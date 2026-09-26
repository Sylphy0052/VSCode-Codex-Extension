import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/orchestrator/runnerOrchestrator', () => ({
  notifyOrchestrator: vi.fn(),
}));

import { notifyOrchestrator } from '../../src/orchestrator/runnerOrchestrator';
import { observeTaskSize, suggestTaskSplits } from '../../src/orchestrator/runnerTaskSplit';
import type { LiveRun, LiveTask } from '../../src/orchestrator/runner';
import type { WorkflowRunnerInternals } from '../../src/orchestrator/runnerInternals';
import type { Logger } from '../../src/log';
import type { SplitSuggestThresholds } from '../../src/orchestrator/taskSplit';

/**
 * `suggestTaskSplits`（Issue #1508、ロードマップH4）が、走行中のタスクの規模が閾値を
 * 超えたときに1試行につき1回だけオーケストレーターへ通知することを確かめる。
 *
 * `runnerInstruction.test.ts`と同じ方針: `notifyOrchestrator`をモジュールごとモックし、
 * `WorkflowRunnerInternals`/`LiveRun`は`as unknown as`で最小限のフェイクにする
 * （実際のフィールドは`git diff`で確認済みの`LiveTask.touchedFiles` /
 * `LiveTask.changedLines` / `LiveTask.completedTurnCount` / `LiveTask.splitSuggested`のみ）。
 */

const notifyOrchestratorMock = vi.mocked(notifyOrchestrator);

const THRESHOLDS: SplitSuggestThresholds = { fileCount: 2, lineCount: 1_000_000, turnCount: 1_000_000 };

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined, show: () => undefined };
}

function makeSelf(notify: () => void = () => undefined): WorkflowRunnerInternals {
  return {
    deps: {
      log: makeLogger(),
      readSplitSuggestThresholds: () => THRESHOLDS,
    },
    notify,
  } as unknown as WorkflowRunnerInternals;
}

/** 閾値（fileCount: 2）を超えるタスク1件。 */
function makeExceedingTask(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    touchedFiles: new Set(['a.ts', 'b.ts', 'c.ts']),
    changedLines: { added: 1, deleted: 0 },
    completedTurnCount: 1,
    splitSuggested: false,
    ...overrides,
  } as unknown as LiveTask;
}

function makeLive(options: {
  hasOrchestrator?: boolean;
  haltedByUser?: boolean;
  taskState?: string;
  launching?: boolean;
  task?: LiveTask;
}): LiveRun {
  const taskId = 'T1';
  return {
    orchestrator: options.hasOrchestrator === false ? undefined : {},
    runState: {
      haltedByUser: options.haltedByUser ?? false,
      tasks: new Map([[taskId, { state: options.taskState ?? 'running' }]]),
    },
    tasks: new Map([[taskId, options.task ?? makeExceedingTask()]]),
    launchingTasks: options.launching === true ? new Set([taskId]) : new Set(),
  } as unknown as LiveRun;
}

describe('observeTaskSize', () => {
  it('touchedFiles/changedLines/completedTurnCountから実測値を組み立てる', () => {
    const liveTask = makeExceedingTask({
      touchedFiles: new Set(['a.ts', 'b.ts']),
      changedLines: { added: 10, deleted: 5 },
      completedTurnCount: 3,
    });
    expect(observeTaskSize(liveTask)).toEqual({ fileCount: 2, lineCount: 15, turnCount: 3 });
  });

  it('touchedFiles/changedLinesが未測定ならundefined（turnCountは常に埋まる）', () => {
    const liveTask = makeExceedingTask({
      touchedFiles: undefined,
      changedLines: undefined,
      completedTurnCount: 0,
    });
    expect(observeTaskSize(liveTask)).toEqual({
      fileCount: undefined,
      lineCount: undefined,
      turnCount: 0,
    });
  });
});

describe('suggestTaskSplits', () => {
  beforeEach(() => {
    notifyOrchestratorMock.mockReset();
    notifyOrchestratorMock.mockReturnValue(true);
  });

  it('runごとのイベント上限で捨てられたら、splitSuggestedを立てず、次の判定で送り直す', () => {
    const notifyMock = vi.fn();
    const self = makeSelf(notifyMock);
    const live = makeLive({});
    notifyOrchestratorMock.mockReturnValueOnce(false);

    suggestTaskSplits(self, 'R1', live);

    expect(live.tasks.get('T1')?.splitSuggested).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).toHaveBeenCalledTimes(2);
    expect(live.tasks.get('T1')?.splitSuggested).toBe(true);
  });

  it('閾値を超えたタスクへ、taskSplitSuggestedイベントを1回送り、splitSuggestedを立てる', () => {
    const notifyMock = vi.fn();
    const self = makeSelf(notifyMock);
    const live = makeLive({});

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).toHaveBeenCalledTimes(1);
    expect(notifyOrchestratorMock).toHaveBeenCalledWith(
      self,
      'R1',
      expect.objectContaining({ kind: 'taskSplitSuggested' }),
    );
    expect(live.tasks.get('T1')?.splitSuggested).toBe(true);
    expect(notifyMock).toHaveBeenCalledWith('R1');
  });

  it('同じ試行で2回呼んでも、2回目は送らない（splitSuggestedが立ったまま）', () => {
    const self = makeSelf();
    const live = makeLive({});

    suggestTaskSplits(self, 'R1', live);
    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).toHaveBeenCalledTimes(1);
  });

  it('splitSuggested=falseのLiveTask（再試行を模す）へ差し替えると、再び送る', () => {
    const self = makeSelf();
    const live = makeLive({});

    suggestTaskSplits(self, 'R1', live);
    expect(notifyOrchestratorMock).toHaveBeenCalledTimes(1);

    // retryTaskが作り直したLiveTaskを模す: 実測値は引き継がず、splitSuggestedもfalseに戻る
    live.tasks.set('T1', makeExceedingTask());
    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).toHaveBeenCalledTimes(2);
  });

  it('mergingのタスクは対象外（HOLDING_STATESに含まれていても除く）', () => {
    const self = makeSelf();
    const live = makeLive({ taskState: 'merging' });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('pending（保持状態でない）タスクは対象外', () => {
    const self = makeSelf();
    const live = makeLive({ taskState: 'pending' });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('launchingTasksに含まれるタスクは対象外', () => {
    const self = makeSelf();
    const live = makeLive({ launching: true });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('orchestratorが居ないrunでは何もしない', () => {
    const self = makeSelf();
    const live = makeLive({ hasOrchestrator: false });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
    expect(live.tasks.get('T1')?.splitSuggested).toBe(false);
  });

  it('haltedByUserのrunでは何もしない', () => {
    const self = makeSelf();
    const live = makeLive({ haltedByUser: true });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('閾値を超えていなければ何もしない', () => {
    const self = makeSelf();
    const live = makeLive({
      task: makeExceedingTask({ touchedFiles: new Set(['a.ts']) }),
    });

    suggestTaskSplits(self, 'R1', live);

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });
});
