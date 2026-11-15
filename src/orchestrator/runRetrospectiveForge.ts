/**
 * 振り返り（Issue #2086）のGitHub側の入出力。`gh`と`git`だけで行い、判断は`runRetrospective.ts`が持つ。
 */

import {
  createIssue,
  nodeForgeFileSystem,
  parsePullRequestNumberFromUrl,
  type ForgeFileSystemPort,
} from './forge';
import type { RepoVisibility } from './lessonPromotion';
import { detectRoadmapForgeHost, type RoadmapRunForgePorts } from './roadmapRunForge';
import type { MergeState, RetrospectiveForge } from './runRetrospective';
import { parseProtectedPaths, SELF_IMPROVE_PROTECTED_PATHS_FILE } from './selfImproveGuard';

const LABEL_COLORS: Record<string, string> = { 'self-improve': '5319e7', research: 'c5def5' };
const LIST_LIMIT = '1000';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toVisibility(value: unknown): RepoVisibility {
  switch (typeof value === 'string' ? value.toLowerCase() : '') {
    case 'public':
      return 'public';
    case 'private':
      return 'private';
    case 'internal':
      return 'internal';
    default:
      return 'unknown';
  }
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((l: unknown) => {
        const name = (l as { name?: unknown } | null)?.name;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
}

export function createGithubRetrospectiveForge(
  ports: RoadmapRunForgePorts,
  fsPort: ForgeFileSystemPort = nodeForgeFileSystem,
): RetrospectiveForge {
  const gh = (args: readonly string[], root: string) => ports.cli.run('gh', args, root);
  return {
    async isGithub(root) {
      return (await detectRoadmapForgeHost(ports, root)) === 'github';
    },

    async repoInfo(root) {
      const r = await gh(['repo', 'view', '--json', 'nameWithOwner,visibility'], root);
      const parsed = r.code === 0 ? (parseJson(r.stdout) as Record<string, unknown>) : undefined;
      const name = parsed?.nameWithOwner;
      return {
        nameWithOwner: typeof name === 'string' ? name : '',
        // 名前が取れないときは公開範囲も信用しない（起票しない側へ倒す）
        visibility: typeof name === 'string' ? toVisibility(parsed?.visibility) : 'unknown',
      };
    },

    async listSelfImproveIssueNumbers(root) {
      const r = await gh(
        [
          'issue',
          'list',
          '--label=self-improve',
          '--state=all',
          `--limit=${LIST_LIMIT}`,
          '--json=number',
        ],
        root,
      );
      const parsed = r.code === 0 ? parseJson(r.stdout) : undefined;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed.flatMap((i: unknown) => {
        const n = (i as { number?: unknown } | null)?.number;
        return typeof n === 'number' ? [n] : [];
      });
    },

    async findIssueByKey(root, key) {
      const r = await gh(
        [
          'issue',
          'list',
          '--state=all',
          `--search=${key} in:body`,
          '--limit=20',
          '--json=number,body',
        ],
        root,
      );
      const parsed = r.code === 0 ? parseJson(r.stdout) : undefined;
      if (!Array.isArray(parsed)) {
        return 'error';
      }
      // 検索は部分一致・語の分割で広く当たるので、本文にキーがそのまま入っているものだけを採る
      for (const i of parsed) {
        const issue = i as { number?: unknown; body?: unknown } | null;
        if (
          typeof issue?.number === 'number' &&
          typeof issue.body === 'string' &&
          issue.body.includes(`\`${key}\``)
        ) {
          return issue.number;
        }
      }
      return undefined;
    },

    async ensureLabel(root, name) {
      // 既にあれば失敗するだけ。無いラベルを付けた起票は失敗するので先に作る
      await gh(
        [
          'label',
          'create',
          name,
          `--color=${LABEL_COLORS[name] ?? 'ededed'}`,
          '--description=振り返り（Issue #2086）が使うラベル',
        ],
        root,
      );
    },

    async createIssue(root, issue) {
      const outcome = await createIssue(
        { cli: ports.cli, fs: fsPort },
        {
          host: 'github',
          cwd: root,
          title: issue.title,
          body: issue.body,
          labels: issue.labels.join(','),
        },
      );
      if (!outcome.ok) {
        return { ok: false, message: outcome.message };
      }
      const n = outcome.url === undefined ? undefined : parsePullRequestNumberFromUrl(outcome.url);
      return n === undefined
        ? { ok: false, message: '起票したIssueの番号を取れない' }
        : { ok: true, issueNumber: n };
    },

    async readMergeState(root, issueNumber): Promise<MergeState> {
      const v = await gh(
        [
          'issue',
          'view',
          String(issueNumber),
          '--json=state,stateReason,closedByPullRequestsReferences',
        ],
        root,
      );
      const issue =
        v.code === 0
          ? (parseJson(v.stdout) as {
              state?: unknown;
              stateReason?: unknown;
              closedByPullRequestsReferences?: unknown;
            })
          : undefined;
      if (issue === undefined) {
        return { state: 'unknown', reason: `Issue #${String(issueNumber)}を読めない` };
      }
      if (issue.state === 'OPEN') {
        return { state: 'open' };
      }
      const refs = Array.isArray(issue.closedByPullRequestsReferences)
        ? issue.closedByPullRequestsReferences.flatMap((p: unknown) => {
            const n = (p as { number?: unknown } | null)?.number;
            return typeof n === 'number' ? [n] : [];
          })
        : [];
      if (issue.stateReason === 'NOT_PLANNED' || refs.length === 0) {
        return { state: 'closedWithoutMerge' };
      }
      for (const prNumber of refs) {
        const p = await gh(
          ['pr', 'view', String(prNumber), '--json=state,mergedAt,mergeCommit'],
          root,
        );
        const pr =
          p.code === 0
            ? (parseJson(p.stdout) as {
                state?: unknown;
                mergedAt?: unknown;
                mergeCommit?: unknown;
              })
            : undefined;
        const oid = (pr?.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
        if (pr?.state !== 'MERGED' || typeof pr.mergedAt !== 'string' || typeof oid !== 'string') {
          continue;
        }
        const pkg = await gh(
          [
            'api',
            '-H',
            'Accept: application/vnd.github.raw+json',
            `repos/{owner}/{repo}/contents/package.json?ref=${oid}`,
          ],
          root,
        );
        const version = (parseJson(pkg.stdout) as { version?: unknown } | undefined)?.version;
        if (pkg.code !== 0 || typeof version !== 'string') {
          return { state: 'unknown', reason: `PR #${String(prNumber)}の版を読めない` };
        }
        return {
          state: 'merged',
          mergedAt: Date.parse(pr.mergedAt),
          version,
          pullRequestNumber: prNumber,
          mergeCommit: oid,
        };
      }
      return { state: 'closedWithoutMerge' };
    },

    async readProtectedPaths(root) {
      const r = await ports.git.run(
        ['show', `origin/main:${SELF_IMPROVE_PROTECTED_PATHS_FILE}`],
        root,
      );
      return r.code === 0 ? parseProtectedPaths(r.stdout) : undefined;
    },

    async readIssueInfo(root, issueNumber) {
      const r = await gh(['issue', 'view', String(issueNumber), '--json=state,labels,title'], root);
      const parsed =
        r.code === 0
          ? (parseJson(r.stdout) as { state?: unknown; labels?: unknown; title?: unknown })
          : undefined;
      if (parsed === undefined || typeof parsed.title !== 'string') {
        return undefined;
      }
      return {
        open: parsed.state === 'OPEN',
        labels: labelNames(parsed.labels),
        title: parsed.title,
      };
    },
  };
}
