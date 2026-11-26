import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { previewRequest } from './threadList';
import { FIRST_PROMPT_MAX, type SessionSummary } from './types';

/**
 * Codexの状態DB（`<CODEX_HOME>/state_<N>.sqlite`の`threads`表）から、対話スレッドの見出し・
 * 最初の依頼文・cwdを読む（Issue #2178）。
 *
 * `thread/list`はrolloutが残っているスレッドしか返さない（実測: codex-cli 0.166.0で状態DBの
 * 対話スレッド410件のうち、rolloutが残る25件だけを返した）。rolloutは保持期間を過ぎると消えるが、
 * 状態DBの行は残るので、Mission Controlの全期間の目録へはここから書き留める。
 *
 * - 読むだけ（`readOnly`）。Codexの内部の表なので、列が足りない・開けない・`node:sqlite`が無い
 *   （VS Code 1.90前後のNode 20）ときは空を返し、呼び出し側を落とさない
 * - 対象は`thread/list`の既定と同じ対話の起動元（`cli`・`vscode`）で、派生スレッド
 *   （`thread_source`が`user`以外）は除く
 * - 返す値は外部由来のまま。目録（`SessionCatalog`）へ入れる時に1行へ均す
 */

/** 読む行数の上限。対話スレッドだけを新しい順に読む。 */
export const STATE_DB_THREADS_MAX = 5_000;
const INTERACTIVE_SOURCES = ['cli', 'vscode'] as const;
const TITLE_READ_MAX = 500;
const PROMPT_READ_MAX = 20_000;
const REQUIRED_COLUMNS = [
  'id',
  'rollout_path',
  'updated_at',
  'source',
  'cwd',
  'title',
  'archived',
  'first_user_message',
  'thread_source',
  'name',
] as const;

interface Logger {
  warn(message: string): void;
}

/** `state_<N>.sqlite`のうちNが最大のもの。無ければ`undefined`。 */
export function pickStateDbFile(names: readonly string[]): string | undefined {
  let best: { name: string; version: number } | undefined;
  for (const name of names) {
    const m = /^state_(\d+)\.sqlite$/.exec(name);
    if (m === null) {
      continue;
    }
    const version = Number(m[1]);
    if (best === undefined || version > best.version) {
      best = { name, version };
    }
  }
  return best?.name;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `threads`表の1行を`SessionSummary`にする。形が合わない行は`undefined`。 */
export function toStateDbSession(row: Record<string, unknown>): SessionSummary | undefined {
  const id = text(row['id']);
  const updatedAt = row['updated_at'];
  if (id === undefined || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return undefined;
  }
  const threadSource = text(row['thread_source']);
  if (threadSource !== undefined && threadSource !== 'user') {
    return undefined;
  }
  const firstPrompt = previewRequest(text(row['first_user_message']) ?? '');
  const rolloutPath = text(row['rollout_path']);
  return {
    id,
    provider: 'codex',
    threadName: text(row['name']) ?? text(row['title']),
    updatedAt: new Date(updatedAt * 1000).toISOString(),
    cwd: text(row['cwd']),
    archived: row['archived'] === 1,
    ...(rolloutPath === undefined ? {} : { rolloutPath }),
    ...(firstPrompt === undefined ? {} : { firstPrompt: firstPrompt.slice(0, FIRST_PROMPT_MAX) }),
  };
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  };
}

/** 状態DBから対話スレッドを新しい順に読む。読めなければ空。 */
export async function readStateDbThreads(
  codexHome: string,
  log?: Logger,
  limit = STATE_DB_THREADS_MAX,
): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(codexHome);
  } catch {
    return [];
  }
  const file = pickStateDbFile(names);
  if (file === undefined) {
    return [];
  }
  let sqlite: SqliteModule;
  try {
    sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  } catch {
    // Node 22.5より前（VS Code 1.90前後）には無い
    return [];
  }
  let db: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    db = new sqlite.DatabaseSync(join(codexHome, file), { readOnly: true });
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((c) => (c as { name?: unknown }).name),
    );
    const lacking = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
    if (lacking.length > 0) {
      log?.warn(`Codexの状態DB（${file}）の形が想定と違うため読みません: ${lacking.join(', ')}`);
      return [];
    }
    // 見出し（title）と依頼文には依頼の全文が入ることがある（実測で数KB）。目録に残すのは
    // 数百字なので、読む時点で切る。依頼文はIDE拡張の前置きを除いてから切るので長めに取る
    const select = REQUIRED_COLUMNS.map((c) =>
      c === 'title' || c === 'name'
        ? `substr(${c}, 1, ${String(TITLE_READ_MAX)}) AS ${c}`
        : c === 'first_user_message'
          ? `substr(${c}, 1, ${String(PROMPT_READ_MAX)}) AS ${c}`
          : c,
    ).join(', ');
    const rows = db
      .prepare(
        `SELECT ${select} FROM threads
         WHERE source IN (${INTERACTIVE_SOURCES.map(() => '?').join(', ')})
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...INTERACTIVE_SOURCES, Math.max(0, Math.floor(limit)));
    const sessions: SessionSummary[] = [];
    for (const row of rows) {
      const session =
        typeof row === 'object' && row !== null
          ? toStateDbSession(row as Record<string, unknown>)
          : undefined;
      if (session !== undefined) {
        sessions.push(session);
      }
    }
    return sessions;
  } catch (e: unknown) {
    log?.warn(`Codexの状態DB（${file}）を読めませんでした: ${String(e)}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // 閉じる失敗は結果に関係しない
    }
  }
}
