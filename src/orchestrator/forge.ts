import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { executableNameCandidates } from '../codex/cliLocator';
import { sanitizeForLog, stripControlChars } from './sanitize';
import { TASK_ID_PATTERN } from './workflow';
import { isWorkflowBranchName, type GitCommandRunner } from './worktree';

/**
 * ホスト連携（PR/MRの作成。design.md §16.18）。
 *
 * `worktree.ts` / `integration.ts` と同じ方針を踏襲する。外部コマンド（`git` / `gh` /
 * `glab`）の呼び出しは `execFile` にargv配列を渡すだけでシェルを経由しないポート越しに行い、
 * テストではフェイクに差し替える。
 *
 * ホストの判定（`ForgeHost` / `detectForgeHost`）と汎用CLI実行ポート（`CliCommandRunner` /
 * `nodeCliCommandRunner`）は、Issue #95（`roadmap.ts`）で「#94着手時にこちらへ寄せる」前提で
 * 最小実装されていたものを、このファイルへ正式に移す。`roadmap.ts` はこのファイルから
 * importして使う（重複を残さない）。
 *
 * **`runner.ts` への配線（実際にワークフロー実行から呼び出す配線）はこのIssueの範囲外
 * （Issue #105）。** ここで用意するのは純粋ロジックとポートの型・Node実装まで。
 */

/* -------------------------------------------------------------------------------------------- */
/* ホストの判定                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export type ForgeHost = 'github' | 'gitlab';

/**
 * `origin` のURLからホストを判定する（design.md §16.18）。`github.com` ならGitHub、
 * ホスト名に `gitlab` を含めばGitLab。それ以外（自己ホストのGitHub Enterpriseなど名前から
 * 判定できないもの）は `undefined` を返す。
 *
 * `roadmap.ts` から移設（元は #95 の最小実装。detectForgeHost自体のロジックは変更しない）。
 */
export function detectForgeHost(remoteUrl: string): ForgeHost | undefined {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[^@\s]+@([^:\s/]+)[:/]/u.exec(trimmed);
  let host: string | undefined;
  if (scpMatch !== null) {
    host = scpMatch[1];
  } else {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      host = undefined;
    }
  }
  if (host === undefined || host === '') {
    return undefined;
  }
  const lower = host.toLowerCase();
  if (lower === 'github.com') {
    return 'github';
  }
  if (lower.includes('gitlab')) {
    return 'gitlab';
  }
  return undefined;
}

/** `gh` / `glab` のどちらを起動するか。 */
export function forgeCliCommand(host: ForgeHost): 'gh' | 'glab' {
  return host === 'github' ? 'gh' : 'glab';
}

/** 設定 `agent.workflows.forge`（machineスコープ。design.md §16.16・§16.18）。 */
export type ForgeHostConfig = 'auto' | 'github' | 'gitlab' | 'none';

/** `agent.workflows.forge` の生値を安全な既定（`auto`）へ丸める。 */
export function normalizeForgeHostConfig(value: string): ForgeHostConfig {
  return value === 'github' || value === 'gitlab' || value === 'none' ? value : 'auto';
}

export type ResolveForgeHostResult =
  { kind: 'host'; host: ForgeHost } | { kind: 'none' } | { kind: 'undetermined'; message: string };

/**
 * ホストを最終的に決定する。設定 `agent.workflows.forge` が `github` / `gitlab` を明示
 * していればそれを使い、`none` ならPR/MRを作らない。`auto`（既定）は `detectForgeHost` の
 * 判定結果を使い、判定できなければ `undetermined` を返す（design.md §16.18）。
 */
export function resolveForgeHost(
  remoteUrl: string | undefined,
  config: ForgeHostConfig,
): ResolveForgeHostResult {
  if (config === 'none') {
    return { kind: 'none' };
  }
  if (config === 'github' || config === 'gitlab') {
    return { kind: 'host', host: config };
  }
  if (remoteUrl === undefined || remoteUrl.trim() === '') {
    return {
      kind: 'undetermined',
      message: 'originのremoteが見つからないため、ホストを判定できませんでした',
    };
  }
  const detected = detectForgeHost(remoteUrl);
  return detected === undefined
    ? {
        kind: 'undetermined',
        message: `originのURLからホストを判定できませんでした: ${sanitizeForLog(remoteUrl)}`,
      }
    : { kind: 'host', host: detected };
}

/* -------------------------------------------------------------------------------------------- */
/* 汎用CLI実行ポート（`gh` / `glab`）                                                            */
/* -------------------------------------------------------------------------------------------- */

export interface CliCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `gh` / `glab` のような任意のCLIコマンドを実行する抽象。`worktree.ts` の `GitCommandRunner` と同じ方針。 */
export interface CliCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResult>;
}

const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const nodeCliCommandRunner: CliCommandRunner = {
  run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResult> {
    return new Promise((resolve) => {
      // execFileはシェルを経由しない（design.md §8・§16.18と同じ方針）
      execFile(
        command,
        [...args],
        { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const code = typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
        },
      );
    });
  },
};

/* -------------------------------------------------------------------------------------------- */
/* 前提チェック                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** `gh` / `glab` がPATH上にあるかどうかの確認。実際に起動せず存在だけを見る。 */
export interface CliAvailabilityPort {
  isOnPath(command: string): Promise<boolean>;
}

/**
 * PATH上の各ディレクトリを順に見て、実行可能なファイルとして見つかれば true。
 *
 * `src/codex/cliLocator.ts` の `resolveExecutable` と同じ考え方（PATH区切りで走査し、
 * 実行可能ビットを確認する）だが、走査そのもの（同期`fs`か非同期`fs/promises`か等）は
 * 意図的に複製する。`codex/cliLocator.ts` はCodex/Claude実行ファイルの解決という別ドメイン
 * の関心事（`machine` スコープの `executablePath` 設定を受け取る等）を持つ専用モジュールで、
 * orchestrator配下からそこへ結合させると「たまたま走査ロジックが同じだけ」の依存が生まれる
 * （`worktree.ts` / `integration.ts` が他ファイルの非exportヘルパーを複製しているのと同じ
 * 方針）。
 *
 * ただし**候補となる実行ファイル名の組み立て（`PATHEXT`を考慮した拡張子展開）だけは
 * `executableNameCandidates`として`cliLocator.ts`側へ一本化し、ここからimportして使う**
 * （Issue #404）。以前はここで`path.join(dir, command)`と拡張子なしのまま`fs.access`して
 * いたため、Windowsでは`gh.exe` / `glab.cmd`を見つけられず常に「PATHに無い」と誤判定して
 * いた。走査ロジックの重複は許容しても、同じ拡張子解決ロジックを2箇所に書くと片方だけ
 * 直して他方が取り残される実害（このIssueの根本原因）が起きるため、そこだけは共通化する。
 */
export const nodeCliAvailability: CliAvailabilityPort = {
  async isOnPath(command: string): Promise<boolean> {
    const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
    for (const dir of dirs) {
      for (const candidateName of executableNameCandidates(command, process.env)) {
        const candidate = path.join(dir, candidateName);
        try {
          await fsPromises.access(candidate, fsConstants.X_OK);
          const stat = await fsPromises.stat(candidate);
          if (stat.isFile()) {
            return true;
          }
        } catch {
          // 見つからなければ次の候補へ
        }
      }
    }
    return false;
  },
};

export interface ForgePrerequisiteDeps {
  git: GitCommandRunner;
  cli: CliCommandRunner;
  cliAvailability: CliAvailabilityPort;
}

/**
 * PR/MR作成の前提チェックの結果（design.md §16.18「前提が欠けている場合」）。
 *
 * **欠けていてもエラーにしない。** `ready` が `false` のときは、呼び出し側がPR/MRの作成を
 * 飛ばし、統合ブランチへのローカルのマージだけを進める判断材料として使う。
 */
export interface ForgePrerequisites {
  host: ForgeHost;
  hasOriginRemote: boolean;
  cliOnPath: boolean;
  authenticated: boolean;
  /** 上記3つ全てが揃っているか。 */
  ready: boolean;
  /** 欠けている項目ごとの警告文（ワークフローViewの警告欄とログの両方へ出す想定。design.md §16.18）。 */
  warnings: string[];
}

const SKIP_SUFFIX =
  'PR/MRの作成を飛ばし、統合ブランチへのローカルのマージだけ進めます（design.md §16.18）';

/**
 * 実行開始前に、`origin` remoteの有無・`gh` / `glab` がPATHにあるか・認証が通っているかを
 * 確かめる（design.md §16.18「前提が欠けている場合」）。3つとも確かめたうえで、欠けている
 * ものがあってもエラーにせず結果を型で返すだけに留める。
 */
export async function checkForgePrerequisites(
  deps: ForgePrerequisiteDeps,
  cwd: string,
  host: ForgeHost,
): Promise<ForgePrerequisites> {
  const command = forgeCliCommand(host);

  const remote = await deps.git.run(['remote', 'get-url', 'origin'], cwd);
  const hasOriginRemote = remote.code === 0 && remote.stdout.trim() !== '';

  const cliOnPath = await deps.cliAvailability.isOnPath(command);

  let authenticated = false;
  if (cliOnPath) {
    const authResult = await deps.cli.run(command, ['auth', 'status'], cwd);
    authenticated = authResult.code === 0;
  }

  const warnings: string[] = [];
  if (!hasOriginRemote) {
    warnings.push(`originのremoteが見つかりません。${SKIP_SUFFIX}`);
  }
  if (!cliOnPath) {
    warnings.push(`${command} がPATHに見つかりません。${SKIP_SUFFIX}`);
  } else if (!authenticated) {
    warnings.push(`${command} の認証が通っていません（${command} auth status）。${SKIP_SUFFIX}`);
  }

  return {
    host,
    hasOriginRemote,
    cliOnPath,
    authenticated,
    ready: hasOriginRemote && cliOnPath && authenticated,
    warnings,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* PR/MRの層の設定                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** 設定 `agent.workflows.pullRequest`（machine-overridable。design.md §16.18）。 */
export type PullRequestLayerConfig = 'none' | 'integration' | 'per-task';

/** `agent.workflows.pullRequest` の生値を安全な既定（`per-task`）へ丸める。 */
export function normalizePullRequestLayerConfig(value: string): PullRequestLayerConfig {
  return value === 'none' || value === 'integration' ? value : 'per-task';
}

/** タスクブランチ→統合ブランチのPR/MR（タスクごと）を作るか。 */
export function shouldCreateTaskPullRequest(config: PullRequestLayerConfig): boolean {
  return config === 'per-task';
}

/** 統合ブランチ→mainのPR/MR（runごと1本）を作るか。 */
export function shouldCreateIntegrationPullRequest(config: PullRequestLayerConfig): boolean {
  return config === 'integration' || config === 'per-task';
}

/**
 * 設定 `agent.workflows.finalMerge`（machineスコープ。design.md §16.16・§16.18・§16.26）。
 *
 * - `auto`: PR/MRを作ってそのままマージする（従来の既定）
 * - `orchestrator`: PR/MRを作り、オーケストレーターの判断でマージする（**新しい既定**）
 * - `confirm`: PR/MRを作って人の承認を待ち、承認されたときだけマージする
 * - `pr-only`: PR/MRを作った時点でrunを終える。マージは拡張の外（GitHub/GitLab上）で行う
 */
export type FinalMergeConfig = 'auto' | 'orchestrator' | 'confirm' | 'pr-only';

/** `agent.workflows.finalMerge` の生値を安全な既定（`orchestrator`、design.md §16.26）へ丸める。 */
export function normalizeFinalMergeConfig(value: string): FinalMergeConfig {
  return value === 'auto' || value === 'orchestrator' || value === 'confirm' || value === 'pr-only'
    ? value
    : 'orchestrator';
}

/**
 * 最終マージ（`gh pr merge` / `glab mr merge`）を**即座に**実行してよいか。
 *
 * `auto` のときだけ `true`。`orchestrator` / `confirm` はPR/MR作成の直後にはマージせず、
 * 判断が付いてから（`needsFinalMergeDecision`が`true`を返した後の`decide_final_merge`／
 * 人の承認）マージする（design.md §16.26）。
 *
 * **前提チェックが通らずPR/MRを作れなかった場合、`finalMerge: auto` であってもmainへは
 * マージしない**（design.md §16.18「この場合、finalMerge: autoであってもmainへのマージは
 * 行わない。PR/MRを介さずにmainを書き換えることはしない」）。`pullRequestCreated` が
 * `false`（前提チェック未達・PR/MR作成失敗のいずれか）ならこの関数は常に `false` を返す。
 */
export function shouldRunFinalMerge(
  config: FinalMergeConfig,
  pullRequestCreated: boolean,
): boolean {
  return config === 'auto' && pullRequestCreated;
}

/**
 * マージするかどうかの判断を待つ必要があるか（design.md §16.26）。
 *
 * `orchestrator`（オーケストレーターへ判断を問う）と `confirm`（人の承認を待つ）が対象。
 * `shouldRunFinalMerge`と同じく、PR/MRを作れていなければ（`pullRequestCreated: false`）
 * 判断を待つ意味が無いため常に `false`。
 */
export function needsFinalMergeDecision(
  config: FinalMergeConfig,
  pullRequestCreated: boolean,
): boolean {
  return (config === 'orchestrator' || config === 'confirm') && pullRequestCreated;
}

/* -------------------------------------------------------------------------------------------- */
/* PR/MRのタイトル・本文の組み立て（純粋関数）                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * タスクのPR/MRのタイトル（design.md §16.18「タイトル: `<taskId>: <prompt の1行目>`」）。
 *
 * `taskId` の字種は `workflow.ts` の `TASK_ID_PATTERN` で検証し、不正なら例外にする
 * （`integration.ts` / `worktree.ts` の「組み立て系の純粋関数は不正な識別子を例外にする」
 * 方針と揃える）。
 */
export function buildTaskPullRequestTitle(taskId: string, prompt: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`不正なtaskId（許可されない文字を含みます）: ${taskId}`);
  }
  const firstLine = stripControlChars((prompt.split(/\r?\n/u)[0] ?? '').trim());
  return `${taskId}: ${firstLine}`;
}

