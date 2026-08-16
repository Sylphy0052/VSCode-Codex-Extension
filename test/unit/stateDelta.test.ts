import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { MERGE_ITEMS_SOURCE, buildItemsDelta } from '../../src/view/stateDelta';

const item = (id: string, text = ''): ChatItem => ({
  id,
  kind: 'agentMessage',
  text,
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
});

describe('buildItemsDelta（issue #262）', () => {
  it('前回が無ければ全量を送る', () => {
    const items = [item('a'), item('b')];

    expect(buildItemsDelta(undefined, items)).toEqual({ mode: 'full', items, total: 2 });
  });

  it('末尾に増えた分だけ送る', () => {
    const a = item('a');
    const b = item('b');

    const delta = buildItemsDelta([a], [a, b]);

    expect(delta).toEqual({ mode: 'delta', items: [b], total: 2 });
  });

  it('変わっていない項目は送らない（参照で見る）', () => {
    const a = item('a');
    const b = item('b', '書きかけ');
    const grown = { ...b, text: '書きかけの続き' };

    const delta = buildItemsDelta([a, b], [a, grown]);

    expect(delta).toEqual({ mode: 'delta', items: [grown], total: 2 });
  });

  it('何も変わっていなければ空の差分になる', () => {
    const items = [item('a'), item('b')];

    expect(buildItemsDelta(items, items)).toEqual({ mode: 'delta', items: [], total: 2 });
  });

  it('並びが変わったら全量へ落とす', () => {
    const a = item('a');
    const b = item('b');

    const delta = buildItemsDelta([a, b], [b, a]);

    expect(delta).toEqual({ mode: 'full', items: [b, a], total: 2 });
  });

  it('項目が減ったら全量へ落とす（巻き戻し・resume）', () => {
    const a = item('a');
    const b = item('b');

    const delta = buildItemsDelta([a, b], [a]);

    expect(delta).toEqual({ mode: 'full', items: [a], total: 1 });
  });
});

/**
 * `editReplace`（issue #310）はホスト側の復元処理だけが見るもので、webviewは描画に
 * 使わない。表示用の `diff` と違い切り詰めが掛からないため、送信内容から落とす。
 */
describe('buildItemsDelta: editReplaceを送らない（issue #320）', () => {
  const editItem = (id: string): ChatItem => ({
    ...item(id),
    kind: 'fileChange',
    diffs: [
      {
        path: 'src/a.ts',
        kind: 'update',
        movePath: undefined,
        diff: '-古い\n+新しい',
        editReplace: { oldString: '古い', newString: '新しい' },
      },
    ],
  });

  it('全量で送るときも落とす', () => {
    const delta = buildItemsDelta(undefined, [editItem('a')]);

    expect(delta.items[0]?.diffs[0]?.editReplace).toBeUndefined();
  });

  it('差し分で送るときも落とす', () => {
    const a = item('a');

    const delta = buildItemsDelta([a], [a, editItem('b')]);

    expect(delta.mode).toBe('delta');
    expect(delta.items[0]?.diffs[0]?.editReplace).toBeUndefined();
  });

  it('落としても表示用の差分本文とパスは残す', () => {
    const delta = buildItemsDelta(undefined, [editItem('a')]);

    expect(delta.items[0]?.diffs[0]?.diff).toBe('-古い\n+新しい');
    expect(delta.items[0]?.diffs[0]?.path).toBe('src/a.ts');
  });

  it('元の項目は書き換えない（ホスト側は復元にeditReplaceを使い続ける）', () => {
    const original = editItem('a');

    buildItemsDelta(undefined, [original]);

    expect(original.diffs[0]?.editReplace).toEqual({ oldString: '古い', newString: '新しい' });
  });

  it('落とす対象が無ければ同じ参照のまま返す（余計な割り当てをしない）', () => {
    const a = item('a');
    const b = item('b');

    const delta = buildItemsDelta([a], [a, b]);

    expect(delta.items[0]).toBe(b);
  });
});

/**
 * webview側の積み直しは `chatScript` へソースとして埋め込まれ、型検査もlintも効かない。
 * ここで評価して振る舞いだけを確かめる（`webviewScript.test.ts` は構文しか見ない）。
 */
const mergeItems = new Function(`return (${MERGE_ITEMS_SOURCE});`)() as (
  current: ChatItem[],
  payload: { mode: string; items: ChatItem[]; total: number },
) => ChatItem[] | undefined;

describe('mergeItems（webview側。issue #262）', () => {
  it('全量は受け取った並びでそのまま置き換える', () => {
    const items = [item('a'), item('b')];

    expect(mergeItems([item('x')], { mode: 'full', items, total: 2 })).toEqual(items);
  });

  it('差し分は同じidを差し替え、無いものを末尾へ足す', () => {
    const a = item('a');
    const b = item('b', '書きかけ');
    const grown = { ...b, text: '書きかけの続き' };
    const c = item('c');

    const merged = mergeItems([a, b], { mode: 'delta', items: [grown, c], total: 3 });

    expect(merged).toEqual([a, grown, c]);
  });

  it('総数が合わなければ積み直せなかったことを返す', () => {
    const a = item('a');

    // 途中の差し分を取りこぼした状況。呼び出し側は全量の送り直しを頼む
    expect(mergeItems([a], { mode: 'delta', items: [item('c')], total: 5 })).toBeUndefined();
  });

  it('全量を渡した元の配列は書き換えない', () => {
    const source = [item('a')];

    mergeItems([], { mode: 'full', items: source, total: 1 })?.push(item('b'));

    expect(source).toHaveLength(1);
  });
});
