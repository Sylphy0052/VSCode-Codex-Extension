import * as path from 'node:path';

import { isPathWithinRoot } from './escalation';
import { sanitizeForLog } from './sanitize';
import { TASK_ID_PATTERN } from './workflow';
import {
  resolveHeadCommit,
  worktreesRootDir,
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from './worktree';

/**
 * 成果の統合（統合ブランチとマージ）。design.md §16.17。
 *
 * `worktree.ts` と同じ方針を踏襲する。gitの呼び出しは `GitCommandRunner`
 * （`worktree.ts` からそのまま再利用する。同じ意味の抽象を複製しない）越しに行い、
 * `execFile` にargv配列を渡すだけでシェルを経由しない。ファイルシステムへのアクセス
 * （実パス解決・シンボリックリンク検知）も `worktree.ts` の `WorktreeFileSystemPort` を
 * そのまま使う。
 *
 * `runId` の字種（UUID）の検証は `worktree.ts` の `RUN_ID_PATTERN` と同じ正規表現だが、
 * `worktree.ts` はこれをexportしていないため複製する（`pseudoWorktree.ts` が同じ理由で
 * 複製しているのと同じ方針）。`taskId` の字種は `workflow.ts` の `TASK_ID_PATTERN` を
 * `worktree.ts` と同じく直接参照する（循環importの心配が無いため複製しない）。
 *
 * 状態遷移（`merging` / `blocked`）との接続、衝突解決セッションの起動は `runner.ts`
 * （#93）が担う。このファイルは、その接続で使う純粋寄りの補助（衝突解決プロンプトの
 * 組み立て、衝突解決の完了判定、リロード直後の`merging`タスクの再判定）までを提供する。
 * PR/MRの作成（`forge.ts`）は引き続きこのファイルの範囲に含まない。
 */

/** 統合先ディレクトリのタスクid相当の固定名。design.md §16.17「`_integration` はタスクidとして予約する」。 */
export const INTEGRATION_DIR_NAME = '_integration';

/** `runId` の字種（UUID）。`worktree.ts` の `RUN_ID_PATTERN` と同じ正規表現の複製（コメント参照）。 */
const RUN_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `headCommit` はコミットのSHA（省略形を含む7〜40桁の16進数）に限る。
 * `worktree.ts` の `HEAD_COMMIT_PATTERN` と同じ理由・同じ正規表現の複製（フラグ注入対策）。
 */
const HEAD_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

function runIdError(runId: string): string | undefined {
  return RUN_ID_PATTERN.test(runId) ? undefined : `不正なrunId（UUID形式ではありません）: ${runId}`;
}

function identifierError(runId: string, taskId: string): string | undefined {
  const runIdMessage = runIdError(runId);
  if (runIdMessage !== undefined) {
    return runIdMessage;
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    return `不正なtaskId（許可されない文字を含みます）: ${taskId}`;
  }
  return undefined;
}

/**
 * `taskBranch` が `wf/<runId>/<...>` の形をしているかを確かめる。
 *
 * マージ対象のブランチ名は `git merge --no-ff -m <message> <taskBranch>` の末尾の位置引数
 * として渡す。`--` の区切りが無いため、`-` から始まる文字列を渡されるとフラグとして解釈
 * されうる（`worktree.ts` の `HEAD_COMMIT_PATTERN` と同じ理由の防御）。`branchName`
 * （`worktree.ts`）が生成する形（`wf/<runId>/<taskId>` または再試行時の
 * `wf/<runId>/<taskId>-retry<n>`）だけを許す。
 */
function isValidTaskBranch(taskBranch: string, runId: string): boolean {
  const prefix = `wf/${runId}/`;
  if (!taskBranch.startsWith(prefix)) {
    return false;
  }
  const rest = taskBranch.slice(prefix.length);
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,60}$/.test(rest);
}

/**
 * `root` から `target` までの各中間ディレクトリにシンボリックリンクが含まれていないかを
 * 確かめる（一次防御）。`worktree.ts` の同名関数と同じロジックの複製（exportされていない
 * ため直接参照できない。`pseudoWorktree.ts` と同じ方針）。
 */
