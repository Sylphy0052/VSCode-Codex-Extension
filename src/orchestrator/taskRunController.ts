import { randomUUID } from 'node:crypto';

import type { ModelInfo } from '../codex/modelCatalog';
import type { HandoffClassifierInput } from '../view/handoffClassifier';
import { buildTaskRunKanban, type TaskRunKanbanBoard } from '../view/taskRunKanbanModel';
import { SerialQueue } from './serialQueue';
import { recommendationKey, type TaskRunOrchestratorCall } from './taskRunOrchestratorTools';
import { parsePlanArgs, resolveTaskPlan, type PlanTaskInput } from './taskRunPlan';
import { findStageQuestion } from './taskRunQuestions';
import {
  findOpenGate,
  findStageGate,
  GATE_CHOICE_LABELS,
  isGateChoiceAllowed,
  resolveStageGate,
} from './taskRunGates';
import { reconcileTaskRunOnReload, type TaskExternalFacts } from './taskRunReload';
import { decideStageStart, type StageRef, type StartStageRejection } from './taskRunScheduler';
import {
  approveTaskPlan,
  createTaskRun,
  currentStage,
  finishTaskRun,
  getTask,
  isTaskDone,
  isValidMaxParallel,
  listTasks,
  MAX_TASK_RUN_PARALLEL,
  proposeTaskPlan,
  recordStageDecision,
  resetStageForRetry,
  setTaskRunHaltedByUser,
  setTaskRunMaxParallel,
  type StageDecision,
  type StageGateChoice,
  type TaskRun,
  type TaskRunEngine,
} from './taskRunState';
import type { TaskRunStore } from './taskRunStore';
import type { StageObservationPorts } from './taskStageObservation';
import type { TaskStageRunner } from './taskStageRunner';
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

export type ControllerResult = { ok: true; message: string } | { ok: false; message: string };

export type StartTaskRunOutcome =
  | { ok: true; runId: string; reused: boolean }
  | { ok: false; message: string };

export interface TaskRunControllerDeps {
  store: Pick<TaskRunStore, 'find' | 'update' | 'list' | 'findActive'>;
  runner: Pick<
    TaskStageRunner,
    'pump' | 'stopStage' | 'instructStage' | 'answerQuestion' | 'cleanupRestoredTask'
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
}

export type TaskRunTransitionListener = (prev: TaskRun | undefined, next: TaskRun) => void;

