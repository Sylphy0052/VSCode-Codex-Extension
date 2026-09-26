import { cleanupMergedBranch, type CleanupMergedBranchDeps } from './mergeLanes';
import type { OrchestratedTask } from './taskRunState';

/**
 * オーケストレータモード（Issue #1505）のmergeCleanupの工程が終わったあとの後片付け。
 * 工程セッションはmergeとリモートブランチの削除までを行い、worktree・ローカルのブランチ・
 * メインのworking treeはControllerが片付ける（セッションが自分の作業ディレクトリを消さないように）。
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
