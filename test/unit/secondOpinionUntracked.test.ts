import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectUntrackedFiles,
  createNodeUntrackedFileReader,
  isInsideRoot,
  looksBinary,
  parseUntrackedList,
  type UntrackedFileReader,
} from '../../src/secondOpinion/untracked';
import { captureWorkspaceSnapshot } from '../../src/secondOpinion/snapshot';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';

function okResult(stdout: string): GitCommandResult {
  return { code: 0, stdout, stderr: '' };
}

/** 引数列をスペースで繋いだキーで引くフェイク。未登録の呼び出しは失敗として返す。 */
function fakeGit(responses: Record<string, GitCommandResult>): GitCommandRunner {
  return {
    async run(args) {
      return responses[args.join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

/** 中身をメモリに持つ読み手。ファイルシステムに触れない経路の検証に使う。 */
function fakeReader(files: Record<string, string>): UntrackedFileReader {
  return {
    async read(absPath, _root, maxBytes) {
      const content = files[absPath];
      if (content === undefined) {
        return { kind: 'skipped', reason: 'read-error' };
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > maxBytes) {
        return { kind: 'skipped', reason: 'per-file-budget', bytes };
      }
      return { kind: 'file', bytes, content };
    },
  };
}

describe('parseUntrackedList（Issue #926 F）', () => {
  it('NUL区切りで分け、末尾の空要素を落とす', () => {
    expect(parseUntrackedList('a.ts\0dir/b.ts\0')).toEqual(['a.ts', 'dir/b.ts']);
  });

  it('改行を含むファイル名でも1件として扱う', () => {
    expect(parseUntrackedList('od\nd\0')).toEqual(['od\nd']);
  });

  it('空の出力は0件', () => {
    expect(parseUntrackedList('')).toEqual([]);
  });
});

describe('isInsideRoot（Issue #926 F）', () => {
  it('root配下は通す', () => {
    expect(isInsideRoot('/repo/src/a.ts', '/repo')).toBe(true);
  });

  it('接頭辞が同じだけの別ディレクトリは通さない', () => {
    expect(isInsideRoot('/repo-secrets/a.ts', '/repo')).toBe(false);
  });

  it('root自身は通さない', () => {
    expect(isInsideRoot('/repo', '/repo')).toBe(false);
  });

  it('rootの外は通さない', () => {
    expect(isInsideRoot('/etc/passwd', '/repo')).toBe(false);
  });
});

describe('looksBinary（Issue #926 F）', () => {
  it('NULを含めばバイナリ', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });

  it('NULが無ければテキスト', () => {
    expect(looksBinary(Buffer.from('const a = 1;\n', 'utf8'))).toBe(false);
  });
});

describe('collectUntrackedFiles（Issue #926 F）', () => {
  it('予算の範囲で読み、超えた分は理由付きで一覧へ載せる', async () => {
    const root = '/repo';
    const reader = fakeReader({
      [path.resolve(root, 'a.ts')]: 'aaaa',
      [path.resolve(root, 'b.ts')]: 'bbbb',
      [path.resolve(root, 'c.ts')]: 'cccc',
    });
    const result = await collectUntrackedFiles({
      root,
      paths: ['a.ts', 'b.ts', 'c.ts'],
      totalBudgetBytes: 8,
      reader,
    });
    expect(result.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    // 打ち切らずに残りも一覧へ載せる（何件見ていないかが分かる方が判断に使える）
    expect(result.omissions).toEqual([{ path: 'c.ts', bytes: undefined, reason: 'total-budget' }]);
  });

  it('読めなかったファイルも黙って落とさない', async () => {
    const result = await collectUntrackedFiles({
      root: '/repo',
      paths: ['missing.ts'],
      totalBudgetBytes: 100,
      reader: fakeReader({}),
    });
    expect(result.files).toEqual([]);
    expect(result.omissions).toEqual([
      { path: 'missing.ts', bytes: undefined, reason: 'read-error' },
    ]);
  });

  it('1ファイルの上限を超えるものは、残り予算ではなくファイル自体の理由で落とす', async () => {
    const root = '/repo';
    const result = await collectUntrackedFiles({
      root,
      paths: ['huge.ts'],
      totalBudgetBytes: 1000,
      perFileBytes: 4,
      reader: fakeReader({ [path.resolve(root, 'huge.ts')]: 'aaaaaaaa' }),
    });
    expect(result.omissions).toEqual([{ path: 'huge.ts', bytes: 8, reason: 'per-file-budget' }]);
  });
});

describe('createNodeUntrackedFileReader（Issue #926 F）', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'untracked-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('通常のテキストファイルは読める', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf8');
    const result = await createNodeUntrackedFileReader().read(
      path.join(root, 'a.ts'),
      root,
      64 * 1024,
    );
    expect(result).toEqual({ kind: 'file', bytes: 13, content: 'const a = 1;\n' });
  });

  it('workspaceの外を指すsymlinkは読まない（.gitignoreは秘密の境界ではない）', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'untracked-outside-'));
    try {
      const secret = path.join(outside, 'credentials');
      await fs.writeFile(secret, 'token=abcdef\n', 'utf8');
      await fs.symlink(secret, path.join(root, '.env'));
      const result = await createNodeUntrackedFileReader().read(
        path.join(root, '.env'),
        root,
        64 * 1024,
      );
      expect(result).toEqual({ kind: 'skipped', reason: 'outside-workspace' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('通常ファイルでないものは読まない', async () => {
    await fs.mkdir(path.join(root, 'dir'));
    const result = await createNodeUntrackedFileReader().read(
      path.join(root, 'dir'),
      root,
      64 * 1024,
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'unsafe-file-type' });
  });

  it('NULを含むファイルはバイナリとして落とす', async () => {
    await fs.writeFile(path.join(root, 'bin'), Buffer.from([0x61, 0x00, 0x62]));
    const result = await createNodeUntrackedFileReader().read(
      path.join(root, 'bin'),
      root,
      64 * 1024,
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'binary', bytes: 3 });
  });

  it('上限を超えるファイルは開いても読まない', async () => {
    await fs.writeFile(path.join(root, 'big.ts'), 'x'.repeat(100), 'utf8');
    const result = await createNodeUntrackedFileReader().read(path.join(root, 'big.ts'), root, 10);
    expect(result).toEqual({ kind: 'skipped', reason: 'per-file-budget', bytes: 100 });
  });
});

