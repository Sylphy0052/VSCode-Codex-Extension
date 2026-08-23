import type { LoopStopReason } from '../loop/loopController';
import {
  createPullRequest,
  buildTaskPullRequestBody,
  buildTaskPullRequestTitle,
  markPullRequestReady,
  pushBranch,
  runTaskPullRequestFlow,
  shouldCreateTaskPullRequest,
  type ForgeStepOutcome,
  type TaskPullRequestFlowResult,
  type TaskPullRequestSteps,
} from './forge';
import { reviewTaskPullRequest } from './planner';
import {
  buildMergeResolutionPrompt,
  commitUncommittedChangesIfNeeded,
  findTaskIdsMergedSince,
  isMergeResolutionComplete,
  MERGE_RESOLUTION_CONDITION,
  MERGE_RESOLUTION_MAX_ITERATIONS,
  type IntegrationLease,
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
  lease: IntegrationLease,
): Promise<{ merge: MergeTaskResult; pullRequest: PullRequestResult | undefined }> {
  const forgeDeps = self.deps.forge;
  const forge = live.forge;
  if (
    forgeDeps === undefined ||
    forge.kind !== 'active' ||
    !shouldCreateTaskPullRequest(forge.pullRequest)
  ) {
    const merge = await self.integrationQueue.mergeTask(
      lease,
      runId,
      taskId,
      taskBranch,
      self.deps.git,
      task.type,
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
      lease,
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
  lease: IntegrationLease,
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
            // `task.issue`（YAML・ロードマップ由来）を優先し、無ければタスク開始時に
            // 起票したIssue（design.md §16.31、roadmap W6、Issue #596。
            // `live.createdTaskIssues`、`runner.ts`の`maybeCreateTaskIssue`）を使う
            issue: task.issue ?? live.createdTaskIssues.get(taskId),
          }),
          draft: live.draftPullRequest,
        },
      ),
    // design.md §16.31「PRを作ったあと、ローカルマージの前にレビューを1段挟む」、
    // roadmap W6、Issue #596。無効なコールバックを渡さない
    // （`runTaskPullRequestFlow`はcallback自体がundefinedならレビューを試みない）
    ...(forge.reviewTaskPullRequest
      ? {
          reviewPullRequest: buildTaskPullRequestReviewStep(
            self,
            live,
            runId,
            taskId,
            task,
            integration,
            taskCwd,
          ),
        }
      : {}),
    mergeAndPushIntegration: async () => {
      const merged = await self.integrationQueue.mergeTask(
        lease,
        runId,
        taskId,
        taskBranch,
        self.deps.git,
        task.type,
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
    // design.md §16.18「作る順序」5.「draftPullRequestが有効なら、3で作ったPR/MRをreadyへ
    // 切り替える」。無効なコールバックを渡さない（`runTaskPullRequestFlow`はcallback自体が
    // undefinedならready化を試みない。design.md「既定を`false`にしているのは後方互換のため」）
    ...(live.draftPullRequest
      ? { markPullRequestReady: buildMarkTaskPullRequestReady(forgeDeps, forge, taskCwd) }
      : {}),
  };
}

/**
 * タスクのPR/MRを、別の読み取り専用セッションでレビューさせるコールバック
 * （`runTaskPullRequestFlow`の`reviewPullRequest`）を組み立てる（design.md §16.31「PRを
 * 作ったあと、ローカルマージの前にレビューを1段挟む」、roadmap W6、Issue #596）。
 *
 * レビュー対象のdiffは、タスクブランチ（`taskCwd`でチェックアウト済み）と統合ブランチの
 * 間で`git diff`を取る（3点リーダ形式`<integration.branch>...HEAD`。マージベース以降の
 * 変更だけを見る）。diffの取得自体に失敗しても空文字のまま続行し、レビューは止めない
 * （diffが空でもレビューセッション自体は起動する。指摘0件で返るだけ）。
 *
 * 指摘・レビュー自体の失敗はどちらも`taskPullRequestReview`警告として`live.warnings`へ
 * 積む。**この関数はマージをブロックしない**（常に`{ ok: true }`系の結果を返し、
 * `runTaskPullRequestFlow`は結果を問わず`mergeAndPushIntegration`を呼ぶ。design.md
 * §16.31「結果に関わらずマージは進める」）。
 */
function buildTaskPullRequestReviewStep(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  taskCwd: string,
): (url: string | undefined) => Promise<ForgeStepOutcome> {
  return async () => {
    const diffResult = await self.deps.git.run(
      ['diff', `${integration.branch}...HEAD`],
      taskCwd,
    );
    const diff = diffResult.code === 0 ? diffResult.stdout : '';

    const host = self.deps.hosts[task.provider];
    const review = await reviewTaskPullRequest({
      prompt: task.prompt,
      done: task.done,
      diff,
      provider: task.provider,
      host,
      cwd: taskCwd,
      log: self.deps.log,
    });

    if (review.error !== undefined) {
      self.deps.log.warn(
        `[workflow ${runId}/${taskId}] PR/MRのレビューに失敗しました: ${review.error}`,
      );
      live.warnings.push({
        kind: 'taskPullRequestReview',
        taskId,
        message: `PR/MRのレビューに失敗しました: ${sanitizeForLog(review.error)}`,
      });
      return { ok: true };
    }

    if (review.findings.length > 0) {
      const summary = review.findings.map((f) => `- ${f.message}`).join('\n');
      self.deps.log.warn(
        `[workflow ${runId}/${taskId}] PR/MRのレビューで${review.findings.length}件の指摘がありました`,
      );
      live.warnings.push({
        kind: 'taskPullRequestReview',
        taskId,
        message: `PR/MRのレビューで指摘がありました:\n${summary}`,
      });
    }
    return { ok: true };
  };
}

/**
 * タスクのPR/MRをreadyへ切り替えるコールバック（`runTaskPullRequestFlow`の
 * `markPullRequestReady`）を組み立てる。URLから番号を取り出せなければready化を飛ばし、
 * 失敗として返す（design.md §16.18「URLから番号を取り出せなかった場合はready化を飛ばし、
 * 警告を残す」。呼び出し側の`finalizeTaskPullRequestFlow`が警告へ変換する）。
 */
