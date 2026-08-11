/**
 * ログ・理由文字列へ埋め込む前に、外部プロセス（git・CLI）由来のテキストを無害化する
 * 共通ヘルパー（design.md §16.7の `sanitizeForReason` と同じ考え方。レビュー指摘: warning）。
 *
 * `worktree.ts`（gitのstderr）と `runner.ts`（CLI起動失敗などの例外メッセージ）の両方が
 * このモジュールを通す。現状のサブコマンドは資格情報を含む出力を返さないが、将来
 * `fetch` / `push` 等を足したときに同じ経路で漏れるのを防ぐため、今のうちに共通化する。
 */

/** 理由・ログに埋め込む値の既定の上限長。長大な値で表示・ログが崩れるのを防ぐ。 */
export const SANITIZE_MAX_LEN = 200;

/**
 * `scheme://user:pass@host` の `user:pass@` 部分（userinfo）を `***@` に置き換える。
 * gitのリモートURLやエラーメッセージにHTTPS用のトークン付きURLがそのまま出ることがある
 * （例: `remote: Invalid username or password. fatal: Authentication failed for
 * 'https://token@github.com/...'`）。
 */
const URL_USERINFO_PATTERN = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/gu;

function maskUrlUserinfo(value: string): string {
  return value.replace(URL_USERINFO_PATTERN, '$1***@');
}

/**
 * 双方向制御文字（RTL override等）と、幅を持たない不可視文字。`textContent` で挿入する限り
 * XSSにはならないが（design.md §16.8のワークフローViewの前提）、表示上の文字の並びを
 * 反転・偽装したり、目視比較をすり抜けたりできてしまう。ワークフローViewの「承認」操作は
 * 会話タブを開かずその場で許可・拒否を決められる設計（design.md §16.8）で、通常の
 * チャット画面より文脈が少なく見た目の偽装が誤判断に直結しやすいため、制御文字と
 * 同列に落とす（レビュー指摘: medium 3 / low）。
 *
 * - `U+200E` `U+200F`: LRM / RLM（双方向）
 * - `U+061C`: Arabic Letter Mark（双方向）
 * - `U+202A`-`U+202E`: LRE / RLE / PDF / LRO / RLO（双方向）
 * - `U+2066`-`U+2069`: LRI / RLI / FSI / PDI（双方向）
 * - `U+200B`: ゼロ幅スペース
 * - `U+2060`: word joiner
 * - `U+FEFF`: BOM / ゼロ幅no-breakスペース
 */
const INVISIBLE_CHAR_PATTERN = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/gu;

/**
 * C0制御文字・DEL・双方向制御文字を取り除く。改行やタブは空白に畳み、それ以外の
 * 制御文字（双方向制御含む）は跡を残さず削除する。`sanitizeForLog` の下請けだが、
 * 単独でも使う（`runner.ts` の承認要求表示、`taskSummary.ts` の応答要約。
 * レビュー指摘: medium 3 / low）。
 */
export function stripControlChars(value: string): string {
  let normalized = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    normalized += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return normalized.replace(INVISIBLE_CHAR_PATTERN, '');
}

/**
 * `stripControlChars` と同じく双方向制御文字・不可視文字（Trojan Source対策）を落とすが、
 * 改行（`\n` `\r`）とタブ（`\t`）は残す。
 *
 * `stripControlChars` は改行も含めた全てのC0制御文字を空白へ畳むため、1行の表示
 * （承認カードのタイトル、応答の1行要約）には適するが、複数行のテキストへ使うと
 * 改行が空白に潰れて読めなくなる。ワークフローViewの「展開後のプロンプトを見る」
 * （design.md §16.4 案1、Issue #67）は複数行のプロンプトをそのまま人が目視で確認する
 * 機能なので、双方向制御文字だけを落として整形は保つ必要がある（セキュリティ監査
 * 指摘#5。双方向制御文字を仕込まれると、この目視確認そのものを欺けるため、
 * `INVISIBLE_CHAR_PATTERN` の除去自体は省略できない）。
 */
export function stripControlCharsPreservingNewlines(value: string): string {
  let normalized = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isPreservedWhitespace = code === 0x0a || code === 0x0d || code === 0x09;
    normalized += !isPreservedWhitespace && (code < 0x20 || code === 0x7f) ? ' ' : ch;
  }
  return normalized.replace(INVISIBLE_CHAR_PATTERN, '');
}

/**
 * 制御文字・改行を空白に畳み、URL中のuserinfoをマスクし、長すぎる値を切り詰める。
 * HTMLエスケープはView側の責務（design.md §16.8）であり、ここでは行わない。
 */
export function sanitizeForLog(value: string, maxLen: number = SANITIZE_MAX_LEN): string {
  const normalized = stripControlChars(value);
  const masked = maskUrlUserinfo(normalized);
  const collapsed = masked.replace(/ {2,}/gu, ' ').trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}
