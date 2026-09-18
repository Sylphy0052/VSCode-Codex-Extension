import { describe, expect, it } from 'vitest';
import type { PersistedProgram } from '../../src/orchestrator/programStore';
import type { LiveRunSummary } from '../../src/orchestrator/runner';
import { buildFeedRuns } from '../../src/orchestrator/workflowFeed';

/**
 * run一覧へプログラム所属を付ける突き合わせ（`buildFeedRuns`、Issue #1272）。
 *
 * この対応付けはこれまでViewが持っていた「2種類のデータの突き合わせ」にあたる部分で、
 * feedの純粋関数へ寄せた。ここが崩れると、単発runとプログラムのrunの区別が付かなくなる。
 */

function run(runId: string): LiveRunSummary {
  return { runId, name: runId, defPath: `${runId}.yaml`, outcome: 'running' };
}

function program(
  programId: string,
  runs: Record<string, string | undefined>,
): PersistedProgram {
  return {
    programId,
    defPath: `${programId}.yaml`,
    workspaceRoot: '/repo',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: undefined,
    state: {
      haltedByUser: false,
      runs: Object.fromEntries(
        Object.entries(runs).map(([runRefId, runId]) => [
          runRefId,
          { state: runId === undefined ? 'pending' : 'running', runId, skipReason: undefined },
        ]),
      ),
    } as PersistedProgram['state'],
  };
}

describe('buildFeedRuns: run一覧へプログラム所属を付ける（Issue #1272）', () => {
  it('プログラムが起動したrunにはprogramIdとrun参照名が付く', () => {
    const feed = buildFeedRuns([run('run-1')], [program('p1', { R1: 'run-1' })]);
    expect(feed).toEqual([{ ...run('run-1'), programId: 'p1', programRunRefId: 'R1' }]);
  });

  it('プログラムに属さない単発runは同じ配列に並び、programIdがundefinedになる', () => {
    const feed = buildFeedRuns(
      [run('run-1'), run('run-2')],
      [program('p1', { R1: 'run-1' })],
    );
    expect(feed.map((r) => [r.runId, r.programId])).toEqual([
      ['run-1', 'p1'],
      ['run-2', undefined],
    ]);
  });

  it('まだ起動していないrun参照（runIdが無い）はどのrunにも結び付かない', () => {
    const feed = buildFeedRuns([run('run-1')], [program('p1', { R1: 'run-1', R2: undefined })]);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.programRunRefId).toBe('R1');
  });

  it('プログラム一覧が空でもrun一覧はそのまま返る（プログラム層が未配線の場合）', () => {
    const feed = buildFeedRuns([run('run-1')], []);
    expect(feed).toEqual([{ ...run('run-1'), programId: undefined, programRunRefId: undefined }]);
  });

  it('同じrunIdを複数のプログラムが参照していたら先に見つかった方を採る', () => {
    const feed = buildFeedRuns(
      [run('run-1')],
      [program('p1', { R1: 'run-1' }), program('p2', { R9: 'run-1' })],
    );
    expect(feed[0]?.programId).toBe('p1');
  });
});
