/**
 * 凍結after-treeの構築（Issue #1047）。
 *
 * フェイクのgitでは受入基準を確かめられない。ここで確かめたいのは「gitが実際に何を書くか」
 * （実行bit・symlink・binary・`.git` を作らないこと）と「当たらない差分で本当に失敗するか」で、
 * どちらもフェイクだと自分の思い込みをそのまま検証することになる。`worktree.test.ts` に
 * 実物のgitを使う先例があるので、それに倣って使い捨てリポジトリを作る。
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeGitCommandRunner } from '../../src/orchestrator/worktree';
import {
  createFrozenAfterTree,
  FrozenAfterTreeError,
  FROZEN_AFTER_TREE_NOTICE_FILE,
} from '../../src/secondOpinion/afterTree';
import { captureWorkspaceSnapshot } from '../../src/secondOpinion/snapshot';

const execFileAsync = promisify(execFile);

/** 使い捨てリポジトリでgitを打つ。テストの前提が崩れたらそこで落としたいので `reject` させる。 */
async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** `git apply` に通せる形の差分。`snapshot.ts` の `applyDiff` と同じ引数で取る。 */
async function applyDiffOf(repo: string, base: string): Promise<string> {
  return await git(
    repo,
    'diff',
    '--binary',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--no-ext-diff',
    '--no-textconv',
    base,
    '--',
  );
}

