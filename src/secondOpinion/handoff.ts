/**
 * メインAIへの指示の下書き（Issue #929 Handoff）の解釈。
 *
 * Advisorの応答から `userSummary`（利用者向けの要約）と `mainInstruction`（作業中のAIへ渡す
 * 指示文）を取り出す。**読めない応答は下書きとして扱わない**——形を推測で補って通すと、
 * 利用者向けの説明が指示文の側へ入り込んだまま承認へ進む経路ができる。指示文は承認されれば
 * より強い権限を持つ相手へ渡るため、ここは緩めず、読めなければ作り直させる。
 *
 * 送信そのものはここでは行わない。この場所は文字列を構造へ変えるだけで、`vscode` にも
 * セッションにも触らない（純関数のまま単体テストで固められるようにする）。
 */

/** 承認前の下書き。両方とも空でないことが保証される。 */
export interface HandoffDraft {
  /**
   * この下書きの世代（`AdvisorSession.markHandoffDrafted()` が返す値）。
   *
   * 承認のときに相談相手の現在の世代と一致させる。承認の画面を開いたまま新しい下書きを
   * 作った場合に、古い方が送られるのを防ぐ（Issue #929 の自己レビュー）。
   */
  revision: number;
  /**
   * この下書きの根拠になった材料の世代（Issue #975）。
   *
   * 承認のときに相談相手の現在の世代と比べる。相談の途中で材料を更新すると、更新前の
   * 議論から作った下書きは古い前提に立ったものになる。送るのを止めはしないが、**古い
   * ことを知らないまま送らせない**ために持ち回る。
   */
  materialRevision: number;
  /** 利用者が採否を判断するための要約。会話へ表示するだけで、送信されることはない。 */
  userSummary: string;
  /** 承認されたときにだけ作業中のAIへ渡る指示文。 */
  mainInstruction: string;
}

/** パースの結果。世代はまだ付いていない（相談相手が採番する）。 */
export type ParsedHandoff = Omit<HandoffDraft, 'revision' | 'materialRevision'>;

export type HandoffParseResult = { ok: true; draft: ParsedHandoff } | { ok: false; reason: string };

/**
 * 指示文の上限（文字数）。
 *
 * 送信の可否ではなく、**下書きとして読めるか**の判断に使う。これを超える応答は、指示ではなく
 * 相談の続きを書いてしまっている（あるいは資料を丸ごと引き写している）と見なして作り直させる。
 * 作業中のAIへ渡る文が長いほど、利用者が全文を読まずに承認する率は上がる。
 */
const MAX_INSTRUCTION_CHARS = 8_000;

/** 要約の上限（文字数）。利用者が読み切れる長さに寄せる。 */
const MAX_SUMMARY_CHARS = 8_000;

/**
 * 応答から下書きを取り出す。
 *
 * 探すのは ```json のコードブロック1つだけである。地の文からJSONらしき部分を拾いにいかない
 * のは、Advisorが本文中でJSONの例を挙げたときに、それを下書きとして拾ってしまうためである。
 * 「1つだけ」を要求するのも同じ理由で、複数あるとどれが結論なのかを機械が決められない。
 */
export function parseHandoffDraft(raw: string): HandoffParseResult {
  const blocks = extractJsonBlocks(raw);
  if (blocks.length === 0) {
    return { ok: false, reason: 'JSONのコードブロックが見つかりませんでした' };
  }
  if (blocks.length > 1) {
    return {
      ok: false,
      reason: `JSONのコードブロックが${blocks.length}個ありました（1個だけにしてください）`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0] ?? '');
  } catch (e) {
    return { ok: false, reason: `JSONとして読めませんでした: ${messageOf(e)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'JSONの中身がオブジェクトではありませんでした' };
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== 'userSummary' && key !== 'mainInstruction',
  );
  if (unknownKeys.length > 0) {
    // 指示した2つ以外のキーがあるということは、形式を守れていない。読み替えて通さない
    return { ok: false, reason: `想定していないキーがありました: ${unknownKeys.join(', ')}` };
  }
  const summary = requireText(record['userSummary'], 'userSummary', MAX_SUMMARY_CHARS);
  if (typeof summary !== 'string') {
    return summary;
  }
  const instruction = requireText(
    record['mainInstruction'],
    'mainInstruction',
    MAX_INSTRUCTION_CHARS,
  );
  if (typeof instruction !== 'string') {
    return instruction;
  }
  return { ok: true, draft: { userSummary: summary, mainInstruction: instruction } };
}

/**
 * 値が「空でない文字列」であることを確かめ、そうでなければ失敗の理由を返す。
 *
 * 戻り値の型を `string | 失敗` にしているのは、呼び出し側で2つのキーを同じ流れで扱うため。
 * 例外にしないのは、これが利用者へ見せる「作り直しの理由」であって異常事態ではないため。
 */
function requireText(
  value: unknown,
  key: string,
  maxChars: number,
): string | { ok: false; reason: string } {
  if (typeof value !== 'string') {
    return { ok: false, reason: `${key} が文字列ではありませんでした` };
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: false, reason: `${key} が空でした` };
  }
  if (trimmed.length > maxChars) {
    return {
      ok: false,
      reason: `${key} が長すぎます（${trimmed.length}文字。上限は${maxChars}文字）`,
    };
  }
  return trimmed;
}

/**
 * ```json のコードブロックの中身をすべて取り出す。
 *
 * 開きフェンスは3個以上のバッククォートを許す（`fence()` は中身に応じてフェンスを伸ばす）。
 * 閉じフェンスは開いたものと同じ長さ以上を要求する——CommonMarkの規則であり、中身にバッククォート
 * の並びが含まれていても途中で切れないようにするための取り決めでもある。
 */
function extractJsonBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const opening = /^[ \t]*(`{3,})[ \t]*json[ \t]*$/gim;
  for (;;) {
    const match = opening.exec(raw);
    if (match === null) {
      break;
    }
    const marker = match[1] ?? '```';
    const bodyStart = match.index + match[0].length;
    const closing = new RegExp(`^[ \\t]*\`{${marker.length},}[ \\t]*$`, 'm');
    const rest = raw.slice(bodyStart);
    const end = closing.exec(rest);
    if (end === null) {
      // 閉じていないブロックは読めない。中身を推測で切り出さない
      break;
    }
    blocks.push(rest.slice(0, end.index));
    opening.lastIndex = bodyStart + end.index + end[0].length;
  }
  return blocks;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
