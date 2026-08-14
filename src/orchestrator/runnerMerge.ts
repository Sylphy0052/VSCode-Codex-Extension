import type { LoopStopReason } from '../loop/loopController';
import {
  createPullRequest,
  buildTaskPullRequestBody,
  buildTaskPullRequestTitle,
  pushBranch,
  runTaskPullRequestFlow,
  shouldCreateTaskPullRequest,
  type TaskPullRequestFlowResult,
  type TaskPullRequestSteps,
} from './forge';
import {
  buildMergeResolutionPrompt,
  commitUncommittedChangesIfNeeded,
  findTaskIdsMergedSince,
  isMergeResolutionComplete,
  MERGE_RESOLUTION_CONDITION,
  MERGE_RESOLUTION_MAX_ITERATIONS,
  type MergeResolutionTaskInfo,
  type MergeTaskResult,
} from './integration';
import { sanitizeForLog } from './sanitize';
import { buildEffectiveTaskConfig } from './taskConfig';
import type { TaskSession } from './taskSession';
import { shouldRemoveWorktree } from './worktree';
import type { WorkflowTask } from './workflow';
import {
  applyLoopStopReason,
  markMergeBlocked,
  markMergeFailed,
  markMergeSucceeded,
  retryMergeState,
} from './runState';
import {
  parsePullRequestNumberFromUrl,
  retrySuffixOf,
  type LiveRun,
  type LiveTask,
  type PullRequestResult,
} from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * マージと衝突解決（design.md §16.17、Issue #147）を集めたモジュール。`WorkflowRunner`から
 * 機能単位で切り出した1本で、`WorktreeCreationQueue`を1つだけ使い回す不変条件
 * （`self.integrationQueue`。design.md §16.6・§16.17）は変えない。
 *
 * `self: WorkflowRunnerInternals`を第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に
 * 切り出したままの形を保ち、挙動を変えないため（最終報告に記載）。
 */

// ---- PR/MR作成（design.md §16.18） ----

/**
 * タスクのマージを試みる。PR/MRの作成が有効（`forge.kind === 'active'` かつ
 * `shouldCreateTaskPullRequest`）なら、design.mdが定める順序
 * （`runTaskPullRequestFlow`。push→push→create→merge+push）で行う。無効なら
 * 従来どおりローカルの統合worktreeへのマージだけを行う。
 *
 * PR/MRの作成（`pushTaskBranch`/`pushIntegrationBranch`/`createPullRequest`）が
 * 失敗しても、統合ブランチへのローカルのマージ（`mergeAndPushIntegration`）は必ず行う
 * （`runTaskPullRequestFlow`自身の保証。design.md §16.18「前提が欠けている場合」と同じ
 * 「ワークフロー自体は止めない」方針）。
 */
export async function mergeTaskWithForge(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  taskCwd: string,
  taskBranch: string,
): Promise<{ merge: MergeTaskResult; pullRequest: PullRequestResult | undefined }> {
  const forgeDeps = self.deps.forge;
  const forge = live.forge;
  if (
    forgeDeps === undefined ||
    forge.kind !== 'active' ||
    !shouldCreateTaskPullRequest(forge.pullRequest)
  ) {
    const merge = await self.integrationQueue.mergeTask(
      integration.cwd,
      runId,
      taskId,
      taskBranch,
      self.deps.git,
    );
    return { merge, pullRequest: undefined };
  }

  const flow = await runTaskPullRequestFlow(
    buildTaskPullRequestFlowCallbacks(
      self,
      live,
      runId,
      taskId,
      task,
      integration,
      taskCwd,
      taskBranch,
      forgeDeps,
      forge,
    ),
  );
  return finalizeTaskPullRequestFlow(self, live, runId, taskId, flow);
}

