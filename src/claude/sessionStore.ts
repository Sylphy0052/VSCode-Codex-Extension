import type { SessionSummary } from '../codex/types';
import type { FileSystemPort } from '../session/ports';
import { isWithinAny, type ListOptions, type ListResult } from '../session/sessionStore';
import type { ClaudePaths } from './cliLocator';
import { parseTranscriptHead, sessionIdFromTranscriptName } from './transcript';

/**
 * 素性を得るために読む先頭行数。
 * `queue-operation` などが数行挟まるため1行では足りない。
 */
const HEAD_LINES = 40;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * Claude Code のセッション一覧。
 *
 * Codexの `session_index.jsonl` にあたる索引が無いため、`projects/**` の
 * transcript を mtime 降順に並べ、上位N件だけ先頭を読んで組み立てる。
 */
export class ClaudeSessionStore {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly paths: ClaudePaths,
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
        threadName: meta.firstUserText,
        updatedAt: new Date((mtimeMs ?? Date.parse(meta.startedAt ?? '')) || 0).toISOString(),
        cwd: meta.cwd,
        archived: false,
      });
    }

    // 索引を読まないためパース失敗の概念が無い（壊れた行は素性側で吸収する）
    return { sessions, skippedIndexLines: 0, unresolved };
  }

  /** 会話ビューアなど、全文を読む用途のために場所を解決する。 */
  async resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
    const found = await this.fs.listJsonl(this.paths.projects);
    return found.find((filePath) => sessionIdFromTranscriptName(basename(filePath)) === sessionId);
  }

  /** id が読めたtranscriptを、更新の新しい順に。 */
  private async orderedTranscripts(): Promise<
    Array<{ filePath: string; id: string; mtimeMs: number | undefined }>
  > {
    const files = await this.fs.listJsonl(this.paths.projects);
    const entries: Array<{ filePath: string; id: string; mtimeMs: number | undefined }> = [];

    for (const filePath of files) {
      const id = sessionIdFromTranscriptName(basename(filePath));
      if (id === undefined) {
        continue;
      }
      entries.push({ filePath, id, mtimeMs: await this.fs.mtimeMs(filePath) });
    }

    return entries.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
}
