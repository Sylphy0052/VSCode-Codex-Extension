import * as fs from 'node:fs/promises';
import type { FileScanPort } from '../provider/fileMentions';

/**
 * `@` の候補を集めるための走査。
 *
 * シンボリックリンクは辿らない（`isDirectory` / `isFile` はリンク自身を見るため、
 * リンクは自然に候補から外れる）。循環したツリーで止まらなくなるのを避ける。
 */
export const nodeFileScan: FileScanPort = {
  async scan(
    dir: string,
    options: { skipDir(name: string): boolean; limit: number },
  ): Promise<string[]> {
    const found: string[] = [];

    const walk = async (current: string, prefix: string): Promise<void> => {
      if (found.length >= options.limit) {
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= options.limit) {
          return;
        }
        const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (options.skipDir(entry.name)) {
            continue;
          }
          await walk(`${current}/${entry.name}`, relPath);
        } else if (entry.isFile()) {
          found.push(relPath);
        }
      }
    };

    await walk(dir, '');
    return found;
  },

  async readText(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },
};
