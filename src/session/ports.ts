import type { ThreadListOutcome, ThreadListPageConsumer } from '../codex/threadList';
import type { SessionMeta } from '../codex/types';

/**
 * ファイル先頭の、素性を読み終えた範囲（Issue #1466）。`bytes` は範囲のバイト数、
 * `sha256` はその範囲の内容のSHA-256（16進）。
 */
export interface HeadDigest {
  bytes: number;
  sha256: string;
}

/**
 * ファイルアクセスの抽象。実体は node:fs だが、テストではインメモリ実装に差し替える。
 * VSCode APIには依存させない（unit testを軽く保つため）。
 */
export interface FileSystemPort {
  /** ファイル全体をUTF-8で読む。存在しなければ undefined。 */
  readTextFile(filePath: string): Promise<string | undefined>;
  /** 1行目だけを読む。全文読み込みを避けるための専用メソッド。 */
  readFirstLine(filePath: string): Promise<string | undefined>;
  /** 末尾の最大 maxBytes 分だけを読む。先頭が欠けた行を含みうる。 */
  readTail(filePath: string, maxBytes: number): Promise<string | undefined>;
  /** 最終更新時刻（ミリ秒）。読めなければ undefined。 */
  mtimeMs(filePath: string): Promise<number | undefined>;
  /**
   * 更新時刻・サイズ・inode番号をまとめて返す（Issue #1460）。
   *
   * `mtimeMs` 単体と同じ `fs.stat` 呼び出しで取れるため追加コストは無い。Claude Codeの
   * 索引がtranscriptへの通常の追記（サイズ増加・inode不変）を検出し、先頭の読み直し
   * （`readHeadMeta`）を省くために使う。
   *
   * 任意実装。持たないポート（テストのフェイク等）では `mtimeMs` へ退避し、
   * 常に先頭を読み直す（安全側）。
   */
  statLite?(filePath: string): Promise<{ mtimeMs: number; size: number; ino: number } | undefined>;
  /** ディレクトリを再帰的に走査し、rollout-*.jsonl の絶対パスを返す。 */
  listRollouts(dir: string): Promise<string[]>;
  /** ディレクトリを再帰的に走査し、*.jsonl の絶対パスを返す。 */
  listJsonl(dir: string): Promise<string[]>;
  /** ディレクトリを再帰的に走査し、*.md の絶対パスを返す。 */
  listMarkdown(dir: string): Promise<string[]>;
  /** 先頭 maxLines 行だけを読む。全文をメモリに載せないための専用メソッド。 */
  readHead(filePath: string, maxLines: number): Promise<string[]>;
  /**
   * 直下のサブディレクトリ名だけを返す（Issue #885）。
   *
   * Claude Codeのtranscriptは `projects/<cwd-slug>/<sessionId>.jsonl` に置かれ、
   * slugはcwdの英数字以外を `-` へ置換したものになる。ワークスペース絞り込みのとき、
   * ファイルを開かずに候補ディレクトリを削るために使う。
   *
   * 任意実装。持たないポート（テストのフェイク等）では全走査へ退避する。
   */
  listSubdirectories?(dir: string): Promise<string[]>;
  /**
   * 先頭を読むが、`isComplete` が true を返した行、`maxLines` 行、累積 `maxBytes` の
   * いずれか早い方で打ち切る（Issue #885）。
   *
   * Claude Codeのtranscriptは1行にtool_resultを丸ごと積むため1行が巨大になりうる。
   * 素性（cwd・sessionId・最初の発言）が揃った時点で読むのをやめるために使う。
   *
   * 任意実装。持たないポートでは `readHead` へ退避する。
   */
  readHeadUntil?(
    filePath: string,
    maxLines: number,
    maxBytes: number,
    isComplete: (line: string) => boolean,
  ): Promise<string[]>;
  /**
   * `readHeadUntil` と同じ条件で先頭を読み、読んだ範囲のバイト数とSHA-256を返す
   * （Issue #1466）。
   *
   * 範囲が確定しない（打ち切り条件に当たる前にファイル末尾へ達した・読み込みに
   * 失敗した）ときは `undefined` を返す。末尾まで読んだ範囲は、その後の追記で
   * 先頭の素性が揃う可能性があるため、照合の基準にしない。
   *
   * 任意実装。持たないポートでは `readHeadUntil` へ退避し、先頭の読み直しを省かない。
   */
  readHeadDigestUntil?(
    filePath: string,
    maxLines: number,
    maxBytes: number,
    isComplete: (line: string) => boolean,
  ): Promise<HeadDigest | undefined>;
  /**
   * 先頭 `bytes` バイトのSHA-256を返す（Issue #1466）。ファイルが `bytes` より短い・
   * 読めないときは `undefined`。`readHeadDigestUntil` が返した範囲の照合に使う。
   */
  digestHead?(filePath: string, bytes: number): Promise<string | undefined>;
  /**
   * ファイル全体をbase64で読む。会話に出す画像に使う。
   *
   * `maxBytes` を超えるファイルは読まずに `undefined` を返す。Webviewへ渡す前に
   * 上限で切るのは、巨大な画像でメッセージが詰まるのを防ぐため。
   */
  readBase64File(filePath: string, maxBytes: number): Promise<string | undefined>;
  /**
   * 1行ずつ読み、`onLine` へ渡す。全文を一度にメモリへ載せないための専用メソッド
   * （issue #1325）。ファイルが読めなければ `false`（呼び出し側は `readTextFile` が
   * `undefined` を返す場合と同じに扱ってよい。読めなかった理由が変わらない限り、
   * 読み直しても同じ結果になるため再試行しない）。
   *
   * 任意実装。**メソッド自体を持たない**ポート（テストのフェイク等）でのみ
   * `readTextFile` へ退避する。実行した上で `false` が返った場合の退避は含まない。
   */
  forEachLine?(filePath: string, onLine: (line: string) => void): Promise<boolean>;
}

/**
 * `thread/list` を叩く口。SessionStoreはこれを介してのみapp-serverを知る
 * （app-serverの起動・JSON-RPC自体はAppServerClientの責務）。
 *
 * `limit` は1回に取得する件数、`archivedSessionsDir` はarchived判定に使うディレクトリ
 * （`CodexPaths.archivedSessions`）。`consumePage`があれば同じプロセスで後続を読む。
 */
export type ThreadListPort = (
  limit: number,
  archivedSessionsDir: string,
  consumePage?: ThreadListPageConsumer,
) => Promise<ThreadListOutcome>;

/** `thread/list`で名前が空だったスレッドだけへ、導出した名前を保存する口。 */
export type ThreadNameSetterPort = (threadId: string, name: string) => Promise<boolean>;

/** session_meta の永続キャッシュ。1行目は不変なので無効化はエントリ削除のみ。 */
export interface MetaCachePort {
  get(sessionId: string): SessionMeta | undefined;
  set(sessionId: string, meta: SessionMeta): void;
  delete(sessionId: string): void;
  keys(): string[];
}

export class InMemoryMetaCache implements MetaCachePort {
  private readonly map = new Map<string, SessionMeta>();

  constructor(initial: Record<string, SessionMeta> = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.map.set(k, v);
    }
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.map.get(sessionId);
  }

  set(sessionId: string, meta: SessionMeta): void {
    this.map.set(sessionId, meta);
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  toRecord(): Record<string, SessionMeta> {
    return Object.fromEntries(this.map);
  }
}
