import { isPathWithinRoot, type TaskBoundary } from './escalation';
import { resolveTaskBranchOrigin } from './integration';
import {
  cloneWorkspace,
  diffSnapshots,
  ensureIntegrationDir,
  reflectIntegrationToWorkspace,
  takeSnapshot,
  IntegrationQueue as PseudoWorktreeIntegrationQueue,
  type Snapshot,
} from './pseudoWorktree';
import { markMergeBlocked, markMergeFailed, markMergeSucceeded } from './runState';
import { issue, type LiveRun, type LiveTask } from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';
import { sanitizeForLog } from './sanitize';
import { buildTaskBoundary, decideWorkingDirectory } from './worktree';
import type { WorkflowDefinition, WorkflowIssue, WorkflowTask } from './workflow';

/**
 * 作業ディレクトリの解決と疑似worktree統合（design.md §16.6・§16.20、Issue #147）を
 * 集めたモジュール。`WorkflowRunner`から機能単位で切り出した1本。
 *
 * `self: WorkflowRunnerInternals`を第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に
 * 切り出したままの形を保ち、挙動を変えないため（最終報告に記載）。
 */

/**
 * `cwd` を実パス解決し、`repoRoot` の実パス配下にあるか確かめる。
 *
 * cwdを無検証で通すと、`sandbox: workspace-write` の「workspace」の基準そのものを
 * YAMLから付け替えられる（例: cwdに `~/.ssh` を指定すれば、そこが書き込み可能な領域に
 * なる）。design.md §16.16 が塞ぐと決めている経路。`workflow.ts` の検証は実パス解決を
 * 伴わないためこの判定ができず、実行層の責務になる。
 */
async function resolveExplicitCwd(
  self: WorkflowRunnerInternals,
  cwd: string,
  repoRoot: string,
): Promise<{ ok: true; resolved: string } | { ok: false; message: string }> {
  const resolvedCwd = await self.deps.fs.realpath(cwd);
  if (resolvedCwd === undefined) {
    return { ok: false, message: `cwdを解決できませんでした: ${cwd}` };
  }
  // 境界側も実パスに直してから比べる。シンボリックリンク越しに外へ出るのを防ぐ
  const resolvedRoot = (await self.deps.fs.realpath(repoRoot)) ?? repoRoot;
  if (!isPathWithinRoot(resolvedCwd, resolvedRoot)) {
    return {
      ok: false,
      message: `cwdがワークスペースの外を指しています（design.md §16.16）: ${cwd}`,
    };
  }
  return { ok: true, resolved: resolvedCwd };
}

/**
 * 全タスクの明示`cwd`を実行開始前に一括で検証する（design.md §16.2「1件でも該当すれば
 * 実行を始めない」）。タスクごと（`startTask`内）の事後検証だけだと、正当なcwdの
 * タスクが先に開始・副作用を残した後で別タスクの違反が判明しうる
 * （レビュー指摘: warning）。
 */
export async function validateExplicitCwds(
  self: WorkflowRunnerInternals,
  def: WorkflowDefinition,
  repoRoot: string,
): Promise<WorkflowIssue[]> {
  const errors: WorkflowIssue[] = [];
  for (const task of def.tasks) {
    if (task.cwd === undefined) {
      continue;
    }
    const resolved = await resolveExplicitCwd(self, task.cwd, repoRoot);
    if (!resolved.ok) {
      errors.push(issue(resolved.message, [task.id]));
    }
  }
  return errors;
}

interface WorkingDirectoryResolution {
  cwd: string;
  branch: string;
  usedWorktree: boolean;
  usedPseudoWorktree: boolean;
  pseudoSnapshot: Snapshot | undefined;
  originCommit: string;
}

