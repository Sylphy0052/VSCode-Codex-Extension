/**
 * Claude Code画面の入力欄で、行頭の `!` を特別扱いするための純粋関数。
 *
 * Claude Code TUIには入力の先頭が `!` ならシェルコマンド（bashモード）として扱う挙動がある
 * （issue #5、design.md §14.29）。これに相当する control_request のsubtypeは存在しない
 * （詳細はdesign.md §14.29）。そのため拡張機能側で入力を判定し、拡張機能の機能として
 * 実行する。行頭 `#` のメモリモードはissue #2007で削除した（CLI本体も廃止済み）。
 *
 * 判定は `routePseudoCommand`（src/provider/pseudoCommands.ts）と同じ考え方で、
 * 1行だけの入力に限って引き受ける。複数行にまたがる発言を誤って乗っ取らないため。
 */

export type InputModeCall = { kind: 'shell'; command: string };

/**
 * 送信テキストが `!` 始まりの特別扱いにあたるか調べる。
 *
 * 行頭（前後の空白を落とした先頭1文字）が `!` ならシェルコマンド。
 * それ以外（該当しない・複数行・記号の後が空）は `undefined` を返し、普通の発言として
 * 扱わせる。
 */
export function routeInputMode(text: string): InputModeCall | undefined {
  const line = text.trim();
  if (line === '' || line.includes('\n')) {
    return undefined;
  }
  if (line.startsWith('!')) {
    const command = line.slice(1).trim();
    return command === '' ? undefined : { kind: 'shell', command };
  }
  return undefined;
}

/**
 * 送信前に入力欄の下へ出す案内文。送るとどうなるかを事前に見せる
 * （issue #5の受入基準「実行前に何が起きるか分かる」）。
 */
export function describeInputMode(call: InputModeCall): string {
  return `シェルコマンドとしてターミナルへ入力します: ${call.command}`;
}
