import { execFile } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot, type TaskBoundary } from './escalation';
import {
  assertValidIdentifiers,
  findSymlinkedAncestor,
  identifierError,
} from './fsGuards';
import type { TaskState } from './runState';
import { sanitizeForLog } from './sanitize';
import { SerialQueue } from './serialQueue';
import { normalizeCommitType, type CleanupMode, type Isolation } from './workflow';

/**
 * タスクごとの作業ディレクトリ分離とgit外フォールバック（design.md §16.6）。
 *
 * `escalation.ts` と同じく、VSCode APIには依存しない。gitの呼び出し（`execFile`。
 * シェルを経由しない。§8「引数インジェクション」と同じ方針）とファイルシステムへの
 * アクセス（実パス解決・`.gitignore` の確認）はポート越しにし、テストで差し替える。
 *
 * worktreeの作成・撤去のスケジューリング（誰の完了を待ってから始めるか）は
 * `scheduler.ts` / `runState.ts` の責務で、ここには置かない。このモジュールが持つのは
 * 「1件の作成・1件の撤去をどう安全に行うか」と、複数の作成・撤去要求を1本のキューへ通す
 * 直列化だけ。
 *
 * **`runId` / `taskId` はこのモジュール自身でも検証する。** `workflow.ts` の
 * `validateWorkflow` が上流で検証済みであっても、ここが唯一の呼び出し元
 * （`runner.ts`）に単層依存する構造だと、検証が本当に経由されるかコード上どこにも
 * 保証が無い。`src/session/sessionActions.ts` の `buildActionArgs` が
 * `isSessionId` を破壊的操作の直前で再確認しているのと同じ流儀（セキュリティ監査指摘）。
 */

/** gitコマンドの実行結果。`stdout` を含む点が `session/sessionActions.ts` の `CommandResult` と違う。 */
export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * gitコマンド実行の抽象。`nodeCommandRunner`（`src/session/sessionActions.ts`）と同じく
 * `execFile` にargv配列を渡す実装を既定にし、テストでは呼ばれた引数列を記録する
 * フェイクに差し替える。
 */
