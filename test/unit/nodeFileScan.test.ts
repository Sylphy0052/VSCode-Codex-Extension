import { describe, expect, it } from 'vitest';
import { nodeFileScan } from '../../src/session/nodeFileScan';

/**
 * 走査だけは実物のファイルシステムで確かめる。
 * インメモリのフェイクでは「除外したはずのディレクトリへ入っていた」に気づけない。
 */
const root = process.cwd();

const scan = (options: Partial<{ skipDir(name: string): boolean; limit: number }> = {}) =>
  nodeFileScan.scan(root, {
    skipDir: options.skipDir ?? ((name) => name === '.git' || name === 'node_modules'),
    limit: options.limit ?? 5_000,
  });

describe('nodeFileScan', () => {
  it('ルートからの相対パスを返す', async () => {
    const found = await scan();
    expect(found).toContain('package.json');
    expect(found).toContain('src/extension.ts');
    // 絶対パスにしない（候補としてそのまま入力欄へ入るため）
    expect(found.every((p) => !p.startsWith('/'))).toBe(true);
  });

  it('skipDir が真のディレクトリへ入らない', async () => {
    const found = await scan();
    expect(found.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(found.some((p) => p.startsWith('.git/'))).toBe(false);
  });

  it('上限を超えて集めない', async () => {
    const found = await scan({ limit: 3 });
    expect(found).toHaveLength(3);
  });

  it('無いディレクトリでは空を返す', async () => {
    const found = await nodeFileScan.scan(`${root}/そんなディレクトリは無い`, {
      skipDir: () => false,
      limit: 10,
    });
    expect(found).toEqual([]);
  });

  it('読めないファイルは undefined を返す', async () => {
    expect(await nodeFileScan.readText(`${root}/package.json`)).toContain('"name"');
    expect(await nodeFileScan.readText(`${root}/そんなファイルは無い`)).toBeUndefined();
  });
});
