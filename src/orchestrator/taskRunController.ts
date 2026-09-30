import { randomUUID } from 'node:crypto';

import type { ModelInfo } from '../codex/modelCatalog';
import type { HandoffClassifierInput } from '../view/handoffClassifier';
import { buildTaskRunKanban, type TaskRunKanbanBoard } from '../view/taskRunKanbanModel';
import { SerialQueue } from './serialQueue';
import { recommendationKey, type TaskRunOrchestratorCall } from './taskRunOrchestratorTools';
import type { RoadmapChild } from './roadmapImport';
import type { RoadmapPlanNode } from './roadmapShared';
import {
  MAX_PLAN_TITLE_LENGTH,
  parsePlanArgs,
  resolveTaskPlan,
  type PlanTaskInput,
} from './taskRunPlan';
import { buildRoadmapInitialPlan, findIssuesOutsideRoadmap, taskIssueNumber } from './taskRunRoadmap';
import type { TaskRunRoadmapPort } from './taskRunRoadmapForge';
import {
  findClosedRoadmapChildren,
  TaskRunRoadmapFollower,
  withRoadmapNotices,
} from './taskRunRoadmapFollower';
import { sanitizeInlineText } from './untrustedText';
import {
  formatTaskRunLeaseHolder,
  formatTaskRunLeaseRejection,
  TASK_LEASE_STALE_MS,
  type TaskRunLease,
  type TaskRunLeasePort,
} from './taskRunLease';
import { escalateQuestionToUser, findStageQuestion } from './taskRunQuestions';
import {
  escalateGateToUser,
  findOpenGate,
  findStageGate,
  GATE_CHOICE_LABELS,
  isGateChoiceAllowed,
  resolveStageGate,
} from './taskRunGates';
import type { ReflexJudgeDeps } from './planReflexReview';
import { reconcileTaskRunOnReload, type TaskExternalFacts } from './taskRunReload';
import {
  decideStageStart,
  listResumingStages,
  type StageRef,
  type StartStageRejection,
} from './taskRunScheduler';
import {
  approveTaskPlan,
  createTaskRun,
  currentStage,
  finishTaskRun,
  getTask,
  isTaskDone,
  isTaskRunActive,
  isValidMaxParallel,
  listTasks,
  markStagePaused,
  MAX_TASK_RUN_PARALLEL,
  proposeTaskPlan,
  recordStageDecision,
  reopenTaskRun,
  resetStageForRetry,
  resumeTaskRun,
  setTaskPlanReview,
  setTaskRunHaltedByUser,
  setTaskRunMaxParallel,
  setTaskRunTitle,
  suspendTaskRun,
  taskRunLabel,
  type StageDecision,
  type StageGateChoice,
  type TaskRun,
  type TaskRunEngine,
} from './taskRunState';
import { reviewTaskRunPlanProposal } from './taskRunPlanReview';
import type { TaskRunStore } from './taskRunStore';
import type { StageObservationPorts } from './taskStageObservation';
import type { PauseStageOutcome, TaskStageRunner } from './taskStageRunner';
import {
  buildStageClassifierInput,
  checkStageSettings,
  type StageSettingsRecommendation,
} from './taskStageSettings';

/**
 * オーケストレータモード（Issue #1505）のController。Orchestratorの命令（MCPツール）と
 * ユーザーの操作（計画の承認）を受け、妥当な状態遷移だけを`TaskRun`へ反映する。
 *
 * - 状態の遷移は`taskRunState.ts`の純粋関数だけで行い、検証は`taskRunPlan.ts`・
 *   `taskRunScheduler.ts`・`taskStageSettings.ts`に任せる
 * - 工程セッションの開始・停止・指示・質問への回答は`TaskStageRunner`へ委ねる
 * - 状態が変わるたびに前後のrunを`onTransition`の購読者へ渡す（Orchestratorへのイベントの元）
 */

// resume_stageの応答へ載せる失敗理由の上限。get_run_stateの「理由:」と同じ長さで切る
const RESUME_FAILURE_MAX_LENGTH = 1000;

const PAUSE_REJECTIONS: Record<Exclude<PauseStageOutcome, { ok: true }>['reason'], string> = {
  noSession: '工程セッションが動いていない',
  mergeCleanup: 'mergeとcleanupはmergeの鍵を持つため一時停止できない',
  finishing: '工程が報告済み・止めている途中・一時停止の受付済み',
  alreadyPaused: '既に一時停止している',
};

export type ControllerResult = { ok: true; message: string } | { ok: false; message: string };

export type StartTaskRunOutcome =
  | { ok: true; runId: string; reused: boolean }
  | { ok: false; message: string };

export interface TaskRunControllerDeps {
  store: Pick<TaskRunStore, 'find' | 'update' | 'list' | 'listActive'>;
  runner: Pick<
    TaskStageRunner,
    | 'pump'
    | 'stopStage'
    | 'stopLiveStagesOfRun'
    | 'pauseStage'
    | 'resumeStage'
    | 'instructStage'
    | 'answerQuestion'
    | 'cleanupRestoredTask'
  >;
  /** エンジンのモデル一覧と、カタログからeffortを取れないときの退避先。 */
  modelCatalog(engine: TaskRunEngine): {
    models: readonly ModelInfo[];
    fallbackEfforts: readonly string[];
  };
  /**
   * 工程の推奨値を求める（実体は`proposeHandoffModelSettings`）。求められなければ`undefined`。
   * 判定はvscodeの設定を読むため依存で受ける。
   */
  recommendStageSettings(
    engine: TaskRunEngine,
    input: HandoffClassifierInput,
  ): Promise<StageSettingsRecommendation | undefined>;
  /** 計画で指定された既存のIssueがopenかを確かめる。再読み込み後の復元ではPRの状態も見る。 */
  observation: Pick<StageObservationPorts, 'fetchIssueState' | 'fetchPullRequestState'>;
  /**
   * 再読み込み後の復元で、記録したworktreeが残っているかを確かめる。無ければ`false`、
   * 確かめられなければreject（消えたと誤判定しないため）。
   */
  pathExists(path: string): Promise<boolean>;
  log(message: string): void;
  now?: () => Date;
  newId?: () => string;
  /**
   * 計画の提案をReflexで判定し、自動承認する（Issue #1554）。設定
   * `agent.taskRun.planAutoApprove.enabled`が無効なら`undefined`（判定を試みずに承認待ちのまま）。
   */
  planAutoApprove(engine: TaskRunEngine): { reflex: ReflexJudgeDeps; threshold: number } | undefined;
  /** ロードマップIssueの読み書き（Issue #1623）。無ければ実行中の追従と書き戻しをしない。 */
  roadmap?: TaskRunRoadmapPort;
  /**
   * runごとのウィンドウ専有権（Issue #1628）。無ければ専有権の確認をせず全ウィンドウで操作できる
   * （テスト用のフェイクdepsを壊さないための省略可能な依存注入。`roadmap`と同じパターン）。
   */
  lease?: TaskRunLeasePort;
}

export type TaskRunTransitionListener = (prev: TaskRun | undefined, next: TaskRun) => void;

