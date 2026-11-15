import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertRunId,
  cleanIgnored,
  normalizeKeepPaths,
  optimizeRef,
  prepareMeasureWorktrees,
  resetCandidateToBest,
  snapshotTree,
} from '../../src/orchestrator/optimizeWorktrees';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

describe('optimizeWorktrees', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opt-wt-'));
    repo = join(root, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, '.gitignore'), 'dist/\nnode_modules/\n');
    await writeFile(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refの名前とrunIdを検証する', () => {
    expect(optimizeRef('r1', 'baseline')).toBe('refs/optimize/r1/baseline');
    expect(optimizeRef('r1', 'best')).toBe('refs/optimize/r1/best');
    expect(optimizeRef('r1', { trial: 3 })).toBe('refs/optimize/r1/trial/3');
    expect(() => assertRunId('../x')).toThrow();
    expect(() => optimizeRef('r1', { trial: -1 })).toThrow();
  });

  it('木をcommitにしてrefへ固定し、HEAD・ブランチ・indexを動かさない', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await mkdir(join(repo, 'dist'));
    await writeFile(join(repo, 'dist', 'o.js'), 'x');
    const ref = optimizeRef('r1', { trial: 1 });
    const sha = await snapshotTree({ workDir: repo, ref, message: 'trial', parent: head });
    expect(git(repo, 'rev-parse', ref)).toBe(sha);
    expect(git(repo, 'rev-parse', `${sha}^`)).toBe(head);
    expect(git(repo, 'show', `${sha}:a.txt`)).toBe('changed');
    expect(git(repo, 'show', `${sha}:new.txt`)).toBe('new');
    expect(git(repo, 'ls-tree', '-r', '--name-only', sha)).not.toContain('dist');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toContain('new.txt'); // 本物のindexは未変更
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('残すパス以外のignoredを消す（祖先ディレクトリの中も）', async () => {
    await mkdir(join(repo, 'dist', 'keep'), { recursive: true });
    await writeFile(join(repo, 'dist', 'keep', 'k'), 'k');
    await writeFile(join(repo, 'dist', 'junk'), 'j');
    await mkdir(join(repo, 'node_modules'));
    await writeFile(join(repo, 'node_modules', 'm'), 'm');
    await cleanIgnored(repo, ['dist/keep', 'node_modules']);
    expect(existsSync(join(repo, 'dist', 'keep', 'k'))).toBe(true);
    expect(existsSync(join(repo, 'dist', 'junk'))).toBe(false);
    expect(existsSync(join(repo, 'node_modules', 'm'))).toBe(true);
    expect(() => normalizeKeepPaths(['../x'])).toThrow();
    expect(() => normalizeKeepPaths(['/abs'])).toThrow();
  });

  it('3本のworktreeを準備し、ビルド成果物が木の間で混ざらない', async () => {
    const baseline = git(repo, 'rev-parse', 'HEAD');
    // best: 作業ツリーに変更を入れてcommit化
    await writeFile(join(repo, 'a.txt'), 'best\n');
    const best = await snapshotTree({
      workDir: repo,
      ref: optimizeRef('r1', 'best'),
      message: 'best',
      parent: baseline,
    });
    await writeFile(join(repo, 'a.txt'), 'base\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const setups: string[] = [];
    const dirs = await prepareMeasureWorktrees({
      repoDir: repo,
      root: join(root, 'wts'),
      commits: { baseline, best, candidate: best },
      allowedPaths: [],
      runSetup: async (dir, role) => {
        setups.push(role);
        await mkdir(join(dir, 'dist'), { recursive: true });
        await writeFile(join(dir, 'dist', 'out'), role);
      },
    });
    expect(setups).toEqual(['baseline', 'best', 'candidate']);
    expect(await readFile(join(dirs.baseline, 'a.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(join(dirs.best, 'a.txt'), 'utf8')).toBe('best\n');
    for (const role of ['baseline', 'best', 'candidate'] as const) {
      expect(git(dirs[role], 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached
      expect(await readFile(join(dirs[role], 'dist', 'out'), 'utf8')).toBe(role);
    }
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);

    // 候補へ手作業の変更と成果物を足し、bestへ戻す。古い成果物は準備前に消える
    await writeFile(join(dirs.candidate, 'a.txt'), 'trial\n');
    await writeFile(join(dirs.candidate, 'stray.txt'), 's');
    await writeFile(join(dirs.candidate, 'dist', 'stale'), 'old');
    await resetCandidateToBest({
      repoDir: repo,
      candidateDir: dirs.candidate,
      bestCommit: best,
      allowedPaths: [],
    });
    expect(await readFile(join(dirs.candidate, 'a.txt'), 'utf8')).toBe('best\n');
    expect(existsSync(join(dirs.candidate, 'stray.txt'))).toBe(false);
    expect(existsSync(join(dirs.candidate, 'dist'))).toBe(false);
    expect(git(dirs.candidate, 'rev-parse', 'HEAD')).toBe(best);
  });
});
