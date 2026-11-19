import type { McSlashCommand } from './protocol';

/**
 * 指示欄（Composer）の補完の判定（Issue #2158）。DOMもPreactも使わない（単体テストから直接呼ぶ）。
 */

/** いま補完している語。`start`〜`end`が置き換える範囲（`@`・`/`を含む）。 */
export interface McCompletionToken {
  kind: 'file' | 'command';
  start: number;
  end: number;
  /** `@`・`/`の後ろの文字列。 */
  query: string;
}

/** スラッシュコマンドの候補を出す上限。 */
export const COMMAND_CANDIDATE_LIMIT = 50;

/**
 * カーソルの直前の語が補完の対象かを決める。
 *
 * - `/`は本文の先頭だけ（チャットタブと同じく、スラッシュコマンドは行頭でしか効かない）
 * - `@`は先頭か空白の直後に打ったもの（メールアドレスの`@`で候補を出さない）
 */
export function completionTokenAt(text: string, caret: number): McCompletionToken | undefined {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/u.exec(before);
  if (command !== null) {
    return { kind: 'command', start: 0, end: caret, query: command[1] ?? '' };
  }
  const file = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (file !== null) {
    const query = file[1] ?? '';
    return { kind: 'file', start: caret - query.length - 1, end: caret, query };
  }
  return undefined;
}

/**
 * 選んだ候補で語を置き換える。カーソルの後ろに続く語の残り（空白まで）も置き換え、
 * 候補の後ろに空白を1つ入れる。返す`caret`は差し込んだ空白の直後。
 */
export function applyCompletion(
  text: string,
  token: McCompletionToken,
  value: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, token.start)}${token.kind === 'command' ? '/' : '@'}${value} `;
  const tail = text.slice(token.end).replace(/^\S*/u, '').replace(/^ /u, '');
  return { text: `${head}${tail}`, caret: head.length };
}

/** スラッシュコマンドを絞り込む。名前の前方一致を先に、名前・説明の部分一致を後に並べる。 */
export function filterCommands(
  commands: readonly McSlashCommand[],
  query: string,
  limit: number = COMMAND_CANDIDATE_LIMIT,
): McSlashCommand[] {
  const needle = query.toLowerCase();
  if (needle === '') {
    return commands.slice(0, limit);
  }
  const prefix: McSlashCommand[] = [];
  const partial: McSlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefix.push(command);
    } else if (name.includes(needle) || command.description.toLowerCase().includes(needle)) {
      partial.push(command);
    }
  }
  return [...prefix, ...partial].slice(0, limit);
}

/** 候補の選択位置を動かす（端で反対側へ回る）。候補が無ければ0。 */
export function stepIndex(index: number, count: number, delta: 1 | -1): number {
  if (count === 0) {
    return 0;
  }
  return (index + delta + count) % count;
}

/** 添付で選んだ画像以外のファイルのパスを`@パス`の形にする。空白を含むパスは引用符で囲む。 */
export function mentionOf(filePath: string): string {
  return /\s/u.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
}