/**
 * `runTaskPullRequestFlow`（design.mdが定める順序。push→push→create→merge+push）へ渡す
 * 4つのコールバックを組み立てる。`mergeAndPushIntegration`はローカルのマージ後、統合
 * ブランチのpushにも失敗すれば警告を積む（`runTaskPullRequestFlow`自身の保証により、
 * PR/MRの作成が失敗してもこのマージ自体は必ず行われる）。
 */
function buildTaskPullRequestFlowCallbacks(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  taskCwd: string,
  taskBranch: string,
  forgeDeps: NonNullable<WorkflowRunnerInternals['deps']['forge']>,
  forge: Extract<LiveRun['forge'], { kind: 'active' }>,
): TaskPullRequestSteps<MergeTaskResult> {
  return {
    pushTaskBranch: () => pushBranch(self.deps.git, taskCwd, taskBranch),
    // 統合ブランチのpushはタスクごとに並列で走りうるため、worktreeの作成・撤去・マージと
    // 同じキュー（`IntegrationMergeQueue`）を経由させて直列化する（design.md §16.18・
    // Issue #253。同じ統合worktreeの同じブランチへの並行pushをリモートが
    // `cannot lock ref` で弾く事故対策）。直接`pushBranch`を呼ばない
    pushIntegrationBranch: () =>
      self.integrationQueue.pushIntegrationBranch(self.deps.git, integration.cwd, integration.branch),
    createPullRequest: () =>
      createPullRequest(
        { cli: forgeDeps.cli, fs: forgeDeps.fs },
        {
          host: forge.host,
          cwd: taskCwd,
          base: integration.branch,
          head: taskBranch,
          title: buildTaskPullRequestTitle(taskId, task.prompt),
          body: buildTaskPullRequestBody({
            prompt: task.prompt,
            done: task.done,
            runId,
            dependsOn: task.dependsOn,
            issue: task.issue,
          }),
        },
      ),
    mergeAndPushIntegration: async () => {
      const merged = await self.integrationQueue.mergeTask(
        integration.cwd,
        runId,
        taskId,
        taskBranch,
        self.deps.git,
      );
      if (merged.kind === 'success') {
        const push = await pushBranch(self.deps.git, integration.cwd, integration.branch);
        if (!push.ok) {
          self.deps.log.warn(
            `[workflow ${runId}/${taskId}] 統合ブランチのpushに失敗しました: ${push.message}`,
          );
          live.warnings.push({
            kind: 'forgeFailed',
            taskId,
            message: `統合ブランチのpushに失敗しました: ${push.message}`,
          });
        }
      }
      return merged;
    },
  };
}

/** `runTaskPullRequestFlow`の結果を警告・ログへ反映し、`mergeTaskWithForge`の戻り値へ整える。 */
function finalizeTaskPullRequestFlow(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  runId: string,
  taskId: string,
  flow: TaskPullRequestFlowResult<MergeTaskResult>,
): { merge: MergeTaskResult; pullRequest: PullRequestResult | undefined } {
  if (!flow.pullRequest.created) {
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] PR/MRの作成に失敗しました（${flow.pullRequest.stage}）: ${flow.pullRequest.message}`,
    );
    live.warnings.push({
      kind: 'forgeFailed',
      taskId,
      message: `PR/MRの作成に失敗しました（${flow.pullRequest.stage}）: ${flow.pullRequest.message}`,
    });
  } else if (flow.pullRequest.url !== undefined) {
    self.deps.log.info(
      `[workflow ${runId}/${taskId}] PR/MRを作成しました: ${flow.pullRequest.url}`,
    );
  }

  // design.md §16.11「タスクごとの...PR/MRの番号」・Issue #118。番号とURLだけを持ち帰る
  // （本文は持ち帰らない）。作成できていても`url`が無い（CLIの出力形式が想定外）場合は
  // 表示に使えないため記録しない（`else if`と同じ条件）
  const pullRequest: PullRequestResult | undefined =
    flow.pullRequest.created && flow.pullRequest.url !== undefined
      ? { number: parsePullRequestNumberFromUrl(flow.pullRequest.url), url: flow.pullRequest.url }
      : undefined;

  return { merge: flow.mergeOutcome, pullRequest };
}

// ---- マージ（design.md §16.17） ----

/**
 * タスクが`merging`になった直後に呼ぶ。未コミットの変更を回収してからマージを試みる。
 * `onTaskFinished`（通常経路）と`resumeMergeAfterReload`（リロード後の再開）の両方から
 * 呼ばれるため、`LiveTask`ではなくcwd/branch/originCommitを直接受け取る。
 */
export async function startMerge(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  taskCwd: string,
  taskBranch: string,
  originCommit: string,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  if (live.integration === undefined) {
    // 内部矛盾（usedWorktreeなタスクが走っている以上、start()が統合worktreeを
    // 作っているはず）。安全側でfailedにする
    self.deps.log.error(`[workflow ${runId}/${taskId}] 統合worktreeが無いためマージできません`);
    live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  // design.md §16.17「タスク完了時のコミット」2.〜4.
  const commitResult = await commitUncommittedChangesIfNeeded(taskCwd, taskId, self.deps.git);
  if (!commitResult.ok) {
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 未コミットの変更の回収に失敗しました: ${commitResult.message}`,
    );
    live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  await attemptMerge(self, runId, taskId, task, live.integration, taskCwd, taskBranch, originCommit);
}

