import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import { buildDateGroups, buildFolderGroups } from '../../src/util/sessionGrouping';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    provider: 'codex',
    threadName: undefined,
    updatedAt: new Date(0).toISOString(),
    cwd: '/tmp/example',
    archived: false,
    ...overrides,
  };
}

const iso = (y: number, m: number, d: number): string => new Date(y, m - 1, d, 12, 0).toISOString();
const NOW = new Date(2026, 7, 16, 12, 0).getTime();

describe('buildDateGroups（issue #293）', () => {
  it('今日・昨日・今週・それ以前の順に並べる', () => {
    const sessions = [
      session({ id: 'older', updatedAt: iso(2026, 1, 1) }),
      session({ id: 'today', updatedAt: iso(2026, 8, 16) }),
      session({ id: 'thisWeek', updatedAt: iso(2026, 8, 12) }),
      session({ id: 'yesterday', updatedAt: iso(2026, 8, 15) }),
    ];

    const groups = buildDateGroups(sessions, NOW);

    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'thisWeek', 'older']);
    expect(groups.map((g) => g.label)).toEqual(['今日', '昨日', '今週', 'それ以前']);
  });

  it('該当セッションが無いバケットは出さない', () => {
    const sessions = [session({ id: 'a', updatedAt: iso(2026, 8, 16) })];

    const groups = buildDateGroups(sessions, NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('today');
  });

  it('各グループ内は入力順を保つ', () => {
    const sessions = [
      session({ id: 'a', updatedAt: iso(2026, 8, 16) }),
      session({ id: 'b', updatedAt: iso(2026, 8, 16) }),
    ];

    const groups = buildDateGroups(sessions, NOW);

    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('セッションが無ければ空配列', () => {
    expect(buildDateGroups([], NOW)).toEqual([]);
  });
});

describe('buildFolderGroups（issue #293）', () => {
  it('cwdごとにグループ化し、basenameをラベルにする', () => {
    const sessions = [
      session({ id: 'a', cwd: '/home/user/project-a' }),
      session({ id: 'b', cwd: '/home/user/project-b' }),
      session({ id: 'c', cwd: '/home/user/project-a' }),
    ];

    const groups = buildFolderGroups(sessions);

    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === '/home/user/project-a')?.label).toBe('project-a');
    expect(groups.find((g) => g.key === '/home/user/project-a')?.sessions.map((s) => s.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('グループの並びは初出（＝入力が更新時刻降順なら最新順）を保つ', () => {
    const sessions = [
      session({ id: 'a', cwd: '/repo/newer' }),
      session({ id: 'b', cwd: '/repo/older' }),
      session({ id: 'c', cwd: '/repo/newer' }),
    ];

    const groups = buildFolderGroups(sessions);

    expect(groups.map((g) => g.key)).toEqual(['/repo/newer', '/repo/older']);
  });

  it('basenameが衝突する異なるパスはフルパスで区別する', () => {
    const sessions = [
      session({ id: 'a', cwd: '/home/user-a/app' }),
      session({ id: 'b', cwd: '/home/user-b/app' }),
    ];

    const groups = buildFolderGroups(sessions);

    expect(groups.map((g) => g.label).sort()).toEqual(['/home/user-a/app', '/home/user-b/app']);
  });

  it('cwdが無いセッションは「不明な作業ディレクトリ」へまとめる', () => {
    const sessions = [session({ id: 'a', cwd: undefined }), session({ id: 'b', cwd: undefined })];

    const groups = buildFolderGroups(sessions);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('不明な作業ディレクトリ');
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
