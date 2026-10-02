import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { isPathWithinRoot } from './escalation';
import { findSymlinkedAncestor, identifierError, runIdError } from './fsGuards';
import { pushBranch, type PushBranchResult } from './forge';
import { sanitizeForLog } from './sanitize';
import { COMMIT_TYPES, normalizeCommitType, TASK_ID_PATTERN } from './workflow';
import {
  CONVENTIONAL_BRANCH_PATTERN,
  isWorkflowBranchName,
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
 * `runId` / `taskId` の字種の検証（`identifierError` / `runIdError`）とシンボリックリンク
 * 検知（`findSymlinkedAncestor`）は、以前はこのファイル・`worktree.ts` ・`pseudoWorktree.ts`
 * の3箇所へほぼ同一実装のまま複製されていたが、`fsGuards.ts`（依存を持たない末端モジュール）
 * へ一本化した（Issue #146）。
 *
 * 状態遷移（`merging` / `blocked`）との接続、衝突解決セッションの起動は `runner.ts`
 * （#93）が担う。このファイルは、その接続で使う純粋寄りの補助（衝突解決プロンプトの
 * 組み立て、衝突解決の完了判定、リロード直後の`merging`タスクの再判定）までを提供する。
 * PR/MRの作成（`forge.ts`）は引き続きこのファイルの範囲に含まない。
 *
 * 例外として、統合ブランチのpush（`forge.ts`の`pushBranch`）だけは`IntegrationMergeQueue`が
 * 直接呼ぶ（`IntegrationMergeQueue.pushIntegrationBranch`。design.md §16.18・Issue #253）。
 * 並列タスクが同じ統合worktreeの同じブランチへ同時にpushすると、リモートが
 * `cannot lock ref` で一方を弾く（worktreeの作成・撤去・マージが直列化されているのと
 * 同じ`index.lock`系の理由）。pushをworktree操作と同じキューへ通して直列化するには、
 * `forge.ts`の`pushBranch`をこのファイルから呼ぶ必要がある。PR/MRの作成そのもの
 * （`createPullRequest`等）は引き続き`forge.ts`側の責務のままで、ここへは持ち込まない。
 */

/** 統合先ディレクトリのタスクid相当の固定名。design.md §16.17「`_integration` はタスクidとして予約する」。 */
export const INTEGRATION_DIR_NAME = '_integration';

/**
 * `headCommit` はコミットのSHA（省略形を含む7〜40桁の16進数）に限る。
 * `worktree.ts` の `HEAD_COMMIT_PATTERN` と同じ理由・同じ正規表現の複製（フラグ注入対策）。
 */
const HEAD_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/** `git show-ref`が返す省略なしのSHA（SHA-1の40桁、SHA-256の64桁）。 */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** `attemptId`（`randomUUID`の値）。永続データから読んだ値の検証に使う。 */
const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{1,64}$/;

/**
 * `taskBranch` が「この `runId` の」タスクブランチの形をしているかを確かめる。
 *
 * マージ対象のブランチ名は `git merge --no-ff -m <message> <taskBranch>` の末尾の位置引数
 * として渡す。`--` の区切りが無いため、`-` から始まる文字列を渡されるとフラグとして解釈
 * されうる（`worktree.ts` の `HEAD_COMMIT_PATTERN` と同じ理由の防御）。形そのものの検証
 * （`branchName()` が生成する `wf/<runId>/<taskId>` / `wf/<runId>/<taskId>-retry<n>`、
 * または conventional形式の `<type>/<issue>/<slug>`）は `worktree.ts` の
 * `isWorkflowBranchName` へ一本化した（Issue #146）。ここではそれに加えて、渡された
 * `taskBranch` が「他のrunのブランチではなく、まさにこの `runId` のものであること」まで
 * 確かめる（`isWorkflowBranchName` はrunIdを問わないため、この一段厳しい確認は
 * `integration.ts`固有の責務として残す）。
 *
 * - `wf/<runId>/...` 形式: 従来どおり、`wf/${runId}/` で始まり `isWorkflowBranchName` を
 *   満たすことで確かめる。
 * - conventional形式（`<type>/<issue>/<slug>`）: runIdが先頭に来ないため、
 *   `CONVENTIONAL_BRANCH_PATTERN` を満たし、かつslugが `-<runId先頭8文字>` で終わることで
 *   確かめる（`branchName()` の `naming: 'conventional'` はslugの末尾に必ずrunId先頭8文字を
 *   残す設計。`-retry<n>` が付く場合も `...-retry<n>-<runId8>` の並びになるため、単純な
 *   `endsWith` で判定できる）。runId先頭8文字だけの照合は理論上は別runと衝突しうる弱さが
 *   あるが、UUIDの先頭8文字なので実用上は衝突しない。それでも「他のrunのブランチを誤って
 *   マージしない」という元の目的（取り違え防止）は満たす。
 */
export function isValidTaskBranch(taskBranch: string, runId: string): boolean {
  if (taskBranch.startsWith(`wf/${runId}/`) && isWorkflowBranchName(taskBranch)) {
    return true;
  }
  if (CONVENTIONAL_BRANCH_PATTERN.test(taskBranch)) {
    const runId8 = runId.slice(0, 8).toLowerCase();
    return taskBranch.endsWith(`-${runId8}`);
  }
  return false;
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
 * `<type>(<taskId>): uncommitted changes at task completion`（design.md §16.17）。
 * **エージェントの出力を混ぜない**。引数は検証済みの `taskId` / `type` のみを受け取る。
 *
 * 以前は `wf(<taskId>): uncommitted changes at task completion` という固定文言だったが、
 * `wf` はConventional Commitsのtype語彙に無いため、規約準拠の形へ改めた。`type` は
 * 省略可能で、未指定・未知の値は `normalizeCommitType`（`workflow.ts`）が`chore`へ倒す
 * （GitLab運用規約のConventional Commits短形に合わせる）。
 */
export function uncommittedChangesCommitMessage(taskId: string, type?: string): string {
  return `${normalizeCommitType(type)}(${taskId}): uncommitted changes at task completion`;
}

/**
 * マージコミットの固定文言メッセージ。`<type>(<taskId>): merge task (run <runId>)`
 * （design.md §16.17）。**エージェントの出力を混ぜない**。
 *
 * 以前は `Merge task <taskId> (run <runId>)` という固定文言だったが、Conventional
 * Commits形式そのものではなかったため、規約準拠の形へ改めた。`type` は省略可能で、
 * 未指定・未知の値は `normalizeCommitType`（`workflow.ts`）が`chore`へ倒す。
 */
export function mergeCommitMessage(taskId: string, runId: string, type?: string): string {
  return `${normalizeCommitType(type)}(${taskId}): merge task (run ${runId})`;
}

// ---------------------------------------------------------------------------
// タスクブランチの分岐元
// ---------------------------------------------------------------------------

/**
 * タスクブランチの分岐元となるコミットを解決する。**そのタスクを開始する時点の
 * 統合ブランチの先頭**（design.md §16.17「タスクブランチの分岐元」）。
 *
 * 統合worktreeのHEADではなく統合ブランチのrefを読む。マージの途中（衝突の解決中など）の
 * 統合worktreeは候補へdetachしており、HEADは統合ブランチの先頭と一致しない（Issue #1678）。
 */
export async function resolveTaskBranchOrigin(
  repoRoot: string,
  runId: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const cwd = integrationWorktreePath(repoRoot, runId);
  return resolveIntegrationTip(cwd, runId, git);
}

/**
 * 統合ブランチの先頭のSHA。統合の基準は常にこれで、統合worktreeのHEADは使わない
 * （`resolveTaskBranchOrigin`と同じ理由。Issue #1678）。
 */
export async function resolveIntegrationTip(
  integrationWorktreeCwd: string,
  runId: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  if (runIdError(runId) !== undefined) {
    return undefined;
  }
  return resolveBranchSha(integrationWorktreeCwd, integrationBranchName(runId), git);
}

/**
 * 永続データから読んだ試行の状態を検証する。形が合わない・別タスクの試行なら`undefined`
 * （保存された試行が無い古い状態と同じ扱いになる）。
 */
export function parseMergeAttempt(value: unknown, taskId: string): MergeAttempt | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const isSha = (x: unknown): x is string => typeof x === 'string' && FULL_SHA_PATTERN.test(x);
  if (
    v['taskId'] !== taskId ||
    typeof v['attemptId'] !== 'string' ||
    !ATTEMPT_ID_PATTERN.test(v['attemptId']) ||
    !isSha(v['baseSha']) ||
    !isSha(v['sourceSha']) ||
    (v['stage'] !== 'prepared' && v['stage'] !== 'candidate') ||
    (v['candidateSha'] !== undefined && !isSha(v['candidateSha']))
  ) {
    return undefined;
  }
  return {
    taskId,
    attemptId: v['attemptId'],
    baseSha: v['baseSha'],
    sourceSha: v['sourceSha'],
    ...(v['candidateSha'] === undefined ? {} : { candidateSha: v['candidateSha'] }),
    stage: v['stage'],
  };
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
 *
 * `type` はコミットメッセージのConventional Commits typeを指定する省略可能な引数
 * （`uncommittedChangesCommitMessage` へそのまま渡す。未指定・未知の値は`chore`）。
 */
export async function commitUncommittedChangesIfNeeded(
  taskWorktreeCwd: string,
  taskId: string,
  git: GitCommandRunner,
  type?: string,
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
    ['commit', '-m', uncommittedChangesCommitMessage(taskId, type)],
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
 * 統合の1試行の記録（Issue #1678）。統合ブランチのrefを動かす前に、何を基準に何を取り込み、
 * どの候補を作ったかをSHAで残す。`PersistedTaskState.mergeAttempt`として永続化し、リロード後の
 * 判定（`reconcileMergingTaskOnReload`）と、人が衝突を解決した候補の引き取り
 * （`IntegrationMergeQueue.mergeTask`の`previousAttempt`）に使う。
 *
 * **保存はgit操作の前に行う**（`MergeTaskOptions.saveAttempt`）。保存の前にrefが動くと、
 * リロード後にcommitの件名で探すしかなくなり、件名が一致しない場合に二重マージになる
 * （#1677のR型）。
 */
export interface MergeAttempt {
  taskId: string;
  attemptId: string;
  /** 候補を作る基準にした統合ブランチの先頭のSHA。ref更新は先頭がこの値のときだけ行う。 */
  baseSha: string;
  /** 取り込むタスクブランチのSHA。 */
  sourceSha: string;
  /** 候補（baseを第1親、sourceを取り込んだマージコミット）のSHA。候補ができる前は無い。 */
  candidateSha?: string;
  /** `prepared`はgit操作の前、`candidate`は候補ができてref更新の前。 */
  stage: 'prepared' | 'candidate';
}

/**
 * マージの結果。成功・衝突・その他の失敗の3種類（design.md §16.17）。
 *
 * 衝突のときは未解決パスの一覧（`git diff --name-only --diff-filter=U`）と、巻き戻し先の
 * コミットid（試行のbase。統合ブランチの先頭）を添える。**衝突した状態のまま返し、
 * ここでは `git merge --abort` しない。** 解決用セッションが自分でマージをやり直す必要が
 * 無いようにするため（design.md §16.17「コンフリクト」1.）。統合worktreeはbaseへdetachした
 * ままで、統合ブランチのrefは動いていない。解決後の反映は`completeResolution`、巻き戻しは
 * `abortMerge`を呼び出し側が明示的に呼ぶ。
 */
export type MergeTaskResult =
  | { kind: 'success'; mergeCommit: string }
  | {
      kind: 'conflict';
      unresolvedPaths: string[];
      rollbackCommit: string;
      attempt: MergeAttempt;
    }
  /**
   * 統合worktreeが他タスクの未解決の衝突を抱えたままで、いま自分のマージを始められない
   * （Issue #412）。`failure`と分けているのは**回復可能だから**で、呼び出し側
   * （`runnerMerge.ts`）はこれを`failed`ではなく`blocked`へ倒す。`failed`にすると
   * `retryMergeState`が`blocked`からしか戻せないため、Viewの「再マージ」でも復帰できない
   * 行き止まりになる。
   */
  | { kind: 'busy'; message: string }
  | { kind: 'failure'; message: string };

/**
 * 統合worktreeで既にマージが進行中（他タスクの衝突が未解決のまま残っている）かどうかを
 * 調べ、進行中ならその理由の文言を返す（Issue #412）。
 *
 * `IntegrationMergeQueue`の占有（リース）で本来は防がれるが、リースを取らずに
 * `mergeTaskBranch`へ到達した場合でも「他タスクの未解決状態を自分の衝突として拾う」
 * 誤判定を起こさないための多層防御。ここで止めれば、`git merge`が
 * `Merging is not possible because you have unmerged files.` で失敗したあとに
 * `git diff --diff-filter=U`が**他タスクの**未解決パスを返す経路そのものへ入らない。
 *
 * 判定は2つ:
 *
 * - `git rev-parse -q --verify MERGE_HEAD` が成功する（マージの途中）
 * - `git diff --name-only --diff-filter=U` が非空（`MERGE_HEAD`が無くても未解決が残る形）
 *
 * どちらの確認も、gitコマンド自体が失敗した場合は「判定できない」として素通りさせる
 * （統合worktreeが壊れている場合は続く`git merge`自身が失敗し、`failure`へ倒れる）。
 */
async function findMergeInProgress(
  integrationWorktreeCwd: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const mergeHead = await git.run(
    ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
    integrationWorktreeCwd,
  );
  if (mergeHead.code === 0 && mergeHead.stdout.trim() !== '') {
    return '統合worktreeに他タスクの未解決のマージ（MERGE_HEADの残り）があるため、いまはマージできません。統合worktreeの衝突を解決するか巻き戻してから「再マージ」してください';
  }
  const unresolved = await git.run(
    ['diff', '--name-only', '--diff-filter=U'],
    integrationWorktreeCwd,
  );
  if (unresolved.code === 0 && unresolved.stdout.trim() !== '') {
    return '統合worktreeに他タスクの未解決の衝突が残っているため、いまはマージできません。統合worktreeの衝突を解決してから「再マージ」してください';
  }
  return undefined;
}

/** `IntegrationMergeQueue.mergeTask`の追加の引数。 */
export interface MergeTaskOptions {
  /** マージコミットのConventional Commits type（`mergeCommitMessage`へ渡す。未指定・未知は`chore`）。 */
  type?: string;
  /** 同じタスクの前回の試行。統合worktreeに残った候補を引き取れるかの判定に使う。 */
  previousAttempt?: MergeAttempt | undefined;
  /**
   * 試行の状態を保存する。git操作（detach・merge・ref更新）の前に呼び、完了を待つ。
   * 例外を投げたらマージを始めずに`failure`を返す。
   */
  saveAttempt: (attempt: MergeAttempt) => Promise<void>;
}

/**
 * タスクブランチを統合ブランチへ取り込む、統合の唯一の経路（Issue #1678）。**exportしない。**
 * 呼び出し側は必ず `IntegrationMergeQueue.mergeTask` を経由すること（`worktree.ts` の作成・
 * 撤去と同じ `index.lock` の競合を避けるため。design.md §16.17「マージはworktreeの作成・撤去と
 * 同じ1本のキューに通して直列化する」）。
 *
 * 手順は「試行の状態を保存→統合ブランチの先頭（base）へdetach→`git merge --no-ff <source>`で
 * 候補を作る→候補を検証→`git update-ref`で先頭がbaseのときだけ統合ブランチを候補へ進める→
 * 統合ブランチをcheckoutし直す」。統合ブランチのrefを動かすのは最後のCASだけで、途中で
 * 失敗・中断しても統合ブランチは元の先頭のまま残る。CASが失敗したら（先頭がbaseから動いた）
 * 候補を捨てて新しい先頭から作り直す。
 */
async function mergeTaskBranch(
  integrationWorktreeCwd: string,
  runId: string,
  taskId: string,
  taskBranch: string,
  git: GitCommandRunner,
  options: MergeTaskOptions,
): Promise<MergeTaskResult> {
  const idMessage = identifierError(runId, taskId);
  if (idMessage !== undefined) {
    return { kind: 'failure', message: idMessage };
  }
  if (!isValidTaskBranch(taskBranch, runId)) {
    return {
      kind: 'failure',
      message:
        `不正なtaskBranch（wf/${runId}/... の形にも、conventional形式（<type>/<issue>/<slug>、` +
        `末尾がこのrunIdの先頭8文字）にも一致しません）: ${taskBranch}`,
    };
  }

  const inProgress = await findMergeInProgress(integrationWorktreeCwd, git);
  if (inProgress !== undefined) {
    // `failure`ではなく`busy`。ここへ来るのは「他タスクの停止経路が未解決状態を残した」
    // ようなケースで、人が統合worktreeを片付ければ「再マージ」で先へ進める。`failure`に
    // 倒すと`markMergeFailed`で`failed`が確定し、`retryMergeState`（`blocked`専用）では
    // 戻せなくなる（Issue #412のレビュー指摘1）
    return { kind: 'busy', message: inProgress };
  }

  const branch = integrationBranchName(runId);
  const sourceSha = await resolveBranchSha(integrationWorktreeCwd, taskBranch, git);
  if (sourceSha === undefined) {
    return { kind: 'failure', message: `タスクブランチ ${taskBranch} のcommitを解決できません` };
  }

  const settled = await settleIntegrationHead(
    integrationWorktreeCwd,
    branch,
    { runId, taskId, taskBranch, sourceSha },
    options.previousAttempt,
    git,
  );
  if (settled.kind === 'busy' || settled.kind === 'failure') {
    return settled;
  }
  if (settled.kind === 'adopt') {
    // 前回の試行の候補（人が衝突を解決してコミットしたもの、またはref更新の前に中断したもの）が
    // 統合worktreeに残っている。作り直さずにそのまま反映する。これは前回の試行の後始末なので、
    // staleでも下の作り直しの回数（MAX_CANDIDATE_REBUILDS）には数えない
    const published = await publishCandidate(
      integrationWorktreeCwd,
      branch,
      settled.attempt,
      git,
      options.saveAttempt,
    );
    if (published.kind !== 'stale') {
      return published;
    }
  }

  for (let rebuild = 0; rebuild < MAX_CANDIDATE_REBUILDS; rebuild += 1) {
    const baseSha = await resolveBranchSha(integrationWorktreeCwd, branch, git);
    if (baseSha === undefined) {
      return { kind: 'failure', message: `統合ブランチ ${branch} の先頭を解決できません` };
    }
    if ((await isAncestor(integrationWorktreeCwd, sourceSha, baseSha, git)) === true) {
      // 既に取り込み済み（`git merge`の「Already up to date」に当たる）。refは動かさない
      return { kind: 'success', mergeCommit: baseSha };
    }
    const attempt: MergeAttempt = {
      taskId,
      attemptId: randomUUID(),
      baseSha,
      sourceSha,
      stage: 'prepared',
    };
    const saveError = await trySaveAttempt(options.saveAttempt, attempt);
    if (saveError !== undefined) {
      return { kind: 'failure', message: saveError };
    }
    const built = await buildCandidate(
      integrationWorktreeCwd,
      branch,
      runId,
      attempt,
      git,
      options.type,
    );
    if (built.kind !== 'candidate') {
      return built;
    }
    const published = await publishCandidate(
      integrationWorktreeCwd,
      branch,
      built.attempt,
      git,
      options.saveAttempt,
    );
    if (published.kind !== 'stale') {
      return published;
    }
    // ref更新の直前に統合ブランチの先頭がbaseから動いた。候補を捨て、新しい先頭から作り直す
  }
  await restoreIntegrationHead(integrationWorktreeCwd, branch, git);
  return {
    kind: 'failure',
    message: `統合ブランチ ${branch} の先頭が動き続けたため、${MAX_CANDIDATE_REBUILDS}回作り直しても統合候補を反映できませんでした`,
  };
}

/** ref更新（CAS）が先頭の移動で失敗したときに候補を作り直す上限。 */
const MAX_CANDIDATE_REBUILDS = 3;

/** ローカルブランチの先頭のSHA。`name`は検証済みのブランチ名（統合ブランチ・タスクブランチ）に限る。 */
async function resolveBranchSha(
  cwd: string,
  name: string,
  git: GitCommandRunner,
): Promise<string | undefined> {
  const result = await git.run(['show-ref', '--verify', '--hash', `refs/heads/${name}`], cwd);
  const sha = result.stdout.trim();
  return result.code === 0 && FULL_SHA_PATTERN.test(sha) ? sha : undefined;
}

/**
 * `ancestor`が`descendant`から到達できるか。gitコマンド自体が失敗したら`undefined`（不明）。
 *
 * 「到達できない」は終了コード1、コマンドの異常（不正なSHAなど）は128で返る。stderrの有無では
 * 判定しない。`nodeGitCommandRunner`は非0終了でstderrが空だと例外の文言を詰めるため、
 * 「到達できない」まで不明になってしまう。
 */
async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
  git: GitCommandRunner,
): Promise<boolean | undefined> {
  const result = await git.run(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
  if (result.code === 0) {
    return true;
  }
  return result.code === 1 ? false : undefined;
}

/** 試行の状態を保存する。失敗したら理由の文言を返す（git操作へ進まない）。 */
async function trySaveAttempt(
  save: (attempt: MergeAttempt) => Promise<void>,
  attempt: MergeAttempt,
): Promise<string | undefined> {
  try {
    await save(attempt);
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `統合の試行状態を保存できないためマージを始めません: ${sanitizeForLog(detail)}`;
  }
}

/** gitコマンドの失敗を1行の文言にする。 */
function gitFailureMessage(label: string, result: { code: number; stderr: string }): string {
  return result.stderr.trim() !== ''
    ? sanitizeForLog(result.stderr)
    : `${label} に失敗しました（終了コード ${result.code}）`;
}

type SettledHead =
  | { kind: 'attached' }
  | { kind: 'adopt'; attempt: MergeAttempt }
  | { kind: 'busy'; message: string }
  | { kind: 'failure'; message: string };

/**
 * マージを始める前に、統合worktreeを「統合ブランチをcheckoutした状態」へ揃える。
 *
 * 統合worktreeがdetachしているのは、前の試行の候補が残っている（衝突を人が解決してコミット
 * した、ref更新の前に中断した）か、ref更新の後の再checkoutの前に中断したかのどちらか。
 * 前回の試行（`previous`）の候補がいまも反映できる（base・sourceが一致し、候補の検証を
 * 通る）ならそれを引き取る（`adopt`）。それ以外の候補は先頭がbaseから動いて使えないため
 * 捨てて統合ブランチをcheckoutし直す。未コミットの変更が残っていれば人の作業を消さないよう
 * `busy`で止める。
 */
async function settleIntegrationHead(
  cwd: string,
  branch: string,
  target: { runId: string; taskId: string; taskBranch: string; sourceSha: string },
  previous: MergeAttempt | undefined,
  git: GitCommandRunner,
): Promise<SettledHead> {
  const head = await git.run(['symbolic-ref', '-q', 'HEAD'], cwd);
  const headRef = head.stdout.trim();
  if (head.code === 0) {
    return headRef === `refs/heads/${branch}`
      ? { kind: 'attached' }
      : {
          kind: 'busy',
          message: `統合worktreeが統合ブランチ以外（${sanitizeForLog(headRef)}）をcheckoutしているため、いまはマージできません。統合ブランチ ${branch} をcheckoutし直してから「再マージ」してください`,
        };
  }
  if (head.code !== 1) {
    return { kind: 'failure', message: gitFailureMessage('git symbolic-ref HEAD', head) };
  }
  const status = await git.run(['status', '--porcelain', '-uno'], cwd);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return {
      kind: 'busy',
      message:
        '統合worktreeに未コミットの変更が残っているため、いまはマージできません。統合worktreeを片付けてから「再マージ」してください',
    };
  }
  if (
    previous !== undefined &&
    previous.taskId === target.taskId &&
    previous.sourceSha === target.sourceSha &&
    (await resolveBranchSha(cwd, branch, git)) === previous.baseSha
  ) {
    const candidateSha = await verifyCandidate(cwd, target.runId, target.taskBranch, previous, git);
    if (candidateSha !== undefined) {
      return { kind: 'adopt', attempt: { ...previous, candidateSha, stage: 'candidate' } };
    }
  }
  const checkout = await git.run(['checkout', branch], cwd);
  return checkout.code === 0
    ? { kind: 'attached' }
    : { kind: 'failure', message: gitFailureMessage(`git checkout ${branch}`, checkout) };
}

type BuildCandidateResult =
  | { kind: 'candidate'; attempt: MergeAttempt }
  | Extract<MergeTaskResult, { kind: 'success' | 'conflict' | 'failure' }>;

/**
 * 統合ブランチの先頭（`attempt.baseSha`）へdetachし、sourceを`git merge --no-ff`して候補を作る。
 * 統合ブランチのrefはここでは動かさない。衝突したらdetachしたまま`conflict`を返す。
 */
async function buildCandidate(
  cwd: string,
  branch: string,
  runId: string,
  attempt: MergeAttempt,
  git: GitCommandRunner,
  type: string | undefined,
): Promise<BuildCandidateResult> {
  const detach = await git.run(['checkout', '--detach', attempt.baseSha], cwd);
  if (detach.code !== 0) {
    await restoreIntegrationHead(cwd, branch, git);
    return { kind: 'failure', message: gitFailureMessage('git checkout --detach', detach) };
  }
  const merge = await git.run(
    ['merge', '--no-ff', '-m', mergeCommitMessage(attempt.taskId, runId, type), attempt.sourceSha],
    cwd,
  );
  if (merge.code === 0) {
    const head = await resolveHeadCommit(cwd, git);
    if (head === attempt.baseSha) {
      // 取り込むものが無かった（「Already up to date」）。候補を作らずに戻す
      await restoreIntegrationHead(cwd, branch, git);
      return { kind: 'success', mergeCommit: attempt.baseSha };
    }
    if (head === undefined || !FULL_SHA_PATTERN.test(head)) {
      await restoreIntegrationHead(cwd, branch, git);
      return { kind: 'failure', message: '統合候補のcommitを解決できません' };
    }
    return { kind: 'candidate', attempt: { ...attempt, candidateSha: head, stage: 'candidate' } };
  }

  const unresolvedPaths = await listUnresolvedPaths(cwd, git);
  if (unresolvedPaths.length > 0) {
    return { kind: 'conflict', unresolvedPaths, rollbackCommit: attempt.baseSha, attempt };
  }
  await restoreIntegrationHead(cwd, branch, git);
  return { kind: 'failure', message: gitFailureMessage('git merge', merge) };
}

async function listUnresolvedPaths(cwd: string, git: GitCommandRunner): Promise<string[]> {
  const unresolved = await git.run(['diff', '--name-only', '--diff-filter=U'], cwd);
  return unresolved.code === 0
    ? unresolved.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];
}

/**
 * 統合worktreeのHEAD（detach中の候補）を検証し、通ればそのSHAを返す。
 *
 * `isMergeResolutionComplete`（未解決パスなし・`MERGE_HEAD`なし・作業ツリーがclean・
 * タスクブランチが取り込み済み）に加え、候補の第1親が試行のbaseで、試行のsourceが候補から
 * 到達できることを確かめる。baseの確認が無いと、先頭以外を基準にした候補（衝突解決中に
 * 人がresetした等）を統合ブランチへ載せてしまう。
 */
async function verifyCandidate(
  cwd: string,
  runId: string,
  taskBranch: string,
  attempt: MergeAttempt,
  git: GitCommandRunner,
): Promise<string | undefined> {
  if (!(await isMergeResolutionComplete(cwd, git, { runId, taskBranch }))) {
    return undefined;
  }
  const parents = await git.run(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd);
  const [candidateSha, firstParent] = parents.stdout.trim().split(/\s+/u);
  if (
    parents.code !== 0 ||
    candidateSha === undefined ||
    !FULL_SHA_PATTERN.test(candidateSha) ||
    firstParent !== attempt.baseSha
  ) {
    return undefined;
  }
  return (await isAncestor(cwd, attempt.sourceSha, candidateSha, git)) === true
    ? candidateSha
    : undefined;
}

type PublishResult = Extract<MergeTaskResult, { kind: 'success' | 'failure' }> | { kind: 'stale' };

/**
 * 検証済みの候補を統合ブランチへ反映する。`git update-ref refs/heads/<branch> <candidate> <base>`
 * （先頭がbaseのときだけ更新するCAS）のあと、統合ブランチをcheckoutし直す。
 *
 * 先頭がbaseから動いていてCASが失敗したら`stale`を返す（呼び出し側が作り直すか止める）。
 * 先頭がbaseのままなのに更新できなかったときは、gitの失敗として`failure`を返す。
 * 先頭が既に候補と同じ（前回の試行がref更新まで済ませて中断した）なら成功として扱う。
 */
async function publishCandidate(
  cwd: string,
  branch: string,
  attempt: MergeAttempt,
  git: GitCommandRunner,
  save: (attempt: MergeAttempt) => Promise<void>,
): Promise<PublishResult> {
  const candidateSha = attempt.candidateSha;
  if (candidateSha === undefined) {
    return { kind: 'failure', message: '統合候補が無いため統合ブランチへ反映できません' };
  }
  const saveError = await trySaveAttempt(save, attempt);
  if (saveError !== undefined) {
    await restoreIntegrationHead(cwd, branch, git);
    return { kind: 'failure', message: saveError };
  }
  const update = await git.run(
    ['update-ref', `refs/heads/${branch}`, candidateSha, attempt.baseSha],
    cwd,
  );
  if (update.code !== 0) {
    const tip = await resolveBranchSha(cwd, branch, git);
    if (tip === undefined || tip === attempt.baseSha) {
      // 先頭はbaseのまま（またはrefを読めない）なのに更新できなかった。CASの競合ではなく
      // refのロック残留・権限・容量などのgitの失敗なので、作り直さずにgitのエラーを返す
      await restoreIntegrationHead(cwd, branch, git);
      return { kind: 'failure', message: gitFailureMessage('git update-ref', update) };
    }
    if (tip !== candidateSha) {
      return { kind: 'stale' };
    }
  }
  // ref更新は済んでいるため、再checkoutの失敗はマージの失敗にしない。detachしたままでも
  // 次の試行の`settleIntegrationHead`が統合ブランチをcheckoutし直す
  await git.run(['checkout', branch], cwd);
  return { kind: 'success', mergeCommit: candidateSha };
}

/**
 * 統合worktreeを「統合ブランチをcheckoutした状態」へ戻す（片付け）。進行中のマージがあれば
 * `git merge --abort`で取り消してから統合ブランチをcheckoutする。統合ブランチのrefは
 * 動かさないため、捨てた候補は統合ブランチに残らない。
 */
async function restoreIntegrationHead(
  cwd: string,
  branch: string,
  git: GitCommandRunner,
): Promise<AbortMergeResult> {
  const mergeHead = await git.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd);
  if (mergeHead.code === 0) {
    const abort = await git.run(['merge', '--abort'], cwd);
    if (abort.code !== 0) {
      return {
        ok: false,
        reason: 'gitError',
        message: gitFailureMessage('git merge --abort', abort),
      };
    }
  }
  const checkout = await git.run(['checkout', branch], cwd);
  if (checkout.code !== 0) {
    return {
      ok: false,
      reason: 'gitError',
      message: gitFailureMessage(`git checkout ${branch}`, checkout),
    };
  }
  return { ok: true };
}

