import type { SessionSummary } from '../codex/types';
import type { FileSystemPort } from '../session/ports';
import { isWithinAny, type ListOptions, type ListResult } from '../session/sessionStore';
import { mapWithLimit } from '../util/concurrency';
import { basenameOf } from '../util/paths';
import type { ClaudePaths } from './cliLocator';
import { ClaudeSessionNameStore } from './sessionNames';
import { parseTranscriptHead, sessionIdFromTranscriptName } from './transcript';

/**
 * 素性を得るために読む先頭行数。
 * `queue-operation` などが数行挟まるため1行では足りない。
 */
const HEAD_LINES = 40;

/**
 * `orderedTranscripts`で`fs.mtimeMs`を並列発火する上限。
 * Codex側（`src/session/sessionStore.ts`の`MTIME_CONCURRENCY_LIMIT`）と同じ値を使う
 * （issue #436）。件数分を無制限に同時発火しないための頭打ち値。
 */
const MTIME_CONCURRENCY_LIMIT = 32;

/**
 * Claude Code のセッション一覧。
 *
 * Codexの `session_index.jsonl` にあたる索引が無いため、`projects/**` の
 * transcript を mtime 降順に並べ、上位N件だけ先頭を読んで組み立てる。
 *
 * 表示名は「人が付けた名前（`ClaudeSessionNameStore`） > transcriptの最初の発言」の順で
 * 解決する（issue #199）。CLI側の `rename_session` は実在するが読み戻す索引が無いため、
 * ここでは使わない（`control.ts` の `buildRenameSessionRequest` のJSDoc参照）。
 */
export class ClaudeSessionStore {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: ClaudePaths,
    /**
     * 人が付け直した名前の保存先（issue #199）。既定はテスト等で使い回せる no-op
     * （`ClaudeSessionNameStore` のJSDoc参照）。
     */
    private readonly names: ClaudeSessionNameStore = new ClaudeSessionNameStore(),
  ) {}

  async list(options: ListOptions): Promise<ListResult> {
    const ordered = await this.orderedTranscripts();

    const sessions: SessionSummary[] = [];
    let unresolved = 0;

    for (const { filePath, id, mtimeMs } of ordered) {
      if (sessions.length >= Math.max(0, options.maxEntries)) {
        break;
      }

      const meta = parseTranscriptHead(await this.fs.readHead(filePath, HEAD_LINES));
      if (meta === undefined) {
        unresolved++;
        continue;
      }
      if (options.scope === 'workspace' && !isWithinAny(meta.cwd, options.workspaceFolders)) {
        continue;
      }

      sessions.push({
        id,
        provider: 'claude',
        // 解決順: 人が付けた名前 > transcriptの最初の発言（issue #199の受入基準）
        threadName: this.names.get(id) ?? meta.firstUserText,
        updatedAt: new Date((mtimeMs ?? Date.parse(meta.startedAt ?? '')) || 0).toISOString(),
        cwd: meta.cwd,
        archived: false,
      });
    }

    // 索引を読まないためパース失敗の概念が無い（壊れた行は素性側で吸収する）
    return { sessions, skippedIndexLines: 0, unresolved };
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

  /** id が読めたtranscriptを、更新の新しい順に。 */
  private async orderedTranscripts(): Promise<
    Array<{ filePath: string; id: string; mtimeMs: number | undefined }>
  > {
    const files = await this.fs.listJsonl(this.paths.projects);
    const named = files
      .map((filePath) => ({ filePath, id: sessionIdFromTranscriptName(basenameOf(filePath)) }))
      .filter(
        (entry): entry is { filePath: string; id: string } => entry.id !== undefined,
      );

    // 件数分の`mtimeMs`取得を逐次待つと台数に比例して遅くなるため並列化する
    // （issue #436、Codex側の`orderByRecency`と同じ形）。最終的に全件ソートするため
    // 呼び出し順は問わない。ただし件数分を無制限に同時発火しないよう上限を設ける。
    const entries = await mapWithLimit(named, MTIME_CONCURRENCY_LIMIT, async ({ filePath, id }) => ({
      filePath,
      id,
      mtimeMs: await this.fs.mtimeMs(filePath),
    }));

    return entries.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
}