export async function resolveWorkingDirectory(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
  retry: number | undefined,
): Promise<WorkingDirectoryResolution> {
  const decision = decideWorkingDirectory(task, live.gitRepo);
  if (decision.kind === 'explicitCwd') {
    return resolveExplicitCwdWorkingDirectory(self, live, task);
  }
  if (decision.kind === 'shared') {
    return {
      cwd: live.repoRoot,
      branch: '',
      usedWorktree: false,
      usedPseudoWorktree: false,
      pseudoSnapshot: undefined,
      originCommit: '',
    };
  }
  if (decision.kind === 'sharedFallback') {
    return resolveSharedFallbackWorkingDirectory(self, live, task, decision.warning);
  }
  if (decision.kind === 'error') {
    throw new Error(decision.message);
  }
  return resolveWorktreeWorkingDirectory(self, live, task, retry);
}

async function resolveExplicitCwdWorkingDirectory(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
): Promise<WorkingDirectoryResolution> {
  // decision.kind==='explicitCwd'はtask.cwdが設定されている場合にしか出ない
  // （decideWorkingDirectoryの実装参照）。ここで無いのは呼び出し元の不整合
  if (task.cwd === undefined) {
    throw new Error('内部矛盾: explicitCwdの判定なのにcwdが無いタスクです');
  }
  // 実行開始時（start()）の一括検証を必ず通っている前提だが、念のためここでも確かめる
  // （多層防御。呼び出し順序の変更などで一括検証が経由されなくても危険側に倒れない）
  const resolved = await resolveExplicitCwd(self, task.cwd, live.repoRoot);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  return {
    cwd: resolved.resolved,
    branch: '',
    usedWorktree: false,
    usedPseudoWorktree: false,
    pseudoSnapshot: undefined,
    originCommit: '',
  };
}

async function resolveSharedFallbackWorkingDirectory(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
  warning: string,
): Promise<WorkingDirectoryResolution> {
  self.deps.log.warn(`[workflow ${live.runId}/${task.id}] ${warning}`);
  live.warnings.push({ kind: 'gitFallback', taskId: task.id, message: warning });
  // 疑似worktree（design.md §16.20、Issue #105）。`WorkflowRunnerDeps.pseudoWorktree`が
  // 渡されていない場合は、従来どおりワークスペース直下を共有する（後方互換）
  if (live.pseudo !== undefined && self.deps.pseudoWorktree !== undefined) {
    const cloned = await cloneWorkspace(
      live.repoRoot,
      live.runId,
      task.id,
      live.pseudo.exclude,
      self.deps.pseudoWorktree.fs,
    );
    if (!cloned.ok) {
      throw new Error(`疑似worktreeの作成に失敗しました: ${cloned.message}`);
    }
    return {
      cwd: cloned.cwd,
      branch: '',
      usedWorktree: false,
      usedPseudoWorktree: true,
      pseudoSnapshot: cloned.snapshot,
      originCommit: '',
    };
  }
  return {
    cwd: live.repoRoot,
    branch: '',
    usedWorktree: false,
    usedPseudoWorktree: false,
    pseudoSnapshot: undefined,
    originCommit: '',
  };
}

async function resolveWorktreeWorkingDirectory(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
  retry: number | undefined,
): Promise<WorkingDirectoryResolution> {
  // タスクブランチの分岐元は「そのタスクを開始する時点の統合ブランチのHEAD」
  // （design.md §16.17「タスクブランチの分岐元」。現行の「実行開始時のHEAD」から変更）。
  // 統合worktreeが無い（gitRepoでない）ケースは`decideWorkingDirectory`が`shared`/
  // `sharedFallback`/`error`のいずれかへ倒すため、ここへは来ない
  if (live.integration === undefined) {
    throw new Error('内部矛盾: 統合worktreeが無い状態でworktree隔離のタスクを開始しようとしました');
  }
  const originCommit = await resolveTaskBranchOrigin(live.repoRoot, live.runId, self.deps.git);
  if (originCommit === undefined) {
    throw new Error('統合ブランチのHEADコミットを解決できませんでした');
  }

  const result = await self.deps.worktreeQueue.create(
    {
      repoRoot: live.repoRoot,
      runId: live.runId,
      taskId: task.id,
      headCommit: originCommit,
      retry,
      // ブランチの命名方式（design.md §16.6「ブランチの命名方式」）。`live.branchNaming`が
      // `wf`、または対応する`issue`が無いタスクは、`branchName`自身の判定により
      // 従来どおり`wf/<runId>/<taskId>`へ落ちる（`BranchNamingOptions`のJSDoc参照）
      branchNaming: { naming: live.branchNaming, type: task.type, issue: task.issue },
    },
    self.deps.git,
    self.deps.fs,
  );
  if (!result.ok) {
    throw new Error(`worktreeの作成に失敗しました: ${result.message}`);
  }
  return {
    cwd: result.cwd,
    branch: result.branch,
    usedWorktree: true,
    usedPseudoWorktree: false,
    pseudoSnapshot: undefined,
    originCommit,
  };
}