export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * `execFile` の既定 `maxBuffer` は1MBで、超えるとバッファ超過エラーが `gitError` として
 * 返るだけになる（実害は薄いが原因が分かりにくい）。`git status --porcelain` 等の出力が
 * 大きくなる場合に備え、明示的に広げておく（セキュリティ監査指摘・info）。
 */
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const nodeGitCommandRunner: GitCommandRunner = {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolve) => {
      // execFileはシェルを経由せず、argv配列をそのままプロセスへ渡す。`exec` と違い
      // `;` `&&` 等のシェルメタ文字は引数の中身としてしか解釈されない（design.md §8）。
      execFile(
        'git',
        [...args],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES },
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

/**
 * ファイルシステムへのアクセスの抽象。実パス解決・`.gitignore` の読み取り・存在確認だけに絞る。
 * 削除系のメソッドは持たせない（`removeWorktree` がディレクトリを直接消せない構造にするため。
 * design.md §16.6）。
 */
export interface WorktreeFileSystemPort {
  /** シンボリックリンクを解決した実パス。存在しなければ undefined。 */
  realpath(target: string): Promise<string | undefined>;
  /** ファイル全体をUTF-8で読む。存在しなければ undefined。 */
  readTextFile(target: string): Promise<string | undefined>;
  /**
   * `target` そのものがシンボリックリンクか（リンクを辿らず`lstat`で見る）。
   * 存在しなければ `false`。worktreeの作成先を組み立てる途中の各セグメントが
   * リンクでないかを確かめるために使う（design.md §16.6、レビュー指摘: critical 4）。
   */
  isSymbolicLink(target: string): Promise<boolean>;
  /**
   * `target` が実在するか。`removeWorktree` が撤去済み（＝既にディレクトリが無い）
   * worktreeを検知するために使う（Issue #252）。存在確認だけで、削除は行わない。
   */
  pathExists(target: string): Promise<boolean>;
}

export const nodeWorktreeFileSystem: WorktreeFileSystemPort = {
  async realpath(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.realpath(target);
    } catch {
      return undefined;
    }
  },
  async readTextFile(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  },
  async isSymbolicLink(target: string): Promise<boolean> {
    try {
      const stat = await fsPromises.lstat(target);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
  async pathExists(target: string): Promise<boolean> {
    try {
      await fsPromises.stat(target);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * `taskId` に再試行のサフィックスを付ける。`worktreePath` のディレクトリ名と
 * `branchName` のブランチ名の末尾セグメントとで同じ変換を共有する
 * （design.md §16.5「再試行時のブランチ名は `wf/<runId>/<taskId>-retry<n>`」）。
 *
 * `pseudoWorktree.ts`（gitの無いワークスペースでの隔離）も同じ変換を要る（Issue #396）。
 * 疑似worktree側にも同じロジックを複製すると、この関数の変換規則が変わったときに
 * 片方だけ追随し忘れる事故が起きるため、export してそちらから読む。
 */
export function withRetrySuffix(taskId: string, retry: number | undefined): string {
  return retry === undefined ? taskId : `${taskId}-retry${retry}`;
}

/** worktreeを置くディレクトリ（design.md §16.6）。 */
export function worktreesRootDir(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'worktrees');
}

/**
 * タスク1件のworktreeの絶対パス。
 *
 * `retry` を渡すとディレクトリ名にも `-retry<n>` が付く。`branchName` と対称にしていないと、
 * `failed` になったタスク（design.mdの規則で撤去されず残る）をリトライしたときに
 * 同じディレクトリへ2回目の `git worktree add` を試みて必ず失敗する
 * （セキュリティ監査指摘・high1。§16.5「再試行は新しいworktreeでやり直す」との食い違い）。
 *
 * **`branchName` が `naming: 'conventional'` を選んでも、ここのディレクトリ名の形
 * （`<runId>/<taskId>`、再試行時は `<runId>/<taskId>-retry<n>`）は変えない。** worktreeの
 * 置き場は `.agents/worktrees/<runId>/` 配下で既にrun単位に分かれており、パス側は
 * 元々衝突しない構造になっている（ブランチ名のように「他のrunと被らないための工夫」を
 * 別途要らない）。ブランチ名の形とディレクトリ名の形を独立させておくことで、
 * ブランチ命名規約（GitLab運用規約 `<type>/<IID>/<slug>` 等）が変わってもファイル
 * システム側のパス組み立てには影響しない。
 */
export function worktreePath(
  repoRoot: string,
  runId: string,
  taskId: string,
  retry?: number,
): string {
  assertValidIdentifiers(runId, taskId);
  return path.join(worktreesRootDir(repoRoot), runId, withRetrySuffix(taskId, retry));
}

/** `branchName` の命名方式。`wf`が従来形式、`conventional`がGitLab運用規約形式。 */
export type BranchNaming = 'wf' | 'conventional';
export const BRANCH_NAMINGS = ['wf', 'conventional'] as const;
export const DEFAULT_BRANCH_NAMING: BranchNaming = 'wf';

/**
 * 設定 `agent.workflows.branchNaming` の生値を安全な既定（`DEFAULT_BRANCH_NAMING`）へ丸める。
 * `config.ts` の `normalizeForgeHostConfig`（`forge.ts`）・`normalizePullRequestLayerConfig`と
 * 同じ「壊れた値は既定へ倒す」方針。`BranchNaming`自体が`worktree.ts`の定義のため、
 * `forge.ts`の正規化関数群と同じく定義の隣（このファイル）へ置き、`config.ts`からimportする。
 */
export function normalizeBranchNaming(value: string): BranchNaming {
  return (BRANCH_NAMINGS as readonly string[]).includes(value) ? (value as BranchNaming) : DEFAULT_BRANCH_NAMING;
}

/** `branchName` の命名方式の指定。省略時は従来どおり `wf/<runId>/<taskId>`。 */
export interface BranchNamingOptions {
  naming: BranchNaming;
  /** Conventional Commitsのtype（`workflow.ts` の `CommitType`）。未知の値は`chore`へ倒す。 */
  type: string;
  /** 対応するIssue番号。未指定なら conventional 形式を作れないため `wf` 形式へ落とす。 */
  issue: number | undefined;
}

/** `CONVENTIONAL_BRANCH_PATTERN` のslug部分が満たす形（1〜30文字、先頭は英数字）。 */
const CONVENTIONAL_SLUG_MAX_LENGTH = 30;

/**
 * `taskId` をkebab-caseへ変換する。小文字化し、`_` を `-` へ寄せたうえで、
 * 英数字と `-` 以外の文字（記号・非ASCII等）は落とす。連続する `-` は1つへ潰し、
 * 先頭・末尾の `-` も落とす。結果が空になる（記号だけのidだった場合等）ときは
 * `task` を使う。
 */
function kebabCase(taskId: string): string {
  const lowered = taskId.toLowerCase().replace(/_/gu, '-');
  const onlyAllowedChars = lowered.replace(/[^a-z0-9-]/gu, '');
  const collapsed = onlyAllowedChars.replace(/-+/gu, '-').replace(/^-+|-+$/gu, '');
  return collapsed === '' ? 'task' : collapsed;
}

/**
 * conventional形式のブランチ名のslug部分を組み立てる。
 * `<kebab(taskId)>[-retry<n>]-<runId先頭8文字>` を基本形にし、`CONVENTIONAL_BRANCH_PATTERN`
 * の制約（先頭が英数字・kebab-case・30文字以内）へ収める。
 *
 * runId先頭8文字と `-retry<n>` は必ず残す（runIdは同じrunの他タスクとの衝突を避けるため、
 * retryサフィックスは同一runの再試行同士の衝突を避けるため）。30文字を超える場合は
 * `kebab(taskId)` の部分だけを末尾から削って収める。削った結果が空になれば `t` 1文字にする。
 */
function buildConventionalSlug(taskId: string, runId: string, retry: number | undefined): string {
  // runIdはUUID形式（`assertValidIdentifiers`で検証済み）で16進数に大文字を許すため、
  // slugは小文字のみという制約（`/^[a-z0-9][a-z0-9-]{0,29}$/`）に合わせて小文字化する
  const runId8 = runId.slice(0, 8).toLowerCase();
  const retrySuffix = retry === undefined ? '' : `-retry${retry}`;
  const fixedSuffix = `${retrySuffix}-${runId8}`;

  const maxBaseLength = Math.max(0, CONVENTIONAL_SLUG_MAX_LENGTH - fixedSuffix.length);
  const base = kebabCase(taskId);
  // 末尾から削った結果が`-`で終わると`fixedSuffix`（`-`始まり）と繋がって`--`になるため、
  // 削ったあとの末尾の`-`も落とす
  const trimmedBase =
    maxBaseLength > 0 ? base.slice(0, maxBaseLength).replace(/-+$/u, '') : '';
  const finalBase = trimmedBase === '' ? 't' : trimmedBase;

  return `${finalBase}${fixedSuffix}`;
}

/**
 * conventional形式のブランチ名 `<branchType>/<issue>/<slug>` を組み立てる。
 *
 * `branchType`はConventional Commitsのtype（`type`）をそのまま使うが、`feat`だけは
 * `feature`へ読み替える。GitLab運用規約側のブランチtype語彙が
 * `feature|fix|refactor|docs|test|chore|perf|ci`で、Conventional Commitsの`feat`と
 * 綴りが違うため（コミットメッセージのtypeとブランチ名のtypeで別の慣習が使われている）。
 */
function conventionalBranchName(
  taskId: string,
  runId: string,
  retry: number | undefined,
  type: string,
  issue: number,
): string {
  const normalizedType = normalizeCommitType(type);
  const branchType = normalizedType === 'feat' ? 'feature' : normalizedType;
  const slug = buildConventionalSlug(taskId, runId, retry);
  return `${branchType}/${issue}/${slug}`;
}

/**
 * worktreeのブランチ名。再試行時は `-retry<n>` を付ける（design.md §16.5）。
 * `retry` を渡さない1回目の実行と、`retry: 0` 以降の再試行を区別するため `undefined` を既定にする。
 *
 * `options` を渡さない、または `options.naming === 'wf'`、または `options.issue` が
 * `undefined`（対応するIssueが無い＝GitLab運用規約の `<type>/<IID>/<slug>` を作れない）
 * のときは、従来どおり `wf/<runId>/<taskId>` を返す。`options.naming === 'conventional'`
 * かつ `issue` があるときだけ `<branchType>/<issue>/<slug>`（GitLab運用規約形式）を返す。
 */
export function branchName(
  runId: string,
  taskId: string,
  retry?: number,
  options?: BranchNamingOptions,
): string {
  assertValidIdentifiers(runId, taskId);
  if (options !== undefined && options.naming === 'conventional' && options.issue !== undefined) {
    return conventionalBranchName(taskId, runId, retry, options.type, options.issue);
  }
  return `wf/${runId}/${withRetrySuffix(taskId, retry)}`;
}

/**
 * `branchName()` が生成する形（`wf/<runId>/<taskId>`、または再試行時の
 * `wf/<runId>/<taskId>-retry<n>`）だけにマッチする。
 *
 * gitへ位置引数として渡すブランチ名が `-` から始まらないことを保証するための検証
 * （引数インジェクション対策。design.md §8）。`integration.ts` は `git merge` の対象
 * ブランチ、`forge.ts` は `git push` の対象ブランチとして、それぞれこの形のブランチ名
 * だけを渡してよい。以前はこの検証がファイルごとに別々の実装形（`integration.ts` は
 * 既知の `runId` への文字列prefix一致＋正規表現、`forge.ts` は正規表現1本）で複製されて
 * おり、末尾の許容文字数（`{0,60}`）が偶然一致しているだけの状態だった（Issue #146）。
 * `branchName()` の生成元であるここへ一本化し、双方から参照する。
 */
export const WF_BRANCH_PATTERN =
  /^wf\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[A-Za-z0-9_][A-Za-z0-9_-]{0,60}$/u;

/**
 * `<type>/<IID>/<slug>` 形式のブランチ名。GitLab運用規約に合わせた形（`branchName` が
 * `naming: 'conventional'` で生成する形）。
 *
 * `WF_BRANCH_PATTERN` と同じ理由（引数インジェクション対策。design.md §8）で、
 * 先頭が英数字であることを崩さない。IIDは`0`始まり・先頭`0`を許さない正の整数、
 * slugは1〜30文字の英数字・kebab-case（先頭は英数字）に絞る。
 */
export const CONVENTIONAL_BRANCH_PATTERN =
  /^(feature|fix|refactor|docs|test|chore|perf|ci)\/[1-9][0-9]*\/[a-z0-9][a-z0-9-]{0,29}$/u;

/**
 * `branch` が `branchName()` の生成形（`WF_BRANCH_PATTERN` または
 * `CONVENTIONAL_BRANCH_PATTERN`、どの `runId` / `issue` でもよい）かどうか。
 */
export function isWorkflowBranchName(branch: string): boolean {
  return WF_BRANCH_PATTERN.test(branch) || CONVENTIONAL_BRANCH_PATTERN.test(branch);
}

/** ワークスペースがgitの作業ツリーかどうか（ベアリポジトリを除く）。 */
export async function isGitWorkingTree(repoRoot: string, git: GitCommandRunner): Promise<boolean> {
  const result = await git.run(['rev-parse', '--is-inside-work-tree'], repoRoot);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/**
 * 実行開始時のHEADコミットを解決する。
 *
 * **呼び出し側が実行開始時に一度だけ呼び、その値を全タスクの `createWorktree` へ
 * 使い回すこと。** 実行中にHEADが動いても全タスクが同じ地点から分岐する（design.md §16.6）
 * という要件は、この関数自体ではなく「1回だけ呼んで使い回す」呼び出し側の責務で満たす。
 */
export async function resolveHeadCommit(
  repoRoot: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const result = await git.run(['rev-parse', 'HEAD'], repoRoot);
  const sha = result.stdout.trim();
  return result.code === 0 && sha !== '' ? sha : undefined;
}

/**
 * `git rev-parse --git-common-dir` の解決結果。「gitでない」（`notGit`）と
 * 「コマンドが失敗した」（`commandFailed`）「実パス解決が失敗した」（`realpathFailed`）を
 * 区別する（セキュリティ監査指摘・medium2）。
 *
 * 以前は全て `undefined` に潰していたが、`escalation.ts` の `touchesGitDirectory` は
 * `gitCommonDir` が `undefined` だと共有領域の判定を丸ごと飛ばす。一時的なI/O失敗や
 * タイムアウトを「gitでない」と同列に扱うと、その回だけ `.git` 保護の一部が無警告で
 * 無効になる。「gitでない」だけが正常系であり、それ以外の失敗は呼び出し側が検知して
 * 警告を出せるようにする。
 */
export type GitCommonDirResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'notGit' }
  | { ok: false; reason: 'commandFailed'; message: string }
  | { ok: false; reason: 'realpathFailed'; path: string };

/** gitの標準的な「リポジトリでない」旨のエラーメッセージ（大文字小文字は問わない）。 */
const NOT_A_GIT_REPOSITORY_PATTERN = /not a git repository/i;

/**
 * `git rev-parse --git-common-dir` を実行し、実パス解決まで行う。worktreeの `.git` は
 * 実体がファイルで、hooksなどの実データは親リポジトリの共有領域にある（design.md §16.7）。
 */
export async function resolveGitCommonDir(
  repoRoot: string,
  git: GitCommandRunner,
  fsPort: WorktreeFileSystemPort,
): Promise<GitCommonDirResult> {
  const result = await git.run(['rev-parse', '--git-common-dir'], repoRoot);
  if (result.code !== 0) {
    if (NOT_A_GIT_REPOSITORY_PATTERN.test(result.stderr)) {
      return { ok: false, reason: 'notGit' };
    }
    return {
      ok: false,
      reason: 'commandFailed',
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `git rev-parse --git-common-dir に失敗しました（終了コード ${result.code}）`,
    };
  }

  const raw = result.stdout.trim();
  if (raw === '') {
    return {
      ok: false,
      reason: 'commandFailed',
      message: 'git rev-parse --git-common-dir の出力が空でした',
    };
  }

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const resolved = await fsPort.realpath(absolute);
  if (resolved === undefined) {
    return { ok: false, reason: 'realpathFailed', path: absolute };
  }
  return { ok: true, value: resolved };
}

/** `buildTaskBoundary` の結果。境界そのものと、`gitCommonDir` 取得に問題があった場合の警告を分けて返す。 */
export interface TaskBoundaryResult {
  boundary: TaskBoundary;
  /**
   * `resolveGitCommonDir` が `notGit` 以外の理由で失敗したときの警告。
   * `.git` 保護の一部が働かない可能性があるため、呼び出し側（ログ・ワークフローView）は
   * これを黙って捨てずに表示すること。「gitでない」（`notGit`）だけが正常系のため含まない。
   */
  gitCommonDirWarning: string | undefined;
}

/**
 * タスクごとの `TaskBoundary`（`escalation.ts`）を組み立てる。#54 のパス境界判定・
 * `.git` 保護はこの値を前提にしているため、`gitCommonDir` を供給し忘れると
 * worktreeの `.git`（実体はファイル）配下の共有領域への書き込みが素通りする。
 *
 * `roots` は解決前の候補（タスクの作業ディレクトリ、worktreeのルートなど）。
 * 実パス解決に失敗したもの（存在しない等）は黙って除く。全滅した場合、
 * `escalation.ts` 側は `allowedRoots` が空の境界を「常に境界外」として安全側に扱う。
 */
export async function buildTaskBoundary(
  roots: readonly string[],
  repoRoot: string,
  git: GitCommandRunner,
  fsPort: WorktreeFileSystemPort,
): Promise<TaskBoundaryResult> {
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    const resolved = await fsPort.realpath(root);
    if (resolved !== undefined && !resolvedRoots.includes(resolved)) {
      resolvedRoots.push(resolved);
    }
  }

  const commonDir = await resolveGitCommonDir(repoRoot, git, fsPort);
  if (commonDir.ok) {
    return {
      boundary: { allowedRoots: resolvedRoots, gitCommonDir: commonDir.value },
      gitCommonDirWarning: undefined,
    };
  }
  if (commonDir.reason === 'notGit') {
    return {
      boundary: { allowedRoots: resolvedRoots, gitCommonDir: undefined },
      gitCommonDirWarning: undefined,
    };
  }

  const detail = commonDir.reason === 'commandFailed' ? commonDir.message : commonDir.path;
  return {
    boundary: { allowedRoots: resolvedRoots, gitCommonDir: undefined },
    gitCommonDirWarning: `git-common-dirの取得に失敗したため、.git配下への書き込み保護の一部が働きません（${commonDir.reason}）: ${detail}`,
  };
}

/**
 * `isolation` の3値とgit外フォールバックの決定（design.md §16.6の表）。
 * ファイルシステム・gitに触れない純粋関数。`isGitRepo` は呼び出し側が
 * `isGitWorkingTree` で解決済みの値を渡す。
 */
export type WorkingDirectoryDecision =
  /** `cwd` を明示したタスク。`isolation` より優先し、worktreeを作らない。 */
  | { kind: 'explicitCwd' }
  /** worktreeを作る。 */
  | { kind: 'worktree' }
  /** `isolation: shared` が最初から指定されている（フォールバックではない）。 */
  | { kind: 'shared' }
  /** `isolation: worktree` がgit外のため `shared` へ落ちた。警告を伴う。 */
  | { kind: 'sharedFallback'; warning: string }
  /** `isolation: worktree-strict` がgit外のため実行を開始できない。 */
  | { kind: 'error'; message: string };

const NOT_GIT_FALLBACK_WARNING =
  'ワークスペースがgitの作業ツリーではないため、isolation: worktreeをshared（ワークスペース直下）' +
  'へ切り替えました。並列タスクが同じディレクトリで走るためファイル衝突しうります。' +
  '{{T.branch}}は空文字になります。';

const NOT_GIT_STRICT_ERROR =
  'isolation: worktree-strictが指定されていますが、ワークスペースがgitの作業ツリーではないため' +
  '実行を開始できません。';

export function decideWorkingDirectory(
  task: { isolation: Isolation; cwd: string | undefined },
  isGitRepo: boolean,
): WorkingDirectoryDecision {
  if (task.cwd !== undefined) {
    return { kind: 'explicitCwd' };
  }
  if (task.isolation === 'shared') {
    return { kind: 'shared' };
  }
  if (isGitRepo) {
    return { kind: 'worktree' };
  }
  if (task.isolation === 'worktree-strict') {
    return { kind: 'error', message: NOT_GIT_STRICT_ERROR };
  }
  return { kind: 'sharedFallback', warning: NOT_GIT_FALLBACK_WARNING };
}

/** `createWorktree` の入力。 */
export interface CreateWorktreeRequest {
  repoRoot: string;
  runId: string;
  taskId: string;
  /** 実行開始時に一度だけ解決したHEAD（`resolveHeadCommit`）。全タスクで同じ値を渡す。 */
  headCommit: string;
  /** 再試行回数。1回目は undefined（design.md §16.5）。 */
  retry: number | undefined;
  /**
   * ブランチの命名方式（design.md §16.6「ブランチの命名方式」）。`branchName`へそのまま渡す。
   * 省略時は`branchName`自身の既定どおり `wf/<runId>/<taskId>` になる（後方互換）。
   */
  branchNaming?: BranchNamingOptions;
}

export type CreateWorktreeResult =
  | { ok: true; cwd: string; branch: string }
  | {
      ok: false;
      reason:
        | 'branchExists'
        | 'gitError'
        | 'invalidIdentifier'
        | 'invalidHeadCommit'
        | 'symlinkDetected'
        | 'boundaryEscape';
      message: string;
    };

/** `WorktreeCreationQueue.createWithOrigin` の戻り値。Issue #380。 */
export type CreateWorktreeWithOriginResult =
  | { ok: true; cwd: string; branch: string; originCommit: string }
  | {
      ok: false;
      reason:
        | 'headUnresolved'
        | 'branchExists'
        | 'gitError'
        | 'invalidIdentifier'
        | 'invalidHeadCommit'
        | 'symlinkDetected'
        | 'boundaryEscape';
      message: string;
    };

/**
 * `headCommit` はコミットのSHA（省略形を含む7〜40桁の16進数）に限る。
 *
 * `git worktree add -b <branch> <path> <headCommit>` の末尾は位置引数で、`--` の区切りが
 * 無い。検証を怠ると `headCommit` に `--force` のようなフラグ文字列を渡され、エラーにならず
 * 成立したうえで**指定したコミットではなく現在のHEADから分岐する**（実機で確認済み。
 * セキュリティ監査指摘・low1）。§16.6「全タスクが実行開始時の同じHEADから分岐する」が
 * 静かに破れるため、位置引数として解釈される保証がある形式だけを通す。
 */
const HEAD_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * worktreeを1件作る。**exportしない。** 呼び出し側は必ず `WorktreeCreationQueue.create`
 * を経由すること（直列化しないと同時実行で `index.lock` が競合する。design.md §16.6）。
 * `createWorktree` 自体をexportして直接呼べる状態にしておくと、キューを経由し忘れる
 * 事故を型やレビューだけでは防げない（セキュリティ監査指摘・low2）ため、
 * 「作成の入口は `WorktreeCreationQueue.create` だけ」という構造で強制する。
 *
 * 同名のブランチが既にあればエラーで返し、`git worktree add` 自体を試みない
 * （既存の作業を踏まないため）。worktree作成に失敗したときは呼び出し側がそのタスクを
 * 開始しない前提で、この関数自体は後始末をしない（中途半端な状態を隠さず、失敗を
 * そのまま呼び出し側へ返す）。
 */
async function createWorktree(
  request: CreateWorktreeRequest,
  git: GitCommandRunner,
  fs: WorktreeFileSystemPort,
): Promise<CreateWorktreeResult> {
  const identifierMessage = identifierError(request.runId, request.taskId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }
  if (!HEAD_COMMIT_PATTERN.test(request.headCommit)) {
    return {
      ok: false,
      reason: 'invalidHeadCommit',
      message: `不正なheadCommit（コミットのSHAではありません）: ${request.headCommit}`,
    };
  }

  const branch = branchName(request.runId, request.taskId, request.retry, request.branchNaming);
  // `branchName()`が生成した値を無検証で`git worktree add -b <branch>`（`-b`の直後はオプション値
  // として消費されるため現時点で実害は無い）へ渡さず、ここでも`isWorkflowBranchName`で自己検証
  // する（多層防御。レビュー指摘）。`pushBranch`（`forge.ts`）や`mergeTaskBranch`（`integration.ts`）
  // はgitへ渡す直前に同種の再検証を行っており、防御が生成ロジックの正しさだけに依存する
  // 一枚防御になっていた
  if (!isWorkflowBranchName(branch)) {
    return {
      ok: false,
      reason: 'invalidIdentifier',
      message: `不正なブランチ名（branchName()の生成形に一致しません）: ${branch}`,
    };
  }
  const cwd = worktreePath(request.repoRoot, request.runId, request.taskId, request.retry);

  // 一次防御: `git worktree add` を呼ぶ前に、作成先までの経路にシンボリックリンクが
  // 含まれていないかを確かめる（レビュー指摘: critical 4）
  const symlinkedAncestor = await findSymlinkedAncestor(request.repoRoot, cwd, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      reason: 'symlinkDetected',
      message: `worktreeの作成先の経路にシンボリックリンクが含まれています。作成を中止しました: ${symlinkedAncestor}`,
    };
  }

  const verify = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    request.repoRoot,
  );
  if (verify.code === 0) {
    return { ok: false, reason: 'branchExists', message: `ブランチ ${branch} は既に存在します` };
  }

  const add = await git.run(
    ['worktree', 'add', '-b', branch, cwd, request.headCommit],
    request.repoRoot,
  );
  if (add.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        add.stderr.trim() !== ''
          ? sanitizeForLog(add.stderr)
          : `git worktree add に失敗しました（終了コード ${add.code}）`,
    };
  }

  // 二次防御: 実際に作られた場所が本当にrepoRoot配下にあるかを確かめる。一次防御
  // （事前のリンク検知）だけに頼らない多層防御（design.md §16.6）。TOCTOU
  // （検査後・作成前にリンクが差し替えられる）や、一次防御の見落としに備える
  const realCwd = await fs.realpath(cwd);
  const realRoot = (await fs.realpath(request.repoRoot)) ?? request.repoRoot;
  if (realCwd === undefined || !isPathWithinRoot(realCwd, realRoot)) {
    const cleanup = await git.run(['worktree', 'remove', '--force', cwd], request.repoRoot);
    const cleanupNote =
      cleanup.code === 0 ? '撤去しました' : '撤去にも失敗しました。手動で確認してください';
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `worktreeがワークスペースの外に作られたため、${cleanupNote}: ${realCwd ?? cwd}`,
    };
  }

  return { ok: true, cwd, branch };
}