const REJECTION_MESSAGES: Record<StartStageRejection, string> = {
  unknownTask: 'そのタスクは計画に無い',
  planNotApproved: '計画がまだユーザーに承認されていない',
  runFinished: 'このrunは終わっている',
  taskDone: 'このタスクはすべての工程を終えている',
  notCurrentStage: 'その工程はこのタスクの現在の工程ではない（get_run_stateで現在の工程を確かめる）',
  alreadyRunning: 'その工程は既に実行中',
  paused: 'その工程は一時停止中（続けるならresume_stageで再開する）',
  halted: 'このタスクは停止処理中、またはユーザーの対応を待っている',
  gatePending:
    'このタスクには、Reflexが判定中またはユーザーの判断待ちの関門がある（ユーザーの判断はresolve_gateで渡す）',
  dependenciesUnmet: '依存先のタスクが終わっていない',
};

export class TaskRunController {
  /** 最後に購読者へ渡したrun。差分の起点にする。 */
  private readonly lastSeen = new Map<string, TaskRun>();
  private readonly listeners = new Set<TaskRunTransitionListener>();
  /** 求めている途中・求め終えた推奨値。キーは`runId`と`recommendationKey`。 */
  private readonly recommending = new Map<string, Promise<StageSettingsRecommendation | undefined>>();
  private readonly recommended = new Map<string, Map<string, StageSettingsRecommendation>>();
  /** runの開始と再開を直列にする。動いているrunの確認と作成の間に別の開始が割り込まないため。 */
  private readonly startQueue = new SerialQueue();

  /** ロードマップIssueから始めたrunの、ロードマップへの追従と書き戻し（Issue #1623）。 */
  private readonly roadmapFollower: TaskRunRoadmapFollower | undefined;

