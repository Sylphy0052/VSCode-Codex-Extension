import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
  | { kind: 'host'; host: ForgeHost }
  | { kind: 'none' }
  | { kind: 'undetermined'; message: string };

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
 * 実行可能ビットを確認する）だが、意図的に複製する。`codex/cliLocator.ts` はCodex/Claude
 * 実行ファイルの解決という別ドメインの関心事（`machine` スコープの `executablePath` 設定を
 * 受け取る等）を持つ専用モジュールで、orchestrator配下からそこへ結合させると
 * 「たまたま走査ロジックが同じだけ」の依存が生まれる（`worktree.ts` / `integration.ts` が
 * 他ファイルの非exportヘルパーを複製しているのと同じ方針）。
 */
export const nodeCliAvailability: CliAvailabilityPort = {
  async isOnPath(command: string): Promise<boolean> {
    const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
    for (const dir of dirs) {
      const candidate = path.join(dir, command);
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

/** 設定 `agent.workflows.finalMerge`（machineスコープ。design.md §16.16・§16.18）。 */
export type FinalMergeConfig = 'auto' | 'pr-only';

/** `agent.workflows.finalMerge` の生値を安全な既定（`auto`）へ丸める。 */
export function normalizeFinalMergeConfig(value: string): FinalMergeConfig {
  return value === 'pr-only' ? 'pr-only' : 'auto';
}

/**
 * 最終マージ（`gh pr merge` / `glab mr merge`）を実行してよいか。
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

export function buildIntegrationPullRequestTitle(input: IntegrationPullRequestContentInput): string {
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
 */
function buildCreatePullRequestArgs(
  host: ForgeHost,
  params: { base: string; head: string; title: string; bodyFilePath: string },
): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    return {
      command: 'gh',
      args: [
        'pr',
        'create',
        `--base=${params.base}`,
        `--head=${params.head}`,
        `--title=${params.title}`,
        `--body-file=${params.bodyFilePath}`,
      ],
    };
  }
  return {
    command: 'glab',
    args: [
      'api',
      'projects/:id/merge_requests',
      `--field=source_branch=${params.head}`,
      `--field=target_branch=${params.base}`,
      `--field=title=${params.title}`,
      `--field=description=@${params.bodyFilePath}`,
    ],
  };
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

/* -------------------------------------------------------------------------------------------- */
/* タスク層のPR/MR作成フロー（呼び出し順の固定）                                                  */
/* -------------------------------------------------------------------------------------------- */

/** 各手順の成否。`ok: false` でも後続の手順（マージ）は止めない（後述）。 */
export type ForgeStepOutcome = { ok: true } | { ok: false; message: string };

/**
 * タスク層のPR/MR作成フローの4手順。design.md §16.18「作る順序」がそのまま手順名になる。
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
  mergeAndPushIntegration: () => Promise<TMerge>;
}

export interface TaskPullRequestFlowResult<TMerge> {
  pullRequest:
    | { created: true; url: string | undefined }
    | {
        created: false;
        stage: 'pushTaskBranch' | 'pushIntegrationBranch' | 'createPullRequest';
        message: string;
      };
  mergeOutcome: TMerge;
}

/**
 * タスク層のPR/MR作成フローを、design.mdが定める順序（タスクブランチをpush→統合ブランチを
 * push→PR/MRを作る→マージして統合ブランチをpush）で実行する。
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

  const mergeOutcome = await steps.mergeAndPushIntegration();
  return { pullRequest, mergeOutcome };
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
  });
  return { push, pullRequest };
}

/** ホストごとの最終マージコマンド（design.md §16.18「最終マージ」）。 */
function buildFinalMergeArgs(host: ForgeHost): { command: 'gh' | 'glab'; args: string[] } {
  if (host === 'github') {
    return { command: 'gh', args: ['pr', 'merge', '--merge'] };
  }
  // GitLabの `--remove-source-branch` はリモート（origin）上のsource branchを消すだけで、
  // ローカルの統合worktree・ブランチは残る。design.md §16.18「mainへマージした後も統合
  // ブランチは残す」と矛盾しない（片付けはViewの操作から行う別の関心事）。
  return { command: 'glab', args: ['mr', 'merge', '--remove-source-branch'] };
}

export type RunFinalMergeResult = { ok: true } | { ok: false; message: string };

/**
 * 統合→mainのPR/MRを実際にマージする（`gh pr merge --merge` / `glab mr merge
 * --remove-source-branch`。design.md §16.18「最終マージ」）。呼び出し側は
 * `shouldRunFinalMerge` の判定を経てからこの関数を呼ぶこと（このファイル自体は
 * 常に実行する。ガードは呼び出し側の責務にして二重化しない）。
 */
export async function runFinalMerge(
  cli: CliCommandRunner,
  host: ForgeHost,
  cwd: string,
): Promise<RunFinalMergeResult> {
  const { command, args } = buildFinalMergeArgs(host);
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
