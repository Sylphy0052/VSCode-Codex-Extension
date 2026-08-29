import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmptyReviewBundle,
  createReviewBundle,
  removeStaleReviewBundles,
  REVIEW_BUNDLE_PREFIX,
} from '../../src/secondOpinion/reviewBundle';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';

/** `git show <base>:<path>` にだけ答えるフェイク。未登録のパスは「ベースに無い」扱い。 */
function fakeShow(contents: Record<string, string>): GitCommandRunner {
  return {
    async run(args): Promise<GitCommandResult> {
      const spec = args[1] ?? '';
      const content = contents[spec];
      if (args[0] !== 'show' || content === undefined) {
        return { code: 128, stdout: '', stderr: 'not found' };
      }
      return { code: 0, stdout: content, stderr: '' };
    },
  };
}

describe('createReviewBundle（Issue #926 E）', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('差分の全量と、ベース側の内容を書き出す', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd: '/repo',
      git: fakeShow({ 'abc1234:src/a.ts': 'const a = 0;\n' }),
      baseCommit: 'abc1234',
      fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n',
      changedPaths: ['src/a.ts'],
    });
    try {
      expect(await fs.readFile(path.join(bundle.dir, 'changes.diff'), 'utf8')).toBe(
        'diff --git a/src/a.ts b/src/a.ts\n',
      );
      expect(await fs.readFile(path.join(bundle.dir, 'base', 'src', 'a.ts'), 'utf8')).toBe(
        'const a = 0;\n',
      );
    } finally {
      await bundle.dispose();
    }
  });

  it('ベースに無いファイル（新規追加）は飛ばして続ける', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd: '/repo',
      git: fakeShow({ 'abc1234:src/a.ts': 'const a = 0;\n' }),
      baseCommit: 'abc1234',
      fullDiff: 'diff',
      changedPaths: ['src/new.ts', 'src/a.ts'],
    });
    try {
      await expect(fs.stat(path.join(bundle.dir, 'base', 'src', 'new.ts'))).rejects.toThrow();
      expect(await fs.readFile(path.join(bundle.dir, 'base', 'src', 'a.ts'), 'utf8')).toBe(
        'const a = 0;\n',
      );
    } finally {
      await bundle.dispose();
    }
  });

  it('`base/` の外を指すパスは書き出さない', async () => {
    const escaped = path.join('..', '..', 'escaped.ts');
    const bundle = await createReviewBundle({
      root,
      cwd: '/repo',
      git: fakeShow({ [`abc1234:${escaped}`]: 'secret\n' }),
      baseCommit: 'abc1234',
      fullDiff: 'diff',
      changedPaths: [escaped],
    });
    try {
      await expect(fs.stat(path.join(bundle.dir, '..', 'escaped.ts'))).rejects.toThrow();
    } finally {
      await bundle.dispose();
    }
  });

  it('バイナリはベース側へ置かない', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd: '/repo',
      git: fakeShow({ 'abc1234:img.png': 'a\0b' }),
      baseCommit: 'abc1234',
      fullDiff: 'diff',
      changedPaths: ['img.png'],
    });
    try {
      await expect(fs.stat(path.join(bundle.dir, 'base', 'img.png'))).rejects.toThrow();
    } finally {
      await bundle.dispose();
    }
  });

  it('dispose は中身ごと消し、何度呼んでも安全', async () => {
    const bundle = await createReviewBundle({
      root,
      cwd: '/repo',
      git: fakeShow({}),
      baseCommit: 'abc1234',
      fullDiff: 'diff',
      changedPaths: [],
    });
    await bundle.dispose();
    await bundle.dispose();
    await expect(fs.stat(bundle.dir)).rejects.toThrow();
  });

  it('空のbundleでも、実workspaceとは別のディレクトリを作る', async () => {
    const bundle = await createEmptyReviewBundle(root);
    try {
      expect(path.basename(bundle.dir).startsWith(REVIEW_BUNDLE_PREFIX)).toBe(true);
      expect(await fs.readdir(bundle.dir)).toEqual([]);
    } finally {
      await bundle.dispose();
    }
  });
});

describe('removeStaleReviewBundles（Issue #926 E）', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-stale-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('十分に古いbundleだけを消す', async () => {
    const stale = await fs.mkdtemp(path.join(root, REVIEW_BUNDLE_PREFIX));
    const fresh = await fs.mkdtemp(path.join(root, REVIEW_BUNDLE_PREFIX));
    const other = path.join(root, 'not-a-bundle');
    await fs.mkdir(other);
    const now = Date.now();
    // mtimeを過去へずらして「取り残し」を作る
    await fs.utimes(stale, new Date(now - 48 * 60 * 60_000), new Date(now - 48 * 60 * 60_000));

    await removeStaleReviewBundles(root, now);

    await expect(fs.stat(stale)).rejects.toThrow();
    expect((await fs.stat(fresh)).isDirectory()).toBe(true);
    // 自分が作ったもの以外には触らない
    expect((await fs.stat(other)).isDirectory()).toBe(true);
  });

  it('親ディレクトリがまだ無くても失敗しない', async () => {
    await expect(
      removeStaleReviewBundles(path.join(root, 'missing'), Date.now()),
    ).resolves.toBeUndefined();
  });
});
