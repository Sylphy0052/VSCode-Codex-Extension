import type { SessionSummary } from '../codex/types';
import type { MementoLike } from '../util/memento';

/** Claude transcriptの一覧用スナップショットを永続化するキー。 */
export const CLAUDE_SESSION_INDEX_KEY = 'claude.sessionIndex';

export interface ClaudeSessionIndexEntry {
  filePath: string;
  mtimeMs: number | undefined;
  session: SessionSummary;
}

/**
 * Claude Codeには一覧用の索引がないため、前回読み取ったtranscriptの先頭情報を保存する。
 * 起動直後はここから表示し、実ファイルとの照合はバックグラウンドで行う。
 */
export class ClaudeSessionIndex {
  private readonly entries = new Map<string, ClaudeSessionIndexEntry>();

  constructor(
    private readonly memento: MementoLike = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
  ) {
    for (const entry of this.memento.get<ClaudeSessionIndexEntry[]>(CLAUDE_SESSION_INDEX_KEY, [])) {
      if (entry.filePath !== '' && entry.session.provider === 'claude') {
        this.entries.set(entry.filePath, entry);
      }
    }
  }

  all(): ClaudeSessionIndexEntry[] {
    return [...this.entries.values()];
  }

  get(filePath: string): ClaudeSessionIndexEntry | undefined {
    return this.entries.get(filePath);
  }

  replace(entries: readonly ClaudeSessionIndexEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.filePath, entry);
    }
  }

  set(entry: ClaudeSessionIndexEntry): void {
    this.entries.set(entry.filePath, entry);
  }

  delete(filePath: string): void {
    this.entries.delete(filePath);
  }

  async persist(): Promise<void> {
    await this.memento.update(CLAUDE_SESSION_INDEX_KEY, this.all());
  }
}
