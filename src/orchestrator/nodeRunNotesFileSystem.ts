import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { RunNotesFileSystemPort } from './runNotes';

/**
 * `RunNotesFileSystemPort`（`runNotes.ts`、Issue #1599）のNode実装。
 *
 * `nodeHandoffFileSystem.ts`と同じ流儀: 失敗は例外を投げず`false`/`undefined`で表す。
 * `appendLine`は`nodeAppender.ts`と同じ「1回のappendFile呼び出し」の作法を守る。
 * `replaceTextFile`だけは一時ファイルへ書いてから`rename`する（`roadmap.ts`の
 * `writeTextFile`と同じ理由。削除・上限整理の書き直し中に拡張機能ホストが落ちても、
 * 確定前の内容で本体ファイルを壊さないようにする）。
 */
export const nodeRunNotesFileSystem: RunNotesFileSystemPort = {
  async isSymbolicLink(target: string): Promise<boolean> {
    try {
      const stat = await fsPromises.lstat(target);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
  async makeDirectory(target: string): Promise<boolean> {
    try {
      await fsPromises.mkdir(target, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
  async appendLine(target: string, line: string): Promise<boolean> {
    try {
      await fsPromises.appendFile(target, line, 'utf8');
      return true;
    } catch {
      return false;
    }
  },
  async readTextFile(target: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  },
  async replaceTextFile(target: string, content: string): Promise<boolean> {
    const dir = path.dirname(target);
    const tempPath = path.join(dir, `.run-notes-${randomUUID()}.tmp`);
    try {
      await fsPromises.writeFile(tempPath, content, 'utf8');
      await fsPromises.rename(tempPath, target);
      return true;
    } catch {
      await fsPromises.rm(tempPath, { force: true });
      return false;
    }
  },
};
