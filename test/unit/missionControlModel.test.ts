import { describe, expect, it } from 'vitest';
import {
  ActivitySince,
  buildMissionControlSnapshot,
  createRepoResolver,
  missionControlTitle,
  type McSessionInput,
} from '../../src/view/missionControlModel';
import type { PendingItem } from '../../src/view/pendingItem';

/** `.git`の置き場所だけを持つ偽のファイルシステム。 */
function fakeFs(entries: Record<string, 'dir' | string>): Parameters<typeof createRepoResolver>[0] {
  return {
    gitEntry: (dir) => {
      const entry = entries[`${dir}/.git`];
      return entry === undefined ? undefined : entry === 'dir' ? 'dir' : 'file';
    },
    readText: (file) => {
      const entry = entries[file];
      return entry === undefined || entry === 'dir' ? undefined : entry;
    },
  };
}

describe('createRepoResolver（Issue #2136）', () => {
  it('cwdから上へ辿ってgitのtoplevelをrepoにする', () => {
    const resolve = createRepoResolver(fakeFs({ '/w/app/.git': 'dir' }));
    expect(resolve('/w/app/src/view')).toEqual({ key: '/w/app', label: 'app', full: '/w/app' });
  });

  it('worktreeは元のrepoへまとめる', () => {
    const resolve = createRepoResolver(
      fakeFs({
        '/w/app/.git': 'dir',
        '/w/app/.agents/worktrees/T6/.git': 'gitdir: /w/app/.git/worktrees/T6\n',
      }),
    );
    expect(resolve('/w/app/.agents/worktrees/T6/src').key).toBe('/w/app');
  });

  it('worktreeの形でない.gitファイル（submodule等）はその場所をrepoにする', () => {
    const resolve = createRepoResolver(
      fakeFs({ '/w/app/lib/.git': 'gitdir: ../.git/modules/lib\n', '/w/app/.git': 'dir' }),
    );
    expect(resolve('/w/app/lib').key).toBe('/w/app/lib');
  });

  it('gitの外・cwd不明でも1つのrepoとして扱う', () => {
    const resolve = createRepoResolver(fakeFs({}));
    expect(resolve('/tmp/x').key).toBe('/tmp/x');
    expect(resolve(undefined).label).toBe('(不明)');
  });
});

function session(overrides: Partial<McSessionInput>): McSessionInput {
  return {
    threadId: 't1',
    title: '会話',
    cwd: '/w/app',
    provider: 'codex',
    activity: 'idle',
    windowId: 'w-self',
    ...overrides,
  };
}

function pending(overrides: Partial<PendingItem> & { id: string }): PendingItem {
  return {
    kind: 'toolApproval',
    session: { windowId: 'w-self', threadId: 't1', provider: 'codex' },
    cwd: '/w/app',
    title: '承認',
    createdAt: 100,
    payload: { summary: 'npm test', requestId: '1' },
    answer: 'decision',
    ...overrides,
  };
}

const resolveByCwd = createRepoResolver(fakeFs({ '/w/app/.git': 'dir', '/w/other/.git': 'dir' }));

describe('buildMissionControlSnapshot（Issue #2136）', () => {
  it('2ウィンドウ・別repoのセッションをrepo別にまとめ、待ちの長い順に並べる', () => {
    const snapshot = buildMissionControlSnapshot({
      sessions: [
        session({
          threadId: 'a',
          pending: [pending({ id: 'p-new', createdAt: 300 })],
          activity: 'approvalPending',
        }),
        session({
          threadId: 'b',
          windowId: 'w-other',
          cwd: '/w/other/src',
          provider: 'claude',
          pending: [
            pending({
              id: 'p-old',
              createdAt: 100,
              kind: 'askUserQuestion',
              session: { windowId: 'w-other', threadId: 'b', provider: 'claude' },
              cwd: '/w/other/src',
            }),
          ],
        }),
      ],
      windowPending: [
        pending({
          id: 'taskRun:r:T1:q',
          kind: 'taskRunQuestion',
          createdAt: 200,
          session: { windowId: 'w-other', threadId: 'r', provider: 'claude' },
          cwd: '/w/other',
          payload: { summary: 'どちら？', options: ['A', 'B'] },
          answer: 'text',
        }),
      ],
      currentWindowId: 'w-self',
      resolveRepo: resolveByCwd,
      activitySince: new ActivitySince(() => 50),
      now: 1_000,
    });
    expect(snapshot.pending.map((p) => p.id)).toEqual(['p-old', 'taskRun:r:T1:q', 'p-new']);
    expect(snapshot.repos.map((r) => [r.label, r.sessionCount, r.pendingCount])).toEqual([
      ['other', 1, 2],
      ['app', 1, 1],
    ]);
    const other = snapshot.sessions.find((s) => s.threadId === 'b');
    expect(other).toMatchObject({
      repoKey: '/w/other',
      isCurrentWindow: false,
      cwdLabel: 'src',
      pendingCount: 1,
      activitySince: 50,
    });
    expect(snapshot.pending[1]).toMatchObject({ options: ['A', 'B'], isCurrentWindow: false });
  });

  it('同じidの待ち項目は1行にする', () => {
    const item = pending({ id: 'dup' });
    const snapshot = buildMissionControlSnapshot({
      sessions: [session({ pending: [item] })],
      windowPending: [item],
      currentWindowId: 'w-self',
      resolveRepo: resolveByCwd,
      activitySince: new ActivitySince(),
      now: 0,
    });
    expect(snapshot.pending).toHaveLength(1);
  });
});

describe('ActivitySince', () => {
  it('状態が変わるまで最初に見た時刻を返し、消えたセッションは忘れる', () => {
    let now = 10;
    const since = new ActivitySince(() => now);
    expect(since.stamp('s', 'running')).toBe(10);
    now = 20;
    expect(since.stamp('s', 'running')).toBe(10);
    expect(since.stamp('s', 'idle')).toBe(20);
    since.retain(new Set());
    now = 30;
    expect(since.stamp('s', 'idle')).toBe(30);
  });
});

describe('missionControlTitle', () => {
  it('タブ名に要対応の件数を付ける', () => {
    expect(missionControlTitle(3)).toBe('MC (3)');
    expect(missionControlTitle(0)).toBe('MC (0)');
  });
});
