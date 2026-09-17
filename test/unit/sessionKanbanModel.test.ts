import { describe, expect, it } from 'vitest';
import { buildSessionKanban, type ManagedSessionInput } from '../../src/view/sessionKanbanModel';

const CURRENT_WINDOW_ID = 'w1';

function session(overrides: Partial<ManagedSessionInput> = {}): ManagedSessionInput {
  return {
    threadId: 't1',
    title: 'タイトル',
    cwd: '/home/u/work/repo',
    provider: 'codex',
    activity: 'idle',
    windowId: CURRENT_WINDOW_ID,
    ...overrides,
  };
}

describe('buildSessionKanban（issue #811・#1012、管理中の会話を状態別に並べる）', () => {
  it('活動状態ごとの列へ振り分け、総数を数える', () => {
    const board = buildSessionKanban(
      [
        session({ threadId: 'a', activity: 'approvalPending' }),
        session({ threadId: 'b', activity: 'running' }),
        session({ threadId: 'c', activity: 'idle' }),
      ],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    expect(board.cards.approvalPending.map((c) => c.threadId)).toEqual(['a']);
    expect(board.cards.running.map((c) => c.threadId)).toEqual(['b']);
    expect(board.cards.idle.map((c) => c.threadId)).toEqual(['c']);
    expect(board.total).toBe(3);
  });

  it('ワークスペース外の会話とcwdが無い会話は除く', () => {
    const board = buildSessionKanban(
      [
        session({ threadId: 'in', cwd: '/home/u/work/repo/sub' }),
        session({ threadId: 'out', cwd: '/home/u/other' }),
        session({ threadId: 'none', cwd: undefined }),
      ],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    expect(board.cards.idle.map((c) => c.threadId)).toEqual(['in']);
    expect(board.total).toBe(1);
  });

  it('末尾の区切りと区切りの向きが違っても同じワークスペースとみなす', () => {
    const board = buildSessionKanban(
      [session({ cwd: 'C:\\work\\repo\\pkg' })],
      ['C:/work/repo/'],
      CURRENT_WINDOW_ID,
    );
    expect(board.total).toBe(1);
  });

  it('先頭が一致するだけの別ディレクトリは入れない', () => {
    const board = buildSessionKanban(
      [session({ cwd: '/home/u/work/repo-2' })],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    expect(board.total).toBe(0);
  });

  it('cwdの末尾をカードの表示名にする', () => {
    const board = buildSessionKanban(
      [session({ cwd: '/home/u/work/repo/pkg/app' })],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    expect(board.cards.idle[0]?.cwdLabel).toBe('app');
  });

  it('常時表示のcwdLabelには絶対パスを載せない（issue 1039、hover専用cwdFullはIssue #1244で追加）', () => {
    const board = buildSessionKanban(
      [session({ cwd: '/home/u/work/repo/pkg/app' })],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    const card = board.cards.idle[0];
    // 陽性対照: カード自体は作られている（条件を間違えて空を見ていない）
    expect(card?.cwdLabel).toBe('app');
    // 画面共有やスクリーンショットでホームディレクトリ名などが映らないよう、
    // 常時表示のcwdLabelは末尾の要素だけを持つ。絶対パスはhover専用のcwdFullにだけ載る
    expect(card).not.toHaveProperty('cwd');
    expect(card?.cwdFull).toBe('/home/u/work/repo/pkg/app');
  });

  it('各列をタイトルの昇順で並べる', () => {
    const board = buildSessionKanban(
      [
        session({ threadId: '1', title: 'さくら' }),
        session({ threadId: '2', title: 'あさひ' }),
        session({ threadId: '3', title: 'かえで' }),
      ],
      ['/home/u/work/repo'],
      CURRENT_WINDOW_ID,
    );
    expect(board.cards.idle.map((c) => c.title)).toEqual(['あさひ', 'かえで', 'さくら']);
  });

  it('複数のワークスペースルートのいずれかに入っていれば残す', () => {
    const board = buildSessionKanban(
      [session({ threadId: 'a', cwd: '/srv/one' }), session({ threadId: 'b', cwd: '/srv/two' })],
      ['/srv/one', '/srv/two'],
      CURRENT_WINDOW_ID,
    );
    expect(board.total).toBe(2);
  });
});
