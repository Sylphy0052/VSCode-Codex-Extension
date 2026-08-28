import type { SessionSummary } from '../codex/types';
import type { MementoLike } from '../util/memento';

/** Claude transcriptの一覧用スナップショットを永続化するキー。 */
export const CLAUDE_SESSION_INDEX_KEY = 'claude.sessionIndex';

/**
 * 永続化するエントリ数の上限（Issue #885）。
 *
 * globalStateは1キーぶんを丸ごと読み書きするため、transcriptが数千件あると
 * ウィンドウを開くたびに数MBのJSONを往復することになる。表示上限
 * （`codex.history.maxEntries` の既定は200）から見て十分に余裕のある数で頭を打つ。
 * ここで落ちた古いエントリは、次に走査したとき読み直される（一覧からは消えない）。
 */
export const CLAUDE_SESSION_INDEX_MAX_PERSISTED = 2_000;

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
    // 新しいものから順に上限まで残す。mtimeが読めなかったものは最後に回す
    const ordered = this.all().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    await this.memento.update(
      CLAUDE_SESSION_INDEX_KEY,
      ordered.slice(0, CLAUDE_SESSION_INDEX_MAX_PERSISTED),
    );
  }
}
