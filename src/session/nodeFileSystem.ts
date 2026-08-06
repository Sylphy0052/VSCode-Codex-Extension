import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import type { FileSystemPort } from './ports';

/** 1行目だけ読むために全文をメモリに載せない。ロールアウトは巨大になりうる。 */
async function readFirstLine(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
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
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          found.push(full);
        }
      }
    };
    await walk(dir);
    return found;
  },
};
