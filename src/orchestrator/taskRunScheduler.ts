/**
 * オーケストレータモード（Issue #1505）のスケジューラ。Controllerの状態（`taskRunState.ts`）から、
 * Orchestratorに設定を決めてもらう工程、今始める工程、`start_stage`を受け付けてよいか、
 * runが止まって人の対応を要するかを決める。
 *
 * すべて純粋関数で、セッションの起動や通知は呼び出し側（Controller）が行う。
 * タスクは同時に1つの工程しか動かないので、ノードの識別子は`taskId`にする。
 * - 依存が効くのは「実装とPR作成」だけ。依存先のタスクがmergeとcleanupまで終わるまで始めない
 * - 並列上限は「動いている工程セッションの数」に掛ける。Orchestratorのセッションは数えない
 * - 「mergeとcleanup」は並列枠に加えて、リポジトリごとのmergeの鍵が空いているときだけ始める
 * - 上限を下げても実行中のセッションは止めず、動いている数が上限を下回るまで新しい工程を始めない
 */

import {
  currentStage,
  DEPENDENCY_GATED_STAGES,
  getTask,
  isTaskDone,
  listTasks,
  type OrchestratedTask,
  type TaskRun,
  type TaskStage,
} from './taskRunState';
import {
  assessRunProgress,
  newlyAppeared,
  pickToStart,
  unmetDependencies,
  type RunAssessment,
} from './runScheduling';

/** 工程セッションが動いている（停止処理中を含む）。並列上限の対象。 */
export function hasActiveStageSession(task: OrchestratedTask): boolean {
  const stage = currentStage(task);
  return (
    stage !== undefined &&
    task.stages[stage].status === 'running' &&
    task.currentAttemptId !== undefined
  );
}

export function countActiveStageSessions(run: TaskRun): number {
  return listTasks(run).filter(hasActiveStageSession).length;
}

/** タスクの依存先のうち、まだmergeとcleanupまで終わっていない`taskId`。 */
export function unmetTaskDependencies(run: TaskRun, task: OrchestratedTask): string[] {
  return unmetDependencies(task.dependsOn, (dep) => {
    const depTask = getTask(run, dep);
    return depTask !== undefined && isTaskDone(depTask);
  });
}

/** 計画が承認済みで、run全体が動いている。 */
function isRunAccepting(run: TaskRun): boolean {
  return run.planStatus === 'approved' && run.finishedAt === undefined && !run.haltedByUser;
}

/**
 * 現在の工程を始められる状態か。前の工程が終わり（`currentStage`がそれを表す）、未着手で、
 * 止まっておらず、「実装とPR作成」なら依存先がすべて終わっている。
 */
function isStageStartable(run: TaskRun, task: OrchestratedTask): boolean {
  const stage = currentStage(task);
  if (stage === undefined || task.stages[stage].status !== 'notStarted') {
    return false;
  }
  if (task.attention !== 'none') {
    return false;
  }
  return !DEPENDENCY_GATED_STAGES.includes(stage) || unmetTaskDependencies(run, task).length === 0;
}

export interface StageRef {
  taskId: string;
  stage: TaskStage;
}

/**
 * Orchestratorに設定（Model/Effortと指示）を決めてもらう工程。始められる状態で、まだ設定を
 * 受け付けていないものを着手順（計画の並び）に返す。run全体の停止中と計画の承認前は空にする。
 */
export function listStagesAwaitingDecision(run: TaskRun): StageRef[] {
  if (!isRunAccepting(run)) {
    return [];
  }
  return listTasks(run)
    .filter((task) => isStageStartable(run, task))
    .flatMap((task) => {
      const stage = currentStage(task);
      return stage !== undefined && task.stages[stage].pendingDecision === undefined
        ? [{ taskId: task.taskId, stage }]
        : [];
    });
}

/** 設定を受け付け、並列枠（とmergeの鍵）の空きを待っている工程。着手順に返す。 */
export function listQueuedStages(run: TaskRun): StageRef[] {
  if (!isRunAccepting(run)) {
    return [];
  }
  return listTasks(run)
    .filter((task) => isStageStartable(run, task))
    .flatMap((task) => {
      const stage = currentStage(task);
      return stage !== undefined && task.stages[stage].pendingDecision !== undefined
        ? [{ taskId: task.taskId, stage }]
        : [];
    });
}

/**
 * 今始める工程。並列上限から動いているセッション数を引いた空き枠の分だけ、設定を受け付けた
 * 工程を着手順に返す。
 *
 * - `startingTaskIds`には、まだ状態へ`running`として反映されていない（worktree作成・セッション
 *   起動・mergeの鍵の取得が途中の）タスクを渡す（空き枠の二重計上を防ぐ。Issue #1484）
 * - 「mergeとcleanup」は、`isMergeKeyBusy`が偽のときに先頭の1件だけを選ぶ。鍵の取得を始めた
 *   時点で`TaskRunMergeKeys.isBusy`が真になるので、次の呼び出しでは選ばれない
 */
