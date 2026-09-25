import {
  getIssue,
  type IssueAttention,
  type IssuePhase,
  type IssueResult,
  type RoadmapIssueExecution,
  type RoadmapRun,
  type RoadmapRunEngine,
  type RoadmapRunMode,
} from '../orchestrator/roadmapRunState';
import {
  assessRun,
  countActiveSessions,
  hasActiveSession,
  unmetDependencies,
  type RunAssessment,
} from '../orchestrator/roadmapScheduler';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

/**
 * ロードマップ実行（Issue #1465）のKanbanの盤面。Controllerの状態（`RoadmapRun`）から
 * 表示用の値だけを組み立てる純粋関数で、画面（`roadmapKanbanView.ts`）はこれを描くだけにする。
 *
 * 列は5つ（未着手 / 実行可能 / 進行中 / 要対応 / 終了）に絞り、工程と注意はカードのバッジで出す
 * （#1465 §14）。操作の可否もここで決め、画面側で状態を解釈し直さない。
 */

export const ROADMAP_KANBAN_COLUMNS = ['blocked', 'runnable', 'running', 'attention', 'done'] as const;
export type RoadmapKanbanColumn = (typeof ROADMAP_KANBAN_COLUMNS)[number];

export const ROADMAP_KANBAN_COLUMN_LABELS: Record<RoadmapKanbanColumn, string> = {
  blocked: '未着手',
  runnable: '実行可能',
  running: '進行中',
  attention: '要対応',
  done: '終了',
};

const PHASE_LABELS: Record<IssuePhase, string> = {
  implement: '実装',
  execute: '実行',
  review: 'レビュー',
  awaitingMerge: 'merge待ち',
  merging: 'merge中',
  mergeRepair: 'merge修復',
  cleanup: 'cleanup',
};

const ATTENTION_LABELS: Record<IssueAttention, string | undefined> = {
  none: undefined,
  orchestratorConsidering: 'Orchestrator検討中',
  awaitingUser: 'ユーザー判断待ち',
  awaitingApproval: '承認待ち',
  failed: '失敗',
  stopping: '停止処理中',
  paused: '一時停止',
};

const RESULT_LABELS: Record<IssueResult, string> = {
  succeeded: '成功',
  stopped: '停止',
  failed: '失敗',
};

/** カードへ出すタイトル・失敗理由の上限。 */
const TITLE_MAX_LENGTH = 200;
const FAILURE_MAX_LENGTH = 300;

/** 人の対応を要する注意。進行中でもこの注意なら「要対応」列へ置く。 */
const USER_ATTENTIONS: readonly IssueAttention[] = ['awaitingUser', 'awaitingApproval', 'failed'];

export interface RoadmapKanbanBadge {
  kind: 'phase' | 'attention' | 'result';
  label: string;
  /** 色分け用。`attention`・`failed`は注意色、`succeeded`は成功色にする。 */
  tone: 'neutral' | 'warn' | 'ok';
}

export interface RoadmapKanbanCard {
  issueNumber: number;
  /** 1行へ均した外部由来のテキスト。画面側でもエスケープして出す。 */
  title: string;
  column: RoadmapKanbanColumn;
  badges: RoadmapKanbanBadge[];
  dependsOn: { issueNumber: number; satisfied: boolean }[];
  wave: number | undefined;
  /** 最初の実行回の開始時刻（ISO8601）。未着手なら`undefined`。 */
  startedAt: string | undefined;
  /** 終わったノードは最後の実行回の終了時刻。経過時間の計算に使う。 */
  endedAt: string | undefined;
  pullRequest: { number: number; url: string } | undefined;
  failure: string | undefined;
  canRun: boolean;
  /** 依存が終わっていない。実行には確認つきの上書きが要る。 */
  needsOverride: boolean;
  /** 実行ボタンの文言（実行 / 再開 / 再実行）。 */
  runLabel: string;
  canPause: boolean;
  canStop: boolean;
  /** セッションタブを前面に出せる（セッションが生きている見込みがある）。 */
  canReveal: boolean;
}

export interface RoadmapKanbanRunSummary {
  runId: string;
  roadmapIssueNumber: number;
  workspaceRoot: string;
  startedAt: string;
  finished: boolean;
}

export interface RoadmapKanbanBoard {
  runs: RoadmapKanbanRunSummary[];
  /** 表示中のrun。runが1つも無ければ`undefined`。 */
  run:
    | {
        runId: string;
        roadmapIssueNumber: number;
        workspaceRoot: string;
        engine: RoadmapRunEngine;
        mode: RoadmapRunMode;
        maxParallel: number;
        haltedByUser: boolean;
        finished: boolean;
        activeSessions: number;
        assessment: RunAssessment;
        columns: Record<RoadmapKanbanColumn, RoadmapKanbanCard[]>;
      }
    | undefined;
  /** 表示中のrunについてKanbanで知らせる出来事（新しい順）。 */
  events: RoadmapKanbanEvent[];
}

export interface RoadmapKanbanEvent {
  /** ISO8601。 */
  at: string;
  message: string;
  tone: 'info' | 'warn';
}

