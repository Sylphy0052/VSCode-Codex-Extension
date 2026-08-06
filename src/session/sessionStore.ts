import type { CodexPaths } from '../codex/cliLocator';
import { parseSessionIndex, sortByUpdatedAtDesc } from '../codex/sessionIndex';
import { parseSessionMeta, sessionIdFromRolloutName } from '../codex/sessionMeta';
import type { SessionMeta, SessionSummary } from '../codex/types';
import type { FileSystemPort, MetaCachePort } from './ports';

export type HistoryScope = 'workspace' | 'all';

export interface ListOptions {
  scope: HistoryScope;
  /** ワークスペースフォルダの絶対パス。scope が 'workspace' のときのフィルタに使う。 */
  workspaceFolders: string[];
  /** 一覧構築の上限。updated_at 降順で上位N件だけ session_meta を解決する。 */
  maxEntries: number;
}

export interface ListResult {
  sessions: SessionSummary[];
  /** パースできず捨てたindex行数。 */
  skippedIndexLines: number;
  /** ロールアウトが見つからず cwd を解決できなかった件数。 */
  unresolved: number;
}

interface RolloutLocation {
  filePath: string;
  archived: boolean;
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * 与えられたパスがいずれかのワークスペースフォルダの配下か。
 * `/a/b` が `/a/bc` を誤って含まないよう境界を厳密に見る。
 */
export function isWithinAny(target: string, folders: string[]): boolean {
  const norm = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const t = norm(target);
  return folders.some((folder) => {
    const f = norm(folder);
    return t === f || t.startsWith(`${f}/`);
  });
}

export class SessionStore {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: CodexPaths,
    private readonly cache: MetaCachePort,
  ) {}

  /**
   * 一覧を構築する。indexを骨格に、cwdの解決だけロールアウトの1行目から補う
   * （設計書 §4）。
   */
  async list(options: ListOptions): Promise<ListResult> {
    const content = await this.fs.readTextFile(this.paths.sessionIndex);
    if (content === undefined) {
      return { sessions: [], skippedIndexLines: 0, unresolved: 0 };
    }

    const { entries, skipped } = parseSessionIndex(content);
    const ordered = sortByUpdatedAtDesc(entries).slice(0, Math.max(0, options.maxEntries));
    const locations = await this.locateRollouts();

    const sessions: SessionSummary[] = [];
    let unresolved = 0;

    for (const entry of ordered) {
      const location = locations.get(entry.id);
      if (location === undefined) {
        // indexにはあるがファイルが消えている。cwdが判らないので workspace スコープでは出せない。
        unresolved++;
        this.cache.delete(entry.id);
        if (options.scope === 'all') {
          sessions.push({
            id: entry.id,
            threadName: entry.threadName,
            updatedAt: entry.updatedAt,
            cwd: undefined,
            archived: false,
          });
        }
        continue;
      }

      const meta = await this.resolveMeta(entry.id, location.filePath);
      if (meta === undefined) {
        unresolved++;
        continue;
      }

      if (options.scope === 'workspace' && !isWithinAny(meta.cwd, options.workspaceFolders)) {
        continue;
      }

      sessions.push({
        id: entry.id,
        threadName: entry.threadName,
        updatedAt: entry.updatedAt,
        cwd: meta.cwd,
        archived: location.archived,
      });
    }

    return { sessions, skippedIndexLines: skipped, unresolved };
  }

  /**
   * id → thread_name だけを読む軽量版。
   * タブ名の追従で頻繁に呼ぶため、ロールアウトの解決は行わない。
   */
  async threadNames(): Promise<Map<string, string>> {
    const content = await this.fs.readTextFile(this.paths.sessionIndex);
    if (content === undefined) {
      return new Map();
    }
    const { entries } = parseSessionIndex(content);
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry.threadName !== undefined) {
        map.set(entry.id, entry.threadName);
      }
    }
    return map;
  }

  /** 会話ビューアなど、全文を読む用途のためにロールアウトの場所を解決する。 */
  async resolveRolloutPath(sessionId: string): Promise<string | undefined> {
    return (await this.locateRollouts()).get(sessionId)?.filePath;
  }

  /** id → ロールアウトの所在。archived_sessions 配下かどうかがアーカイブ状態そのもの。 */
  private async locateRollouts(): Promise<Map<string, RolloutLocation>> {
    const map = new Map<string, RolloutLocation>();

    const active = await this.fs.listRollouts(this.paths.sessions);
    for (const filePath of active) {
      const id = sessionIdFromRolloutName(basename(filePath));
      if (id !== undefined) {
        map.set(id, { filePath, archived: false });
      }
    }

    const archived = await this.fs.listRollouts(this.paths.archivedSessions);
    for (const filePath of archived) {
      const id = sessionIdFromRolloutName(basename(filePath));
      if (id !== undefined) {
        map.set(id, { filePath, archived: true });
      }
    }

    return map;
  }

  private async resolveMeta(id: string, filePath: string): Promise<SessionMeta | undefined> {
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return cached;
    }

    const line = await this.fs.readFirstLine(filePath);
    if (line === undefined) {
      return undefined;
    }

    const meta = parseSessionMeta(line);
    if (meta === undefined) {
      return undefined;
    }

    this.cache.set(id, meta);
    return meta;
  }

  /** 実体が消えたセッションのキャッシュを落とす。 */
  async pruneCache(): Promise<number> {
    const locations = await this.locateRollouts();
    let removed = 0;
    for (const id of this.cache.keys()) {
      if (!locations.has(id)) {
        this.cache.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
