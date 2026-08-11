import type { ThreadListOutcome } from '../codex/threadList';
import type { SessionMeta } from '../codex/types';

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
  /** ディレクトリを再帰的に走査し、rollout-*.jsonl の絶対パスを返す。 */
  listRollouts(dir: string): Promise<string[]>;
  /** ディレクトリを再帰的に走査し、*.jsonl の絶対パスを返す。 */
  listJsonl(dir: string): Promise<string[]>;
  /** ディレクトリを再帰的に走査し、*.md の絶対パスを返す。 */
  listMarkdown(dir: string): Promise<string[]>;
  /** 先頭 maxLines 行だけを読む。全文をメモリに載せないための専用メソッド。 */
  readHead(filePath: string, maxLines: number): Promise<string[]>;
  /**
   * ファイル全体をbase64で読む。会話に出す画像に使う。
   *
   * `maxBytes` を超えるファイルは読まずに `undefined` を返す。Webviewへ渡す前に
   * 上限で切るのは、巨大な画像でメッセージが詰まるのを防ぐため。
   */
  readBase64File(filePath: string, maxBytes: number): Promise<string | undefined>;
}

/**
 * メモリ追記（入力欄の行頭 `#`、issue #6/#144）専用の読み取り口。
 *
 * 共有の `FileSystemPort.readTextFile` は「読めなければ無い扱い」で他の呼び出し元
 * （`commandCatalog` 等）には正しいが、メモリ追記でこれを使うと、ENOENT以外の理由
 * （EACCES/EBUSY/EISDIR等）で読めなかった場合も「ファイルが無い」と誤認し、追記のつもりで
 * 書いた `- <ノート>\n` だけの本文が既存のCLAUDE.mdを丸ごと上書きしてしまう（issue #144）。
 * 共有ポートの挙動はそのまま（影響範囲が広いため）にし、メモリ追記の経路だけこちらを使う。
 */
export interface MemoryFileSystemPort {
  /** ファイル全体をUTF-8で読む。ENOENT（存在しない）なら `undefined`、それ以外の例外は投げる。 */
  readStrict(filePath: string): Promise<string | undefined>;
  /**
   * `filePath` がシンボリックリンクかどうか、リンクなら実体の絶対パスを解決できたかを判別する
   * （issue #144）。判定・解決のどちらも失敗させず、常に `SymlinkResolution` を返す
   * （追記先の確認自体は失敗させない）。**例外を投げない契約**（呼び出し側が防御的にtry/catchで
   * 包むことを妨げないが、既定実装はここで完結させる）。
   */
  resolveSymlinkTarget(filePath: string): Promise<SymlinkResolution>;
}

/**
 * `MemoryFileSystemPort.resolveSymlinkTarget` の戻り値（issue #144）。
 *
 * 判別可能ユニオンにして「シンボリックリンクでない」と「シンボリックリンクだが実体パスを
 * 特定できない」を区別できるようにする。後者を前者と区別せず `undefined` 1種類で表していたのが
 * 脆弱性だった（壊れたリンク・循環参照・権限不足で`fs.realpath`が失敗すると「リンクでない」
 * ケースと見分けが付かず、確認ダイアログにも会話記録にも警告が出ないまま
 * `vscode.workspace.fs.writeFile` がリンクを追従して任意のパスへ書き込んでいた）。
 */
export type SymlinkResolution =
  | { kind: 'not-symlink' }
  | { kind: 'resolved'; target: string }
  | { kind: 'unresolved' };

/**
 * `thread/list` を叩く口。SessionStoreはこれを介してのみapp-serverを知る
 * （app-serverの起動・JSON-RPC自体はAppServerClientの責務）。
 *
 * `limit` は取得したい件数の上限（`codex.history.maxEntries`）、`archivedSessionsDir` は
 * archived判定に使うディレクトリ（`CodexPaths.archivedSessions`）。
 */
export type ThreadListPort = (
  limit: number,
  archivedSessionsDir: string,
) => Promise<ThreadListOutcome>;

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
