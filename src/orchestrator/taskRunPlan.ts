import { stripControlCharsPreservingNewlines } from './sanitize';
import {
  allocateTaskIds,
  getTask,
  hasStarted,
  isValidTaskId,
  listTasks,
  type TaskDraft,
  type TaskRun,
} from './taskRunState';
import { findCycleGroups } from './workflow';

/**
 * オーケストレータモード（Issue #1505）の計画の提案（`propose_plan`）の検証。
 *
 * Orchestratorは新しいタスクを仮のキーで書き、Controllerがここで`taskId`を採番して置き換える。
 * 既存のタスクは`taskId`（`T<n>`）で指す。形式、重複、存在しない依存先、循環、着手済みの
 * タスクの削除をここで拒否し、理由をOrchestratorへ返す。状態へ置くのは`proposeTaskPlan`。
 */

export const MAX_PLAN_TASKS = 30;
export const MAX_PLAN_TITLE_LENGTH = 200;
export const MAX_PLAN_SUMMARY_LENGTH = 2000;
export const MAX_PLAN_CRITERIA = 20;
export const MAX_PLAN_CRITERION_LENGTH = 500;
const MAX_PLAN_DEPENDENCIES = MAX_PLAN_TASKS;

/** 計画の中でタスクを指すキー。既存のタスクは`T<n>`、新しいタスクは任意の仮キー。 */
const PLAN_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const CONTROLLER_TASK_ID = /^T[0-9]+$/;

/** `propose_plan`の1タスク。文字列は制御文字を落とし済み。 */
export interface PlanTaskInput {
  id: string;
  title: string;
  summary: string;
  acceptanceCriteria: readonly string[];
  dependsOn: readonly string[];
  existingIssueNumber: number | undefined;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): Parsed<T> {
  return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { required: boolean; singleLine: boolean },
): Parsed<string> {
  if (value === undefined && !options.required) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return fail(`${field}は文字列で指定する`);
  }
  const stripped = stripControlCharsPreservingNewlines(value);
  const cleaned = (options.singleLine ? stripped.replace(/\s+/gu, ' ') : stripped).trim();
  if (options.required && cleaned === '') {
    return fail(`${field}が空`);
  }
  if ([...cleaned].length > maxLength) {
    return fail(`${field}は${String(maxLength)}文字以内にする`);
  }
  return { ok: true, value: cleaned };
}

function parseTask(raw: unknown, index: number): Parsed<PlanTaskInput> {
  const at = `tasks[${String(index)}]`;
  if (!isRecord(raw)) {
    return fail(`${at}はオブジェクトで指定する`);
  }
  const id = raw.id;
  if (typeof id !== 'string' || !PLAN_KEY.test(id)) {
    return fail(`${at}.idは英数字・_・-の1〜32文字で指定する`);
  }
  const title = readText(raw.title, `${at}.title`, MAX_PLAN_TITLE_LENGTH, {
    required: true,
    singleLine: true,
  });
  if (!title.ok) {
    return title;
  }
  const summary = readText(raw.summary, `${at}.summary`, MAX_PLAN_SUMMARY_LENGTH, {
    required: true,
    singleLine: false,
  });
  if (!summary.ok) {
    return summary;
  }
  const criteriaRaw = raw.acceptanceCriteria;
  if (
    !Array.isArray(criteriaRaw) ||
    criteriaRaw.length === 0 ||
    criteriaRaw.length > MAX_PLAN_CRITERIA
  ) {
    return fail(`${at}.acceptanceCriteriaは1〜${String(MAX_PLAN_CRITERIA)}件の配列で指定する`);
  }
  const acceptanceCriteria: string[] = [];
  for (const [i, item] of criteriaRaw.entries()) {
    const criterion = readText(
      item,
      `${at}.acceptanceCriteria[${String(i)}]`,
      MAX_PLAN_CRITERION_LENGTH,
      { required: true, singleLine: true },
    );
    if (!criterion.ok) {
      return criterion;
    }
    acceptanceCriteria.push(criterion.value);
  }
  const depsRaw = raw.dependsOn ?? [];
  if (
    !Array.isArray(depsRaw) ||
    depsRaw.length > MAX_PLAN_DEPENDENCIES ||
    depsRaw.some((d) => typeof d !== 'string' || !PLAN_KEY.test(d))
  ) {
    return fail(`${at}.dependsOnは計画内のidの配列で指定する`);
  }
  const dependsOn = depsRaw as string[];
  if (new Set(dependsOn).size !== dependsOn.length) {
    return fail(`${at}.dependsOnに同じidが重複している`);
  }
  if (dependsOn.includes(id)) {
    return fail(`${at}（${id}）が自分自身に依存している`);
  }
  const issue = raw.existingIssueNumber;
  if (issue !== undefined && (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1)) {
    return fail(`${at}.existingIssueNumberは1以上の整数で指定する`);
  }
  return {
    ok: true,
    value: {
      id,
      title: title.value,
      summary: summary.value,
      acceptanceCriteria,
      dependsOn,
      existingIssueNumber: issue,
    },
  };
}

