import type { SessionSummary } from '../codex/types';
import type { FileSystemPort } from '../session/ports';
import {
  isWithinAny,
  MTIME_CONCURRENCY_LIMIT,
  type ListOptions,
  type ListResult,
} from '../session/sessionStore';
import { mapWithLimit } from '../util/concurrency';
import { basenameOf } from '../util/paths';
import type { ClaudePaths } from './cliLocator';
import { ClaudeSessionNameStore } from './sessionNames';
import { ClaudeSessionIndex, type ClaudeSessionIndexEntry } from './sessionIndex';
import {
  createTranscriptHeadReader,
  parseTranscriptHead,
  sessionIdFromTranscriptName,
  transcriptDirSlug,
} from './transcript';
import type { TranscriptMeta } from './types';

/**
 * 素性を得るために読む先頭行数。
 * `queue-operation` などが数行挟まるため1行では足りない。
 */
const HEAD_LINES = 40;

/**
 * 素性を読むときに1ファイルから読み込むバイト数の上限（Issue #885）。
 *
 * transcriptは1行にtool_resultを丸ごと積むため、40行が数MBになることがある。
 * cwdとsessionIdは通常先頭の数行で揃うので、揃わないまま膨らんだファイルは
 * ここで打ち切って次へ進む。
 */
const HEAD_MAX_BYTES = 256 * 1024;

/**
 * 索引を作り直す範囲（Issue #885）。
 *
 * `limit` を指定すると件数が揃った時点で走査をやめる（初回表示を早く出すため）。
 * 省くと範囲内を最後まで走査する（索引を完成させるため）。
 */
interface RefreshScope {
  scope: ListOptions['scope'];
  workspaceFolders: string[];
  limit?: number;
}

/** 索引がどの範囲で作られたかを表す鍵（Issue #885）。 */
function scopeKey(scope: RefreshScope | undefined): string {
  if (scope === undefined) {
    return 'all:';
  }
  return `${scope.scope}:${[...scope.workspaceFolders].sort().join('\u0000')}`;
}

/**
 * Claude Code のセッション一覧。
 *
 * Codexの `session_index.jsonl` にあたる索引が無いため、前回読み取った一覧を
 * `globalState`へ保存する。起動時はそのスナップショットを返し、実ファイルとの照合は
 * バックグラウンドで行う。
 *
 * 表示名は「人が付けた名前（`ClaudeSessionNameStore`） > transcriptの最初の発言」の順で
 * 解決する（issue #199）。CLI側の `rename_session` は実在するが読み戻す索引が無いため、
 * ここでは使わない（`control.ts` の `buildRenameSessionRequest` のJSDoc参照）。
 */
