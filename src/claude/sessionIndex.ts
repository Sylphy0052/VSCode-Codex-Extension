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
  /**
   * sessionId からエントリを引くための副次索引（Issue #887）。
   *
   * 主索引は transcript の絶対パスをキーにしているため、sessionId しか手元に無い
   * `resolveTranscriptPath` / `resolveCwd` は全件を舐めるしかなかった。両者は会話を
   * 開くたび（リロード後の復元を含む）に通るので、逆引きを持っておく。
   */
  private readonly bySessionId = new Map<string, ClaudeSessionIndexEntry>();

  constructor(
    private readonly memento: MementoLike = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
  ) {
    for (const entry of this.memento.get<ClaudeSessionIndexEntry[]>(CLAUDE_SESSION_INDEX_KEY, [])) {
      if (entry.filePath !== '' && entry.session.provider === 'claude') {
        this.remember(entry);
      }
    }
  }

  all(): ClaudeSessionIndexEntry[] {
    return [...this.entries.values()];
  }

  get(filePath: string): ClaudeSessionIndexEntry | undefined {
    return this.entries.get(filePath);
  }

  /** sessionId からエントリを引く（Issue #887）。 */
  findBySessionId(sessionId: string): ClaudeSessionIndexEntry | undefined {
    return this.bySessionId.get(sessionId);
  }

  replace(entries: readonly ClaudeSessionIndexEntry[]): void {
    this.entries.clear();
    this.bySessionId.clear();
    for (const entry of entries) {
      this.remember(entry);
    }
  }

  set(entry: ClaudeSessionIndexEntry): void {
    this.remember(entry);
  }

  delete(filePath: string): void {
    const removed = this.entries.get(filePath);
    this.entries.delete(filePath);
    // 同じsessionIdが別パスで登録し直されている場合があるため、
    // 逆引きは自分が指していたときだけ消す
    if (removed !== undefined && this.bySessionId.get(removed.session.id) === removed) {
      this.bySessionId.delete(removed.session.id);
    }
  }

  /** 主索引と逆引きを同時に更新する。両者がずれないよう入口を1つにする。 */
  private remember(entry: ClaudeSessionIndexEntry): void {
    const previous = this.entries.get(entry.filePath);
    if (previous !== undefined && this.bySessionId.get(previous.session.id) === previous) {
      this.bySessionId.delete(previous.session.id);
    }
    this.entries.set(entry.filePath, entry);
    this.bySessionId.set(entry.session.id, entry);
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
