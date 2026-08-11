import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import type { FileSystemPort } from './ports';

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
};
