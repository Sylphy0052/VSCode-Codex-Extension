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
import { parseTranscriptHead, sessionIdFromTranscriptName } from './transcript';

/**
 * 素性を得るために読む先頭行数。
 * `queue-operation` などが数行挟まるため1行では足りない。
 */
const HEAD_LINES = 40;

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
  private stale = true;
  private onRefreshed: (() => void) | undefined;

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
    if (this.index.all().length === 0) {
      await this.refreshIndex();
    } else if (this.stale) {
      void this.refreshIndex().catch(() => undefined);
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
      if (previous?.mtimeMs === mtimeMs) {
        return;
      }
      const meta = parseTranscriptHead(await this.fs.readHead(filePath, HEAD_LINES));
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

    return { sessions, skippedIndexLines: 0, unresolved: 0 };
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

  /** 会話ビューアなど、全文を読む用途のために場所を解決する。 */
  async resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
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
    const filePath = await this.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return undefined;
    }
    return parseTranscriptHead(await this.fs.readHead(filePath, HEAD_LINES))?.cwd;
  }

  /** 初回・キャッシュ不整合時だけ全transcriptを照合する。 */
  private async refreshIndex(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const next = await this.readIndexFromFiles();
      this.index.replace(next);
      this.stale = false;
      await this.index.persist();
      this.onRefreshed?.();
    } finally {
      this.refreshing = false;
    }
  }

  private async readIndexFromFiles(): Promise<ClaudeSessionIndexEntry[]> {
    const files = await this.fs.listJsonl(this.paths.projects);
    const named = files
      .map((filePath) => ({ filePath, id: sessionIdFromTranscriptName(basenameOf(filePath)) }))
      .filter((entry): entry is { filePath: string; id: string } => entry.id !== undefined);

    // 件数分の`mtimeMs`取得を逐次待つと台数に比例して遅くなるため並列化する
    // （issue #436、Codex側の`orderByRecency`と同じ形）。最終的に全件ソートするため
    // 呼び出し順は問わない。ただし件数分を無制限に同時発火しないよう上限を設ける。
    const entries = await mapWithLimit(named, MTIME_CONCURRENCY_LIMIT, async ({ filePath, id }) => {
      const mtimeMs = await this.fs.mtimeMs(filePath);
      const cached = this.index.get(filePath);
      if (cached?.mtimeMs === mtimeMs) {
        return cached;
      }
      const meta = parseTranscriptHead(await this.fs.readHead(filePath, HEAD_LINES));
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
    });

    return entries.filter((entry): entry is ClaudeSessionIndexEntry => entry !== undefined);
  }
}
