import { describe, expect, it } from 'vitest';
import { parseSessionMeta } from '../../src/codex/sessionMeta';
import { SessionBinder, createLaunchTag } from '../../src/terminal/sessionBinder';
import { FakeClock } from '../../src/util/clock';

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

const build = (timeoutMs = 15_000) => {
  const clock = new FakeClock(1_000);
  return { clock, binder: new SessionBinder(clock, timeoutMs) };
};

describe('SessionBinder', () => {
  it('タグが一致したロールアウトで紐付けが確定する', () => {
    const { binder } = build();
    binder.register('tag-1');

    const bound = binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'));

    expect(bound).toEqual({ tag: 'tag-1', sessionId: ID_A, cwd: '/work/alpha' });
    expect(binder.pendingTags()).toEqual([]);
  });

  it('他プロセスが作ったセッションを掴まない', () => {
    const { binder } = build();
    binder.register('tag-1');

    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'codex_vscode'))).toBeUndefined();
    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, undefined))).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('パースできなかったmetaを無視する', () => {
    const { binder } = build();
    binder.register('tag-1');
    expect(binder.onRolloutCreated(fileName(ID_A), undefined)).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('同時に開いた複数タブがそれぞれ自分のセッションに紐付く', () => {
    const { binder } = build();
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
    const { binder } = build();
    binder.register('tag-1');
    expect(binder.onRolloutCreated(fileName(ID_B), meta(ID_A, 'tag-1'))).toBeUndefined();
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('タイムアウト前は回収しない', () => {
    const { clock, binder } = build(15_000);
    binder.register('tag-1');
    clock.advance(14_999);
    expect(binder.sweep()).toEqual([]);
    expect(binder.pendingTags()).toEqual(['tag-1']);
  });

  it('タイムアウトしたタグを回収し、以後は紐付かない', () => {
    const { clock, binder } = build(15_000);
    binder.register('tag-1');
    clock.advance(15_000);

    expect(binder.sweep()).toEqual(['tag-1']);
    expect(binder.pendingTags()).toEqual([]);
    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'))).toBeUndefined();
  });

  it('回収は期限切れのものだけを対象にする', () => {
    const { clock, binder } = build(15_000);
    binder.register('old');
    clock.advance(10_000);
    binder.register('new');
    clock.advance(5_000);

    expect(binder.sweep()).toEqual(['old']);
    expect(binder.pendingTags()).toEqual(['new']);
  });

  it('cancelで待ちを取り下げる', () => {
    const { binder } = build();
    binder.register('tag-1');
    binder.cancel('tag-1');
    expect(binder.pendingTags()).toEqual([]);
    expect(binder.onRolloutCreated(fileName(ID_A), meta(ID_A, 'tag-1'))).toBeUndefined();
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