export function pickStagesToStart(
  run: TaskRun,
  startingTaskIds: ReadonlySet<string>,
  isMergeKeyBusy: boolean,
): StageRef[] {
  const queued = listQueuedStages(run);
  const firstMerge = isMergeKeyBusy
    ? undefined
    : queued.find((ref) => ref.stage === 'mergeCleanup' && !startingTaskIds.has(ref.taskId));
  const runnable = queued.filter((ref) => ref.stage !== 'mergeCleanup' || ref === firstMerge);
  const picked = new Set(
    pickToStart({
      runnable: runnable.map((ref) => ref.taskId),
      maxParallel: run.maxParallel,
      activeCount: countActiveStageSessions(run),
      starting: startingTaskIds,
      isActive: (taskId) => {
        const task = getTask(run, taskId);
        return task !== undefined && hasActiveStageSession(task);
      },
    }),
  );
  return runnable.filter((ref) => picked.has(ref.taskId));
}

export type StartStageRejection =
  | 'unknownTask'
  | 'planNotApproved'
  | 'runFinished'
  | 'taskDone'
  | 'notCurrentStage'
  | 'alreadyRunning'
  | 'halted'
  | 'dependenciesUnmet';

export type StartStageDecision =
  { ok: true } | { ok: false; reason: StartStageRejection; unmetDependencies: readonly string[] };

/**
 * Orchestratorの`start_stage`を受け付けてよいかを決める（工程の順番、前の工程の完了、依存）。
 * 並列枠とmergeの鍵は見ない（空いていなければ受け付けて待たせる）。run全体の停止中も
 * 受け付け、再開後に始める。Model/Effortの値の検証は呼び出し側が行う。
 */
export function decideStageStart(
  run: TaskRun,
  taskId: string,
  stage: TaskStage,
): StartStageDecision {
  const reject = (
    reason: StartStageRejection,
    unmet: readonly string[] = [],
  ): StartStageDecision => ({
    ok: false,
    reason,
    unmetDependencies: unmet,
  });
  const task = getTask(run, taskId);
  if (task === undefined) {
    return reject('unknownTask');
  }
  if (run.planStatus !== 'approved') {
    return reject('planNotApproved');
  }
  if (run.finishedAt !== undefined) {
    return reject('runFinished');
  }
  const current = currentStage(task);
  if (current === undefined) {
    return reject('taskDone');
  }
  if (current !== stage) {
    return reject('notCurrentStage');
  }
  const status = task.stages[stage].status;
  if (status === 'running') {
    return reject('alreadyRunning');
  }
  if (status === 'halted' || task.attention !== 'none') {
    return reject('halted');
  }
  if (DEPENDENCY_GATED_STAGES.includes(stage)) {
    const unmet = unmetTaskDependencies(run, task);
    if (unmet.length > 0) {
      return reject('dependenciesUnmet', unmet);
    }
  }
  return { ok: true };
}

/**
 * 人の対応が無くても進むタスクか。工程セッションが動いていて人を待っていない、または
 * 始められる工程があり、Orchestrator・Controllerが進める。
 */
function isProgressingWithoutUser(run: TaskRun, task: OrchestratedTask): boolean {
  if (hasActiveStageSession(task)) {
    return task.attention === 'none' || task.attention === 'stopping';
  }
  return !run.haltedByUser && isStageStartable(run, task);
}

export type TaskRunAssessment =
  | RunAssessment<string>
  /** 計画をOrchestratorが作成中、またはユーザーの承認待ち。 */
  | { kind: 'planPending'; planStatus: 'drafting' | 'awaitingApproval' };

/**
 * runが進んでいるか、人の対応を待って止まっているかを判定する。`stalled`になったら、
 * ControllerはKanbanとデスクトップ通知で知らせる。`blockers`は、ユーザー判断待ち・要対応・
 * 失敗・停止で止まったタスク。
 */
export function assessTaskRun(run: TaskRun): TaskRunAssessment {
  if (run.planStatus !== 'approved') {
    return { kind: 'planPending', planStatus: run.planStatus };
  }
  const tasks = listTasks(run);
  return assessRunProgress({
    allDone: tasks.every(isTaskDone),
    anyProgressingWithoutUser: tasks.some((task) => isProgressingWithoutUser(run, task)),
    haltedByUser: run.haltedByUser,
    hasRunnable: !run.haltedByUser && tasks.some((task) => isStageStartable(run, task)),
    blockers: () =>
      tasks
        .filter((task) => !isTaskDone(task) && task.attention !== 'none')
        .map((task) => task.taskId),
  });
}

function stageRefKey(ref: StageRef): string {
  return `${ref.taskId}:${ref.stage}`;
}

/**
 * 状態の更新で新たにOrchestratorの判断を待つようになった工程。Controllerはこれを
 * Orchestratorへイベントとして送る。
 */
export function newlyAwaitingDecision(before: TaskRun, after: TaskRun): StageRef[] {
  const beforeKeys = listStagesAwaitingDecision(before).map(stageRefKey);
  const afterRefs = listStagesAwaitingDecision(after);
  const appeared = new Set(newlyAppeared(beforeKeys, afterRefs.map(stageRefKey)));
  return afterRefs.filter((ref) => appeared.has(stageRefKey(ref)));
}