async function findSymlinkedAncestor(
  root: string,
  target: string,
  fs: WorktreeFileSystemPort,
): Promise<string | undefined> {
  const rel = path.relative(root, target);
  const segments = rel.split(path.sep).filter((s) => s !== '' && s !== '..');
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (await fs.isSymbolicLink(cursor)) {
      return cursor;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// パス・ブランチ名・固定文言
// ---------------------------------------------------------------------------

/** 統合ブランチ名。`wf/<runId>/integration`（design.md §16.17）。不正な `runId` は例外にする。 */
export function integrationBranchName(runId: string): string {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  return `wf/${runId}/integration`;
}

/**
 * 統合用worktreeの絶対パス。`<repo>/.agents/worktrees/<runId>/_integration`
 * （design.md §16.17）。不正な `runId` は例外にする。
 */
export function integrationWorktreePath(repoRoot: string, runId: string): string {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  return path.join(worktreesRootDir(repoRoot), runId, INTEGRATION_DIR_NAME);
}

/**
 * タスク完了時に未コミットの変更を拾うための固定文言のコミットメッセージ。
 * `wf(<taskId>): uncommitted changes at task completion`（design.md §16.17）。
 * **エージェントの出力を混ぜない**。引数は検証済みの `taskId` のみを受け取る。
 */
export function uncommittedChangesCommitMessage(taskId: string): string {
  return `wf(${taskId}): uncommitted changes at task completion`;
}

/**
 * マージコミットの固定文言メッセージ。`Merge task <taskId> (run <runId>)`
 * （design.md §16.17）。**エージェントの出力を混ぜない**。
 */
export function mergeCommitMessage(taskId: string, runId: string): string {
  return `Merge task ${taskId} (run ${runId})`;
}

// ---------------------------------------------------------------------------
// タスクブランチの分岐元
// ---------------------------------------------------------------------------

/**
 * タスクブランチの分岐元となるコミットを解決する。**そのタスクを開始する時点の
 * 統合ブランチのHEAD**（design.md §16.17「タスクブランチの分岐元」）。
 *
 * 統合worktreeのHEADをそのまま使う。`resolveHeadCommit`（`worktree.ts`）を統合worktreeの
 * パスに対して呼ぶだけの薄いラッパーだが、「タスクブランチの分岐元を解決する」という
 * 呼び出し側にとっての意味を名前で表すために独立した関数にする。
 */
export async function resolveTaskBranchOrigin(
  repoRoot: string,
  runId: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const cwd = integrationWorktreePath(repoRoot, runId);
  return resolveHeadCommit(cwd, git);
}

// ---------------------------------------------------------------------------
// 統合ブランチ・統合worktreeの作成
// ---------------------------------------------------------------------------

/** `createIntegrationWorktree` の入力。 */
export interface CreateIntegrationWorktreeRequest {
  repoRoot: string;
  runId: string;
  /** 実行開始時に一度だけ解決したHEAD（`resolveHeadCommit`）。統合ブランチの分岐元。 */
  headCommit: string;
}

export type CreateIntegrationWorktreeResult =
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

/**
 * 統合ブランチ・統合worktreeを1件作る。**exportしない。** `worktree.ts` の
 * `createWorktree` と同じ理由で、呼び出し側は必ず `IntegrationMergeQueue.createIntegrationWorktree`
 * を経由すること（`git worktree add` を直列化しないと `index.lock` が競合する）。
 *
 * `worktree.ts` の `createWorktree` と対称の手順（シンボリックリンク対策の二段構え、
 * 実パス解決による境界確認）を踏む。
 */
async function createIntegrationWorktree(
  request: CreateIntegrationWorktreeRequest,
  git: GitCommandRunner,
  fs: WorktreeFileSystemPort,
): Promise<CreateIntegrationWorktreeResult> {
  const runIdMessage = runIdError(request.runId);
  if (runIdMessage !== undefined) {
    return { ok: false, reason: 'invalidIdentifier', message: runIdMessage };
  }
  if (!HEAD_COMMIT_PATTERN.test(request.headCommit)) {
    return {
      ok: false,
      reason: 'invalidHeadCommit',
      message: `不正なheadCommit（コミットのSHAではありません）: ${request.headCommit}`,
    };
  }

  const branch = integrationBranchName(request.runId);
  const cwd = integrationWorktreePath(request.repoRoot, request.runId);

  // 一次防御: `git worktree add` を呼ぶ前に、作成先までの経路にシンボリックリンクが
  // 含まれていないかを確かめる（`worktree.ts` §16.6と同じ理由）
  const symlinkedAncestor = await findSymlinkedAncestor(request.repoRoot, cwd, fs);
  if (symlinkedAncestor !== undefined) {
    return {
      ok: false,
      reason: 'symlinkDetected',
      message: `統合worktreeの作成先の経路にシンボリックリンクが含まれています。作成を中止しました: ${symlinkedAncestor}`,
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

  // 二次防御: 実際に作られた場所が本当に repoRoot 配下にあるかを確かめる
  // （TOCTOU・一次防御の見落とし対策。`worktree.ts` の `createWorktree` と同じ）
  const realCwd = await fs.realpath(cwd);
  const realRoot = (await fs.realpath(request.repoRoot)) ?? request.repoRoot;
  if (realCwd === undefined || !isPathWithinRoot(realCwd, realRoot)) {
    const cleanup = await git.run(['worktree', 'remove', '--force', cwd], request.repoRoot);
    const cleanupNote =
      cleanup.code === 0 ? '撤去しました' : '撤去にも失敗しました。手動で確認してください';
    return {
      ok: false,
      reason: 'boundaryEscape',
      message: `統合worktreeがワークスペースの外に作られたため、${cleanupNote}: ${realCwd ?? cwd}`,
    };
  }

  return { ok: true, cwd, branch };
}

// ---------------------------------------------------------------------------
// タスク完了時の自動コミット
// ---------------------------------------------------------------------------

export type CommitUncommittedChangesResult =
  | { ok: true; committed: boolean }
  | { ok: false; reason: 'gitError' | 'invalidIdentifier'; message: string };

/**
 * タスクのworktreeに未コミットの変更が残っていれば、`git add -A` と固定文言でのコミットを
 * 行う（design.md §16.17「タスク完了時のコミット」）。既にクリーンなら何もせず
 * `{ ok: true, committed: false }` を返す。
 *
 * タスクごとのworktreeは別々の `.git/worktrees/<name>/index` を持つため、
 * `worktree.ts` の作成・撤去や本ファイルのマージのような直列化キューは要らない
 * （`index.lock` の競合が起きるのは共有の管理領域を触る操作だけ）。**exportして直接
 * 呼べる。**
 */
export async function commitUncommittedChangesIfNeeded(
  taskWorktreeCwd: string,
  taskId: string,
  git: GitCommandRunner,
): Promise<CommitUncommittedChangesResult> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    return {
      ok: false,
      reason: 'invalidIdentifier',
      message: `不正なtaskId（許可されない文字を含みます）: ${taskId}`,
    };
  }

  const status = await git.run(['status', '--porcelain'], taskWorktreeCwd);
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
  if (status.stdout.trim() === '') {
    return { ok: true, committed: false };
  }

  // -A で追跡対象外のファイルも拾う（design.md §16.17「新規ファイルがマージから落ちる
  // ほうが実害が大きい」）。`.gitignore` は効くのでビルド生成物は入らない
  const add = await git.run(['add', '-A'], taskWorktreeCwd);
  if (add.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        add.stderr.trim() !== ''
          ? sanitizeForLog(add.stderr)
          : `git add -A に失敗しました（終了コード ${add.code}）`,
    };
  }

  const commit = await git.run(
    ['commit', '-m', uncommittedChangesCommitMessage(taskId)],
    taskWorktreeCwd,
  );
  if (commit.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        commit.stderr.trim() !== ''
          ? sanitizeForLog(commit.stderr)
          : `git commit に失敗しました（終了コード ${commit.code}）`,
    };
  }

  return { ok: true, committed: true };
}