function buildMarkTaskPullRequestReady(
  forgeDeps: NonNullable<WorkflowRunnerInternals['deps']['forge']>,
  forge: Extract<LiveRun['forge'], { kind: 'active' }>,
  taskCwd: string,
): (url: string | undefined) => Promise<ForgeStepOutcome> {
  return async (url) => {
    const number = url !== undefined ? parsePullRequestNumberFromUrl(url) : undefined;
    if (number === undefined) {
      return {
        ok: false,
        message: 'PR/MRの番号をURLから取り出せなかったため、ready化を飛ばしました',
      };
    }
    return markPullRequestReady(forgeDeps.cli, forge.host, taskCwd, number);
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

  // ready化（design.md §16.18「5の失敗はワークフローを止めない」）の失敗はログ・警告へ
  // 反映するだけで、`merge`/`pullRequest`の戻り値は変えない
  if (flow.markReady !== undefined && !flow.markReady.ok) {
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] PR/MRのready化に失敗しました: ${flow.markReady.message}`,
    );
    live.warnings.push({
      kind: 'forgeFailed',
      taskId,
      message: `PR/MRのready化に失敗しました: ${flow.markReady.message}`,
    });
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
 *
 * **この関数はrejectしない。** `runner.ts`の`onTaskFinished`と`retryMerge`（本ファイル）は
 * この関数を`void`で発火するため、内部で投げると呼び出し元が未ハンドルrejectになり、
 * タスクが`merging`のまま統合worktreeの枠を永久に占有する（`getRunOutcome`は`merging`を
 * `running`扱いするため、runの終了判定も進まない）。疑似worktree側（`integratePseudoWorktree`。
 * Issue #376）が全体をtry/catchで包んで`markMergeFailed`へ落としているのと同じ形に揃える
 * （Issue #437）。`nodeGitCommandRunner`/`nodeCliCommandRunner`は基本的にresolveしか返さない
 * ため実害は起きにくいが、ENOSPC等の想定外の例外が起きたときの安全網として必要
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

  try {
    // design.md §16.17「タスク完了時のコミット」2.〜4.
    const commitResult = await commitUncommittedChangesIfNeeded(taskCwd, taskId, self.deps.git, task.type);
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
  } catch (e) {
    // gitのメイン経路で想定外の例外が起きた場合の安全網（Issue #437）。他の失敗を
    // `markMergeFailed`に落とすのと同じ扱いにする
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.error(`[workflow ${runId}/${taskId}] マージ中に例外が発生しました: ${message}`);
    live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
  }
}

/**
 * 統合worktreeへ実際にマージを試みる。成功なら`done`、衝突なら衝突解決セッションを
 * 起動、その他の失敗なら`failed`にする（design.md §16.17「マージ」）。
 *
 * PR/MRの作成（design.md §16.18）が有効なら、マージ自体も`mergeTaskWithForge`が
 * design.mdの定める順序で行う。
 *
 * 統合worktreeの占有（`IntegrationMergeQueue.acquireLease`。Issue #412）はこの関数が取る。
 * 他タスクが衝突解決中ならここで順番待ちになる。解放の責任は次のとおり:
 *
 * - 成功・失敗・例外: この関数の`finally`が解放する
 * - 衝突して解決セッションが立った場合のみ、占有は解決セッション側（
 *   `onMergeResolutionFinished` / `abortAndBlock`）へ引き継ぐ（`handover.done`）。
 *   セッションを立てられなかった経路は引き継ぎが立たないため、この関数の`finally`が解放する
 *
 * **占有を取ったあとで停止・破棄を再確認する**（`decideAfterLeaseWait`）。`acquireLease`は
 * 無期限で待つのに対し、`stop()`は`haltedByUser`を立てるだけで待機中の取得を起こさないため、
 * 他タスクの衝突解決が長引いている間にユーザーが停止すると、解放と同時にこのタスクの
 * `git merge --no-ff`が走り、新しい衝突解決セッションまで開いてしまう（レビュー指摘2）。
 * そこで止めた場合は`merging`のまま放置せず`blocked`まで確定させる（レビュー指摘A）。
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
  const before = self.runs.get(runId);
  if (before === undefined) {
    return;
  }
  // 順番待ちの**前**の停止状態を控えておく（`decideAfterLeaseWait`の判定に使う）。
  // 「もともと停止中だったrunの、走り切ったタスクのマージ」は従来どおり行う
  // （design.md §16.5「`running`のものは走らせ切る」。`interrupted`の既存テスト参照）ので、
  // 見るのは「待っている間に停止へ変わったかどうか」だけにする
  const haltedBefore = before.runState.haltedByUser;
  const lease = await self.integrationQueue.acquireLease(integration.cwd, taskId);
  // 衝突解決セッションへ占有を引き継いだかどうかを、`startMergeResolution`の**途中から**
  // 共有するための箱（Issue #412のレビュー指摘5）。戻り値で受け取る形だと、引き継ぎの確定が
  // 関数の`return`まで遅れ、その手前（`session.runLoop`等）で例外が起きたときに
  // 「セッションは生きているのに`finally`が占有を解放する」ズレが生まれる
  const handover = { done: false };
  try {
    const decision = decideAfterLeaseWait(self, runId, taskId, lease, haltedBefore);
    if (decision.kind !== 'proceed') {
      if (decision.kind === 'block') {
        blockMergeAfterLeaseWait(self, runId, taskId, decision.reason);
      }
      return;
    }
    await mergeWithLease(
      self,
      runId,
      taskId,
      task,
      integration,
      taskCwd,
      taskBranch,
      originCommit,
      lease,
      handover,
    );
  } finally {
    if (!handover.done) {
      self.integrationQueue.releaseLease(lease);
    }
  }
}

/**
 * 順番待ちの間にマージを始められなくなった理由。`blockMergeAfterLeaseWait`が人へ出す文面を
 * 分ける（到達しうる理由と文面が食い違わないようにするため。レビュー指摘10）。
 */
type LeaseWaitBlockReason = 'halted' | 'leaseRevoked';

/** `decideAfterLeaseWait`の判定結果。 */
type LeaseWaitDecision =
  | { kind: 'proceed' }
  | { kind: 'block'; reason: LeaseWaitBlockReason }
  | { kind: 'skip' };

/**
 * 占有を取った直後に、いまマージを始めてよいかを判定する（Issue #412のレビュー指摘2）。
 *
 * - `proceed`: そのままマージへ進む
 * - `block`: マージはせず`blocked`へ確定させる（`blockMergeAfterLeaseWait`）
 * - `skip`: 何もしない（runが破棄された、または誰かが既にこのタスクのマージを決着させている）
 *
 * `acquireLease`は他タスクの衝突解決が終わるまで無期限で待つ。その待ち時間の間に
 * 実行が停止（`stop()`）・破棄されていることがあるため、待つ前の判断のまま
 * `git merge`へ進んではいけない。
 *
 * **見送るときに`merging`のまま残してはいけない**（レビュー指摘A）。`merging`は
 * `getRunOutcome`では`running`扱いなので、放置するとrunの終了判定（`pump`の
 * `live.finished`）が永久に立たず、停止操作が完了せず、終了時の後始末
 * （オーケストレーターへの通知・MCPサーバの停止・`waitingReply`のポーリング停止）も
 * 走らないままリークする。Viewも`merging`には操作ボタンを出さないため、セッション内の
 * 復帰手段が無くなる。`blocked`へ倒せばrunの終了判定が進み、「再マージ」で復帰できる
 * （統合worktreeが塞がっていた`busy`経路と扱いも揃う）。`skip`を返してよいのは、その
 * 「終わらないrun」を誰も見られない場合（run破棄）と、既に誰かが決着させている場合だけ。
 *
 * 停止は**待つ前と比べて変わった場合だけ**見る。もともと停止中のrunでも、既に走っていた
 * タスクは走らせ切ってマージまで進める設計（design.md §16.5）なので、現在値だけで弾くと
 * `interrupted`後に完走したタスクがマージされなくなる。この差分方式は「再マージ」
 * （`retryMerge`）で停止中のrunのマージをやり直す経路も同時に守っている
 * （`retryMergeState`が`haltedByUser`を解除しなくても、待つ前から停止中なら通る）。
 * 一方「まだ`merging`かどうか」は待つ前と比べる必要がない（`merging`でなくなっていれば、
 * 誰かが既にこのタスクのマージを決着させている）。
 *
 * **`live.finished`は「待っている間に終わったか」ではなく「runが破棄されたか」の印として
 * 見る**（レビュー指摘10）。`merging`のタスクがある間`getRunOutcome`は`running`を返すので、
 * `pump`がこのタスクの順番待ち中に`live.finished`を立てることはない。立てられるのは
 * `WorkflowRunner.dispose()`だけで、そこは直後に`releaseAllLeases()`を呼ぶ。つまり
 * 「強制解放された」かつ「`live.finished`」の組み合わせが破棄の印になる。
 */
function decideAfterLeaseWait(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  lease: IntegrationLease,
  haltedBefore: boolean,
): LeaseWaitDecision {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return { kind: 'skip' };
  }
  if (live.runState.tasks.get(taskId)?.state !== 'merging') {
    self.deps.log.info(
      `[workflow ${runId}/${taskId}] 統合worktreeの順番待ちの間にmerging以外へ変わったため、マージを始めません`,
    );
    return { kind: 'skip' };
  }
  if (self.integrationQueue.wasLeaseRevoked(lease)) {
    // 順番が回ってきたのではなく、`releaseAllLeases()`で強制解放されて起こされた。
    // 統合worktreeを触る権利は無いので、どちらにせよマージはしない
    if (live.finished) {
      // `WorkflowRunner.dispose()`。破棄済みのrunへは状態を書き戻さない（レビュー指摘6。
      // `persist`/`notify`が破棄済みのEventEmitter・workspaceStateを触ってしまう）
      self.deps.log.info(`[workflow ${runId}/${taskId}] 実行が破棄されたため、マージを始めません`);
      return { kind: 'skip' };
    }
    // 破棄以外の理由で強制解放された（いまの呼び出し元は`dispose()`だけだが、
    // `IntegrationMergeQueue`はそれを保証していない）。生きているrunなので`merging`のまま
    // 放置できない
    return { kind: 'block', reason: 'leaseRevoked' };
  }
  if (live.runState.haltedByUser && !haltedBefore) {
    return { kind: 'block', reason: 'halted' };
  }
  return { kind: 'proceed' };
}

/**
 * `mergeBusy`警告を、同一taskIdの直近1件へ丸めて積む（Issue #439）。「再マージ」は人が
 * 何度でも押せる操作で、統合worktreeが塞がっている間は押すたびに同じ文面の警告が積まれて
 * いくため、`orchestratorPromptOverride`（Issue #383・`runnerOrchestrator.ts`）が
 * `taskId`ごと直近1件へ丸めたのと同じ規律に乗せる。警告が出た事実自体は最新の1件として
 * 残るので「警告が出た事実が失われる」ことはない。
 */
function pushMergeBusyWarning(live: LiveRun, taskId: string, message: string): void {
  live.warnings = live.warnings.filter((w) => !(w.kind === 'mergeBusy' && w.taskId === taskId));
  live.warnings.push({ kind: 'mergeBusy', taskId, message });
}

/**
 * `mergeInterrupted`警告を、`mergeBusy`と同じ規律（同一taskIdの直近1件へ丸める）で積む
 * （Issue #443）。`markMergeBlocked`は対象タスクの`failure`を`undefined`にするため、
 * 「巻き戻し済みの`blocked`」と「人が止めて中断した`blocked`」の区別を状態側には持たせず、
 * この警告だけが持つ。
 */
function pushMergeInterruptedWarning(live: LiveRun, taskId: string, message: string): void {
  live.warnings = live.warnings.filter(
    (w) => !(w.kind === 'mergeInterrupted' && w.taskId === taskId),
  );
  live.warnings.push({ kind: 'mergeInterrupted', taskId, message });
}

/**
 * `mergeApprovalTimeout`警告を、`mergeBusy`/`mergeInterrupted`と同じ規律（同一taskIdの
 * 直近1件へ丸める）で積む（Issue #413 PR5）。「再マージ」でやり直したセッションが再び
 * タイムアウトした場合に、同じ文面の警告が積み増されていくのを防ぐ。
 */
function pushMergeApprovalTimeoutWarning(live: LiveRun, taskId: string, message: string): void {
  live.warnings = live.warnings.filter(
    (w) => !(w.kind === 'mergeApprovalTimeout' && w.taskId === taskId),
  );
  live.warnings.push({ kind: 'mergeApprovalTimeout', taskId, message });
}

/**
 * `mergeStopTaskStopped`警告を、他の`merge*`警告と同じ規律（同一taskIdの直近1件へ丸める）
 * で積む（Issue #514）。「再マージ」でやり直したセッションが再び`stop_task`で止められた
 * 場合に、同じ文面の警告が積み増されていくのを防ぐ。
 */
function pushMergeStopTaskStoppedWarning(live: LiveRun, taskId: string, message: string): void {
  live.warnings = live.warnings.filter(
    (w) => !(w.kind === 'mergeStopTaskStopped' && w.taskId === taskId),
  );
  live.warnings.push({ kind: 'mergeStopTaskStopped', taskId, message });
}

/** `blockMergeAfterLeaseWait`が人へ出す文面（理由ごと）。 */
const LEASE_WAIT_BLOCK_MESSAGES: Record<LeaseWaitBlockReason, string> = {
  halted:
    '統合worktreeの順番待ちの間に実行が停止したため、マージを見送りました（Viewの「再マージ」でやり直せます）',
  leaseRevoked:
    '統合worktreeの占有が強制解放されたため、マージを見送りました（Viewの「再マージ」でやり直せます）',
};

/**
 * 順番待ちの間にマージを始められなくなったタスクを`blocked`で確定させる（レビュー指摘A）。
 *
 * マージ自体は行わない（統合worktreeには触っていない）。人が「なぜ止まったのか」を
 * 追えるよう、ログと警告の両方に理由を残す。`markMergeBlocked`は`merging`のときだけ
 * 動くため、呼ぶのは`decideAfterLeaseWait`が`block`を返したときだけでよい。
 */
function blockMergeAfterLeaseWait(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  reason: LeaseWaitBlockReason,
): void {
  if (self.isDisposing()) {
    // 破棄経路からは現状ここに到達しない（レビュー3周目のmedium）。`dispose()`は
    // for文で全runの`live.finished`を立て終えてからループの外で1度だけ
    // `releaseAllLeases()`を呼ぶ。`releaseAllLeases()`が起こす`acquireLease`の継続
    // （`decideAfterLeaseWait`の実行）はマイクロタスクなので、`dispose()`の同期フレームが
    // 終わったあとにしか走らない。つまり破棄由来の待機起こしでは`live.finished`が必ず
    // 既に真で、`decideAfterLeaseWait`は`skip`しか返さず、`block`を経てここへ来る経路が
    // 無い（呼び出し元は`decision.kind === 'block'`のときだけ`attemptMerge`から呼ぶ）。
    //
    // それでもガードは残す。`blocked`確定は「人が再マージで直す」前提の後戻りできない
    // 書き換えなので、`decideAfterLeaseWait`の条件が将来変わってここへ来るようになった
    // ときの多層防御として置いておく。破棄しただけの実行は`merging`のまま残し、
    // 次の起動の`resumeMergeAfterReload`に再判定させる
    return;
  }
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const message = LEASE_WAIT_BLOCK_MESSAGES[reason];
  self.deps.log.warn(`[workflow ${runId}/${taskId}] ${message}`);
  pushMergeBusyWarning(live, taskId, message);
  live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
  void self.persist(runId);
  self.notify(runId);
  self.pump(runId);
}

/**
 * `attemptMerge`の中身（占有を取ったあとの処理）。衝突解決セッションへ占有を引き継いだ
 * ときは`handover.done`を立てる（呼び出し側はそのときだけ解放しない）。
 */
async function mergeWithLease(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  taskCwd: string,
  taskBranch: string,
  originCommit: string,
  lease: IntegrationLease,
  handover: { done: boolean },
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
    lease,
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
  if (merge.kind === 'busy') {
    // 統合worktreeに他タスクの未解決の衝突が残っていて、いまは始められない（Issue #412）。
    // `failed`ではなく`blocked`にする。`failed`は`retryMergeState`（`blocked`専用）で戻せず、
    // 以後そのrunのマージが全て同じ理由で`failed`になる行き止まりを作るため
    // （レビュー指摘1）。`blocked`ならViewの「再マージ」で復帰できる
    self.deps.log.warn(`[workflow ${runId}/${taskId}] マージを見送りました: ${merge.message}`);
    pushMergeBusyWarning(live, taskId, merge.message);
    live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
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
  await startMergeResolution(
    self,
    runId,
    taskId,
    task,
    integration,
    merge,
    originCommit,
    lease,
    handover,
  );
}

/**
 * `agent.workflows.mergeApprovalTimeoutSec`の既定値（Issue #413 PR5、design.md §16.17
 * 「承認待ちのアイドルタイムアウト」）。既定1時間。LLMが作業中（承認待ちで**ない**）の
 * 時間はこの計測に含まれない（`waitingApprovalSinceMs`が`undefined`の間はタイマーを
 * 張らない）。
 */
export const DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC = 3600;

/**
 * `waitingApprovalSinceMs`が変わるたび（承認待ちに入る／抜ける）に呼ぶ。既存のタイマーを
 * 必ず先に消してから、承認待ちに入った場合だけ新しいタイマーを張り直す
 * （`agent.workflows.mergeApprovalTimeoutSec`秒後に`handleMergeApprovalTimeout`を呼ぶ）。
 *
 * `setInterval`によるポーリングではなく、承認待ちに入った時点で`setTimeout`を張る方式を
 * 選んだ（`MergeResolutionEntry.approvalTimeoutTimer`のJSDoc参照）。エントリの寿命に
 * 対して1本のタイマーだけを持ち回るため、解放漏れの検査対象も1箇所（`clearTimeout`）に
 * 絞れる。
 */
function scheduleApprovalTimeout(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  previous: ReturnType<typeof setTimeout> | undefined,
  waitingApprovalSinceMs: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (previous !== undefined) {
    clearTimeout(previous);
  }
  if (waitingApprovalSinceMs === undefined) {
    return undefined;
  }
  const timeoutSec =
    self.deps.readMergeApprovalTimeoutSec?.() ?? DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC;
  const timer = setTimeout(
    () => handleMergeApprovalTimeout(self, runId, taskId, waitingApprovalSinceMs),
    timeoutSec * 1000,
  );
  // `waitingReplyPollTimer`（`runnerMessaging.ts`）と同じく、テスト・プロセス終了を
  // 妨げないようにする
  timer.unref?.();
  return timer;
}

/**
 * 承認待ちタイムアウトの本体（Issue #413 PR5）。衝突解決セッションが承認待ちのまま
 * `agent.workflows.mergeApprovalTimeoutSec`を超えたら`session.stopLoop()`を呼び、
 * `finishMergeResolution`の非破壊分岐（対象タスクだけを`blocked`にし、`git merge --abort`は
 * 呼ばない）へ合流させる。
 *
 * **停止中（`haltedByUser`）でもタイムアウトさせる（Issue #539）。** かつては
 * 「run全体が停止済みならこの解決セッションのエントリは`finishMergeResolution`で既に
 * 消えているはず」という前提のもと`haltedByUser`なら何もせず戻っていたが、この前提は
 * 成立しない。「再マージ」（`retryMerge`）は`haltedByUser`を解除しない設計（Issue #517/
 * #525・design.md §16.17「再マージ」）のため、run全体が停止したままでも新しい衝突解決
 * セッションが開くことがあり、そのセッションが承認待ちに入るとこの関数へ到達する。
 * ここで何もせず戻ると、`scheduleApprovalTimeout`が張るタイマーは
 * `waitingApprovalSinceMs`が変わらない限り一発物（`scheduleApprovalTimeout`のJSDoc参照）
 * なので、以後そのセッションのタイムアウトは二度と発火せず、対象タスクが`merging`のまま
 * 永久に残る（`getRunOutcome`が`running`を返し続け、runが終了確定しない）。
 *
 * 下の`markMergeBlocked`（`localOnlyStopKind === 'approvalTimeout'`分岐）は対象タスク
 * だけを`blocked`にし、`live.runState.haltedByUser`には触れない。**run全体の停止状態は
 * タイムアウトでは変えない**（人が明示的に止めた事実をタイムアウトが上書きしない）ため、
 * ここで`haltedByUser`を無条件でタイムアウトさせても安全側に倒れる。
 *
 * なお、このガードを入れた当初（Issue #413 PR5）の理由は「停止中も計測を続けると
 * halt解除直後に即タイムアウトする」という懸念だったが、`scheduleApprovalTimeout`は
 * 経過時間を積算せず`setTimeout`を張るだけで、`haltedByUser`の変化ではタイマーに
 * 触れない。そのため懸念した即発火は構造的に起こりえず、**このガードは懸念に対して
 * 何も機能しないまま、上記の行き止まりだけを作っていた**（Issue #539）。同じ懸念から
 * ここへガードを戻さないこと。
 *
 * `waitingApprovalSinceMs`は張った時点の値をそのまま比較する（承認待ちが一度解けて再び
 * 承認待ちへ戻っていれば値が変わっているため、古いタイマーの取りこぼしを検知できる。
 * `scheduleApprovalTimeout`は張り直す前に必ず`clearTimeout`するので通常は起こらないが、
 * 多層防御として残す）。
 */
function handleMergeApprovalTimeout(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  scheduledForWaitingApprovalSinceMs: number,
): void {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const entry = live.mergeResolutions.get(taskId);
  if (
    entry === undefined ||
    entry.waitingApprovalSinceMs !== scheduledForWaitingApprovalSinceMs
  ) {
    // 既に承認待ちを抜けた、解決セッション自体が終わった、または新しい承認待ちへ
    // 張り替わった後（多層防御。上のJSDoc参照）
    return;
  }
  self.deps.log.warn(
    `[workflow ${runId}/${taskId}] 承認待ちがタイムアウト（${
      self.deps.readMergeApprovalTimeoutSec?.() ?? DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC
    }秒）を超えたため、衝突解決セッションを停止します`,
  );
  entry.timedOutByApprovalTimeout = true;
  entry.session.stopLoop();
}

/**
 * 衝突解決セッションを開く（design.md §16.17「コンフリクト」3.）。衝突した状態の
 * 統合worktreeを`cwd`にし、未解決パスの一覧と、突き合わせる相手のタスクの`prompt`/`done`
 * をプロンプトに渡す。解決用セッションは依存グラフのノードにはしない（design.md
 * 「コンフリクト」5.）ため、`live.tasks`ではなく`live.mergeResolutions`で管理する。
 *
 * 統合worktreeの占有（`lease`）を解決セッションへ引き継げた場合だけ`handover.done`を立てる
 * （Issue #412）。セッションを開けなかった経路（承認モードによる拒否・`openTaskSession`の
 * 例外）は`abortAndBlock`が巻き戻し、`handover.done`が立たないまま戻るので呼び出し側の
 * `finally`が解放する。
 *
 * **引き継ぎの確定は`openTaskSession`が解決した直後に行う**（レビュー指摘5・C）。少しでも
 * 遅らせると、その手前（`session.open` / `buildMergeResolutionPrompt` / `session.runLoop`）が
 * 投げたときに「セッションは生きているのに`attemptMerge`の`finally`が占有を解放する」ズレが
 * 生まれ、以後その解決セッションの`onFinished`→`abortAndBlock`は`leaseNotHeld`で拒否されて
 * `git merge --abort`が走らず、`MERGE_HEAD`が残る。`session.open()`が投げた場合は
 * `live.mergeResolutions`へ入る前でもあり、誰にもdisposeされないセッションが残る。
 */
async function startMergeResolution(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  conflict: Extract<MergeTaskResult, { kind: 'conflict' }>,
  originCommit: string,
  lease: IntegrationLease,
  handover: { done: boolean },
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }

  const baseline = self.deps.readBaseline();
  const effective = buildEffectiveTaskConfig(task, baseline);
  // startTask()と同じ最終防御（レビュー指摘: critical 3参照）。衝突解決セッションも
  // 通常のタスクと同じループ制御・承認判定に従う（design.md §16.17「コンフリクト」5.）。
  // startTask()側と同じく、`buildEffectiveTaskConfig`の読み替え（issue #271）により
  // 通常この分岐へは入らない。多層防御として残す
  // `agent.workflows.allowClaudeBypassPermissions` が有効なら、startTask()側と同じく通す
  // （issue #278）
  if (
    task.provider === 'claude' &&
    effective.config.approvalMode === 'bypassPermissions' &&
    !baseline.allowClaudeBypassPermissions
  ) {
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 実効approvalModeがbypassPermissionsのため衝突解決セッションを開始できません`,
    );
    await abortAndBlock(self, runId, taskId, integration, lease);
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
      // タブ名を`taskId`で分ける（Issue #413 PR4）。従来は固定文字列（`'Codex'`/`LABEL`）
      // だったため、複数の衝突解決セッションが並ぶ場合にどのタスクの解決か見分けられ
      // なかった
      mergeResolutionTaskId: taskId,
    });
  } catch (e) {
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 衝突解決セッションを開始できませんでした: ${message}`,
    );
    await abortAndBlock(self, runId, taskId, integration, lease);
    return;
  }
  // **セッションが手に入った時点で引き継ぎを確定させる**（レビュー指摘C）。以降は
  // `session.open()`・`buildMergeResolutionPrompt()`が投げても呼び出し側の`finally`には
  // 解放させない。ここで解放されると、統合worktreeで生きているセッションを抱えたまま次の
  // タスクの`git merge`が割り込む（レビュー指摘5で塞いだのと同じ壊れ方）。この関数が
  // 自分の`catch`で始末する
  handover.done = true;
  // `session.dispose()`は`onFinished`を同期的に発火しうる（`chatView.ts`の`teardown`が
  // `loop.stop('manual')`を呼び、`dispatch`の`onStatus`で`wasLoopRunning`が既に立っている）。
  // 後始末を`catch`が引き取ったあとに`onMergeResolutionFinished(reason: 'manual')`が動くと、
  // `applyLoopStopReason('manual')`がrun全体を停止して未開始の`pending`まで`skipped`にし、
  // さらに`finally`の解放が先に走るぶん`abortAndBlock`の`git merge --abort`が`leaseNotHeld`で
  // 拒否されて`MERGE_HEAD`が残る（レビュー指摘D）。印を先に立てて再入を黙らせる
  const abandoned = { done: false };
  // `open()`の最中に終了が発火したかどうか（下の`onFinished`が立てる）。読むのは`open()`が
  // 返った直後の1回だけなので、通常の（あとから来る）終了で立っても影響しない。
  const finishedWhileOpening = { done: false };
  // 承認待ちの可視化（Issue #413 PR4）。`live.mergeResolutions`（`MergeResolutionEntry`）へ
  // 反映する値。承認待ちで**ない**間は`undefined`。`live.mergeResolutions.set()`より前に
  // `onStateChanged`が発火しうる（`open()`が同期的に状態を発火するhost実装）ため、
  // まずローカル変数として持ち、`set()`する時点の値をそのまま渡す
  let waitingApprovalSinceMs: number | undefined;
  // 承認待ちタイムアウト（Issue #413 PR5）。エントリの寿命に対して1本だけ持ち回る
  // タイマーのハンドル。`waitingApprovalSinceMs`と同じくローカル変数で持ち、`try`の外
  // （`catch`からも参照できる位置）で宣言する
  let approvalTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // **`onFinished`の登録は`session.open()`より前に行う**（レビュー指摘12）。`open()`が
    // 同期的にループを回し始めるhost実装だと、登録が後では`open()`中に発火した終了を
    // 取りこぼす。取りこぼすと`handover.done`が既に立っているぶん`attemptMerge`の`finally`も
    // 解放しないため、統合worktreeの占有を誰も手放さないまま`runLoop()`が正常returnし、
    // 以後そのrunのマージが全て詰まる（`catch`にも入らないので気づけない）
    //
    // 衝突解決セッションの承認は、通常のタスクの`escalation.ts`（境界・allow/escalate）
    // ではなく、標準の承認カード（`setApprovalHandler`を設定しない既定挙動）へ委ねる。
    // タスク境界（`TaskBoundary`）は本来そのタスクのworktree用に作られたもので、統合
    // worktree（別ディレクトリ）向けに作り直すと境界判定の意味が変わってしまう。安全側
    // （常に人の承認を要求する）に倒すための単純化であり、最終報告に明記する。
    //
    // あわせて、統合worktreeの占有はこの解決セッションが引き継ぐ。`onMergeResolutionFinished`が
    // 全ての出口（done / blocked / manual / interrupted / 例外）で解放する（Issue #412）
    session.onFinished((reason) => {
      if (abandoned.done) {
        return;
      }
      finishedWhileOpening.done = true;
      void onMergeResolutionFinished(self, runId, taskId, task, integration, reason, lease);
    });

    // 承認待ちの可視化（Issue #413 PR4）。**`onFinished`と同じく`session.open()`より前に
    // 登録する**（同期的に状態変化を発火するhost実装があるため取りこぼさない）。
    // `waitingApproval`状態そのものへは倒さない（`markWaitingApproval`は`running`からしか
    // 動かず、`merging`は`isUnsettled`から意図的に外されている。`runState.ts`参照）ため、
    // ここでは`live.mergeResolutions`のエントリへ承認待ちフラグを足すだけに留める。
    // `setApprovalHandler`は付けない（上のコメント・design.md §16.17「コンフリクト」5.）ため
    // 承認要求は標準の承認カードへ委ねられたまま変わらない
    session.onStateChanged((state) => {
      if (abandoned.done) {
        return;
      }
      const waiting = state.approvals.length > 0;
      const nextSince = waiting ? (waitingApprovalSinceMs ?? Date.now()) : undefined;
      if (nextSince === waitingApprovalSinceMs) {
        return;
      }
      waitingApprovalSinceMs = nextSince;
      approvalTimeoutTimer = scheduleApprovalTimeout(
        self,
        runId,
        taskId,
        approvalTimeoutTimer,
        waitingApprovalSinceMs,
      );
      if (!live.mergeResolutions.has(taskId)) {
        // まだ`set()`前（`open()`の最中）。`set()`する側がこの時点の`waitingApprovalSinceMs`を
        // 読むので、ここでは何もしなくてよい
        return;
      }
      live.mergeResolutions.set(taskId, {
        session,
        waitingApprovalSinceMs,
        approvalTimeoutTimer,
        timedOutByApprovalTimeout: false,
        stoppedByStopTask: false,
      });
      self.notify(runId);
      // 承認待ちの開始/解消は`maxParallel`の枠の勘定（`excludeFromActiveCount`）を変える
      // ため、次に開始できるタスクを拾い直す
      self.pump(runId);
    });

    session.open({ preserveFocus: true });
    if (finishedWhileOpening.done) {
      // `open()`が同期的にループを回し切って終了まで発火した。決着と占有の解放は上の
      // リスナーが済ませているので、ここでは終わったセッションを畳むだけにする
      // （`live.mergeResolutions`へは入れない・`runLoop`もかけ直さない）
      abandoned.done = true;
      clearTimeout(approvalTimeoutTimer);
      live.mergeResolutions.delete(taskId);
      session.dispose();
      self.notify(runId);
      return;
    }
    live.mergeResolutions.set(taskId, {
      session,
      waitingApprovalSinceMs,
      approvalTimeoutTimer,
      timedOutByApprovalTimeout: false,
      stoppedByStopTask: false,
    });

    const prompt = buildMergeResolutionPrompt(
      { id: taskId, prompt: task.prompt, done: task.done },
      others,
      conflict.unresolvedPaths,
    );

    session.runLoop({
      initialPrompt: prompt,
      continuePrompt: `続けてください。終了条件: ${MERGE_RESOLUTION_CONDITION}`,
      maxIterations: MERGE_RESOLUTION_MAX_ITERATIONS,
      condition: MERGE_RESOLUTION_CONDITION,
    });
    self.notify(runId);
  } catch (e) {
    // セッションは手に入ったが走らせられなかった。引き継ぎ済み（`handover.done`）なので
    // 呼び出し側の`finally`には任せず、ここでセッションを畳んでから巻き戻して解放する
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.error(
      `[workflow ${runId}/${taskId}] 衝突解決セッションを開始できませんでした: ${message}`,
    );
    try {
      abandoned.done = true;
      clearTimeout(approvalTimeoutTimer);
      live.mergeResolutions.delete(taskId);
      session.dispose();
      await abortAndBlock(self, runId, taskId, integration, lease);
    } finally {
      // 後始末の途中で何が起きても、占有はここで必ず手放す
      self.integrationQueue.releaseLease(lease);
    }
  }
}

/**
 * 衝突解決セッションの結果を受けて、`done`（解決済み）か`blocked`（未解決）かを確定する。
 *
 * `startMergeResolution`から引き継いだ統合worktreeの占有（`lease`）を、**どの出口でも
 * 必ず解放する**（`finally`。Issue #412。解放漏れは以後そのrunのマージが全て詰まる
 * デッドロックになる）。`abortAndBlock`が先に解放していても、解放は冪等なので二重解放に
 * ならない。
 *
 * **この関数はrejectしない。** `startMergeResolution`の`session.onFinished`はこの関数を
 * `void`で発火するため、`finishMergeResolution`が投げると呼び出し元が未ハンドルrejectに
 * なり、タスクが`merging`のまま統合worktreeの枠を永久に占有する（Issue #437）。gitの
 * メイン経路の他の失敗を`markMergeFailed`に落とすのと同じ扱いにする
 */
async function onMergeResolutionFinished(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  reason: LoopStopReason,
  lease: IntegrationLease,
): Promise<void> {
  try {
    await finishMergeResolution(self, runId, taskId, task, integration, reason, lease);
  } catch (e) {
    const live = self.runs.get(runId);
    if (live !== undefined) {
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      self.deps.log.error(
        `[workflow ${runId}/${taskId}] 衝突解決の後始末で例外が発生しました: ${message}`,
      );
      live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
      void self.persist(runId);
      self.notify(runId);
      self.pump(runId);
    }
  } finally {
    self.integrationQueue.releaseLease(lease);
  }
}

/** `onMergeResolutionFinished`の中身（占有の解放は呼び出し側の`finally`が受け持つ）。 */
async function finishMergeResolution(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  task: WorkflowTask,
  integration: { cwd: string; branch: string },
  reason: LoopStopReason,
  lease: IntegrationLease,
): Promise<void> {
  if (self.isDisposing()) {
    // `WorkflowRunner.dispose()`が`live.mergeResolutions`のセッションを解放したときの
    // 呼び戻し（`reason`は`manual`）。下の`manual`分岐は`applyLoopStopReason`でrun全体を
    // 手動停止にし、未着手の`pending`まで`skipped`にするため、deactivateしただけの実行が
    // 次の起動で続きから進まなくなる。セッションの解放は`dispose()`が済ませているので、
    // ここは何もせず戻る（`WorkflowRunnerInternals.isDisposing`のJSDoc参照）
    return;
  }
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const entry = live.mergeResolutions.get(taskId);
  live.mergeResolutions.delete(taskId);
  // 承認待ちタイムアウトのタイマー（Issue #413 PR5）。この関数はどの`reason`でも
  // 必ず1度は通る（`session.onFinished`の唯一の合流点）ため、ここで解放すれば
  // `done`/`manual`/`interrupted`/`taskStopped`の全経路を洗える
  clearTimeout(entry?.approvalTimeoutTimer);
  try {
    entry?.session.dispose();
  } catch (e) {
    // ここで投げたまま呼び出し側（`onMergeResolutionFinished`）の`catch`へ流すと、
    // 下の`reason`判定を経由せず`markMergeFailed`へ落ちてしまう。`reason`が
    // `manual`/`interrupted`/`taskStopped`（人が止めた経路）だったときは「タスク自身の
    // 状態は変えない」（Issue #434）はずが、disposeの失敗という無関係な理由で破られる。
    // 他のdispose()呼び出し箇所（`runner.ts`のセッション差し替え・終了処理）と同じく、
    // 後始末の失敗はログにだけ残して先へ進む
    self.deps.log.warn(
      `[workflow ${runId}/${taskId}] 衝突解決セッションの後始末（dispose）に失敗しました: ${sanitizeForLog(
        e instanceof Error ? e.message : String(e),
      )}`,
    );
  }

  // `reason === 'taskStopped'`のうち、run全体ではなく「このタスク単体」を狙った停止
  // （承認待ちタイムアウト = Issue #413 PR5、`stop_task` = Issue #514）はここへ合流する。
  // `session.stopLoop()`は理由を`'taskStopped'`としてしか`onFinished`へ伝えられないため、
  // 送り元はエントリのフラグ（`entry.timedOutByApprovalTimeout` /
  // `entry.stoppedByStopTask`）でしか区別できず、下の「人が全体停止を押した」経路
  // （`applyLoopStopReason`でrun全体を`haltedByUser`にする）とは別扱いにする必要がある。
  //
  // 2つのフラグは「run全体は止めず、このタスクだけを`blocked`にする」という**同じ結末**へ
  // 合流するため、`markMergeBlocked`の呼び出しと後始末（persist/notify/pump）は1箇所に
  // まとめる。ただし警告の文言と積む警告の`kind`は分ける。「タイムアウトで自動的に止まった」
  // のか「単体の停止操作で明示的に止められた」のかは、人が次に取るべき行動
  // （前者は放置を疑う、後者は止めた側の意図を確認する）が違うため。
  //
  // **`stoppedByStopTask`はオーケストレーターの`stop_task`だけでなく、ワークフローView
  // の「タスク停止」ボタン（`src/view/workflowScript.ts`）からも立つ**（`merging`タスクへの
  // ボタン表示はIssue #514で意図的に追加された。`WorkflowRunner.stopTask()`は呼び出し元を
  // 区別しない単一の入口）。そのため下の警告文言は片方の呼び出し元だけを名指ししない
  // （Issue #539のレビューで、`stop_task`を一度も使っていない人へその名前を出す食い違いが
  // 見つかった）。
  const localOnlyStopKind: 'approvalTimeout' | 'stopTask' | undefined =
    reason !== 'taskStopped'
      ? undefined
      : entry?.timedOutByApprovalTimeout === true
        ? 'approvalTimeout'
        : entry?.stoppedByStopTask === true
          ? 'stopTask'
          : undefined;
  if (localOnlyStopKind !== undefined) {
    // **run全体は止めない。** どちらも「このタスクの衝突解決だけが止まった」という
    // 局所的な事象であり、他のタスクが動くのを妨げる理由にはならない。
    // `applyLoopStopReason`を呼んで`haltedByUser`を立てると、まだ開始していない
    // `pending`が全て`skipped`（`runHalted`）へ倒れてしまい（`skipRemainingPending`）、
    // 「対象はこのタスクだけ」という前提が崩れる（design.md §16.17。最終報告参照）。
    //
    // このタスク自身は下の`manual`/`interrupted`/`taskStopped`共通の経路と同じく
    // `markMergeBlocked`で`blocked`へ確定させ、`git merge --abort`は呼ばない（Issue #434と
    // 同じ理由。統合worktreeで進んでいた解決作業を巻き戻さない）。
    live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    if (localOnlyStopKind === 'approvalTimeout') {
      const message =
        '衝突解決セッションが承認待ちのままタイムアウトしたため停止しました。統合worktreeは衝突した状態のまま残っています（Viewの「再マージ」で再開できます）';
      self.deps.log.warn(`[workflow ${runId}/${taskId}] ${message}`);
      pushMergeApprovalTimeoutWarning(live, taskId, message);
    } else {
      const message =
        '衝突解決セッションが単体の停止操作（Viewの「タスク停止」またはオーケストレーターのstop_task）で停止されました。統合worktreeは衝突した状態のまま残っています（Viewの「再マージ」で再開できます）';
      self.deps.log.warn(`[workflow ${runId}/${taskId}] ${message}`);
      pushMergeStopTaskStoppedWarning(live, taskId, message);
    }
    void self.persist(runId);
    self.notify(runId);
    self.pump(runId);
    return;
  }

  if (reason === 'manual' || reason === 'interrupted' || reason === 'taskStopped') {
    // 人が止めた経路。タブへの直接介入（`manual` / `interrupted`）に加えて、ワークフローView
    // の「全体停止」（`WorkflowRunner.stop()`が衝突解決セッションへ送る`stopLoop()` →
    // `taskStopped`。issue #381で止め対象に加えた）もここへ合流する。通常のタスク
    // （`applyLoopStopReason`の`manual`/`interrupted`分岐）は対象タスク自身の状態を変えず
    // 実行全体だけを止めるが（design.md §16.5）、衝突解決セッションはここに限り
    // `markMergeBlocked`で対象タスク自身も`blocked`へ確定させる（下のコメント、Issue #443・
    // 案A）。`merging`のまま実行全体だけを止めると、`getRunOutcome`が`running`を返し続けて
    // runが終了確定しない行き止まりになるため。
    //
    // **ここで`git merge --abort`はしない**（Issue #412のレビュー指摘1・Issue #434）。人が
    // 統合worktreeで直接手を動かしている経路であり、巻き戻すとその解決作業を破棄してしまう
    // （design.md §16.17が「衝突した状態のままにしておく」としているのと同じ理由）。
    // 「全体停止」も、人が統合worktreeで解いている途中の未コミットの解決結果を巻き上げる点は
    // 同じで、破棄すると復旧手段が無い（「再マージ」してもゼロからやり直しになる）。
    // 結果として統合worktreeは`MERGE_HEAD`と未解決パスを抱えたまま占有だけが解放される。
    // 次にマージへ来たタスクは`mergeTaskBranch`のゲートで`busy`を受け、`failed`ではなく
    // `blocked`（Viewの「再マージ」で復帰できる）になる。
    //
    // `taskStopped`はrun全体を止める操作なので、run単位の停止としては`manual`と同じ扱いに
    // する（`stop()`が呼び出し前に既に`haltedByUser`を立てているため、この呼び出しは冪等）。
    // `taskStopped`のまま渡すと`applyLoopStopReason`はタスク単位の`manualStop`確定を試み、
    // taskIdを渡さないこの呼び出しでは何も起きない、という分かりにくい形になる。
    const haltReason: LoopStopReason = reason === 'taskStopped' ? 'manual' : reason;
    live.runState = applyLoopStopReason(live.runState, live.def.tasks, '', haltReason);

    // 案A（Issue #443）: `merging`は必ず閉じる。ここで`markMergeBlocked`を呼び、
    // このタスク自身を`blocked`へ確定させる。`git merge --abort`は呼ばない
    // （上のコメントの通り、巻き戻すと未コミットの解決結果を破棄してしまうため）。
    // `blocked`は「作業は終わったが統合ブランチに入っていない」という意味に広げて使う
    // （design.md §16.17）。「巻き戻し済みの`blocked`」との違いは状態には持たせず、
    // 下の警告だけが持つ（`markMergeBlocked`は`failure`を`undefined`にするため）。
    //
    // **呼び出し順序に意味がある。** 必ず`applyLoopStopReason`の**後**に呼ぶこと。
    // `applyLoopStopReason('manual' | 'interrupted')`は内部で`skipRemainingPending`を
    // 呼び、このタスクに依存する後続のうちまだ`pending`のものを先に
    // `skipped`（理由: `runHalted`）へ倒す。その後で`markMergeBlocked`を呼んでも、対象の
    // 後続は既に`pending`ではないため、その状態遷移ループは`appendCascadeTaskId`経由で
    // 何もしない（`current.failure?.kind`が`'mergeBlocked'`ではなく`'runHalted'`なので
    // 一致せず素通りする）。結果として後続は`runHalted`のまま残り、`mergeBlocked`と
    // 二重の意味を持たない。逆順で呼ぶと、後続が先に`mergeBlocked`で`skipped`になった後
    // `skipRemainingPending`は`pending`だけを見るため触らずに済んでしまうが、それでは
    // 「実行全体が停止したから開始しなかった」という本来の理由（`runHalted`）が
    // 「依存先の衝突で止まった」（`mergeBlocked`）にすり替わってしまう。
    live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    pushMergeInterruptedWarning(
      live,
      taskId,
      '衝突解決が停止のため中断されました。統合worktreeは衝突した状態のまま残っています（Viewの「再マージ」で再開できます）',
    );
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
  await abortAndBlock(self, runId, taskId, integration, lease);
}

/**
 * マージを巻き戻して`blocked`に確定させる共通処理（design.md §16.17「コンフリクト」7.）。
 *
 * `git merge --abort`は統合worktree全体を巻き戻すため、**自分が占有しているマージだけを
 * 巻き戻せる**ように占有ハンドルを必須にする（Issue #412の指摘2。ハンドル無しだと、他
 * タスクの衝突解決セッションが編集中の内容ごと巻き戻していた）。ハンドルが失効していれば
 * `IntegrationMergeQueue.abortMerge`が`leaseNotHeld`で拒否し、`git merge --abort`自体が
 * 走らない。
 */
async function abortAndBlock(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  integration: { cwd: string; branch: string },
  lease: IntegrationLease,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const abort = await self.integrationQueue.abortMerge(lease, self.deps.git);
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
  const retry = retrySuffixOf(live.runState.tasks.get(taskId));
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