  constructor(private readonly deps: TaskRunControllerDeps) {
    this.roadmapFollower =
      deps.roadmap === undefined
        ? undefined
        : new TaskRunRoadmapFollower({
            port: deps.roadmap,
            find: (runId) => this.deps.store.find(runId),
            updateRun: (runId, fn) => this.updateRun(runId, fn),
            fetchIssueState: (root, n) => this.deps.observation.fetchIssueState(root, n),
            log: (message) => this.deps.log(message),
            now: () => this.now(),
            newId: () => this.newId(),
          });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  find(runId: string): TaskRun | undefined {
    return this.deps.store.find(runId);
  }

  onTransition(listener: TaskRunTransitionListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * runの状態が変わった。Controller自身の更新と、Runnerの`onRunChanged`の両方から呼ぶ。
   * 前回渡したrunとの差分を購読者へ渡す。
   */
  handleRunChanged(next: TaskRun): void {
    const prev = this.lastSeen.get(next.runId);
    this.lastSeen.set(next.runId, next);
    this.roadmapFollower?.observe(prev, next);
    for (const listener of this.listeners) {
      try {
        listener(prev, next);
      } catch (e: unknown) {
        this.deps.log(`[task run] 状態の通知に失敗しました: ${String(e)}`);
      }
    }
  }

  /**
   * Kanban画面へ現在の状態を強制的に再通知する（Orchestratorの`refresh_kanban`ツール）。
   *
   * 状態変更は`updateRun`が`handleRunChanged`を都度呼ぶため通常は自動で反映されるが、
   * webview側の描画が古いまま止まって見える場合の手動リカバリ手段として設ける。
   * runが見つからなければ何もしない。
   */
  refreshKanban(runId: string): void {
    const run = this.deps.store.find(runId);
    if (run !== undefined) {
      this.handleRunChanged(run);
    }
  }

  /**
   * このウィンドウがrunの専有権を持っているか確かめ、持っていなければ取る（Issue #1628）。
   * run状態を書き換える操作（計画の変更・承認、工程の起動・停止・一時停止・指示、質問への回答、
   * 関門の決着、runの一時停止・終了・中断・再開、並列上限の変更）の共通の関門にする（Issue #1636）。
   * 工程セッションと質問の待ち受けは専有権を持つウィンドウにしか無く、他のウィンドウから
   * 状態だけを書き換えると動いている工程と食い違うため。例外はrunの名前変更（`setTitle`）だけ。
   * `lease`未設定（テスト等）なら常に許可する。
   */
  async ensureLease(runId: string): Promise<ControllerResult> {
    if (this.deps.lease === undefined || this.deps.lease.holds(runId)) {
      return { ok: true, message: '' };
    }
    const outcome = await this.deps.lease.acquire(runId);
    if (outcome.ok) {
      return { ok: true, message: '' };
    }
    return { ok: false, message: formatTaskRunLeaseRejection(outcome.holder, this.now()) };
  }

  /**
   * Kanban表示用。このウィンドウが専有権を持たず、かつ別のウィンドウが持っているように
   * 見えるときだけ、持ち主の説明文を返す（Issue #1628）。PIDの生死までは確かめず、
   * heartbeatの新しさだけで簡易に判定する（正確な判定は`ensureLease`が操作の直前に行う）。
   */
  async leaseStatus(runId: string): Promise<{ heldByOther: boolean; holderText?: string }> {
    if (this.deps.lease === undefined || this.deps.lease.holds(runId)) {
      return { heldByOther: false };
    }
    const lease = await this.deps.lease.peek(runId);
    if (lease === undefined) {
      return { heldByOther: false };
    }
    const age = this.now().getTime() - Date.parse(lease.heartbeatAt);
    if (!Number.isFinite(age) || age >= TASK_LEASE_STALE_MS) {
      return { heldByOther: false };
    }
    return { heldByOther: true, holderText: formatTaskRunLeaseHolder(lease, this.now()) };
  }

  /**
   * 専有権を明示的にこのウィンドウへ移す（受入基準4）。動作中のウィンドウからも無条件で奪う。
   */
  async transferLease(runId: string): Promise<ControllerResult> {
    if (this.deps.lease === undefined) {
      return { ok: false, message: '専有権の仕組みが無効になっている' };
    }
    await this.deps.lease.forceAcquire(runId);
    this.refreshKanban(runId);
    return { ok: true, message: '専有権をこのウィンドウへ移した' };
  }

  /**
   * 持っていた専有権を別のウィンドウに取られた（`TaskRunLeaseManager`のheartbeatが検知して
   * 呼ぶ）。このウィンドウで動いている工程セッションは止める（Issue #1636。理由は
   * `TaskStageRunner.stopLiveStagesOfRun`）。止めた工程は移した先のウィンドウで「やり直す」から始め直す。
   */
  handleLeaseLost(runId: string, holder: TaskRunLease | undefined): void {
    this.deps.log(`[task run] ${runId}の専有権を${formatTaskRunLeaseHolder(holder, this.now())}に取られた`);
    this.refreshKanban(runId);
    void this.deps.runner
      .stopLiveStagesOfRun(runId, '専有権が別のウィンドウへ移ったため止めました')
      .then((count) => {
        if (count > 0) {
          this.deps.log(`[task run] ${runId}の専有権を失ったため、動いていた工程を${String(count)}件止めた`);
        }
      })
      .catch((e: unknown) => {
        this.deps.log(`[task run] ${runId}の専有権を失った後、工程を止められませんでした: ${String(e)}`);
      });
  }

  /** 状態を純粋関数で進めて永続化する。runが無ければ`undefined`。 */
  async updateRun(runId: string, fn: (run: TaskRun) => TaskRun): Promise<TaskRun | undefined> {
    if (this.deps.store.find(runId) === undefined) {
      return undefined;
    }
    let changed = false;
    const next = await this.deps.store.update(runId, (current) => {
      if (current === undefined) {
        throw new Error(`task runが見つかりません: ${runId}`);
      }
      const updated = fn(current);
      changed = updated !== current;
      return updated;
    });
    if (changed) {
      this.handleRunChanged(next);
    }
    return next;
  }

  /** 求め終えた推奨値（`get_run_state`の表示用）。 */
  recommendations(runId: string): ReadonlyMap<string, StageSettingsRecommendation> {
    return this.recommended.get(runId) ?? new Map();
  }

  /**
   * 工程の推奨値を求める。同じ工程は1回だけ求めてキャッシュする。求められなければ
   * `undefined`（Orchestratorは推奨値なしで決める）。
   */
  recommend(runId: string, ref: StageRef): Promise<StageSettingsRecommendation | undefined> {
    const key = recommendationKey(ref.taskId, ref.stage);
    const cacheKey = `${runId}#${key}`;
    const cached = this.recommending.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const run = this.deps.store.find(runId);
    const task = run === undefined ? undefined : getTask(run, ref.taskId);
    if (run === undefined || task === undefined) {
      return Promise.resolve(undefined);
    }
    const pending = this.deps
      .recommendStageSettings(run.engine, buildStageClassifierInput(run, task, ref.stage))
      .then((value) => {
        if (value !== undefined) {
          const perRun = this.recommended.get(runId) ?? new Map<string, StageSettingsRecommendation>();
          perRun.set(key, value);
          this.recommended.set(runId, perRun);
        }
        return value;
      })
      .catch((e: unknown) => {
        this.deps.log(`[task run] ${ref.taskId}の${ref.stage}の推奨値を求められませんでした: ${String(e)}`);
        // 失敗は覚えない（次に判断を待つときに求め直す）
        this.recommending.delete(cacheKey);
        return undefined;
      });
    this.recommending.set(cacheKey, pending);
    return pending;
  }

  private forgetRecommendation(runId: string, ref: StageRef): void {
    const key = recommendationKey(ref.taskId, ref.stage);
    this.recommending.delete(`${runId}#${key}`);
    this.recommended.get(runId)?.delete(key);
  }

  private pumpLater(runId: string): void {
    void this.deps.runner.pump(runId).catch((e: unknown) => {
      this.deps.log(`[task run] ${runId}の工程を始められませんでした: ${String(e)}`);
    });
  }

  /**
   * 計画の提案（`propose_plan`）。検証を通れば承認待ちにし、仮キーと採番した`taskId`の
   * 対応を返す。承認済みの計画を変えた場合も承認待ちへ戻る。
   *
   * `planAutoApprove`が有効なら、書き込み前（forgeへの問い合わせと同様、直列書き込みの外）に
   * Reflexで計画を判定する（Issue #1554）。判定は書き込みの直列に入る前の内容に対して行うため、
   * 書き込み時に同じ内容へ解決できたときだけ承認まで進める（待っている間に他の変更が割り込んで
   * いれば、判定済みの内容と食い違うため承認待ちへ戻す。ロードマップ計画審査
   * `roadmapPlanProposal.ts`と同じ判定器・同じ既定閾値を使う）。
   */
  async proposePlan(runId: string, rawArgs: unknown): Promise<ControllerResult> {
    const parsed = parsePlanArgs(rawArgs);
    if (!parsed.ok) {
      return parsed;
    }
    return this.applyPlan(runId, parsed.value);
  }

  /**
   * 形式の検証を済ませた計画を受け付ける（`proposePlan`と、ロードマップIssueから作る初期計画
   * `startRoadmapRun`が共有する。Issue #1623）。Issueの検証とReflex審査は両者で同じ。
   */
  private async applyPlan(runId: string, tasks: readonly PlanTaskInput[]): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const current = this.deps.store.find(runId);
    const issueProblem =
      (current === undefined ? undefined : this.findIssueConflict(current, tasks)) ??
      (await this.checkExistingIssues(runId, tasks));
    if (issueProblem !== undefined) {
      return { ok: false, message: `計画を受け付けられない: ${issueProblem}` };
    }
    const review = await this.reviewPlanIfEnabled(current, tasks);
    let failure: string | undefined;
    let assigned: ReadonlyMap<string, string> = new Map();
    let autoApproved = false;
    const next = await this.updateRun(runId, (r) => {
      // forgeへの問い合わせの間に別のrunが同じIssueを計画へ入れていないか、書き込みの直列の中で確かめ直す
      const conflict = this.findIssueConflict(r, tasks);
      if (conflict !== undefined) {
        failure = conflict;
        return r;
      }
      const resolved = resolveTaskPlan(r, tasks);
      if (!resolved.ok) {
        failure = resolved.message;
        return r;
      }
      assigned = resolved.value.assigned;
      try {
        let proposed = proposeTaskPlan(
          withOutsideRoadmapWarning(r, resolved.value.run, tasks, this.now(), () => this.newId()),
          resolved.value.drafts,
          () => this.newId(),
          this.now(),
        );
        if (review !== undefined) {
          // Reflexへ渡した内容から書き込み時までに変わっていなければ判定を適用する
          const unchanged = JSON.stringify(resolved.value.drafts) === review.reviewedDrafts;
          proposed = setTaskPlanReview(proposed, {
            autoApproved: unchanged && review.verdict.kind === 'approved',
            summary: review.verdict.summary,
            reviewedAt: this.now().toISOString(),
          });
          if (unchanged && review.verdict.kind === 'approved') {
            proposed = approveTaskPlan(proposed);
            autoApproved = true;
          }
        } else {
          // 判定を試みていない（設定が無効、またはrunが無い）。前回の判定結果を残さない
          proposed = setTaskPlanReview(proposed, undefined);
        }
        return proposed;
      } catch (e: unknown) {
        failure = e instanceof Error ? e.message : String(e);
        return r;
      }
    });
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (failure !== undefined) {
      return { ok: false, message: `計画を受け付けられない: ${failure}` };
    }
    if (autoApproved) {
      this.pumpLater(runId);
    }
    const mapping = [...assigned].map(([key, taskId]) => `${key} → ${taskId}`).join(', ');
    return {
      ok: true,
      message: [
        autoApproved
          ? `計画を受け付け、Reflexの判定により自動承認した（${String(next.taskOrder.length)}タスク）。工程を始める。`
          : `計画を受け付けた（${String(next.taskOrder.length)}タスク）。ユーザーの承認を待っている。承認されるまで工程は始まらない。`,
        mapping === '' ? '新しいタスクは無い。' : `採番したtaskId: ${mapping}`,
      ].join('\n'),
    };
  }

  /**
   * `planAutoApprove`が有効なら、提案された計画をReflexで判定する。無効・runが無い・計画の
   * 検証に通らない場合は`undefined`（判定を試みない。検証エラーは後続の`updateRun`内の
   * `resolveTaskPlan`が理由を返す）。
   */
  private async reviewPlanIfEnabled(
    current: TaskRun | undefined,
    tasks: readonly PlanTaskInput[],
  ): Promise<{ verdict: Awaited<ReturnType<typeof reviewTaskRunPlanProposal>>; reviewedDrafts: string } | undefined> {
    if (current === undefined) {
      return undefined;
    }
    const config = this.deps.planAutoApprove(current.engine);
    if (config === undefined) {
      return undefined;
    }
    const resolved = resolveTaskPlan(current, tasks);
    if (!resolved.ok) {
      return undefined;
    }
    const verdict = await reviewTaskRunPlanProposal(config.reflex, resolved.value.drafts, config.threshold);
    return { verdict, reviewedDrafts: JSON.stringify(resolved.value.drafts) };
  }

  /**
   * 計画で新しく指定された既存のIssueが、forgeにopenで存在するかを確かめる。問題があれば理由を返す。
   * すでに計画にあるタスクのIssueは確かめない（mergeでcloseされたIssueを持つ完了済みのタスクを含む
   * 計画の変更を拒まないため）。
   */
  private async checkExistingIssues(
    runId: string,
    tasks: readonly PlanTaskInput[],
  ): Promise<string | undefined> {
    const run = this.deps.store.find(runId);
    // 構造の不正はこの後のresolveTaskPlanが理由を返すので、forgeへ問い合わせない
    if (run === undefined || !resolveTaskPlan(run, tasks).ok) {
      return undefined;
    }
    const known = new Set(listTasks(run).map((t) => t.existingIssueNumber));
    const numbers = [
      ...new Set(
        tasks
          // ロードマップで完了済みの子Issue（Issue #1623）はcloseされていてよい
          .filter((t) => t.completedInRoadmap !== true)
          .map((t) => t.existingIssueNumber)
          .filter((n): n is number => n !== undefined && !known.has(n)),
      ),
    ];
    const states = await Promise.all(
      numbers.map((n) => this.deps.observation.fetchIssueState(run.workspaceRoot, n)),
    );
    const problems = numbers.flatMap((n, i) => {
      const state = states[i];
      if (state === 'open') {
        return [];
      }
      return [
        state === 'closed'
          ? `既存のIssue #${String(n)}はcloseされている`
          : `既存のIssue #${String(n)}を確かめられない（存在しないか、forgeへ問い合わせられない）`,
      ];
    });
    return problems.length === 0 ? undefined : problems.join('。');
  }

  /**
   * 同じフォルダの終わっていない別のrunが、まだ終えていないタスクで扱っている既存のIssueを、
   * 計画が指定していないか（Issue #1562）。同じIssueを2本のrunで実装しないように、見つかれば理由を返す。
   * `tasks`を省くと、run自身の計画にあるタスクを確かめる（承認時の再確認）。runをまたいで確認と
   * 書き込みの間に割り込まれないよう、`updateRun`の更新関数の中（storeの書き込みの直列の中）で呼ぶ。
   */
  private findIssueConflict(run: TaskRun, tasks?: readonly PlanTaskInput[]): string | undefined {
    const plannedIssueNumbers = new Set(
      (tasks ?? listTasks(run))
        // ロードマップで完了済みの子Issue（Issue #1623）は実装しないため、他のrunと重なってよい
        .filter((t) => t.completedInRoadmap !== true)
        .map((t) => t.existingIssueNumber)
        .filter((n): n is number => n !== undefined),
    );
    for (const other of this.deps.store.list()) {
      if (other.runId === run.runId || other.workspaceRoot !== run.workspaceRoot || other.finishedAt !== undefined) {
        continue;
      }
      for (const task of listTasks(other)) {
        if (isTaskDone(task)) {
          continue;
        }
        const takenIssueNumber = [task.existingIssueNumber, task.issueNumber].find(
          (n): n is number => n !== undefined && plannedIssueNumbers.has(n),
        );
        if (takenIssueNumber !== undefined) {
          return `既存のIssue #${String(takenIssueNumber)}は別のrun「${taskRunLabel(other)}」が扱っている`;
        }
      }
    }
    return undefined;
  }

  /**
   * 計画を承認する（Kanbanのボタン、またはOrchestratorの`approve_plan`ツールから呼ぶ）。
   * 提案の後に別のrunが同じIssueを扱い始めていれば承認しない（Issue #1562）。
   */
  async approvePlan(runId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const run = this.deps.store.find(runId);
    if (run?.planStatus !== 'awaitingApproval') {
      return { ok: false, message: '承認待ちの計画がありません' };
    }
    let conflict: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      conflict = this.findIssueConflict(r);
      return conflict === undefined ? approveTaskPlan(r) : r;
    });
    if (conflict !== undefined) {
      return { ok: false, message: `計画を承認できません: ${conflict}。Orchestratorに計画を直させてください` };
    }
    if (next?.planStatus !== 'approved') {
      return { ok: false, message: '承認待ちの計画がありません' };
    }
    this.pumpLater(runId);
    return { ok: true, message: '計画を承認した' };
  }

  /**
   * runを始める。同じフォルダに動いているrunがあれば、新しく作らずにそのうち1本を返す。
   * `parallel`なら動いているrunがあっても新しく作り、並行して動かす（Issue #1562）。
   */
  startRun(input: {
    workspaceRoot: string;
    engine: TaskRunEngine;
    maxParallel: number;
    /** 表示名（Issue #1561）。空なら付けない。既存のrunを返すときは使わない。 */
    title?: string;
    /** 動いているrunを再利用せず、並行して新しく始める（Issue #1562）。 */
    parallel?: boolean;
  }): Promise<StartTaskRunOutcome> {
    return this.startQueue.enqueue(async (): Promise<StartTaskRunOutcome> => {
      const active = this.deps.store.listActive(input.workspaceRoot)[0];
      if (active !== undefined && input.parallel !== true) {
        return { ok: true, runId: active.runId, reused: true };
      }
      if (!isValidMaxParallel(input.maxParallel)) {
        return { ok: false, message: `並列上限は1〜${String(MAX_TASK_RUN_PARALLEL)}の整数で指定する` };
      }
      const run = createTaskRun({
        workspaceRoot: input.workspaceRoot,
        engine: input.engine,
        maxParallel: input.maxParallel,
        ...(input.title === undefined ? {} : { title: input.title }),
        runId: this.newId(),
        now: this.now(),
      });
      await this.deps.store.update(run.runId, () => run);
      this.handleRunChanged(run);
      return { ok: true, runId: run.runId, reused: false };
    });
  }

  /**
   * 同じフォルダで同じロードマップIssueを対象にする、終わっていないrun（中断中を含む。Issue #1623）。
   */
  findRoadmapRun(workspaceRoot: string, roadmapIssueNumber: number): TaskRun | undefined {
    return this.listInFolder(workspaceRoot).find(
      (r) => r.finishedAt === undefined && r.roadmap?.issueNumber === roadmapIssueNumber,
    );
  }

  /**
   * ロードマップIssueから始める（Issue #1623）。子Issueをタスクにした初期計画を`propose_plan`と
   * 同じ経路（`applyPlan`）で受け付ける。同じロードマップIssueの終わっていないrunがあれば新しく作らず
   * それを返す。他のrunとは並行して動かす（同じIssueの重複は`findIssueConflict`が防ぐ）。
   * 初期計画が受け付けられなくてもrunは作り、理由を`planMessage`で返す（Orchestratorが提案し直す）。
   */
  async startRoadmapRun(input: {
    workspaceRoot: string;
    engine: TaskRunEngine;
    maxParallel: number;
    title?: string;
    roadmapIssueNumber: number;
    roadmapTitle: string;
    children: readonly RoadmapChild[];
    planNodes: readonly RoadmapPlanNode[] | undefined;
    /** 計画区画の中身のハッシュ。区画が無い・読めないときは`undefined`。 */
    planSectionHash: string | undefined;
  }): Promise<StartTaskRunOutcome & { planMessage?: ControllerResult }> {
    const closedIssueNumbers = await findClosedRoadmapChildren(
      (n) => this.deps.observation.fetchIssueState(input.workspaceRoot, n),
      input.children,
    );
    const plan = buildRoadmapInitialPlan({
      roadmapIssueNumber: input.roadmapIssueNumber,
      children: input.children,
      planNodes: input.planNodes,
      planSectionHash: input.planSectionHash,
      closedIssueNumbers,
      now: this.now(),
    });
    const started = await this.startQueue.enqueue(async (): Promise<StartTaskRunOutcome> => {
      const existing = this.findRoadmapRun(input.workspaceRoot, input.roadmapIssueNumber);
      if (existing !== undefined) {
        return { ok: true, runId: existing.runId, reused: true };
      }
      if (!isValidMaxParallel(input.maxParallel)) {
        return { ok: false, message: `並列上限は1〜${String(MAX_TASK_RUN_PARALLEL)}の整数で指定する` };
      }
      const run = createTaskRun({
        workspaceRoot: input.workspaceRoot,
        engine: input.engine,
        maxParallel: input.maxParallel,
        ...(input.title === undefined ? {} : { title: input.title }),
        roadmap: {
          issueNumber: input.roadmapIssueNumber,
          title: sanitizeInlineText(input.roadmapTitle, MAX_PLAN_TITLE_LENGTH),
          snapshot: plan.snapshot,
        },
        runId: this.newId(),
        now: this.now(),
      });
      await this.deps.store.update(run.runId, () => run);
      this.handleRunChanged(run);
      return { ok: true, runId: run.runId, reused: false };
    });
    if (!started.ok || started.reused) {
      return started;
    }
    return { ...started, planMessage: await this.applyPlan(started.runId, plan.tasks) };
  }

  /**
   * ロードマップを読み直す（Kanbanの「ロードマップを読み直す」とOrchestratorの`sync_roadmap`。
   * Issue #1623）。差分は`run.roadmap.notices`へ足し、Orchestratorへはイベントで届く。計画は変えない。
   */
  async syncRoadmap(runId: string): Promise<ControllerResult> {
    if (this.roadmapFollower === undefined) {
      return { ok: false, message: 'ロードマップIssueを読み書きできない' };
    }
    return this.roadmapFollower.sync(runId);
  }

  /** タスクのmergeと後片付けが済んだ（Runnerの`onTaskMerged`）。ロードマップの行を`[x]`にする。 */
  handleTaskMerged(runId: string, taskId: string): void {
    this.roadmapFollower?.handleTaskMerged(runId, taskId);
  }

  /** run全体の一時停止と再開（Kanbanから）。停止中は新しい工程を始めない。実行中の工程は止めない。 */
  async setHalted(runId: string, halted: boolean): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    // 中断中のrunは再開（`resumeRun`）で一時停止を解く
    const next = await this.updateRun(runId, (r) =>
      isTaskRunActive(r) ? setTaskRunHaltedByUser(r, halted) : r,
    );
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (!halted) {
      this.pumpLater(runId);
    }
    return { ok: true, message: halted ? 'runを一時停止した' : 'runの一時停止を解いた' };
  }

  /**
   * runの表示名を付け替える（Issue #1561）。空なら名前を外す。runが無ければ`false`。
   * 表示だけの変更で工程の動きに関わらないため、専有権を持たないウィンドウからも受け付ける
   * （Issue #1636。他の書き換えは`ensureLease`で専有権を持つウィンドウに限る）。
   */
  async setTitle(runId: string, title: string): Promise<boolean> {
    return (await this.updateRun(runId, (r) => setTaskRunTitle(r, title))) !== undefined;
  }

  /** 同じフォルダの動いているrun（並行して動かせるため複数ありうる）。中断中のrunは含まない。 */
  listActive(workspaceRoot: string): TaskRun[] {
    return this.deps.store.listActive(workspaceRoot);
  }

  /** 同じフォルダのrun（中断中・終了を含む。保存の上限で消えたrunは含まない）。 */
  listInFolder(workspaceRoot: string): TaskRun[] {
    return this.deps.store.list().filter((r) => r.workspaceRoot === workspaceRoot);
  }

  /**
   * 人がrunを終える（Issue #1558）。先に一時停止して新しい工程を始めないようにし、動いている
   * 工程セッションを止めてから`finishedAt`を立てる。Orchestratorのセッションは呼び出し側が閉じる。
   */
  async finishRun(runId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const halted = await this.updateRun(runId, (r) =>
      r.finishedAt === undefined ? setTaskRunHaltedByUser(r, true) : r,
    );
    if (halted === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (halted.finishedAt !== undefined) {
      return { ok: true, message: 'runは終わっている' };
    }
    await this.stopRunningStages(halted);
    await this.updateRun(runId, (r) => finishTaskRun(r, this.now()));
    await this.deps.lease?.release(runId);
    return { ok: true, message: 'runを終えた' };
  }

  /**
   * 人がrunを中断する（Issue #1560）。`finishRun`と同じ手順で、`finishedAt`の代わりに中断を立てる。
   * worktreeとブランチは残す。Orchestratorのセッションは呼び出し側が閉じる。
   * 既に中断しているrunには`ok: true`を返す（冪等）。「開始」の選択肢やKanbanでのrunの入れ替えは、
   * 中断の成否だけを見て次へ進むため、別の操作が先に中断していても失敗扱いにしない（Issue #1565）。
   */
  async suspendRun(runId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const halted = await this.updateRun(runId, (r) =>
      isTaskRunActive(r) ? setTaskRunHaltedByUser(r, true) : r,
    );
    if (halted === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (halted.finishedAt !== undefined) {
      return { ok: false, message: 'runは終わっている' };
    }
    if (halted.suspendedAt !== undefined) {
      return { ok: true, message: 'runは中断している' };
    }
    // 一時停止中の工程はセッションが無いため止めず、一時停止のまま残す（Issue #1629）
    await this.stopRunningStages(halted, { keepPaused: true });
    await this.updateRun(runId, (r) => suspendTaskRun(r, this.now()));
    await this.deps.lease?.release(runId);
    return { ok: true, message: 'runを中断した' };
  }

  /**
   * 中断したrunを再開する（Issue #1560）。同じフォルダに動いているrunがあれば、`parallel`のときだけ
   * 並行して再開し（Issue #1562）、それ以外は拒否する（呼び出し側が先にそちらを中断させる）。
   * 中断で止めた工程は自動では始めず、「やり直す」かOrchestratorの判断で動かす。Orchestratorは
   * 呼び出し側が開く。
   */
  resumeRun(runId: string, options: { parallel?: boolean } = {}): Promise<ControllerResult> {
    // `startRun`と同じキューに通し、動いているrunの確認と再開の間に別のrunが割り込まないようにする
    return this.startQueue.enqueue(async (): Promise<ControllerResult> => {
      const run = this.deps.store.find(runId);
      if (run === undefined) {
        return { ok: false, message: 'runが見つからない' };
      }
      if (run.finishedAt !== undefined) {
        return { ok: false, message: 'runは終わっている' };
      }
      if (run.suspendedAt === undefined) {
        return { ok: true, message: 'runは中断していない' };
      }
      if (options.parallel !== true && this.deps.store.listActive(run.workspaceRoot).length > 0) {
        return { ok: false, message: 'このフォルダには動いているrunがある。先にそのrunを中断する' };
      }
      const leased = await this.ensureLease(runId);
      if (!leased.ok) {
        return leased;
      }
      await this.updateRun(runId, (r) =>
        r.finishedAt === undefined ? setTaskRunHaltedByUser(resumeTaskRun(r), false) : r,
      );
      this.pumpLater(runId);
      return { ok: true, message: 'runを再開した' };
    });
  }

  /**
   * 終わったrunか中断中のrunを、同じフォルダの動いているrunと並行して再び動かす（Issue #1620）。
   * `finishedAt`と中断を外して一時停止を解く。終了・中断で止めた工程は自動では始めず、
   * 「やり直す」かOrchestratorの判断で動かす。`finishRun`はworktreeとブランチを片付けないため、
   * 工程はそのまま続けられる。Orchestratorは呼び出し側が開く。
   */
  reopenRun(runId: string): Promise<ControllerResult> {
    // `startRun`・`resumeRun`と同じキューに通す
    return this.startQueue.enqueue(async (): Promise<ControllerResult> => {
      const run = this.deps.store.find(runId);
      if (run === undefined) {
        return { ok: false, message: 'runが見つからない' };
      }
      if (isTaskRunActive(run)) {
        return { ok: false, message: 'runは動いている' };
      }
      const leased = await this.ensureLease(runId);
      if (!leased.ok) {
        return leased;
      }
      await this.updateRun(runId, (r) =>
        isTaskRunActive(r) ? r : setTaskRunHaltedByUser(reopenTaskRun(r, this.now()), false),
      );
      this.pumpLater(runId);
      return { ok: true, message: 'runを再開した' };
    });
  }

  /** 実行中の工程セッションを止める。先に一時停止にして、新しい工程を始めない状態で呼ぶ。 */
  private async stopRunningStages(
    run: TaskRun,
    options: { keepPaused?: boolean } = {},
  ): Promise<void> {
    if (options.keepPaused === true) {
      // 再開を受け付けて開き直す前の工程は一時停止へ戻す。runを再開しても勝手に開き直さない
      for (const task of listTasks(run)) {
        if (task.pause?.phase === 'resuming') {
          await this.updateRun(run.runId, (r) => markStagePaused(r, task.taskId, this.now()));
        }
      }
    }
    const running = listTasks(run).filter((task) => {
      const stage = currentStage(task);
      const paused = task.pause !== undefined && task.pause.phase !== 'requested';
      return (
        stage !== undefined &&
        task.stages[stage].status === 'running' &&
        !(options.keepPaused === true && paused)
      );
    });
    // 1つの工程で止め損ねても、残りの工程を止めて終了・中断まで進める
    const results = await Promise.allSettled(
      running.map((task) => this.deps.runner.stopStage(run.runId, task.taskId)),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.deps.log(
          `[task run] ${running[i]?.taskId ?? ''}の工程を止められませんでした: ${String(result.reason)}`,
        );
      }
    });
  }

  /**
   * 止まった工程をやり直せる状態へ戻す（Kanbanから）。工程は未着手に戻り、Orchestratorが
   * 設定を決め直すのを待つ（判断待ちのイベントがOrchestratorへ届く）。失敗の関門が開いていれば、
   * ユーザーの「やり直す」判断として決着させる（Reflexの判定より優先する）。
   */
  async retryStage(runId: string, taskId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    let rejection: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      const task = getTask(r, taskId);
      const stage = task === undefined ? undefined : currentStage(task);
      if (r.finishedAt !== undefined) {
        rejection = 'このrunは終わっている';
        return r;
      }
      if (r.suspendedAt !== undefined) {
        rejection = 'このrunは中断している。先に再開する';
        return r;
      }
      if (task === undefined || stage === undefined || task.stages[stage].status !== 'halted') {
        rejection = '止まっている工程が無い';
        return r;
      }
      if (task.attention === 'stopping') {
        rejection = '停止処理中';
        return r;
      }
      const gate = findOpenGate(task);
      if (gate === undefined) {
        return resetStageForRetry(r, taskId, this.now());
      }
      if (gate.kind === 'reviewFindings') {
        rejection = 'レビューの関門を先に決着させる（差し戻す、または指摘を残したまま進める）';
        return r;
      }
      const resolved = resolveStageGate(r, taskId, gate.gateId, { choice: 'retry', by: 'user' }, this.now());
      if (resolved === r) {
        rejection = '関門を決着させられなかった';
      }
      return resolved;
    });
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (rejection !== undefined) {
      return { ok: false, message: `${taskId}をやり直せない: ${rejection}` };
    }
    return { ok: true, message: `${taskId}をやり直せる状態へ戻した。Orchestratorが設定を決め直す` };
  }

  /**
   * 再読み込み後の復元。工程セッションとOrchestratorは再読み込みで終わっているため、外部の状態
   * （PR・worktree・Issue）と突き合わせて工程を止め・終え（`taskRunReload.ts`）、終わっていない
   * runは人が「再開」するまで止めておく。再読み込みの間にmergeされたタスクは後片付けまで行う。
   * 実行中だった工程のうち会話が残っているものは、同じ会話を開き直す（Issue #1670）。
   */
  async restore(): Promise<void> {
    for (const run of this.deps.store.list()) {
      if (run.finishedAt !== undefined) {
        this.lastSeen.set(run.runId, run);
        continue;
      }
      let merged: string[] = [];
      let resuming = false;
      try {
        const facts = await this.collectReloadFacts(run);
        const next = await this.deps.store.update(run.runId, (current) =>
          reconcileTaskRunOnReload(current ?? run, facts, this.now()),
        );
        this.lastSeen.set(run.runId, next);
        resuming = listResumingStages(next).length > 0;
        merged = [...facts]
          .filter(([, fact]) => fact.pullRequestState === 'merged')
          .map(([taskId]) => taskId);
      } catch (e: unknown) {
        // 1件の保存失敗で残りのrunの復元を止めない
        this.deps.log(`[task run] ${run.runId}を復元できませんでした: ${String(e)}`);
      }
      for (const taskId of merged) {
        try {
          await this.deps.runner.cleanupRestoredTask(run.runId, taskId);
        } catch (e: unknown) {
          this.deps.log(`[task run] ${taskId}のmerge後の後片付けに失敗しました: ${String(e)}`);
        }
      }
      // 再読み込みで終わった工程は同じ会話を開き直す（Issue #1670）。runは止めたままなので、
      // 新しい工程は人が「再開」するまで始まらない
      if (resuming) {
        this.pumpLater(run.runId);
      }
    }
  }

  /** 終わっていないタスクの外部の状態を集める。取得に失敗した事実は`undefined`にする。 */
  private async collectReloadFacts(run: TaskRun): Promise<Map<string, TaskExternalFacts>> {
    const root = run.workspaceRoot;
    const { observation } = this.deps;
    const orUndefined = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
    const entries = await Promise.all(
      listTasks(run)
        .filter((task) => !isTaskDone(task))
        .map(async (task): Promise<[string, TaskExternalFacts]> => {
          const { pullRequest, worktreePath, issueNumber } = task;
          const [pullRequestState, worktreeExists, issueState] = await Promise.all([
            pullRequest === undefined
              ? undefined
              : orUndefined(observation.fetchPullRequestState(root, pullRequest.number)),
            worktreePath === undefined ? undefined : orUndefined(this.deps.pathExists(worktreePath)),
            // PRを作った後のIssueは見ない（reconcileTaskRunOnReloadの規則）
            issueNumber === undefined || pullRequest !== undefined
              ? undefined
              : orUndefined(observation.fetchIssueState(root, issueNumber)),
          ]);
          return [task.taskId, { pullRequestState, worktreeExists, issueState }];
        }),
    );
    return new Map(entries);
  }

  /**
   * Kanbanの盤面。`selectedRunId`が無ければ、いま開いているフォルダ（`currentFolders`）の動いているrun、
   * 無ければそのフォルダの最も新しいrunを選ぶ。
   */
  board(selectedRunId: string | undefined, currentFolders: readonly string[]): TaskRunKanbanBoard {
    return buildTaskRunKanban(this.deps.store.list(), selectedRunId, currentFolders);
  }

  /**
   * 工程を始める（`start_stage`）。止まっている工程はやり直しとして未着手へ戻してから判定し、
   * 判定を通らなければ状態を変えない。並列枠やmergeの鍵が空いていなければ設定だけ受け付ける。
   */
  async startStage(
    runId: string,
    call: Extract<TaskRunOrchestratorCall, { tool: 'start_stage' }>,
  ): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const run = this.deps.store.find(runId);
    if (run === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    const catalog = this.deps.modelCatalog(run.engine);
    const settings = checkStageSettings(catalog.models, catalog.fallbackEfforts, call.model, call.effort);
    if (!settings.ok) {
      return settings;
    }
    const ref: StageRef = { taskId: call.taskId, stage: call.stage };
    const recommended = this.recommended.get(runId)?.get(recommendationKey(ref.taskId, ref.stage));
    let rejection: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      const now = this.now();
      const task = getTask(r, call.taskId);
      const retry =
        task !== undefined &&
        currentStage(task) === call.stage &&
        task.stages[call.stage].status === 'halted' &&
        task.attention !== 'stopping';
      const base = retry ? resetStageForRetry(r, call.taskId, now) : r;
      const decided = decideStageStart(base, call.taskId, call.stage);
      if (!decided.ok) {
        rejection =
          decided.reason === 'dependenciesUnmet'
            ? `${REJECTION_MESSAGES.dependenciesUnmet}（${decided.unmetDependencies.join(', ')}）`
            : REJECTION_MESSAGES[decided.reason];
        return r;
      }
      const decision: StageDecision = {
        model: settings.model,
        effort: settings.effort,
        reason: call.reason,
        instruction: call.instruction,
        recommended:
          recommended === undefined
            ? undefined
            : { model: recommended.model, effort: recommended.effort },
        decidedAt: now.toISOString(),
      };
      const updated = recordStageDecision(base, call.taskId, call.stage, decision, now);
      if (updated === base) {
        rejection = '設定を記録できなかった';
        return r;
      }
      return updated;
    });
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (rejection !== undefined) {
      return { ok: false, message: `${call.taskId}の${call.stage}を始められない: ${rejection}` };
    }
    this.forgetRecommendation(runId, ref);
    this.pumpLater(runId);
    return {
      ok: true,
      message: `${call.taskId}の${call.stage}をmodel=${settings.model} effort=${settings.effort === '' ? '（既定）' : settings.effort}で受け付けた。並列枠が空き次第始まる。`,
    };
  }

  async stopStage(runId: string, taskId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const stopped = await this.deps.runner.stopStage(runId, taskId);
    return stopped
      ? { ok: true, message: `${taskId}の工程を止めた` }
      : { ok: false, message: `${taskId}の工程を止められなかった（動いていない、または報告済み）` };
  }

  /**
   * 工程を一時停止する（Issue #1629）。進行中のターンは止めず、終わったところでセッションを閉じる。
   * codexはapp-serverを工程間で共有するため、会話の購読を外すだけでメモリは空かない。
   */
  async pauseStage(runId: string, taskId: string, reason: string): Promise<ControllerResult> {
    // 工程セッションを持つのは専有権のあるウィンドウだけ（Issue #1628）
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const run = this.deps.store.find(runId);
    if (run === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    const outcome = await this.deps.runner.pauseStage(runId, taskId, reason);
    if (!outcome.ok) {
      return {
        ok: false,
        message: `${taskId}を一時停止できなかった（${PAUSE_REJECTIONS[outcome.reason]}）`,
      };
    }
    const timing = outcome.waitingForTurn
      ? '進行中のターンが終わったところでセッションを閉じる'
      : 'セッションを閉じた';
    const memory =
      run.engine === 'codex'
        ? '。codexはapp-serverを工程間で共有するため会話の購読を外すだけで、メモリは空かない'
        : '。CLIと子プロセスを終了してメモリを空ける';
    return {
      ok: true,
      message: `${taskId}の一時停止を受け付けた。${timing}${memory}。並列枠は使わない。resume_stageで同じ会話から再開する`,
    };
  }

  async resumeStage(runId: string, taskId: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    // 開き直しの失敗は`failed`で止める。人の`stop_task`（`stopped`）が同じ間に割り込んでも取り違えない
    const failureOf = (): string | undefined => {
      const run = this.deps.store.find(runId);
      const task = run === undefined ? undefined : getTask(run, taskId);
      return task?.attention === 'failed' ? task.failure : undefined;
    };
    const failureBefore = failureOf();
    const accepted = await this.deps.runner.resumeStage(runId, taskId);
    if (!accepted) {
      return { ok: false, message: `${taskId}を再開できなかった（一時停止していない）` };
    }
    // 並列枠が空いていれば、受け付けた流れのまま開き直しまで済んでいる。開き直せずに工程が止まった
    // （worktreeや会話の記録が無い等）なら、その理由をここで返す（Issue #1638）
    const failure = failureOf();
    if (failure !== undefined && failure !== failureBefore) {
      return {
        ok: false,
        message: `${taskId}を再開できなかった: ${sanitizeInlineText(failure, RESUME_FAILURE_MAX_LENGTH)}`,
      };
    }
    return {
      ok: true,
      message:
        `${taskId}の再開を受け付けた。並列枠と資源の保留が空き次第、同じ会話を開き直して続きから進める。` +
        '開き直せなければ工程は失敗になり、理由はget_run_stateの「理由:」に出る',
    };
  }

  async instructTask(runId: string, taskId: string, instruction: string): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const ok = await this.deps.runner.instructStage(runId, taskId, instruction);
    return ok
      ? { ok: true, message: `${taskId}へ指示を渡した。次の指示の頭に添えて届く` }
      : { ok: false, message: `${taskId}へ指示を渡せなかった（工程セッションが動いていない）` };
  }

  async setMaxParallel(runId: string, maxParallel: number): Promise<ControllerResult> {
    if (!isValidMaxParallel(maxParallel)) {
      return { ok: false, message: `maxParallelは1〜${String(MAX_TASK_RUN_PARALLEL)}の整数で指定する` };
    }
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const next = await this.updateRun(runId, (r) => setTaskRunMaxParallel(r, maxParallel));
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    this.pumpLater(runId);
    return { ok: true, message: `並列上限を${String(maxParallel)}にした` };
  }

  /**
   * ユーザーかオーケストレーターの判断待ちの質問か。Orchestratorの`answer_question`はこれで
   * 確認（モーダル）の要否を決める。`awaitingOrchestrator`ならオーケストレーター自身が答えてよい
   * （Issue #1708）。
   */
  findQuestionAwaitingAnswer(
    runId: string,
    taskId: string,
    questionId: string,
  ): { title: string; question: string; awaitingOrchestrator: boolean } | undefined {
    const run = this.deps.store.find(runId);
    const task = run === undefined ? undefined : getTask(run, taskId);
    const question = run === undefined ? undefined : findStageQuestion(run, taskId, questionId);
    if (
      task === undefined ||
      (question?.status !== 'awaitingUser' && question?.status !== 'awaitingOrchestrator')
    ) {
      return undefined;
    }
    return {
      title: task.title,
      question: question.question,
      awaitingOrchestrator: question.status === 'awaitingOrchestrator',
    };
  }

  async answerQuestion(
    runId: string,
    taskId: string,
    questionId: string,
    answer: string,
    by: 'orchestrator' | 'user' = 'user',
  ): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const ok = await this.deps.runner.answerQuestion(runId, taskId, questionId, answer, by);
    return ok
      ? { ok: true, message: `${taskId}の質問に回答した` }
      : { ok: false, message: '回答を受け付けられなかった（既に回答済み、または取り消された可能性がある）' };
  }

  /** 決着待ちの関門か。決着の確認（モーダル）の前に確かめる。 */
  findOpenGateForUser(
    runId: string,
    taskId: string,
    gateId: string,
  ): { title: string; detail: string; awaitingOrchestrator: boolean } | undefined {
    const run = this.deps.store.find(runId);
    const task = run === undefined ? undefined : getTask(run, taskId);
    const gate = run === undefined ? undefined : findStageGate(run, taskId, gateId);
    if (task === undefined || gate === undefined || gate.status === 'resolved') {
      return undefined;
    }
    return {
      title: task.title,
      detail: gate.detail,
      awaitingOrchestrator: gate.status === 'awaitingOrchestrator',
    };
  }

  /**
   * 関門を決着させる（KanbanとOrchestratorの`resolve_gate`から）。ユーザーの判断はReflexが
   * 判定中でも優先する。オーケストレーター（`by: 'orchestrator'`）はオーケストレーターの
   * 判断待ちの関門だけを決着させられる（Issue #1708）。決着後はスケジューラを回す。
   */
  async resolveGate(
    runId: string,
    taskId: string,
    gateId: string,
    choice: StageGateChoice,
    by: 'orchestrator' | 'user' = 'user',
  ): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    let rejection: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      const gate = findStageGate(r, taskId, gateId);
      if (r.finishedAt !== undefined) {
        rejection = 'このrunは終わっている';
        return r;
      }
      if (r.suspendedAt !== undefined) {
        rejection = 'このrunは中断している。先に再開する';
        return r;
      }
      if (gate === undefined || gate.status === 'resolved') {
        rejection = '決着待ちの関門ではない（既に決着済み、または存在しない）';
        return r;
      }
      if (!isGateChoiceAllowed(gate.kind, choice)) {
        rejection = `この関門では「${GATE_CHOICE_LABELS[choice]}」を選べない`;
        return r;
      }
      if (by === 'orchestrator' && gate.status !== 'awaitingOrchestrator') {
        rejection = 'オーケストレーターの判断待ちの関門ではない（ユーザーの判断が要る）';
        return r;
      }
      const resolved = resolveStageGate(r, taskId, gateId, { choice, by }, this.now());
      if (resolved === r) {
        rejection = 'タスクの状態が関門を開いたときから変わっている';
      }
      return resolved;
    });
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (rejection !== undefined) {
      return { ok: false, message: `${taskId}の関門を決着させられない: ${rejection}` };
    }
    this.pumpLater(runId);
    return { ok: true, message: `${taskId}の関門を「${GATE_CHOICE_LABELS[choice]}」で決着させた` };
  }

  /**
   * オーケストレーターの判断待ちの質問・関門をユーザーの判断待ちへ回す（Orchestratorの
   * `escalate_to_user`から。Issue #1708）。
   */
  async escalateToUser(
    runId: string,
    taskId: string,
    target: { questionId: string } | { gateId: string },
    reason: string,
  ): Promise<ControllerResult> {
    const leased = await this.ensureLease(runId);
    if (!leased.ok) {
      return leased;
    }
    const next = await this.updateRun(runId, (r) =>
      'questionId' in target
        ? escalateQuestionToUser(r, taskId, target.questionId, reason, this.now())
        : escalateGateToUser(r, taskId, target.gateId, reason, this.now()),
    );
    const status =
      next === undefined
        ? undefined
        : 'questionId' in target
          ? findStageQuestion(next, taskId, target.questionId)?.status
          : findStageGate(next, taskId, target.gateId)?.status;
    return status === 'awaitingUser'
      ? { ok: true, message: `${taskId}の判断をユーザーへ回した` }
      : { ok: false, message: 'オーケストレーターの判断待ちではない（既に決着済み、またはユーザーの判断待ち）' };
  }

  /** runを忘れる（runの削除・拡張機能の終了時）。 */
  forget(runId: string): void {
    this.lastSeen.delete(runId);
    this.recommended.delete(runId);
    for (const key of [...this.recommending.keys()]) {
      if (key.startsWith(`${runId}#`)) {
        this.recommending.delete(key);
      }
    }
  }
}

/**
 * ロードマップIssueから始めたrunで、ロードマップに無い既存のIssueが計画へ新しく入ったら警告を残す
 * （受け付けは止めない。Issue #1623）。このrunが作ったIssue（チェックリストへ足す途中）は除く。
 */
function withOutsideRoadmapWarning(
  before: TaskRun,
  run: TaskRun,
  tasks: readonly PlanTaskInput[],
  now: Date,
  newId: () => string,
): TaskRun {
  if (run.roadmap === undefined) {
    return run;
  }
  const known = new Set(
    listTasks(before)
      .map((t) => taskIssueNumber(t))
      .filter((n): n is number => n !== undefined),
  );
  const outside = findIssuesOutsideRoadmap(tasks, run.roadmap.snapshot).filter((n) => !known.has(n));
  if (outside.length === 0) {
    return run;
  }
  return withRoadmapNotices(
    run,
    [
      {
        kind: 'warning',
        body: `ロードマップのチェックリストに無いIssueを計画へ入れた: ${outside.map((n) => `#${String(n)}`).join(', ')}`,
      },
    ],
    now,
    newId,
  );
}
