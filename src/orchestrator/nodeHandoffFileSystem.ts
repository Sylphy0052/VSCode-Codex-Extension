import * as fsPromises from 'node:fs/promises';

import type { HandoffFileSystemPort } from './teamHandoff';

/**
 * `HandoffFileSystemPort`（`teamHandoff.ts`）のNode実装（design.md §16.44、Issue #693）。
 *
 * `worktree.ts` の `nodeWorktreeFileSystem` と同じ流儀に揃える: 失敗は例外を投げず
 * `undefined` / `false` / 空配列で表す。`teamHandoff.ts` 側（`TeamHandoffStore`）は
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
  async makeDirectory(target: string): Promise<void> {
    try {
      await fsPromises.mkdir(target, { recursive: true });
    } catch {
      // 呼び出し側（`TeamHandoffStore.write`）は直後の`writeTextFile`の失敗で
      // 実質的なエラーに気付ける。ここで例外を投げると`worktree.ts`と流儀が揃わなくなる。
    }
  },
  async writeTextFile(target: string, content: string): Promise<void> {
    try {
      await fsPromises.writeFile(target, content, 'utf8');
    } catch {
      // 同上。書き込み失敗を呼び出し側へ伝える手段が無いのは`HandoffFileSystemPort`の
      // インターフェース自体の制約（`Promise<void>`）で、`teamHandoff.ts`を編集できない
      // 制約上ここでは変えられない。実運用ではまれ（`.agents/handoff/runs/`配下は
      // このプロセス自身が作るディレクトリで、権限・容量の問題以外では失敗しにくい）。
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
  async removeFile(target: string): Promise<void> {
    try {
      await fsPromises.rm(target, { force: true });
    } catch {
      // `remove`は「無ければ成功」という流儀（`teamHandoff.ts`の`TeamHandoffStore.remove`
      // JSDoc参照）のため、`force: true`で存在しない場合を吸収したうえで、それ以外の
      // 失敗（権限等）も黙って収める。`worktree.ts`には対応物が無い新規の操作だが、
      // 「例外を外へ投げない」という同じ流儀は保つ。
    }
  },
  async removeDirectory(target: string): Promise<void> {
    try {
      await fsPromises.rm(target, { recursive: true, force: true });
    } catch {
      // 同上。
    }
  },
};
