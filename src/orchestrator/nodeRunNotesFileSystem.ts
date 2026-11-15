import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { ReadTextFileResult, RunNotesFileSystemPort } from './runNotes';

/** ロックを待つ上限。超えたら排他なしで続ける（記録の失敗でrunを止めない）。 */
const LOCK_WAIT_MS = 5_000;
/** この時間より古いロックは、持ち主が落ちて残ったものとみなして取り除く。 */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;

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
  async readTextFile(target: string): Promise<ReadTextFileResult> {
    try {
      const text = await fsPromises.readFile(target, 'utf8');
      return { kind: 'ok', text };
    } catch (e) {
      // 「存在しない（ENOENT）」と「読めない（権限・I/O等）」を呼び出し側が区別できるように
      // する（`runNotes.ts`の`ReadTextFileResult`のJSDoc参照）
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { kind: 'missing' };
      }
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  },
  async withLock<T>(target: string, fn: () => Promise<T>): Promise<T | undefined> {
    const lockDir = `${target}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let acquired = false;
    while (!acquired) {
      try {
        // mkdirは存在すれば失敗するので、プロセス間で原子的な排他になる
        await fsPromises.mkdir(lockDir);
        acquired = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          return undefined;
        }
        try {
          const stat = await fsPromises.stat(lockDir);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            // 持ち主が落ちて残ったロック。取り除いて取り直す
            await fsPromises.rmdir(lockDir);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await fsPromises.rmdir(lockDir).catch(() => undefined);
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