/** 衝突解決セッションが作った候補を反映した結果（`IntegrationMergeQueue.completeResolution`）。 */
export type CompleteResolutionResult =
  | Extract<MergeTaskResult, { kind: 'success' | 'failure' }>
  /** 候補が検証を通らない（未解決・未コミット・baseやsourceとの関係が合わない）。 */
  | { kind: 'incomplete' }
  /** 解決の間に統合ブランチの先頭がbaseから動いた。候補は使えない。 */
  | { kind: 'stale' };

// ---------------------------------------------------------------------------
// 巻き戻し
// ---------------------------------------------------------------------------

export type AbortMergeResult =
  { ok: true } | { ok: false; reason: 'gitError' | 'leaseNotHeld'; message: string };

// ---------------------------------------------------------------------------
// 統合worktreeの占有（リース）と直列化キュー
// ---------------------------------------------------------------------------

/**
 * 統合worktreeを1タスクが占有していることを表すハンドル（Issue #412）。
 *
 * `IntegrationMergeQueue.acquireLease`だけが作れる不透明な値で、`mergeTask` /
 * `abortMerge` の引数として要求される。**マージ1件の全区間**（`git merge`から、衝突した
 * 場合は解決セッションが終わって`done`／`blocked`が確定するまで）をこのハンドルで守る。
 *
 * 従来は`WorktreeCreationQueue`の直列化しか無く、キュー項目の粒度が「gitコマンド1回」
 * だったため、衝突解決セッション（LLMの複数ターン。数分〜数十分）の間は統合worktreeが
 * 無防備だった。その隙に別タスクのマージが走ると、他タスクの未解決パスを自分の衝突として
 * 拾う・他タスクの解決作業を`git merge --abort`で巻き戻す、といった壊れ方をする。
 *
 * **占有の区間にはPR/MRの作成（`gh`/`glab`のネットワーク処理。design.md §16.18）も含む。**
 * `gh`/`glab`が固まると他タスクのマージまで待たされる、という指摘は認識したうえで、
 * それでも区間を分けない。PR/MRの作成は`runTaskPullRequestFlow`が
 * push→push→create→merge+push という1本の順序で行うもので、途中でいったん占有を手放すと、
 * 統合ブランチのpushとローカルのマージの間に別タスクのマージが割り込む余地（このIssueで
 * 塞いだのと同じ種類のレース）を作り直してしまう。正しさを優先して区間を保つ。
 * 占有が長く握られる問題（承認待ちを含む）はIssue #413の範囲として別途扱う。
 */
