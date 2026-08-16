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
    return { mode: 'full', items: stripHostOnlyItems(next), total };
  }
  const changed: ChatItem[] = [];
  for (let i = 0; i < previous.length; i += 1) {
    const before = previous[i];
    const after = next[i];
    if (before === undefined || after === undefined || before.id !== after.id) {
      return { mode: 'full', items: stripHostOnlyItems(next), total };
    }
    if (before !== after) {
      changed.push(stripHostOnlyFields(after));
    }
  }
  for (let i = previous.length; i < total; i += 1) {
    const added = next[i];
    if (added !== undefined) {
      changed.push(stripHostOnlyFields(added));
    }
  }
  return { mode: 'delta', items: changed, total };
}

/**
 * webviewが描画に使わない項目を落としてから送る（issue #320）。
 *
 * `FileDiff.editReplace`（issue #310でClaude CodeのEditツール由来の復元用に足した
 * `old_string` / `new_string` の生の値）を見るのはホスト側の `diffRestore.ts` だけで、
 * webview側は一切参照しない。表示用の `diff` テキストが `MAX_DIFF_LINES` で切り詰め
 * られているのに対しこちらは切り詰めていないため、そのまま送ると描画に使わないデータが
 * 上限を素通りして直列化に載る。この経路の重さは issue #246・#262 で二度手当てしている
 * ので、載せる必要が無いものは載せない。
 *
 * ホスト側は差分の実体をwebviewから受け取らず、`itemId` と差分の添字からセッションの
 * 状態を引き直す（`chatView.ts`）。落としても「差分を開く」「この変更を戻す」は動く。
 *
 * 落とす対象を持たない項目は**同じ参照のまま返す**。全項目を作り直すと、送信を軽くする
 * ために足したこの処理自体が割り当てを増やしてしまうため。なお `flushState` が次回の
 * 比較に使う `sentItems` は元の項目を指したままなので、参照の同一性で変化を捉える
 * {@link buildItemsDelta} の判定はここでの作り替えに影響されない。
 */
function stripHostOnlyFields(item: ChatItem): ChatItem {
  if (!item.diffs.some((diff) => diff.editReplace !== undefined)) {
    return item;
  }
  return {
    ...item,
    diffs: item.diffs.map((diff) =>
      diff.editReplace === undefined ? diff : { ...diff, editReplace: undefined },
    ),
  };
}

/** {@link stripHostOnlyFields} を並び全体へ掛ける。落とす対象が無ければ元の配列を返す。 */
export function stripHostOnlyItems(items: readonly ChatItem[]): readonly ChatItem[] {
  return items.some((item) => item.diffs.some((diff) => diff.editReplace !== undefined))
    ? items.map(stripHostOnlyFields)
    : items;
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