/**
 * 統合worktreeへ実際にマージを試みる。成功なら`done`、衝突なら衝突解決セッションを
 * 起動、その他の失敗なら`failed`にする（design.md §16.17「マージ」）。
 *
 * PR/MRの作成（design.md §16.18）が有効なら、マージ自体も`mergeTaskWithForge`が
 * design.mdの定める順序で行う。
 */
async function attemptMerge(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  taskCwd: string,
  taskBranch: string,
  originCommit: string,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const { merge, pullRequest } = await mergeTaskWithForge(
    self,
    live,
    runId,
    taskId,
    task,
    integration,
    taskCwd,
    taskBranch,
  );

  // design.md §16.11「タスクごとの...PR/MRの番号」・Issue #118。PR/MRの作成はマージより
  // 前の手順（design.md §16.18「作る順序」）なので、マージが失敗・衝突した場合でも
  // 既に作られたPR/MRのリンクは書き込む。`live.tasks.get(taskId)`はリロード直後に
  // マージを再開した経路（`resumeMergeAfterReload`）では未定義になりうる
  // （このウィンドウでセッションを開いていないため）。その場合はこの1回分の結果を
  // 保持できないが、実行そのものは止めない（安全側）
  const liveTaskForPr = live.tasks.get(taskId);
  if (liveTaskForPr !== undefined && pullRequest !== undefined) {
    liveTaskForPr.pullRequest = pullRequest;
  }

  if (merge.kind === 'success') {
    live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
    // ラッパー（`WorkflowRunner`側のメソッド）を通す。テストが`prototype`をスパイして
    // 「interrupted/manualでは撤去しない」を確かめるため、モジュール関数を直接呼ばない
    // （PR #157のレビュー指摘。分割時にこの2経路だけラッパーを迂回していた）
    self.cleanupWorktreeIfNeeded(live, task, taskId, live.tasks.get(taskId));
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }
  if (merge.kind === 'failure') {
    self.deps.log.error(`[workflow ${runId}/${taskId}] マージに失敗しました: ${merge.message}`);
    live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  // 衝突。design.md §16.17「コンフリクト」1.「衝突した状態のままにしておく」
  void self.persist(runId);
  await startMergeResolution(self, runId, taskId, task, integration, merge, originCommit);
}

/**
 * 衝突解決セッションを開く（design.md §16.17「コンフリクト」3.）。衝突した状態の
 * 統合worktreeを`cwd`にし、未解決パスの一覧と、突き合わせる相手のタスクの`prompt`/`done`
 * をプロンプトに渡す。解決用セッションは依存グラフのノードにはしない（design.md
 * 「コンフリクト」5.）ため、`live.tasks`ではなく`live.mergeResolutions`で管理する。
 */
async function startMergeResolution(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  conflict: Extract<MergeTaskResult, { kind: 'conflict' }>,
  originCommit: string,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }

  const baseline = self.deps.readBaseline();
  const effective = buildEffectiveTaskConfig(task, baseline);
  // startTask()と同じ最終防御（レビュー指摘: critical 3参照）。衝突解決セッションも
  // 通常のタスクと同じループ制御・承認判定に従う（design.md §16.17「コンフリクト」5.）
  if (task.provider === 'claude' && effective.config.approvalMode === 'bypassPermissions') {
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 実効approvalModeがbypassPermissionsのため衝突解決セッションを開始できません`,
    );
    await abortAndBlock(self, runId, taskId, integration);
    return;
  }

  const otherIds =
    originCommit !== ''
      ? await findTaskIdsMergedSince(integration.cwd, runId, originCommit, self.deps.git)
      : [];
  const others: MergeResolutionTaskInfo[] = otherIds
    .filter((id) => id !== taskId)
    .map((id) => live.def.tasks.find((t) => t.id === id))
    .filter((t): t is WorkflowTask => t !== undefined)
    .map((t) => ({ id: t.id, prompt: t.prompt, done: t.done }));

  const host = self.deps.hosts[task.provider];
  let session: TaskSession;
  try {
    session = await host.openTaskSession({
      cwd: integration.cwd,
      config: effective.config,
      sandbox: effective.sandbox,
    });
  } catch (e) {
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 衝突解決セッションを開始できませんでした: ${message}`,
    );
    await abortAndBlock(self, runId, taskId, integration);
    return;
  }
  session.open({ preserveFocus: true });
  live.mergeResolutions.set(taskId, session);

  const prompt = buildMergeResolutionPrompt(
    { id: taskId, prompt: task.prompt, done: task.done },
    others,
    conflict.unresolvedPaths,
  );

  // 衝突解決セッションの承認は、通常のタスクの`escalation.ts`（境界・allow/escalate）
  // ではなく、標準の承認カード（`setApprovalHandler`を設定しない既定挙動）へ委ねる。
  // タスク境界（`TaskBoundary`）は本来そのタスクのworktree用に作られたもので、統合
  // worktree（別ディレクトリ）向けに作り直すと境界判定の意味が変わってしまう。安全側
  // （常に人の承認を要求する）に倒すための単純化であり、最終報告に明記する
  session.onFinished((reason) => {
    void onMergeResolutionFinished(self, runId, taskId, task, integration, reason);
  });

  session.runLoop({
    initialPrompt: prompt,
    continuePrompt: `続けてください。終了条件: ${MERGE_RESOLUTION_CONDITION}`,
    maxIterations: MERGE_RESOLUTION_MAX_ITERATIONS,
    condition: MERGE_RESOLUTION_CONDITION,
  });
  self.notify(runId);
}