export interface IntegrationLease {
  /** 占有している統合worktreeのcwd。 */
  readonly integrationWorktreeCwd: string;
  /** 占有しているタスクのid。 */
  readonly taskId: string;
}

/** 占有ハンドルが無効なときに`mergeTask`が返す文言。 */
const LEASE_NOT_HELD_MERGE = '統合worktreeの占有（リース）を持っていないためマージできません';

/** 占有ハンドルが無効なときに`abortMerge`が返す文言。 */
const LEASE_NOT_HELD_ABORT = '統合worktreeの占有（リース）を持っていないためマージを巻き戻せません';

/**
 * `IntegrationLease`の実体。**exportしない**（外から偽造したハンドルで`mergeTask` /
 * `abortMerge`を通せないようにするため。`owner`の同一性まで見る）。
 */
class IntegrationLeaseHandle implements IntegrationLease {
  released = false;
  /**
   * `releaseAllLeases()`（強制解放）で失効させられた印。通常の`releaseLease`では立たない。
   * 「順番が回ってきて起きた」のか「強制解放で起こされた」のかを、待っていた側が
   * 区別できるようにするためだけに持つ（`wasLeaseRevoked`）。
   */
  revoked = false;

  constructor(
    readonly owner: IntegrationMergeQueue,
    readonly integrationWorktreeCwd: string,
    readonly taskId: string,
  ) {}
}

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
 * `createIntegrationWorktree` / `mergeTaskBranch` / `restoreIntegrationHead` はこのファイルの外へ
 * exportしていない。統合worktreeの作成・マージ・巻き戻しはこのクラスのメソッドだけが
 * 入口になる構造にすることで、「キューを経由し忘れる」事故を型のうえで起こしえない
 * 状態にする（`worktree.ts` の `WorktreeCreationQueue` と同じ方針）。
 */
