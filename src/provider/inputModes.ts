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

import { basename, dirname } from 'node:path';
import type { SymlinkResolution } from '../session/ports';
import type { MementoLike } from '../util/memento';

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

/**
 * メモリ追記先の候補1件（issue #144）。QuickPickの1項目に対応する。
 *
 * `exists` はラベルへ「既存」/「新規作成」として出す（受入基準「各候補が既存か新規作成かが
 * ラベルで分かる」）。実在確認そのもの（I/O）は呼び出し側の責務で、ここには含めない
 * （このファイルは純粋関数のみを置く方針のため）。
 */
export interface MemoryCandidate {
  /** QuickPickのlabel。プロジェクト側は `プロジェクト（<フォルダ名>）`、ユーザー側は `ユーザー`。 */
  label: string;
  /** 追記先の絶対パス。書き込みは必ずこの値（列挙した候補）に限り、ノート本文からは組み立てない。 */
  path: string;
  exists: boolean;
}

/** `buildProjectMemoryCandidates` の入力1件。workspaceFolder1つ分に対応する。 */
export interface ProjectMemoryFolderInput {
  /** QuickPickのラベルに出すフォルダ名。 */
  name: string;
  cwd: string;
  rootClaudeMdExists: boolean;
  dotClaudeMdExists: boolean;
}

/**
 * プロジェクト側のメモリ追記候補を、workspaceFolderごとに組み立てる（issue #144）。
 *
 * マルチルートワークスペースで「どのフォルダのCLAUDE.mdか」が候補から分からない問題への
 * 対処（受入基準）。各フォルダの追記先自体は既存の `resolveProjectMemoryFile` を使い回す。
 *
 * フォルダ名が複数の候補で重複する場合（親ディレクトリが異なる同名フォルダ、例:
 * `/a/project` と `/b/project`）は、ラベルだけでは区別が付かない。書き込み先自体は
 * `path`（詳細に出す）で常に一意だが、QuickPickのラベルで見分けが付くよう、
 * 重複しているときだけ親ディレクトリ名を添える。
 */
export function buildProjectMemoryCandidates(
  folders: readonly ProjectMemoryFolderInput[],
): MemoryCandidate[] {
  const nameCounts = new Map<string, number>();
  for (const f of folders) {
    nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);
  }
  return folders.map((f) => {
    const isDuplicateName = (nameCounts.get(f.name) ?? 0) > 1;
    const label = isDuplicateName
      ? `プロジェクト（${basename(dirname(f.cwd))}/${f.name}）`
      : `プロジェクト（${f.name}）`;
    return {
      label,
      path: resolveProjectMemoryFile(f.cwd, f.rootClaudeMdExists, f.dotClaudeMdExists),
      exists: f.rootClaudeMdExists || f.dotClaudeMdExists,
    };
  });
}

/**
 * 直前に選んだ追記先（`lastSelectedPath`）があれば、それをQuickPickの先頭へ動かす
 * （issue #144の受入基準「直前に選んだ追記先が次回の候補の先頭に来る」）。
 *
 * `path` が一致する候補が無い（前回選択が今回の候補に無い。例: ワークスペースを
 * 切り替えた）場合は、元の並び順のまま返す。immutable（引数の配列・要素は変更しない）。
 */
export function orderMemoryCandidates<T extends { path: string }>(
  candidates: readonly T[],
  lastSelectedPath: string | undefined,
): T[] {
  if (lastSelectedPath === undefined) {
    return [...candidates];
  }
  const index = candidates.findIndex((c) => c.path === lastSelectedPath);
  const picked = index > 0 ? candidates[index] : undefined;
  if (picked === undefined) {
    // 見つからない、または既に先頭
    return [...candidates];
  }
  return [picked, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

/** `vscode.Memento` と構造的に一致する最小限の口（実体は `src/util/memento.ts`）。 */
export type MemoryModeMemento = MementoLike;

/** 直前に選んだメモリ追記先のパスを覚えておく `workspaceState` のキー（issue #144）。 */
export const MEMORY_LAST_SELECTED_PATH_KEY = 'claude.memoryMode.lastSelectedPath';

/** シンボリックリンクだが実体パスを特定できないときに、確認・記録の両方へ出す警告文。 */
const UNRESOLVED_SYMLINK_WARNING =
  'シンボリックリンクですが、実体のパスを特定できません（壊れたリンク・循環参照・権限不足の可能性があります）。書き込みは実際のリンク先へ届きます。';

/**
 * メモリ追記の確認ダイアログの本文を組み立てる（issue #144）。
 *
 * `symlink` の判別結果に応じて本文を足す。追記先（`path`）がシンボリックリンクの場合、
 * `vscode.workspace.fs.writeFile` はリンクを追従して実体へ書くため、リンク自身のパスしか
 * 見せないと実際にどのファイルが書き換わるのか分からない（issue #144の受入基準）。
 * 実体パスが解決できなかった場合（壊れたリンク・循環参照・権限不足）も、それを隠さず
 * 警告として出す（CRITICAL指摘。「分からない」ことを見せるのが修正の本質で、書き込み自体は
 * 中止しない。dotfiles管理での正当な使い方のため）。
 */
export function buildMemoryAppendConfirmation(
  content: string,
  path: string,
  symlink: SymlinkResolution,
): string {
  const linkLine =
    symlink.kind === 'resolved'
      ? `\nリンク先: ${symlink.target}`
      : symlink.kind === 'unresolved'
        ? `\n警告: ${UNRESOLVED_SYMLINK_WARNING}`
        : '';
  return `次の内容を追記します:\n\n${content}\n\n追記先: ${path}${linkLine}`;
}

/**
 * 追記後に会話へ残す1行を組み立てる（issue #144）。
 *
 * 確認ダイアログと同じ理由で、シンボリックリンクのときは実体パスも、実体パスが特定できない
 * ときは警告も分かる形にする（受入基準「会話に残る記録にも実体パスが分かる形で残る」）。
 */
export function describeMemoryAppendResult(path: string, symlink: SymlinkResolution): string {
  if (symlink.kind === 'resolved') {
    return `メモリへ追記しました: ${path}（リンク先: ${symlink.target}）`;
  }
  if (symlink.kind === 'unresolved') {
    return `メモリへ追記しました: ${path}（警告: ${UNRESOLVED_SYMLINK_WARNING}）`;
  }
  return `メモリへ追記しました: ${path}`;
}

/**
 * 2つの `SymlinkResolution` が同じ状態を表すか比較する（issue #144のTOCTOU対策）。
 *
 * 確認ダイアログを出した時点の解決結果と、書き込み直前に取り直した解決結果を比べ、
 * 食い違っていれば書き込みを中止する（`ClaudeChatViewManager.runMemoryInputMode`）。
 */
export function symlinkResolutionEquals(a: SymlinkResolution, b: SymlinkResolution): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'resolved' && b.kind === 'resolved') {
    return a.target === b.target;
  }
  return true;
}
