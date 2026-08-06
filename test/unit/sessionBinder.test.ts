import { describe, expect, it } from 'vitest';
import { parseSessionMeta } from '../../src/codex/sessionMeta';
import { SessionBinder, createLaunchTag } from '../../src/terminal/sessionBinder';

const ID_A = '019fd79f-1e16-7b60-b9d2-0324b275ed81';
const ID_B = '019fd7a6-d25e-7bd2-b181-751e467277f3';

const fileName = (id: string) => `rollout-2026-08-07T00-00-00-${id}.jsonl`;

const meta = (id: string, originator: string | undefined, cwd = '/work/alpha') =>
  parseSessionMeta(
    JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: id,
        cwd,
        timestamp: '2026-08-06T15:00:00Z',
        ...(originator === undefined ? {} : { originator }),
        source: 'vscode',
        thread_source: 'user',
      },
    }),
  );

describe('SessionBinder', () => {
  it('タグが一致したロールアウトで紐付けが確定する', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');

    const bound = binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'));

    expect(bound).toEqual({ tag: 'tag-1', sessionId: ID_A, cwd: '/work/alpha' });
    expect(binder.pendingTags()).toEqual([]);
  });

  it('他プロセスが作ったセッションを掴まない', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');

    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'codex_vscode'))).toBeUndefined();
    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, undefined))).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('パースできなかったmetaを無視する', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');
    expect(binder.onRolloutCreated(fileName(ID_A), undefined)).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('同時に開いた複数タブがそれぞれ自分のセッションに紐付く', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');
    binder.register('tag-2');

    // 起動順と逆にファイルが現れても取り違えない
    const second = binder.onRolloutCreated(fileName(ID_B), meta(ID_B, 'tag-2'));
    const first = binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'));

    expect(second?.sessionId).toBe(ID_B);
    expect(first?.sessionId).toBe(ID_A);
    expect(binder.pendingTags()).toEqual([]);
  });

  it('ファイル名のidと session_meta のidが食い違えば信用しない', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');
    expect(binder.onRolloutCreated(fileName(ID_B), meta(ID_A, 'tag-1'))).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('発言まで時間が空いても待ち続ける（TUIは初回発言時にrolloutを作る）', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');

    // 何度も無関係なロールアウトが現れても取り下げない
    binder.onRolloutCreated(fileName(ID_B), meta(ID_B, 'codex_vscode'));
    binder.onRolloutCreated(fileName(ID_B), meta(ID_B, 'other-tag'));
    expect(binder.pendingTags()).toEqual(['tag-1']);

    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'))?.sessionId).toBe(ID_A);
  });

  it('cancelで待ちを取り下げる', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');
    binder.cancel('tag-1');
    expect(binder.pendingTags()).toEqual([]);
    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'))).toBeUndefined();
  });

  it('同じタグを二重に登録しても1件として扱う', () => {
    const binder = new SessionBinder();
    binder.register('tag-1');
    binder.register('tag-1');
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });
});

describe('createLaunchTag', () => {
  it('呼ぶたびに異なる値を返す', () => {
    const a = createLaunchTag();
    const b = createLaunchTag();
    expect(a).not.toBe(b);
    expect(a.startsWith('vscode-codex-')).toBe(true);
  });
});
