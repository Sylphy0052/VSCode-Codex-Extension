/**
 * 入力欄の判定（design.md §14.25、Issue #5・#6）。
 *
 * Claude Code TUIのbashモード（`!`）・メモリモード（`#`）相当。Phase 0の実測で、
 * どちらもCLIのcontrol protocolに経路が無いと確定している（`local_command` subtypeは
 * `Unsupported control request subtype` で拒否される。`/memory` コマンドはエディタで
 * ファイルを開くだけでメモリ追記ではない）。したがって拡張機能側だけで完結させる。
 *
 * 判定は**入力欄の先頭文字だけ**を見る（trimしない。`raw` の1文字目が `!` / `#` かどうか）。
 * 複数行入力でもその全体を1つのコマンド／ノート本文として扱う。
 */
export type ClaudeInputMode =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'shellCommand'; readonly command: string }
  | { readonly kind: 'memoryNote'; readonly note: string }
  /** `!` / `#` の後ろが空白のみ。CLIへは送らず、会話にも何も残さない。 */
  | { readonly kind: 'empty' };

/**
 * 入力欄の文字列を分類する（純粋関数）。
 *
 * - `!` 始まり: シェルコマンド。`!` を除いた残り全体がコマンド（trimしない）
 * - `#` 始まり: メモリ追記。`#` を除いた残り全体がノート本文（前後の空白はtrim）
 * - `\!` / `\#` 始まり: エスケープ。先頭のバックスラッシュ1つだけを取り除き、
 *   通常のメッセージとして送る（`\# 見出し` → `# 見出し` をCLIへ送る）
 * - `!` / `#` の後ろが空白のみ: `empty`。呼び出し側はCLIへ送らず、会話にも項目を足さない
 * - それ以外は通常のメッセージ
 */
export function classifyClaudeInput(raw: string): ClaudeInputMode {
  if (raw.startsWith('\\!') || raw.startsWith('\\#')) {
    return { kind: 'message', text: raw.slice(1) };
  }
  if (raw.startsWith('!')) {
    const command = raw.slice(1);
    return command.trim() === '' ? { kind: 'empty' } : { kind: 'shellCommand', command };
  }
  if (raw.startsWith('#')) {
    const note = raw.slice(1).trim();
    return note === '' ? { kind: 'empty' } : { kind: 'memoryNote', note };
  }
  return { kind: 'message', text: raw };
}
