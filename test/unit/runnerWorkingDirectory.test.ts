import { describe, expect, it, vi } from 'vitest';

import type { CarriedOverWork } from '../../src/orchestrator/resumeCarryOver';
import type { LiveRun } from '../../src/orchestrator/runner';
import type { WorkflowRunnerInternals } from '../../src/orchestrator/runnerInternals';
import { resolveWorkingDirectory } from '../../src/orchestrator/runnerWorkingDirectory';
import type { WorkflowTask } from '../../src/orchestrator/workflow';

function carried(retry: number | undefined): CarriedOverWork {
  return {
    cwd: '/repo/.worktree/run/T1',
    branch: 'wf/run/T1',
    retry,
    originCommit: 'b'.repeat(40),
    uncommittedCount: 1,
    commitCount: 0,
    files: ['src/a.ts'],
    addedLines: 3,
    deletedLines: 1,
  };
}

function setup(work: CarriedOverWork): {
  self: WorkflowRunnerInternals;
  live: LiveRun;
  task: WorkflowTask;
  createWithOrigin: ReturnType<typeof vi.fn>;
} {
  const createWithOrigin = vi.fn(async () => ({
    ok: true,
    cwd: '/repo/.worktree/run/T1-1',
    branch: 'wf/run/T1-1',
    originCommit: 'c'.repeat(40),
  }));
  const self = {
    deps: { worktreeQueue: { createWithOrigin }, git: {}, fs: {} },
  } as unknown as WorkflowRunnerInternals;
  const live = {
    runId: 'run',
    repoRoot: '/repo',
    gitRepo: true,
    integration: { branch: 'wf/run/integration' },
    carriedOverWork: new Map([['T1', work]]),
  } as unknown as LiveRun;
  const task = {
    id: 'T1',
    isolation: 'worktree',
    cwd: undefined,
    type: 'chore',
    issue: undefined,
  } as unknown as WorkflowTask;
  return { self, live, task, createWithOrigin };
}

describe('resolveWorkingDirectory の作業の引き継ぎ（Issue #1514・#1521）', () => {
  it('試行の添字が一致すれば、前の試行のworktreeとブランチをそのまま使う', async () => {
    const work = carried(1);
    const { self, live, task, createWithOrigin } = setup(work);

    const result = await resolveWorkingDirectory(self, live, task, 1);

    expect(result.cwd).toBe(work.cwd);
    expect(result.branch).toBe(work.branch);
    expect(result.carriedOver).toBe(work);
    expect(createWithOrigin).not.toHaveBeenCalled();
    expect(live.carriedOverWork.has('T1')).toBe(false);
  });

  it('試行の添字がずれていれば、引き継がずに新しいworktreeを作り、引き継ぎ情報を捨てる', async () => {
    const { self, live, task, createWithOrigin } = setup(carried(0));

    const result = await resolveWorkingDirectory(self, live, task, 1);

    expect(createWithOrigin).toHaveBeenCalledTimes(1);
    expect(result.cwd).toBe('/repo/.worktree/run/T1-1');
    expect(result.carriedOver).toBeUndefined();
    expect(live.carriedOverWork.has('T1')).toBe(false);
  });
});