export class IntegrationMergeQueue {
  constructor(private readonly worktreeQueue: WorktreeCreationQueue) {}

  /**
   * 統合worktreeごとの現在の占有者（`acquireLease`が渡したハンドル）。キーは統合worktreeの
   * cwd（runごとに異なるディレクトリなので、1つのキューを複数runで共有しても混ざらない）。
   */
  private readonly leaseHolders = new Map<string, IntegrationLeaseHandle>();

  /** 占有待ちの行列（FIFO）。統合worktreeのcwdごとに持つ。 */
  private readonly leaseWaiters = new Map<
    string,
    Array<{ handle: IntegrationLeaseHandle; resolve: () => void }>
  >();

  /**
   * 統合worktreeの占有（リース）を取る。既に他タスクが占有していれば、解放されるまで
   * FIFOで待つ（Issue #412）。
   *
   * **必ず`try/finally`で`releaseLease`と対にすること。** 解放し忘れると、以後そのrunの
   * マージが全て待ち続ける（デッドロック）。run破棄時の保険として`releaseAllLeases`も
   * 用意してある。
   */
  async acquireLease(integrationWorktreeCwd: string, taskId: string): Promise<IntegrationLease> {
    const handle = new IntegrationLeaseHandle(this, integrationWorktreeCwd, taskId);
    if (!this.leaseHolders.has(integrationWorktreeCwd)) {
      this.leaseHolders.set(integrationWorktreeCwd, handle);
      return handle;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.leaseWaiters.get(integrationWorktreeCwd) ?? [];
      waiters.push({ handle, resolve });
      this.leaseWaiters.set(integrationWorktreeCwd, waiters);
    });
    return handle;
  }

  /**
   * 占有を解放し、待っている次のタスクへ渡す。**同じハンドルで何度呼んでも安全**
   * （2度目以降は何もしない）。「衝突解決の途中で例外が起きた経路」と「`finally`」の
   * 両方から呼ばれても二重解放にならないようにするため。
   */
  releaseLease(lease: IntegrationLease): void {
    if (!(lease instanceof IntegrationLeaseHandle) || lease.owner !== this || lease.released) {
      return;
    }
    const cwd = lease.integrationWorktreeCwd;
    if (this.leaseHolders.get(cwd) !== lease) {
      // 失効していないのに保持者でもないハンドル。**`released`を立てる前に保持者を照合する**
      // （Issue #412のレビュー指摘3）。順序が逆だと、行列に並んだままのハンドルが失効だけして、
      // 後で`leaseHolders.set(cwd, next.handle)`が死んだハンドルへ占有を渡し、そのcwdの
      // マージが永久に詰まる。
      //
      // **この分岐は公開APIからは到達しない**（同レビュー指摘9）。`acquireLease`は「保持者に
      // なった」か「`releaseAllLeases`で失効させられた」かのどちらかになるまでresolveしない
      // ため、呼び出し側へ渡るハンドルは常に「現在の保持者」か「失効済み」のいずれかで、
      // 待ち行列に並んだままのハンドルは外から触れない。将来`acquireLease`にキャンセルを
      // 足したときに、待機中のハンドルを黙って失効させないための最終防御として残す
      return;
    }
    lease.released = true;
    const waiters = this.leaseWaiters.get(cwd);
    const next = waiters?.shift();
    if (next === undefined) {
      this.leaseHolders.delete(cwd);
      this.leaseWaiters.delete(cwd);
      return;
    }
    this.leaseHolders.set(cwd, next.handle);
    next.resolve();
  }

  /**
   * 全ての占有を強制的に解放する（`WorkflowRunner.dispose()`から呼ぶ保険）。
   *
   * 待っているタスクは「解放済みのハンドル」を受け取った状態で起き上がるため、その
   * `mergeTask` / `abortMerge` は`failure`で返る。待ち続けて固まるより、失敗として
   * 表面化するほうが安全（fail-closed）。
   */
  releaseAllLeases(): void {
    const holders = [...this.leaseHolders.values()];
    const waiters = [...this.leaseWaiters.values()].flat();
    this.leaseHolders.clear();
    this.leaseWaiters.clear();
    for (const handle of holders) {
      handle.released = true;
      handle.revoked = true;
    }
    for (const waiter of waiters) {
      waiter.handle.released = true;
      waiter.handle.revoked = true;
      waiter.resolve();
    }
  }

  /**
   * そのハンドルが`releaseAllLeases()`（強制解放）で失効させられたかどうか。
   *
   * 占有待ちから起き上がった呼び出し側が「順番が回ってきたのか、強制解放で起こされたのか」
   * を区別するために使う（Issue #412のレビュー指摘9・11）。`acquireLease`はこのどちらかに
   * なるまでresolveしないため、待っていた側にとってこの2つは排他になる。
   *
   * **返すのは「強制解放された」という事実だけで、その理由は含まない。** 以前は
   * `holdsLease`の公開別名（`isLeaseHeld`）で、呼び出し側がその`false`を「runが破棄された」と
   * 読み替えて何もせず戻っていた。その読み替えが成り立つのは`releaseAllLeases`の呼び出し元が
   * `WorkflowRunner.dispose()`だけだからで、このクラスは何もそれを保証していない。将来
   * `releaseAllLeases`を停止時などにも呼ぶようにすると、読み替えた側は「破棄されたので戻る」と
   * 判断し、そのタスクは`merging`のまま固着してrunが永久に終わらなくなる（`getRunOutcome`が
   * `merging`を`running`扱いするため）。意味づけは呼び出し側が自分の状態と突き合わせて決める
   * （`runnerMerge.ts`の`decideAfterLeaseWait`。破棄済みなら何もせず戻り、生きているrunなら
   * `blocked`へ倒して「再マージ」で復帰できるようにする）。
   */
  wasLeaseRevoked(lease: IntegrationLease): boolean {
    return lease instanceof IntegrationLeaseHandle && lease.owner === this && lease.revoked;
  }

  /** テスト・診断用。いま占有されている統合worktreeのcwdなら占有者のtaskIdを返す。 */
  leaseHolderTaskId(integrationWorktreeCwd: string): string | undefined {
    return this.leaseHolders.get(integrationWorktreeCwd)?.taskId;
  }

  /** 有効な占有ハンドルかどうか（このキューが今まさに占有者として認めているか）。 */
  private holdsLease(lease: IntegrationLease): lease is IntegrationLeaseHandle {
    return (
      lease instanceof IntegrationLeaseHandle &&
      lease.owner === this &&
      !lease.released &&
      this.leaseHolders.get(lease.integrationWorktreeCwd) === lease
    );
  }

  /** 統合ブランチ・統合worktreeを1件作る（`createIntegrationWorktree` をキュー経由で呼ぶ）。 */
  createIntegrationWorktree(
    request: CreateIntegrationWorktreeRequest,
    git: GitCommandRunner,
    fs: WorktreeFileSystemPort,
  ): Promise<CreateIntegrationWorktreeResult> {
    return this.worktreeQueue.enqueue(() => createIntegrationWorktree(request, git, fs));
  }

  /**
   * タスクブランチを統合ブランチへ取り込む（`mergeTaskBranch` をキュー経由で呼ぶ）。
   *
   * 第1引数は`acquireLease`で取った占有ハンドル。統合worktreeのcwdはハンドルが持つ
   * （呼び出し側が別のcwdを渡せない）。ハンドルが失効していれば`failure`を返す。
   */
  mergeTask(
    lease: IntegrationLease,
    runId: string,
    taskId: string,
    taskBranch: string,
    git: GitCommandRunner,
    options: MergeTaskOptions,
  ): Promise<MergeTaskResult> {
    if (!this.holdsLease(lease)) {
      return Promise.resolve<MergeTaskResult>({ kind: 'failure', message: LEASE_NOT_HELD_MERGE });
    }
    if (lease.taskId !== taskId) {
      return Promise.resolve({
        kind: 'failure',
        message: `占有（リース）の持ち主（${lease.taskId}）とマージ対象のタスク（${taskId}）が食い違います`,
      });
    }
    const cwd = lease.integrationWorktreeCwd;
    return this.worktreeQueue.enqueue(() => {
      // キュー待ちの間に`releaseAllLeases()`（`WorkflowRunner.dispose()`）が走ると、
      // 投入時には有効だったハンドルが失効している。ジョブ本体の先頭でも確認する
      // （Issue #412のレビュー指摘4。確認が投入前だけだと、失効済みのまま`git merge`が走る）
      if (!this.holdsLease(lease)) {
        return Promise.resolve<MergeTaskResult>({ kind: 'failure', message: LEASE_NOT_HELD_MERGE });
      }
      return mergeTaskBranch(cwd, runId, taskId, taskBranch, git, options);
    });
  }

  /**
   * 衝突解決セッションが作った候補（統合worktreeのHEAD）を検証し、統合ブランチへ反映する
   * （`mergeTask`の衝突時の続き。Issue #1678）。検証とref更新は`mergeTask`と同じ
   * `verifyCandidate`・`publishCandidate`を通る。
   *
   * `stale`（解決の間に先頭が動いた）では作り直さない。解決の内容が古いbaseに対するもので、
   * 新しい先頭に対して機械的に作り直すと衝突解決をやり直す必要があるため、呼び出し側が
   * `blocked`へ倒して人の「再マージ」に委ねる。
   */
  completeResolution(
    lease: IntegrationLease,
    runId: string,
    taskBranch: string,
    attempt: MergeAttempt,
    git: GitCommandRunner,
    saveAttempt: (attempt: MergeAttempt) => Promise<void>,
  ): Promise<CompleteResolutionResult> {
    if (!this.holdsLease(lease) || lease.taskId !== attempt.taskId) {
      return Promise.resolve<CompleteResolutionResult>({
        kind: 'failure',
        message: LEASE_NOT_HELD_MERGE,
      });
    }
    const cwd = lease.integrationWorktreeCwd;
    return this.worktreeQueue.enqueue(async (): Promise<CompleteResolutionResult> => {
      if (!this.holdsLease(lease)) {
        return { kind: 'failure', message: LEASE_NOT_HELD_MERGE };
      }
      const branch = integrationBranchName(runId);
      const candidateSha = await verifyCandidate(cwd, runId, taskBranch, attempt, git);
      if (candidateSha === undefined) {
        return { kind: 'incomplete' };
      }
      return publishCandidate(
        cwd,
        branch,
        { ...attempt, candidateSha, stage: 'candidate' },
        git,
        saveAttempt,
      );
    });
  }

  /**
   * 進行中のマージ・未反映の候補を捨て、統合worktreeを統合ブランチへ戻す
   * （`restoreIntegrationHead` をキュー経由で呼ぶ。design.md §16.17「巻き戻し」）。
   * 統合ブランチのrefは動かさない。
   *
   * **占有ハンドルを持つタスクだけが巻き戻せる。** ハンドルを要求しないと、衝突解決中の
   * 他タスクの作業（未コミットの解決結果とインデックス）を`git merge --abort`で巻き戻して
   * しまう（Issue #412の指摘2）。
   */
  abortMerge(
    lease: IntegrationLease,
    runId: string,
    git: GitCommandRunner,
  ): Promise<AbortMergeResult> {
    if (!this.holdsLease(lease)) {
      return Promise.resolve<AbortMergeResult>({
        ok: false,
        reason: 'leaseNotHeld',
        message: LEASE_NOT_HELD_ABORT,
      });
    }
    const cwd = lease.integrationWorktreeCwd;
    return this.worktreeQueue.enqueue(() => {
      // `mergeTask`と同じ理由でジョブ本体の先頭でも確認する（Issue #412のレビュー指摘4）。
      // ここを省くと、キュー待ちの間に失効したハンドルのまま`git merge --abort`が実際に
      // 走り、他タスクの解決作業を巻き戻しうる
      if (!this.holdsLease(lease)) {
        return Promise.resolve<AbortMergeResult>({
          ok: false,
          reason: 'leaseNotHeld',
          message: LEASE_NOT_HELD_ABORT,
        });
      }
      return restoreIntegrationHead(cwd, integrationBranchName(runId), git);
    });
  }

  /**
   * 統合ブランチをoriginへpushする（`forge.ts`の`pushBranch`をキュー経由で呼ぶ。
   * design.md §16.18・Issue #253）。
   *
   * タスクブランチのpushとは異なり、統合ブランチへのpushは同じrun内の複数タスクが
   * ほぼ同時に行いうる（同じrankのタスクが並列で完了する場合）。作成・撤去・マージと
   * 同じキューへ通すことで、同じ統合worktree・同じ統合ブランチに対するpushが重ならない
   * ようにする（直列化してもリモート側で他クライアントとの競合は起こりうるため、
   * `pushBranch`自体のリトライと併用する）。
   */
  pushIntegrationBranch(
    git: GitCommandRunner,
    integrationWorktreeCwd: string,
    integrationBranch: string,
  ): Promise<PushBranchResult> {
    return this.worktreeQueue.enqueue(() =>
      pushBranch(git, integrationWorktreeCwd, integrationBranch),
    );
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
 * - 保存された試行（`attempt`）があれば、統合ブランチの先頭がその候補か、先頭からsourceへ
 *   到達できれば `done`、そうでなければ `merging`（Issue #1678。以下の件名照合は使わない）
 * - 試行が無ければ、対象タスクのマージコミット（`mergeCommitMessage`の固定文言。旧形式
 *   `Merge task <taskId> (run <runId>)` も含む）が統合ブランチの履歴に見つかれば `done`
 * - どちらでもなければ `merging`（呼び出し側がマージをやり直す）
 *
 * `runId` / `taskId` が不正な場合や、統合worktreeが読めない場合（gitコマンド自体が
 * 失敗する）は安全側の `merging`（やり直し対象）を返す。
 *
 * **`type`引数は持たない。** 以前は`mergeCommitMessage(taskId, runId, type)`の固定文言を
 * そのまま`--grep`（`--fixed-strings`付きの完全一致）に使っており、マージ時に実際へ渡した
 * `type`と呼び出し側が揃えないと見つからなかった。`type`は`PersistedTaskState`
 * （`runStore.ts`）に永続化されておらず、リロード時は定義ファイルを再パースした結果から
 * 引き直すしかない値のため、「ワークフローYAMLの`type:`をrunの実行中に書き換えてから
 * リロードする」「旧バージョンの拡張機能（旧形式のマージコミット）で走らせたrunを、この
 * 変更を含む新バージョンへ上げてからリロードする」の2経路で、既にマージ済みのタスクを
 * `merging`（やり直し対象）へ誤判定し、同じタスクブランチへ二重マージが走る事故になって
 * いた。`findTaskIdsMergedSince`と同じ「gitには件名の一覧を出させ、照合はJS側で行う」
 * 方式へ寄せ、`type`を問わず（`COMMIT_TYPES`のいずれでも）・新旧どちらの形式でもマッチ
 * させることでこの2経路を塞ぐ。
 */
export type ReconcileMergingOutcome = 'done' | 'merging' | 'blocked';

export async function reconcileMergingTaskOnReload(
  integrationWorktreeCwd: string,
  runId: string,
  taskId: string,
  git: GitCommandRunner,
  attempt?: MergeAttempt,
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

  // 保存された試行があればSHAで判定する（Issue #1678）。先頭が候補そのもの、または先頭から
  // sourceへ到達できれば取り込み済み。それ以外は`merging`（再開時に`mergeTask`が候補を
  // 引き取るか、新しい先頭から作り直す）。件名の照合は試行が保存されていない古い状態だけに残す
  if (attempt !== undefined && attempt.taskId === taskId) {
    const tip = await resolveIntegrationTip(integrationWorktreeCwd, runId, git);
    if (tip === undefined) {
      return 'merging';
    }
    if (tip === attempt.candidateSha) {
      return 'done';
    }
    return (await isAncestor(integrationWorktreeCwd, attempt.sourceSha, tip, git)) === true
      ? 'done'
      : 'merging';
  }

  const log = await git.run(['log', '--format=%s'], integrationWorktreeCwd);
  if (log.code !== 0) {
    return 'merging';
  }
  const pattern = buildMergeCommitSubjectPattern(runId);
  const found = log.stdout
    .split(/\r?\n/u)
    .some((line) => extractMergedTaskId(line, pattern) === taskId);
  return found ? 'done' : 'merging';
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
    'HEADは統合ブランチの先頭から切り離した（detached）状態です。ブランチの切り替え・作成・resetはせず、この状態のまま解決のコミットを作ってください（統合ブランチへの反映は拡張機能が行います）。',
    '',
    '# 未解決のパス',
  );
  for (const p of unresolvedPaths) {
    lines.push(`- ${p}`);
  }
  lines.push(
    '',
    `# タスク「${target.id}」（今回マージしようとしたタスク）`,
    `prompt: ${target.prompt}`,
    `done: ${target.done}`,
  );
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
 * マージコミットのsubjectから`taskId`を取り出す正規表現を組み立てる。`mergeCommitMessage`が
 * 生成する現行形（`<type>(<taskId>): merge task (run <runId>)`）に加え、以前の固定文言
 * （`Merge task <taskId> (run <runId>)`）にも一致させる。**呼び出し側は必ず`runIdError`で
 * 検証を通してから呼ぶこと（fail-closed）。** ここで改めて検証するのは、`findTaskIdsMergedSince`
 * のように既に検証済みの呼び出し元だけでなく、将来この関数が別の経路から呼ばれた場合にも
 * 規律だけに頼らず安全側で止めるため（レビュー指摘）。
 *
 * 旧形式を受け付けるのは、アップグレードを跨いで実行中のrun（統合ブランチに旧バージョンの
 * 拡張機能が作った旧形式のマージコミットが既にある）を、この変更を含む新バージョンで
 * リロードしても壊さないため。
 *
 * `<type>`は`normalizeCommitType`が返す`COMMIT_TYPES`のいずれか（英数字のみで regexの
 * メタ文字を含まない）に固定し、`runId`は呼び出し側が`runIdError`で検証済み（UUID形式。
 * 16進数とハイフンのみ）のため、そのまま正規表現へ埋め込んでも意図しないパターンには
 * ならない。`taskId`部分は貪欲すぎない`[^()]+`で受け、`TASK_ID_PATTERN`で改めて検証する
 * （字種が想定と違うものを拾わないための二重チェック）。新形式・旧形式のどちらにマッチ
 * したかで名前付きキャプチャ（`newId` / `oldId`）を分け、`extractMergedTaskId`が両方を見る。
 */
function buildMergeCommitSubjectPattern(runId: string): RegExp {
  const message = runIdError(runId);
  if (message !== undefined) {
    throw new Error(message);
  }
  const types = COMMIT_TYPES.join('|');
  return new RegExp(
    `^(?:(?:${types})\\((?<newId>[^()]+)\\): merge task \\(run ${runId}\\)` +
      `|Merge task (?<oldId>[^()]+) \\(run ${runId}\\))$`,
    'u',
  );
}

/**
 * マージコミットのsubject1行から`taskId`を取り出す。`buildMergeCommitSubjectPattern`が
 * 生成する正規表現を1回適用し、新形式・旧形式どちらの名前付きキャプチャにもマッチしなければ
 * `undefined`。取り出せた値は`TASK_ID_PATTERN`で再検証する（字種が想定と違うものを
 * 拾わないための二重チェック。`buildMergeCommitSubjectPattern`のJSDoc参照）。
 */
function extractMergedTaskId(subject: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(subject);
  const id = match?.groups?.['newId'] ?? match?.groups?.['oldId'];
  return id !== undefined && TASK_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * `sinceCommit`（対象タスクのブランチの分岐元）から統合ブランチの現在のHEADまでの間に
 * マージされたタスクidの一覧を、マージコミットの固定文言（`mergeCommitMessage`）から
 * 逆算する。衝突解決プロンプトの「突き合わせる」相手を特定するために使う
 * （`buildMergeResolutionPrompt`の`others`）。
 *
 * `mergeCommitMessage`は`type`（省略時`chore`）を先頭に持つ形（`<type>(<taskId>): merge
 * task (run <runId>)`）を生成するため、ここでの逆算も同じ形に一致させる
 * （`buildMergeCommitSubjectPattern`）。マージ時に渡した`type`が何であっても、
 * `COMMIT_TYPES`のいずれかである限り拾える。**以前の固定文言
 * （`Merge task <taskId> (run <runId>)`）のマージコミットも拾う**（アップグレードを
 * 跨いだrunで、衝突解決プロンプトの「突き合わせる」相手（旧形式でマージ済みのタスク）を
 * 取りこぼさないため）。
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
  const pattern = buildMergeCommitSubjectPattern(runId);
  const ids: string[] = [];
  for (const line of log.stdout.split(/\r?\n/u)) {
    const id = extractMergedTaskId(line, pattern);
    if (id !== undefined && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 衝突解決セッションが「完了」を宣言した際、実際に解決されコミット済みかを
 * `git status`相当のコマンドで確かめる（design.md §16.17「コンフリクト」4.
 * 「宣言だけを信じず`git status`でも確かめる」）。
 *
 * 次の4つを全て満たすときだけ`true`。
 *
 * 1. 未解決パス（`git diff --diff-filter=U`）が無い
 * 2. マージが進行中でない（`MERGE_HEAD`が存在しない＝解決コミットが済んでいる）
 * 3. 作業ツリーに未コミットの変更が残っていない（`git status --porcelain -uno`）
 * 4. タスクブランチのcommitが統合先のHEADから到達できる（`git merge-base --is-ancestor`）
 *
 * **1と2だけでは`git merge --abort`や`git reset`でマージを取り消した状態と区別できない**
 * （どちらも未解決0件・`MERGE_HEAD`なしになる）。取り消したまま`done`を宣言されると、
 * 成果が統合されていないのに「解決済み」として後続へ進んでいた（Issue #1111）。取込みの
 * 有無そのものを見る4を足して区別する。3は、解決の編集が未コミットのまま残っている状態を
 * 「取り込み済み」と読み違えないため（未追跡ファイルは対象外。統合worktreeにはビルド生成物が
 * 置かれうるため、それで完了を否定しない）。
 *
 * `MERGE_HEAD`の問い合わせが**エラーで**落ちた場合（非0かつstderrあり）は「不在」ではなく
 * 「不明」として`false`にする。`-q --verify`は不在のとき何も出力せず終了コードだけで返すため、
 * stderrがある非0はコマンド自体の異常（壊れたworktree等）である。
 *
 * `taskBranch`は`git merge-base --is-ancestor <taskBranch> HEAD`の位置引数として渡すため、
 * `isValidTaskBranch`でこのrunのタスクブランチの形であることを先に確かめる（`-`始まりの
 * 文字列がフラグとして解釈されるのを防ぐ、`mergeTaskBranch`と同じ理由の防御）。
 */
export async function isMergeResolutionComplete(
  integrationWorktreeCwd: string,
  git: GitCommandRunner,
  target: { runId: string; taskBranch: string },
): Promise<boolean> {
  if (!isValidTaskBranch(target.taskBranch, target.runId)) {
    return false;
  }
  const unresolved = await git.run(
    ['diff', '--name-only', '--diff-filter=U'],
    integrationWorktreeCwd,
  );
  if (unresolved.code !== 0 || unresolved.stdout.trim() !== '') {
    return false;
  }
  const mergeHead = await git.run(
    ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
    integrationWorktreeCwd,
  );
  // MERGE_HEADの解決に成功する（code 0）ということは、まだマージ進行中（未コミット）。
  // 不在は終了コード1で返る。それ以外（128など）はコマンド自体の異常なので「不明」として
  // 完了扱いにしない。stderrの有無では判定しない（`nodeGitCommandRunner`は非0終了で
  // stderrが空だと例外の文言を詰めるため、不在まで「不明」になり解決が完了しなくなる）
  if (mergeHead.code !== 1) {
    return false;
  }
  const status = await git.run(['status', '--porcelain', '-uno'], integrationWorktreeCwd);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return false;
  }
  const merged = await git.run(
    ['merge-base', '--is-ancestor', target.taskBranch, 'HEAD'],
    integrationWorktreeCwd,
  );
  return merged.code === 0;
}
