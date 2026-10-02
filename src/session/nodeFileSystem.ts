import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import type { FileSystemPort, HeadDigest, MemoryFileSystemPort, SymlinkResolution } from './ports';

/** Node.jsの例外がENOENT（対象が存在しない）かどうかを見る。 */
function isEnoent(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 先頭だけ読むために全文をメモリに載せない。ロールアウトは巨大になりうる。 */
async function readHead(filePath: string, maxLines: number): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      lines.push(line);
      if (lines.length >= maxLines) {
        break;
      }
    }
    return lines;
  } catch {
    return lines;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  return (await readHead(filePath, 1))[0];
}

/**
 * `readHead` の打ち切り付き版（Issue #885）。
 *
 * `isComplete` が true を返した行で読むのをやめる。行の切り出しは readline に任せる
 * ため1行が巨大な場合はその行までは読み切るが、累積が `maxBytes` を超えた時点で次の
 * 行へは進まない。累積は文字数で数える（UTF-8のバイト数とは厳密には一致しないが、
 * 目的は青天井の読み込みを止めることなので概算で足りる）。
 */
async function readHeadUntil(
  filePath: string,
  maxLines: number,
  maxBytes: number,
  isComplete: (line: string) => boolean,
): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let bytes = 0;
  try {
    for await (const line of rl) {
      lines.push(line);
      bytes += line.length;
      if (isComplete(line) || lines.length >= maxLines || bytes >= maxBytes) {
        break;
      }
    }
    return lines;
  } catch {
    return lines;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 改行を除いた1行の文字列にする。readline（`crlfDelay: Infinity`）と同じく `\r\n` も1つの改行とみなす。 */
function decodeLine(raw: Buffer): string {
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && raw[end - 1] === 0x0d) {
    end -= 1;
  }
  return raw.toString('utf8', 0, end);
}

/**
 * `readHeadUntil` と同じ打ち切り条件で先頭を読み、読んだ範囲のバイト数とSHA-256を返す
 * （Issue #1466）。
 *
 * readlineは改行を落とすため元のバイト位置が分からない。範囲を正確に照合できるよう、
 * バイト列のまま `\n` で区切って読む。打ち切り条件に当たる前に末尾へ達したときは
 * `undefined`（範囲が確定していない）。末尾の改行の無い行も `isComplete` には渡す。
 *
 * readlineと違い、単独の `\r` は行区切りとみなさない。JSONLは値の中の改行を
 * エスケープするため、行の途中に生の `\r` は現れない前提とする。
 */
async function readHeadDigestUntil(
  filePath: string,
  maxLines: number,
  maxBytes: number,
  isComplete: (line: string) => boolean,
): Promise<HeadDigest | undefined> {
  const stream = createReadStream(filePath);
  const hash = createHash('sha256');
  let pending: Buffer[] = [];
  let lines = 0;
  let bytes = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) {
          pending.push(chunk.subarray(start));
          break;
        }
        pending.push(chunk.subarray(start, newline + 1));
        start = newline + 1;
        const raw = Buffer.concat(pending);
        pending = [];
        hash.update(raw);
        bytes += raw.length;
        lines += 1;
        if (isComplete(decodeLine(raw)) || lines >= maxLines || bytes >= maxBytes) {
          return { bytes, sha256: hash.digest('hex') };
        }
      }
    }
    if (pending.length > 0) {
      // readHeadUntilと同じく末尾の改行の無い行も素性の解釈には含める。書きかけの行の
      // 可能性があるため、isCompleteがtrueを返しても範囲は確定させない
      isComplete(decodeLine(Buffer.concat(pending)));
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    stream.destroy();
  }
}

/**
 * 先頭 `bytes` バイトのSHA-256（Issue #1466）。ファイルがそれより短い・読めなければ `undefined`。
 *
 * `bytes`は索引ファイルから来た値で上限を検証していない（Issue #1648）。読む前に
 * 実ファイルのサイズと比べ、足りなければ読まずに`undefined`を返す。壊れた・改ざんされた
 * `bytes`で実ファイルが短いケースの無駄な読み込みを避けるだけで、`bytes`と実ファイルが
 * 両方巨大なケースは変わらず読む（打ち切る根拠が無いため）。
 */
async function digestHead(filePath: string, bytes: number): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (stat.size < bytes) {
      return undefined;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(bytes, 64 * 1024));
    let offset = 0;
    while (offset < bytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, bytes - offset),
        offset,
      );
      if (bytesRead === 0) {
        return undefined;
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** 全文を一度にメモリへ載せず、1行ずつ `onLine` へ渡す（issue #1325）。 */
async function forEachLine(filePath: string, onLine: (line: string) => void): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      onLine(line);
    }
    return true;
  } catch {
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 拡張子で絞ってディレクトリを再帰的に走査する。 */
async function walkFiles(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (accept(entry.name)) {
        found.push(full);
      }
    }
  };
  await walk(dir);
  return found;
}

export const nodeFileSystem: FileSystemPort = {
  async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },

  readFirstLine,

  readHead,

  async readBase64File(filePath: string, maxBytes: number): Promise<string | undefined> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > maxBytes) {
        return undefined;
      }
      return (await fs.readFile(filePath)).toString('base64');
    } catch {
      return undefined;
    }
  },

  async readTail(filePath: string, maxBytes: number): Promise<string | undefined> {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, size - length));
      return buffer.toString('utf8');
    } catch {
      return undefined;
    } finally {
      await handle?.close();
    }
  },

  async mtimeMs(filePath: string): Promise<number | undefined> {
    try {
      return (await fs.stat(filePath)).mtimeMs;
    } catch {
      return undefined;
    }
  },

  async statLite(
    filePath: string,
  ): Promise<{ mtimeMs: number; size: number; ino: number } | undefined> {
    try {
      const stat = await fs.stat(filePath);
      return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return undefined;
    }
  },

  async listRollouts(dir: string): Promise<string[]> {
    return walkFiles(dir, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
  },

  async listJsonl(dir: string): Promise<string[]> {
    return walkFiles(dir, (name) => name.endsWith('.jsonl'));
  },

  async listMarkdown(dir: string): Promise<string[]> {
    return walkFiles(dir, (name) => name.endsWith('.md'));
  },

  async listSubdirectories(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },

  readHeadUntil,
  readHeadDigestUntil,
  digestHead,
  forEachLine,
};

/** `MemoryFileSystemPort` の既定実装（issue #144。`nodeFileSystem` とは意図的に分ける）。 */
export const nodeMemoryFileSystem: MemoryFileSystemPort = {
  async readStrict(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (isEnoent(e)) {
        return undefined;
      }
      throw e;
    }
  },

  async resolveSymlinkTarget(filePath: string): Promise<SymlinkResolution> {
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      // 対象自体が無い（シンボリックリンクの入口すら存在しない）。「リンクでない」で正しい。
      return { kind: 'not-symlink' };
    }
    if (!stat.isSymbolicLink()) {
      return { kind: 'not-symlink' };
    }
    try {
      return { kind: 'resolved', target: await fs.realpath(filePath) };
    } catch {
      // リンク先が存在しない（壊れたリンク）・循環参照（ELOOP）・途中ディレクトリの権限不足
      // （EACCES）等。「リンクでない」と混同しない（issue #144のCRITICAL指摘）。
      return { kind: 'unresolved' };
    }
  },
};
