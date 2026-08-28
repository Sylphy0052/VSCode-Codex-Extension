import type { SessionSummary } from './types';

export type ThreadListOutcome =
  { ok: true; sessions: SessionSummary[] } | { ok: false; error: string };

export interface ThreadListPage {
  /** そのページに含まれる生のスレッド1件分。個々の形は `normalizeThread` で確定する。 */
  items: unknown[];
  /** 続きを取るためのカーソル。続きが無ければ undefined。 */
  nextCursor: string | undefined;
}

/**
 * `thread/list` の1回分の応答をパースする。
 *
 * 実測（codex-cli 0.147.0、`{limit: 3}`）: `{data: [...], nextCursor: "2026-08-11T00:52:11Z"}`。
 * 形が変わっていても落ちないよう、`data` が配列でなければ空として扱う。
 */
export function parseThreadListPage(result: unknown): ThreadListPage {
  const root = asRecord(result);
  const data = root?.['data'];
  const cursor = str(root?.['nextCursor']);
  return {
    items: Array.isArray(data) ? data : [],
    nextCursor: cursor === '' ? undefined : cursor,
  };
}

/**
 * `thread/list` の1件を `SessionSummary` へ正規化する。
 *
 * 実測で確認したキー: `id, sessionId, forkedFromId, parentThreadId, preview, ephemeral,
 * section, sectionEnteredAt, historyMode, modelProvider, createdAt, updatedAt, recencyAt,
 * status, path, cwd, cliVersion, source, canAcceptDirectInput, threadSource, agentNickname,
 * agentRole, gitInfo, name, turns`。ここで使うのは一覧に必要な最小限のみ。
 *
 * - `threadSource` が明示的に `'user'` 以外の値（`'subagent'` など）を持つ派生スレッドのみ除く。
 *   実測（codex-cli 0.147.0、`thread/list` を全件ページングし尽くした33件）では `threadSource` は
 *   全件 `null` だったため、`null` / 未設定はユーザースレッドとして通す。ファイル読み経路
 *   （`sessionMeta.isUserThread`）も同じ規則で判定する。あちらが見ているのは
 *   `session_index.jsonl` ではなくロールアウト1行目の `session_meta` で、codex-cli 0.148.0 では
 *   そこに `thread_source` が無い。未設定を除外扱いにすると一覧が丸ごと空になるため、
 *   両経路とも「明示的に `'user'` 以外のときだけ除く」に揃えてある（design.md §4.4、issue #943）。
 * - `archived` に相当するフィールドは無いため、`path` が `archivedSessionsDir` 配下かどうかで
 *   判定する（ファイル読み経路と同じ考え方。design.md §4.2）。
 * - `updatedAt` は実測でUnix epoch秒（数値）。文字列（ISO8601）で来た場合も念のため受け付ける。
 */
export function normalizeThread(
  raw: unknown,
  archivedSessionsDir: string,
): SessionSummary | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) {
    return undefined;
  }

  const threadSource = str(obj['threadSource']);
  if (threadSource !== '' && threadSource !== 'user') {
    return undefined;
  }

  const id = str(obj['id']);
  if (id === '') {
    return undefined;
  }

  const updatedAt = toIsoString(obj['updatedAt']);
  if (updatedAt === undefined) {
    return undefined;
  }

  const cwd = str(obj['cwd']);
  const name = obj['name'];
  const path = str(obj['path']);
  const parentThreadId = str(obj['parentThreadId']);

  return {
    id,
    provider: 'codex',
    threadName: typeof name === 'string' && name !== '' ? name : undefined,
    updatedAt,
    cwd: cwd === '' ? undefined : cwd,
    archived: path !== '' && isUnderDir(path, archivedSessionsDir),
    rolloutPath: path === '' ? undefined : path,
    parentThreadId: parentThreadId === '' ? undefined : parentThreadId,
  };
}

/** `raw` の配列をまとめて正規化する。個々に失敗した要素は結果から落ちる。 */
export function normalizeThreadList(raw: unknown[], archivedSessionsDir: string): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  for (const entry of raw) {
    const session = normalizeThread(entry, archivedSessionsDir);
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  return sessions;
}

/** `target` が `dir` 配下（`dir` 自身を含む）か。前方一致だけの別ディレクトリを含めない。 */
function isUnderDir(target: string, dir: string): boolean {
  if (dir === '') {
    return false;
  }
  const norm = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const t = norm(target);
  const d = norm(dir);
  return t === d || t.startsWith(`${d}/`);
}

function toIsoString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
