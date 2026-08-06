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
  /** ディレクトリを再帰的に走査し、rollout-*.jsonl の絶対パスを返す。 */
  listRollouts(dir: string): Promise<string[]>;
}

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
