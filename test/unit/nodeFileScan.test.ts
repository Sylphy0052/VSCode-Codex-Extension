import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeFileScan } from '../../src/session/nodeFileScan';

/**
 * 走査だけは実物のファイルシステムで確かめる。
 * インメモリのフェイクでは「除外したはずのディレクトリへ入っていた」に気づけない。
 *
 * 走査対象はリポジトリルートではなく一時ディレクトリに作った既知の構造にする。
 * リポジトリルートを対象にすると、開発機の作業ツリーに未追跡の大量ファイル
 * （例: 統合テストが .vscode-test/ 配下へ展開するVSCode本体）が存在するだけで
 * 走査が上限へ達し、本来到達するはずのファイルへ届かず失敗する。
 * これは「作業ツリーの状態」というテストの意図と無関係な要因に結果が
 * 左右されてしまうため、一時ディレクトリへ隔離する。
 */

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'node-file-scan-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(root, '.git', 'objects'), { recursive: true });

  await writeFile(join(root, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(root, 'README.md'), '# fixture');
  await writeFile(join(root, 'src', 'extension.ts'), '// fixture');
  await writeFile(join(root, 'src', 'other.ts'), '// fixture');
  await writeFile(join(root, 'docs', 'guide.md'), '# guide');
  // skipDir が効かない限りここへは到達しないはずのファイル。
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), '// dep');
  await writeFile(join(root, '.git', 'objects', 'pack'), 'binary');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const scan = (options: Partial<{ skipDir(name: string): boolean; limit: number }> = {}) =>
  nodeFileScan.scan(root, {
    skipDir: options.skipDir ?? ((name) => name === '.git' || name === 'node_modules'),
    limit: options.limit ?? 5_000,
  });

/**
 * `toContain` だけだと、上限に達して探索が打ち切られた場合も
 * 「単に見つからなかった」ときと同じ失敗メッセージになり区別できない。
 * 上限に達している場合はその旨を明示したメッセージで失敗させる。
 */
const expectContains = (found: string[], path: string, limit: number) => {
  if (found.length >= limit && !found.includes(path)) {
    throw new Error(
      `走査が上限（${limit}件）に達したため打ち切られ、'${path}' が含まれるかを判定できません。実際の件数: ${found.length}`,
    );
  }
  expect(found).toContain(path);
};

describe('nodeFileScan', () => {
  it('ルートからの相対パスを返す', async () => {
    const limit = 5_000;
    const found = await scan({ limit });
    expectContains(found, 'package.json', limit);
    expectContains(found, 'src/extension.ts', limit);
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
