import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import type { FileSystemPort, MemoryFileSystemPort, SymlinkResolution } from './ports';

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
