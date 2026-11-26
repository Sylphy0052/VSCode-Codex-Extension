import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionSummary } from '../codex/types';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

/**
 * 全期間のセッション目録（Issue #2178）。
 *
 * Claude Codeのtranscriptは保持期間（既定14日前後）を過ぎると消え、一覧（`listSessions`）からも
 * 外れる。見出しと最初の依頼文を、一覧で見かけたときに`<globalStorage>/mission-control/`へ
 * 書き留めておき、transcriptが消えた後も履歴の検索で引けるようにする。目録からは消さない
 * （件数が`SESSION_CATALOG_MAX`を超えたら、更新の古いものから捨てる）。
 */

export const SESSION_CATALOG_FILE = 'session-catalog.json';
const CATALOG_VERSION = 1;
export const SESSION_CATALOG_MAX = 20_000;
const TITLE_MAX = 200;
const PROMPT_MAX = 300;
const PATH_MAX = 1_000;

export interface SessionCatalogEntry {
  provider: 'claude' | 'codex';
  threadId: string;
  title?: string | undefined;
  firstPrompt?: string | undefined;
  cwd?: string | undefined;
  /** 最後に更新された時刻（ms）。不明なら0。 */
  updatedAt: number;
  /** Codexのrollout。transcriptが残っているかを確かめるのに使う。 */
  transcriptPath?: string | undefined;
}

export function catalogKey(provider: string, threadId: string): string {
  return `${provider}|${threadId}`;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isEntry(value: unknown): value is SessionCatalogEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    (v.provider === 'claude' || v.provider === 'codex') &&
    typeof v.threadId === 'string' &&
    v.threadId !== '' &&
    optionalString(v.title) &&
    optionalString(v.firstPrompt) &&
    optionalString(v.cwd) &&
    optionalString(v.transcriptPath) &&
    typeof v.updatedAt === 'number'
  );
}

function inline(value: string | undefined, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = sanitizeInlineText(value.trim(), max);
  return text === '' ? undefined : text;
}

/** 一覧の1件を目録の形にする。前に書き留めた値は、今回取れなかった項目だけ引き継ぐ。 */
export function toCatalogEntry(
  session: SessionSummary,
  previous: SessionCatalogEntry | undefined,
): SessionCatalogEntry | undefined {
  if (session.provider !== 'claude' && session.provider !== 'codex') {
    return undefined;
  }
  const updatedAt = Date.parse(session.updatedAt);
  return {
    provider: session.provider,
    threadId: session.id,
    title: inline(session.threadName, TITLE_MAX) ?? previous?.title,
    firstPrompt: inline(session.firstPrompt, PROMPT_MAX) ?? previous?.firstPrompt,
    cwd: inline(session.cwd, PATH_MAX) ?? previous?.cwd,
    updatedAt: Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, previous?.updatedAt ?? 0),
    transcriptPath: inline(session.rolloutPath, PATH_MAX) ?? previous?.transcriptPath,
  };
}

function sameEntry(a: SessionCatalogEntry, b: SessionCatalogEntry): boolean {
  return (
    a.title === b.title &&
    a.firstPrompt === b.firstPrompt &&
    a.cwd === b.cwd &&
    a.updatedAt === b.updatedAt &&
    a.transcriptPath === b.transcriptPath
  );
}

interface Logger {
  warn(message: string): void;
}

export class SessionCatalog {
  private readonly entries = new Map<string, SessionCatalogEntry>();
  private loaded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly log?: Logger,
  ) {}

  /** 一覧で見かけたセッションを書き留め、目録の全件を返す。 */
  async merge(sessions: readonly SessionSummary[]): Promise<SessionCatalogEntry[]> {
    this.loaded ??= this.load();
    await this.loaded;
    let changed = false;
    for (const session of sessions) {
      const key = catalogKey(session.provider, session.id);
      const previous = this.entries.get(key);
      const next = toCatalogEntry(session, previous);
      if (next !== undefined && (previous === undefined || !sameEntry(previous, next))) {
        this.entries.set(key, next);
        changed = true;
      }
    }
    if (this.entries.size > SESSION_CATALOG_MAX) {
      const oldest = [...this.entries.values()]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, this.entries.size - SESSION_CATALOG_MAX);
      for (const entry of oldest) {
        this.entries.delete(catalogKey(entry.provider, entry.threadId));
      }
      changed = true;
    }
    if (changed) {
      const body = JSON.stringify({
        version: CATALOG_VERSION,
        entries: [...this.entries.values()],
      });
      this.writing = this.writing.then(() => this.write(body));
      await this.writing;
    }
    return [...this.entries.values()];
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const entry of parsed.entries) {
        if (isEntry(entry)) {
          this.entries.set(catalogKey(entry.provider, entry.threadId), entry);
        }
      }
    } catch (e: unknown) {
      this.log?.warn(`セッション目録を読めないため作り直します: ${String(e)}`);
    }
  }

  private async write(body: string): Promise<void> {
    const tmp = `${this.path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.path);
    } catch (e: unknown) {
      this.log?.warn(`セッション目録を書けませんでした: ${String(e)}`);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

/** 渡したパスのうち、ファイルが無いもの。 */
export async function missingFiles(paths: readonly string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const unique = [...new Set(paths)];
  const LIMIT = 16;
  for (let i = 0; i < unique.length; i += LIMIT) {
    await Promise.all(
      unique.slice(i, i + LIMIT).map(async (path) => {
        try {
          await fs.stat(path);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            missing.add(path);
          }
        }
      }),
    );
  }
  return missing;
}
