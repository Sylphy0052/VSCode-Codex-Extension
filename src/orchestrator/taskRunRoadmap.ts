import { ISSUE_CHECKLIST_LINE_PATTERN } from './roadmap';
import type { RoadmapChild } from './roadmapImport';
import type { RoadmapPlanNode } from './roadmapShared';
import { MAX_PLAN_TITLE_LENGTH, type PlanTaskInput } from './taskRunPlan';
import {
  listTasks,
  type OrchestratedTask,
  type TaskRun,
  type TaskRunRoadmapSnapshot,
} from './taskRunState';
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
  /** 計画区画の中身のハッシュ（`hashRoadmapPlanSectionContent`）。区画が無ければ`undefined`。 */
  planSectionHash: string | undefined;
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
  return { tasks, snapshot: buildRoadmapSnapshot(input) };
}

export type RoadmapSnapshotInput = Omit<RoadmapInitialPlanInput, 'roadmapIssueNumber'>;

/** 読んだロードマップを、次に読み直したときの差分の基準（`TaskRun.roadmap.snapshot`）にする。 */
export function buildRoadmapSnapshot(input: RoadmapSnapshotInput): TaskRunRoadmapSnapshot {
  return {
    children: input.children.map((c) => ({
      issueNumber: c.issueNumber,
      title: c.title,
      completed: c.checked || input.closedIssueNumbers.has(c.issueNumber),
    })),
    plan: input.planNodes?.map((n) => ({ issueNumber: n.issueNumber, dependsOn: [...n.dependsOn] })),
    planSectionHash: input.planSectionHash,
    readAt: input.now.toISOString(),
  };
}

export interface RoadmapChangeDraft {
  kind: 'childrenAdded' | 'childrenRemoved' | 'planChanged';
  /** 番号だけで組み立てた文。子Issueのタイトル（外部由来）は入れない。 */
  body: string;
}

/**
 * このrun自身が起こしたロードマップの変化。読み直したときに差分として届けない（Orchestratorは
 * 既に知っている）。
 */
export interface OwnRoadmapChanges {
  /** このrunのタスクが持つIssue番号（追記した行が「追加」に見えるため）。 */
  taskIssueNumbers: ReadonlySet<number>;
  /** このrunでmergeまで済んだタスクのIssue番号（`[x]`にした行が「close」に見えるため）。 */
  mergedIssueNumbers: ReadonlySet<number>;
}

/**
 * 前回読んだときとの差分を、子Issueの追加・子Issueの削除とclose・計画区画の依存と並び順の変更に
 * 分ける。差分が無ければ空。計画区画が読めなかったときは、呼び出し側が`after`の計画を前回のまま
 * にして警告を出す。
 */
export function diffRoadmapSnapshots(
  before: TaskRunRoadmapSnapshot,
  after: TaskRunRoadmapSnapshot,
  own: OwnRoadmapChanges,
): RoadmapChangeDraft[] {
  const drafts: RoadmapChangeDraft[] = [];
  const beforeByNumber = new Map(before.children.map((c) => [c.issueNumber, c]));
  const afterNumbers = new Set(after.children.map((c) => c.issueNumber));
  const added = after.children
    .map((c) => c.issueNumber)
    .filter((n) => !beforeByNumber.has(n) && !own.taskIssueNumbers.has(n));
  if (added.length > 0) {
    drafts.push({
      kind: 'childrenAdded',
      body:
        `ロードマップに子Issueが追加されました: ${formatIssueList(added)}。` +
        '計画に入れるならpropose_planで既存Issue（existingIssueNumber）のタスクとして足してください',
    });
  }
  const removed = before.children
    .map((c) => c.issueNumber)
    .filter((n) => !afterNumbers.has(n));
  const closed = after.children
    .filter((c) => c.completed && beforeByNumber.get(c.issueNumber)?.completed === false)
    .map((c) => c.issueNumber)
    .filter((n) => !own.mergedIssueNumbers.has(n));
  if (removed.length > 0 || closed.length > 0) {
    const parts = [
      ...(removed.length > 0 ? [`行が消えた子Issue: ${formatIssueList(removed)}`] : []),
      ...(closed.length > 0 ? [`完了（[x]またはclose）になった子Issue: ${formatIssueList(closed)}`] : []),
    ];
    drafts.push({
      kind: 'childrenRemoved',
      body:
        `ロードマップの子Issueが削除・closeされました（${parts.join('、')}）。` +
        '計画から外すならpropose_planでそのタスクを除いた計画を出してください',
    });
  }
  if (!samePlan(before, after)) {
    drafts.push({
      kind: 'planChanged',
      body:
        'ロードマップの計画区画の依存・並び順が変わりました。新しい区画: ' +
        (after.plan === undefined ? '（区画なし）' : formatPlan(after.plan)) +
        '。反映するならpropose_planで依存を合わせた計画を出してください',
    });
  }
  return drafts;
}

