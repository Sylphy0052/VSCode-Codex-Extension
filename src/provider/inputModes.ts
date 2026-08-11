/**
 * Claude Code画面の入力欄で、行頭の `!` / `#` を特別扱いするための純粋関数。
 *
 * Claude Code TUIには入力の先頭が `!` ならシェルコマンド（bashモード）、`#` なら
 * メモリ（CLAUDE.md）への追記として扱う挙動がある（issue #5, #6、design.md §14.29）。
 * 拡張機能側で総当たりした結果、これに相当する control_request のsubtypeは存在しない
 * （詳細はdesign.md §14.29）。そのため拡張機能側で入力を判定し、拡張機能の機能として
 * 実行する。
 *
 * 判定は `routePseudoCommand`（src/provider/pseudoCommands.ts）と同じ考え方で、
 * 1行だけの入力に限って引き受ける。複数行にまたがる発言（`!`/`#`で始まるだけの
 * 普通の文章、たとえばMarkdown見出しの引用）を誤って乗っ取らないため。
 */

export type InputModeCall =
  | { kind: 'shell'; command: string }
  | { kind: 'memory'; content: string };

/**
 * 送信テキストが `!`/`#` 始まりの特別扱いにあたるか調べる。
 *
 * 行頭（前後の空白を落とした先頭1文字）が `!` ならシェルコマンド、`#` ならメモリ追記。
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
  if (line.startsWith('#')) {
    const content = line.slice(1).trim();
    return content === '' ? undefined : { kind: 'memory', content };
  }
  return undefined;
}

/**
 * 送信前に入力欄の下へ出す案内文。送るとどうなるかを事前に見せる
 * （issue #5/#6の受入基準「実行前/追記前に何が起きるか分かる」）。
 */
export function describeInputMode(call: InputModeCall): string {
  return call.kind === 'shell'
    ? `シェルコマンドとしてターミナルへ入力します: ${call.command}`
    : `メモリへ追記します: ${call.content}`;
}

/**
 * メモリの追記先（プロジェクト側）を解決する。
 *
 * プロジェクトのCLAUDE.mdは `<cwd>/CLAUDE.md` と `<cwd>/.claude/CLAUDE.md` の
 * どちらでも良い（公式ドキュメント「Choose where to put CLAUDE.md files」）。
 * 既にどちらかがあればそれを使い、両方無ければ `<cwd>/CLAUDE.md` を新規に使う
 * （`.claude/CLAUDE.md` を新規に選ぶと `.claude` ディレクトリを作る一手間が増えるため、
 * 既存が無いときはより単純な方を既定にする）。
 */
export function resolveProjectMemoryFile(
  cwd: string,
  rootClaudeMdExists: boolean,
  dotClaudeMdExists: boolean,
): string {
  if (!rootClaudeMdExists && dotClaudeMdExists) {
    return `${cwd}/.claude/CLAUDE.md`;
  }
  return `${cwd}/CLAUDE.md`;
}

/** メモリの追記先（ユーザー側）。`claudeHome` は既定で `~/.claude`（`resolveClaudeHome`）。 */
export function resolveUserMemoryFile(claudeHome: string): string {
  return `${claudeHome}/CLAUDE.md`;
}

/**
 * 追記後のファイル内容を組み立てる。
 *
 * 既存の内容は変更せず、末尾に箇条書きで1行足す（immutable。呼び出し側が
 * そのまま書き込めるよう文字列を返すだけで、ファイルへは触れない）。
 * 既存の内容が改行で終わっていなければ、まず改行を補ってから足す。
 */
export function appendMemoryLine(existingContent: string | undefined, content: string): string {
  const base = existingContent ?? '';
  const withTrailingNewline = base === '' || base.endsWith('\n') ? base : `${base}\n`;
  return `${withTrailingNewline}- ${content}\n`;
}
