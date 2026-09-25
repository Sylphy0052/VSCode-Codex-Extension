/**
 * ロードマップ実行（Issue #1465）の実行層が使う外部処理（git・`gh`・`glab`）。
 * `RoadmapIssueRunnerDeps`の`resolveBaseCommit`・`findPullRequest`・`isPullRequestMerged`と、
 * Controllerが使うforgeの判定を実装する。
 *
 * コマンドは`execFile`系のrunner（シェルを経由しない）で実行し、ブランチ名などは引数の
 * 配列で渡す。応答は外部由来のため、番号とURLの形を確かめてから使う。
 */

import {
  detectForgeHost,
  fetchPullRequestStatus,
  type CliCommandRunner,
  type ForgeHost,
} from './forge';
import type { GitCommandRunner } from './worktree';

export interface RoadmapRunForgePorts {
  git: GitCommandRunner;
  cli: CliCommandRunner;
}

/** originのURLからGitHub / GitLabを判定する。判定できなければ`undefined`。 */
export async function detectRoadmapForgeHost(
  ports: RoadmapRunForgePorts,
  repoRoot: string,
): Promise<ForgeHost | undefined> {
  const remote = await ports.git.run(['remote', 'get-url', 'origin'], repoRoot);
  return remote.code === 0 ? detectForgeHost(remote.stdout.trim()) : undefined;
}

/**
 * Issueブランチの分岐元。依存先のmergeを含めるため、originを取り込んでから
 * `origin/HEAD` → `origin/main` → `HEAD`の順に解決する。取り込みの失敗（オフライン等）は
 * 止めずに手元の参照で続ける。
 */
export async function resolveRoadmapBaseCommit(
  ports: RoadmapRunForgePorts,
  repoRoot: string,
): Promise<string | undefined> {
  // `--prune`は付けない。付けると取り込みの経路によってはorigin/mainが消える
  await ports.git.run(['fetch', 'origin'], repoRoot);
  for (const ref of ['origin/HEAD', 'origin/main', 'HEAD']) {
    const result = await ports.git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot);
    const sha = result.stdout.trim();
    if (result.code === 0 && /^[0-9a-f]{7,64}$/.test(sha)) {
      return sha;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toPullRequest(numberValue: unknown, urlValue: unknown): { number: number; url: string } | undefined {
  if (
    typeof numberValue !== 'number' ||
    !Number.isSafeInteger(numberValue) ||
    numberValue <= 0 ||
    typeof urlValue !== 'string' ||
    !urlValue.startsWith('https://')
  ) {
    return undefined;
  }
  return { number: numberValue, url: urlValue };
}

/** 応答の先頭要素だけを見る（`--limit 1`・新しい順）。 */
export function parseGithubPullRequestList(stdout: string): { number: number; url: string } | undefined {
  const parsed = parseJson(stdout);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  return isRecord(first) ? toPullRequest(first.number, first.url) : undefined;
}

export function parseGitlabMergeRequestList(stdout: string): { number: number; url: string } | undefined {
  const parsed = parseJson(stdout);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  return isRecord(first) ? toPullRequest(first.iid, first.web_url) : undefined;
}

/** ブランチに対応するPR/MR（閉じた・merge済みを含む）。無い・確かめられなければ`undefined`。 */
export async function findRoadmapPullRequest(
  ports: RoadmapRunForgePorts,
  repoRoot: string,
  branch: string,
): Promise<{ number: number; url: string } | undefined> {
  const host = await detectRoadmapForgeHost(ports, repoRoot);
  if (host === 'github') {
    const result = await ports.cli.run(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url', '--limit', '1'],
      repoRoot,
    );
    return result.code === 0 ? parseGithubPullRequestList(result.stdout) : undefined;
  }
  if (host === 'gitlab') {
    const query = new URLSearchParams({ source_branch: branch, state: 'all', per_page: '1' });
    const result = await ports.cli.run(
      'glab',
      ['api', `projects/:id/merge_requests?${query.toString()}`],
      repoRoot,
    );
    return result.code === 0 ? parseGitlabMergeRequestList(result.stdout) : undefined;
  }
  return undefined;
}

/** PR/MRがmerge済みか。確かめられなければ`undefined`。 */
export async function isRoadmapPullRequestMerged(
  ports: RoadmapRunForgePorts,
  repoRoot: string,
  pullRequestNumber: number,
): Promise<boolean | undefined> {
  const host = await detectRoadmapForgeHost(ports, repoRoot);
  if (host === undefined) {
    return undefined;
  }
  const status = await fetchPullRequestStatus(ports.cli, host, repoRoot, pullRequestNumber);
  return status.state === 'unknown' ? undefined : status.state === 'merged';
}
