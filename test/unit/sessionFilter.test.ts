import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import { matchesSessionQuery, sessionNameHighlights } from '../../src/util/sessionFilter';

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

describe('sessionNameHighlights（issue #738）', () => {
  it('一致箇所を[開始, 終了)で返す', () => {
    expect(sessionNameHighlights('認証まわりの相談', '認証')).toEqual([[0, 2]]);
    expect(sessionNameHighlights('認証まわりの相談', 'まわり')).toEqual([[2, 5]]);
  });

  it('大小文字が違っても元の文字列の位置を返す', () => {
    // 陽性対照: 同じ綴りなら一致することを先に示す（この検査が常に空を返す形でないことの確認）
    expect(sessionNameHighlights('Fix Auth bug', 'Auth')).toEqual([[4, 8]]);
    expect(sessionNameHighlights('Fix Auth bug', 'auth')).toEqual([[4, 8]]);
    expect(sessionNameHighlights('Fix auth bug', 'AUTH')).toEqual([[4, 8]]);
  });

  it('複数回一致すればすべて返し、範囲は重ならない', () => {
    expect(sessionNameHighlights('auth auth', 'auth')).toEqual([
      [0, 4],
      [5, 9],
    ]);
    // 重なりうる語でも、前の一致の終端から先を探すので範囲は重ならない
    expect(sessionNameHighlights('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('空の語・空白だけの語は強調しない', () => {
    expect(sessionNameHighlights('認証まわりの相談', '')).toEqual([]);
    expect(sessionNameHighlights('認証まわりの相談', '   ')).toEqual([]);
  });

  it('前後の空白は落として照合する（matchesSessionQueryと同じ扱い）', () => {
    expect(sessionNameHighlights('認証まわりの相談', '  認証  ')).toEqual([[0, 2]]);
  });

  it('一致しなければ空配列', () => {
    expect(sessionNameHighlights('認証まわりの相談', 'デプロイ')).toEqual([]);
  });

  it('小文字化で長さが変わる文字を含むときは強調しない（位置がずれるため）', () => {
    // 陽性対照: この文字列は`toLowerCase()`で長さが伸びる
    expect('İstanbul'.toLowerCase().length).toBeGreaterThan('İstanbul'.length);
    expect(sessionNameHighlights('İstanbul', 'stan')).toEqual([]);
  });
});
