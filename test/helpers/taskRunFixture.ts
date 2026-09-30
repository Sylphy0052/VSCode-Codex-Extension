import { openStageGate } from '../../src/orchestrator/taskRunGates';
import {
  TASK_RUN_SCHEMA_VERSION,
  TASK_STAGES,
  type OrchestratedTask,
  type StageGate,
  type StageReviewResult,
  type StageStatus,
  type TaskRun,
  type TaskStage,
  type TaskStageRecord,
} from '../../src/orchestrator/taskRunState';

/** 関門・質問の判定を試すための最小のrun。`TaskRun`の不変条件は`taskRunState.ts`に従う。 */

export const FIXTURE_NOW = new Date('2026-09-30T00:00:00Z');

function stageRecord(status: StageStatus): TaskStageRecord {
  return { status, attempts: [], pendingDecision: undefined, completedAt: undefined };
}

/** `current`より前の工程を終わらせ、`current`を`status`、後ろを未着手にしたタスク。 */
export function makeTask(
  taskId: string,
  current: TaskStage,
  status: StageStatus,
  overrides: Partial<OrchestratedTask> = {},
): OrchestratedTask {
  const index = TASK_STAGES.indexOf(current);
  const stages = Object.fromEntries(
    TASK_STAGES.map((stage, i) => [
      stage,
      stageRecord(i < index ? 'done' : i === index ? status : 'notStarted'),
    ]),
  ) as Record<TaskStage, TaskStageRecord>;
  return {
    taskId,
    title: `${taskId}のタイトル`,
    summary: '',
    acceptanceCriteria: [],
    dependsOn: [],
    existingIssueNumber: undefined,
    executionId: `exec-${taskId}`,
    stages,
    currentAttemptId: undefined,
    attention: status === 'halted' ? 'needsAction' : 'none',
    failure: undefined,
    issueDraft: undefined,
    issueNumber: undefined,
    worktreePath: undefined,
    branch: undefined,
    pullRequest: undefined,
    review: undefined,
    updatedAt: FIXTURE_NOW.toISOString(),
    ...overrides,
  };
}

export function makeRun(tasks: readonly OrchestratedTask[]): TaskRun {
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    runId: 'run-1',
    workspaceRoot: '/tmp/ws',
    engine: 'claude',
    maxParallel: 2,
    startedAt: FIXTURE_NOW.toISOString(),
    finishedAt: undefined,
    planStatus: 'approved',
    taskOrder: tasks.map((t) => t.taskId),
    tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])),
    nextTaskNumber: tasks.length + 1,
    haltedByUser: false,
    orchestratorGeneration: 0,
    orchestratorSessionRefs: [],
  };
}

export function reviewResult(passed: boolean, remainingFindings: readonly string[]): StageReviewResult {
  return { summary: 'レビュー結果', remainingFindings, passed };
}

/** 工程の失敗で止まったタスク（`stageFailed`の関門を開ける状態）。 */
export function haltedTask(taskId: string, overrides: Partial<OrchestratedTask> = {}): OrchestratedTask {
  return makeTask(taskId, 'implement', 'halted', overrides);
}

/** レビューを終えて「mergeとcleanup」が未着手のタスク（`reviewFindings`の関門を開ける状態）。 */
export function reviewedTask(
  taskId: string,
  review: StageReviewResult,
  overrides: Partial<OrchestratedTask> = {},
): OrchestratedTask {
  return makeTask(taskId, 'mergeCleanup', 'notStarted', { review, ...overrides });
}

/** `openStageGate`で関門を開いたrun。開けなかったときは例外にする。 */
export function withOpenGate(
  run: TaskRun,
  taskId: string,
  gateId: string,
  kind: StageGate['kind'],
  detail = '詳細',
): TaskRun {
  const next = openStageGate(run, taskId, { gateId, kind, detail }, FIXTURE_NOW);
  if (next === run) {
    throw new Error(`${taskId}に関門を開けなかった`);
  }
  return next;
}

/** 決着済みの`stageFailed`関門（自動のやり直しの回数を積むため）。 */
export function resolvedRetryGate(gateId: string, stage: TaskStage, by: 'reflex' | 'orchestrator' | 'user'): StageGate {
  return {
    gateId,
    kind: 'stageFailed',
    stage,
    status: 'resolved',
    detail: '前回の失敗',
    reflexSummary: undefined,
    resolution: { choice: 'retry', by, at: FIXTURE_NOW.toISOString() },
    openedAt: FIXTURE_NOW.toISOString(),
  };
}
