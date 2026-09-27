import {
  fetchIssueBody,
  nodeForgeFileSystem,
  updateIssue,
  type CliCommandRunner,
  type ForgeHost,
} from './forge';
import {
  extractRoadmapChildren,
  findRoadmapPlanSection,
  parseRoadmapPlanSection,
  writeRoadmapPlan,
  type RoadmapChild,
} from './roadmapImport';
import { runExclusiveOnRoadmapIssue } from './roadmapIssueSync';
import { hashRoadmapPlanSectionContent } from './roadmapPlanHash';
import { detectRoadmapForgeHost } from './roadmapRunForge';
import type { RoadmapPlanNode } from './roadmapShared';
import type { GitCommandRunner } from './worktree';

/**
 * オーケストレータモードのrunが実行中にロードマップIssueを読み書きする口（Issue #1623）。
 * 書き込みはIssueごとに直列化し（`runExclusiveOnRoadmapIssue`）、書く直前に本文を読み直す。
 */

export type RoadmapPlanRead =
  | { kind: 'absent' }
  /** 区画の子Issueとの1対1は問わない（行を足した直後は区画に無い子Issueがあるため）。 */
  | { kind: 'valid'; nodes: RoadmapPlanNode[]; sectionHash: string }
  | { kind: 'invalid'; errors: string[] };

export type RoadmapReadOutcome =
  | { kind: 'read'; children: RoadmapChild[]; plan: RoadmapPlanRead }
  | { kind: 'failed'; message: string };

export type RoadmapEditOutcome =
  | { kind: 'written' }
  | { kind: 'unchanged' }
  | { kind: 'failed'; message: string };

export type RoadmapPlanWriteOutcome =
  | { kind: 'written'; nodes: RoadmapPlanNode[]; sectionHash: string }
  /** 読み直した区画が`replaceSectionHash`と違った（人が手で直した）。上書きしない。 */
  | { kind: 'sectionChanged' }
  | { kind: 'failed'; message: string };

export interface TaskRunRoadmapPort {
  read(workspaceRoot: string, roadmapIssueNumber: number): Promise<RoadmapReadOutcome>;
  /** 本文を書き換える。`edit`が`undefined`を返したら書かない。 */
  edit(
    workspaceRoot: string,
    roadmapIssueNumber: number,
    edit: (body: string) => string | undefined,
  ): Promise<RoadmapEditOutcome>;
  /**
   * 計画区画を書き戻す。区画が無ければ足し、あれば中身のハッシュが`replaceSectionHash`と合うときだけ
   * 置き換える。
   */
  writePlan(
    workspaceRoot: string,
    roadmapIssueNumber: number,
    plan: (children: readonly RoadmapChild[]) => readonly RoadmapPlanNode[],
    replaceSectionHash: string | undefined,
  ): Promise<RoadmapPlanWriteOutcome>;
}

export function createTaskRunRoadmapPort(ports: {
  git: GitCommandRunner;
  cli: CliCommandRunner;
}): TaskRunRoadmapPort {
  const deps = { cli: ports.cli, fs: nodeForgeFileSystem };
  const hostOf = async (workspaceRoot: string): Promise<ForgeHost | undefined> =>
    detectRoadmapForgeHost(ports, workspaceRoot);
  const noHost = 'originがGitHub/GitLabのリポジトリではないため、ロードマップIssueを読めません';
  const noBody = (n: number): string =>
    `ロードマップIssue #${String(n)} の本文を取得できませんでした`;
  return {
    async read(workspaceRoot, roadmapIssueNumber) {
      const host = await hostOf(workspaceRoot);
      if (host === undefined) {
        return { kind: 'failed', message: noHost };
      }
      const body = await fetchIssueBody(ports.cli, host, workspaceRoot, roadmapIssueNumber);
      if (body === undefined) {
        return { kind: 'failed', message: noBody(roadmapIssueNumber) };
      }
      return {
        kind: 'read',
        children: extractRoadmapChildren(body).children,
        plan: readPlanSection(body),
      };
    },
    async edit(workspaceRoot, roadmapIssueNumber, edit) {
      const host = await hostOf(workspaceRoot);
      if (host === undefined) {
        return { kind: 'failed', message: noHost };
      }
      return runExclusiveOnRoadmapIssue(host, workspaceRoot, roadmapIssueNumber, async () => {
        const body = await fetchIssueBody(ports.cli, host, workspaceRoot, roadmapIssueNumber);
        if (body === undefined) {
          return { kind: 'failed', message: noBody(roadmapIssueNumber) };
        }
        const next = edit(body);
        if (next === undefined || next === body) {
          return { kind: 'unchanged' };
        }
        const outcome = await updateIssue(deps, {
          host,
          cwd: workspaceRoot,
          number: roadmapIssueNumber,
          body: next,
        });
        return outcome.ok ? { kind: 'written' } : { kind: 'failed', message: outcome.message };
      });
    },
    async writePlan(workspaceRoot, roadmapIssueNumber, plan, replaceSectionHash) {
      const host = await hostOf(workspaceRoot);
      if (host === undefined) {
        return { kind: 'failed', message: noHost };
      }
      const outcome = await writeRoadmapPlan(
        deps,
        { host, cwd: workspaceRoot, roadmapIssueNumber },
        plan,
        { replaceSectionHash },
      );
      switch (outcome.kind) {
        case 'written': {
          const written = readPlanSection(outcome.body);
          return written.kind === 'valid'
            ? { kind: 'written', nodes: written.nodes, sectionHash: written.sectionHash }
            : { kind: 'failed', message: '書き戻した計画区画を読めませんでした' };
        }
        case 'sectionExists':
          return { kind: 'sectionChanged' };
        case 'invalid':
          return { kind: 'failed', message: outcome.errors.join(' / ') };
        case 'failed':
          return { kind: 'failed', message: outcome.message };
      }
    },
  };
}

function readPlanSection(body: string): RoadmapPlanRead {
  const section = findRoadmapPlanSection(body);
  if (section.kind === 'absent') {
    return { kind: 'absent' };
  }
  if (section.kind === 'malformed') {
    return { kind: 'invalid', errors: [section.message] };
  }
  const parsed = parseRoadmapPlanSection(section.content);
  return parsed.errors.length > 0
    ? { kind: 'invalid', errors: parsed.errors }
    : {
        kind: 'valid',
        nodes: parsed.nodes,
        sectionHash: hashRoadmapPlanSectionContent(section.content),
      };
}