/** `propose_plan`の引数の形式を検証する。長さ・件数の超過は切り詰めずに拒否し、書き直させる。 */
export function parsePlanArgs(raw: unknown): Parsed<PlanTaskInput[]> {
  const tasksRaw = isRecord(raw) ? raw.tasks : undefined;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0 || tasksRaw.length > MAX_PLAN_TASKS) {
    return fail(`tasksは1〜${String(MAX_PLAN_TASKS)}件の配列で指定する`);
  }
  const tasks: PlanTaskInput[] = [];
  for (const [i, item] of tasksRaw.entries()) {
    const parsed = parseTask(item, i);
    if (!parsed.ok) {
      return parsed;
    }
    tasks.push(parsed.value);
  }
  return { ok: true, value: tasks };
}

export interface ResolvedTaskPlan {
  /** 新しいタスクの`taskId`を採番したrun。`proposeTaskPlan`へ渡す。 */
  run: TaskRun;
  drafts: TaskDraft[];
  /** 仮キーから採番した`taskId`への対応。既存のタスクは含めない。 */
  assigned: ReadonlyMap<string, string>;
}

/**
 * 計画をrunと突き合わせて検証し、仮キーを`taskId`へ置き換える。
 *
 * - `T<n>`の形のキーは既存のタスクだけを指せる（Controllerが採番する番号を名乗らせない）
 * - 依存先は計画内のキーだけ。循環は循環するキーの組を挙げて拒否する
 * - 着手済みのタスクは計画から外せず、既存のIssue番号も変えられない
 * - 既存のIssue番号は計画内で重複させない
 */
export function resolveTaskPlan(run: TaskRun, tasks: readonly PlanTaskInput[]): Parsed<ResolvedTaskPlan> {
  if (run.finishedAt !== undefined) {
    return fail('このrunは終わっている');
  }
  const keys = new Set(tasks.map((t) => t.id));
  if (keys.size !== tasks.length) {
    return fail('idが重複している');
  }
  for (const task of tasks) {
    if (CONTROLLER_TASK_ID.test(task.id) && getTask(run, task.id) === undefined) {
      return fail(
        `${task.id}は既存のタスクではない。T<数字>の形は既存のタスクにだけ使い、新しいタスクには別の仮キー（例: new1）を付ける`,
      );
    }
    const unknown = task.dependsOn.find((dep) => !keys.has(dep));
    if (unknown !== undefined) {
      return fail(`${task.id}の依存先${unknown}が計画に無い`);
    }
  }
  const cycles = findCycleGroups(tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn })));
  if (cycles.length > 0) {
    return fail(`依存が循環している: ${cycles.map((group) => group.join(' → ')).join(' / ')}`);
  }
  const issueOwner = new Map<number, string>();
  for (const task of tasks) {
    if (task.existingIssueNumber === undefined) {
      continue;
    }
    const other = issueOwner.get(task.existingIssueNumber);
    if (other !== undefined) {
      return fail(
        `既存のIssue #${String(task.existingIssueNumber)}が${other}と${task.id}で重複している`,
      );
    }
    issueOwner.set(task.existingIssueNumber, task.id);
  }
  const removed = listTasks(run).find((t) => !keys.has(t.taskId) && hasStarted(t));
  if (removed !== undefined) {
    return fail(`着手済みのタスク${removed.taskId}は計画から外せない`);
  }
  for (const task of tasks) {
    const existing = getTask(run, task.id);
    if (
      existing !== undefined &&
      hasStarted(existing) &&
      existing.existingIssueNumber !== task.existingIssueNumber
    ) {
      return fail(`着手済みのタスク${task.id}の既存のIssue番号は変えられない`);
    }
  }

  const fresh = tasks.filter((t) => getTask(run, t.id) === undefined);
  const allocated = allocateTaskIds(run, fresh.length);
  const assigned = new Map(fresh.map((t, i) => [t.id, allocated.taskIds[i] ?? '']));
  const toTaskId = (key: string): string => assigned.get(key) ?? key;
  const drafts = tasks.map(
    (t): TaskDraft => ({
      taskId: toTaskId(t.id),
      title: t.title,
      summary: t.summary,
      acceptanceCriteria: t.acceptanceCriteria,
      dependsOn: t.dependsOn.map(toTaskId),
      existingIssueNumber: t.existingIssueNumber,
    }),
  );
  if (drafts.some((d) => !isValidTaskId(d.taskId))) {
    return fail('taskIdを採番できなかった');
  }
  return { ok: true, value: { run: allocated.run, drafts, assigned } };
}
