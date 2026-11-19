import * as path from 'node:path';
import type { TaskRunAssessment } from '../orchestrator/taskRunScheduler';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type {
  McIssueListing,
  McIssueStartRequest,
  McRun,
  McRunOp,
  McRunState,
  McRunTask,
  McRunsSnapshot,
} from '../webview/missionControl/protocol';
import {
  TASK_RUN_KANBAN_COLUMNS,
  type TaskRunKanbanColumn,
  type TaskRunKanbanRun,
  type TaskRunKanbanRunSummary,
} from './taskRunKanbanModel';

/**
 * Mission ControlのRunsタブ（Issue #2150）。オーケストレータモードのrunを一覧にし、runの操作と
 * roadmap・Issueからの起動を受け付ける。
 *
 * 処理そのものはKanban・コマンドと同じ関数（`taskRunSetup.ts`が組む`McRunsPort`）に任せ、ここは
 * 画面の形への変換と、webviewから届いた値の検証だけを持つ。webviewは信頼境界の外側として扱う。
 */

/** webviewから届く操作を実行する口。vscodeに依る部分は`taskRunSetup.ts`が組む。 */
export interface McRunsPort {
  snapshot(currentFolders: readonly string[]): McRunsSnapshot;
  /** runが変わったら呼ぶ。戻り値で購読をやめる。 */
  onDidChange(listener: () => void): { dispose(): void };
  /** 失敗・取りやめなら理由の文、成功なら`undefined`。 */
  runOp(op: McRunOp, runId: string): Promise<string | undefined>;
  setMaxParallel(runId: string, maxParallel: number): Promise<string | undefined>;
  /** 新しいrunを始める（`agent.taskRun.start`と同じQuickPickを出す）。 */
  start(): Promise<string | undefined>;
  /** roadmapの着手順とOPENのIssue。取れなければ理由の文。 */
  listIssues(folder: string): Promise<McIssueListing | string>;
  /** roadmap・Issueから起動する。結果の説明を返す。 */
  startFromIssues(request: McIssueStartRequest): Promise<{ ok: boolean; message: string }>;
}

const COLUMN_LABELS: Record<TaskRunKanbanColumn, string> = {
  planApproval: '計画承認待ち',
  issuePlan: 'Issue計画',
  issueCreate: 'Issue作成',
  implement: '実装',
  review: 'レビュー',
  mergeCleanup: 'mergeとcleanup',
  done: '完了',
};

const TITLE_MAX_LENGTH = 200;
/** 1回の起動で選べるIssueの数の上限。 */
export const MAX_ISSUES_PER_START = 20;
const ISSUE_NUMBER_MAX = 10_000_000;
/** runIdの形。`randomUUID`のほか、テストで差し替えたidも通す。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const RUN_OPS: readonly McRunOp[] = ['switch', 'pause', 'unpause', 'suspend', 'resume', 'finish'];

export function assessmentLabel(assessment: TaskRunAssessment): string {
  switch (assessment.kind) {
    case 'finished':
      return 'すべて完了';
    case 'progressing':
      return '進行中';
    case 'haltedByUser':
      return '一時停止中';
    case 'planPending':
      return assessment.planStatus === 'awaitingApproval'
        ? '計画の承認待ち'
        : 'Orchestratorが計画を作成中';
    case 'stalled':
      return `人の対応待ち: ${assessment.blockers.join(', ')}`;
    case 'reopened':
      return '再開済み（タスクの追加・再実行待ち）';
    default:
      return '';
  }
}

function runState(summary: TaskRunKanbanRunSummary, run: TaskRunKanbanRun | undefined): McRunState {
  if (summary.finished) {
    return 'finished';
  }
  if (summary.suspended) {
    return 'suspended';
  }
  if (run !== undefined && (run.haltedByUser || run.planStatus === 'awaitingApproval')) {
    return 'waiting';
  }
  return 'running';
}

function toTasks(run: TaskRunKanbanRun): McRunTask[] {
  return TASK_RUN_KANBAN_COLUMNS.flatMap((column) =>
    run.columns[column].map((card): McRunTask => ({
      taskId: card.taskId,
      title: sanitizeInlineText(card.title, TITLE_MAX_LENGTH),
      stage: COLUMN_LABELS[column],
      badges: card.badges.map((b) => sanitizeInlineText(b.label, TITLE_MAX_LENGTH)),
      warn: card.badges.some((b) => b.tone === 'warn'),
      done: column === 'done',
      issueNumber: card.issueNumber,
      pullRequestNumber: card.pullRequest?.number,
    })),
  );
}

/**
 * run一覧を画面の形にする。`details`は終わっていないrunの盤面（runId → 盤面）。終えたrunは
 * タスクを載せない。
 */