/** hunkが2件ある差分。1件だけ入る予算を渡して境界での切り詰めを見る。 */
const BIG_DIFF =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n' +
  `@@ -1,1 +1,1 @@\n+${'a'.repeat(200)}\n` +
  `@@ -2,1 +2,1 @@\n+${'b'.repeat(200)}\n`;

describe('captureWorkspaceSnapshot と未追跡ファイル（Issue #926 F）', () => {
  const base = {
    'rev-parse --is-inside-work-tree': okResult('true\n'),
    'rev-parse HEAD': okResult('abc1234\n'),
  };

  it('未追跡ファイルを差分とは別に取り、先に予算を確保する', async () => {
    const git = fakeGit({
      ...base,
      'diff --no-ext-diff --no-textconv abc1234 --': okResult(BIG_DIFF),
      'diff --name-only -z --no-ext-diff --no-textconv abc1234 --': okResult('a.ts\0'),
      'ls-files --others --exclude-standard -z': okResult('new.ts\0'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git, {
      maxDiffBytes: 387,
      maxUntrackedBytes: 10,
      untrackedReader: fakeReader({ [path.resolve('/repo', 'new.ts')]: 'newnewnew' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.untrackedFiles).toEqual([
      { path: 'new.ts', content: 'newnewnew', bytes: 9 },
    ]);
    // 未追跡の9byteを引いた残り（378byte）が差分の予算になり、hunkが1件落ちる
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.diffPartials).toEqual([
      { path: 'a.ts', omittedHunks: 1, totalHunks: 2 },
    ]);
    expect(result.material.changedPaths).toEqual(['a.ts']);
    expect(result.material.fullDiff).toBe(BIG_DIFF);
  });

  it('差分が空でも未追跡ファイルがあれば実行する', async () => {
    const git = fakeGit({
      ...base,
      'diff --no-ext-diff --no-textconv abc1234 --': okResult(''),
      'diff --name-only -z --no-ext-diff --no-textconv abc1234 --': okResult(''),
      'ls-files --others --exclude-standard -z': okResult('new.ts\0'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git, {
      untrackedReader: fakeReader({ [path.resolve('/repo', 'new.ts')]: 'x' }),
    });
    expect(result.ok).toBe(true);
  });

  it('ls-files が失敗しても差分だけで続行する', async () => {
    const git = fakeGit({
      ...base,
      'diff --no-ext-diff --no-textconv abc1234 --': okResult('+const a = 1;\n'),
      'diff --name-only -z --no-ext-diff --no-textconv abc1234 --': okResult('a.ts\0'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.untrackedFiles).toEqual([]);
    expect(result.snapshot.untrackedOmissions).toEqual([]);
  });
});
