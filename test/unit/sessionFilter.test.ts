import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import { matchesSessionQuery } from '../../src/util/sessionFilter';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    provider: 'codex',
    threadName: '認証まわりの相談',
    updatedAt: new Date(0).toISOString(),
    cwd: '/home/user/my-project',
    archived: false,
    ...overrides,
  };
}

describe('matchesSessionQuery（issue #293）', () => {
  it('空文字は常に一致する（絞り込み無し扱い）', () => {
    expect(matchesSessionQuery(session(), '')).toBe(true);
    expect(matchesSessionQuery(session(), '   ')).toBe(true);
  });

  it('セッション名に部分一致する', () => {
    expect(matchesSessionQuery(session({ threadName: '認証まわりの相談' }), '認証')).toBe(true);
  });

  it('作業ディレクトリに部分一致する', () => {
    expect(matchesSessionQuery(session({ cwd: '/home/user/my-project' }), 'my-project')).toBe(true);
  });

  it('大小文字を無視する', () => {
    expect(matchesSessionQuery(session({ threadName: 'Refactor Auth' }), 'refactor')).toBe(true);
    expect(matchesSessionQuery(session({ cwd: '/repo/MyProject' }), 'myproject')).toBe(true);
  });

  it('どちらにも一致しなければfalse', () => {
    expect(matchesSessionQuery(session({ threadName: '設計方針', cwd: '/repo/a' }), 'zzz')).toBe(
      false,
    );
  });

  it('threadName・cwdが無いセッションでも例外にならない', () => {
    expect(matchesSessionQuery(session({ threadName: undefined, cwd: undefined }), 'query')).toBe(
      false,
    );
    expect(matchesSessionQuery(session({ threadName: undefined, cwd: undefined }), '')).toBe(true);
  });
});
