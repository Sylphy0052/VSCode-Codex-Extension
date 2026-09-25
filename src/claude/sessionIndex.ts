import type { SessionSummary } from '../codex/types';
import type { MementoLike } from '../util/memento';
import {
  migrateLegacyIndex,
  readSessionIndexFileSync,
  writeSessionIndexFile,
} from './sessionIndexFile';

/** 旧globalStateキー（Issue #1460で廃止。移行のためだけに残す）。 */
export const CLAUDE_SESSION_INDEX_KEY = 'claude.sessionIndex';

/**
 * 永続化するエントリ数の上限（Issue #885）。
 *
 * 表示上限（`codex.history.maxEntries` の既定は200）から見て十分に余裕のある数で
 * 頭を打つ。ここで落ちた古いエントリは、次に走査したとき読み直される（一覧からは消えない）。
 */
export const CLAUDE_SESSION_INDEX_MAX_PERSISTED = 2_000;

/** `requestPersist()` を間引く間隔（Issue #1460）。最後の変更からこの時間だけ書き込みを待つ。 */
const PERSIST_DEBOUNCE_MS = 10_000;

export interface ClaudeSessionIndexEntry {
  filePath: string;
  mtimeMs: number | undefined;
  /**
   * ファイルサイズ（Issue #1460）。`statLite` を持たないポートで作ったエントリ・
   * 旧schemaから移行したエントリでは `undefined`。`undefined` のエントリへの追記は
   * 先頭の読み直しを省けない（`ClaudeSessionStore.canSkipHeadRead` が安全側にフォールバックする）。
   */
  size: number | undefined;
  /** inode番号（Issue #1460）。同じパスのファイル置き換えを検出するために使う。 */
  ino: number | undefined;
  session: SessionSummary;
}

const noopMemento: MementoLike = {
  get: (_key, defaultValue) => defaultValue,
  update: () => Promise.resolve(),
};

/**
 * Claude Codeのセッション索引（Issue #1460）。
 *
 * 保存先は `context.globalStorageUri` 配下のファイル（ウィンドウ間で配信されない）。
 * 各ウィンドウはメモリ上のスナップショットを持ち、書くときは差分ではなく全量をtmp経由で
 * 置き換える（`writeSessionIndexFile`）。読むのは起動時（コンストラクタ）だけで、
 * リーダー選出や単一writerの調停は入れない。複数ウィンドウが同時に書いても、最後に
 * `rename` した内容が残るだけで壊れない（取りこぼした変更は、次の変更か次回起動時の
 * 照合で戻る。索引はtranscriptから作り直せるキャッシュのため許容する）。
 *
 * 旧 `globalState`（`CLAUDE_SESSION_INDEX_KEY`）からの移行は起動を止めずバックグラウンドで
 * 行う。ファイルが既にあればそちらを正として使う。ファイルが無いときだけ旧キーを暫定の
 * 初期値として使い（移行が終わるまで一覧を空にしないため）、移行を1回走らせる。
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
  private persistTimer: NodeJS.Timeout | undefined;
  /** `flush` すべき変更があるか。デバウンス中の予約と、失敗後の再試行判定に使う。 */
  private dirty = false;

  constructor(
    /** 索引ファイルの絶対パス。`undefined` ならファイル永続化をしない（テスト等）。 */
    private readonly filePath: string | undefined = undefined,
    legacyMemento: MementoLike = noopMemento,
  ) {
    const fromFile = filePath !== undefined ? readSessionIndexFileSync(filePath) : [];
    if (fromFile.length > 0) {
      for (const entry of fromFile) {
        this.remember(entry);
      }
    } else {
      for (const entry of legacyMemento.get<ClaudeSessionIndexEntry[]>(CLAUDE_SESSION_INDEX_KEY, [])) {
        if (entry.filePath !== '' && entry.session.provider === 'claude') {
          this.remember(entry);
        }
      }
      if (filePath !== undefined) {
        // 起動をブロックしない。失敗しても次回起動の照合でやり直せる（キャッシュのため）
        void migrateLegacyIndex(filePath, legacyMemento).catch(() => undefined);
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

  /**
   * 保存を予約する（Issue #1460）。最後の呼び出しから `PERSIST_DEBOUNCE_MS` 後に1回だけ
   * 書く。連続する追記1回ごとには書かない。タイマーは `unref` し、プロセス終了を妨げない
   * （書き出せずに終わっても、次回起動時の照合で復元される）。
   */
  requestPersist(): void {
    this.dirty = true;
    if (this.filePath === undefined) {
      return;
    }
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /**
   * 直ちに書く。`deactivate` からの最適化用の呼び出しを想定する（あくまで最適化であり、
   * 失敗しても次回起動時の照合で回復できるため、ここでの例外は投げずに握りつぶす）。
   */
  async flush(): Promise<void> {
    if (this.filePath === undefined || !this.dirty) {
      return;
    }
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    // 新しいものから順に上限まで残す。mtimeが読めなかったものは最後に回す
    const ordered = this.all().sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    try {
      await writeSessionIndexFile(
        this.filePath,
        ordered.slice(0, CLAUDE_SESSION_INDEX_MAX_PERSISTED),
      );
      this.dirty = false;
    } catch {
      // 書けなくても次回起動時の照合で復元できる（キャッシュのため）。ここでは投げない
    }
  }
}
