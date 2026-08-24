import type { SessionSummary } from '../codex/types';

/**
 * 履歴ビューのタイトルバーの絞り込み（issue #293）。セッション名（`threadName`）と
 * 作業ディレクトリ（`cwd`）に対して大小文字を無視した部分一致で照合する。
 *
 * 表示だけを変えるための関数で、読み込み件数（`codex.history.maxEntries`）には関与しない
 * （`SessionTreeProvider` 側で読み込み済みの一覧に対して掛けるだけ）。
 */
export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  const name = (session.threadName ?? '').toLowerCase();
  const cwd = (session.cwd ?? '').toLowerCase();
  return name.includes(q) || cwd.includes(q);
}

/**
 * 絞り込み中に強調する範囲（issue #738）。`TreeItemLabel.highlights` と同じ
 * `[開始, 終了)` の組を、前から順に重ならないよう列挙する。
 *
 * 照合は `matchesSessionQuery` と同じく前後の空白を落とした語で、大小文字を無視して行う。
 * 語が空のときと一致しないときは空配列を返す（呼び出し側は素の文字列ラベルへ戻せる）。
 *
 * 強調できるのはラベル（スレッド名）だけで、`cwd` やIDにだけ一致した行は強調なしで出る。
 * `TreeItem.description` は `TreeItemLabel` を受け付けないため。
 */
export function sessionNameHighlights(name: string, query: string): [number, number][] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [];
  }
  const haystack = name.toLowerCase();
  // `toLowerCase()` で長さが変わる文字（`İ` → `i̇` など）があると、小文字側で得た位置が
  // 元の文字列とずれる。ずれたまま強調すると無関係な箇所が光るので、その場合は強調しない
  if (haystack.length !== name.length) {
    return [];
  }
  const ranges: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(q, from);
    if (at < 0) {
      break;
    }
    ranges.push([at, at + q.length]);
    from = at + q.length;
  }
  return ranges;
}