/**
 * タスクのPR/MRの本文に渡す入力。**`{{T.result}}` の展開結果（エージェントの応答）を
 * 受け取るフィールドを意図的に持たない**（design.md §16.16「`{{T1.result}}` の展開結果は
 * PR/MRの本文に入れない」）。呼び出し側がエージェントの応答を渡そうとしても、この型に
 * 渡す場所が無い。
 */
export interface TaskPullRequestBodyInput {
  prompt: string;
  done: string;
  /** run全体とタスク固有の実行契約。旧呼び出しでは未指定。 */
  contract?: string;
  runId: string;
  dependsOn: readonly string[];
  /** 対応するIssue番号。あれば本文の先頭に `Closes #<N>` を出す。 */
  issue: number | undefined;
}

/**
 * タスクのPR/MRの本文（design.md §16.18「本文: そのタスクの `prompt` と `done`、runId、
 * 依存タスクのid、対応するIssue番号（あれば `Closes #<N>`）」）。
 */
export function buildTaskPullRequestBody(input: TaskPullRequestBodyInput): string {
  const lines: string[] = [];
  if (input.issue !== undefined) {
    lines.push(`Closes #${input.issue}`);
    lines.push('');
  }
  if (input.contract !== undefined && input.contract !== '') {
    lines.push(input.contract);
    lines.push('');
  }
  lines.push('## prompt');
  lines.push('');
  lines.push(input.prompt);
  lines.push('');
  lines.push('## done');
  lines.push('');
  lines.push(input.done);
  lines.push('');
  lines.push('## meta');
  lines.push('');
  lines.push(`- runId: ${input.runId}`);
  lines.push(`- dependsOn: ${input.dependsOn.length > 0 ? input.dependsOn.join(', ') : 'なし'}`);
  return lines.join('\n');
}

/**
 * 統合PR/MR（統合ブランチ→mainの層。runごと1本）のタイトル・本文に渡す入力。
 *
 * design.md §16.18の「本文」節はタスク層（そのタスクの `prompt` / `done`）を指しており、
 * 統合層の書式そのものは明記していない。ここでは「run単位で何を統合したか」が
 * 追跡できることを優先し、runIdと完了したタスクidの一覧だけを本文に載せる形にした
 * （実装判断。最終報告に記載）。タスク層と同じく、エージェントの応答を受け取る
 * フィールドは持たない。
 */
export interface IntegrationPullRequestContentInput {
  runId: string;
  taskIds: readonly string[];
}

export function buildIntegrationPullRequestTitle(
  input: IntegrationPullRequestContentInput,
): string {
  return `run ${input.runId} の統合`;
}

export function buildIntegrationPullRequestBody(input: IntegrationPullRequestContentInput): string {
  const lines: string[] = [];
  lines.push(`run ${input.runId} で完了したタスクを統合します。`);
  lines.push('');
  lines.push('## 完了したタスク');
  lines.push('');
  if (input.taskIds.length === 0) {
    lines.push('（なし）');
  } else {
    for (const taskId of input.taskIds) {
      lines.push(`- ${taskId}`);
    }
  }
  return lines.join('\n');
}

/**
 * タスクのIssue（design.md §16.31、roadmap W6、Issue #596）の本文に渡す入力。PR/MRの本文
 * （`TaskPullRequestBodyInput`）と違い、`dependsOn` / `issue`（このIssue自身への自己参照は
 * 意味を持たない）は持たない。
 */
export interface TaskIssueBodyInput {
  prompt: string;
  done: string;
  contract?: string;
  runId: string;
  taskId: string;
}

/**
 * タスクのIssueの本文（design.md §16.31「タスクの開始時にIssueを起票し、PR本文から参照する」）。
 * `buildTaskPullRequestBody`と同じ`prompt`/`done`の2段構成に、`runId`/`taskId`を`meta`として
 * 添える。
 */
export function buildTaskIssueBody(input: TaskIssueBodyInput): string {
  const lines: string[] = [];
  if (input.contract !== undefined && input.contract !== '') {
    lines.push(input.contract);
    lines.push('');
  }
  lines.push('## prompt');
  lines.push('');
  lines.push(input.prompt);
  lines.push('');
  lines.push('## done');
  lines.push('');
  lines.push(input.done);
  lines.push('');
  lines.push('## meta');
  lines.push('');
  lines.push(`- runId: ${input.runId}`);
  lines.push(`- taskId: ${input.taskId}`);
  return lines.join('\n');
}

/* -------------------------------------------------------------------------------------------- */
/* 本文を渡すための一時ファイル                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * PR/MRの本文をファイル経由で渡す（design.md §16.18「本文はファイル経由で渡す
 * （`--body-file`）。`prompt` もエージェントの出力も、引数に直接置かない」）ための
 * 一時ファイルの読み書き。
 */
export interface ForgeFileSystemPort {
  /** 本文を一時ファイルへ書き、そのパスを返す。 */
  writeTempFile(content: string): Promise<string>;
  /** 使い終わった一時ファイル（を含むディレクトリ）を片付ける。失敗しても例外にしない。 */
  removeTempFile(target: string): Promise<void>;
}

export const nodeForgeFileSystem: ForgeFileSystemPort = {
  async writeTempFile(content: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'vscode-codex-forge-'));
    const target = path.join(dir, 'body.md');
    await fsPromises.writeFile(target, content, 'utf8');
    return target;
  },
  async removeTempFile(target: string): Promise<void> {
    try {
      await fsPromises.rm(path.dirname(target), { recursive: true, force: true });
    } catch {
      // OSの一時領域は最終的に回収されるため、削除の失敗自体は致命的ではない
    }
  },
};

/* -------------------------------------------------------------------------------------------- */
/* ブランチ名の検証（`git push` の引数として渡す前の防御）                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * `wf/<runId>/...` の形（`worktree.ts` の `branchName` が生成する形）だけを許す。
 * `git push origin <branch>:<branch>` の引数として渡す前の防御。検証パターンそのものは
 * `worktree.ts` の `isWorkflowBranchName` へ一本化した（以前は `integration.ts` の
 * `isValidTaskBranch` と実装形が違うまま複製されていた。Issue #146）。
 */
function isManagedWorkflowBranch(branch: string): boolean {
  return isWorkflowBranchName(branch);
}

/* -------------------------------------------------------------------------------------------- */
/* push                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export type PushBranchResult = { ok: true } | { ok: false; message: string };

/**
 * `pushBranch` のリトライ前の待ち時間を注入するための型。既定は実際に待つ実装
 * （`defaultPushBranchWait`）だが、テストはこれを差し替えて実時間で待たないようにする
 * （design.md §16.18・Issue #253）。
 */
export type PushBranchWait = (attempt: number) => Promise<void>;

/** `pushBranch` が競合を理由にリトライする最大試行回数（初回を含む。Issue #253）。 */
export const PUSH_BRANCH_MAX_ATTEMPTS = 3;

/** バックオフの基準時間（ミリ秒）。実際の待ち時間は `attempt * PUSH_BRANCH_RETRY_BASE_DELAY_MS`。 */
const PUSH_BRANCH_RETRY_BASE_DELAY_MS = 500;

const defaultPushBranchWait: PushBranchWait = (attempt) =>
  new Promise((resolve) => {
    setTimeout(resolve, attempt * PUSH_BRANCH_RETRY_BASE_DELAY_MS);
  });

/**
 * リモート側が同じrefへの並行更新を弾いたときに出す、一時的な失敗を示すstderrのパターン
 * （`cannot lock ref` / `fetch first` / `non-fast-forward` / `stale info`。Issue #253）。
 * 時間をおいて再送すれば通る類の失敗だけをこのパターンに含める。認証エラーや
 * 不正なブランチ名などはこのパターンに一致しないため、リトライせず即座に失敗として扱う。
 */
const RETRYABLE_PUSH_ERROR_PATTERN = /cannot lock ref|fetch first|non-fast-forward|stale info/iu;

/** `pushBranch` の失敗メッセージが、時間をおいて再試行する価値のある一時的な競合かどうか。 */
export function isRetryablePushError(stderr: string): boolean {
  return RETRYABLE_PUSH_ERROR_PATTERN.test(stderr);
}

/**
 * タスクブランチ・統合ブランチを `origin` へpushする（design.md §16.18「作る順序」の
 * 1・2番目の手順）。push先のremoteは常に `origin`（design.md §16.16「push先のremoteを
 * YAMLや設定から選ぶ手段は設けない」）。
 *
 * `branch` は `wf/<runId>/...` の形だけを受け付ける。位置引数としてブランチ名を渡す
 * `git push` は、先頭が `-` の文字列を渡されるとフラグとして解釈されうる
 * （`worktree.ts` / `integration.ts` の `HEAD_COMMIT_PATTERN` 等と同じ理由の防御）ため、
 * refspec形式（`<branch>:<branch>`）で1つの引数にまとめたうえで字種も検証する。
 *
 * **競合による一時的失敗（`isRetryablePushError`）に限り、バックオフを挟んで最大
 * `PUSH_BRANCH_MAX_ATTEMPTS` 回まで再試行する（design.md §16.18・Issue #253）。**
 * 同じ統合ブランチへ複数タスクが並行してpushすると、リモートが `cannot lock ref` で
 * 一方を弾くことがある。呼び出し側を直列化しても、リモート側では他クライアント
 * （同じrepoの別クローンや別run）との間で同種の競合が起こりうるため、直列化とは独立に
 * ここでも吸収する。認証エラーや不正なブランチ名などリトライしても無駄な失敗は対象外で、
 * 即座に失敗を返す。
 */
export async function pushBranch(
  git: GitCommandRunner,
  cwd: string,
  branch: string,
  wait: PushBranchWait = defaultPushBranchWait,
): Promise<PushBranchResult> {
  if (!isManagedWorkflowBranch(branch)) {
    return {
      ok: false,
      message: `不正なブランチ名（wf/<runId>/... の形ではありません）: ${branch}`,
    };
  }

  let lastMessage = '';
  for (let attempt = 1; attempt <= PUSH_BRANCH_MAX_ATTEMPTS; attempt += 1) {
    const result = await git.run(['push', 'origin', `${branch}:${branch}`], cwd);
    if (result.code === 0) {
      return { ok: true };
    }
    lastMessage =
      result.stderr.trim() !== ''
        ? sanitizeForLog(result.stderr)
        : `git push に失敗しました（終了コード ${result.code}）`;

    const isLastAttempt = attempt === PUSH_BRANCH_MAX_ATTEMPTS;
    if (isLastAttempt || !isRetryablePushError(result.stderr)) {
      return { ok: false, message: lastMessage };
    }
    await wait(attempt);
  }
  // 上のループは必ずreturnで終わる（TypeScriptの制御フロー解析のためのフォールバック）
  return { ok: false, message: lastMessage };
}