export type RemoveWorktreeResult =
  | { ok: true }
  | { ok: false; reason: 'uncommittedChanges' | 'gitError' | 'invalidIdentifier'; message: string };

/**
 * worktreeを1件撤去する。**exportしない。** `createWorktree` と同じ理由
 * （セキュリティ監査指摘・low2）で、呼び出し側は必ず `WorktreeCreationQueue.remove` を
 * 経由すること。`git worktree remove` も `.git/worktrees/` 配下の管理情報を書き換えるため、
 * 作成と同じキューへ通して競合を避ける。
 *
 * 生のパス文字列を受け取らず、`createWorktree` と同じ `repoRoot` / `runId` / `taskId` /
 * `retry` から自分でパスを組み立てる（セキュリティ監査指摘・medium1）。呼び出し側が
 * パスを取り違えて `.agents/worktrees/` の外にある無関係なworktreeを渡す余地を無くすため。
 *
 * 未コミットの変更があれば撤去せず警告として返す。ディレクトリを直接消すことはしない
 * （`git worktree remove` のみを使う。design.md §16.6）。`WorktreeFileSystemPort` に
 * 削除メソッドを持たせていないため、構造的にディレクトリの直接削除ができない
 * （存在確認の `pathExists` だけが読み取り専用の例外）。
 *
 * **cwdの実在を先に確かめる（Issue #252）。** Node.jsの `spawn` はcwdに指定した
 * ディレクトリが実在しないと `ENOENT` を返す。既定の `cleanup: after-merge` で
 * 既に自動撤去済みのworktreeへこの関数がもう一度呼ばれると、`git status` の実行が
 * cwd不在のせいで失敗し、本物のgitエラーと区別が付かないまま `reason: 'gitError'` に
 * なっていた。撤去の目的（ディレクトリが無いこと）は既に達成されているため、
 * cwdが無ければgitを呼ばずに成功として返す。
 */
