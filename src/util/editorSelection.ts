/**
 * エディタの選択範囲をチャット入力欄へ送るための純粋関数群（issue #292）。
 *
 * `vscode` に依存しないロジックだけをここへ切り出す（`diffRestore.ts` / `diffWorkspacePath.ts`
 * と同じ方針）。実際の `vscode.window.activeTextEditor` からの読み取り・ワークスペース相対パスの
 * 解決・パネルへの挿入は `src/extension.ts` 側（vscodeへ依存してよい層）が担う。
 */

/** 選択範囲として送ってよい本文の上限バイト数（UTF-8換算）。 */
export const MAX_SELECTION_BYTES = 1 * 1024 * 1024;

/** 1始まり・両端を含む行範囲。 */
export interface SelectionLineRange {
  startLine: number;
  endLine: number;
}

/**
 * `vscode.Selection` の0始まり座標から、表示用の1始まり行範囲を求める。
 *
 * 行末から次の行の先頭（`endCharacter === 0`）までドラッグして選択を終えると、
 * `endLine` は実際には選択していない次の行を指す（VSCode標準の選択範囲の性質）。
 * その場合は1つ前の行を最終行として扱う（実際に選んだ文字を含む行だけを行範囲に含める）。
 */
export function computeSelectionLineRange(
  startLine: number,
  endLine: number,
  endCharacter: number,
): SelectionLineRange {
  const trailingEmptyLine = endCharacter === 0 && endLine > startLine;
  const lastLine = trailingEmptyLine ? endLine - 1 : endLine;
  return { startLine: startLine + 1, endLine: lastLine + 1 };
}

/** チャット入力欄へ挿し込む見出し行（`パス:開始行-終了行`）。 */
export function formatSelectionHeader(displayPath: string, range: SelectionLineRange): string {
  return `${displayPath}:${range.startLine}-${range.endLine}`;
}

/** 見出し行＋選択本文。入力欄へはこれをそのまま挿し込む。 */
export function buildSelectionPayload(
  displayPath: string,
  range: SelectionLineRange,
  text: string,
): string {
  return `${formatSelectionHeader(displayPath, range)}\n${text}`;
}

/** 選択本文がUTF-8換算で上限を超えているか。 */
export function selectionTextExceedsLimit(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > MAX_SELECTION_BYTES;
}
