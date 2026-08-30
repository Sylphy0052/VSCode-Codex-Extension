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

export interface SessionKanbanCard extends ManagedSessionInput {
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
    cards[column].push({ ...session, column, cwdLabel: basename(session.cwd) });
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
