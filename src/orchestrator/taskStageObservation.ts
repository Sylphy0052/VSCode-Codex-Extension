import { fetchPullRequestStatus } from './forge';
import {
  detectRoadmapForgeHost,
  findRoadmapPullRequest,
  type RoadmapRunForgePorts,
} from './roadmapRunForge';
import type { OrchestratedTask, StageOutput } from './taskRunState';

/**
 * オーケストレータモード（Issue #1505）の工程の完了を、Controllerが観測した事実で確かめる。
 * 工程セッションの報告は「終わった」という申告にすぎないので、forgeのIssue・PRとgitの
 * ブランチを見て完了条件を満たすかを決める。成果（Issue番号・PR）は観測した値を正とする。
 */

export type PullRequestState = 'open' | 'merged' | 'closed' | 'unknown';

/** 観測に使う外部の口。`undefined`は「確かめられなかった」を表す。 */
export interface StageObservationPorts {
  fetchIssueTitle(repoRoot: string, issueNumber: number): Promise<string | undefined>;
  findPullRequest(
    repoRoot: string,
    branch: string,
  ): Promise<{ number: number; url: string } | undefined>;
  fetchPullRequestState(repoRoot: string, pullRequestNumber: number): Promise<PullRequestState>;
  /** リモートのブランチの先頭のcommit。ブランチが無ければ`null`、確かめられなければ`undefined`。 */
  remoteBranchHead(repoRoot: string, branch: string): Promise<string | null | undefined>;
  /** worktreeの`HEAD`のcommit。 */
  localHead(worktreePath: string): Promise<string | undefined>;
}

export type StageObservation = { ok: true; output: StageOutput } | { ok: false; reason: string };

const ACCEPTANCE_HEADING = /^#{1,6}\s*受入基準/mu;

/**
 * 報告された成果と観測した事実を突き合わせ、完了条件を満たせば確定する成果を返す。
 * `repoRoot`はメインのworking tree（forgeとリモートの問い合わせに使う）。
 */
export async function observeStageCompletion(
  ports: StageObservationPorts,
  repoRoot: string,
  task: OrchestratedTask,
  reported: StageOutput,
): Promise<StageObservation> {
  const fail = (reason: string): StageObservation => ({ ok: false, reason });
  switch (reported.stage) {
    case 'issuePlan': {
      const { title, body } = reported.issueDraft;
      if (title.trim() === '' || body.trim() === '') {
        return fail('Issueのタイトルか本文が空');
      }
      if (!ACCEPTANCE_HEADING.test(body)) {
        return fail('Issueの本文に「受入基準」の節が無い');
      }
      return { ok: true, output: reported };
    }
    case 'issueCreate': {
      const title = await ports.fetchIssueTitle(repoRoot, reported.issueNumber);
      if (title === undefined) {
        return fail(`Issue #${String(reported.issueNumber)}がforgeに見つからない`);
      }
      const expected = task.issueDraft?.title.trim();
      if (expected !== undefined && title.trim() !== expected) {
        return fail(
          `Issue #${String(reported.issueNumber)}のタイトルが前の工程の下書きと一致しない`,
        );
      }
      return { ok: true, output: reported };
    }
    case 'implement': {
      if (task.branch === undefined) {
        return fail('タスクのブランチが記録されていない');
      }
      const pr = await ports.findPullRequest(repoRoot, task.branch);
      if (pr === undefined) {
        return fail(`ブランチ ${task.branch} のPRが見つからない`);
      }
      const state = await ports.fetchPullRequestState(repoRoot, pr.number);
      if (state !== 'open') {
        return fail(`PR #${String(pr.number)}がopenでない（${state}）`);
      }
      return { ok: true, output: { stage: 'implement', pullRequest: pr } };
    }
    case 'review': {
      if (
        task.pullRequest === undefined ||
        task.branch === undefined ||
        task.worktreePath === undefined
      ) {
        return fail('タスクのPRかブランチが記録されていない');
      }
      const state = await ports.fetchPullRequestState(repoRoot, task.pullRequest.number);
      if (state !== 'open') {
        return fail(`PR #${String(task.pullRequest.number)}がopenでない（${state}）`);
      }
      const [remote, local] = await Promise.all([
        ports.remoteBranchHead(repoRoot, task.branch),
        ports.localHead(task.worktreePath),
      ]);
      if (remote === undefined || remote === null || local === undefined || remote !== local) {
        return fail(`ブランチ ${task.branch} の先頭がpushされていない`);
      }
      return { ok: true, output: reported };
    }
    case 'mergeCleanup': {
      if (task.pullRequest === undefined || task.branch === undefined) {
        return fail('タスクのPRかブランチが記録されていない');
      }
      const state = await ports.fetchPullRequestState(repoRoot, task.pullRequest.number);
      if (state !== 'merged') {
        return fail(`PR #${String(task.pullRequest.number)}がmergeされていない（${state}）`);
      }
      const remote = await ports.remoteBranchHead(repoRoot, task.branch);
      if (remote !== null) {
        return fail(
          remote === undefined
            ? `リモートブランチ ${task.branch} の有無を確かめられない`
            : `リモートブランチ ${task.branch} が残っている`,
        );
      }
      return { ok: true, output: reported };
    }
  }
}

/** `gh issue view --json title`と`glab api projects/:id/issues/<n>`の出力は、どちらも`title`を持つ。 */
function parseIssueTitle(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const title = (parsed as Record<string, unknown>).title;
    return typeof title === 'string' ? title : undefined;
  } catch {
    return undefined;
  }
}

/** `git`と`gh`／`glab`で観測の口を作る。 */
export function createStageObservationPorts(ports: RoadmapRunForgePorts): StageObservationPorts {
  return {
    async fetchIssueTitle(repoRoot, issueNumber) {
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        return undefined;
      }
      const host = await detectRoadmapForgeHost(ports, repoRoot);
      if (host === undefined) {
        return undefined;
      }
      const result =
        host === 'github'
          ? await ports.cli.run(
              'gh',
              ['issue', 'view', String(issueNumber), '--json', 'title'],
              repoRoot,
            )
          : await ports.cli.run(
              'glab',
              ['api', `projects/:id/issues/${String(issueNumber)}`],
              repoRoot,
            );
      return result.code === 0 ? parseIssueTitle(result.stdout) : undefined;
    },
    findPullRequest: (repoRoot, branch) => findRoadmapPullRequest(ports, repoRoot, branch),
    async fetchPullRequestState(repoRoot, pullRequestNumber) {
      const host = await detectRoadmapForgeHost(ports, repoRoot);
      if (host === undefined) {
        return 'unknown';
      }
      return (await fetchPullRequestStatus(ports.cli, host, repoRoot, pullRequestNumber)).state;
    },
    async remoteBranchHead(repoRoot, branch) {
      const result = await ports.git.run(
        ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
        repoRoot,
      );
      if (result.code !== 0) {
        return undefined;
      }
      const sha = result.stdout.trim().split(/\s+/u)[0];
      return sha === undefined || sha === '' ? null : sha;
    },
    async localHead(worktreePath) {
      const result = await ports.git.run(['rev-parse', 'HEAD'], worktreePath);
      const sha = result.stdout.trim();
      return result.code === 0 && /^[0-9a-f]{7,64}$/u.test(sha) ? sha : undefined;
    },
  };
}