/** 衝突解決セッションの結果を受けて、`done`（解決済み）か`blocked`（未解決）かを確定する。 */
async function onMergeResolutionFinished(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  reason: LoopStopReason,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const session = live.mergeResolutions.get(taskId);
  live.mergeResolutions.delete(taskId);
  session?.dispose();

  if (reason === 'manual' || reason === 'interrupted') {
    // 人がタブへ直接介入した。通常のタスクと同じく、このタスク自身の状態は変えず
    // 実行全体だけを止める設計を踏襲する（design.md §16.5）
    live.runState = applyLoopStopReason(live.runState, live.def.tasks, '', reason);
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  // design.md §16.17「コンフリクト」4.「宣言だけを信じず`git status`でも確かめる」
  const resolved =
    reason === 'done' && (await isMergeResolutionComplete(integration.cwd, self.deps.git));
  if (resolved) {
    live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
    // ラッパー（`WorkflowRunner`側のメソッド）を通す。テストが`prototype`をスパイして
    // 「interrupted/manualでは撤去しない」を確かめるため、モジュール関数を直接呼ばない
    // （PR #157のレビュー指摘。分割時にこの2経路だけラッパーを迂回していた）
    self.cleanupWorktreeIfNeeded(live, task, taskId, live.tasks.get(taskId));
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  if (reason === 'done') {
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] 衝突解決セッションはdoneを宣言しましたが、git上は未解決のままでした`,
    );
  }
  await abortAndBlock(self, runId, taskId, integration);
}

/** マージを巻き戻して`blocked`に確定させる共通処理（design.md §16.17「コンフリクト」7.）。 */
async function abortAndBlock(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  integration: { cwd: string; branch: string },
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const abort = await self.integrationQueue.abortMerge(integration.cwd, self.deps.git);
  if (!abort.ok) {
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] マージの巻き戻しに失敗しました: ${abort.message}`,
    );
  }
  live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
  void self.persist(runId);
  self.notify(runId);
  self.pump(runId);
}