async function removeWorktree(
  repoRoot: string,
  runId: string,
  taskId: string,
  retry: number | undefined,
  git: GitCommandRunner,
  fs: WorktreeFileSystemPort,
): Promise<RemoveWorktreeResult> {
  const identifierMessage = identifierError(runId, taskId);
  if (identifierMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: identifierMessage };
  }
  const cwd = worktreePath(repoRoot, runId, taskId, retry);

  if (!(await fs.pathExists(cwd))) {
    return { ok: true };
  }

  const status = await git.run(['status', '--porcelain'], cwd);
  if (status.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        status.stderr.trim() !== ''
          ? sanitizeForLog(status.stderr)
          : `git status の取得に失敗しました（終了コード ${status.code}）`,
    };
  }
  if (status.stdout.trim() !== '') {
    return {
      ok: false,
      reason: 'uncommittedChanges',
      message: `未コミットの変更があるため撤去しませんでした: ${cwd}`,
    };
  }

  const remove = await git.run(['worktree', 'remove', cwd], repoRoot);
  if (remove.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        remove.stderr.trim() !== ''
          ? sanitizeForLog(remove.stderr)
          : `git worktree remove に失敗しました（終了コード ${remove.code}）`,
    };
  }
  return { ok: true };
}

/**
 * worktreeの作成・撤去を1本のキューへ通して直列化する。
 *
 * タスクの並列実行そのものは止めない（`scheduler.ts` の範囲）。同時に依存が解けた
 * 複数タスクが同時に `git worktree add` / `git worktree remove` を叩くと、同じリポジトリの
 * `index.lock` や `.git/worktrees/` 配下の管理情報で競合するため、worktree操作だけを
 * このキューに通す（design.md §16.6）。
 *
 * **1つの実行（run）につき、このキューのインスタンスは1つだけ使うこと。** 複数
 * インスタンスを作って別々に使うと、直列化の意味が無くなり `index.lock` の競合が
 * 再発する（セキュリティ監査指摘・low2）。
 *
 * `createWorktree` / `removeWorktree` はこのファイルの外へexportしていない。worktreeの
 * 作成・撤去はこのクラスの `create` / `remove` メソッドだけが入口になる構造にすることで、
 * 「キューを経由し忘れる」事故を型のうえで起こしえない状態にする。
 */
