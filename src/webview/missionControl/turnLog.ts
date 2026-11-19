import type { McTurn } from './protocol';

/**
 * 詳細ペインの会話ログ（Issue #2157）。
 *
 * 拡張ホストからは範囲指定（`before`と件数）で何回かに分けて届くので、届いた範囲を位置で
 * 継ぎ足して1本の列にする。検索の一致もここで数える。DOMの型もPreactも使わない（単体テスト
 * から直接呼ぶ）。
 */

/** 読み込み済みの会話。 */
export interface TurnLog {
  turns: McTurn[];
  /** `turns[0]`が会話の何件目か（0始まり）。相手が古い版で範囲が分からなければ`undefined`。 */
  start: number | undefined;
  /** 会話全体の件数。`start`と同じく、分からなければ`undefined`。 */
  total: number | undefined;
  /** 古いやり取りを取り寄せている途中か。 */
  olderLoading: boolean;
  /** 古いやり取りを取り寄せられなかった理由。 */
  olderError?: string | undefined;
}

/** 1回の取り寄せで届いた範囲。 */
export interface TurnPage {
  turns: McTurn[];
  start?: number | undefined;
  total?: number | undefined;
}

/** 1回に取り寄せる件数。拡張ホストの上限（`MAX_RECENT_TURNS`）に合わせる。 */
export const TURN_PAGE_SIZE = 50;

function hasRange(page: TurnPage): page is TurnPage & { start: number; total: number } {
  return (
    page.start !== undefined &&
    page.total !== undefined &&
    page.start >= 0 &&
    page.start + page.turns.length <= page.total
  );
}

/** 届いた範囲だけで新しいログを作る。 */
export function logFromPage(page: TurnPage): TurnLog {
  const ranged = hasRange(page);
  return {
    turns: page.turns,
    start: ranged ? page.start : undefined,
    total: ranged ? page.total : undefined,
    olderLoading: false,
  };
}

/**
 * 届いた範囲を、読み込み済みのログへ位置で継ぎ足す。
 *
 * - 届いた範囲の中は、届いた内容で置き換える（ストリーム中の応答が伸びる）
 * - 末尾まで届いた（ライブtail）なら、それより後ろの古い内容は捨てる
 * - 範囲が離れている・どちらかの範囲が分からないときは、届いた範囲だけにする
 *   （ずれた位置で継ぎ足して会話の順序を壊さない）
 */
export function mergeTurnPage(prev: TurnLog | undefined, page: TurnPage): TurnLog {
  if (prev === undefined || prev.start === undefined || !hasRange(page)) {
    return logFromPage(page);
  }
  const pageEnd = page.start + page.turns.length;
  const prevEnd = prev.start + prev.turns.length;
  if (page.start > prevEnd || pageEnd < prev.start) {
    return { ...logFromPage(page), olderLoading: prev.olderLoading };
  }
  const isTail = pageEnd === page.total;
  const head = prev.start < page.start ? prev.turns.slice(0, page.start - prev.start) : [];
  const rest = !isTail && prevEnd > pageEnd ? prev.turns.slice(pageEnd - prev.start) : [];
  return {
    turns: [...head, ...page.turns, ...rest],
    start: Math.min(prev.start, page.start),
    total: page.total,
    olderLoading: prev.olderLoading,
    olderError: prev.olderError,
  };
}

/** まだ遡れる古いやり取りがあるか。 */
export function hasOlderTurns(log: TurnLog): boolean {
  return log.start !== undefined && log.start > 0;
}

/** 検索の一致1件。`turn`は`turns`の添字、`from` / `to`は`field`の文字位置。 */
export interface TurnMatch {
  turn: number;
  field: 'title' | 'text';
  from: number;
  to: number;
}

/** 一致を数える上限。これを超える分は数えない（画面の印付けが重くなる）。 */
export const MAX_TURN_MATCHES = 2_000;

function matchesIn(
  haystack: string,
  needle: string,
  turn: number,
  field: TurnMatch['field'],
  out: TurnMatch[],
): void {
  const lower = haystack.toLowerCase();
  let at = lower.indexOf(needle);
  while (at !== -1 && out.length < MAX_TURN_MATCHES) {
    out.push({ turn, field, from: at, to: at + needle.length });
    at = lower.indexOf(needle, at + needle.length);
  }
}

/**
 * 会話の中から`query`を探す（大文字・小文字を区別しない）。順序は会話の順で、1件の中では
 * 見出し → 本文の順。空白だけの`query`は何も探さない。
 */
export function findTurnMatches(turns: readonly McTurn[], query: string): TurnMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [];
  }
  const out: TurnMatch[] = [];
  for (let i = 0; i < turns.length && out.length < MAX_TURN_MATCHES; i += 1) {
    const turn = turns[i] as McTurn;
    if (turn.title !== undefined) {
      matchesIn(turn.title, needle, i, 'title', out);
    }
    matchesIn(turn.text, needle, i, 'text', out);
  }
  return out;
}

/** 文字列を一致の印付きの断片に分けたもの。`match`は一致の通し番号。 */
export interface TextSegment {
  text: string;
  match?: number | undefined;
}

/** 一致と、`findTurnMatches`の結果の中での通し番号。 */
export interface IndexedMatch {
  match: TurnMatch;
  index: number;
}

/** 一致を`turns`の添字ごとにまとめる（1件ずつ全一致を見直さずに済むように）。 */
export function groupMatchesByTurn(
  matches: readonly TurnMatch[],
): ReadonlyMap<number, IndexedMatch[]> {
  const byTurn = new Map<number, IndexedMatch[]>();
  matches.forEach((match, index) => {
    const list = byTurn.get(match.turn);
    if (list === undefined) {
      byTurn.set(match.turn, [{ match, index }]);
    } else {
      list.push({ match, index });
    }
  });
  return byTurn;
}

/**
 * 1つの欄（見出しか本文）を、一致とそれ以外の断片に分ける。`matches`はその1件分の一致
 * （`groupMatchesByTurn`の値）。
 */
export function segmentField(
  text: string,
  matches: readonly IndexedMatch[],
  field: TurnMatch['field'],
): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const { match: m, index } of matches) {
    if (m.field !== field || m.from < cursor || m.to > text.length) {
      continue;
    }
    if (m.from > cursor) {
      segments.push({ text: text.slice(cursor, m.from) });
    }
    segments.push({ text: text.slice(m.from, m.to), match: index });
    cursor = m.to;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}

/** 一致の移動。端で反対側へ回る。一致が無ければ`undefined`。 */
export function stepMatch(
  current: number | undefined,
  count: number,
  delta: 1 | -1,
): number | undefined {
  if (count === 0) {
    return undefined;
  }
  if (current === undefined) {
    return delta === 1 ? 0 : count - 1;
  }
  return (current + delta + count) % count;
}
