import type { RoadmapChild } from './roadmapImport';
import type { RoadmapPlanNode } from './roadmapShared';
import { MAX_PLAN_TITLE_LENGTH, type PlanTaskInput } from './taskRunPlan';
import type { TaskRunRoadmapSnapshot } from './taskRunState';
import { sanitizeInlineText } from './untrustedText';

/**
 * ロードマップIssueから始めるrun（Issue #1623）の初期計画とスナップショットを作る純関数。
 * forgeからの取得は呼び出し側（`TaskRunController.startRun`）が済ませる。
 */

/** 初期計画でロードマップの子Issueを指す仮キー。 */
export function roadmapTaskKey(issueNumber: number): string {
  return `issue${String(issueNumber)}`;
}

export interface RoadmapInitialPlanInput {
  roadmapIssueNumber: number;
  children: readonly RoadmapChild[];
  /** 計画区画のノード。区画が無い・検証に通らなければ`undefined`（子の並びをそのまま使う）。 */
  planNodes: readonly RoadmapPlanNode[] | undefined;
  /** `- [ ]`のままcloseされている子Issue。完了済みとして置く。 */
  closedIssueNumbers: ReadonlySet<number>;
  now: Date;
}

export interface RoadmapInitialPlan {
  tasks: PlanTaskInput[];
  snapshot: TaskRunRoadmapSnapshot;
}

/**
 * 子Issueを計画のタスクへ変える。`- [ ] #N`は既存Issueのタスク、`- [x] #N`とcloseされた子は
 * 完了済みのタスクにする。計画区画があれば依存と並び順をそこから取る（区画は子と1対1で
 * 検証済みの前提。`validateRoadmapPlan`）。
 */
export function buildRoadmapInitialPlan(input: RoadmapInitialPlanInput): RoadmapInitialPlan {
  const completed = new Set(
    input.children
      .filter((c) => c.checked || input.closedIssueNumbers.has(c.issueNumber))
      .map((c) => c.issueNumber),
  );
  const byNumber = new Map(input.children.map((c) => [c.issueNumber, c]));
  const ordered: { child: RoadmapChild; dependsOn: readonly number[] }[] =
    input.planNodes === undefined
      ? input.children.map((child) => ({ child, dependsOn: [] }))
      : input.planNodes.flatMap((node) => {
          const child = byNumber.get(node.issueNumber);
          return child === undefined ? [] : [{ child, dependsOn: node.dependsOn }];
        });
  const tasks = ordered.map(
    ({ child, dependsOn }): PlanTaskInput => ({
      id: roadmapTaskKey(child.issueNumber),
      title:
        child.title === ''
          ? `Issue #${String(child.issueNumber)}`
          : sanitizeInlineText(child.title, MAX_PLAN_TITLE_LENGTH),
      summary: `ロードマップIssue #${String(input.roadmapIssueNumber)}の子Issue #${String(child.issueNumber)}。内容はIssueの本文に従う。`,
      acceptanceCriteria: [`Issue #${String(child.issueNumber)}の受入基準を満たす`],
      // 完了済みの子の依存は着手の判断に使わないため持たせない
      dependsOn: completed.has(child.issueNumber)
        ? []
        : dependsOn.filter((n) => byNumber.has(n)).map(roadmapTaskKey),
      existingIssueNumber: child.issueNumber,
      ...(completed.has(child.issueNumber) ? { completedInRoadmap: true as const } : {}),
    }),
  );
  return {
    tasks,
    snapshot: {
      children: input.children.map((c) => ({
        issueNumber: c.issueNumber,
        title: c.title,
        completed: completed.has(c.issueNumber),
      })),
      plan: input.planNodes?.map((n) => ({ issueNumber: n.issueNumber, dependsOn: [...n.dependsOn] })),
      readAt: input.now.toISOString(),
    },
  };
}