/* -------------------------------------------------------------------------------------------- */
/* PR/MRの作成                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export interface CreatePullRequestRequest {
  host: ForgeHost;
  /** PR/MR作成コマンドを起動するディレクトリ（対象ブランチが存在するworktree）。 */
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  /**
   * Draft指定で作るか（「Draft PR/MRとして作成し、統合マージ後にreadyへ切り替える」フロー用）。
   * 省略時・`false`は従来どおりDraftなしで作る（既存呼び出し元に影響を与えない）。readyへの
   * 切り替えは`markPullRequestReady`が担う。
   *
   * `?: boolean | undefined`にしているのは、`CreateIntegrationPullRequestRequest.draft`
   * （同じくoptional）をそのまま中継する`createIntegrationPullRequest`からの呼び出しが
   * `exactOptionalPropertyTypes: true`の下でも成立するようにするため（`runner.ts`の
   * `integrationBranch?: string | undefined`と同じ書き方）。
   */
  draft?: boolean | undefined;
}

export type CreatePullRequestOutcome =
  | { ok: true; url: string | undefined }
  | { ok: false; reason: 'invalidInput' | 'cliError'; message: string };

/**
 * `base` / `head` / `title` の最低限の健全性を確かめる。`base` はタスク層では統合ブランチ
 * （`wf/...`）、統合層では実行開始時のブランチ（`main` など任意の名前）になりうるため
 * `isWorkflowBranchName` のような固定形では縛れない。改行を含む・空文字といった、
 * `--base=<value>` の一部として渡すには不適切な値だけを弾く（引数の値自体は `=` で
 * 1つのトークンに結合するため、先頭が `-` でもフラグとして再解釈されない。後述）。
 */
function invalidCliArgumentValue(value: string): boolean {
  return value.trim() === '' || /[\r\n]/u.test(value);
}

/**
 * ホストごとのPR/MR作成コマンドを組み立てる（純粋関数。design.md §16.18）。
 *
 * - GitHub: `gh pr create --base=<base> --head=<head> --title=<title> --body-file=<path>`
 * - GitLab: `glab mr create` の `-d/--description` はファイルからの読み込みに対応していない
 *   （実機の `--help` で確認済み。`glab` 1.112.0）。そのため `glab api` で
 *   `projects/:id/merge_requests` へPOSTし、`--field description=@<path>` で本文をファイル
 *   経由にする（`glab api` の `--field` は値が `@` から始まると「その後ろをファイル名として
 *   読む」という仕様。同じく実機の `--help` で確認済み）。`source_branch` / `target_branch` /
 *   `title` は文字列として渡す。
 *
 * 全てのフラグを `--flag=value` の1トークン形式にする。`gh` / `glab` はいずれもpflagベースの
 * パーサで、`--flag value`（スペース区切りの2トークン）だと `value` が `-` から始まる文字列
 * のときにフラグとして誤解釈される余地が残る。`--flag=value` なら1トークンに収まるため、
 * 値の中身に関わらずパーサが値として一貫して扱う（`worktree.ts` / `integration.ts` が
 * 位置引数について講じている防御と同じ動機を、フラグ引数について満たす形）。
 *
 * `draft`（省略時・`false`は付けない）:
 * - GitHub: `gh pr create` に `--draft` を足す。値を取らないフラグなのでそのまま1トークン
 * - GitLab: `glab api projects/:id/merge_requests` へのPOSTに `--field=draft=true` を足す
 *   （GitLab APIのMR作成エンドポイントは`draft` booleanを受け付ける）
 */
function buildCreatePullRequestArgs(
  host: ForgeHost,
  params: {
    base: string;
    head: string;
    title: string;
    bodyFilePath: string;
    draft?: boolean | undefined;
  },
): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    const args = [
      'pr',
      'create',
      `--base=${params.base}`,
      `--head=${params.head}`,
      `--title=${params.title}`,
      `--body-file=${params.bodyFilePath}`,
    ];
    if (params.draft === true) {
      args.push('--draft');
    }
    return { command: 'gh', args };
  }
  const args = [
    'api',
    'projects/:id/merge_requests',
    `--field=source_branch=${params.head}`,
    `--field=target_branch=${params.base}`,
    `--field=title=${params.title}`,
    `--field=description=@${params.bodyFilePath}`,
  ];
  if (params.draft === true) {
    args.push('--field=draft=true');
  }
  return { command: 'glab', args };
}

/** `gh pr create` は成功時にPRのURLをそのまま標準出力へ出す。 */
function extractGithubPullRequestUrl(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  return trimmed !== '' ? trimmed : undefined;
}

/** `glab api` はJSONを返す。作成したMRの `web_url` を拾う。 */
function extractGitlabMergeRequestUrl(stdout: string): string | undefined {
  try {
    const data: unknown = JSON.parse(stdout);
    if (typeof data === 'object' && data !== null && 'web_url' in data) {
      const url = (data as Record<string, unknown>)['web_url'];
      return typeof url === 'string' ? url : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface CreatePullRequestDeps {
  cli: CliCommandRunner;
  fs: ForgeFileSystemPort;
}

/**
 * PR/MRを1件作る（design.md §16.18「作る順序」の3番目の手順）。本文は一時ファイルへ書き、
 * `--body-file`（GitHubは`gh`のフラグそのもの、GitLabは`glab api`の`--field description=@…`）
 * 経由で渡す。一時ファイルは結果に関わらず必ず片付ける。
 */
export async function createPullRequest(
  deps: CreatePullRequestDeps,
  request: CreatePullRequestRequest,
): Promise<CreatePullRequestOutcome> {
  if (
    invalidCliArgumentValue(request.base) ||
    invalidCliArgumentValue(request.head) ||
    invalidCliArgumentValue(request.title)
  ) {
    return {
      ok: false,
      reason: 'invalidInput',
      message: 'base / head / title のいずれかが空、または改行を含んでいます',
    };
  }

  const bodyFilePath = await deps.fs.writeTempFile(request.body);
  try {
    const { command, args } = buildCreatePullRequestArgs(request.host, {
      base: request.base,
      head: request.head,
      title: stripControlChars(request.title),
      bodyFilePath,
      draft: request.draft,
    });
    const result = await deps.cli.run(command, args, request.cwd);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'cliError',
        message:
          result.stderr.trim() !== ''
            ? sanitizeForLog(result.stderr)
            : `${command} の実行に失敗しました（終了コード ${result.code}）`,
      };
    }
    const url =
      request.host === 'github'
        ? extractGithubPullRequestUrl(result.stdout)
        : extractGitlabMergeRequestUrl(result.stdout);
    return { ok: true, url };
  } finally {
    await deps.fs.removeTempFile(bodyFilePath);
  }
}

/**
 * ホストごとのIssue作成コマンドを組み立てる（design.md §16.31、roadmap W6、Issue #596）。
 * `buildCreatePullRequestArgs`と同じ「全フラグを`--flag=value`の1トークン形式にする」防御を
 * そのまま踏襲する。
 *
 * - GitHub: `gh issue create --title=<title> --body-file=<path>`
 * - GitLab: `glab issue create`の`-d/--description`もPR/MRと同じくファイル読み込みに
 *   対応していない（`buildCreatePullRequestArgs`のコメント参照）ため、同じく`glab api`で
 *   `projects/:id/issues`へPOSTする
 */
function buildCreateIssueArgs(
  host: ForgeHost,
  params: {
    title: string;
    bodyFilePath: string;
    labels?: string;
    assignees?: string;
    assigneeIds?: readonly number[];
    milestone?: string;
  },
): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    const args = [
      'issue',
      'create',
      `--title=${params.title}`,
      `--body-file=${params.bodyFilePath}`,
    ];
    if (params.labels !== undefined && params.labels !== '') args.push(`--label=${params.labels}`);
    if (params.assignees !== undefined && params.assignees !== '')
      args.push(`--assignee=${params.assignees}`);
    if (params.milestone !== undefined && params.milestone !== '')
      args.push(`--milestone=${params.milestone}`);
    return {
      command: 'gh',
      args,
    };
  }
  const args = [
    'api',
    'projects/:id/issues',
    `--field=title=${params.title}`,
    `--field=description=@${params.bodyFilePath}`,
  ];
  if (params.labels !== undefined && params.labels !== '')
    args.push(`--field=labels=${params.labels}`);
  for (const assigneeId of params.assigneeIds ?? []) {
    args.push(`--field=assignee_ids[]=${String(assigneeId)}`);
  }
  if (params.milestone !== undefined && params.milestone !== '')
    args.push(`--field=milestone=${params.milestone}`);
  return { command: 'glab', args };
}

/** `createPullRequest`と同じ戻り値の形（URLが取れれば返す。番号は呼び出し側が`parsePullRequestNumberFromUrl`で取り出す）。 */
export type CreateIssueOutcome = CreatePullRequestOutcome;

export interface CreateIssueRequest {
  host: ForgeHost;
  cwd: string;
  title: string;
  body: string;
  labels?: string;
  assignees?: string;
  milestone?: string;
}

/**
 * タスクのIssueを1件作る（design.md §16.31「タスクの開始時にIssueを起票し、PR本文から
 * 参照する」、roadmap W6、Issue #596）。`createPullRequest`と同じく本文は一時ファイル経由
 * （`--body-file` / `glab api`の`--field description=@…`）で渡し、結果に関わらず必ず片付ける。
 *
 * **呼び出し側（`runner.ts`）が前提（CLI・認証）を確かめてから呼ぶ。** この関数自体は
 * CLIの起動が失敗すれば`{ ok: false }`をそのまま返すだけで、呼び出し側はそれを警告として
 * 記録し、Issueが起票できなくても`run`を止めない（design.md §16.31の受入基準）。
 */
export async function createIssue(
  deps: CreatePullRequestDeps,
  request: CreateIssueRequest,
): Promise<CreateIssueOutcome> {
  if (invalidCliArgumentValue(request.title)) {
    return {
      ok: false,
      reason: 'invalidInput',
      message: 'title が空、または改行を含んでいます',
    };
  }
  const assigneeIds =
    request.host === 'gitlab' && request.assignees !== undefined && request.assignees.trim() !== ''
      ? request.assignees.split(',').map((value) => Number(value.trim()))
      : undefined;
  if (assigneeIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return {
      ok: false,
      reason: 'invalidInput',
      message: 'GitLabのassigneeは正のユーザーIDをカンマ区切りで指定してください',
    };
  }

  const bodyFilePath = await deps.fs.writeTempFile(request.body);
  try {
    const { command, args } = buildCreateIssueArgs(request.host, {
      title: stripControlChars(request.title),
      bodyFilePath,
      ...(request.labels === undefined ? {} : { labels: stripControlChars(request.labels) }),
      ...(request.assignees === undefined
        ? {}
        : { assignees: stripControlChars(request.assignees) }),
      ...(assigneeIds === undefined ? {} : { assigneeIds }),
      ...(request.milestone === undefined
        ? {}
        : { milestone: stripControlChars(request.milestone) }),
    });
    const result = await deps.cli.run(command, args, request.cwd);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'cliError',
        message:
          result.stderr.trim() !== ''
            ? sanitizeForLog(result.stderr)
            : `${command} の実行に失敗しました（終了コード ${result.code}）`,
      };
    }
    // 関数名はPR/MR限定に読めるが、URLの形は使い回してよい（GitHubの`gh issue create`も
    // PR同様URLを1行だけ吐き、GitLabのissues APIも`web_url`を返す）ため、そのまま流用する
    const url =
      request.host === 'github'
        ? extractGithubPullRequestUrl(result.stdout)
        : extractGitlabMergeRequestUrl(result.stdout);
    return { ok: true, url };
  } finally {
    await deps.fs.removeTempFile(bodyFilePath);
  }
}

