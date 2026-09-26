import { listQuestionsAwaitingUser } from '../orchestrator/taskRunQuestions';
import {
  assessTaskRun,
  countActiveStageSessions,
  unmetTaskDependencies,
  type TaskRunAssessment,
} from '../orchestrator/taskRunScheduler';
import {
  currentStage,
  DEPENDENCY_GATED_STAGES,
  hasStarted,
  isTaskDone,
  listTasks,
  type OrchestratedTask,
  type StageQuestion,
  type TaskPlanStatus,
  type TaskRun,
  type TaskRunEngine,
  type TaskStage,
} from '../orchestrator/taskRunState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

/**
 * オーケストレータモード（Issue #1505）のKanbanの盤面。列は工程別（計画承認待ち / Issue計画 /
 * Issue作成 / 実装 / レビュー / mergeとcleanup / 完了）で、依存待ち・ユーザー判断待ち・失敗・
 * 停止はバッジで示す。状態の判断はここで済ませ、webviewは描くだけにする。
 */

export const TASK_RUN_KANBAN_COLUMNS = [
  'planApproval',
  'issuePlan',
  'issueCreate',
  'implement',
  'review',
  'mergeCleanup',
  'done',
] as const;
export type TaskRunKanbanColumn = (typeof TASK_RUN_KANBAN_COLUMNS)[number];

const TITLE_MAX_LENGTH = 200;
const SUMMARY_MAX_LENGTH = 300;
const FAILURE_MAX_LENGTH = 300;

export interface TaskRunKanbanBadge {
  label: string;
  tone: '' | 'warn' | 'ok';
}

export interface TaskRunKanbanQuestion {
  questionId: string;
  question: string;
  reason: string;
  evidence: string | undefined;
  options: readonly string[];
  recommended: string | undefined;
  blocking: boolean;
  reflexSummary: string | undefined;
}

export interface TaskRunKanbanCard {
  taskId: string;
  title: string;
  summary: string;
  column: TaskRunKanbanColumn;
  badges: TaskRunKanbanBadge[];
  dependsOn: { taskId: string; satisfied: boolean }[];
  issueNumber: number | undefined;
  pullRequest: { number: number; url: string } | undefined;
  failure: string | undefined;
  /** 今の工程の実行回数。 */
  attempts: number;
  canStop: boolean;
  canRetry: boolean;
  canReveal: boolean;
  questions: TaskRunKanbanQuestion[];
}

export interface TaskRunKanbanRunSummary {
  runId: string;
  workspaceRoot: string;
  engine: TaskRunEngine;
  startedAt: string;
  finished: boolean;
}

export interface TaskRunKanbanRun {
  runId: string;
  workspaceRoot: string;
  engine: TaskRunEngine;
  maxParallel: number;
  planStatus: TaskPlanStatus;
  haltedByUser: boolean;
  finished: boolean;
  assessment: TaskRunAssessment;
  activeSessions: number;
  columns: Record<TaskRunKanbanColumn, TaskRunKanbanCard[]>;
}

export interface TaskRunKanbanBoard {
  runs: TaskRunKanbanRunSummary[];
  run: TaskRunKanbanRun | undefined;
}

function columnFor(run: TaskRun, task: OrchestratedTask): TaskRunKanbanColumn {
  if (isTaskDone(task)) {
    return 'done';
  }
  if (run.planStatus !== 'approved' && !hasStarted(task)) {
    return 'planApproval';
  }
  return currentStage(task) ?? 'done';
}

function attentionBadge(task: OrchestratedTask): TaskRunKanbanBadge | undefined {
  switch (task.attention) {
    case 'awaitingUser':
      return { label: 'ユーザー判断待ち', tone: 'warn' };
    case 'needsAction':
      return { label: '要対応', tone: 'warn' };
    case 'failed':
      return { label: '失敗', tone: 'warn' };
    case 'stopping':
      return { label: '停止中', tone: '' };
    case 'stopped':
      return { label: '停止', tone: 'warn' };
    case 'none':
      return undefined;
  }
}

