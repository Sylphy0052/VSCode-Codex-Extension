import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * `globalState`の代わりに`globalStorageUri`配下のファイルへ持つ、キー付きの小さな状態（Issue #2006）。
 *
 * `globalState`は拡張機能1つ分を1つのJSONとして保存し、どのキーを更新しても全体を書き出して
 * 全ウィンドウへ配信する。セッション数に比例して増える値（セッション名・モデル設定）は
 * ここへ逃がす。
 *
 * - 読むのはメモリ上のスナップショット。他ウィンドウの書込みは、前回確認から
 *   `RELOAD_CHECK_INTERVAL_MS`以上経った`get`で、ファイルのmtimeを見て取り込む
 * - 書くときはディスク上の最新を読み直し、自分の変更だけを重ねてtmp経由で置き換える
 *   （他ウィンドウが足したキーを巻き戻さない）
 * - 件数が`maxEntries`を超えたら、最後に書いた時刻（`at`）が古いものから捨てる
 */
const SCHEMA_VERSION = 1;
const RELOAD_CHECK_INTERVAL_MS = 1_000;

interface StoredEntry<T> {
  v: T;
  /** 最後に書いた時刻（epoch ms）。旧globalStateから移したものは0。 */
  at: number;
}

interface PersistedFile<T> {
  version: number;
  entries: Record<string, StoredEntry<T>>;
}

type ParseValue<T> = (value: unknown) => T | undefined;

function parseFile<T>(raw: string, parseValue: ParseValue<T>): Map<string, StoredEntry<T>> {
  const result = new Map<string, StoredEntry<T>>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return result;
    }
    const file = parsed as Partial<PersistedFile<unknown>>;
    if (
      file.version !== SCHEMA_VERSION ||
      typeof file.entries !== 'object' ||
      file.entries === null
    ) {
      return result;
    }
    for (const [key, entry] of Object.entries(file.entries)) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const record = entry as unknown as Record<string, unknown>;
      const value = parseValue(record['v']);
      const at = record['at'];
      if (value !== undefined) {
        result.set(key, { v: value, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
      }
    }
  } catch {
    // 壊れたファイルは空として扱い、次の書込みで作り直す
  }
  return result;
}

function trimOldest<T>(entries: Map<string, StoredEntry<T>>, maxEntries: number): void {
  const excess = entries.size - maxEntries;
  if (excess <= 0) {
    return;
  }
  // 同時刻は挿入順を保つ（安定ソート）。先頭から捨てる
  const oldest = [...entries.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, excess);
  for (const [key] of oldest) {
    entries.delete(key);
  }
}

export class KeyedStateFile<T> {
  private entries = new Map<string, StoredEntry<T>>();
  /** まだファイルへ書き終えていない自分の変更。`null`は削除。再読込で巻き戻さないために重ねる。 */
  private readonly pending = new Map<string, StoredEntry<T> | null>();
  private writeChain: Promise<void> = Promise.resolve();
  private mtimeMs = -1;
  private checkedAt = 0;

  constructor(
    private readonly filePath: string | undefined,
    private readonly parseValue: ParseValue<T>,
    private readonly maxEntries: number,
  ) {
    this.reload();
  }

  get(key: string): T | undefined {
    this.refreshIfChanged();
    return this.entries.get(key)?.v;
  }

  has(key: string): boolean {
    this.refreshIfChanged();
    return this.entries.has(key);
  }

  size(): number {
    return this.entries.size;
  }

  async set(key: string, value: T): Promise<void> {
    const stored: StoredEntry<T> = { v: value, at: Date.now() };
    this.pending.set(key, stored);
    this.entries.set(key, stored);
    await this.enqueue((disk) => {
      disk.set(key, stored);
    });
    if (this.pending.get(key) === stored) {
      this.pending.delete(key);
    }
  }

  async delete(key: string): Promise<void> {
    this.pending.set(key, null);
    this.entries.delete(key);
    await this.enqueue((disk) => {
      disk.delete(key);
    });
    if (this.pending.get(key) === null) {
      this.pending.delete(key);
    }
  }

  /** ファイルに無いキーだけ足す（旧globalStateからの移行用）。書込みに失敗したら拒否する。 */
  async importMissing(items: Iterable<readonly [string, T]>): Promise<void> {
    const list = [...items];
    await this.enqueue((disk) => {
      for (const [key, value] of list) {
        if (!disk.has(key)) {
          disk.set(key, { v: value, at: 0 });
        }
      }
    });
  }

  private reload(): void {
    this.checkedAt = Date.now();
    if (this.filePath !== undefined) {
      try {
        const mtimeMs = statSync(this.filePath).mtimeMs;
        this.entries = parseFile(readFileSync(this.filePath, 'utf8'), this.parseValue);
        this.mtimeMs = mtimeMs;
      } catch {
        this.entries = new Map();
        this.mtimeMs = -1;
      }
    }
    this.applyPending(this.entries);
  }

  private refreshIfChanged(): void {
    if (this.filePath === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.checkedAt < RELOAD_CHECK_INTERVAL_MS) {
      return;
    }
    this.checkedAt = now;
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      // 無いファイルは-1のまま
    }
    if (mtimeMs !== this.mtimeMs) {
      this.reload();
    }
  }

  private applyPending(target: Map<string, StoredEntry<T>>): void {
    for (const [key, entry] of this.pending) {
      if (entry === null) {
        target.delete(key);
      } else {
        target.set(key, entry);
      }
    }
  }

  private enqueue(mutate: (disk: Map<string, StoredEntry<T>>) => void): Promise<void> {
    const filePath = this.filePath;
    if (filePath === undefined) {
      return Promise.resolve();
    }
    const run = this.writeChain
      // 1回の保存失敗で、その後の変更まで永久に止めない
      .catch(() => undefined)
      .then(async () => {
        let disk = new Map<string, StoredEntry<T>>();
        try {
          disk = parseFile(await readFile(filePath, 'utf8'), this.parseValue);
        } catch {
          // 無い・読めないときは空から作る
        }
        mutate(disk);
        trimOldest(disk, this.maxEntries);
        const payload: PersistedFile<T> = {
          version: SCHEMA_VERSION,
          entries: Object.fromEntries(disk),
        };
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify(payload), 'utf8');
        await rename(tmp, filePath);
        this.entries = disk;
        this.applyPending(this.entries);
        try {
          this.mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          this.mtimeMs = -1;
        }
        this.checkedAt = Date.now();
      });
    this.writeChain = run;
    return run;
  }
}