/** Issueへ実装計画をコメントとして残す。既存本文を上書きしない。 */
export async function postIssueComment(
  deps: CreatePullRequestDeps,
  request: { host: ForgeHost; cwd: string; number: number; body: string },
): Promise<CreateIssueOutcome> {
  if (!Number.isSafeInteger(request.number) || request.number <= 0 || request.body.trim() === '') {
    return { ok: false, reason: 'invalidInput', message: 'Issue番号または本文が不正です' };
  }
  const bodyFilePath = await deps.fs.writeTempFile(request.body);
  try {
    const args =
      request.host === 'github'
        ? ['issue', 'comment', String(request.number), `--body-file=${bodyFilePath}`]
        : [
            'api',
            `projects/:id/issues/${String(request.number)}/notes`,
            `--field=body=@${bodyFilePath}`,
          ];
    const command = request.host === 'github' ? 'gh' : 'glab';
    const result = await deps.cli.run(command, args, request.cwd);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'cliError',
        message:
          result.stderr.trim() !== ''
            ? sanitizeForLog(result.stderr)
            : 'Issue計画の反映に失敗しました',
      };
    }
    return {
      ok: true,
      url:
        request.host === 'github'
          ? result.stdout.trim() || undefined
          : extractGitlabMergeRequestUrl(result.stdout),
    };
  } finally {
    await deps.fs.removeTempFile(bodyFilePath);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* PR/MRの番号の取り出し                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * PR/MRのURLから番号を取り出す（design.md §16.11「タスクごとの...PR/MRの番号」・
 * 「統合PR/MRの番号」、Issue #118）。`createPullRequest` の戻り値はURLしか返さない
 * （`gh pr create`の標準出力・`glab api`が返す`web_url`）ため、ここで拾う。GitHubは
 * `.../pull/<n>`、GitLabは`.../-/merge_requests/<n>`の形式で、いずれも末尾が10進数になる。
 * 取り出せなければ`undefined`（番号なし・URLだけは引き続き表示に使える）。
 *
 * 実装はここへ一本化してある。`runner.ts`は元々同名関数を複製していたが、本体コード
 * （`runner.ts` / `runnerMerge.ts`）はどちらも`./runner`からimportしていたためこちら側は
 * `forge.test.ts`からしか呼ばれない実質デッドコードになっていた（レビュー指摘）。
 * `runner.ts`側は`export { parsePullRequestNumberFromUrl } from './forge'`の再exportへ
 * 差し替え、既存の`import { parsePullRequestNumberFromUrl } from './runner'`を壊さない形で
 * 重複を解消した。
 */
export function parsePullRequestNumberFromUrl(url: string): number | undefined {
  const match = /\/(\d+)\/?$/u.exec(url);
  if (match === null) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* タスク層のPR/MR作成フロー（呼び出し順の固定）                                                  */
/* -------------------------------------------------------------------------------------------- */

/** 各手順の成否。`ok: false` でも後続の手順（マージ）は止めない（後述）。 */
export type ForgeStepOutcome = { ok: true } | { ok: false; message: string };

/**
 * タスク層のPR/MR作成フローの手順（design.md §16.18「作る順序」がそのまま手順名になる。
 * 元は4手順だったが、readyへの切り替え（5番目、`markPullRequestReady`）・レビュー
 * （3.5番目、`reviewPullRequest`、roadmap W6）が任意手順として増え、現在は最大6手順）。
 *
 * 手順の実体（実際に `git push` / `gh pr create` / 統合worktreeでのマージを行う関数）は
 * 呼び出し側が組み立てて渡す。`mergeAndPushIntegration` の型を `TMerge` で汎用化している
 * のは、`IntegrationMergeQueue`（`integration.ts`）の具体的な戻り値型にこのファイルを
 * 結合させないため。統合・マージのドメインは `integration.ts` の責務のままにし、このファイルは
 * 「PR/MRを作る手順と統合の手順を、design.mdが定める順序で呼ぶ」ことだけを保証する。
 */
export interface TaskPullRequestSteps<TMerge> {
  pushTaskBranch: () => Promise<ForgeStepOutcome>;
  pushIntegrationBranch: () => Promise<ForgeStepOutcome>;
  createPullRequest: () => Promise<CreatePullRequestOutcome>;
  /**
   * PR/MRを作った後、ローカルマージの前に読み取り専用の別セッションでレビューさせる
   * （design.md §16.31「PRを作ったあと、ローカルマージの前にレビューを1段挟む」、
   * roadmap W6、Issue #596）。PR/MRの作成に成功したときだけ、mergeAndPushIntegration の
   * 前に呼ぶ。省略時は行わない（既定は無効。design.md「forge側の『人のレビューを待つ』
   * 方式は採らない」）。
   *
   * **結果に関わらずマージは進める。** 指摘は呼び出し側が警告として記録するだけで、
   * このフロー自体は指摘の有無でマージをブロックしない（forgeの「人のレビューを待つ」
   * 方式のように、応答が無いまま待ち続ける構造を持ち込まないため。design.md §16.31）。
   */
  reviewPullRequest?: (url: string | undefined) => Promise<ForgeStepOutcome>;
  mergeAndPushIntegration: () => Promise<TMerge>;
  /**
   * Draftで作ったPR/MRをreadyへ切り替える。Draftを使わない設定なら undefined。
   * PR/MRの作成に成功したときだけ、mergeAndPushIntegration の後に呼ぶ。
   */
  markPullRequestReady?: (url: string | undefined) => Promise<ForgeStepOutcome>;
}

export interface TaskPullRequestFlowResult<TMerge> {
  pullRequest:
    | { created: true; url: string | undefined }
    | {
        created: false;
        stage: 'pushTaskBranch' | 'pushIntegrationBranch' | 'createPullRequest';
        message: string;
      };
  /** レビューを試みた場合の結果。試みていなければ undefined。 */
  review?: ForgeStepOutcome;
  mergeOutcome: TMerge;
  /** ready化を試みた場合の結果。試みていなければ undefined。 */
  markReady?: ForgeStepOutcome;
}

/**
 * タスク層のPR/MR作成フローを、design.mdが定める順序（タスクブランチをpush→統合ブランチを
 * push→PR/MRを作る→（あれば）レビューさせる→マージして統合ブランチをpush→（あれば）
 * Draftで作ったPR/MRをreadyへ切り替える）で実行する。**既存の4手順の順序は変えない。
 * レビューは3.5番目、ready化は5番目として足す。**
 *
 * **先にマージしてしまうと、baseとheadの間に差分が無くなりPR/MRの作成に失敗する**
 * （GitHubは"No commits between"を返す。design.md §16.18）ため、この順序を型で強制する
 * （呼び出し側が手順を並べ替えられない。手順は個別の関数として渡され、このファイルの中で
 * しか呼ばれない）。
 *
 * PR/MRの作成に至るまでの手順（push・push・create）のどれかが失敗しても、
 * `mergeAndPushIntegration` は必ず最後に実行する。統合ブランチへのローカルのマージは
 * PR/MRの成否に関わらず進める必要がある（design.md §16.18「前提が欠けている場合」と
 * 同じ「ワークフロー自体は止めない」方針を、PR/MR作成の他の失敗要因にも一貫して適用する）。
 *
 * レビュー（`reviewPullRequest`、design.md §16.31、roadmap W6）はPR/MRが作れたときだけ
 * `mergeAndPushIntegration` の前に呼ぶ。**結果（指摘の有無・レビュー自体の失敗）に関わらず
 * `mergeAndPushIntegration` は必ず呼ぶ**（マージをブロックしない。ready化・pushの失敗と
 * 同じ「ワークフロー自体は止めない」方針）。
 *
 * ready化（`markPullRequestReady`）は「統合ブランチへのマージが済んでからDraftを外す」ため
 * `mergeAndPushIntegration` の後に置く。PR/MRが作れていないとき（作成に失敗した、または
 * 前段のpush失敗で作成自体を試みていないとき）はready化の対象が無いため呼ばない。
 * ready化の失敗もワークフロー自体は止めない（同じ方針の踏襲）。結果は `markReady` へ残すだけ。
 */
export async function runTaskPullRequestFlow<TMerge>(
  steps: TaskPullRequestSteps<TMerge>,
): Promise<TaskPullRequestFlowResult<TMerge>> {
  let pullRequest: TaskPullRequestFlowResult<TMerge>['pullRequest'];

  const pushTask = await steps.pushTaskBranch();
  if (!pushTask.ok) {
    pullRequest = { created: false, stage: 'pushTaskBranch', message: pushTask.message };
  } else {
    const pushIntegration = await steps.pushIntegrationBranch();
    if (!pushIntegration.ok) {
      pullRequest = {
        created: false,
        stage: 'pushIntegrationBranch',
        message: pushIntegration.message,
      };
    } else {
      const created = await steps.createPullRequest();
      pullRequest = created.ok
        ? { created: true, url: created.url }
        : { created: false, stage: 'createPullRequest', message: created.message };
    }
  }

  let review: ForgeStepOutcome | undefined;
  if (pullRequest.created && steps.reviewPullRequest !== undefined) {
    review = await steps.reviewPullRequest(pullRequest.url);
  }

  const mergeOutcome = await steps.mergeAndPushIntegration();

  let markReady: ForgeStepOutcome | undefined;
  if (pullRequest.created && steps.markPullRequestReady !== undefined) {
    markReady = await steps.markPullRequestReady(pullRequest.url);
  }

  return {
    pullRequest,
    ...(review === undefined ? {} : { review }),
    mergeOutcome,
    ...(markReady === undefined ? {} : { markReady }),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* 統合層のPR/MR作成と最終マージ                                                                  */
/* -------------------------------------------------------------------------------------------- */

export interface CreateIntegrationPullRequestRequest {
  host: ForgeHost;
  /** 統合worktreeのcwd。push・PR/MR作成・（`auto`なら）最終マージの全てをここから行う。 */
  cwd: string;
  /** 実行開始時のHEADブランチ（PR/MRのbase）。 */
  baseBranch: string;
  /** 統合ブランチ名（PR/MRのhead）。 */
  integrationBranch: string;
  title: string;
  body: string;
  /**
   * Draft指定で作るか。省略時・`false`は従来どおりDraftなしで作る。
   *
   * 統合層のready化は、**最終マージ（`runFinalMerge`）の直前**に行う必要がある（Draftのままで
   * はマージできないため）。ただし`runFinalMerge`自体は現状「呼び出し側がガードを判定してから
   * 呼ぶ」構造になっており、ここへ`markPullRequestReady`の呼び出しを組み込むと「PR/MRを作る」
   * と「readyへ切り替える」という別の関心事がこの関数の中で結合してしまう。統合層でも
   * タスク層（`runTaskPullRequestFlow`）と同じく「作る順序を型で強制する」形にするのは
   * 本Issueの範囲外とし、このファイルでは`markPullRequestReady`をexportするところまでに
   * 留める。統合層での呼び出し順序の強制
   * （`createIntegrationPullRequest` → ローカルマージ → `markPullRequestReady` →
   * `runFinalMerge`という並び）は配線担当（`runner.ts`側）が行う。
   */
  draft?: boolean;
}

export interface CreateIntegrationPullRequestResult {
  push: PushBranchResult;
  pullRequest: CreatePullRequestOutcome | { ok: false; reason: 'pushFailed'; message: string };
}

/**
 * 統合層のPR/MRを作る（design.md §16.18「全体の終了とmainへの反映」）。統合ブランチの
 * baseは実行開始時のHEADブランチで、既にorigin上にある想定のため、タスク層のような
 * 「baseを先にpush」の手順は要らない。head（統合ブランチ）だけpushしてから作る。
 */
export async function createIntegrationPullRequest(
  deps: CreatePullRequestDeps & { git: GitCommandRunner },
  request: CreateIntegrationPullRequestRequest,
): Promise<CreateIntegrationPullRequestResult> {
  const push = await pushBranch(deps.git, request.cwd, request.integrationBranch);
  if (!push.ok) {
    return {
      push,
      pullRequest: { ok: false, reason: 'pushFailed', message: push.message },
    };
  }
  const pullRequest = await createPullRequest(deps, {
    host: request.host,
    cwd: request.cwd,
    base: request.baseBranch,
    head: request.integrationBranch,
    title: request.title,
    body: request.body,
    draft: request.draft,
  });
  return { push, pullRequest };
}

/**
 * ホストごとの最終マージコマンド（design.md §16.18「最終マージ」）。
 *
 * **番号を必ず引数へ含める（Issue #404）。** 番号を省略すると、マージ対象は「cwd
 * （統合worktree）のカレントブランチに紐づくPR/MR」という暗黙の状態依存になり、
 * ブランチがずれていれば無関係のPR/MRがmainへマージされる。`markPullRequestReady`と同じ
 * 直前の手順（`finalizeForge`）が`live.integrationPullRequest.number`を既に持っているため、
 * その番号をそのまま位置引数として渡す。`buildMarkReadyArgs`と同じく正の整数のみ受け付け、
 * `String(number)`で文字列化してからargv配列の1要素としてそのまま渡す（`execFile`はシェルを
 * 経由しないため、引数インジェクションの余地は無い）。
 */
function buildFinalMergeArgs(
  host: ForgeHost,
  number: number,
): { ok: true; command: 'gh' | 'glab'; args: string[] } | { ok: false; message: string } {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, message: `不正なPR/MR番号（正の整数ではありません）: ${number}` };
  }
  if (host === 'github') {
    return { ok: true, command: 'gh', args: ['pr', 'merge', String(number), '--merge'] };
  }
  // GitLabの `--remove-source-branch` はリモート（origin）上のsource branchを消すだけで、
  // ローカルの統合worktree・ブランチは残る。design.md §16.18「mainへマージした後も統合
  // ブランチは残す」と矛盾しない（片付けはViewの操作から行う別の関心事）。
  return {
    ok: true,
    command: 'glab',
    args: ['mr', 'merge', String(number), '--remove-source-branch'],
  };
}

export type RunFinalMergeResult = { ok: true } | { ok: false; message: string };

/**
 * 統合→mainのPR/MRを実際にマージする（`gh pr merge <number> --merge` / `glab mr merge
 * <number> --remove-source-branch`。design.md §16.18「最終マージ」）。呼び出し側は
 * `shouldRunFinalMerge` の判定を経てからこの関数を呼ぶこと（このファイル自体は
 * 常に実行する。ガードは呼び出し側の責務にして二重化しない）。
 *
 * `number`は統合PR/MRの番号（`live.integrationPullRequest.number`）。**`undefined`のときは
 * カレントブランチ依存でのマージが危険なため、CLIを呼ばずに`{ ok: false }`を返す**
 * （Issue #404。`markPullRequestReady`の番号不明時と同じ「わからないなら実行しない」方針）。
 */
export async function runFinalMerge(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number | undefined,
): Promise<RunFinalMergeResult> {
  if (number === undefined) {
    return {
      ok: false,
      message:
        '統合PR/MRの番号が不明なため、最終マージを飛ばしました' +
        '（カレントブランチに依存したマージは危険なため実行しません）',
    };
  }
  const built = buildFinalMergeArgs(host, number);
  if (!built.ok) {
    return { ok: false, message: built.message };
  }
  const { command, args } = built;
  const result = await cli.run(command, args, cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `${command} ${args.join(' ')} に失敗しました（終了コード ${result.code}）`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------------------------- */
/* Draft PR/MRのready化                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * ホストごとのready化コマンド。
 *
 * - GitHub: `gh pr ready <number>`
 * - GitLab: `glab mr update <number> --ready`
 *
 * `number`は正の整数のみ受け付ける（`buildTaskPullRequestTitle`が不正な`taskId`を例外にする
 * のと同じ流儀）。数値は`String(number)`で文字列化してからargv配列の1要素としてそのまま渡す
 * （`execFile`はシェルを経由しない。design.md §16.18）ため、引数インジェクションの余地は無い。
 *
 * 不正な`number`は例外ではなく`{ ok: false }`で返す（レビュー指摘）。以前は`throw`していたが、
 * 呼び出し元の`markPullRequestReady`がこれをcatchせず素通しするうえ、そのまた呼び出し元
 * （`runner.ts`の`finalizeForge`）は`void this.finalizeForge(runId)`というfloating promiseで
 * 起動されているため、例外が起きると`runFinalMerge` / `persist` / `notify`が実行されないまま
 * 打ち切られてしまう。「ready化の失敗はワークフローを止めない」（design.md §16.18）という方針と
 * 食い違うため、このコードベースの他のCLI呼び出し（`runFinalMerge`等）と同じくResult型へ揃える。
 */
function buildMarkReadyArgs(
  host: ForgeHost,
  number: number,
): { ok: true; command: 'gh' | 'glab'; args: string[] } | { ok: false; message: string } {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, message: `不正なPR/MR番号（正の整数ではありません）: ${number}` };
  }
  if (host === 'github') {
    return { ok: true, command: 'gh', args: ['pr', 'ready', String(number)] };
  }
  return { ok: true, command: 'glab', args: ['mr', 'update', String(number), '--ready'] };
}

export type MarkPullRequestReadyResult = { ok: true } | { ok: false; message: string };

/**
 * Draftで作ったPR/MRをreadyへ切り替える（`gh pr ready` / `glab mr update --ready`）。
 * `runFinalMerge`と同じ形（失敗してもエラーにせず結果型で返し、失敗時はstderrを
 * `sanitizeForLog`へ通してメッセージにする）。不正な`number`（`buildMarkReadyArgs`が
 * `{ ok: false }`を返す場合）も同じ結果型で返し、例外を投げない。
 *
 * 「Draft PR/MRとして作成し、統合マージ後にreadyへ切り替える」フローの最後の手順に当たる。
 * タスク層では`runTaskPullRequestFlow`が`mergeAndPushIntegration`の後に呼ぶ（design.md
 * §16.18「ready化は統合ブランチへのマージが済んでからDraftを外す」）。統合層での呼び出し順序
 * （最終マージの直前に呼ぶ必要があること）の強制は`CreateIntegrationPullRequestRequest.draft`
 * のJSDocに記載のとおり配線担当の責務で、この関数自体はいつ呼ばれても同じように動く。
 */
export async function markPullRequestReady(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<MarkPullRequestReadyResult> {
  const built = buildMarkReadyArgs(host, number);
  if (!built.ok) {
    return { ok: false, message: built.message };
  }
  const { command, args } = built;
  const result = await cli.run(command, args, cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `${command} ${args.join(' ')} に失敗しました（終了コード ${result.code}）`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------------------------- */
/* CIの完了待ちとbaseの取り込み直し（design.md §16.36、Issue #556）                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * CIチェックの集約結果（design.md §16.36）。
 *
 * - `none`: チェックが1件も設定されていない（CI未設定リポジトリ）。この場合は待たずに
 *   即座にマージへ進む（受入基準「CIが設定されていないリポジトリでは従来どおり即マージする」）。
 *   **`none`はリポジトリ側が意味を持って返す明示的な形（`statusCheckRollup: []` /
 *   `head_pipeline: null`）に限る。** JSONの解析自体には成功したが期待するキーが
 *   無い・型が違う（`gh`/`glab`のバージョン差やAPIのスキーマ変更を想定）場合は
 *   `none`ではなく`failed`へ倒す（セキュリティ監査の指摘。2026-08-23。「チェックが
 *   0件」と「応答の形が想定外」を型のレベルで区別し、後者を空配列と取り違えて
 *   fail-openにしない）
 * - `pending`: 1件でも完了していないチェックがある
 * - `passed`: 全て完了し、失敗が無い
 * - `failed`: 完了したチェックの中に失敗がある（CLI呼び出し自体の失敗、および上記の
 *   応答形が想定外な場合もここに含める。認証切れ等で状態を取得できない異常状態を
 *   `pending`のまま無期限に待たせないため）
 */
export type CiConclusion = 'none' | 'pending' | 'passed' | 'failed';

export interface CiConclusionResult {
  conclusion: CiConclusion;
  /** `failed`のとき、失敗した理由を人が読める形にしたもの。 */
  message?: string;
}

/** `gh pr view <number> --json=statusCheckRollup` が返す1件分の型（必要な項目だけ）。 */
interface GithubStatusCheckRollupEntry {
  status?: unknown;
  state?: unknown;
  conclusion?: unknown;
}

/**
 * GitHubの`conclusion`のうち成功として扱う値。`SKIPPED`は必須チェックでなければ
 * ブロックしない、の意。
 *
 * セキュリティ監査の指摘（2026-08-23）を受けて「失敗値のホワイトリスト」から
 * 「成功値のホワイトリスト」へ反転した。失敗値のホワイトリストは、ここに載って
 * いない未知の値（例: baseが進んだ後の再実行待ちを示す`STALE`）を素通しして成功
 * 寄りに扱ってしまう構造的なfail-openになる。この機能はmainへの実マージを左右
 * するため、知らない`conclusion`が来たときは待つ・失敗させる側（fail-closed）へ
 * 倒すほうが安全（`STALE`はこの反転により自動的に失敗側へ回る。個別に列挙する
 * 必要が無い）。
 */
const GITHUB_SUCCESS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * `gh pr view <number> --json=statusCheckRollup` の標準出力を解釈する（純粋関数）。
 *
 * `statusCheckRollup`の要素はCheckRun（`status`/`conclusion`を持つ）とStatusContext
 * （レガシーAPI由来。`state`だけを持つ）が混在しうる（GitHub GraphQLの仕様）。両方を見る。
 */
export function parseGithubCiConclusion(stdout: string): CiConclusionResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { conclusion: 'failed', message: 'statusCheckRollupの出力を解釈できませんでした' };
  }
  // パースはできたがオブジェクトでない・`statusCheckRollup`キーが無い・配列でない場合は
  // 「チェックが0件（`none`）」ではなく想定外の応答形（`failed`）として扱う。空配列
  // （キーがあり、明示的に0件）とは型のレベルで区別する（セキュリティ監査の指摘）
  if (typeof data !== 'object' || data === null) {
    return {
      conclusion: 'failed',
      message: 'statusCheckRollupの出力を解釈できませんでした（想定外の応答形）',
    };
  }
  if (!('statusCheckRollup' in data)) {
    return {
      conclusion: 'failed',
      message: 'statusCheckRollupキーが応答に含まれていません（想定外の応答形）',
    };
  }
  const rollup = (data as { statusCheckRollup: unknown }).statusCheckRollup;
  if (!Array.isArray(rollup)) {
    return {
      conclusion: 'failed',
      message: 'statusCheckRollupが配列ではありません（想定外の応答形）',
    };
  }
  if (rollup.length === 0) {
    return { conclusion: 'none' };
  }
  const entries = rollup as GithubStatusCheckRollupEntry[];
  const failed: string[] = [];
  let pending = false;
  for (const entry of entries) {
    if (typeof entry.state === 'string') {
      // StatusContext（レガシーAPI由来）
      const state = entry.state.toUpperCase();
      if (state === 'PENDING') {
        pending = true;
      } else if (state === 'ERROR' || state === 'FAILURE') {
        failed.push(state);
      }
      continue;
    }
    const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
    if (status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    // 成功値のホワイトリストに無い値は全て失敗として扱う（`STALE`等の未知の値を
    // 含む。`GITHUB_SUCCESS_CONCLUSIONS`のコメント参照）
    const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : '';
    if (!GITHUB_SUCCESS_CONCLUSIONS.has(conclusion)) {
      failed.push(conclusion === '' ? '(不明)' : conclusion);
    }
  }
  if (failed.length > 0) {
    // 失敗したチェックの件数・名前に上限が無いと、チェックが数百あるリポジトリで
    // このメッセージがそのまま`live.warnings`・ログへ入り巨大化する
    // （レビュー指摘。2026-08-23）。他のCLI出力由来のメッセージと同じく`sanitizeForLog`
    // で長さを切る（現状の値はGitHubのenum語彙なので制御文字等の実害は無いが、
    // 「ここは通さなくてよい」と読ませない表記の一貫性のため）
    return {
      conclusion: 'failed',
      message: sanitizeForLog(`失敗したチェックがあります: ${failed.join(', ')}`),
    };
  }
  if (pending) {
    return { conclusion: 'pending' };
  }
  return { conclusion: 'passed' };
}

/**
 * GitLabの`head_pipeline.status`のうち失敗として扱う値。
 */
const GITLAB_FAILURE_PIPELINE_STATUSES = new Set(['failed', 'canceled', 'cancelled']);
/** GitLabの`head_pipeline.status`のうち成功として扱う値（`skipped`は必須でなければブロックしない）。 */
const GITLAB_PASSED_PIPELINE_STATUSES = new Set(['success', 'skipped']);

/**
 * `glab api projects/:id/merge_requests/<iid>` の標準出力を解釈する（純粋関数）。
 *
 * `glab ci status`はテキスト向けの対話コマンドでJSON出力が無く、しかも対象を「ブランチ」で
 * 指定する（実機の`--help`で確認済み。`glab` 1.112.0。`docs.gitlab.com/cli/ci/status/`も
 * 同様）ため、`createPullRequest`と同じく構造化データを得やすい`glab api`へ寄せた
 * （Issue #556。「同じ形で用意する」はコマンド名の一致ではなく、CIの完了待ち・失敗判定という
 * 挙動の一致を指す）。GitLabのMR単体取得レスポンスは`head_pipeline`フィールドにそのMRの
 * 先頭コミットのパイプライン状態を持つ（`docs.gitlab.com/api/merge_requests/`）。
 * `head_pipeline`が無い（`null`）ならパイプライン自体が無い＝CI未設定として扱う。
 */
export function parseGitlabCiConclusion(stdout: string): CiConclusionResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { conclusion: 'failed', message: 'マージリクエストの応答を解釈できませんでした' };
  }
  if (typeof data !== 'object' || data === null) {
    return {
      conclusion: 'failed',
      message: 'マージリクエストの応答を解釈できませんでした（想定外の応答形）',
    };
  }
  // `head_pipeline`キーが無い・`null`以外の想定外の型は「パイプライン無し（`none`）」
  // ではなく想定外の応答形（`failed`）として扱う。GitLabが「パイプライン自体が無い」
  // ことを表す明示的な形は`null`のみ（`docs.gitlab.com/api/merge_requests/`）。
  // キーが無いのはAPIのスキーマ変更等を想定した異常系（セキュリティ監査の指摘）
  if (!('head_pipeline' in data)) {
    return {
      conclusion: 'failed',
      message: 'head_pipelineキーが応答に含まれていません（想定外の応答形）',
    };
  }
  const headPipeline = (data as Record<string, unknown>)['head_pipeline'];
  if (headPipeline === null) {
    return { conclusion: 'none' };
  }
  if (typeof headPipeline !== 'object') {
    return { conclusion: 'failed', message: 'head_pipelineの形が想定外です' };
  }
  const status = (headPipeline as Record<string, unknown>)['status'];
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  if (GITLAB_FAILURE_PIPELINE_STATUSES.has(normalized)) {
    // GitHub側と同じ理由で`sanitizeForLog`を通す（レビュー指摘。2026-08-23）
    return {
      conclusion: 'failed',
      message: sanitizeForLog(`パイプラインが失敗しました（status: ${normalized}）`),
    };
  }
  if (GITLAB_PASSED_PIPELINE_STATUSES.has(normalized)) {
    return { conclusion: 'passed' };
  }
  // running / pending / created / waiting_for_resource / preparing / scheduled / manual等
  return { conclusion: 'pending' };
}

/** ホストごとのCI状態取得コマンド（design.md §16.36）。 */
function buildCiStatusArgs(
  host: ForgeHost,
  number: number,
): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    return { command: 'gh', args: ['pr', 'view', String(number), '--json=statusCheckRollup'] };
  }
  return { command: 'glab', args: ['api', `projects/:id/merge_requests/${String(number)}`] };
}

