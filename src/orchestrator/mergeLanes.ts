/**
 * 並列に進むrunのmergeと後片付けの共通部品。ロードマップ実行（Issue #1465、
 * `roadmapMergeQueue.ts`）とオーケストレータモード（Issue #1505）が共通で使う。
 *
 * - `MergeLanes`: リポジトリごとの鍵。同じリポジトリのmergeは別runでも1件ずつにする。
 *   並行するPRが同じ版番号へ上がるのを防ぐため
 * - `confirmPullRequestMerged`: mergeがリモートへ反映されたかを間隔を伸ばしながら確かめる
 * - `cleanupMergedBranch`: リモートのブランチ・worktree・ローカルのブランチを消す
 */

import type { GitCommandRunner, WorktreeCreationQueue, WorktreeFileSystemPort } from './worktree';
import { SerialQueue } from './serialQueue';

/**
 * merge後、リモートでmerge済みになったかを確かめる回数と間隔（issue #1487）。mergeコマンドは
 * 成功していてAPIの反映が遅いだけのことがあるため、間隔を3秒から倍々に伸ばし（上限30秒）、
 * 合計約105秒確かめる。その間は同じリポジトリの次のmergeも待つ。
 */
const MERGE_CONFIRM_ATTEMPTS = 7;
const MERGE_CONFIRM_BASE_INTERVAL_MS = 3_000;
const MERGE_CONFIRM_MAX_INTERVAL_MS = 30_000;
/** gitの引数へ渡してよいブランチ名。 */
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export function isSafeBranchName(branch: string): boolean {
  return SAFE_BRANCH.test(branch) && !branch.startsWith('-');
}

export class MergeLanes {
  /** リポジトリごとの列。 */
  private readonly lanes = new Map<string, SerialQueue>();
  /** 列に並んでいる・処理中の項目。 */
  private readonly queued = new Set<string>();

  /**
   * `laneKey`（リポジトリ）の列へ`task`を積む。同じ`itemKey`が列に並んでいる・処理中なら
   * 積まずに`undefined`を返す。
   */
  enqueue<T>(laneKey: string, itemKey: string, task: () => Promise<T>): Promise<T> | undefined {
    if (this.queued.has(itemKey)) {
      return undefined;
    }
    this.queued.add(itemKey);
    let lane = this.lanes.get(laneKey);
    if (lane === undefined) {
      lane = new SerialQueue();
      this.lanes.set(laneKey, lane);
    }
    return lane.enqueue(async () => {
      try {
        return await task();
      } finally {
        this.queued.delete(itemKey);
      }
    });
  }
}

/**
 * PRがリモートでmerge済みになったかを確かめる。確かめられた時点で`true`、回数を
 * 使い切ったら`false`。
 */
export async function confirmPullRequestMerged(
  isMerged: () => Promise<boolean | undefined>,
  wait: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < MERGE_CONFIRM_ATTEMPTS; i += 1) {
    if ((await isMerged()) === true) {
      return true;
    }
    if (i < MERGE_CONFIRM_ATTEMPTS - 1) {
      await wait(Math.min(MERGE_CONFIRM_BASE_INTERVAL_MS * 2 ** i, MERGE_CONFIRM_MAX_INTERVAL_MS));
    }
  }
  return false;
}

export interface CleanupMergedBranchDeps {
  git: GitCommandRunner;
  fs: WorktreeFileSystemPort;
  worktreeQueue: WorktreeCreationQueue;
}

export interface CleanupMergedBranchRequest {
  repoRoot: string;
  runId: string;
  /** worktreeの場所を決める識別子（`WorktreeCreationQueue.remove`の`taskId`）。 */
  worktreeTaskId: string;
  branch: string | undefined;
  worktreePath: string | undefined;
  /** リモートのブランチも消す。消すのを工程セッションに任せる場合は`false`。 */
  deleteRemoteBranch: boolean;
}

export type CleanupMergedBranchResult =
  /** `warnings`は後片付けを止めるほどではない失敗（ブランチを消せなかった等）。 */
  | { ok: true; warnings: readonly string[] }
  /** worktreeを撤去できなかった。ローカルのブランチは消していない。 */
  | { ok: false; message: string; warnings: readonly string[] };

/**
 * merge後の後片付け。リモートのブランチ（`deleteRemoteBranch`のとき）・worktree・
 * ローカルのブランチの順に消す。扱えない名前のブランチは消さない。
 */
export async function cleanupMergedBranch(
  deps: CleanupMergedBranchDeps,
  request: CleanupMergedBranchRequest,
): Promise<CleanupMergedBranchResult> {
  const { repoRoot: root, branch } = request;
  const warnings: string[] = [];
  const git = async (
    args: readonly string[],
  ): Promise<{ ok: boolean; stdout: string; message: string }> => {
    const result = await deps.git.run(args, root);
    const detail = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      message: `git ${args.join(' ')} に失敗しました（終了コード ${String(result.code)}）: ${detail}`,
    };
  };
  const safeBranch = branch !== undefined && isSafeBranchName(branch);
  if (safeBranch && request.deleteRemoteBranch) {
    const ref = `refs/heads/${branch}`;
    const remote = await git(['ls-remote', '--heads', 'origin', ref]);
    if (remote.ok && remote.stdout.trim() !== '') {
      const deleted = await git(['push', 'origin', '--delete', ref]);
      if (!deleted.ok) {
        warnings.push(`リモートのブランチを消せませんでした: ${deleted.message}`);
      }
    }
  }
  if (request.worktreePath !== undefined && (await deps.fs.pathExists(request.worktreePath))) {
    const removed = await deps.worktreeQueue.remove(
      root,
      request.runId,
      request.worktreeTaskId,
      undefined,
      deps.git,
      deps.fs,
    );
    if (!removed.ok) {
      return { ok: false, message: `worktreeを撤去できませんでした: ${removed.message}`, warnings };
    }
  }
  if (safeBranch) {
    const local = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (local.ok) {
      const deleted = await git(['branch', '-D', branch]);
      if (!deleted.ok) {
        warnings.push(`ローカルのブランチを消せませんでした: ${deleted.message}`);
      }
    }
  }
  return { ok: true, warnings };
}