export class ClaudeSessionStore {
  private refreshing = false;
  private refreshScheduled = false;
  private stale = true;
  private unresolved = 0;
  private onRefreshed: (() => void) | undefined;
  /**
   * 直近の `list` が求めた範囲（Issue #885）。バックグラウンドの照合はこの範囲を引き継ぐ。
   * 以前は範囲を渡さずに走らせていたため、起動直後に全transcriptを開き直していた。
   */
  private lastScope: RefreshScope | undefined;
  /**
   * 索引を作ったときの範囲（Issue #885）。ワークスペース絞り込みで作った索引には
   * 他のワークスペースのセッションが入らないため、`scope` を切り替えたら
   * `stale` と同じ扱いで照合し直す。これが無いと `scope: all` へ変えたとき、
   * 絞り込み済みの索引をそのまま返して他ワークスペースのセッションが消える。
   */
  private indexedScopeKey: string | undefined;

  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: ClaudePaths,
    /**
     * 人が付け直した名前の保存先（issue #199）。既定はテスト等で使い回せる no-op
     * （`ClaudeSessionNameStore` のJSDoc参照）。
     */
    private readonly names: ClaudeSessionNameStore = new ClaudeSessionNameStore(),
    private readonly index: ClaudeSessionIndex = new ClaudeSessionIndex(),
  ) {}

  async list(options: ListOptions): Promise<ListResult> {
    this.lastScope = { scope: options.scope, workspaceFolders: options.workspaceFolders };
    // 索引が無いとき、および索引が別の範囲で作られているときは、その場で作り直す。
    // 後者を待たずに返すと、`scope` を切り替えた直後の1回だけ絞り込み済みの索引が
    // そのまま出てしまう（Issue #885）
    if (this.index.all().length === 0 || this.indexedScopeKey !== scopeKey(this.lastScope)) {
      await this.refreshIndex({ ...this.lastScope, limit: options.maxEntries });
      this.scheduleRefresh();
    } else if (this.stale) {
      this.scheduleRefresh();
    }

    return this.listFromIndex(options);
  }

  /** バックグラウンド照合の完了を受ける。履歴ツリーの再描画に使う。 */
  setOnRefreshed(listener: (() => void) | undefined): void {
    this.onRefreshed = listener;
  }

  /**
   * watcherから呼ぶ差分更新。変更されたtranscriptだけを読み直し、全件のmtime取得を避ける。
   */
  async refreshFile(filePath: string): Promise<void> {
    const id = sessionIdFromTranscriptName(basenameOf(filePath));
    if (id === undefined) {
      return;
    }
    const mtimeMs = await this.fs.mtimeMs(filePath);
    if (mtimeMs === undefined) {
      this.index.delete(filePath);
    } else {
      const previous = this.index.get(filePath);
      if (previous !== undefined && previous.mtimeMs === mtimeMs) {
        return;
      }
      const meta = await this.readHeadMeta(filePath);
      if (meta === undefined) {
        this.index.delete(filePath);
      } else {
        this.index.set({
          filePath,
          mtimeMs,
          session: {
            id,
            provider: 'claude',
            threadName: meta.firstUserText,
            updatedAt: new Date((mtimeMs ?? Date.parse(meta.startedAt ?? '')) || 0).toISOString(),
            cwd: meta.cwd,
            archived: false,
          },
        });
      }
    }
    await this.index.persist();
    this.onRefreshed?.();
  }

  private listFromIndex(options: ListOptions): ListResult {
    const ordered = this.index
      .all()
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));

    const sessions: SessionSummary[] = [];

    for (const { session } of ordered) {
      if (sessions.length >= Math.max(0, options.maxEntries)) {
        break;
      }
      if (
        options.scope === 'workspace' &&
        !isWithinAny(session.cwd ?? '', options.workspaceFolders)
      ) {
        continue;
      }
      sessions.push({
        ...session,
        // 解決順: 人が付けた名前 > transcriptの最初の発言（issue #199の受入基準）
        threadName: this.names.get(session.id) ?? session.threadName,
      });
    }

    return { sessions, skippedIndexLines: 0, unresolved: this.unresolved };
  }

  /** 人が付けた名前を読む（issue #199）。付けていなければ `undefined`。 */
  getName(sessionId: string): string | undefined {
    return this.names.get(sessionId);
  }

  /**
   * 人が付けた名前を保存する（issue #199）。ウィンドウのリロード後も `list` / `getName` に
   * 反映される（`globalState` 実体への書き込みが `await` で確定してから返る）。
   */
  async rename(sessionId: string, name: string): Promise<void> {
    await this.names.set(sessionId, name);
  }

  /**
   * 会話ビューアなど、全文を読む用途のために場所を解決する。
   *
   * 索引に載っていればそこから引く（Issue #887）。この経路は会話を開くたび
   * （リロード後の復元を含む）に通るため、毎回 `projects/` を再帰走査していると
   * 復元されるタブの枚数だけ走査が積み上がる。索引が指すパスは消えていることが
   * あるので、実在を確かめてから返す。
   */
  async resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
    const indexed = this.index.findBySessionId(sessionId);
    if (indexed !== undefined && (await this.fs.mtimeMs(indexed.filePath)) !== undefined) {
      return indexed.filePath;
    }
    const found = await this.fs.listJsonl(this.paths.projects);
    return found.find(
      (filePath) => sessionIdFromTranscriptName(basenameOf(filePath)) === sessionId,
    );
  }

  /**
   * idから作業ディレクトリを引く。
   *
   * リロードで復元されたパネルはcwdを持たないため、transcriptの素性から取り戻す。
   */
  async resolveCwd(sessionId: string): Promise<string | undefined> {
    // 索引はcwdも持っている（Issue #887）。載っていればtranscriptを開かずに済む
    const indexed = this.index.findBySessionId(sessionId);
    if (indexed?.session.cwd !== undefined) {
      return indexed.session.cwd;
    }
    const filePath = await this.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return undefined;
    }
    return (await this.readHeadMeta(filePath))?.cwd;
  }

  /** 初回・キャッシュ不整合時だけtranscriptを照合する。 */
  private async refreshIndex(scope?: RefreshScope): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const next = await this.readIndexFromFiles(scope);
      this.index.replace(next.entries);
      this.unresolved = next.unresolved;
      // 件数で打ち切ったなら索引は途中までなので、あとで走査し直す必要がある
      this.stale = scope?.limit !== undefined;
      this.indexedScopeKey = scopeKey(scope);
      await this.index.persist();
      this.onRefreshed?.();
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled || this.refreshing) {
      return;
    }
    this.refreshScheduled = true;
    setTimeout(() => {
      this.refreshScheduled = false;
      // 件数上限だけ外し、ワークスペースの絞り込みは引き継ぐ（Issue #885）
      void this.refreshIndex(this.lastScope).catch(() => undefined);
    }, 0);
  }

  private async readIndexFromFiles(scope?: RefreshScope): Promise<{
    entries: ClaudeSessionIndexEntry[];
    unresolved: number;
  }> {
    const narrowed = await this.narrowedTranscripts(scope);
    if (narrowed !== undefined) {
      const result = await this.buildEntries(narrowed, scope);
      // ディレクトリ名はcwdと食い違うことがある（`transcriptDirSlug`のJSDoc参照）。
      // 1件も拾えなかったときだけ全走査へ広げ、絞り込みの取りこぼしを防ぐ
      if (result.entries.length > 0) {
        return result;
      }
    }
    return this.buildEntries(await this.fs.listJsonl(this.paths.projects), scope);
  }

  /**
   * ワークスペース絞り込みのとき、`projects/` 直下のディレクトリ名だけで候補を削る
   * （Issue #885）。絞り込めない条件なら `undefined` を返し、呼び出し側が全走査する。
   */
  private async narrowedTranscripts(scope?: RefreshScope): Promise<string[] | undefined> {
    const listSubdirectories = this.fs.listSubdirectories?.bind(this.fs);
    if (scope?.scope !== 'workspace' || listSubdirectories === undefined) {
      return undefined;
    }
    const prefixes = scope.workspaceFolders
      .map((folder) => transcriptDirSlug(folder))
      .filter((slug) => slug !== '');
    if (prefixes.length === 0) {
      return undefined;
    }
    const dirs = (await listSubdirectories(this.paths.projects)).filter((name) =>
      prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`)),
    );
    if (dirs.length === 0) {
      return undefined;
    }
    const nested = await mapWithLimit(dirs, MTIME_CONCURRENCY_LIMIT, (name) =>
      this.fs.listJsonl(`${this.paths.projects}/${name}`),
    );
    return nested.flat();
  }

  private async buildEntries(
    files: readonly string[],
    scope?: RefreshScope,
  ): Promise<{
    entries: ClaudeSessionIndexEntry[];
    unresolved: number;
  }> {
    const named = files
      .map((filePath) => ({ filePath, id: sessionIdFromTranscriptName(basenameOf(filePath)) }))
      .filter((entry): entry is { filePath: string; id: string } => entry.id !== undefined);

    const ordered = await mapWithLimit(named, MTIME_CONCURRENCY_LIMIT, async ({ filePath, id }) => {
      const mtimeMs = await this.fs.mtimeMs(filePath);
      return { filePath, id, mtimeMs };
    });
    ordered.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    const entries: ClaudeSessionIndexEntry[] = [];
    let unresolved = 0;
    for (const { filePath, id, mtimeMs } of ordered) {
      const cached = this.index.get(filePath);
      const entry =
        cached !== undefined && cached.mtimeMs === mtimeMs
          ? cached
          : await this.readIndexEntry(filePath, id, mtimeMs);
      if (entry === undefined) {
        unresolved += 1;
        continue;
      }
      if (
        scope?.scope === 'workspace' &&
        !isWithinAny(entry.session.cwd ?? '', scope.workspaceFolders)
      ) {
        continue;
      }
      entries.push(entry);
      if (scope?.limit !== undefined && entries.length >= Math.max(0, scope.limit)) {
        break;
      }
    }

    return { entries, unresolved };
  }

  /**
   * 素性が揃った時点で読むのをやめる先頭読み（Issue #885）。
   *
   * `readHeadUntil` を持たないポート（テストのフェイク等）では、これまでどおり
   * 先頭 `HEAD_LINES` 行を読んでから解釈する。どちらの経路でも結果は同じ。
   */
  private async readHeadMeta(filePath: string): Promise<TranscriptMeta | undefined> {
    const readHeadUntil = this.fs.readHeadUntil?.bind(this.fs);
    if (readHeadUntil === undefined) {
      return parseTranscriptHead(await this.fs.readHead(filePath, HEAD_LINES));
    }
    const reader = createTranscriptHeadReader();
    await readHeadUntil(filePath, HEAD_LINES, HEAD_MAX_BYTES, (line) => reader.push(line));
    return reader.result();
  }

  private async readIndexEntry(
    filePath: string,
    id: string,
    mtimeMs: number | undefined,
  ): Promise<ClaudeSessionIndexEntry | undefined> {
    const meta = await this.readHeadMeta(filePath);
    if (meta === undefined) {
      return undefined;
    }
    return {
      filePath,
      mtimeMs,
      session: {
        id,
        provider: 'claude' as const,
        threadName: meta.firstUserText,
        updatedAt: new Date((mtimeMs ?? Date.parse(meta.startedAt ?? '')) || 0).toISOString(),
        cwd: meta.cwd,
        archived: false,
      },
    };
  }
}