/**
 * PR/MRのCI状態を1回だけ取得する。ポーリングそのものは`waitForCiChecks`が担う。
 *
 * CLI呼び出し自体が失敗した場合（認証切れ・番号不正など）は`failed`として扱う。
 * `pending`のまま返すと、状態を取得できない異常状態がタイムアウトまで気づかれない。
 */
export async function fetchCiConclusion(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<CiConclusionResult> {
  const { command, args } = buildCiStatusArgs(host, number);
  const result = await cli.run(command, args, cwd);
  if (result.code !== 0) {
    return {
      conclusion: 'failed',
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `${command} ${args.join(' ')} に失敗しました（終了コード ${result.code}）`,
    };
  }
  return host === 'github'
    ? parseGithubCiConclusion(result.stdout)
    : parseGitlabCiConclusion(result.stdout);
}

/** PR/MRのマージ可否と承認状態をHubへ渡す共通表現。 */
export interface PullRequestStatus {
  state: 'open' | 'merged' | 'closed' | 'unknown';
  draft: boolean | undefined;
  mergeable: boolean | undefined;
  approvalsLeft: number | undefined;
  message: string | undefined;
}

/** `gh pr view --json=state,isDraft,mergeable,mergeStateStatus,reviewDecision`を解釈する。 */
export function parseGithubPullRequestStatus(stdout: string): PullRequestStatus {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not object');
    data = parsed as Record<string, unknown>;
  } catch {
    return {
      state: 'unknown',
      draft: undefined,
      mergeable: undefined,
      approvalsLeft: undefined,
      message: 'PR状態の応答を解釈できませんでした',
    };
  }
  const stateValue = typeof data['state'] === 'string' ? data['state'].toUpperCase() : '';
  const state =
    stateValue === 'OPEN'
      ? 'open'
      : stateValue === 'MERGED'
        ? 'merged'
        : stateValue === 'CLOSED'
          ? 'closed'
          : 'unknown';
  const mergeable =
    typeof data['mergeable'] === 'string'
      ? data['mergeable'].toUpperCase() === 'MERGEABLE'
      : undefined;
  const reviewDecision =
    typeof data['reviewDecision'] === 'string' ? data['reviewDecision'].toUpperCase() : '';
  const approvalsLeft = reviewDecision === 'APPROVED' ? 0 : reviewDecision === '' ? undefined : 1;
  const mergeState =
    typeof data['mergeStateStatus'] === 'string' ? data['mergeStateStatus'] : undefined;
  return {
    state,
    draft: typeof data['isDraft'] === 'boolean' ? data['isDraft'] : undefined,
    mergeable,
    approvalsLeft,
    message: mergeState,
  };
}

