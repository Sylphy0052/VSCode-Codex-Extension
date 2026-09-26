import { notifyOrchestrator } from './runnerOrchestrator';
import type { LiveRun, LiveTask } from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';
import { isOverlapHoldingState } from './taskOverlap';
import {
  buildTaskSplitSuggestedEventBody,
  DEFAULT_SPLIT_SUGGEST_THRESHOLDS,
  findExceededMetrics,
  type TaskSizeObservation,
} from './taskSplit';

/**
 * 走行中のタスクの規模が閾値を超えたら、オーケストレーターへ分割を提案する（Issue #1508、
 * ロードマップH4）。H2（Issue #1469）の監視ループが変更ファイルを測り直すたびに、
 * `checkTaskOverlap`の最後で呼ばれる。
 *
 * - 提案は1つのタスクの1回の試行につき1回まで。再試行では`LiveTask`が作り直されるため、
 *   数え直しになる。runごとのイベント総数の上限（`MAX_ORCHESTRATOR_EVENTS_PER_RUN`）を
 *   同じ提案で使い切らないため
 * - 対象は作業中のタスクだけ。`merging`は作業を終えて統合しているところなので、分ける余地が無い
 * - オーケストレーターの居ないrunでは何もしない（提案の受け手が居ない）
 */
export function suggestTaskSplits(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
): void {
  if (live.orchestrator === undefined || live.runState.haltedByUser) {
    return;
  }
  const thresholds = self.deps.readSplitSuggestThresholds?.() ?? DEFAULT_SPLIT_SUGGEST_THRESHOLDS;
  let changed = false;
  for (const [taskId, liveTask] of live.tasks) {
    const state = live.runState.tasks.get(taskId)?.state;
    if (
      liveTask.splitSuggested ||
      !isOverlapHoldingState(state) ||
      state === 'merging' ||
      live.launchingTasks.has(taskId)
    ) {
      continue;
    }
    const exceeded = findExceededMetrics(observeTaskSize(liveTask), thresholds);
    if (exceeded.length === 0) {
      continue;
    }
    liveTask.splitSuggested = true;
    notifyOrchestrator(self, runId, {
      kind: 'taskSplitSuggested',
      body: buildTaskSplitSuggestedEventBody(taskId, exceeded, [
        ...(liveTask.touchedFiles ?? []),
      ]),
    });
    self.deps.log.info(
      `[workflow ${runId}] ${taskId}: 規模が閾値を超えたため、オーケストレーターへ分割を提案しました` +
        `（${exceeded.map((e) => `${e.metric}=${e.actual}>${e.threshold}`).join(', ')}）`,
    );
    changed = true;
  }
  if (changed) {
    self.notify(runId);
  }
}

/** タスクの規模の実測値。変更ファイル数・変更行数は、測れていなければ`undefined` */
export function observeTaskSize(liveTask: LiveTask): TaskSizeObservation {
  return {
    fileCount: liveTask.touchedFiles?.size,
    lineCount:
      liveTask.changedLines === undefined
        ? undefined
        : liveTask.changedLines.added + liveTask.changedLines.deleted,
    turnCount: liveTask.completedTurnCount,
  };
}
