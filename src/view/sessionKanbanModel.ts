import type { SessionActivityState } from './sessionActivity';

export type SessionKanbanColumn = 'approvalPending' | 'running' | 'idle';

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

const columns: SessionKanbanColumn[] = ['approvalPending', 'running', 'idle'];

export function buildSessionKanban(
  sessions: readonly ManagedSessionInput[],
  workspaceRoots: readonly string[],
): SessionKanbanBoard {
  const cards: Record<SessionKanbanColumn, SessionKanbanCard[]> = {
    approvalPending: [],
    running: [],
    idle: [],
  };
  for (const session of sessions) {
    if (session.cwd === undefined || !workspaceRoots.some((root) => isWithin(session.cwd!, root))) {
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

function isWithin(cwd: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCwd = normalizePath(cwd);
  if (normalizedRoot === '/') {
    return normalizedCwd.startsWith('/');
  }
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
}

function basename(path: string): string {
  const trimmed = normalizePath(path);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return normalized === '' ? '/' : normalized;
}
