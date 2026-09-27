import { closePullRequestWithoutMerge, type CliCommandRunner, type ForgeHost } from './forge';
import { cleanupMergedBranch, type CleanupMergedBranchDeps } from './mergeLanes';
import type { OrchestratedTask } from './taskRunState';

/**
 * オーケストレータモード（Issue #1505）のタスク後片付け。
 *
 * `cleanupAfterMerge`はmergeCleanupの工程が終わったあとの後片付け。工程セッションはmergeと
 * リモートブランチの削除までを行い、worktree・ローカルのブランチ・メインのworking treeは
 * Controllerが片付ける（セッションが自分の作業ディレクトリを消さないように）。
 *
 * `cleanupRetiredTask`は計画から外れた・既存Issueの付け替えで作り直された着手済みタスクの
 * 後片付け（Issue #1619）。mergeを経ていないため、メインのworking treeへの反映
 * （`fetch`/`pull`）は行わない。
 */

export type StageCleanupDeps = CleanupMergedBranchDeps;

export type StageCleanupResult =
  | { ok: true; warnings: readonly string[] }
  | { ok: false; message: string; warnings: readonly string[] };

export async function cleanupAfterMerge(
  deps: StageCleanupDeps,
  request: { repoRoot: string; runId: string; task: OrchestratedTask },
): Promise<StageCleanupResult> {
  const { repoRoot, runId, task } = request;
  const cleaned = await cleanupMergedBranch(deps, {
    repoRoot,
    runId,
    worktreeTaskId: task.taskId,
    branch: task.branch,
    worktreePath: task.worktreePath,
    // 工程セッションが消し損ねていても、mergeを確かめた後なので消してよい
    deleteRemoteBranch: true,
  });
  if (!cleaned.ok) {
    return cleaned;
  }
  const warnings = [...cleaned.warnings];
  // `--prune`は付けない（resolveRoadmapBaseCommitと同じ理由）
  const fetched = await deps.git.run(['fetch', 'origin'], repoRoot);
  if (fetched.code !== 0) {
    warnings.push(`git fetch originに失敗しました: ${fetched.stderr.trim()}`);
  } else {
    const pulled = await deps.git.run(['pull', '--ff-only'], repoRoot);
    if (pulled.code !== 0) {
      warnings.push(
        `メインのworking treeをgit pull --ff-onlyで進められませんでした: ${pulled.stderr.trim()}`,
      );
    }
  }
  return { ok: true, warnings };
}

export interface RetiredTaskCleanupDeps extends CleanupMergedBranchDeps {
  cli: CliCommandRunner;
}

export type RetiredTaskCleanupResult =
  | { ok: true; warnings: readonly string[]; closedPullRequest: number | undefined }
  | { ok: false; message: string; warnings: readonly string[]; closedPullRequest: number | undefined };

export async function cleanupRetiredTask(
  deps: RetiredTaskCleanupDeps,
  request: {
    repoRoot: string;
    runId: string;
    task: OrchestratedTask;
    host: ForgeHost | undefined;
  },
): Promise<RetiredTaskCleanupResult> {
  const { repoRoot, runId, task, host } = request;
  const warnings: string[] = [];
  let closedPullRequest: number | undefined;
  if (task.pullRequest !== undefined) {
    if (host === undefined) {
      warnings.push(
        `PR #${String(task.pullRequest.number)}を閉じられませんでした: ホストを判定できませんでした`,
      );
    } else {
      const closed = await closePullRequestWithoutMerge(
        deps.cli,
        host,
        repoRoot,
        task.pullRequest.number,
      );
      if (closed.ok) {
        closedPullRequest = task.pullRequest.number;
      } else {
        warnings.push(`PR #${String(task.pullRequest.number)}を閉じられませんでした: ${closed.message}`);
      }
    }
  }
  const cleaned = await cleanupMergedBranch(deps, {
    repoRoot,
    runId,
    worktreeTaskId: task.taskId,
    branch: task.branch,
    worktreePath: task.worktreePath,
    // 工程セッションが消し損ねていても、セッションは既に止めた後なので消してよい
    deleteRemoteBranch: true,
  });
  warnings.push(...cleaned.warnings);
  return cleaned.ok
    ? { ok: true, warnings, closedPullRequest }
    : { ok: false, message: cleaned.message, warnings, closedPullRequest };
}
