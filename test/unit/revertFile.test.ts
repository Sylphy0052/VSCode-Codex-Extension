import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeRevertFilePort } from '../../src/util/revertFile';

/**
 * `nodeRevertFilePort` を実ファイルシステムで確かめる（Issue #1170）。
 * 一時ディレクトリの中だけを触る。
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'revert-file-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('nodeRevertFilePort', () => {
  it('identify: 存在すれば dev/ino を返し、無ければ undefined', async () => {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');
    const identity = await nodeRevertFilePort.identify(file);
    expect(identity).toBeDefined();
    expect(await nodeRevertFilePort.identify(path.join(root, 'missing.txt'))).toBeUndefined();
  });

  it('rewrite: 同じ実体なら現在の内容を渡し、返った内容で置き換える', async () => {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'new content that is longer');
    const identity = await nodeRevertFilePort.identify(file);
    if (identity === undefined) {
      throw new Error('identity を取れない');
    }
    const seen: string[] = [];
    const outcome = await nodeRevertFilePort.rewrite(file, identity, (current) => {
      seen.push(current);
      return { ok: true, content: 'old' };
    });
    expect(outcome).toEqual({ kind: 'written' });
    expect(seen).toEqual(['new content that is longer']);
    // 短い内容で置き換えても、元の長い内容の尻尾が残らない（truncate している）
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('rewrite: 判断が断れば何も書かない', async () => {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'keep');
    const identity = await nodeRevertFilePort.identify(file);
    if (identity === undefined) {
      throw new Error('identity を取れない');
    }
    const outcome = await nodeRevertFilePort.rewrite(file, identity, () => ({
      ok: false,
      reason: '内容が違う',
    }));
    expect(outcome).toEqual({ kind: 'aborted', reason: '内容が違う' });
    expect(readFileSync(file, 'utf8')).toBe('keep');
  });

  it('rewrite: 控えたあとに別の実体へ差し替えられていたら changed を返し、書かない', async () => {
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'original');
    const identity = await nodeRevertFilePort.identify(file);
    if (identity === undefined) {
      throw new Error('identity を取れない');
    }
    // 同じパスへ別のファイル（別の inode）を rename で被せる
    const other = path.join(root, 'other.txt');
    writeFileSync(other, 'replacement');
    renameSync(other, file);

    let called = false;
    const outcome = await nodeRevertFilePort.rewrite(file, identity, () => {
      called = true;
      return { ok: true, content: 'must not be written' };
    });
    expect(outcome).toEqual({ kind: 'changed' });
    expect(called).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('replacement');
  });

  it('createNew: 無ければ作り、既にあれば投げて上書きしない', async () => {
    const file = path.join(root, 'gone.txt');
    await nodeRevertFilePort.createNew(file, 'restored');
    expect(readFileSync(file, 'utf8')).toBe('restored');
    await expect(nodeRevertFilePort.createNew(file, 'again')).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('restored');
  });
});
