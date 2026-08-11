import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeMemoryFileSystem } from '../../src/session/nodeFileSystem';

/**
 * `MemoryFileSystemPort` の既定実装（issue #144）。
 *
 * `readTextFile`（共有の`FileSystemPort`）と違い、ENOENT以外の例外を握り潰さないことと、
 * シンボリックリンクの実体パスを解決できることの2点が肝。実ファイルシステムに対して
 * 検証する（`pseudoWorktree.test.ts` と同じ流儀。tmpdirを使い、テストごとに掃除する）。
 */
describe('nodeMemoryFileSystem', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'memory-fs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('readStrict', () => {
    it('存在するファイルの内容を返す', async () => {
      const filePath = path.join(dir, 'CLAUDE.md');
      await writeFile(filePath, '- 既存のノート\n', 'utf8');

      await expect(nodeMemoryFileSystem.readStrict(filePath)).resolves.toBe('- 既存のノート\n');
    });

    it('ENOENT（存在しない）はundefinedを返す', async () => {
      const filePath = path.join(dir, 'no-such-file.md');

      await expect(nodeMemoryFileSystem.readStrict(filePath)).resolves.toBeUndefined();
    });

    it('ENOENT以外（EISDIR: 同名のディレクトリがある）は投げる（既存ファイルの上書き破壊を防ぐ。issue #144）', async () => {
      const dirPath = path.join(dir, 'CLAUDE.md');
      await mkdir(dirPath);

      await expect(nodeMemoryFileSystem.readStrict(dirPath)).rejects.toThrow();
    });
  });

  /**
   * 戻り値は判別可能ユニオン（`SymlinkResolution`）。「シンボリックリンクでない」と
   * 「シンボリックリンクだが実体パスを特定できない」を`undefined`1種類で表していたのが
   * issue #144レビューのCRITICAL指摘（壊れたリンクが「リンクでない」と誤表示され、
   * 警告なしに任意パスへ書き込まれる）。3つの`kind`をそれぞれ検証する。
   */
  describe('resolveSymlinkTarget', () => {
    it('シンボリックリンクなら { kind: "resolved", target } を返す', async () => {
      const realFile = path.join(dir, 'real-CLAUDE.md');
      await writeFile(realFile, '実体\n', 'utf8');
      const linkPath = path.join(dir, 'CLAUDE.md');
      await symlink(realFile, linkPath);

      await expect(nodeMemoryFileSystem.resolveSymlinkTarget(linkPath)).resolves.toEqual({
        kind: 'resolved',
        target: await realpath(realFile),
      });
    });

    it('通常のファイルなら { kind: "not-symlink" } を返す', async () => {
      const filePath = path.join(dir, 'CLAUDE.md');
      await writeFile(filePath, '実体\n', 'utf8');

      await expect(nodeMemoryFileSystem.resolveSymlinkTarget(filePath)).resolves.toEqual({
        kind: 'not-symlink',
      });
    });

    it('存在しないパスなら { kind: "not-symlink" } を返す（lstat自体が失敗する。リンクの入口すら無い）', async () => {
      const filePath = path.join(dir, 'no-such-file.md');

      await expect(nodeMemoryFileSystem.resolveSymlinkTarget(filePath)).resolves.toEqual({
        kind: 'not-symlink',
      });
    });

    it('リンク先が存在しない壊れたシンボリックリンクは { kind: "unresolved" } を返す（realpathの失敗をnot-symlinkと混同しない。CRITICAL指摘の再発防止）', async () => {
      const linkPath = path.join(dir, 'broken-link.md');
      await symlink(path.join(dir, 'does-not-exist.md'), linkPath);

      await expect(nodeMemoryFileSystem.resolveSymlinkTarget(linkPath)).resolves.toEqual({
        kind: 'unresolved',
      });
    });

    it('循環参照（自分自身を指すリンク）も { kind: "unresolved" } を返す（ELOOP）', async () => {
      const linkPath = path.join(dir, 'circular-link.md');
      await symlink(linkPath, linkPath);

      await expect(nodeMemoryFileSystem.resolveSymlinkTarget(linkPath)).resolves.toEqual({
        kind: 'unresolved',
      });
    });
  });
});
