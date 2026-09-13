/**
 * PRから、材料を取るための2地点（base / target）を決める（Issue #1046）。
 *
 * `samplingFrame.ts` から切り出してある。あちらは実行するとGitHubを引きに行くので、テストから
 * 読めない。**ここの取り違えは生成を落とさず、もっともらしい数字を出す**（第1親をbaseにした
 * 初版は、169行 / 5ファイル のPRを 1272行 / 19ファイル として正常に生成した）ので、テストで
 * 固定できる場所へ置く。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type SnapshotStatus = 'ok' | 'non-linear' | 'unavailable';

/** `resolveSnapshot` が必要とするPRの情報だけ。 */
export interface SnapshotInput {
  baseRefOid: string;
  headRefOid: string;
  mergeCommit: { oid: string } | null;
}

export interface ResolvedSnapshot {
  status: SnapshotStatus;
  baseSha: string | undefined;
  targetSha: string | undefined;
  /** `ok` でないときの理由。黙って補正せずここへ残す。 */
  note: string | undefined;
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoDir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function commitExists(repoDir: string, sha: string): Promise<boolean> {
  try {
    await git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function mergeBaseOf(repoDir: string, a: string, b: string): Promise<string | undefined> {
  try {
    const out = (await git(repoDir, ['merge-base', a, b])).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * base と target を決める（Issue #1046）。
 *
 * target は merge commit の第2親（PRのhead）。API の `headRefOid` ではなくこちらを使うのは、
 * **親であればローカルに必ずある**ためである。head branch は削除されるので `headRefOid` は
 * fetch済みとは限らない。
 *
 * base は**第1親ではなく `merge-base`** を取る。第1親はmerge直前の `main` であって、この
 * ブランチの分岐点ではない。分岐してからmergeされるまでに他のPRが `main` へ入っていると、
 * 第1親との差分にはその分が逆向きに混ざる。実測では PR #1041 が 169行 / 5ファイル のところ
 * 1272行 / 19ファイル になった。
 *
 * 親が1つしかない場合（squash / rebase merge）は、この対応が成り立たない。**黙って補正せず**
 * `non-linear` として記録し、API の値から同じく merge-base を取る。
 */
export async function resolveSnapshot(
  pr: SnapshotInput,
  repoDir: string,
): Promise<ResolvedSnapshot> {
  const mergeCommit = pr.mergeCommit?.oid;
  if (mergeCommit === undefined || !(await commitExists(repoDir, mergeCommit))) {
    return {
      status: 'unavailable',
      baseSha: undefined,
      targetSha: undefined,
      note: 'merge commit がローカルに無い',
    };
  }
  const parents = (await git(repoDir, ['rev-list', '--parents', '-n', '1', mergeCommit]))
    .trim()
    .split(/\s+/);
  const [, first, second] = parents;
  if (first !== undefined && second !== undefined) {
    const mergeBase = await mergeBaseOf(repoDir, first, second);
    if (mergeBase === undefined) {
      return {
        status: 'unavailable',
        baseSha: undefined,
        targetSha: undefined,
        note: 'merge commit の2つの親に共通祖先が無い',
      };
    }
    return { status: 'ok', baseSha: mergeBase, targetSha: second, note: undefined };
  }

  // 親が1つ = squash か rebase。merge commit の差分は取れるが、PRのheadそのものではない
  const baseAvailable = await commitExists(repoDir, pr.baseRefOid);
  const headAvailable = await commitExists(repoDir, pr.headRefOid);
  if (baseAvailable && headAvailable) {
    const mergeBase = await mergeBaseOf(repoDir, pr.baseRefOid, pr.headRefOid);
    if (mergeBase !== undefined) {
      return {
        status: 'non-linear',
        baseSha: mergeBase,
        targetSha: pr.headRefOid,
        note: 'merge commit の親が1つ（squash/rebase）。API の base/head から merge-base を取った',
      };
    }
    return {
      status: 'unavailable',
      baseSha: undefined,
      targetSha: undefined,
      note: 'merge commit の親が1つで、API の base/head に共通祖先が無い',
    };
  }
  return {
    status: 'unavailable',
    baseSha: undefined,
    targetSha: undefined,
    note: `merge commit の親が1つで、API の ${baseAvailable ? 'head' : 'base'} もローカルに無い`,
  };
}
