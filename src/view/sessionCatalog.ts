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
/**
 * Mission Controlの履歴で読むセッションの最小件数（Issue #2178）。Claude Codeだけに使う（索引から返す
 * だけで軽い）。
 */
export const MC_HISTORY_LIST_MIN = 2_000;
const TITLE_MAX = 200;
const PROMPT_MAX = 300;
const PATH_MAX = 1_000;
const THREAD_ID_MAX = 200;

export interface SessionCatalogEntry {
  provider: 'claude' | 'codex';
  threadId: string;
  title?: string | undefined;
  firstPrompt?: string | undefined;
  cwd?: string | undefined;
  /** 最後に更新された時刻（ms）。不明なら0。 */
  updatedAt: number;
  /** Codexのrollout・Claude Codeのtranscript。会話記録が残っているかを確かめるのに使う。 */
  transcriptPath?: string | undefined;
  /** archive済みか（Codex）。一覧に無いスレッドを開き直す前にarchiveを解除するのに使う。 */
  archived?: boolean | undefined;
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
    // idは鍵としてそのまま使うので、均すと変わるもの（改行・制御文字・長すぎる）は捨てる
    sanitizeInlineText(v.threadId, THREAD_ID_MAX) === v.threadId &&
    optionalString(v.title) &&
    optionalString(v.firstPrompt) &&
    optionalString(v.cwd) &&
    optionalString(v.transcriptPath) &&
    (v.archived === undefined || typeof v.archived === 'boolean') &&
    typeof v.updatedAt === 'number' &&
    Number.isFinite(v.updatedAt)
  );
}

/** ファイルから読んだ1件を、書くときと同じく1行に均す（ファイルが書き換えられていても）。 */
function normalizeStored(entry: SessionCatalogEntry): SessionCatalogEntry {
  return {
    provider: entry.provider,
    threadId: entry.threadId,
    title: inline(entry.title, TITLE_MAX),
    firstPrompt: inline(entry.firstPrompt, PROMPT_MAX),
    cwd: inline(entry.cwd, PATH_MAX),
    updatedAt: entry.updatedAt,
    transcriptPath: inline(entry.transcriptPath, PATH_MAX),
    archived: entry.archived,
  };
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
    transcriptPath:
      inline(session.rolloutPath ?? session.transcriptPath, PATH_MAX) ?? previous?.transcriptPath,
    // 一覧（archive済みを重ねたもの）と状態DBのどちらも、その時点のarchiveの状態を持つ
    archived: session.archived,
  };
}

function sameEntry(a: SessionCatalogEntry, b: SessionCatalogEntry): boolean {
  return (
    a.title === b.title &&
    a.firstPrompt === b.firstPrompt &&
    a.cwd === b.cwd &&
    a.updatedAt === b.updatedAt &&
    a.transcriptPath === b.transcriptPath &&
    a.archived === b.archived
  );
}

interface Logger {
  warn(message: string): void;
}

export class SessionCatalog {
  private readonly entries = new Map<string, SessionCatalogEntry>();
  /** 最後に読んだ・書いた時のファイルの版。変わっていれば別のウィンドウが書いている。 */
  private seenVersion: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly log?: Logger,
  ) {}

  /** 一覧で見かけたセッションを書き留め、目録の全件を返す。 */
  merge(sessions: readonly SessionSummary[]): Promise<SessionCatalogEntry[]> {
    // 同じウィンドウの中では1本ずつ（読み直し・書き込みが交互に走らないように）
    const run = this.queue.then(() => this.doMerge(sessions));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doMerge(sessions: readonly SessionSummary[]): Promise<SessionCatalogEntry[]> {
    // 目録は作り直せない記録なので、別のウィンドウ（globalStorageを共有する）が書いた分を
    // 取り込んでから重ねる。取り込まずに書くと、その分を上書きで消してしまう
    await this.reloadIfChanged();
    const before = new Map(this.entries);
    for (const session of sessions) {
      const key = catalogKey(session.provider, session.id);
      const next = toCatalogEntry(session, this.entries.get(key));
      if (next !== undefined) {
        this.entries.set(key, next);
      }
    }
    // 同じセッションを状態DBと一覧の両方から重ねるので、途中の値ではなく最後の値で比べる
    let changed = [...this.entries].some(([key, entry]) => {
      const previous = before.get(key);
      return previous === undefined || !sameEntry(previous, entry);
    });
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
      await this.write(body);
    }
    return [...this.entries.values()];
  }

  /**
   * ファイルの版。書き込みは一時ファイルからのrenameなのでinodeが毎回変わる。mtimeは粒度が
   * 粗く（数ms）、続けて書かれると同じ値になりうるため、inodeとサイズも合わせて見る。
   */
  private async versionOf(): Promise<string | undefined> {
    try {
      const stat = await fs.stat(this.path);
      return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      return undefined;
    }
  }

  /** ファイルが前に読んだ・書いた時から変わっていれば読み、更新の新しい方を残して重ねる。 */
  private async reloadIfChanged(): Promise<void> {
    const version = await this.versionOf();
    if (version === undefined || version === this.seenVersion) {
      return;
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      return;
    }
    this.seenVersion = version;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const value of parsed.entries) {
        if (!isEntry(value)) {
          continue;
        }
        const entry = normalizeStored(value);
        const key = catalogKey(entry.provider, entry.threadId);
        const current = this.entries.get(key);
        if (current === undefined || entry.updatedAt > current.updatedAt) {
          this.entries.set(key, entry);
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
      // 自分で書いた分は読み直さない
      this.seenVersion = await this.versionOf();
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