/** GitLabのMR本体とapprovals APIの応答を解釈する。 */
export function parseGitlabPullRequestStatus(
  mergeRequestStdout: string,
  approvalsStdout: string | undefined,
): PullRequestStatus {
  try {
    const parsed: unknown = JSON.parse(mergeRequestStdout);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not object');
    const data = parsed as Record<string, unknown>;
    const stateValue = typeof data['state'] === 'string' ? data['state'].toLowerCase() : '';
    const state =
      stateValue === 'opened'
        ? 'open'
        : stateValue === 'merged'
          ? 'merged'
          : stateValue === 'closed'
            ? 'closed'
            : 'unknown';
    const mergeStatus =
      typeof data['detailed_merge_status'] === 'string' ? data['detailed_merge_status'] : undefined;
    let approvalsLeft: number | undefined;
    if (approvalsStdout !== undefined) {
      const approvals: unknown = JSON.parse(approvalsStdout);
      if (
        typeof approvals === 'object' &&
        approvals !== null &&
        typeof (approvals as Record<string, unknown>)['approvals_left'] === 'number'
      ) {
        approvalsLeft = (approvals as Record<string, unknown>)['approvals_left'] as number;
      }
    }
    return {
      state,
      draft: typeof data['draft'] === 'boolean' ? data['draft'] : undefined,
      mergeable: mergeStatus === 'mergeable' ? true : mergeStatus === undefined ? undefined : false,
      approvalsLeft,
      message: mergeStatus,
    };
  } catch {
    return {
      state: 'unknown',
      draft: undefined,
      mergeable: undefined,
      approvalsLeft: undefined,
      message: 'MR状態の応答を解釈できませんでした',
    };
  }
}

/** PR/MR状態を1回取得する。GitLabでは承認状態も追加で読む。 */
export async function fetchPullRequestStatus(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<PullRequestStatus> {
  if (host === 'github') {
    const result = await cli.run(
      'gh',
      [
        'pr',
        'view',
        String(number),
        '--json=state,isDraft,mergeable,mergeStateStatus,reviewDecision',
      ],
      cwd,
    );
    return result.code === 0
      ? parseGithubPullRequestStatus(result.stdout)
      : {
          state: 'unknown',
          draft: undefined,
          mergeable: undefined,
          approvalsLeft: undefined,
          message: sanitizeForLog(result.stderr || 'PR状態を取得できませんでした'),
        };
  }
  const mr = await cli.run('glab', ['api', `projects/:id/merge_requests/${String(number)}`], cwd);
  if (mr.code !== 0)
    return {
      state: 'unknown',
      draft: undefined,
      mergeable: undefined,
      approvalsLeft: undefined,
      message: sanitizeForLog(mr.stderr || 'MR状態を取得できませんでした'),
    };
  const approvals = await cli.run(
    'glab',
    ['api', `projects/:id/merge_requests/${String(number)}/approvals`],
    cwd,
  );
  return parseGitlabPullRequestStatus(
    mr.stdout,
    approvals.code === 0 ? approvals.stdout : undefined,
  );
}

/** `waitForCiChecks`のポーリング間隔をテストから注入するための型（`PushBranchWait`と同じ方針）。 */
export type CiWait = () => Promise<void>;

/** ポーリング間隔（ミリ秒）。 */
const CI_POLL_INTERVAL_MS = 15_000;

const defaultCiWait: CiWait = () =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, CI_POLL_INTERVAL_MS);
    // `runner.ts`の最終マージ判断タイムアウト（`beginFinalMergeDecision`）と同じく、
    // このタイマーだけでテスト・プロセス終了を妨げないようにする
    // （レビュー指摘。2026-08-23。以前は`.unref()`が無く扱いが不揃いだった）
    timer.unref?.();
  });

export type CiWaitOutcome =
  | { kind: 'none' }
  | { kind: 'passed' }
  | { kind: 'failed'; message: string }
  | { kind: 'timeout'; message: string }
  /**
   * 人が「全体の停止」を押した（`isCancelled`が`true`を返した）ため、CIの完了を
   * 待たずに切り上げた（セキュリティ監査の指摘。2026-08-23。W1（Issue #335）が
   * 「判断が確定する瞬間」を守ったのに対し、W11（Issue #556）が新設したCI待ちの
   * 長い区間（既定で最大約90分）を守る）。
   */
  | { kind: 'cancelled' };

/**
 * CIチェックの完了を待つ（design.md §16.36「CIの完了を待つ」）。`pending`の間は
 * `wait`（既定は`CI_POLL_INTERVAL_MS`間隔の実待ち）を挟んでポーリングし、`timeoutMs`を
 * 超えたら赤（`failed`）と同じ扱いの`timeout`を返す（受入基準「待ち時間の上限を超えたら
 * 赤と同じ扱いになる」）。`now`/`wait`はテストから注入できる（`pushBranch`と同じ流儀。
 * テストは実時間で待たない）。
 */
export async function waitForCiChecks(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
  timeoutMs: number,
  now: () => number = Date.now,
  wait: CiWait = defaultCiWait,
  isCancelled: () => boolean = () => false,
): Promise<CiWaitOutcome> {
  const deadline = now() + timeoutMs;
  for (;;) {
    // ループの先頭で毎周確認する。これは「これから行う`fetchCiConclusion`の直前」で
    // あると同時に、初回以外は「直前の`wait()`の直後」でもある（`wait()`の前後の
    // 両方を見る、というセキュリティ監査の要求を1箇所の確認で満たす）
    if (isCancelled()) {
      return { kind: 'cancelled' };
    }
    const result = await fetchCiConclusion(cli, host, cwd, number);
    if (result.conclusion === 'none') {
      return { kind: 'none' };
    }
    if (result.conclusion === 'passed') {
      return { kind: 'passed' };
    }
    if (result.conclusion === 'failed') {
      return { kind: 'failed', message: result.message ?? 'CIチェックが失敗しました' };
    }
    if (now() >= deadline) {
      return {
        kind: 'timeout',
        message: `CIチェックの完了を待つ時間の上限を超えました（${Math.floor(timeoutMs / 1000)}秒）`,
      };
    }
    await wait();
  }
}

/** ホストごとの取り込み直しコマンド（design.md §16.36）。 */
function buildUpdateBranchArgs(
  host: ForgeHost,
  number: number,
): { ok: true; command: 'gh' | 'glab'; args: string[] } | { ok: false; message: string } {
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, message: `不正なPR/MR番号（正の整数ではありません）: ${number}` };
  }
  if (host === 'github') {
    return { ok: true, command: 'gh', args: ['pr', 'update-branch', String(number)] };
  }
  return { ok: true, command: 'glab', args: ['mr', 'rebase', String(number)] };
}

export type UpdatePullRequestBranchResult = { ok: true } | { ok: false; message: string };