describe('createFrozenAfterTree（Issue #1047）', () => {
  let repo: string;
  let scratch: string;
  let base: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'after-tree-test-'));
    repo = path.join(scratch, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'test');
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 0;\n');
    await fs.writeFile(path.join(repo, 'src', 'dep.ts'), 'export const dep = 1;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'base');
    base = (await git(repo, 'rev-parse', 'HEAD')).trim();
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const treeDir = (): string => path.join(scratch, 'after');

  it('未コミットの変更を当てた木ができ、差分に現れないファイルもそのまま入る', async () => {
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: await applyDiffOf(repo, base),
    });
    try {
      // 変更したファイルは after の内容になる
      expect(await fs.readFile(path.join(tree.dir, 'src', 'a.ts'), 'utf8')).toBe(
        'export const a = 1;\n',
      );
      // C-repo の値打ちはここ。差分に現れないファイルも木の中にある
      expect(await fs.readFile(path.join(tree.dir, 'src', 'dep.ts'), 'utf8')).toBe(
        'export const dep = 1;\n',
      );
    } finally {
      await tree.dispose();
    }
  });

  it('木に`.git`を作らない（履歴・他ブランチへ辿れる経路を残さない）', async () => {
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: await applyDiffOf(repo, base),
    });
    try {
      await expect(fs.stat(path.join(tree.dir, '.git'))).rejects.toThrow();
    } finally {
      await tree.dispose();
    }
  });

  it('binary・実行bit・symlinkの変更が写る', async () => {
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await fs.writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\necho a\n', { mode: 0o644 });
    await fs.symlink('src/a.ts', path.join(repo, 'link.ts'));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'add fixtures');
    const base2 = (await git(repo, 'rev-parse', 'HEAD')).trim();

    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([9, 9, 0, 9]));
    await fs.chmod(path.join(repo, 'run.sh'), 0o755);
    await fs.unlink(path.join(repo, 'link.ts'));
    await fs.symlink('src/dep.ts', path.join(repo, 'link.ts'));

    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base2,
      applyDiff: await applyDiffOf(repo, base2),
    });
    try {
      expect([...(await fs.readFile(path.join(tree.dir, 'bin.dat')))]).toEqual([9, 9, 0, 9]);
      const mode = (await fs.stat(path.join(tree.dir, 'run.sh'))).mode & 0o111;
      expect(mode).not.toBe(0);
      expect(await fs.readlink(path.join(tree.dir, 'link.ts'))).toBe('src/dep.ts');
    } finally {
      await tree.dispose();
    }
  });

  it('binaryを含む差分を`--binary`なしで渡すと失敗し、木を残さない（fail-openしない）', async () => {
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'add binary');
    const base2 = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([4, 5, 6, 7]));

    // 条件Aの `changes.diff` と同じ引数（`--binary` 無し）。binaryは内容の無い1行になる
    const plain = await git(repo, 'diff', '--no-ext-diff', '--no-textconv', base2, '--');
    expect(plain).toContain('Binary files');

    await expect(
      createFrozenAfterTree({
        dir: treeDir(),
        cwd: repo,
        git: nodeGitCommandRunner,
        baseCommit: base2,
        applyDiff: plain,
      }),
    ).rejects.toBeInstanceOf(FrozenAfterTreeError);
    // 半端な木（binaryだけbaseのまま）を残さない
    await expect(fs.stat(treeDir())).rejects.toThrow();
  });

  it('当たらない差分では失敗し、木を残さない', async () => {
    const bogus = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-export const nothing = 0;',
      '+export const a = 1;',
      '',
    ].join('\n');
    const error = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: bogus,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrozenAfterTreeError);
    expect((error as FrozenAfterTreeError).step).toBe('apply');
    await expect(fs.stat(treeDir())).rejects.toThrow();
  });

  it('辿れないベースコミットでは失敗し、木を残さない', async () => {
    const error = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: '0000000000000000000000000000000000000000',
      applyDiff: '',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrozenAfterTreeError);
    expect((error as FrozenAfterTreeError).step).toBe('read-tree');
    await expect(fs.stat(treeDir())).rejects.toThrow();
  });

  it('作成先に中身があるときは断り、そこにあったものを消さない', async () => {
    await fs.mkdir(treeDir(), { recursive: true });
    await fs.writeFile(path.join(treeDir(), 'keep.txt'), 'do not delete\n');
    const error = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: '',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrozenAfterTreeError);
    expect(await fs.readFile(path.join(treeDir(), 'keep.txt'), 'utf8')).toBe('do not delete\n');
  });

  it('押下時に読み終えた未追跡ファイルを木へ置き、読めなかったものは欠落として残す', async () => {
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: '',
      untrackedFiles: [{ path: 'src/new.ts', content: 'export const n = 2;\n', bytes: 20 }],
      untrackedOmissions: [{ path: 'huge.bin', bytes: 999_999, reason: 'binary' }],
    });
    try {
      expect(await fs.readFile(path.join(tree.dir, 'src', 'new.ts'), 'utf8')).toBe(
        'export const n = 2;\n',
      );
      expect(tree.omissions).toEqual([
        { path: 'huge.bin', reason: 'untracked-not-captured', detail: 'binary' },
      ]);
      // 欠落は木の中からも読める。「無い」と読まれないようにするのが目的
      const notice = await fs.readFile(path.join(tree.dir, FROZEN_AFTER_TREE_NOTICE_FILE), 'utf8');
      expect(notice).toContain('huge.bin');
      expect(notice).toContain('無いものとして判断しないでください');
    } finally {
      await tree.dispose();
    }
  });

  it('木の外を指す未追跡パスは書かず、欠落として残す', async () => {
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: '',
      untrackedFiles: [{ path: '../escaped.ts', content: 'leak\n', bytes: 5 }],
    });
    try {
      expect(tree.omissions).toEqual([{ path: '../escaped.ts', reason: 'unsafe-path' }]);
      await expect(fs.stat(path.join(scratch, 'escaped.ts'))).rejects.toThrow();
    } finally {
      await tree.dispose();
    }
  });

  it('作業ツリーを読まない。木を作った後に作業ツリーを書き換えても木は変わらない', async () => {
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const pinned = await applyDiffOf(repo, base);
    // 押下後に人が作業を続けた、という状況を作る
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 999;\n');
    await fs.writeFile(path.join(repo, 'src', 'dep.ts'), 'export const dep = 999;\n');

    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: pinned,
    });
    try {
      // 固定した差分の内容であって、いまの作業ツリーの内容ではない
      expect(await fs.readFile(path.join(tree.dir, 'src', 'a.ts'), 'utf8')).toBe(
        'export const a = 1;\n',
      );
      // 差分に現れないファイルは baseCommit の内容。作業ツリーの999は入らない
      expect(await fs.readFile(path.join(tree.dir, 'src', 'dep.ts'), 'utf8')).toBe(
        'export const dep = 1;\n',
      );
    } finally {
      await tree.dispose();
    }
  });

  it('本物のindexと作業ツリーを書き換えない', async () => {
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(repo, 'untracked.ts'), 'export const u = 0;\n');
    const before = await git(repo, 'status', '--porcelain');
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: base,
      applyDiff: await applyDiffOf(repo, base),
    });
    try {
      expect(await git(repo, 'status', '--porcelain')).toBe(before);
    } finally {
      await tree.dispose();
    }
  });

  it('captureWorkspaceSnapshot が返す applyDiff はそのまま木を組み立てられる', async () => {
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const captured = await captureWorkspaceSnapshot(repo, nodeGitCommandRunner);
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    expect(captured.material.applyDiff).toBeDefined();
    const tree = await createFrozenAfterTree({
      dir: treeDir(),
      cwd: repo,
      git: nodeGitCommandRunner,
      baseCommit: captured.snapshot.baseCommit,
      applyDiff: captured.material.applyDiff ?? '',
      untrackedFiles: captured.snapshot.untrackedFiles,
      untrackedOmissions: captured.snapshot.untrackedOmissions,
    });
    try {
      expect(await fs.readFile(path.join(tree.dir, 'src', 'a.ts'), 'utf8')).toBe(
        'export const a = 1;\n',
      );
    } finally {
      await tree.dispose();
    }
  });
});