const REJECTION_MESSAGES: Record<StartStageRejection, string> = {
  unknownTask: 'そのタスクは計画に無い',
  planNotApproved: '計画がまだユーザーに承認されていない',
  runFinished: 'このrunは終わっている',
  taskDone: 'このタスクはすべての工程を終えている',
  notCurrentStage: 'その工程はこのタスクの現在の工程ではない（get_run_stateで現在の工程を確かめる）',
  alreadyRunning: 'その工程は既に実行中',
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
  /** runの開始を直列にする。同じフォルダでrunを2つ作らないため。 */
  private readonly startQueue = new SerialQueue();

  constructor(private readonly deps: TaskRunControllerDeps) {}

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
    for (const listener of this.listeners) {
      try {
        listener(prev, next);
      } catch (e: unknown) {
        this.deps.log(`[task run] 状態の通知に失敗しました: ${String(e)}`);
      }
    }
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
   */
  async proposePlan(runId: string, rawArgs: unknown): Promise<ControllerResult> {
    const parsed = parsePlanArgs(rawArgs);
    if (!parsed.ok) {
      return parsed;
    }
    const issueProblem = await this.checkExistingIssues(runId, parsed.value);
    if (issueProblem !== undefined) {
      return { ok: false, message: `計画を受け付けられない: ${issueProblem}` };
    }
    let failure: string | undefined;
    let assigned: ReadonlyMap<string, string> = new Map();
    const next = await this.updateRun(runId, (r) => {
      const resolved = resolveTaskPlan(r, parsed.value);
      if (!resolved.ok) {
        failure = resolved.message;
        return r;
      }
      assigned = resolved.value.assigned;
      try {
        return proposeTaskPlan(resolved.value.run, resolved.value.drafts, () => this.newId(), this.now());
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
    const mapping = [...assigned].map(([key, taskId]) => `${key} → ${taskId}`).join(', ');
    return {
      ok: true,
      message: [
        `計画を受け付けた（${String(next.taskOrder.length)}タスク）。ユーザーの承認を待っている。承認されるまで工程は始まらない。`,
        mapping === '' ? '新しいタスクは無い。' : `採番したtaskId: ${mapping}`,
      ].join('\n'),
    };
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

  /** ユーザーが計画を承認する（Kanbanのボタンから呼ぶ。Orchestratorからは呼べない）。 */
  async approvePlan(runId: string): Promise<boolean> {
    const run = this.deps.store.find(runId);
    if (run?.planStatus !== 'awaitingApproval') {
      return false;
    }
    const next = await this.updateRun(runId, approveTaskPlan);
    if (next?.planStatus !== 'approved') {
      return false;
    }
    this.pumpLater(runId);
    return true;
  }

  /**
   * runを始める。同じフォルダに終わっていないrunがあれば、新しく作らずにそれを返す
   * （1ワークスペースにつき実行中は1つ）。
   */
  startRun(input: {
    workspaceRoot: string;
    engine: TaskRunEngine;
    maxParallel: number;
  }): Promise<StartTaskRunOutcome> {
    return this.startQueue.enqueue(async (): Promise<StartTaskRunOutcome> => {
      const active = this.deps.store.findActive(input.workspaceRoot);
      if (active !== undefined) {
        return { ok: true, runId: active.runId, reused: true };
      }
      if (!isValidMaxParallel(input.maxParallel)) {
        return { ok: false, message: `並列上限は1〜${String(MAX_TASK_RUN_PARALLEL)}の整数で指定する` };
      }
      const run = createTaskRun({ ...input, runId: this.newId(), now: this.now() });
      await this.deps.store.update(run.runId, () => run);
      this.handleRunChanged(run);
      return { ok: true, runId: run.runId, reused: false };
    });
  }

  /** run全体の一時停止と再開（Kanbanから）。停止中は新しい工程を始めない。実行中の工程は止めない。 */
  async setHalted(runId: string, halted: boolean): Promise<void> {
    const next = await this.updateRun(runId, (r) =>
      r.finishedAt === undefined ? setTaskRunHaltedByUser(r, halted) : r,
    );
    if (next !== undefined && !halted) {
      this.pumpLater(runId);
    }
  }

  /** 同じフォルダの終わっていないrun（`startRun`が再利用するもの）。 */
  findActive(workspaceRoot: string): TaskRun | undefined {
    return this.deps.store.findActive(workspaceRoot);
  }

  /**
   * 人がrunを終える（Issue #1558）。先に一時停止して新しい工程を始めないようにし、動いている
   * 工程セッションを止めてから`finishedAt`を立てる。Orchestratorのセッションは呼び出し側が閉じる。
   */
  async finishRun(runId: string): Promise<ControllerResult> {
    const halted = await this.updateRun(runId, (r) =>
      r.finishedAt === undefined ? setTaskRunHaltedByUser(r, true) : r,
    );
    if (halted === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    if (halted.finishedAt !== undefined) {
      return { ok: true, message: 'runは終わっている' };
    }
    const running = listTasks(halted).filter((task) => {
      const stage = currentStage(task);
      return stage !== undefined && task.stages[stage].status === 'running';
    });
    await Promise.all(running.map((task) => this.deps.runner.stopStage(runId, task.taskId)));
    await this.updateRun(runId, (r) => finishTaskRun(r, this.now()));
    return { ok: true, message: 'runを終えた' };
  }

  /**
   * 止まった工程をやり直せる状態へ戻す（Kanbanから）。工程は未着手に戻り、Orchestratorが
   * 設定を決め直すのを待つ（判断待ちのイベントがOrchestratorへ届く）。失敗の関門が開いていれば、
   * ユーザーの「やり直す」判断として決着させる（Reflexの判定より優先する）。
   */
  async retryStage(runId: string, taskId: string): Promise<ControllerResult> {
    let rejection: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      const task = getTask(r, taskId);
      const stage = task === undefined ? undefined : currentStage(task);
      if (r.finishedAt !== undefined) {
        rejection = 'このrunは終わっている';
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
   */
  async restore(): Promise<void> {
    for (const run of this.deps.store.list()) {
      if (run.finishedAt !== undefined) {
        this.lastSeen.set(run.runId, run);
        continue;
      }
      let merged: string[] = [];
      try {
        const facts = await this.collectReloadFacts(run);
        const next = await this.deps.store.update(run.runId, (current) =>
          reconcileTaskRunOnReload(current ?? run, facts, this.now()),
        );
        this.lastSeen.set(run.runId, next);
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

  /** Kanbanの盤面。`selectedRunId`が無ければ終わっていない新しいrunを選ぶ。 */
  board(selectedRunId: string | undefined): TaskRunKanbanBoard {
    return buildTaskRunKanban(this.deps.store.list(), selectedRunId);
  }

  /**
   * 工程を始める（`start_stage`）。止まっている工程はやり直しとして未着手へ戻してから判定し、
   * 判定を通らなければ状態を変えない。並列枠やmergeの鍵が空いていなければ設定だけ受け付ける。
   */
  async startStage(
    runId: string,
    call: Extract<TaskRunOrchestratorCall, { tool: 'start_stage' }>,
  ): Promise<ControllerResult> {
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
    const stopped = await this.deps.runner.stopStage(runId, taskId);
    return stopped
      ? { ok: true, message: `${taskId}の工程を止めた` }
      : { ok: false, message: `${taskId}の工程を止められなかった（動いていない、または報告済み）` };
  }

  async instructTask(runId: string, taskId: string, instruction: string): Promise<ControllerResult> {
    const ok = await this.deps.runner.instructStage(runId, taskId, instruction);
    return ok
      ? { ok: true, message: `${taskId}へ指示を渡した。次の指示の頭に添えて届く` }
      : { ok: false, message: `${taskId}へ指示を渡せなかった（工程セッションが動いていない）` };
  }

  async setMaxParallel(runId: string, maxParallel: number): Promise<ControllerResult> {
    if (!isValidMaxParallel(maxParallel)) {
      return { ok: false, message: `maxParallelは1〜${String(MAX_TASK_RUN_PARALLEL)}の整数で指定する` };
    }
    const next = await this.updateRun(runId, (r) => setTaskRunMaxParallel(r, maxParallel));
    if (next === undefined) {
      return { ok: false, message: 'runが見つからない' };
    }
    this.pumpLater(runId);
    return { ok: true, message: `並列上限を${String(maxParallel)}にした` };
  }

  /** ユーザー判断待ちの質問か。回答の確認（モーダル）の前に確かめる。 */
  findQuestionAwaitingUser(
    runId: string,
    taskId: string,
    questionId: string,
  ): { title: string; question: string } | undefined {
    const run = this.deps.store.find(runId);
    const task = run === undefined ? undefined : getTask(run, taskId);
    const question = run === undefined ? undefined : findStageQuestion(run, taskId, questionId);
    if (task === undefined || question?.status !== 'awaitingUser') {
      return undefined;
    }
    return { title: task.title, question: question.question };
  }

  async answerQuestion(
    runId: string,
    taskId: string,
    questionId: string,
    answer: string,
  ): Promise<ControllerResult> {
    const ok = await this.deps.runner.answerQuestion(runId, taskId, questionId, answer);
    return ok
      ? { ok: true, message: `${taskId}の質問に回答した` }
      : { ok: false, message: '回答を受け付けられなかった（既に回答済み、または取り消された可能性がある）' };
  }

  /** 決着待ちの関門か。決着の確認（モーダル）の前に確かめる。 */
  findOpenGateForUser(
    runId: string,
    taskId: string,
    gateId: string,
  ): { title: string; detail: string } | undefined {
    const run = this.deps.store.find(runId);
    const task = run === undefined ? undefined : getTask(run, taskId);
    const gate = run === undefined ? undefined : findStageGate(run, taskId, gateId);
    if (task === undefined || gate === undefined || gate.status === 'resolved') {
      return undefined;
    }
    return { title: task.title, detail: gate.detail };
  }

  /**
   * 関門をユーザーの判断で決着させる（KanbanとOrchestratorの`resolve_gate`から）。Reflexが
   * 判定中でもユーザーの判断を優先する。決着後はスケジューラを回す。
   */
  async resolveGate(
    runId: string,
    taskId: string,
    gateId: string,
    choice: StageGateChoice,
  ): Promise<ControllerResult> {
    let rejection: string | undefined;
    const next = await this.updateRun(runId, (r) => {
      const gate = findStageGate(r, taskId, gateId);
      if (r.finishedAt !== undefined) {
        rejection = 'このrunは終わっている';
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
      const resolved = resolveStageGate(r, taskId, gateId, { choice, by: 'user' }, this.now());
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