export function buildMcRuns(
  summaries: readonly TaskRunKanbanRunSummary[],
  details: ReadonlyMap<string, TaskRunKanbanRun>,
  folders: readonly string[],
  maxParallelLimit: number,
): McRunsSnapshot {
  const runs = summaries.map((summary): McRun => {
    const run = details.get(summary.runId);
    const tasks = run === undefined || summary.finished ? [] : toTasks(run);
    return {
      runId: summary.runId,
      label: sanitizeInlineText(summary.label, TITLE_MAX_LENGTH),
      status: summary.status,
      state: runState(summary, run),
      assessment: run === undefined ? '' : assessmentLabel(run.assessment),
      workspaceRoot: summary.workspaceRoot,
      repoLabel: path.basename(summary.workspaceRoot) || summary.workspaceRoot,
      engine: summary.engine,
      maxParallel: run?.maxParallel ?? 0,
      activeSessions: run?.activeSessions ?? 0,
      halted: run?.haltedByUser === true,
      startedAt: summary.startedAt,
      inCurrentFolder: summary.inCurrentFolder,
      taskTotal: tasks.length,
      taskDone: tasks.filter((t) => t.done).length,
      tasks,
    };
  });
  return {
    runs,
    maxParallelLimit,
    folders: folders.map((folder) => ({
      path: folder,
      label: path.basename(folder) || folder,
    })),
  };
}

export function isRunIdShape(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

function isIssueNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ISSUE_NUMBER_MAX
  );
}

/** `runOp`の検証。合わなければ理由の文。 */
export function parseRunOp(
  message: Record<string, unknown>,
): { op: McRunOp; runId: string } | string {
  const { op, runId } = message;
  if (typeof op !== 'string' || !(RUN_OPS as readonly string[]).includes(op)) {
    return '操作が正しくありません';
  }
  if (!isRunIdShape(runId)) {
    return 'runが正しくありません';
  }
  return { op: op as McRunOp, runId };
}

/** `runParallel`の検証。範囲（1〜上限）は`TaskRunController.setMaxParallel`も確かめる。 */
export function parseRunParallel(
  message: Record<string, unknown>,
  limit: number,
): { runId: string; maxParallel: number } | string {
  const { runId, maxParallel } = message;
  if (!isRunIdShape(runId)) {
    return 'runが正しくありません';
  }
  if (
    typeof maxParallel !== 'number' ||
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > limit
  ) {
    return `並列上限は1〜${String(limit)}の整数で指定してください`;
  }
  return { runId, maxParallel };
}

/**
 * `issueList`・`issueStart`のフォルダの検証。届いた文字列は使わず、候補（開いているワークスペース
 * フォルダ）のうち一致したものを返す。
 */
export function pickFolder(raw: unknown, folders: readonly string[]): string | undefined {
  return typeof raw === 'string' ? folders.find((folder) => folder === raw) : undefined;
}

/** `issueStart`の検証。合わなければ理由の文。 */
export function parseIssueStart(
  message: Record<string, unknown>,
  folders: readonly string[],
): McIssueStartRequest | string {
  const folder = pickFolder(message.folder, folders);
  if (folder === undefined) {
    return '開いているワークスペースフォルダを選んでください';
  }
  const { engine, roadmapIssueNumbers, issueNumbers } = message;
  if (engine !== 'codex' && engine !== 'claude') {
    return 'CLIが正しくありません';
  }
  const isNumberList = (value: unknown): value is number[] =>
    Array.isArray(value) && value.length <= MAX_ISSUES_PER_START && value.every(isIssueNumber);
  if (!isNumberList(roadmapIssueNumbers) || !isNumberList(issueNumbers)) {
    return `Issueを1〜${String(MAX_ISSUES_PER_START)}件選んでください`;
  }
  const roadmaps = [...new Set(roadmapIssueNumbers)];
  // 同じ番号がroadmapと通常のIssueの両方に来たら、roadmapとして扱う
  const issues = [...new Set(issueNumbers)].filter((n) => !roadmaps.includes(n));
  const total = roadmaps.length + issues.length;
  if (total === 0 || total > MAX_ISSUES_PER_START) {
    return `Issueを1〜${String(MAX_ISSUES_PER_START)}件選んでください`;
  }
  return { folder, engine, roadmapIssueNumbers: roadmaps, issueNumbers: issues };
}
