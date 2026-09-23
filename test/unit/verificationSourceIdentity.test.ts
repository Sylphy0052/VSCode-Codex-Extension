import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSubject } from '../../src/verification/record';
import {
  captureSourceIdentity,
  CLEAN_DIRTY_STATE_ID,
  parseStatusPaths,
} from '../../src/verification/sourceIdentity';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

describe('captureSourceIdentity', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'verif-src-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await writeFile(join(repo, '.gitignore'), 'ignored/\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('変更が無ければ HEAD と clean を返す', async () => {
    const identity = await captureSourceIdentity(repo);
    expect(identity?.head).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(identity?.dirtyStateId).toBe(CLEAN_DIRTY_STATE_ID);
  });

  it('同じ HEAD でも未コミット変更の内容が違えば dirtyStateId が異なる', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    const first = await captureSourceIdentity(repo);
    await writeFile(join(repo, 'a.txt'), 'three\n');
    const second = await captureSourceIdentity(repo);
    expect(first?.head).toBe(second?.head);
    expect(first?.dirtyStateId).not.toBe(CLEAN_DIRTY_STATE_ID);
    expect(first?.dirtyStateId).not.toBe(second?.dirtyStateId);
  });

  it('同じ内容なら同じ dirtyStateId になり、索引へ載せたかどうかでは変わらない', async () => {
    await writeFile(join(repo, 'a.txt'), 'two\n');
    const unstaged = await captureSourceIdentity(repo);
    git(repo, 'add', 'a.txt');
    const staged = await captureSourceIdentity(repo);
    expect(staged).toEqual(unstaged);
  });

  it('未追跡ファイルの内容も含め、無視されたファイルは含めない', async () => {
    await writeFile(join(repo, 'new.txt'), 'x');
    const withUntracked = await captureSourceIdentity(repo);
    await writeFile(join(repo, 'new.txt'), 'y');
    const changedUntracked = await captureSourceIdentity(repo);
    expect(withUntracked?.dirtyStateId).not.toBe(changedUntracked?.dirtyStateId);

    await rm(join(repo, 'new.txt'));
    await mkdir(join(repo, 'ignored'));
    await writeFile(join(repo, 'ignored', 'big.bin'), 'z');
    expect((await captureSourceIdentity(repo))?.dirtyStateId).toBe(CLEAN_DIRTY_STATE_ID);
  });

  it('実行中にファイルが変わると sourceChanged が真になる', async () => {
    const before = await captureSourceIdentity(repo);
    await writeFile(join(repo, 'a.txt'), 'changed during run\n');
    const after = await captureSourceIdentity(repo);
    expect(buildSubject(before, after)?.sourceChanged).toBe(true);
    expect(buildSubject(before, before)?.sourceChanged).toBe(false);
  });

  it('同じリポジトリの別 worktree は repoId が同じで worktreeId が異なる', async () => {
    const other = join(repo, '..', `${repo.split('/').pop()}-wt`);
    git(repo, 'worktree', 'add', '-q', other);
    try {
      const main = await captureSourceIdentity(repo);
      const wt = await captureSourceIdentity(other);
      expect(wt?.repoId).toBe(main?.repoId);
      expect(wt?.worktreeId).not.toBe(main?.worktreeId);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('git リポジトリの外では undefined', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'verif-nogit-'));
    try {
      expect(await captureSourceIdentity(outside)).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('parseStatusPaths', () => {
  it('-z 区切りの項目からパスを取り出す', () => {
    expect(parseStatusPaths(' M a.txt\0?? dir/b c.txt\0')).toEqual(['a.txt', 'dir/b c.txt']);
  });
});
