import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';

import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import type { LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import { buildEscalationRequest } from './approvalMapping';
import {
  classifyApprovalRequest,
  isPathWithinRoot,
  type EscalationPolicy,
  type TaskBoundary,
} from './escalation';
import {
  applyLoopStopReason,
  createRunState,
  markApprovalRejected,
  markRunning,
  markWaitingApproval,
  recordSessionInfo,
  recordSubmissionCount,
  resumeFromApproval,
  type RunState,
} from './runState';
import { getRunOutcome, nextTasksToStart, type RunOutcome } from './scheduler';
import { WorkflowRunStore, type PersistedTaskState } from './runStore';
import { buildEffectiveTaskConfig, type ExtensionSafetyBaseline } from './taskConfig';
import type {
  ApprovalHandlerResult,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from './taskSession';
import {
  buildTaskBoundary,
  checkWorktreesGitignored,
  decideWorkingDirectory,
  isGitWorkingTree,
  resolveHeadCommit,
  shouldRemoveWorktree,
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from './worktree';
import {
  expandTemplate,
  parseWorkflowYaml,
  validateWorkflow,
  type Provider,
  type TaskResult,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowTask,
} from './workflow';

/**
 * スケジューラ（#53）が「開始せよ」と言ったタスクについて、セッションを作り、指示を送り、
 * 完了を検知して結果を返す（design.md §16.5 / §16.10）。
 *
 * VSCode APIには直接依存しない。`TaskSessionHost`（Codex/Claudeのチャット画面が実装）・
 * `GitCommandRunner` / `WorktreeFileSystemPort`（#55）・`WorkflowRunStore`
 * （`workspaceState` を抽象化した口）を注入で受け取り、`extension.ts` が実体を組み立てる。
 */

/** ワークフロー定義ファイルの読み込み口。サイズ上限のチェックを読み込む側の責務にする（design.md #52コメント）。 */
export interface WorkflowFilePort {
  /** バイト数。存在しない・読めない場合は undefined。 */
  fileSize(path: string): Promise<number | undefined>;
  readTextFile(path: string): Promise<string | undefined>;
}

/**
 * 巨大なYAMLで拡張機能ホスト（シングルスレッド）を固まらせないための上限。
 * `workflow.ts` の `MAX_PROMPT_LENGTH`（20000文字）× `MAX_TASK_COUNT`（50）を
 * 大きく超える値を目安にした余裕のある上限で、通常のワークフロー定義には十分すぎる。
 */
export const MAX_WORKFLOW_FILE_BYTES = 1 * 1024 * 1024;

export const nodeWorkflowFilePort: WorkflowFilePort = {
  async fileSize(path: string): Promise<number | undefined> {
    try {
      const stat = await fsPromises.stat(path);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  },
  async readTextFile(path: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export interface WorkflowRunnerDeps {
  /** provider別の `TaskSessionHost`。`runner.ts` はプロバイダを見ずにこの口だけを使う。 */
  hosts: Record<Provider, TaskSessionHost>;
  /** 1実行（run）につき1つ使い回すこと（`WorktreeCreationQueue` 自身の制約）。 */
  worktreeQueue: WorktreeCreationQueue;
  git: GitCommandRunner;
  fs: WorktreeFileSystemPort;
  filePort: WorkflowFilePort;
  store: WorkflowRunStore;
  log: Logger;
  /**
   * 拡張機能側の現在の設定（クランプの基準）。タスクを開始する瞬間に読み直すため、
   * 呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと。
   */
  readBaseline: () => ExtensionSafetyBaseline;
  /** テスト用の差し替え口。既定は `node:crypto` の `randomUUID`。 */
  randomId?: () => string;
  /** テスト用の差し替え口。既定は `Date.now`。 */
  now?: () => Date;
}

export interface StartWorkflowResult {
  ok: boolean;
  runId?: string;
  errors?: readonly WorkflowIssue[];
}

/** 一覧表示用の要約。#57のワークフローViewができるまでの間、コマンドのQuickPickに使う。 */
export interface LiveRunSummary {
  runId: string;
  name: string;
  defPath: string;
  outcome: RunOutcome;
}

/** タスク1件の実行時ブックキーピング。`RunState`（純粋）とは別に、セッション等の実体を持つ。 */
interface LiveTask {
  session: TaskSession;
  cwd: string;
  branch: string;
  /** クランプ済みの `autoApprove`。承認判定の入力に使う。 */
  autoApprove: boolean;
  boundary: TaskBoundary;
  /** `isolation: worktree` で実際にworktreeを使ったか。撤去してよいかの判定に使う。 */
  usedWorktree: boolean;
  lastState: ChatState | undefined;
  /** `done` になったときだけ埋まる。後続タスクのテンプレート変数に使う（応答本文は永続化しない）。 */
  result: TaskResult | undefined;
  wasBusy: boolean;
  submissionCount: number;
}

interface LiveRun {
  runId: string;
  def: WorkflowDefinition;
  defPath: string;
  repoRoot: string;
  gitRepo: boolean;
  headCommit: string;
  startedAt: string;
  runState: RunState;
  tasks: Map<string, LiveTask>;
  finished: boolean;
}

export class WorkflowRunner {
  private readonly runs = new Map<string, LiveRun>();

  constructor(private readonly deps: WorkflowRunnerDeps) {}

  /** 現在メモリ上で把握している実行（このウィンドウで開始したもの）の一覧。 */
  listLive(): LiveRunSummary[] {
    return [...this.runs.values()].map((live) => ({
      runId: live.runId,
      name: live.def.name,
      defPath: live.defPath,
      outcome: getRunOutcome(live.runState),
    }));
  }

  /**
   * 定義ファイルを読み込み、検証し、通れば実行を開始する。
   *
   * `repoRoot` はワークフロー定義ファイルが属するワークスペースフォルダの絶対パス
   * （design.md §16.6「`currentWorkspaceFolder()` は使わない」の呼び出し側での実践）。
   */
  async start(defPath: string, repoRoot: string): Promise<StartWorkflowResult> {
    const size = await this.deps.filePort.fileSize(defPath);
    if (size === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }
    if (size > MAX_WORKFLOW_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          issue(
            `定義ファイルが大きすぎます（上限${MAX_WORKFLOW_FILE_BYTES}バイト）: ${size}バイト`,
          ),
        ],
      };
    }
    const text = await this.deps.filePort.readTextFile(defPath);
    if (text === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }

    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [issue(`YAMLの解析に失敗しました: ${message}`)] };
    }

    const validation = validateWorkflow(def);
    for (const w of validation.warnings) {
      this.deps.log.warn(`[workflow] ${w.message}`);
    }
    if (validation.errors.length > 0) {
      return { ok: false, errors: validation.errors };
    }

    const gitRepo = await isGitWorkingTree(repoRoot, this.deps.git);
    let headCommit = '';
    if (gitRepo) {
      const head = await resolveHeadCommit(repoRoot, this.deps.git);
      if (head === undefined) {
        return { ok: false, errors: [issue('HEADコミットを解決できませんでした')] };
      }
      headCommit = head;
    } else {
      const strictWithoutCwd = def.tasks.find(
        (t) => t.isolation === 'worktree-strict' && t.cwd === undefined,
      );
      if (strictWithoutCwd !== undefined) {
        return {
          ok: false,
          errors: [
            issue(
              'ワークスペースがgitの作業ツリーではないため、isolation: worktree-strict のタスクを実行できません',
              [strictWithoutCwd.id],
            ),
          ],
        };
      }
    }

    const gitignoreCheck = await checkWorktreesGitignored(repoRoot, this.deps.fs);
    if (gitignoreCheck.needsEntry && gitignoreCheck.message !== undefined) {
      this.deps.log.warn(`[workflow] ${gitignoreCheck.message}`);
    }

    const runId = this.deps.randomId?.() ?? randomUUID();
    const live: LiveRun = {
      runId,
      def,
      defPath,
      repoRoot,
      gitRepo,
      headCommit,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      runState: createRunState(def.tasks),
      tasks: new Map(),
      finished: false,
    };
    this.runs.set(runId, live);
    await this.persist(runId);
    this.pump(runId);
    return { ok: true, runId };
  }

  /**
   * 実行全体を停止する。人の割り込み（`manual`）と同じ扱いで、新しいタスクの開始だけを
   * 止める。既に `running` のタスクはそのまま走らせ切る（design.md §16.5）。
   */
  stop(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    // `manual` / `interrupted` の遷移はtaskIdを使わない（実装上の事実。runState.ts参照）ため
    // 空文字で十分だが、意図を示すため定数として明示しておく
    const NO_SPECIFIC_TASK = '';
    live.runState = applyLoopStopReason(live.runState, live.def.tasks, NO_SPECIFIC_TASK, 'manual');
    void this.persist(runId);
  }

  // ---- スケジューリング ----

  /** 状態が変わるたびに呼ぶ（design.md §16.3）。次に開始できるタスクを開始し、終了を判定する。 */
  private pump(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.finished) {
      return;
    }
    const toStart = nextTasksToStart(live.def, live.runState);
    for (const taskId of toStart) {
      // 開始の意思決定と同時にrunningへ倒す。非同期のstartTaskが終わるまで待つと、
      // 同じタスクが次のpump呼び出しで二重にnextTasksToStartへ拾われてしまう
      live.runState = markRunning(live.runState, taskId);
      void this.startTask(runId, taskId);
    }
    void this.persist(runId);

    const outcome = getRunOutcome(live.runState);
    if (outcome !== 'running' && !live.finished) {
      live.finished = true;
      this.deps.log.info(`[workflow ${runId}] 実行が終了しました: ${outcome}`);
    }
  }

  private async startTask(runId: string, taskId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      return;
    }

    try {
      const retryCount = live.runState.tasks.get(taskId)?.retryCount ?? 0;
      const retry = retryCount > 0 ? retryCount : undefined;
      const { cwd, branch, usedWorktree } = await this.resolveWorkingDirectory(live, task, retry);

      const baseline = this.deps.readBaseline();
      // クランプはこの1関数だけを通す（design.md §16.16。#52セキュリティ監査指摘）
      const effective = buildEffectiveTaskConfig(task, baseline);
      for (const w of effective.warnings) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${w}`);
      }
      const input: TaskSessionInput = { cwd, config: effective.config, sandbox: effective.sandbox };

      const boundaryResult = await this.buildBoundary(live, cwd);
      if (boundaryResult.warning !== undefined) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${boundaryResult.warning}`);
      }

      const host = this.deps.hosts[task.provider];
      const session = await host.openTaskSession(input);
      session.open({ preserveFocus: true });

      const liveTask: LiveTask = {
        session,
        cwd,
        branch,
        autoApprove: effective.autoApprove,
        boundary: boundaryResult.boundary,
        usedWorktree,
        lastState: undefined,
        result: undefined,
        wasBusy: false,
        submissionCount: 0,
      };
      live.tasks.set(taskId, liveTask);
      live.runState = recordSessionInfo(live.runState, taskId, session.sessionId, cwd);

      session.setApprovalHandler((approval, rawParams) =>
        this.handleApproval(runId, taskId, task, approval, rawParams),
      );
      session.onApprovalResolved((outcome) =>
        this.onApprovalResolved(runId, taskId, outcome.decision),
      );
      session.onStateChanged((state) => this.onTaskStateChanged(runId, taskId, state));
      session.onFinished((reason, state) =>
        this.onTaskFinished(runId, taskId, task, reason, state),
      );

      // テンプレート展開はタスク開始直前に行う（design.md §16.4）。`runLoop` へ渡す本文は
      // 展開前のまま（作業記録に残すため。§16.12）で、実際の送信直前にpromptTransformで展開する
      const resultsMap = this.buildResultsMap(live, task);
      session.setPromptTransform((text) => expandTemplate(text, resultsMap));

      session.runLoop({
        initialPrompt: task.prompt,
        continuePrompt: task.continuePrompt,
        maxIterations: task.maxIterations,
        condition: task.done,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log.error(`[workflow ${runId}/${taskId}] タスクを開始できませんでした: ${message}`);
      live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, 'failed');
      void this.persist(runId);
      this.pump(runId);
    }
  }

  private buildResultsMap(live: LiveRun, task: WorkflowTask): Map<string, TaskResult> {
    const map = new Map<string, TaskResult>();
    for (const depId of task.dependsOn) {
      const result = live.tasks.get(depId)?.result;
      if (result !== undefined) {
        map.set(depId, result);
      }
    }
    return map;
  }

  private async resolveWorkingDirectory(
    live: LiveRun,
    task: WorkflowTask,
    retry: number | undefined,
  ): Promise<{ cwd: string; branch: string; usedWorktree: boolean }> {
    const decision = decideWorkingDirectory(task, live.gitRepo);
    if (decision.kind === 'explicitCwd') {
      // decision.kind==='explicitCwd'はtask.cwdが設定されている場合にしか出ない
      // （decideWorkingDirectoryの実装参照）。ここで無いのは呼び出し元の不整合
      if (task.cwd === undefined) {
        throw new Error('内部矛盾: explicitCwdの判定なのにcwdが無いタスクです');
      }
      // cwdを無検証で通すと、`sandbox: workspace-write` の「workspace」の基準そのものを
      // YAMLから付け替えられる（例: cwdに ~/.ssh を指定すれば、そこが書き込み可能な領域に
      // なる）。design.md §16.16 が塞ぐと決めている経路なので、ここで必ず確かめる。
      // workflow.ts の検証は実パス解決を伴わないためこの判定ができず、実行層の責務になる。
      const resolvedCwd = await this.deps.fs.realpath(task.cwd);
      if (resolvedCwd === undefined) {
        throw new Error(`cwdを解決できませんでした: ${task.cwd}`);
      }
      // 境界側も実パスに直してから比べる。シンボリックリンク越しに外へ出るのを防ぐ
      const resolvedRoot = (await this.deps.fs.realpath(live.repoRoot)) ?? live.repoRoot;
      if (!isPathWithinRoot(resolvedCwd, resolvedRoot)) {
        throw new Error(`cwdがワークスペースの外を指しています（design.md §16.16）: ${task.cwd}`);
      }
      return { cwd: resolvedCwd, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'shared') {
      return { cwd: live.repoRoot, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'sharedFallback') {
      this.deps.log.warn(`[workflow ${live.runId}/${task.id}] ${decision.warning}`);
      return { cwd: live.repoRoot, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'error') {
      throw new Error(decision.message);
    }

    const result = await this.deps.worktreeQueue.create(
      {
        repoRoot: live.repoRoot,
        runId: live.runId,
        taskId: task.id,
        headCommit: live.headCommit,
        retry,
      },
      this.deps.git,
    );
    if (!result.ok) {
      throw new Error(`worktreeの作成に失敗しました: ${result.message}`);
    }
    return { cwd: result.cwd, branch: result.branch, usedWorktree: true };
  }

  private async buildBoundary(
    live: LiveRun,
    cwd: string,
  ): Promise<{ boundary: TaskBoundary; warning: string | undefined }> {
    const result = await buildTaskBoundary([cwd], live.repoRoot, this.deps.git, this.deps.fs);
    return { boundary: result.boundary, warning: result.gitCommonDirWarning };
  }

  // ---- 承認 ----

  private async handleApproval(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    approval: PendingApproval,
    rawParams: Record<string, unknown>,
  ): Promise<ApprovalHandlerResult> {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      // 不整合（起きない想定）。安全側でaskへ倒す
      return { kind: 'ask' };
    }

    const request = await buildEscalationRequest(
      task.provider,
      approval,
      rawParams,
      liveTask.cwd,
      liveTask.lastState?.items ?? [],
      this.deps.fs,
    );
    const policy: EscalationPolicy = {
      escalate: task.escalate,
      allow: task.allow,
      autoApprove: liveTask.autoApprove,
    };
    const result = classifyApprovalRequest(request, liveTask.boundary, policy);
    this.deps.log.info(
      `[workflow ${runId}/${taskId}] 承認判定(${approval.kind}): ${result.decision} - ${result.reasons.join(' / ')}`,
    );

    if (result.decision === 'auto') {
      return { kind: 'auto', decision: 'accept' };
    }

    live.runState = markWaitingApproval(live.runState, taskId);
    void this.persist(runId);
    this.pump(runId);
    return { kind: 'ask' };
  }

  private onApprovalResolved(runId: string, taskId: string, decision: ApprovalDecision): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    if (decision === 'accept' || decision === 'acceptForSession') {
      live.runState = resumeFromApproval(live.runState, taskId);
    } else {
      // decline / cancel。危険操作を人が拒否した。`retries` の自動再試行の対象にしない
      // 専用の経路（design.md §16.5「承認拒否をfailedとして通知してはならない」）
      live.runState = markApprovalRejected(live.runState, live.def.tasks, taskId);
    }
    void this.persist(runId);
    this.pump(runId);
  }

  // ---- 完了検知 ----

  private onTaskStateChanged(runId: string, taskId: string, state: ChatState): void {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      return;
    }
    liveTask.lastState = state;
    // 送信回数はLoopControllerが内部に持ち、TaskSessionからは見えないため、
    // ターン開始（busyの立ち上がり）の回数で近似する
    const startedTurn = !liveTask.wasBusy && state.busy;
    liveTask.wasBusy = state.busy;
    if (startedTurn) {
      liveTask.submissionCount += 1;
      live.runState = recordSubmissionCount(live.runState, taskId, liveTask.submissionCount);
      void this.persist(runId);
    }
  }

  private onTaskFinished(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    reason: LoopStopReason,
    state: ChatState,
  ): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const liveTask = live.tasks.get(taskId);

    if (reason === 'done' && liveTask !== undefined) {
      liveTask.result = {
        result: state.turnResultText,
        cwd: liveTask.cwd,
        branch: liveTask.branch,
        files: [...state.turnEditedFiles],
      };
    }

    live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, reason);

    if (reason !== 'manual' && reason !== 'interrupted') {
      // done / maxReached / failed。セッションを解放する（design.md §16.10の4）。
      // 再試行はここで新しいセッション・worktreeを新規に作るため、古いものは残さない
      liveTask?.session.dispose();
      this.cleanupWorktreeIfNeeded(live, task, taskId, liveTask);
    }

    void this.persist(runId);
    this.pump(runId);
  }

  private cleanupWorktreeIfNeeded(
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
    const retryCount = live.runState.tasks.get(taskId)?.retryCount ?? 0;
    void this.deps.worktreeQueue
      .remove(
        live.repoRoot,
        live.runId,
        taskId,
        retryCount > 0 ? retryCount : undefined,
        this.deps.git,
      )
      .then((result) => {
        if (!result.ok) {
          this.deps.log.warn(
            `[workflow ${live.runId}/${taskId}] worktreeの撤去に失敗しました: ${result.message}`,
          );
        }
      });
  }

  // ---- 永続化 ----

  private async persist(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const tasks: Record<string, PersistedTaskState> = {};
    for (const [id, s] of live.runState.tasks) {
      const liveTask = live.tasks.get(id);
      tasks[id] = {
        state: s.state,
        sessionId: s.sessionId,
        cwd: s.cwd,
        branch: liveTask?.branch,
        submissionCount: s.submissionCount,
        retryCount: s.retryCount,
        failure: s.failure,
      };
    }
    const outcome = getRunOutcome(live.runState);
    await this.deps.store.update(runId, (current) => ({
      runId,
      defPath: live.defPath,
      workspaceRoot: live.repoRoot,
      startedAt: current?.startedAt ?? live.startedAt,
      finishedAt:
        outcome === 'running' ? undefined : (current?.finishedAt ?? new Date().toISOString()),
      tasks,
      haltedByUser: live.runState.haltedByUser,
    }));
  }
}

function issue(message: string, taskIds: string[] = []): WorkflowIssue {
  return { taskIds, message };
}