function columnFor(issue: RoadmapIssueExecution, unmet: number): RoadmapKanbanColumn {
  switch (issue.progress) {
    case 'done':
      return 'done';
    case 'notStarted':
      return unmet === 0 ? 'runnable' : 'blocked';
    case 'halted':
      return 'attention';
    case 'running':
      return USER_ATTENTIONS.includes(issue.attention) ? 'attention' : 'running';
  }
}

function badgesFor(issue: RoadmapIssueExecution): RoadmapKanbanBadge[] {
  const badges: RoadmapKanbanBadge[] = [];
  if (issue.phase !== undefined) {
    badges.push({ kind: 'phase', label: PHASE_LABELS[issue.phase], tone: 'neutral' });
  }
  const attention = ATTENTION_LABELS[issue.attention];
  if (attention !== undefined) {
    badges.push({
      kind: 'attention',
      label: attention,
      tone: issue.attention === 'orchestratorConsidering' || issue.attention === 'stopping' ? 'neutral' : 'warn',
    });
  }
  if (issue.result !== undefined && !(issue.result === 'failed' && issue.attention === 'failed')) {
    badges.push({
      kind: 'result',
      label: RESULT_LABELS[issue.result],
      tone: issue.result === 'succeeded' ? 'ok' : 'warn',
    });
  }
  if (issue.checkedAtStart) {
    badges.push({ kind: 'result', label: '開始前に完了', tone: 'neutral' });
  }
  return badges;
}

function runLabelFor(issue: RoadmapIssueExecution): string {
  if (issue.progress === 'notStarted') {
    return '実行';
  }
  return issue.progress === 'halted' && issue.attention === 'paused' ? '再開' : '再実行';
}

function buildCard(run: RoadmapRun, issueNumber: number, dependsOn: readonly number[], wave: number | undefined): RoadmapKanbanCard | undefined {
  const issue = getIssue(run, issueNumber);
  if (issue === undefined) {
    return undefined;
  }
  const unmet = unmetDependencies(run, { issueNumber, dependsOn, wave });
  const unmetSet = new Set(unmet);
  const active = hasActiveSession(issue);
  const finished = run.finishedAt !== undefined;
  const isPaused = issue.progress === 'halted' && issue.attention === 'paused';
  const lastAttempt = issue.attempts.at(-1);
  return {
    issueNumber,
    title: sanitizeInlineText(issue.title, TITLE_MAX_LENGTH),
    column: columnFor(issue, unmet.length),
    badges: badgesFor(issue),
    dependsOn: dependsOn.map((dep) => ({ issueNumber: dep, satisfied: !unmetSet.has(dep) })),
    wave,
    startedAt: issue.attempts[0]?.startedAt,
    endedAt: issue.progress === 'done' ? (lastAttempt?.endedAt ?? issue.updatedAt) : undefined,
    pullRequest: issue.pullRequest,
    failure:
      issue.failure === undefined ? undefined : sanitizeInlineText(issue.failure, FAILURE_MAX_LENGTH),
    canRun: !finished && (issue.progress === 'notStarted' || issue.progress === 'halted'),
    needsOverride: unmet.length > 0,
    runLabel: runLabelFor(issue),
    canPause: !finished && active && issue.attention !== 'stopping',
    canStop: !finished && ((active && issue.attention !== 'stopping') || isPaused),
    canReveal: active || isPaused,
  };
}

function emptyColumns(): Record<RoadmapKanbanColumn, RoadmapKanbanCard[]> {
  return { blocked: [], runnable: [], running: [], attention: [], done: [] };
}

/**
 * 盤面を組み立てる。`selectedRunId`が見つからなければ、実行中のrunのうち新しいもの、
 * それも無ければ最も新しいrunを表示する。
 */
export function buildRoadmapKanban(
  runs: readonly RoadmapRun[],
  selectedRunId: string | undefined,
  eventsFor: (runId: string) => readonly RoadmapKanbanEvent[],
): RoadmapKanbanBoard {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected =
    sorted.find((r) => r.runId === selectedRunId) ??
    sorted.find((r) => r.finishedAt === undefined) ??
    sorted[0];
  const summaries = sorted.map((r) => ({
    runId: r.runId,
    roadmapIssueNumber: r.roadmapIssueNumber,
    workspaceRoot: r.workspaceRoot,
    startedAt: r.startedAt,
    finished: r.finishedAt !== undefined,
  }));
  if (selected === undefined) {
    return { runs: summaries, run: undefined, events: [] };
  }
  const columns = emptyColumns();
  for (const node of selected.plan.nodes) {
    const card = buildCard(selected, node.issueNumber, node.dependsOn, node.wave);
    if (card !== undefined) {
      columns[card.column].push(card);
    }
  }
  return {
    runs: summaries,
    run: {
      runId: selected.runId,
      roadmapIssueNumber: selected.roadmapIssueNumber,
      workspaceRoot: selected.workspaceRoot,
      engine: selected.engine,
      mode: selected.mode,
      maxParallel: selected.maxParallel,
      haltedByUser: selected.haltedByUser,
      finished: selected.finishedAt !== undefined,
      activeSessions: countActiveSessions(selected),
      assessment: assessRun(selected),
      columns,
    },
    events: [...eventsFor(selected.runId)],
  };
}