// ---- 疑似worktree（design.md §16.20、Issue #105） ----

/**
 * gitでないワークスペースでの統合先（`<runId>/_integration`）を用意する
 * （`integration.ts`のgit版と対称の役割）。`WorkflowRunnerDeps.pseudoWorktree`が
 * 渡されていなければ何もせず`state: undefined`を返す（後方互換。上のJSDoc参照）。
 */
export async function resolvePseudoState(
  self: WorkflowRunnerInternals,
  repoRoot: string,
  runId: string,
): Promise<{ ok: true; state: LiveRun['pseudo'] } | { ok: false; message: string }> {
  const deps = self.deps.pseudoWorktree;
  if (deps === undefined) {
    return { ok: true, state: undefined };
  }
  const ensured = await ensureIntegrationDir(repoRoot, runId, deps.fs);
  if (!ensured.ok) {
    return { ok: false, message: ensured.message };
  }
  const baseline = await takeSnapshot(repoRoot, deps.exclude, deps.fs);
  return {
    ok: true,
    state: {
      integrationDir: ensured.dir,
      queue: new PseudoWorktreeIntegrationQueue(),
      baseline,
      exclude: deps.exclude,
    },
  };
}

/**
 * タスク1件分の疑似worktreeを統合先へ適用する（design.md §16.20。gitの`attemptMerge`と
 * 対称の役割）。3-way mergeはできないため、同じパスへの変更が複数タスクにまたがれば
 * 内容を見ずに衝突として扱う（design.md「内容の突き合わせは行わず...」）。
 *
 * **衝突解決セッションは開かない。** design.md §16.17の衝突解決セッションは統合worktree
 * （gitの仕組み）を前提にしており、疑似worktree向けに作り直すのはこのIssueの範囲外
 * （Issue #105の配線対象は「decideWorkingDirectoryのgit外フォールバックから繋ぐ」
 * 「runの終了時にワークスペースへ反映する」の2点。最終報告に安全側の判断として記載）。
 * 衝突したタスクは`blocked`にし、独立した枝は走り続ける（`markMergeBlocked`と同じ扱い）。
 */