export class WorktreeCreationQueue {
  /** 直列化そのものの実装は `serialQueue.ts` の `SerialQueue` へ委譲する（Issue #146）。 */
  private readonly queue = new SerialQueue();

  /** worktreeを1件作る（`createWorktree` をキュー経由で呼ぶ）。 */
  create(
    request: CreateWorktreeRequest,
    git: GitCommandRunner,
    fs: WorktreeFileSystemPort,
  ): Promise<CreateWorktreeResult> {
    return this.queue.enqueue(() => createWorktree(request, git, fs));
  }

  /**
   * タスクブランチの分岐元HEADの解決と、worktreeの作成を同一のキュー項目にまとめて行う
   * （design.md §16.17「タスクブランチの分岐元」、Issue #380）。
   *
   * `resolveOrigin`を呼び出し側で先に呼んでから`create`を別に呼ぶと、両者の間に他の
   * タスクのマージ（`integration.ts`の`IntegrationMergeQueue`もこの`WorktreeCreationQueue`の
   * インスタンスを共有するため、ここへ割り込みうる）が挟まり、分岐元が1マージ分古くなる
   * （避けられたはずの衝突を生む）。`resolveOrigin`と`createWorktree`を1回の
   * `queue.enqueue`にまとめることで、この2手順の間に他の項目が割り込めなくする。
   *
   * `create`をこの内側からは呼ばない（`create`自体が`queue.enqueue`する。同じ`SerialQueue`
   * インスタンスへ実行中のタスクの中から再度`enqueue`すると、後段が前段の完了を待ち、
   * 前段は後段の結果を待つ形になり噛み合わなくなる）。`createWorktree`を直接呼ぶ。
   */
  createWithOrigin(
    resolveOrigin: () => Promise<string | undefined>,
    buildRequest: (headCommit: string) => CreateWorktreeRequest,
    git: GitCommandRunner,
    fs: WorktreeFileSystemPort,
  ): Promise<CreateWorktreeWithOriginResult> {
    return this.queue.enqueue(async () => {
      const headCommit = await resolveOrigin();
      if (headCommit === undefined) {
        return {
          ok: false,
          reason: 'headUnresolved',
          message: '統合ブランチのHEADコミットを解決できませんでした',
        };
      }
      const result = await createWorktree(buildRequest(headCommit), git, fs);
      if (!result.ok) {
        return result;
      }
      return { ...result, originCommit: headCommit };
    });
  }

