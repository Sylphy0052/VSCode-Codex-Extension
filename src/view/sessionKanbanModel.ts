import { isWithinAnyRoot, normalizeWorkspacePath } from '../util/paths';
import type { SessionActivityState } from './sessionActivity';

/**
 * カンバンの列。`SessionActivityState`（`sessionActivity.ts`）そのものを列にする（Issue #1012）。
 *
 * 別名で定義し直すと、状態が増えたときに列の定義だけが取り残されて実行時に
 * `cards[column]`が`undefined`になる。同じ型を使い、下の`cards`のRecordリテラルで
 * 全列を書かせることで、状態の追加をコンパイル時に検出する。
 */
export type SessionKanbanColumn = SessionActivityState;

export interface ManagedSessionInput {
  threadId: string;
  title: string;
  cwd: string | undefined;
  provider: 'codex' | 'claude';
  activity: SessionActivityState;
  /** どのVS Codeウィンドウのセッションか（Issue #1244）。ウィンドウ起動時に生成するid。 */
  windowId: string;
  /**
   * ループの走行状態（Issue #1258）。一時停止と再開のボタンを出し分けるのに使う。
   *
   * 古い版のウィンドウが書いた共有ファイルには無いため任意。無ければ走っていないものとして扱う。
   */
  loop?: { running: boolean; paused: boolean } | undefined;
}

/**
 * 画面へ送るカード1枚。
 *
 * 作業ディレクトリは**末尾の要素だけ**を`cwdLabel`として持ち、既定では絶対パスを
 * 出さない（Issue #1039）。画面共有やスクリーンショットで、ユーザー名・ホームディレクトリ名・
 * 顧客名を含むディレクトリ名が意図せず映るため。絶対パスは`cwdFull`にhover専用として持つ
 * （Issue #1244の受入基準: hoverでだけ絶対パスを読める）。
 */
export interface SessionKanbanCard extends Omit<ManagedSessionInput, 'cwd'> {
  column: SessionKanbanColumn;
  cwdLabel: string;
  cwdFull: string;
  /** このカードが今の統括ページを開いているウィンドウ自身のものか（Issue #1244）。 */
  isCurrentWindow: boolean;
}

export interface SessionKanbanBoard {
  cards: Record<SessionKanbanColumn, SessionKanbanCard[]>;
  total: number;
}

export function buildSessionKanban(
  sessions: readonly ManagedSessionInput[],
  workspaceRoots: readonly string[],
  currentWindowId: string,
): SessionKanbanBoard {
  // 列を1つでも書き漏らすとこのリテラルが型エラーになる（Issue #1012、#1244）
  const cards: Record<SessionKanbanColumn, SessionKanbanCard[]> = {
    approvalPending: [],
    handoffPending: [],
    running: [],
    backgroundRunning: [],
    idle: [],
  };
  const columns = Object.keys(cards) as SessionKanbanColumn[];
  for (const session of sessions) {
    const isCurrentWindow = session.windowId === currentWindowId;
    // ワークスペース絞り込み（Issue #811由来）は自ウィンドウ分にだけ適用する。
    // 他ウィンドウ分は別のワークスペースを開いている前提で、自ウィンドウの
    // workspaceRootsで弾くと全滅してしまう（Issue #1244）
    if (
      isCurrentWindow &&
      (session.cwd === undefined || !isWithinAnyRoot(session.cwd, workspaceRoots))
    ) {
      continue;
    }
    const column = session.activity;
    // cwd は展開に混ぜない。`...session`のままだと絶対パスが画面まで届く（Issue #1039）
    const { cwd, ...rest } = session;
    cards[column].push({
      ...rest,
      column,
      cwdLabel: cwd === undefined ? '(不明)' : basename(cwd),
      cwdFull: cwd === undefined ? '(不明)' : normalizeWorkspacePath(cwd),
      isCurrentWindow,
    });
  }
  for (const column of columns) {
    cards[column].sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }
  return { cards, total: columns.reduce((total, column) => total + cards[column].length, 0) };
}

/** カードに出す表示名。判定と同じ正規化を通してから末尾の要素だけを取る */
function basename(path: string): string {
  const trimmed = normalizeWorkspacePath(path);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}
