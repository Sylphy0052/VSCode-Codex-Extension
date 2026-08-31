import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveSnapshot } from '../bench/secondOpinionEval/prSnapshot';

const run = promisify(execFile);

async function git(repoDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoDir, ...args]);
  return stdout.trim();
}

async function commit(repoDir: string, file: string, body: string): Promise<string> {
  await fs.writeFile(path.join(repoDir, file), body, 'utf8');
  await git(repoDir, 'add', file);
  await git(repoDir, 'commit', '-m', `add ${file}`);
  return git(repoDir, 'rev-parse', 'HEAD');
}

/**
 * 「分岐したあと、mergeされるまでに別のPRが main へ入った」形のリポジトリを作る。
 *
 * ```
 * root --- other ------- merge
 *   \                   /
 *    ---- feature -----
 * ```
 *
 * feature が変えたのは `feature.txt` の1ファイルだけだが、merge commit の第1親は `other` な
 * ので、第1親との差分には `other.txt` の削除まで混ざる。
 */
async function makeRepo(): Promise<{
  dir: string;
  root: string;
  other: string;
  feature: string;
  merge: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'so-eval-snapshot-'));
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
  await git(dir, 'config', 'commit.gpgsign', 'false');

  const root = await commit(dir, 'root.txt', 'root\n');
  await git(dir, 'checkout', '-b', 'feature');
  const feature = await commit(dir, 'feature.txt', 'feature\n');

  await git(dir, 'checkout', 'main');
  const other = await commit(dir, 'other.txt', 'other\n'.repeat(50));

  await git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const merge = await git(dir, 'rev-parse', 'HEAD');
  return { dir, root, other, feature, merge };
}

describe('resolveSnapshot', () => {
  it('base に第1親ではなく merge-base を返す', async () => {
    const repo = await makeRepo();

    const resolved = await resolveSnapshot(
      { baseRefOid: repo.other, headRefOid: repo.feature, mergeCommit: { oid: repo.merge } },
      repo.dir,
    );

    expect(resolved.status).toBe('ok');
    expect(resolved.baseSha).toBe(repo.root);
    expect(resolved.targetSha).toBe(repo.feature);
    // 第1親そのものを返してしまっていないこと
    expect(resolved.baseSha).not.toBe(repo.other);
  });

  it('第1親を base にすると、このPRが触っていないファイルまで差分に入る', async () => {
    const repo = await makeRepo();
    const resolved = await resolveSnapshot(
      { baseRefOid: repo.other, headRefOid: repo.feature, mergeCommit: { oid: repo.merge } },
      repo.dir,
    );

    const viaMergeBase = await git(
      repo.dir,
      'diff',
      '--name-only',
      `${resolved.baseSha ?? ''}..${resolved.targetSha ?? ''}`,
    );
    const viaFirstParent = await git(
      repo.dir,
      'diff',
      '--name-only',
      `${repo.other}..${repo.feature}`,
    );

    expect(viaMergeBase.split('\n').filter(Boolean)).toEqual(['feature.txt']);
    // 旧実装はこちらだった。このPRが触っていない other.txt が混ざる
    expect(viaFirstParent.split('\n').filter(Boolean).sort()).toEqual(['feature.txt', 'other.txt']);
  });

  it('親が1つなら non-linear として記録し、黙って補正しない', async () => {
    const repo = await makeRepo();
    // squash merge の形: main 側に1親のコミットだけがある
    await git(repo.dir, 'checkout', '-b', 'squashed', repo.other);
    const squashed = await commit(repo.dir, 'squashed.txt', 'squashed\n');

    const resolved = await resolveSnapshot(
      { baseRefOid: repo.other, headRefOid: repo.feature, mergeCommit: { oid: squashed } },
      repo.dir,
    );

    expect(resolved.status).toBe('non-linear');
    expect(resolved.baseSha).toBe(repo.root);
    expect(resolved.note).toContain('親が1つ');
  });

  it('merge commit がローカルに無ければ unavailable', async () => {
    const repo = await makeRepo();

    const resolved = await resolveSnapshot(
      {
        baseRefOid: repo.other,
        headRefOid: repo.feature,
        mergeCommit: { oid: '0'.repeat(40) },
      },
      repo.dir,
    );

    expect(resolved.status).toBe('unavailable');
    expect(resolved.baseSha).toBeUndefined();
    expect(resolved.note).toBe('merge commit がローカルに無い');
  });

  it('mergeCommit が null なら unavailable', async () => {
    const repo = await makeRepo();

    const resolved = await resolveSnapshot(
      { baseRefOid: repo.other, headRefOid: repo.feature, mergeCommit: null },
      repo.dir,
    );

    expect(resolved.status).toBe('unavailable');
  });
});
