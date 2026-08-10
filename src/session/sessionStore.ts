import type { CodexPaths } from '../codex/cliLocator';
import { parseSessionIndex } from '../codex/sessionIndex';
import {
  firstUserMessage,
  isUserThread,
  parseSessionMeta,
  sessionIdFromRolloutName,
} from '../codex/sessionMeta';
import type { SessionMeta, SessionSummary } from '../codex/types';
import type { FileSystemPort, MetaCachePort } from './ports';

export type HistoryScope = 'workspace' | 'all';

/**
 * 表示名を作るために読む先頭行数。
 * developerロールの前置きが数行入るため1行では足りない。
 */
const HEAD_LINES = 40;

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
   * 一覧を構築する。
   *
   * ロールアウトの実在を骨格にする。`session_index.jsonl` はCodexが要約名を確定させて
   * から書かれるため、それだけを見ると始めたばかりのセッションが一覧に出てこない。
   * indexは要約名と更新時刻の供給元として重ねる（Claude Code側と同じ組み立て方）。
   */
  async list(options: ListOptions): Promise<ListResult> {
    const content = await this.fs.readTextFile(this.paths.sessionIndex);
    const { entries, skipped } =
      content === undefined ? { entries: [], skipped: 0 } : parseSessionIndex(content);
    const indexed = new Map(entries.map((e) => [e.id, e]));

    const locations = await this.locateRollouts();
    const ordered = await this.orderByRecency([...locations.entries()], indexed);

    const sessions: SessionSummary[] = [];
    let unresolved = 0;

    for (const { id, location, updatedAt } of ordered) {
      if (sessions.length >= Math.max(0, options.maxEntries)) {
        break;
      }

      const meta = await this.resolveMeta(id, location.filePath);
      if (meta === undefined) {
        unresolved++;
        continue;
      }
      // サブエージェントなどの派生スレッドは一覧に出さない（設計書 §4.1）
      if (!isUserThread(meta)) {
        continue;
      }
      if (options.scope === 'workspace' && !isWithinAny(meta.cwd, options.workspaceFolders)) {
        continue;
      }

      sessions.push({
        id,
        provider: 'codex',
        threadName: indexed.get(id)?.threadName ?? (await this.firstInstruction(location.filePath)),
        updatedAt,
        cwd: meta.cwd,
        archived: location.archived,
      });
    }

    // indexにあるのにロールアウトが消えているものは、cwdが判らないので出せない
    for (const entry of entries) {
      if (!locations.has(entry.id)) {
        unresolved++;
        this.cache.delete(entry.id);
      }
    }

    return { sessions, skippedIndexLines: skipped, unresolved };
  }

  /**
   * 新しい順に並べる。
   *
   * indexに更新時刻があればそれを使い、無ければファイルの更新時刻で代用する。
   */
  private async orderByRecency(
    located: Array<[string, RolloutLocation]>,
    indexed: Map<string, { updatedAt: string }>,
  ): Promise<Array<{ id: string; location: RolloutLocation; updatedAt: string }>> {
    const rows: Array<{ id: string; location: RolloutLocation; updatedAt: string }> = [];

    for (const [id, location] of located) {
      const fromIndex = indexed.get(id)?.updatedAt;
      if (fromIndex !== undefined) {
        rows.push({ id, location, updatedAt: fromIndex });
        continue;
      }
      const mtimeMs = await this.fs.mtimeMs(location.filePath);
      rows.push({ id, location, updatedAt: new Date(mtimeMs ?? 0).toISOString() });
    }

    return rows.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
  }

  /** 要約名が無いセッションの表示名。最初の指示を先頭数十行から拾う。 */
  private async firstInstruction(filePath: string): Promise<string | undefined> {
    return firstUserMessage(await this.fs.readHead(filePath, HEAD_LINES));
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
