import { describe, expect, it } from 'vitest';
import {
  createWorkflowFeed,
  type WorkflowChange,
  type WorkflowFeedRunnerPort,
} from '../../src/orchestrator/workflowFeed';
import type { LiveRunSummary, WorkflowRunSnapshot } from '../../src/orchestrator/runner';

/**
 * `createWorkflowFeed`（Issue #1272。複数runを束ねるプログラム機能はIssue #1679で削除済み）。
 *
 * Viewが読む窓口はこれ1つだけなので、通知の中継とスナップショットの組み立てが
 * 正しいことをここで確認する。
 */

function run(runId: string): LiveRunSummary {
  return { runId, name: runId, defPath: `${runId}.yaml`, outcome: 'running' };
}

function fakeRunnerPort(opts: {
  runs: readonly LiveRunSummary[];
  snapshots?: Record<string, WorkflowRunSnapshot>;
}): WorkflowFeedRunnerPort & { fire: (runId: string) => void } {
  const listeners: Array<(runId: string) => void> = [];
  return {
    listLive: () => opts.runs,
    getSnapshot: (runId) => opts.snapshots?.[runId],
    onChanged: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    fire: (runId) => listeners.forEach((l) => l(runId)),
  };
}

describe('createWorkflowFeed', () => {
  it('runnerの変化通知をkind: runの1本として中継する', () => {
    const runner = fakeRunnerPort({ runs: [run('run-1')] });
    const feed = createWorkflowFeed({ runner });
    const changes: WorkflowChange[] = [];
    feed.onChanged((change) => changes.push(change));

    runner.fire('run-1');

    expect(changes).toEqual([{ kind: 'run', runId: 'run-1' }]);
  });

  it('getSnapshotはrun一覧と表示中のrunを1回の呼び出しでまとめて返す', () => {
    const snapshot = { runId: 'run-1' } as unknown as WorkflowRunSnapshot;
    const runner = fakeRunnerPort({ runs: [run('run-1')], snapshots: { 'run-1': snapshot } });
    const feed = createWorkflowFeed({ runner });

    expect(feed.getSnapshot('run-1')).toEqual({ runs: [run('run-1')], activeRun: snapshot });
  });

  it('activeRunIdが未指定ならactiveRunはundefinedになる', () => {
    const runner = fakeRunnerPort({ runs: [run('run-1')] });
    const feed = createWorkflowFeed({ runner });

    expect(feed.getSnapshot(undefined)).toEqual({ runs: [run('run-1')], activeRun: undefined });
  });

  it('disposeで購読を解除する', () => {
    const runner = fakeRunnerPort({ runs: [] });
    const feed = createWorkflowFeed({ runner });
    const changes: WorkflowChange[] = [];
    feed.onChanged((change) => changes.push(change));

    feed.dispose();
    runner.fire('run-1');

    expect(changes).toEqual([]);
  });
});