/**
 * `blocked`のタスクを再マージする（design.md §16.17「Viewから人が解決したうえで
 * 『再マージ』を指示できる」）。Viewからの呼び出しの配線は別Issue（このIssueは
 * `src/view/`を対象外にしている）だが、runner.ts側の入口はここに用意しておく。
 *
 * タスクのworktree・ブランチはこのウィンドウのライブなセッション（`live.tasks`）が
 * あればそれを、無ければ永続化された値（リロード後、まだ再実行していない場合）を使う。
 */
export function retryMerge(self: WorkflowRunnerInternals, runId: string, taskId: string): boolean {
  const live = self.runs.get(runId);
  if (live === undefined || live.integration === undefined) {
    return false;
  }
  const task = live.def.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    return false;
  }
  const liveTask = live.tasks.get(taskId);
  const persistedTask = self.deps.store.find(runId)?.tasks[taskId];
  const branch = liveTask?.branch ?? persistedTask?.branch;
  const cwd = liveTask?.cwd ?? persistedTask?.cwd;
  if (branch === undefined || branch === '' || cwd === undefined) {
    return false;
  }
  const next = retryMergeState(live.runState, taskId);
  if (next === live.runState) {
    return false;
  }
  live.runState = next;
  // `pump()`は`live.finished`が立っていると即座に戻ってしまう（design.md §16.5の終了判定を
  // 一度確定させたら動かさない設計）。`blocked`はrunの終了判定（`getRunOutcome`）を`running`
  // 以外へ倒すため、`retryTask`（手動の再実行）が同じ理由で`finished`を解除しているのと
  // 同様、ここでも再開の起点として明示的に解除する
  live.finished = false;
  void self.persist(runId);
  self.notify(runId);
  void startMerge(self, runId, taskId, task, cwd, branch, liveTask?.originCommit ?? '');
  return true;
}

export function cleanupWorktreeIfNeeded(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
  taskId: string,
  liveTask: LiveTask | undefined,
): void {
  if (liveTask === undefined || !liveTask.usedWorktree) {
    return;
  }
  const finalState = live.runState.tasks.get(taskId)?.state;
  if (finalState === undefined || !shouldRemoveWorktree(task.cleanup, finalState)) {
    return;
  }
  const retry = retrySuffixOf(live.runState.tasks.get(taskId)?.retryCount);
  void self.deps.worktreeQueue
    .remove(live.repoRoot, live.runId, taskId, retry, self.deps.git, self.deps.fs)
    .then((result) => {
      if (!result.ok) {
        self.deps.log.warn(
          `[workflow ${live.runId}/${taskId}] worktreeの撤去に失敗しました: ${result.message}`,
        );
      }
    });
}
