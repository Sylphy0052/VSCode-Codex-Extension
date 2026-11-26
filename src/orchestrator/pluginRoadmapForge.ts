/**
 * pluginのロードマップ起票（Issue #2089）のGitHub側の入出力。別repoなので`gh -R <repo>`で行う。
 * 判断は`pluginRoadmap.ts`が持つ。
 */

import { readFile } from 'node:fs/promises';
import {
  nodeForgeFileSystem,
  parsePullRequestNumberFromUrl,
  type ForgeFileSystemPort,
} from './forge';
import type { RepoVisibility } from './lessonPromotion';
import type { PluginIssueRef, PluginRoadmapForge } from './pluginRoadmap';
import type { RoadmapRunForgePorts } from './roadmapRunForge';

const ROADMAP_LABEL = 'roadmap';
const RESEARCH_LABEL = 'research';
const LIST_LIMIT = '20';
/** `owner/name`の形だけを受ける（`gh -R`へ渡すので、先頭`-`などを弾く）。 */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

export function isPluginRepoName(value: string): boolean {
  return REPO_PATTERN.test(value);
}

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

export function createGithubPluginRoadmapForge(
  ports: RoadmapRunForgePorts,
  cwd: string,
  fsPort: ForgeFileSystemPort = nodeForgeFileSystem,
): PluginRoadmapForge {
  const gh = (args: readonly string[]) => ports.cli.run('gh', args, cwd);

  /** ラベル付きの1本を読む。無ければ`undefined`、確かめられなければ`'error'`。 */
  async function readLabeled(
    repo: string,
    label: string,
  ): Promise<PluginIssueRef | undefined | 'error'> {
    if (!isPluginRepoName(repo)) {
      return 'error';
    }
    const r = await gh([
      'issue',
      'list',
      '-R',
      repo,
      `--label=${label}`,
      '--state=open',
      `--limit=${LIST_LIMIT}`,
      '--json=number,body',
    ]);
    const parsed = r.code === 0 ? parseJson(r.stdout) : undefined;
    if (!Array.isArray(parsed)) {
      return 'error';
    }
    const first = parsed[0] as { number?: unknown; body?: unknown } | undefined;
    if (first === undefined) {
      return undefined;
    }
    return typeof first.number === 'number'
      ? { issueNumber: first.number, body: typeof first.body === 'string' ? first.body : '' }
      : 'error';
  }

  async function create(
    repo: string,
    issue: { title: string; body: string },
    labels: readonly string[],
  ): Promise<{ ok: true; issueNumber: number } | { ok: false; message: string }> {
    if (!isPluginRepoName(repo)) {
      return { ok: false, message: 'pluginのrepo名が不正' };
    }
    const bodyFile = await fsPort.writeTempFile(issue.body);
    try {
      const r = await gh([
        'issue',
        'create',
        '-R',
        repo,
        `--title=${issue.title.replace(/[\r\n]+/g, ' ')}`,
        `--body-file=${bodyFile}`,
        ...labels.map((l) => `--label=${l}`),
      ]);
      if (r.code !== 0) {
        return { ok: false, message: r.stderr.trim().slice(0, 200) || 'gh issue createが失敗' };
      }
      const n = parsePullRequestNumberFromUrl(r.stdout.trim());
      return n === undefined
        ? { ok: false, message: '起票したIssueの番号を取れない' }
        : { ok: true, issueNumber: n };
    } finally {
      await fsPort.removeTempFile(bodyFile);
    }
  }

  return {
    async repoVisibility(repo) {
      if (!isPluginRepoName(repo)) {
        return 'unknown';
      }
      const r = await gh(['repo', 'view', repo, '--json', 'visibility']);
      const parsed = r.code === 0 ? (parseJson(r.stdout) as Record<string, unknown>) : undefined;
      return toVisibility(parsed?.visibility);
    },

    readRoadmap: (repo) => readLabeled(repo, ROADMAP_LABEL),
    readResearch: (repo) => readLabeled(repo, RESEARCH_LABEL),

    async findIssueByKey(repo, key) {
      if (!isPluginRepoName(repo)) {
        return 'error';
      }
      const r = await gh([
        'issue',
        'list',
        '-R',
        repo,
        '--state=all',
        `--search=${key} in:body`,
        `--limit=${LIST_LIMIT}`,
        '--json=number,body,labels',
      ]);
      const parsed = r.code === 0 ? parseJson(r.stdout) : undefined;
      if (!Array.isArray(parsed)) {
        return 'error';
      }
      for (const i of parsed) {
        const issue = i as { number?: unknown; body?: unknown; labels?: unknown } | null;
        const labels = Array.isArray(issue?.labels)
          ? issue.labels.map((l: unknown) => (l as { name?: unknown } | null)?.name)
          : [];
        // ロードマップ・調査のIssue自身（本文にキーを載せることがある）は除く
        if (labels.includes(ROADMAP_LABEL) || labels.includes(RESEARCH_LABEL)) {
          continue;
        }
        if (
          typeof issue?.number === 'number' &&
          typeof issue.body === 'string' &&
          issue.body.includes(`<!-- self-improve-key: ${key} -->`)
        ) {
          return issue.number;
        }
      }
      return undefined;
    },

    createIssue: (repo, issue) => create(repo, issue, []),

    async createResearchIssue(repo, issue) {
      await gh([
        'label',
        'create',
        RESEARCH_LABEL,
        '-R',
        repo,
        '--color=c5def5',
        '--description=調査Issue（振り返り #2089）',
      ]);
      return create(repo, issue, [RESEARCH_LABEL]);
    },

    async updateIssueBody(repo, issueNumber, body) {
      if (!isPluginRepoName(repo)) {
        return false;
      }
      const bodyFile = await fsPort.writeTempFile(body);
      try {
        const r = await gh([
          'issue',
          'edit',
          String(issueNumber),
          '-R',
          repo,
          `--body-file=${bodyFile}`,
        ]);
        return r.code === 0;
      } finally {
        await fsPort.removeTempFile(bodyFile);
      }
    },

    async readHeadCommit(repo) {
      if (!isPluginRepoName(repo)) {
        return undefined;
      }
      const r = await gh(['api', `repos/${repo}/commits/HEAD`, '--jq', '.sha']);
      const sha = r.stdout.trim();
      return r.code === 0 && /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
    },
  };
}

/** 同期済みのcommitを書いたファイルを読む。パス未設定・読めない・SHAでないなら`undefined`。 */
export async function readSyncedCommit(file: string): Promise<string | undefined> {
  if (file === '') {
    return undefined;
  }
  try {
    const text = (await readFile(file, 'utf8')).trim().split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{7,40}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}
