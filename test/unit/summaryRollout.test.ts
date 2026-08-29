import { describe, expect, it } from 'vitest';
import {
  removeSummaryRollout,
  type SummaryRolloutDeps,
} from '../../src/secondOpinion/summaryRollout';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-8888-7777-6666-555555555555';

function metaLine(sessionId: string): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { session_id: sessionId, cwd: '/tmp/x', timestamp: '2026-08-29T00:00:00Z' },
  });
}

function rolloutPath(sessionId: string): string {
  return `/home/u/.codex/sessions/2026/08/29/rollout-2026-08-29T00-00-00-${sessionId}.jsonl`;
}

interface Harness {
  deps: SummaryRolloutDeps;
  removed: string[];
}

function harness(overrides: Partial<SummaryRolloutDeps> = {}): Harness {
  const removed: string[] = [];
  const deps: SummaryRolloutDeps = {
    sessionsDir: '/home/u/.codex/sessions',
    listRollouts: async () => [rolloutPath(SESSION_ID)],
    readFirstLine: async () => metaLine(SESSION_ID),
    removeFile: async (filePath) => {
      removed.push(filePath);
    },
    ...overrides,
  };
  return { deps, removed };
}

/** 待ちを実際には行わない。`not-found` の再試行が絡むテストが実時間を使わないようにする。 */
const noWait = { intervalMs: 0, sleep: async () => {} };

describe('removeSummaryRollout', () => {
  it('ファイル名と session_meta の両方が一致した1件だけを消す', async () => {
    const { deps, removed } = harness();

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('removed');
    expect(removed).toEqual([rolloutPath(SESSION_ID)]);
  });

  it('他のセッションのrolloutは候補にすらしない', async () => {
    const { deps, removed } = harness({ listRollouts: async () => [rolloutPath(OTHER_ID)] });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('not-found');
    expect(removed).toEqual([]);
  });

  it('ファイル名は一致しても session_meta が違えば消さない', async () => {
    const { deps, removed } = harness({ readFirstLine: async () => metaLine(OTHER_ID) });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('mismatched');
    expect(removed).toEqual([]);
  });

  it('先頭行が session_meta として読めなければ消さない', async () => {
    const { deps, removed } = harness({ readFirstLine: async () => 'not json' });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('mismatched');
    expect(removed).toEqual([]);
  });

  it('候補が複数あるときは消さない', async () => {
    const { deps, removed } = harness({
      listRollouts: async () => [rolloutPath(SESSION_ID), `${rolloutPath(SESSION_ID)}.bak`],
    });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('mismatched');
    expect(removed).toEqual([]);
  });

  it('まだ書かれていないときは待って試し直す', async () => {
    let calls = 0;
    const { deps, removed } = harness({
      listRollouts: async () => {
        calls += 1;
        return calls < 3 ? [] : [rolloutPath(SESSION_ID)];
      },
    });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('removed');
    expect(calls).toBe(3);
    expect(removed).toEqual([rolloutPath(SESSION_ID)]);
  });

  it('試行回数を使い切っても見つからなければ not-found', async () => {
    const { deps } = harness({ listRollouts: async () => [] });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, { ...noWait, attempts: 2 });

    expect(outcome).toBe('not-found');
  });

  it('削除が失敗しても例外を投げず failed を返す', async () => {
    const { deps } = harness({
      removeFile: async () => {
        throw new Error('EACCES');
      },
    });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, noWait);

    expect(outcome).toBe('failed');
  });

  it('走査が失敗しても例外を投げない', async () => {
    const { deps } = harness({
      listRollouts: async () => {
        throw new Error('ENOENT');
      },
    });

    const outcome = await removeSummaryRollout(SESSION_ID, deps, { ...noWait, attempts: 1 });

    expect(outcome).toBe('not-found');
  });

  it('セッションIDが空なら走査もしない', async () => {
    let called = false;
    const { deps } = harness({
      listRollouts: async () => {
        called = true;
        return [];
      },
    });

    const outcome = await removeSummaryRollout('  ', deps, noWait);

    expect(outcome).toBe('not-found');
    expect(called).toBe(false);
  });
});