  /** worktreeを1件撤去する（`removeWorktree` をキュー経由で呼ぶ）。 */
  remove(
    repoRoot: string,
    runId: string,
    taskId: string,
    retry: number | undefined,
    git: GitCommandRunner,
    fs: WorktreeFileSystemPort,
  ): Promise<RemoveWorktreeResult> {
    return this.queue.enqueue(() => removeWorktree(repoRoot, runId, taskId, retry, git, fs));
  }

  /**
   * 汎用の直列化を外部へも開放する。`integration.ts` の `IntegrationMergeQueue` が
   * 統合worktreeの作成・マージも同じ1本のキューへ通すために使う（`index.lock` の
   * 競合対策は「worktree操作全般」に及ぶため。design.md §16.6 / §16.17）。
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(task);
  }
}

/**
 * `cleanup: remove` / `after-merge` かつタスクが `done` のときだけ撤去してよい
 * （design.md §16.6 / §16.17）。`failed` / `blocked` は必ず残す（原因調査に要る）。
 * 純粋関数にしておき、実際の撤去（`WorktreeCreationQueue.remove`）を呼ぶかどうかは
 * 呼び出し側（`runner.ts`）がこれで判定する。
 *
 * `done`の意味は design.md §16.17 で「統合ブランチへ入った（＝マージ成功）」に変わった
 * ため、`remove`（「タスクが`done`になった時点で撤去」）と`after-merge`（「マージが
 * 成功した時点で撤去」）は実質同じ事象で発火する。それでも列挙値として2つ残すのは、
 * `remove`が`after-merge`より前から存在する値（design.md §16.6由来）で、既存の定義
 * ファイルとの後方互換のため。
 */
export function shouldRemoveWorktree(cleanup: CleanupMode, taskState: TaskState): boolean {
  return (cleanup === 'remove' || cleanup === 'after-merge') && taskState === 'done';
}

/** `.gitignore` に追記を促す文言に使う1行。 */
const WORKTREES_GITIGNORE_ENTRY = '.agents/worktrees/';

/** `checkWorktreesGitignored` の結果。`.gitignore` を勝手に書き換えないための案内材料。 */
export interface GitignoreCheckResult {
  needsEntry: boolean;
  message: string | undefined;
}

/**
 * `.gitignore` に `.agents/worktrees/` が無ければ追記を促す（design.md §16.6）。
 * 呼び出し側（ログ・ワークフローView）が案内を出せるよう結果を返すだけで、
 * ファイルの書き換えはここでは行わない。
 */
export async function checkWorktreesGitignored(
  repoRoot: string,
  fsPort: WorktreeFileSystemPort,
): Promise<GitignoreCheckResult> {
  const content = await fsPort.readTextFile(path.join(repoRoot, '.gitignore'));
  const lines = (content ?? '').split(/\r?\n/u).map((line) => line.trim());
  const covered = lines.some(
    (line) =>
      line === WORKTREES_GITIGNORE_ENTRY ||
      line === '.agents/worktrees' ||
      line === '.agents/' ||
      line === '.agents',
  );
  if (covered) {
    return { needsEntry: false, message: undefined };
  }
  return {
    needsEntry: true,
    message: `.gitignore に ${WORKTREES_GITIGNORE_ENTRY} がありません。追記を検討してください。`,
  };
}