function samePlan(before: TaskRunRoadmapSnapshot, after: TaskRunRoadmapSnapshot): boolean {
  if (before.plan === undefined && after.plan === undefined) {
    // 区画が無ければ子Issueの並びが着手順になる。追加・削除は別の差分で届けるため、両方にある
    // 子Issueの並びだけを比べる
    const afterNumbers = new Set(after.children.map((c) => c.issueNumber));
    const beforeNumbers = new Set(before.children.map((c) => c.issueNumber));
    const order = (s: TaskRunRoadmapSnapshot): string =>
      s.children
        .filter((c) => afterNumbers.has(c.issueNumber) && beforeNumbers.has(c.issueNumber))
        .map((c) => String(c.issueNumber))
        .join(',');
    return order(before) === order(after);
  }
  const key = (s: TaskRunRoadmapSnapshot): string =>
    s.plan === undefined ? '' : formatPlan(s.plan);
  return key(before) === key(after);
}

function formatPlan(plan: NonNullable<TaskRunRoadmapSnapshot['plan']>): string {
  return plan
    .map(
      (n) =>
        `#${String(n.issueNumber)}（依存: ${n.dependsOn.length === 0 ? 'なし' : formatIssueList(n.dependsOn)}）`,
    )
    .join(' → ');
}

function formatIssueList(numbers: readonly number[]): string {
  return numbers.map((n) => `#${String(n)}`).join(', ');
}

/** タスクが指すIssue番号（既存Issueの指定、または作ったIssue）。 */
export function taskIssueNumber(task: OrchestratedTask): number | undefined {
  return task.existingIssueNumber ?? task.issueNumber;
}

/**
 * 計画のうち、ロードマップの子Issueに無い既存Issueを指すタスクの番号。拒否せず警告に使う
 * （Orchestratorが関連Issueを足す場合がある）。
 */
export function findIssuesOutsideRoadmap(
  tasks: readonly PlanTaskInput[],
  snapshot: TaskRunRoadmapSnapshot,
): number[] {
  const children = new Set(snapshot.children.map((c) => c.issueNumber));
  return [
    ...new Set(
      tasks
        .map((t) => t.existingIssueNumber)
        .filter((n): n is number => n !== undefined && !children.has(n)),
    ),
  ];
}

/**
 * 承認された計画を、計画区画のノードにする。区画は子Issueと1対1でなければならない
 * （`validateRoadmapPlan`）ため、計画の順に子Issueのタスクを並べ、計画に無い子Issue（外した・
 * まだ入れていない）は前回の区画の依存のまま後ろに置く。Issueの無いタスクへの依存は落とす。
 */
export function buildRoadmapPlanNodes(
  run: TaskRun,
  children: readonly RoadmapChild[],
): RoadmapPlanNode[] {
  const childNumbers = new Set(children.map((c) => c.issueNumber));
  const tasks = listTasks(run);
  const issueByTaskId = new Map(
    tasks.flatMap((t) => {
      const n = taskIssueNumber(t);
      return n === undefined ? [] : [[t.taskId, n] as const];
    }),
  );
  const nodes: RoadmapPlanNode[] = [];
  const placed = new Set<number>();
  for (const task of tasks) {
    const n = taskIssueNumber(task);
    if (n === undefined || !childNumbers.has(n) || placed.has(n)) {
      continue;
    }
    placed.add(n);
    nodes.push({
      issueNumber: n,
      dependsOn: task.dependsOn
        .map((id) => issueByTaskId.get(id))
        .filter((d): d is number => d !== undefined && childNumbers.has(d)),
      wave: undefined,
    });
  }
  const previous = new Map(
    (run.roadmap?.snapshot.plan ?? []).map((node) => [node.issueNumber, node.dependsOn]),
  );
  for (const child of children) {
    if (placed.has(child.issueNumber)) {
      continue;
    }
    nodes.push({
      issueNumber: child.issueNumber,
      dependsOn: (previous.get(child.issueNumber) ?? []).filter((d) => childNumbers.has(d)),
      wave: undefined,
    });
  }
  return nodes;
}

/**
 * 子Issueの行を本文へ足す（`- [ ] #IID: タイトル`）。最後の子Issueの行の直後に入れ、子Issueの
 * 行が無ければ本文の末尾に足す。既に子Issueの行があれば`undefined`。改行コードは本文に合わせる。
 */
export function appendRoadmapChild(
  body: string,
  issueNumber: number,
  title: string,
): string | undefined {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  let last = -1;
  for (const [i, line] of lines.entries()) {
    const match = ISSUE_CHECKLIST_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    if (Number(match[4]) === issueNumber) {
      return undefined;
    }
    last = i;
  }
  const oneLine = sanitizeInlineText(title, MAX_PLAN_TITLE_LENGTH);
  const entry = `- [ ] #${String(issueNumber)}${oneLine === '' ? '' : `: ${oneLine}`}`;
  if (last === -1) {
    const separator = body === '' ? '' : body.endsWith(eol) ? eol : eol + eol;
    return `${body}${separator}${entry}${eol}`;
  }
  return [...lines.slice(0, last + 1), entry, ...lines.slice(last + 1)].join(eol);
}