// ---------------------------------------------------------------------------
// マージ
// ---------------------------------------------------------------------------

/**
 * マージの結果。成功・衝突・その他の失敗の3種類（design.md §16.17）。
 *
 * 衝突のときは未解決パスの一覧（`git diff --name-only --diff-filter=U`）と、巻き戻し先の
 * コミットid（マージ前の統合ブランチのHEAD）を添える。**衝突した状態のまま返し、
 * ここでは `git merge --abort` しない。** 解決用セッションが自分でマージをやり直す必要が
 * 無いようにするため（design.md §16.17「コンフリクト」1.）。巻き戻しは呼び出し側が
 * `abortMerge` を明示的に呼ぶ。
 */
export type MergeTaskResult =
  | { kind: 'success'; mergeCommit: string }
  | { kind: 'conflict'; unresolvedPaths: string[]; rollbackCommit: string }
  | { kind: 'failure'; message: string };

/**
 * タスクブランチを統合worktreeへマージする。**exportしない。** 呼び出し側は必ず
 * `IntegrationMergeQueue.mergeTask` を経由すること（`worktree.ts` の作成・撤去と同じ
 * `index.lock` の競合を避けるため。design.md §16.17「マージはworktreeの作成・撤去と
 * 同じ1本のキューに通して直列化する」）。
 */
