import type { SessionIndexEntry } from './types';

export interface ParseIndexResult {
  entries: SessionIndexEntry[];
  /** パースできず捨てた行数。ログ用。 */
  skipped: number;
}

/**
 * ~/.codex/session_index.jsonl をパースする。
 *
 * このindexは全セッションを含まない。`thread_source: "user"` のセッションのみが載り、
 * subagent由来や非対話(exec)セッションは載らない（設計書 §4.1）。
 *
 * 追記中に読むと末尾が不完全な行になりうるため、壊れた行は個別に捨てて続行する。
 */
export function parseSessionIndex(content: string): ParseIndexResult {
  const entries: SessionIndexEntry[] = [];
  let skipped = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    const entry = parseLine(trimmed);
    if (entry === undefined) {
      skipped++;
      continue;
    }
    entries.push(entry);
  }

  return { entries, skipped };
}

function parseLine(line: string): SessionIndexEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  const updatedAt = obj['updated_at'];
  if (typeof id !== 'string' || id === '' || typeof updatedAt !== 'string') {
    return undefined;
  }

  const threadName = obj['thread_name'];
  return {
    id,
    threadName: typeof threadName === 'string' && threadName !== '' ? threadName : undefined,
    updatedAt,
  };
}

/** 更新時刻の降順に並べる。同時刻はidで安定化する。 */
export function sortByUpdatedAtDesc(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return [...entries].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) {
      return a.id.localeCompare(b.id);
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}
