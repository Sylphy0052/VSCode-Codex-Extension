import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/orchestrator/runnerOrchestrator', () => ({
  notifyOrchestrator: vi.fn(),
}));

import { notifyOrchestrator } from '../../src/orchestrator/runnerOrchestrator';
import {
  notifyInstructionResult,
  notifyUnansweredInstructions,
} from '../../src/orchestrator/runnerInstruction';
import type { Logger } from '../../src/log';
import type { LiveRun } from '../../src/orchestrator/runner';
import type { WorkflowRunnerInternals } from '../../src/orchestrator/runnerInternals';
import type { InstructionReport } from '../../src/orchestrator/messaging';

const notifyOrchestratorMock = vi.mocked(notifyOrchestrator);

/** WorkflowRunnerInternalsの最小フェイクに必要なログ */
function makeLogger(): { log: Logger; warnCalls: string[] } {
  const warnCalls: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (message: string) => {
      warnCalls.push(message);
    },
    error: () => undefined,
    show: () => undefined,
  };
  return { log, warnCalls };
}

function makeSelf(overrides: { readOverlapIgnore?: () => readonly string[] } = {}): {
  self: WorkflowRunnerInternals;
  runs: Map<string, LiveRun>;
  warnCalls: string[];
} {
  const { log, warnCalls } = makeLogger();
  const runs = new Map<string, LiveRun>();
  const self = {
    deps: {
      log,
      verificationStore: undefined,
      readOverlapIgnore: overrides.readOverlapIgnore,
    },
    runs,
  } as unknown as WorkflowRunnerInternals;
  return { self, runs, warnCalls };
}

function makeLive(taskId: string, taskOverrides: Record<string, unknown> = {}): LiveRun {
  return {
    tasks: new Map([
      [
        taskId,
        { usedWorktree: false, originCommit: '', touchedFiles: undefined, ...taskOverrides },
      ],
    ]),
  } as unknown as LiveRun;
}

const report: InstructionReport = {
  instructionId: 'inst-1',
  result: '対応した',
  unresolved: [],
  count: undefined,
  countUnit: undefined,
};

describe('notifyInstructionResult/notifyUnansweredInstructions直接呼び出し（Issue #1502）', () => {
  beforeEach(() => {
    notifyOrchestratorMock.mockReset();
  });

  it('await中にself.runsのrunが差し替わると、notifyInstructionResultは通知しない', async () => {
    const { self, runs } = makeSelf();
    const live1 = makeLive('T1');
    runs.set('R1', live1);

    const promise = notifyInstructionResult(self, 'R1', live1, 'T1', report);
    runs.set('R1', makeLive('T1')); // await中にrunを差し替える
    await promise;

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('await中にself.runsのrunが差し替わると、notifyUnansweredInstructionsは通知しない', async () => {
    const { self, runs } = makeSelf();
    const live1 = makeLive('T1');
    runs.set('R1', live1);

    const promise = notifyUnansweredInstructions(self, 'R1', live1, 'T1', ['inst-1']);
    runs.set('R1', makeLive('T1')); // await中にrunを差し替える
    await promise;

    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('観測収集（observeOverlap）が例外を投げても、rejectせずlog.warnで済ませる', async () => {
    const { self, runs, warnCalls } = makeSelf({
      readOverlapIgnore: () => {
        throw new Error('boom-overlap');
      },
    });
    const live = makeLive('T1', {
      usedWorktree: true,
      originCommit: 'abc123',
      touchedFiles: new Set(['a.ts']),
    });
    runs.set('R1', live);

    await expect(notifyInstructionResult(self, 'R1', live, 'T1', report)).resolves.toBeUndefined();
    expect(warnCalls.length).toBe(1);
    expect(notifyOrchestratorMock).not.toHaveBeenCalled();
  });

  it('notifyOrchestrator自体が例外を投げても、rejectせずlog.warnで済ませる', async () => {
    notifyOrchestratorMock.mockImplementation(() => {
      throw new Error('boom-notify');
    });
    const { self, runs, warnCalls } = makeSelf();
    const live = makeLive('T1');
    runs.set('R1', live);

    await expect(notifyInstructionResult(self, 'R1', live, 'T1', report)).resolves.toBeUndefined();
    expect(warnCalls.length).toBe(1);
  });
});
