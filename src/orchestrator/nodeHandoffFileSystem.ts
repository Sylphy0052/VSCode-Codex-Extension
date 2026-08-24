import * as fsPromises from 'node:fs/promises';

import type { HandoffFileSystemPort } from './teamHandoff';

/**
 * `HandoffFileSystemPort`（`teamHandoff.ts`）のNode実装（design.md §16.44、Issue #693）。
 *
 * `worktree.ts` の `nodeWorktreeFileSystem` と同じ流儀に揃える: 失敗は例外を投げず
 * `false` / `undefined` / 空配列で表す。書き換える操作（`makeDirectory` /
 * `writeTextFile` / `removeFile` / `removeDirectory`）は成否を`boolean`で返し、
 * `TeamHandoffStore` がそれを `HandoffResult` の `ok: false` に変換する。`teamHandoff.ts` 側（`TeamHandoffStore`）は
 * この関数群が例外を投げないことを前提に書かれており（`readTextFile` が「存在しなければ
 * `undefined`」を返す設計で、try/catchをここへ閉じ込めている）、ここで例外を漏らすと
 * `TeamHandoffStore` の各メソッドが `HandoffResult` の値ではなく例外で失敗するようになり、
 * 呼び出し側（`messaging.ts` の `MessagingMcpServer`）の`safeDispatch`頼みになってしまう
 * （`teamHandoff.ts` 自身のJSDoc「唯一の入口」という前提が崩れる）。
 */
export const nodeHandoffFileSystem: HandoffFileSystemPort = {
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
  async writeTextFile(target: string, content: string): Promise<boolean> {
    try {
      await fsPromises.writeFile(target, content, 'utf8');
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
  async listDirectory(target: string): Promise<string[]> {
    try {
      return await fsPromises.readdir(target);
    } catch {
      return [];
    }
  },
  async removeFile(target: string): Promise<boolean> {
    // `remove`は「無ければ成功」という流儀（`teamHandoff.ts`の`TeamHandoffStore.remove`
    // JSDoc参照）のため、`force: true`で存在しない場合を吸収する。それ以外の失敗
    // （権限等）は`false`として呼び出し側へ伝える。
    try {
      await fsPromises.rm(target, { force: true });
      return true;
    } catch {
      return false;
    }
  },
  async removeDirectory(target: string): Promise<boolean> {
    try {
      await fsPromises.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  },
};
