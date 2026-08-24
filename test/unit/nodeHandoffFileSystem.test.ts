import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeHandoffFileSystem } from '../../src/orchestrator/nodeHandoffFileSystem';

/**
 * `nodeHandoffFileSystem`（実運用で使う唯一の`HandoffFileSystemPort`実装）を、実ファイル
 * システム越しに確かめる（PR #711 自己レビュー指摘: high）。`teamHandoff.test.ts`は
 * インメモリのfakeだけを相手にしているため、Node実装が「例外を投げない」「失敗を
 * `false` / `undefined` / 空配列で表す」という約束を守っているかはこちらで見る。
 */
describe('nodeHandoffFileSystem（design.md §16.44、Issue #693）', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'handoff-fs-test-'));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('作る・書く・読む・並べる・消すが一通り動く', async () => {
    const dir = path.join(tmpRoot, 'happy');
    const target = path.join(dir, 'T1-notes.md');

    expect(await nodeHandoffFileSystem.makeDirectory(dir)).toBe(true);
    expect(await nodeHandoffFileSystem.writeTextFile(target, '本文')).toBe(true);
    expect(await nodeHandoffFileSystem.readTextFile(target)).toBe('本文');
    expect(await nodeHandoffFileSystem.listDirectory(dir)).toEqual(['T1-notes.md']);
    expect(await nodeHandoffFileSystem.removeFile(target)).toBe(true);
    expect(await nodeHandoffFileSystem.readTextFile(target)).toBeUndefined();
    expect(await nodeHandoffFileSystem.removeDirectory(dir)).toBe(true);
  });

  it('既存のファイルは上書きする', async () => {
    const dir = path.join(tmpRoot, 'overwrite');
    const target = path.join(dir, 'T1-notes.md');
    await nodeHandoffFileSystem.makeDirectory(dir);
    await nodeHandoffFileSystem.writeTextFile(target, '1回目');

    expect(await nodeHandoffFileSystem.writeTextFile(target, '2回目')).toBe(true);
    expect(await nodeHandoffFileSystem.readTextFile(target)).toBe('2回目');
  });

  it('存在しないものを読む・並べる・消すのは例外にならない', async () => {
    const missing = path.join(tmpRoot, 'missing', 'nope.md');

    expect(await nodeHandoffFileSystem.readTextFile(missing)).toBeUndefined();
    expect(await nodeHandoffFileSystem.listDirectory(path.join(tmpRoot, 'missing'))).toEqual([]);
    // 「無ければ成功」という流儀（`TeamHandoffStore.remove`のJSDoc）
    expect(await nodeHandoffFileSystem.removeFile(missing)).toBe(true);
    expect(await nodeHandoffFileSystem.removeDirectory(path.join(tmpRoot, 'missing'))).toBe(true);
  });

  it('親が通常ファイルなら、ディレクトリ作成も書き込みもfalseを返す（例外を投げない）', async () => {
    const blocker = path.join(tmpRoot, 'blocker');
    await writeFile(blocker, 'ここはファイル', 'utf8');

    expect(await nodeHandoffFileSystem.makeDirectory(path.join(blocker, 'sub'))).toBe(false);
    expect(await nodeHandoffFileSystem.writeTextFile(path.join(blocker, 'sub', 'x.md'), 'x')).toBe(
      false,
    );
  });

  it('シンボリックリンクを見分ける', async () => {
    const target = path.join(tmpRoot, 'link-target');
    const link = path.join(tmpRoot, 'a-link');
    await nodeHandoffFileSystem.makeDirectory(target);
    let symlinkSupported = true;
    try {
      await symlink(target, link, 'dir');
    } catch {
      // Windowsでは開発者モード/管理者権限が無いと`EPERM`になりうる
      symlinkSupported = false;
    }
    if (!symlinkSupported) {
      return;
    }

    expect(await nodeHandoffFileSystem.isSymbolicLink(link)).toBe(true);
    expect(await nodeHandoffFileSystem.isSymbolicLink(target)).toBe(false);
    // 存在しないパスは「リンクではない」（例外にしない）
    expect(await nodeHandoffFileSystem.isSymbolicLink(path.join(tmpRoot, 'nope'))).toBe(false);
  });

  it('書き込み権限が無いディレクトリへの書き込みはfalseを返す', async () => {
    // rootで走らせると権限チェックが効かないため、その場合は確かめない
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const dir = path.join(tmpRoot, 'readonly');
    await nodeHandoffFileSystem.makeDirectory(dir);
    await chmod(dir, 0o500);
    try {
      expect(await nodeHandoffFileSystem.writeTextFile(path.join(dir, 'x.md'), 'x')).toBe(false);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
