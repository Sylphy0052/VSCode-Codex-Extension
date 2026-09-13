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
}

/**
 * 画面へ送るカード1枚。
 *
 * 作業ディレクトリは**末尾の要素だけ**を`cwdLabel`として持ち、絶対パスは持たない
 * （Issue #1039）。画面共有やスクリーンショットで、ユーザー名・ホームディレクトリ名・
 * 顧客名を含むディレクトリ名が意図せず映るため。全体を確かめたいときはサイドバーの
 * セッション一覧のツールチップ（`- cwd:`）を見る。
 */
export interface SessionKanbanCard extends Omit<ManagedSessionInput, 'cwd'> {
  column: SessionKanbanColumn;
  cwdLabel: string;
}

export interface SessionKanbanBoard {
  cards: Record<SessionKanbanColumn, SessionKanbanCard[]>;
  total: number;
}

export function buildSessionKanban(
  sessions: readonly ManagedSessionInput[],
  workspaceRoots: readonly string[],
): SessionKanbanBoard {
  // 列を1つでも書き漏らすとこのリテラルが型エラーになる（Issue #1012）
  const cards: Record<SessionKanbanColumn, SessionKanbanCard[]> = {
    approvalPending: [],
    running: [],
    idle: [],
  };
  const columns = Object.keys(cards) as SessionKanbanColumn[];
  for (const session of sessions) {
    if (session.cwd === undefined || !isWithinAnyRoot(session.cwd, workspaceRoots)) {
      continue;
    }
    const column = session.activity;
    // cwd は展開に混ぜない。`...session`のままだと絶対パスが画面まで届く（Issue #1039）
    const { cwd, ...rest } = session;
    cards[column].push({ ...rest, column, cwdLabel: basename(cwd) });
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
