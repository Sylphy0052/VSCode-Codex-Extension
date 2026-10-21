import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
 * - 書くときはlockfileで他ウィンドウと排他し、ディスク上の最新を読み直して自分の変更だけを
 *   重ね、tmp経由で置き換える（他ウィンドウの変更を巻き戻さない）
 * - 読めないファイル・自分より新しい版のファイルには書かない（全件を消さないため）。
 *   壊れたJSONは`.corrupt-<時刻>`へ退避してから作り直す
 * - 件数が`maxEntries`を超えたら、最後に書いた時刻（`at`）が古いものから捨てる
 */
const SCHEMA_VERSION = 1;
const RELOAD_CHECK_INTERVAL_MS = 1_000;
/** lockを待つ上限と間隔。書込み1回は数msなので、待ち切れないのはlockが残ったときだけ。 */
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 20;
/** この時間より古いlockfileは、書込み中に落ちたウィンドウの残骸とみなして消す。 */
const LOCK_STALE_MS = 10_000;

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

type ParsedFile<T> =
  { kind: 'ok'; entries: Map<string, StoredEntry<T>> } | { kind: 'corrupt' } | { kind: 'newer' };

function parseFile<T>(raw: string, parseValue: ParseValue<T>): ParsedFile<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'corrupt' };
  }
  const file = parsed as Partial<PersistedFile<unknown>>;
  if (typeof file.version === 'number' && file.version > SCHEMA_VERSION) {
    return { kind: 'newer' };
  }
  if (
    file.version !== SCHEMA_VERSION ||
    typeof file.entries !== 'object' ||
    file.entries === null
  ) {
    return { kind: 'corrupt' };
  }
  const entries = new Map<string, StoredEntry<T>>();
  for (const [key, entry] of Object.entries(file.entries)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as unknown as Record<string, unknown>;
    const value = parseValue(record['v']);
    const at = record['at'];
    if (value !== undefined) {
      entries.set(key, { v: value, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
    }
  }
  return { kind: 'ok', entries };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 他ウィンドウ（別プロセス）と排他するlockfile。`wx`で作れた側だけが書く。 */
async function withFileLock<R>(lockPath: string, body: () => Promise<R>): Promise<R> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
      continue; // 確かめる間に相手が外した。すぐ取り直す
    }
    if (Date.now() >= deadline) {
      throw new Error(`lockを取れなかった: ${lockPath}`);
    }
    await delay(LOCK_RETRY_MS);
  }
  try {
    return await body();
  } finally {
    await rm(lockPath, { force: true });
  }
}

let tmpCounter = 0;

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

  async set(key: string, value: T): Promise<void> {
    const stored: StoredEntry<T> = { v: value, at: Date.now() };
    const previous = this.entries.get(key);
    this.pending.set(key, stored);
    this.entries.set(key, stored);
    await this.runPending(key, stored, previous, (disk) => {
      disk.set(key, stored);
    });
  }

  async delete(key: string): Promise<void> {
    const previous = this.entries.get(key);
    this.pending.set(key, null);
    this.entries.delete(key);
    await this.runPending(key, null, previous, (disk) => {
      disk.delete(key);
    });
  }

  /**
   * ファイルに無いキーだけ足す（旧globalStateからの移行用）。
   *
   * `collect`はlockを取ってからもう一度呼ぶ（他ウィンドウの移行が旧キーを消した後なら、
   * 空を返せる。消されたセッションを復活させない）。足した結果が`maxEntries`を超えるときは
   * 書かずに拒否する（呼び出し側は旧キーを消さない）。書込みが済むまでの間も読めるよう、
   * メモリ上には先に足しておく。
   */
  async importMissing(collect: () => Iterable<readonly [string, T]>): Promise<void> {
    for (const [key, value] of collect()) {
      if (!this.entries.has(key)) {
        this.entries.set(key, { v: value, at: 0 });
      }
    }
    await this.enqueue((disk) => {
      for (const [key, value] of collect()) {
        if (!disk.has(key)) {
          disk.set(key, { v: value, at: 0 });
        }
      }
      if (disk.size > this.maxEntries) {
        throw new Error(`移行すると上限${this.maxEntries}件を超える: ${disk.size}件`);
      }
    });
  }

  private async runPending(
    key: string,
    marker: StoredEntry<T> | null,
    previous: StoredEntry<T> | undefined,
    mutate: (disk: Map<string, StoredEntry<T>>) => void,
  ): Promise<void> {
    try {
      await this.enqueue(mutate);
    } catch (error) {
      // 失敗した変更を保存済みのように見せない。後から同じキーへ別の変更が
      // 積まれていなければ、変更前の値へ戻してからディスクの内容を取り込む
      if (this.pending.get(key) === marker) {
        this.pending.delete(key);
        if (previous === undefined) {
          this.entries.delete(key);
        } else {
          this.entries.set(key, previous);
        }
      }
      this.reload();
      throw error;
    }
    if (this.pending.get(key) === marker) {
      this.pending.delete(key);
    }
  }

  private reload(): void {
    this.checkedAt = Date.now();
    if (this.filePath !== undefined) {
      try {
        // 読めた・読めないに関わらずmtimeを覚え、壊れたファイルを毎秒読み直さない
        this.mtimeMs = statSync(this.filePath).mtimeMs;
        const parsed = parseFile(readFileSync(this.filePath, 'utf8'), this.parseValue);
        if (parsed.kind === 'ok') {
          this.entries = parsed.entries;
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          this.entries = new Map();
          this.mtimeMs = -1;
        }
        // 一時的な読取り失敗では、手元のスナップショットを捨てない
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

  /** ディスクの最新を読む。無ければ空。読めない・版が新しいときは書かせないよう投げる。 */
  private async readDisk(filePath: string): Promise<Map<string, StoredEntry<T>>> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    const parsed = parseFile(raw, this.parseValue);
    if (parsed.kind === 'newer') {
      throw new Error(`新しい版の拡張機能が書いたファイルなので書かない: ${filePath}`);
    }
    if (parsed.kind === 'corrupt') {
      await rename(filePath, `${filePath}.corrupt-${Date.now()}`);
      return new Map();
    }
    return parsed.entries;
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
        await mkdir(dirname(filePath), { recursive: true });
        await withFileLock(`${filePath}.lock`, async () => {
          const disk = await this.readDisk(filePath);
          mutate(disk);
          trimOldest(disk, this.maxEntries);
          const payload: PersistedFile<T> = {
            version: SCHEMA_VERSION,
            entries: Object.fromEntries(disk),
          };
          tmpCounter += 1;
          const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
          try {
            await writeFile(tmp, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
            await rename(tmp, filePath);
          } catch (error) {
            await rm(tmp, { force: true });
            throw error;
          }
          // lockを持っている間に取るので、他ウィンドウの書込みとmtimeを取り違えない
          this.mtimeMs = (await stat(filePath)).mtimeMs;
          this.entries = disk;
        });
        this.applyPending(this.entries);
        this.checkedAt = Date.now();
      });
    this.writeChain = run;
    return run;
  }
}