async function mergeTaskBranch(
  integrationWorktreeCwd: string,
  runId: string,
  taskId: string,
  taskBranch: string,
  git: GitCommandRunner,
): Promise<MergeTaskResult> {
  const idMessage = identifierError(runId, taskId);
  if (idMessage !== undefined) {
    return { kind: 'failure', message: idMessage };
  }
  if (!isValidTaskBranch(taskBranch, runId)) {
    return { kind: 'failure', message: `不正なtaskBranch（wf/${runId}/... の形ではありません）: ${taskBranch}` };
  }

  const before = await git.run(['rev-parse', 'HEAD'], integrationWorktreeCwd);
  const rollbackCommit = before.stdout.trim();
  if (before.code !== 0 || rollbackCommit === '') {
    return { kind: 'failure', message: 'マージ前の統合ブランチのHEAD取得に失敗しました' };
  }

  const merge = await git.run(
    ['merge', '--no-ff', '-m', mergeCommitMessage(taskId, runId), taskBranch],
    integrationWorktreeCwd,
  );
  if (merge.code === 0) {
    const after = await git.run(['rev-parse', 'HEAD'], integrationWorktreeCwd);
    return { kind: 'success', mergeCommit: after.code === 0 ? after.stdout.trim() : '' };
  }

  const unresolved = await git.run(
    ['diff', '--name-only', '--diff-filter=U'],
    integrationWorktreeCwd,
  );
  const unresolvedPaths =
    unresolved.code === 0
      ? unresolved.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : [];
  if (unresolvedPaths.length > 0) {
    return { kind: 'conflict', unresolvedPaths, rollbackCommit };
  }

  return {
    kind: 'failure',
    message:
      merge.stderr.trim() !== ''
        ? sanitizeForLog(merge.stderr)
        : `git merge に失敗しました（終了コード ${merge.code}）`,
  };
}

// ---------------------------------------------------------------------------
// 巻き戻し
// ---------------------------------------------------------------------------

export type AbortMergeResult =
  | { ok: true }
  | { ok: false; reason: 'gitError'; message: string };

/**
 * 進行中のマージを取り消し、統合ブランチをマージ前の状態へ戻す（`git merge --abort`。
 * design.md §16.17「巻き戻し」）。**exportしない。** `IntegrationMergeQueue.abortMerge`
 * を経由すること。
 */