/**
 * PR/MRのbaseを取り込み直す（`gh pr update-branch <number>` / `glab mr rebase <number>`。
 * design.md §16.36「baseの取り込み直し」）。strictなブランチ保護の下でマージが
 * 「baseの最新でない」ことで拒否されたときに呼ぶ。
 */
export async function updatePullRequestBranch(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<UpdatePullRequestBranchResult> {
  const built = buildUpdateBranchArgs(host, number);
  if (!built.ok) {
    return { ok: false, message: built.message };
  }
  const { command, args } = built;
  const result = await cli.run(command, args, cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `${command} ${args.join(' ')} に失敗しました（終了コード ${result.code}）`,
    };
  }
  return { ok: true };
}

/**
 * マージ失敗のメッセージが「baseの最新でない」ことを理由にした拒否かどうか（`isRetryablePushError`
 * と同じ、stderrのテキストパターン照合による判定。design.md §16.36）。
 *
 * GitHub・GitLabいずれも「これに一致すれば必ずbase遅れ」という単一の構造化フィールドを
 * CLIの標準エラーからは得られない（`gh pr merge`はGraphQLエラー文字列を、`glab mr merge`は
 * REST APIのエラーメッセージをそのままstderrへ出す）ため、既知の文言をパターンで拾う。
 * 一致しなければ「baseの最新でない」以外の失敗（コンフリクト・権限不足等）として扱い、
 * 取り込み直しは試みない（取り込み直しても解決しない失敗を再試行で浪費しないため）。
 *
 * **逆に、実際は「baseの最新でない」以外の失敗（コンフリクト解消の案内文等）でも
 * このパターンに一致してしまう場合がありうる**（テキストパターン照合の限界。特に
 * `needs? (a )?rebase`は緩め）。誤って一致したときは`updatePullRequestBranch`を無駄に
 * 1回試みるだけで、それでも解決しなければ次の`runFinalMerge`が同じ理由（コンフリクト等）
 * で再び失敗し、`maxUpdateBranchRetries`の上限で必ず止まる（無限リトライにはならない。
 * レビュー指摘。2026-08-23）。
 */
const NOT_UP_TO_DATE_PATTERN =
  /not up.to.date|out.of.date with the base|base branch was modified|head branch was modified|is behind the (base|target) branch|needs? (a )?rebase/iu;

export function isBranchNotUpToDateError(message: string): boolean {
  return NOT_UP_TO_DATE_PATTERN.test(message);
}

/**
 * CIチェックの完了を待つ時間の上限（秒）の既定値（`agent.workflows.ciWaitTimeoutSec`、
 * design.md §16.36）。CIの実行時間はリポジトリごとに大きく異なるため長めに取る。
 */
export const DEFAULT_CI_WAIT_TIMEOUT_SEC = 1800;

/**
 * 「baseの最新でない」拒否からの取り込み直しの最大リトライ回数の既定値
 * （`agent.workflows.ciUpdateBranchMaxRetries`、design.md §16.36）。
 */
export const DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES = 2;

/** `runFinalMergeWithCiGate`が読む待ち時間・リトライ回数の設定。 */
export interface CiGateConfig {
  /** CIチェックの完了を待つ時間の上限（ミリ秒）。design.md §16.36・`agent.workflows.ciWaitTimeoutSec`。 */
  waitTimeoutMs: number;
  /**
   * 「baseの最新でない」拒否からの取り込み直しの最大リトライ回数（初回のマージ試行を
   * 含まない）。design.md §16.36・`agent.workflows.ciUpdateBranchMaxRetries`。
   */
  maxUpdateBranchRetries: number;
  now?: () => number;
  wait?: CiWait;
  /**
   * 人が「全体の停止」を押したかどうかを問い合わせるコールバック（`config.now` /
   * `config.wait`と同じ、テストから注入できる流儀）。`forge.ts`はロジック層で
   * `LiveRun`を直接見られないため、`runner.ts`側が`live.runState.haltedByUser`
   * （必要なら`dispose()`中かどうかも合わせて）を見る関数を渡す。省略時は常に
   * `false`（＝停止していない）として扱う。セキュリティ監査の指摘（2026-08-23）:
   * CI待ちのポーリング・取り込み直しの再試行ループの各周回で確認する
   */
  isCancelled?: () => boolean;
}

export type RunFinalMergeWithCiGateResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'ciFailed' | 'ciTimeout' | 'updateBranchFailed' | 'mergeFailed' | 'cancelled';
      message: string;
      /** 「baseの最新でない」ことによる取り込み直しを実際に試みた回数。 */
      updateBranchAttempts: number;
    };

/**
 * 統合PR/MRをCIの完了待ち・baseの取り込み直しを挟んだうえでマージする（design.md §16.36、
 * Issue #556）。`performFinalMerge`（`runner.ts`）が`runFinalMerge`の代わりに呼ぶ、
 * このモジュールでの唯一の最終マージの入口になる。
 *
 * 手順:
 * 1. CIチェックの完了を待つ（`waitForCiChecks`）。`none`（CI未設定）・`passed`ならマージへ
 *    進む。`failed`・`timeout`はマージせず、理由付きで失敗を返す（受入基準）
 * 2. マージを試みる（`runFinalMerge`）。成功すれば完了
 * 3. 失敗理由が「baseの最新でない」（`isBranchNotUpToDateError`）で、かつ取り込み直しの
 *    残り回数があれば、`updatePullRequestBranch`を実行し、1へ戻ってCIの完了を待ち直してから
 *    再度マージを試みる（取り込み直しはbaseの内容を変えるため、直前のCI結果を使い回さず
 *    再取得する）
 * 4. 「baseの最新でない」以外の失敗、または取り込み直しの上限を超えたら、理由付きで失敗を返す
 *
 * `number`が`undefined`のとき（統合PR/MRの番号が不明）はCI状態を取得しようがないため、
 * 待たずに`runFinalMerge`（番号不明時は自身がCLIを呼ばず`{ ok: false }`を返す）へそのまま
 * 委ねる。
 *
 * **`config.isCancelled`が`true`を返す間はマージへ進まない。** CI待ちのポーリングの各周回
 * （`waitForCiChecks`の内部）、`waitForCiChecks`から制御が戻った直後（`none`/`passed`で
 * 即座に返った場合を含む）、`updatePullRequestBranch`を呼ぶ直前の3箇所で確認する
 * （セキュリティ監査の指摘。2026-08-23）。W1（Issue #335）が「最終マージの判断が確定する
 * 瞬間」を`decideFinalMerge`のガードで守ったのに対し、W11（Issue #556）はその判断の後に
 * 新設したCI待ち・取り込み直しの長い区間（既定で最大`waitTimeoutMs` ×
 * (`maxUpdateBranchRetries` + 1）秒、既定値では約90分）を守る必要がある。瞬間だけを守る
 * ガードは、この待ちが伸びた分をカバーしないため。
 */
export async function runFinalMergeWithCiGate(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number | undefined,
  config: CiGateConfig,
): Promise<RunFinalMergeWithCiGateResult> {
  const isCancelled = config.isCancelled ?? (() => false);
  const cancelledResult: RunFinalMergeWithCiGateResult = {
    ok: false,
    reason: 'cancelled',
    message: '人が停止したため最終マージを中止しました',
    updateBranchAttempts: 0,
  };

  if (number === undefined) {
    const merge = await runFinalMerge(cli, host, cwd, number);
    return merge.ok
      ? { ok: true }
      : { ok: false, reason: 'mergeFailed', message: merge.message, updateBranchAttempts: 0 };
  }

  for (let attempt = 0; attempt <= config.maxUpdateBranchRetries; attempt += 1) {
    const ci = await waitForCiChecks(
      cli,
      host,
      cwd,
      number,
      config.waitTimeoutMs,
      config.now,
      config.wait,
      isCancelled,
    );
    if (ci.kind === 'cancelled') {
      return { ...cancelledResult, updateBranchAttempts: attempt };
    }
    if (ci.kind === 'failed') {
      return { ok: false, reason: 'ciFailed', message: ci.message, updateBranchAttempts: attempt };
    }
    if (ci.kind === 'timeout') {
      return { ok: false, reason: 'ciTimeout', message: ci.message, updateBranchAttempts: attempt };
    }
    // 'none' か 'passed'（CI未設定リポジトリは待たずにここへ来る。受入基準）。
    // CIの完了を待っている間に停止された可能性があるため、実マージを呼ぶ直前でも
    // 改めて確認する（セキュリティ監査の指摘。`waitForCiChecks`の`isCancelled`は
    // ポーリングの各周回だけを見ており、`none`/`passed`で即座に返った直後は通らない）
    if (isCancelled()) {
      return { ...cancelledResult, updateBranchAttempts: attempt };
    }
    const merge = await runFinalMerge(cli, host, cwd, number);
    if (merge.ok) {
      return { ok: true };
    }
    const isLastAttempt = attempt === config.maxUpdateBranchRetries;
    if (isLastAttempt || !isBranchNotUpToDateError(merge.message)) {
      return {
        ok: false,
        reason: 'mergeFailed',
        message: merge.message,
        updateBranchAttempts: attempt,
      };
    }
    // 取り込み直し（baseへ実際に変更を及ぼす操作）を呼ぶ直前でも確認する
    if (isCancelled()) {
      return { ...cancelledResult, updateBranchAttempts: attempt };
    }
    const updated = await updatePullRequestBranch(cli, host, cwd, number);
    if (!updated.ok) {
      return {
        ok: false,
        reason: 'updateBranchFailed',
        message: updated.message,
        updateBranchAttempts: attempt + 1,
      };
    }
    // 取り込み直したので、ループの先頭でCIの完了を待ち直してから再度マージを試みる
  }
  // 上のループは必ずreturnで終わる（TypeScriptの制御フロー解析のためのフォールバック）
  return {
    ok: false,
    reason: 'mergeFailed',
    message: '最終マージに失敗しました（取り込み直しの上限に達しました）',
    updateBranchAttempts: config.maxUpdateBranchRetries,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* レビューコメントの取得（design.md §16.30、roadmap W5、Issue #339）                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * 統合PR/MRに付いた1件のレビューコメント（design.md §16.30）。GitHub（レビュー本体・
 * レビュー内コメント・issueコメントの3種）とGitLab（note）の差異を吸収した共通の形。
 *
 * `body` は**外部由来のテキストであり、指示ではなくデータとして扱う**（design.md §16.24・
 * Issue #339受入基準）。ここでは無害化しない。呼び出し側（`runnerReviewComments.ts`）が
 * オーケストレーターへ渡す本文を組み立て、最終的な無害化は`orchestratorSession.ts`の
 * `wrapEvent`（`escapeAngleBrackets` + `stripControlCharsPreservingNewlines`）が一度だけ行う
 * （二重サニタイズを避ける。design.md §16.24・§16.34と同じ「本文を組み立てる側では
 * サニタイズしない」規約）。
 */
export interface ReviewComment {
  /** ホスト側のコメントid（GitHubは`databaseId`、GitLabは`id`）を文字列化したもの。重複検知に使う。 */
  id: string;
  /** 投稿者のユーザー名。空文字なら不明として扱う。 */
  author: string;
  /** コメント本文（無害化前）。 */
  body: string;
  createdAt?: string;
  /** 返信・解決に使うスレッドID。スレッドを持たないコメントでは未設定。 */
  threadId?: string;
  resolved?: boolean;
}

export interface ReviewCommentsResult {
  ok: boolean;
  comments: ReviewComment[];
  message?: string;
}

/** ホストごとのレビューコメント取得コマンド（design.md §16.30）。`fetchCiConclusion`の`buildCiStatusArgs`と同じ方針。 */
function buildReviewCommentsArgs(
  host: ForgeHost,
  number: number,
): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    return { command: 'gh', args: ['pr', 'view', String(number), '--json=reviews,comments'] };
  }
  return { command: 'glab', args: ['api', `projects/:id/merge_requests/${String(number)}/notes`] };
}

/** GitHubの`reviews`/`comments`の要素のうち、パースに使う項目だけの型。 */
interface GithubReviewEntry {
  databaseId?: unknown;
  id?: unknown;
  author?: { login?: unknown } | null;
  body?: unknown;
  submittedAt?: unknown;
  createdAt?: unknown;
}

