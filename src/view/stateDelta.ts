import type { ChatItem } from '../appserver/chatState';

/**
 * 画面へ送る会話項目の差し分（issue #262）。
 *
 * `flushState` は状態を丸ごと `postMessage` していたが、webviewへの送信は構造化クローンを
 * 通るため、変わったのが末尾の1項目だけでも全項目が直列化される。会話が長くなるほど
 * 1回の送信が重くなり（実測: 4001項目で47.8ms。`STATE_POST_INTERVAL_MS` の50msとほぼ同じ）、
 * issue #246 で直した「拡張ホストのイベントループが埋まって `turn/interrupt` の応答を
 * 読めない」筋へ戻る。
 */
export interface ItemsDelta {
  /**
   * `full` は受け取った並びでそのまま置き換える。`delta` は `items` を id で当てて
   * 差し替え、無いものを末尾へ足す。
   */
  mode: 'full' | 'delta';
  /** 送る項目。`delta` のときは変わった項目と増えた項目だけ。 */
  items: readonly ChatItem[];
  /** 適用後にあるべき項目数。webview側が並びのズレに気付くための照合値。 */
  total: number;
}

/**
 * 前回送った項目と今回の項目を比べ、送る分だけを選ぶ。
 *
 * `ChatState.items` の更新は `upsertItem` による「末尾への追加」と「同じ位置の置き換え」
 * だけで、並びは変わらない（`chatState.ts`）。そのため前回の並びが今回の先頭からの
 * 並びと一致していれば、差し替わった項目と増えた項目だけを送れば足りる。
 *
 * 一致しないとき（巻き戻し・`thread/resume` による総入れ替え）は全量へ落とす。判定を
 * 外すより送り直す方が安い。変わっていない項目の判定は**参照の同一性**で行う。状態は
 * 常に新しいオブジェクトへ作り替えられるため（`upsertItem` は触った項目だけ差し替える）、
 * 中身を比べなくても変化を捉えられる。
 */
export function buildItemsDelta(
  previous: readonly ChatItem[] | undefined,
  next: readonly ChatItem[],
): ItemsDelta {
  const total = next.length;
  if (previous === undefined || previous.length > total) {
    return { mode: 'full', items: next, total };
  }
  const changed: ChatItem[] = [];
  for (let i = 0; i < previous.length; i += 1) {
    const before = previous[i];
    const after = next[i];
    if (before === undefined || after === undefined || before.id !== after.id) {
      return { mode: 'full', items: next, total };
    }
    if (before !== after) {
      changed.push(after);
    }
  }
  for (let i = previous.length; i < total; i += 1) {
    const added = next[i];
    if (added !== undefined) {
      changed.push(added);
    }
  }
  return { mode: 'delta', items: changed, total };
}

/**
 * webviewへ埋め込む積み直しの実装（issue #262）。
 *
 * webview側のスクリプトはテンプレートリテラルの中身で型検査もlintも効かないため、
 * ここにソースとして置いて `chatScript` から差し込む。同じ処理を両側へ書くと片方だけ
 * 直したときに黙ってずれるので、実装はこの1か所に持つ。テストは
 * `test/unit/stateDelta.test.ts` がこの文字列を評価して確かめる。
 *
 * 積み直せなかったとき（総数が合わない = 取りこぼしか並びのずれ）は `undefined` を返す。
 * 呼び出し側は全量の送り直しを頼む。
 */
export const MERGE_ITEMS_SOURCE = `function mergeItems(current, payload) {
    var items = payload.mode === 'full' ? payload.items.slice() : current;
    if (payload.mode !== 'full') {
      for (var i = 0; i < payload.items.length; i += 1) {
        var item = payload.items[i];
        var at = items.findIndex(function (x) { return x.id === item.id; });
        if (at === -1) items.push(item);
        else items[at] = item;
      }
    }
    return items.length === payload.total ? items : undefined;
  }`;