async function abortMerge(
  integrationWorktreeCwd: string,
  git: GitCommandRunner,
): Promise<AbortMergeResult> {
  const result = await git.run(['merge', '--abort'], integrationWorktreeCwd);
  if (result.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message:
        result.stderr.trim() !== ''
          ? sanitizeForLog(result.stderr)
          : `git merge --abort に失敗しました（終了コード ${result.code}）`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 直列化キュー
// ---------------------------------------------------------------------------

/**
 * 統合ブランチ・統合worktreeの作成とマージ・巻き戻しを直列化する。
 *
 * design.md §16.17は「マージはworktreeの作成・撤去と同じ1本のキューに通して直列化する」
 * と定める。そのため独自の直列化状態は持たず、`WorktreeCreationQueue`
 * （`worktree.ts`）のインスタンスを受け取り、その `enqueue`（汎用の直列化。`create` /
 * `remove` 専用ではなく公開されている）へ委譲する。**呼び出し側が渡す
 * `WorktreeCreationQueue` は、そのrunでタスクのworktree作成・撤去に使っているものと
 * 同じインスタンスにすること。** 別インスタンスを渡すと直列化の意味が無くなり、
 * `index.lock` の競合が再発する（`worktree.ts` の `WorktreeCreationQueue` 自身の
 * 注意書きと同じ理由）。
 *
 * `createIntegrationWorktree` / `mergeTaskBranch` / `abortMerge` はこのファイルの外へ
 * exportしていない。統合worktreeの作成・マージ・巻き戻しはこのクラスのメソッドだけが
 * 入口になる構造にすることで、「キューを経由し忘れる」事故を型のうえで起こしえない
 * 状態にする（`worktree.ts` の `WorktreeCreationQueue` と同じ方針）。
 */
export class IntegrationMergeQueue {
  constructor(private readonly worktreeQueue: WorktreeCreationQueue) {}

  /** 統合ブランチ・統合worktreeを1件作る（`createIntegrationWorktree` をキュー経由で呼ぶ）。 */
  createIntegrationWorktree(
    request: CreateIntegrationWorktreeRequest,
    git: GitCommandRunner,
    fs: WorktreeFileSystemPort,
  ): Promise<CreateIntegrationWorktreeResult> {
    return this.worktreeQueue.enqueue(() => createIntegrationWorktree(request, git, fs));
  }

  /** タスクブランチを統合worktreeへマージする（`mergeTaskBranch` をキュー経由で呼ぶ）。 */
  mergeTask(
    integrationWorktreeCwd: string,
    runId: string,
    taskId: string,
    taskBranch: string,
    git: GitCommandRunner,
  ): Promise<MergeTaskResult> {
    return this.worktreeQueue.enqueue(() =>
      mergeTaskBranch(integrationWorktreeCwd, runId, taskId, taskBranch, git),
    );
  }

  /** 進行中のマージを取り消す（`abortMerge` をキュー経由で呼ぶ）。 */
  abortMerge(integrationWorktreeCwd: string, git: GitCommandRunner): Promise<AbortMergeResult> {
    return this.worktreeQueue.enqueue(() => abortMerge(integrationWorktreeCwd, git));
  }
}

// ---------------------------------------------------------------------------
// リロード直後の`merging`タスクの再判定（design.md §16.11）
// ---------------------------------------------------------------------------

/**
 * リロード直後、`merging`だったタスクが実際にどうなっているかを統合ブランチの状態から
 * 判定し直す（design.md §16.11「状態の記録ではなく統合ブランチの実際の状態から判定し
 * 直す」）。永続化された状態はマージが途中で切れている可能性があるため信用しない。
 *
 * - 未解決の衝突が残っていれば `blocked`
 * - 対象タスクのマージコミット（`mergeCommitMessage`の固定文言）が統合ブランチの
 *   履歴に見つかれば `done`
 * - どちらでもなければ `merging`（呼び出し側がマージをやり直す）
 *
 * `runId` / `taskId` が不正な場合や、統合worktreeが読めない場合（gitコマンド自体が
 * 失敗する）は安全側の `merging`（やり直し対象）を返す。
 */
export type ReconcileMergingOutcome = 'done' | 'merging' | 'blocked';

export async function reconcileMergingTaskOnReload(
  integrationWorktreeCwd: string,
  runId: string,
  taskId: string,
  git: GitCommandRunner,
): Promise<ReconcileMergingOutcome> {
  const idMessage = identifierError(runId, taskId);
  if (idMessage !== undefined) {
    return 'merging';
  }

  const unresolved = await git.run(
    ['diff', '--name-only', '--diff-filter=U'],
    integrationWorktreeCwd,
  );
  if (unresolved.code === 0 && unresolved.stdout.trim() !== '') {
    return 'blocked';
  }

  const log = await git.run(
    ['log', '--fixed-strings', `--grep=${mergeCommitMessage(taskId, runId)}`, '-1', '--format=%H'],
    integrationWorktreeCwd,
  );
  if (log.code === 0 && log.stdout.trim() !== '') {
    return 'done';
  }
  return 'merging';
}

// ---------------------------------------------------------------------------
// 衝突解決セッション（design.md §16.17「コンフリクト」）
// ---------------------------------------------------------------------------

/** 衝突解決セッションの `maxIterations` の既定値（design.md §16.17「既定は小さくする（5）」）。 */
export const MERGE_RESOLUTION_MAX_ITERATIONS = 5;

/** 衝突解決セッションの終了条件（固定文言。design.md §16.17「コンフリクト」4.）。 */
export const MERGE_RESOLUTION_CONDITION =
  '衝突を解決してコミットしてあり、git statusで未解決のパスが1件も残っていないこと';

/** `buildMergeResolutionPrompt` へ渡すタスク情報。`WorkflowTask` から必要な3項目だけを抜き出す。 */
export interface MergeResolutionTaskInfo {
  id: string;
  prompt: string;
  done: string;
}

/**
 * 衝突解決セッションへ渡す初回プロンプトを組み立てる（design.md §16.17「コンフリクト」3.
 * 「プロンプトには衝突したファイルの一覧、突き合わせる2つのタスクのpromptとdone、
 * 未解決パスの一覧を渡す」）。
 *
 * `others` は、`target`のブランチが分岐した時点から統合ブランチの現在のHEADまでの間に
 * 既に取り込まれたタスク（`findTaskIdsMergedSince`で求める）。通常は1件（design.mdが
 * 想定する「2つのタスク」の片方）だが、複数のタスクが積み重なって取り込まれた後に
 * 衝突した場合は複数件になりうるため、配列として渡す。
 */
export function buildMergeResolutionPrompt(
  target: MergeResolutionTaskInfo,
  others: readonly MergeResolutionTaskInfo[],
  unresolvedPaths: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(
    '複数の並列タスクの成果を統合ブランチへ取り込む際にマージ衝突が発生しました。',
    '現在のディレクトリ（統合worktree）はマージが衝突した状態のままです。衝突を解決し、コミットしてください。',
    '',
    '# 未解決のパス',
  );
  for (const p of unresolvedPaths) {
    lines.push(`- ${p}`);
  }
  lines.push('', `# タスク「${target.id}」（今回マージしようとしたタスク）`, `prompt: ${target.prompt}`, `done: ${target.done}`);
  for (const other of others) {
    lines.push(
      '',
      `# タスク「${other.id}」（既に統合ブランチへ取り込み済みのタスク）`,
      `prompt: ${other.prompt}`,
      `done: ${other.done}`,
    );
  }
  lines.push('', '両方のタスクの意図を汲み取り、意味的に正しくなるよう解決してください。');
  return lines.join('\n');
}

/**
 * `sinceCommit`（対象タスクのブランチの分岐元）から統合ブランチの現在のHEADまでの間に
 * マージされたタスクidの一覧を、マージコミットの固定文言（`mergeCommitMessage`）から
 * 逆算する。衝突解決プロンプトの「突き合わせる」相手を特定するために使う
 * （`buildMergeResolutionPrompt`の`others`）。
 *
 * `sinceCommit`が不正な形式（コミットのSHAでない）なら空配列を返す（安全側）。
 */
export async function findTaskIdsMergedSince(
  integrationWorktreeCwd: string,
  runId: string,
  sinceCommit: string,
  git: GitCommandRunner,
): Promise<string[]> {
  if (runIdError(runId) !== undefined || !HEAD_COMMIT_PATTERN.test(sinceCommit)) {
    return [];
  }
  const log = await git.run(['log', '--format=%s', `${sinceCommit}..HEAD`], integrationWorktreeCwd);
  if (log.code !== 0) {
    return [];
  }
  const prefix = 'Merge task ';
  const suffix = ` (run ${runId})`;
  const ids: string[] = [];
  for (const line of log.stdout.split(/\r?\n/u)) {
    if (line.startsWith(prefix) && line.endsWith(suffix)) {
      const id = line.slice(prefix.length, line.length - suffix.length);
      if (TASK_ID_PATTERN.test(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * 衝突解決セッションが「完了」を宣言した際、実際に解決されコミット済みかを
 * `git status`相当のコマンドで確かめる（design.md §16.17「コンフリクト」4.
 * 「宣言だけを信じず`git status`でも確かめる」）。
 *
 * 未解決パス（`git diff --diff-filter=U`）が無く、かつマージが進行中でない
 * （`MERGE_HEAD`が存在しない＝解決コミットが済んでいる）ときだけ`true`。
 */
export async function isMergeResolutionComplete(
  integrationWorktreeCwd: string,
  git: GitCommandRunner,
): Promise<boolean> {
  const unresolved = await git.run(
    ['diff', '--name-only', '--diff-filter=U'],
    integrationWorktreeCwd,
  );
  if (unresolved.code !== 0 || unresolved.stdout.trim() !== '') {
    return false;
  }
  const mergeHead = await git.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationWorktreeCwd);
  // MERGE_HEADの解決に成功する（code 0）ということは、まだマージ進行中（未コミット）
  return mergeHead.code !== 0;
}