function stageBadges(
  run: TaskRun,
  task: OrchestratedTask,
  stage: TaskStage,
  unmet: readonly string[],
): TaskRunKanbanBadge[] {
  const record = task.stages[stage];
  if (record.status === 'running') {
    return [{ label: '実行中', tone: 'ok' }];
  }
  if (record.status !== 'notStarted' || run.planStatus !== 'approved') {
    return [];
  }
  if (DEPENDENCY_GATED_STAGES.includes(stage) && unmet.length > 0) {
    return [{ label: '依存待ち', tone: '' }];
  }
  if (record.pendingDecision !== undefined) {
    return [{ label: '開始待ち', tone: '' }];
  }
  return [{ label: 'Orchestratorの判断待ち', tone: '' }];
}

function badgesFor(run: TaskRun, task: OrchestratedTask, unmet: readonly string[]): TaskRunKanbanBadge[] {
  if (isTaskDone(task)) {
    return [];
  }
  const stage = currentStage(task);
  const badges = stage === undefined ? [] : stageBadges(run, task, stage, unmet);
  const attention = attentionBadge(task);
  return attention === undefined ? badges : [attention, ...badges];
}

function toKanbanQuestion(q: StageQuestion): TaskRunKanbanQuestion {
  return {
    questionId: q.questionId,
    question: q.question,
    reason: q.reason,
    evidence: q.evidence,
    options: q.options,
    recommended: q.recommended,
    blocking: q.blocking,
    reflexSummary: q.reflexSummary,
  };
}

function buildCard(run: TaskRun, task: OrchestratedTask): TaskRunKanbanCard {
  const unmet = unmetTaskDependencies(run, task);
  const stage = currentStage(task);
  const record = stage === undefined ? undefined : task.stages[stage];
  const stopping = task.attention === 'stopping';
  return {
    taskId: task.taskId,
    title: sanitizeInlineText(task.title, TITLE_MAX_LENGTH),
    summary: sanitizeInlineText(task.summary, SUMMARY_MAX_LENGTH),
    column: columnFor(run, task),
    badges: badgesFor(run, task, unmet),
    dependsOn: task.dependsOn.map((taskId) => ({ taskId, satisfied: !unmet.includes(taskId) })),
    issueNumber: task.issueNumber,
    pullRequest: task.pullRequest,
    failure: task.failure === undefined ? undefined : sanitizeInlineText(task.failure, FAILURE_MAX_LENGTH),
    attempts: record?.attempts.length ?? 0,
    canStop: record?.status === 'running' && !stopping,
    canRetry: record?.status === 'halted' && !stopping && run.finishedAt === undefined,
    canReveal: record !== undefined && record.attempts.length > 0,
    questions: listQuestionsAwaitingUser(task).map(toKanbanQuestion),
  };
}

function emptyColumns(): Record<TaskRunKanbanColumn, TaskRunKanbanCard[]> {
  return {
    planApproval: [],
    issuePlan: [],
    issueCreate: [],
    implement: [],
    review: [],
    mergeCleanup: [],
    done: [],
  };
}

/**
 * 盤面を組み立てる。`selectedRunId`が見つからなければ、終わっていないrunのうち新しいもの、
 * 無ければ最も新しいrunを選ぶ。
 */
export function buildTaskRunKanban(
  runs: readonly TaskRun[],
  selectedRunId: string | undefined,
): TaskRunKanbanBoard {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected =
    sorted.find((r) => r.runId === selectedRunId) ??
    sorted.find((r) => r.finishedAt === undefined) ??
    sorted[0];
  const summaries = sorted.map((r) => ({
    runId: r.runId,
    workspaceRoot: r.workspaceRoot,
    engine: r.engine,
    startedAt: r.startedAt,
    finished: r.finishedAt !== undefined,
  }));
  if (selected === undefined) {
    return { runs: summaries, run: undefined };
  }
  const columns = emptyColumns();
  for (const task of listTasks(selected)) {
    const card = buildCard(selected, task);
    columns[card.column].push(card);
  }
  return {
    runs: summaries,
    run: {
      runId: selected.runId,
      workspaceRoot: selected.workspaceRoot,
      engine: selected.engine,
      maxParallel: selected.maxParallel,
      planStatus: selected.planStatus,
      haltedByUser: selected.haltedByUser,
      finished: selected.finishedAt !== undefined,
      assessment: assessTaskRun(selected),
      activeSessions: countActiveStageSessions(selected),
      columns,
    },
  };
}
