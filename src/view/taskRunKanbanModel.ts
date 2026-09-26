import {
  findLastResolvedGate,
  findOpenGate,
  GATE_CHOICE_LABELS,
  MAX_REVIEW_ROUNDS,
} from '../orchestrator/taskRunGates';
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
  type StageGate,
  type StageGateChoice,
  type StageQuestion,
  type TaskPlanStatus,
  type TaskRun,
  type TaskRunEngine,
  type TaskStage,
} from '../orchestrator/taskRunState';
import { STAGE_LABELS } from '../orchestrator/taskStagePrompts';
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
const GATE_DETAIL_MAX_LENGTH = 2000;

export interface TaskRunKanbanBadge {
  label: string;
  tone: '' | 'warn' | 'ok';
}

/** ユーザー判断待ちの質問。本文は外部由来のため、画面側では`textContent`で出す。 */
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

/** 決着待ちの関門。本文は外部由来のため、画面側では`textContent`で出す。 */
export interface TaskRunKanbanGate {
  gateId: string;
  kind: StageGate['kind'];
  stageLabel: string;
  judging: boolean;
  detail: string;
  reflexSummary: string | undefined;
  /** 画面で選べる決着。失敗の関門は「やり直す」ボタン（`canRetry`）で決着させるため空。 */
  choices: { choice: StageGateChoice; label: string }[];
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
  gate: TaskRunKanbanGate | undefined;
  /** 直近に決着した関門（誰が何を選んだか）。 */
  lastGateDecision: string | undefined;
  /** 実装への差し戻しの回数と上限。差し戻していなければ`undefined`。 */
  reviewRounds: string | undefined;
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
  const gate = findOpenGate(task);
  if (gate !== undefined) {
    // 関門が開いている間は工程を始めないため、工程のバッジ（判断待ち等）を出さない
    const attention = attentionBadge(task);
    const gateBadge: TaskRunKanbanBadge =
      gate.status === 'judging'
        ? { label: 'Reflexが判定中', tone: '' }
        : { label: '関門の判断待ち', tone: 'warn' };
    return attention === undefined || attention.label === 'ユーザー判断待ち'
      ? [gateBadge]
      : [attention, gateBadge];
  }
  const stage = currentStage(task);
  const badges = stage === undefined ? [] : stageBadges(run, task, stage, unmet);
  const attention = attentionBadge(task);
  return attention === undefined ? badges : [attention, ...badges];
}

function toKanbanGate(gate: StageGate): TaskRunKanbanGate {
  const choices: StageGateChoice[] = gate.kind === 'reviewFindings' ? ['sendBack', 'proceed'] : [];
  return {
    gateId: gate.gateId,
    kind: gate.kind,
    stageLabel: STAGE_LABELS[gate.stage],
    judging: gate.status === 'judging',
    detail: gate.detail.slice(0, GATE_DETAIL_MAX_LENGTH),
    reflexSummary:
      gate.reflexSummary === undefined ? undefined : sanitizeInlineText(gate.reflexSummary, SUMMARY_MAX_LENGTH),
    choices: choices.map((choice) => ({ choice, label: GATE_CHOICE_LABELS[choice] })),
  };
}

function lastGateDecision(task: OrchestratedTask): string | undefined {
  const gate = findLastResolvedGate(task);
  if (gate?.resolution === undefined) {
    return undefined;
  }
  const by = gate.resolution.by === 'reflex' ? 'Reflex' : 'ユーザー';
  return `${STAGE_LABELS[gate.stage]}の関門: ${by}が「${GATE_CHOICE_LABELS[gate.resolution.choice]}」を選んだ`;
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
  const gate = findOpenGate(task);
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
    canRetry:
      record?.status === 'halted' &&
      !stopping &&
      run.finishedAt === undefined &&
      gate?.kind !== 'reviewFindings',
    canReveal: record !== undefined && record.attempts.length > 0,
    questions: listQuestionsAwaitingUser(task).map(toKanbanQuestion),
    gate: gate === undefined || run.finishedAt !== undefined ? undefined : toKanbanGate(gate),
    lastGateDecision: lastGateDecision(task),
    reviewRounds:
      (task.reviewRounds ?? 0) > 0
        ? `${String(task.reviewRounds)}/${String(MAX_REVIEW_ROUNDS)}`
        : undefined,
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