function toReviewComment(
  prefix: string,
  entry: GithubReviewEntry,
  fallbackIndex: number,
): ReviewComment | undefined {
  const body = typeof entry.body === 'string' ? entry.body : '';
  if (body.trim() === '') {
    // 本文の無いレビュー（APPROVEやコメント無しのRequest changes等）は取り込む対象が
    // 無いため除外する。`state`（APPROVED等）自体は追う対象外（design.md §16.30は
    // コメント本文の取り込みが目的で、承認状態の同期は範囲外）
    return undefined;
  }
  const rawId = entry.databaseId ?? entry.id;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number'
      ? `${prefix}:${String(rawId)}`
      : `${prefix}:${String(fallbackIndex)}`;
  const author = typeof entry.author?.login === 'string' ? entry.author.login : '';
  const createdAt =
    typeof entry.submittedAt === 'string'
      ? entry.submittedAt
      : typeof entry.createdAt === 'string'
        ? entry.createdAt
        : undefined;
  return createdAt === undefined ? { id, author, body } : { id, author, body, createdAt };
}

/**
 * `gh pr view <number> --json=reviews,comments` の標準出力を解釈する（純粋関数）。
 *
 * `reviews`（レビュー本体。承認・変更要求等に添えたコメント）と`comments`（PRへの
 * issueコメント）の両方を対象にする。レビュー内の個別コメント（review comments API相当）は
 * `gh pr view`のJSON出力に含まれないため対象外（`gh api`での別経路の取得はIssue #339の
 * スコープ外、design.md §16.30「今回は含めないもの」）。
 */
export function parseGithubReviewComments(stdout: string): ReviewCommentsResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, comments: [], message: 'reviews/commentsの出力を解釈できませんでした' };
  }
  if (typeof data !== 'object' || data === null) {
    return {
      ok: false,
      comments: [],
      message: 'reviews/commentsの出力を解釈できませんでした（想定外の応答形）',
    };
  }
  const record = data as Record<string, unknown>;
  const reviews = Array.isArray(record['reviews'])
    ? (record['reviews'] as GithubReviewEntry[])
    : [];
  const comments = Array.isArray(record['comments'])
    ? (record['comments'] as GithubReviewEntry[])
    : [];
  const result: ReviewComment[] = [];
  reviews.forEach((entry, index) => {
    const comment = toReviewComment('review', entry, index);
    if (comment !== undefined) {
      result.push(comment);
    }
  });
  comments.forEach((entry, index) => {
    const comment = toReviewComment('comment', entry, index);
    if (comment !== undefined) {
      result.push(comment);
    }
  });
  return { ok: true, comments: result };
}

/** GitHub GraphQLのreviewThreads応答を、返信・解決可能なコメントへ変換する。 */
export function parseGithubReviewThreads(stdout: string): ReviewCommentsResult {
  try {
    const data = JSON.parse(stdout) as {
      data?: { node?: { reviewThreads?: { nodes?: unknown[] } } };
    };
    const threads = data.data?.node?.reviewThreads?.nodes;
    if (!Array.isArray(threads)) throw new Error('invalid response');
    const comments: ReviewComment[] = [];
    for (const thread of threads) {
      if (typeof thread !== 'object' || thread === null) continue;
      const record = thread as Record<string, unknown>;
      const threadId = typeof record['id'] === 'string' ? record['id'] : undefined;
      const resolved = typeof record['isResolved'] === 'boolean' ? record['isResolved'] : undefined;
      const nodes = (record['comments'] as { nodes?: unknown[] } | undefined)?.nodes;
      if (threadId === undefined || !Array.isArray(nodes)) continue;
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue;
        const comment = node as Record<string, unknown>;
        const body = typeof comment['body'] === 'string' ? comment['body'] : '';
        if (body.trim() === '') continue;
        const author =
          typeof (comment['author'] as { login?: unknown } | undefined)?.login === 'string'
            ? (comment['author'] as { login: string }).login
            : '';
        const id =
          typeof comment['id'] === 'string' ? comment['id'] : `${threadId}:${comments.length}`;
        const createdAt =
          typeof comment['createdAt'] === 'string' ? comment['createdAt'] : undefined;
        comments.push({
          id,
          author,
          body,
          threadId,
          ...(createdAt === undefined ? {} : { createdAt }),
          ...(resolved === undefined ? {} : { resolved }),
        });
      }
    }
    return { ok: true, comments };
  } catch {
    return { ok: false, comments: [], message: 'reviewThreadsの出力を解釈できませんでした' };
  }
}

/** GitLabの note の要素のうち、パースに使う項目だけの型。 */
interface GitlabNoteEntry {
  id?: unknown;
  body?: unknown;
  author?: { username?: unknown } | null;
  created_at?: unknown;
  system?: unknown;
  resolved?: unknown;
}

interface GitlabDiscussionEntry {
  id?: unknown;
  notes?: unknown;
}

/**
 * `glab api projects/:id/merge_requests/<iid>/notes` の標準出力を解釈する（純粋関数）。
 *
 * `system: true`のnote（ラベル変更・承認等、GitLabが自動生成する記録）は人が書いた
 * レビューコメントではないため除外する。
 */
export function parseGitlabReviewComments(stdout: string): ReviewCommentsResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, comments: [], message: 'notesの出力を解釈できませんでした' };
  }
  if (!Array.isArray(data)) {
    return {
      ok: false,
      comments: [],
      message: 'notesの出力を解釈できませんでした（想定外の応答形）',
    };
  }
  const discussions = data as Array<GitlabNoteEntry | GitlabDiscussionEntry>;
  const result: ReviewComment[] = [];
  discussions.forEach((discussion, discussionIndex) => {
    const rawThreadId = (discussion as GitlabDiscussionEntry).id;
    const threadId = typeof rawThreadId === 'string' ? rawThreadId : undefined;
    const entries = Array.isArray((discussion as GitlabDiscussionEntry).notes)
      ? ((discussion as GitlabDiscussionEntry).notes as GitlabNoteEntry[])
      : [discussion as GitlabNoteEntry];
    entries.forEach((entry, index) => {
      if (entry.system === true) return;
      const body = typeof entry.body === 'string' ? entry.body : '';
      if (body.trim() === '') return;
      const id =
        typeof entry.id === 'string' || typeof entry.id === 'number'
          ? `note:${String(entry.id)}`
          : `note:${String(discussionIndex)}:${String(index)}`;
      const author = typeof entry.author?.username === 'string' ? entry.author.username : '';
      const createdAt = typeof entry.created_at === 'string' ? entry.created_at : undefined;
      result.push({
        id,
        author,
        body,
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(typeof entry.resolved === 'boolean' ? { resolved: entry.resolved } : {}),
      });
    });
  });
  return { ok: true, comments: result };
}

/**
 * PR/MRのレビューコメントを1回だけ取得する（design.md §16.30）。ポーリングそのものは
 * `runnerReviewComments.ts`の`pollReviewComments`が担う（`fetchCiConclusion`と
 * `waitForCiChecks`の分担と同じ形）。
 *
 * CLI呼び出し自体が失敗した場合（認証切れ・番号不正等）は`ok: false`を返す。
 */
export async function fetchReviewComments(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<ReviewCommentsResult> {
  const { command, args } = buildReviewCommentsArgs(host, number);
  const result = await cli.run(command, args, cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      comments: [],
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `${command} ${args.join(' ')} に失敗しました（終了コード ${result.code}）`,
    };
  }
  return host === 'github'
    ? parseGithubReviewComments(result.stdout)
    : parseGitlabReviewComments(result.stdout);
}

/** Forge Hub向けに、返信・解決に必要なthread IDを含むレビューを取得する。 */
export async function fetchReviewThreads(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
  number: number,
): Promise<ReviewCommentsResult> {
  if (host === 'gitlab') {
    const discussions = await cli.run(
      'glab',
      ['api', `projects/:id/merge_requests/${String(number)}/discussions`],
      cwd,
    );
    if (discussions.code !== 0) {
      return {
        ok: false,
        comments: [],
        message: sanitizeForLog(discussions.stderr || 'review discussionsの取得に失敗しました'),
      };
    }
    return parseGitlabReviewComments(discussions.stdout);
  }
  const result = await cli.run(
    'gh',
    ['pr', 'view', String(number), '--json=reviews,comments,id'],
    cwd,
  );
  if (result.code !== 0) {
    return {
      ok: false,
      comments: [],
      message: sanitizeForLog(result.stderr || 'レビューの取得に失敗しました'),
    };
  }
  const reviews = parseGithubReviewComments(result.stdout);
  if (!reviews.ok) return reviews;
  let pullRequestId: unknown;
  try {
    pullRequestId = (JSON.parse(result.stdout) as Record<string, unknown>)['id'];
  } catch {
    return reviews;
  }
  if (typeof pullRequestId !== 'string' || pullRequestId === '') return reviews;
  const threads = await cli.run(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($id:ID!){node(id:$id){... on PullRequest{reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{id body createdAt author{login}}}}}}}}',
      '-F',
      `id=${pullRequestId}`,
    ],
    cwd,
  );
  if (threads.code !== 0) return reviews;
  const parsedThreads = parseGithubReviewThreads(threads.stdout);
  return parsedThreads.ok
    ? { ok: true, comments: [...reviews.comments, ...parsedThreads.comments] }
    : reviews;
}

export type ReviewThreadActionOutcome = { ok: true } | { ok: false; message: string };

function invalidReviewThreadAction(number: number, threadId: string, body?: string): boolean {
  return (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    threadId.trim() === '' ||
    /[\r\n]/u.test(threadId) ||
    (body !== undefined && body.trim() === '')
  );
}

/** レビューのスレッドへ返信する。GitHubはGraphQL、GitLabはDiscussions APIを使う。 */
export async function replyToReviewThread(
  deps: CreatePullRequestDeps,
  request: { host: ForgeHost; cwd: string; number: number; threadId: string; body: string },
): Promise<ReviewThreadActionOutcome> {
  if (invalidReviewThreadAction(request.number, request.threadId, request.body)) {
    return { ok: false, message: 'レビュー返信の入力が不正です。' };
  }
  if (request.host === 'github') {
    const result = await deps.cli.run(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        'query=mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}',
        '-F',
        `threadId=${request.threadId}`,
        '-F',
        `body=${request.body}`,
      ],
      request.cwd,
    );
    return result.code === 0
      ? { ok: true }
      : { ok: false, message: sanitizeForLog(result.stderr || 'レビュー返信に失敗しました。') };
  }
  const bodyFilePath = await deps.fs.writeTempFile(request.body);
  try {
    const result = await deps.cli.run(
      'glab',
      [
        'api',
        `projects/:id/merge_requests/${String(request.number)}/discussions/${request.threadId}/notes`,
        `--field=body=@${bodyFilePath}`,
      ],
      request.cwd,
    );
    return result.code === 0
      ? { ok: true }
      : { ok: false, message: sanitizeForLog(result.stderr || 'レビュー返信に失敗しました。') };
  } finally {
    await deps.fs.removeTempFile(bodyFilePath);
  }
}

/** レビューのスレッドを解決済みにする。呼び出し側で必ず確認を取る。 */
export async function resolveReviewThread(
  cli: CliCommandRunner,
  request: { host: ForgeHost; cwd: string; number: number; threadId: string },
): Promise<ReviewThreadActionOutcome> {
  if (invalidReviewThreadAction(request.number, request.threadId)) {
    return { ok: false, message: 'レビュー解決の入力が不正です。' };
  }
  const result =
    request.host === 'github'
      ? await cli.run(
          'gh',
          [
            'api',
            'graphql',
            '-f',
            'query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}',
            '-F',
            `threadId=${request.threadId}`,
          ],
          request.cwd,
        )
      : await cli.run(
          'glab',
          [
            'api',
            '--method=PUT',
            `projects/:id/merge_requests/${String(request.number)}/discussions/${request.threadId}`,
            '--field=resolved=true',
          ],
          request.cwd,
        );
  return result.code === 0
    ? { ok: true }
    : { ok: false, message: sanitizeForLog(result.stderr || 'レビュー解決に失敗しました。') };
}

/**
 * レビューコメントの取得間隔（秒）の既定値（`agent.workflows.reviewCommentPollIntervalSec`、
 * design.md §16.30）。「既定は控えめに置く。APIを叩き続けない」（Issue #339）ため、
 * CIの完了待ちポーリング（`CI_POLL_INTERVAL_MS`=15秒）よりずっと長い10分を既定にする。
 */
export const DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC = 600;