export async function integratePseudoWorktree(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  pseudo: NonNullable<LiveRun['pseudo']>,
  liveTask: LiveTask,
): Promise<void> {
  const live = self.runs.get(runId);
  const deps = self.deps.pseudoWorktree;
  if (live === undefined || deps === undefined) {
    return;
  }
  try {
    const currentSnapshot = await takeSnapshot(liveTask.cwd, pseudo.exclude, deps.fs);
    const diff = diffSnapshots(liveTask.pseudoSnapshot ?? new Map(), currentSnapshot);
    const plan = await pseudo.queue.integrate(
      taskId,
      liveTask.cwd,
      pseudo.integrationDir,
      diff,
      deps.fs,
    );

    if (plan.conflicts.length > 0) {
      const paths = plan.conflicts.map((c) => c.path).join(', ');
      self.deps.log.warn(
        `[workflow ${runId}/${taskId}] 疑似worktreeの統合が衝突しました（3-way mergeができないため）: ${paths}`,
      );
      live.warnings.push({
        kind: 'pseudoWorktreeConflict',
        taskId,
        message: `疑似worktreeの統合が衝突しました: ${paths}`,
      });
      live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    } else {
      live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
    }
  } catch (e) {
    // `pseudoWorktree.ts`のポートメソッド（`fs.mkdir`/`fs.copyFile`等）はEACCES/ENOSPC等を
    // 素通しでthrowする（他のポートメソッドと違いcatchしない実装）。ここで受け止めないと
    // `void integratePseudoWorktree(...)`（呼び出し元）が未ハンドルrejectになり、タスクが
    // `merging`のまま永久に枠を占有する（Issue #364）。gitの`attemptMerge`が
    // その他の失敗を`markMergeFailed`に落とすのと同じ扱いにする
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 疑似worktreeの統合に失敗しました: ${message}`,
    );
    live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
  }
  void self.persist(runId);
  self.notify(runId);
  self.pump(runId);
}

/**
 * runの終了時、疑似worktreeの統合先の内容をワークスペースへ反映する
 * （design.md §16.20「runが終わったら、統合先の内容をワークスペースへ反映する」）。
 * `pump()`が`outcome !== 'running'`を検出した回だけ、成功/失敗を問わず呼ぶ
 * （gitの`finalizeForge`が`succeeded`限定なのとは異なる。§16.20はrunの結果を条件に
 * していないため、それまでに統合できた分は反映する）。
 *
 * 反映前にワークスペース側の変更を検知したら、反映せず警告を残す
 * （design.md「人の編集を上書きしない」。`reflectIntegrationToWorkspace`自身が判定する）。
 */
export async function reflectPseudoWorktree(
  self: WorkflowRunnerInternals,
  runId: string,
): Promise<void> {
  const live = self.runs.get(runId);
  const deps = self.deps.pseudoWorktree;
  if (live === undefined || live.pseudo === undefined || deps === undefined) {
    return;
  }
  try {
    const result = await reflectIntegrationToWorkspace(
      live.repoRoot,
      live.pseudo.integrationDir,
      live.pseudo.baseline,
      live.pseudo.queue.getManifest(),
      live.pseudo.exclude,
      deps.fs,
    );
    if (!result.ok) {
      self.deps.log.warn(`[workflow ${runId}] ${result.message}`);
      live.warnings.push({
        kind: 'pseudoWorktreeReflectBlocked',
        taskId: undefined,
        message: `${result.message}（変更されたパス: ${result.changedPaths.join(', ')}）`,
      });
    } else {
      self.deps.log.info(
        `[workflow ${runId}] 疑似worktreeの統合結果をワークスペースへ反映しました（${result.appliedPaths.length}件）`,
      );
    }
  } catch (e) {
    // `reflectIntegrationToWorkspace`が呼ぶ`fs.copyFile`/`fs.removeFile`もEACCES/ENOSPC等を
    // 素通しでthrowしうる。ここはrun終了処理の途中（`pump()`から呼ばれる）で、ここで
    // 例外を投げ直すとその後の後始末が中断してしまうため、警告としてログ・`live.warnings`へ
    // 記録するだけに留める（Issue #364）
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.warn(
      `[workflow ${runId}] 疑似worktreeの統合結果のワークスペースへの反映に失敗しました: ${message}`,
    );
    live.warnings.push({
      kind: 'pseudoWorktreeReflectBlocked',
      taskId: undefined,
      message: `疑似worktreeの統合結果のワークスペースへの反映に失敗しました: ${message}`,
    });
  }
  self.notify(runId);
}

export async function buildBoundary(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  cwd: string,
): Promise<{ boundary: TaskBoundary; warning: string | undefined }> {
  const result = await buildTaskBoundary([cwd], live.repoRoot, self.deps.git, self.deps.fs);
  return { boundary: result.boundary, warning: result.gitCommonDirWarning };
}
