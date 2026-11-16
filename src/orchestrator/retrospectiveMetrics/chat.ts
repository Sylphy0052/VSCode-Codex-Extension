/**
 * 通常チャット（Codex・Claude）の会話1区切りの指標と教訓（Issue #2123）。
 *
 * - 会話の区切り（タブを閉じた・最後のターン終了から一定時間入力が無い）は
 *   `src/chat/chatConversationTracker.ts`が決め、区切りごとに{@link ChatSegment}を渡す
 * - 指標は拡張が計算する（LLMに書かせない）。教訓も失敗ターンの区分から固定の文で作る
 * - 区切りには会話本文・ファイルパスを持たせない。指標と教訓に外部由来の文が入る経路を作らない
 *   （PUBLIC repoへ起票する文の元になるため。#2090の決定事項）
 *
 * 保護パス（`.github/self-improve-protected-paths`）に入っており、自己改善では変えない。
 * `vscode`に依存しない純関数だけを置く。
 */

import type { TurnFailureKind } from '../../appserver/chatState';
import type { ChatMetricValues, RunMetrics, RunMetricsKeys } from '../runMetrics';
import type { LessonInput } from '../runNotes';
import type { ChatRunSummary } from '../runSummary';
import type { TaskRunEngine } from '../taskRunState';

/** 評価に使う通常チャットの指標。どれも小さいほど良い。 */
export const CHAT_RETROSPECTIVE_METRICS = [
  'failedTurnRate',
  'turnsPerEdit',
  'costPerTurn',
  'msPerTurn',
] as const;
export type ChatRetrospectiveMetric = (typeof CHAT_RETROSPECTIVE_METRICS)[number];

/** 悪化とみなす増え方の絶対値の下限（`runRetrospective.ts`の`MIN_ABS_DELTA`と同じ扱い）。 */
export const CHAT_MIN_ABS_DELTA: Readonly<Record<ChatRetrospectiveMetric, number>> = {
  failedTurnRate: 0.05,
  turnsPerEdit: 0.5,
  costPerTurn: 0.05,
  msPerTurn: 60_000,
};

export const CHAT_METRIC_LABELS: Readonly<Record<ChatRetrospectiveMetric, string>> = {
  failedTurnRate: '失敗ターンの率',
  turnsPerEdit: '編集1回あたりのターン数',
  costPerTurn: 'ターンあたりのコスト（USD）',
  msPerTurn: 'ターンあたりの所要時間（ミリ秒）',
};

export function isChatRetrospectiveMetric(value: string): value is ChatRetrospectiveMetric {
  return (CHAT_RETROSPECTIVE_METRICS as readonly string[]).includes(value);
}

/** 区切りの選別の既定値: ターン数の下限。 */
export const DEFAULT_CHAT_MIN_TURNS = 3;
/** 区切りの既定値: 最後のターン終了からこの分数だけ入力が無ければ区切る。 */
export const DEFAULT_CHAT_IDLE_MINUTES = 30;

export interface ChatRetrospectiveSettings {
  minTurns: number;
  /** 0なら無入力では区切らない。 */
  idleMinutes: number;
}

/** 設定の生の値を検証する。整数でない・範囲外の値は既定値にする。 */
export function normalizeChatRetrospectiveSettings(raw: {
  minTurns: unknown;
  idleMinutes: unknown;
}): ChatRetrospectiveSettings {
  const minTurns =
    Number.isInteger(raw.minTurns) && (raw.minTurns as number) >= 1
      ? (raw.minTurns as number)
      : DEFAULT_CHAT_MIN_TURNS;
  const idleMinutes =
    Number.isInteger(raw.idleMinutes) && (raw.idleMinutes as number) >= 0
      ? (raw.idleMinutes as number)
      : DEFAULT_CHAT_IDLE_MINUTES;
  return { minTurns, idleMinutes };
}

/** 1ターンの記録。本文は持たない。 */
export interface ChatTurnRecord {
  /** 開始・終了の時刻（epoch ms）。 */
  startedAt: number;
  finishedAt: number;
  failed: boolean;
  failureKind: TurnFailureKind | undefined;
  /** そのターンでファイルを編集したか（パスは持たない）。 */
  edited: boolean;
}

/** 会話の1区切り。 */
export interface ChatSegment {
  runId: string;
  engine: TaskRunEngine;
  /** 会話の作業ディレクトリ。分からなければ`undefined`（振り返らない）。 */
  workspaceRoot: string | undefined;
  /** タスク（オーケストレータ）管理下の会話か。管理下の会話は対象にしない。 */
  taskManaged: boolean;
  /** 区切りの開始時刻（最初のターンの開始、epoch ms）。 */
  startedAt: number;
  turns: readonly ChatTurnRecord[];
  /** 区切りの開始時点と終了時点のセッションの累計コスト（USD）。分からなければ`undefined`。 */
  costStartUsd: number | undefined;
  costEndUsd: number | undefined;
}

export type ChatSegmentEligibility = { ok: true } | { ok: false; reason: string };

/** 対象の選別: タスク管理下でない、編集のあったターンが1回以上、ターン数が下限以上。 */
export function checkChatSegmentEligibility(
  segment: Pick<ChatSegment, 'taskManaged' | 'turns' | 'workspaceRoot'>,
  minTurns: number,
): ChatSegmentEligibility {
  if (segment.taskManaged) {
    return { ok: false, reason: 'タスク管理下の会話' };
  }
  if (segment.workspaceRoot === undefined) {
    return { ok: false, reason: '作業ディレクトリが分からない' };
  }
  if (!segment.turns.some((t) => t.edited)) {
    return { ok: false, reason: '編集のあったターンが無い' };
  }
  if (segment.turns.length < Math.max(1, minTurns)) {
    return {
      ok: false,
      reason: `ターン数${String(segment.turns.length)}が下限${String(minTurns)}に満たない`,
    };
  }
  return { ok: true };
}

/** 指標の値。ターンが0件なら`undefined`（比べない）。 */
export function computeChatMetricValues(
  segment: Pick<ChatSegment, 'turns' | 'costStartUsd' | 'costEndUsd'>,
): ChatMetricValues | undefined {
  const turns = segment.turns.length;
  if (turns === 0) {
    return undefined;
  }
  const failedTurns = segment.turns.filter((t) => t.failed).length;
  const editTurns = segment.turns.filter((t) => t.edited).length;
  const totalMs = segment.turns.reduce(
    (sum, t) => sum + Math.max(0, t.finishedAt - t.startedAt),
    0,
  );
  const { costStartUsd, costEndUsd } = segment;
  const cost =
    costStartUsd === undefined || costEndUsd === undefined
      ? undefined
      : Math.max(0, costEndUsd - costStartUsd);
  return {
    turns,
    failedTurns,
    editTurns,
    failedTurnRate: failedTurns / turns,
    // 編集が0件の区切りは選別で落ちるが、計算だけ呼ばれたときも割らない
    turnsPerEdit: turns / Math.max(1, editTurns),
    costPerTurn: cost === undefined ? undefined : cost / turns,
    msPerTurn: Math.round(totalMs / turns),
  };
}

/** 区切りを`kind: 'chat'`の指標にする。ターンが0件なら`undefined`。 */
export function computeChatRunMetrics(
  segment: ChatSegment,
  finishedAt: number,
  keys: RunMetricsKeys,
): RunMetrics | undefined {
  const chat = computeChatMetricValues(segment);
  if (chat === undefined) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    kind: 'chat',
    runId: segment.runId,
    startedAt: new Date(segment.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    childIssues: 0,
    sendBacks: 0,
    autoRetries: 0,
    maxReached: 0,
    questions: 0,
    optimizeTrials: 0,
    gatesResolved: { reflex: 0, orchestrator: 0, user: 0 },
    msPerChildIssue: undefined,
    chat,
    keys,
  };
}

/** 振り返りの入力にする。作業ディレクトリが分からなければ`undefined`。 */
export function chatRunSummary(
  segment: ChatSegment,
  finishedAt: number,
): ChatRunSummary | undefined {
  if (segment.workspaceRoot === undefined) {
    return undefined;
  }
  return {
    kind: 'chat',
    runId: segment.runId,
    workspaceRoot: segment.workspaceRoot,
    engines: [segment.engine],
    startedAt: new Date(segment.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
  };
}

const FAILURE_LESSONS: Readonly<Record<TurnFailureKind, { what: string; instruction: string }>> = {
  usageLimit: {
    what: '使用量の上限で失敗した',
    instruction:
      '使用量の上限に近いときは、1回の発言で頼む範囲を小さく区切り、失敗したターンを同じ内容で繰り返し送らない。',
  },
  other: {
    what: 'エラーで失敗した',
    instruction:
      '失敗したターンの直後は、同じ指示を送り直す前に失敗の原因（エラーの内容）を確かめる。',
  },
};

/**
 * 失敗ターンから教訓を機械的に作る（LLMに書かせない）。失敗が無ければ空。最も多い区分の1件だけを
 * 作る（同数なら`other`）。文は固定のテンプレートと件数だけで組み、会話本文・パスを入れない。
 * 出典は拡張が数えた件数なので`repoArtifact`。
 */
export function buildChatLessons(segment: Pick<ChatSegment, 'turns'>): LessonInput[] {
  const counts: Record<TurnFailureKind, number> = { usageLimit: 0, other: 0 };
  for (const t of segment.turns) {
    if (t.failed) {
      counts[t.failureKind ?? 'other'] += 1;
    }
  }
  const kind: TurnFailureKind = counts.usageLimit > counts.other ? 'usageLimit' : 'other';
  const failed = counts[kind];
  if (failed === 0) {
    return [];
  }
  const turns = segment.turns.length;
  const template = FAILURE_LESSONS[kind];
  return [
    {
      observation: `通常チャットの会話（${String(turns)}ターン）のうち${String(failed)}ターンが${template.what}。`,
      evidence: [`turns=${String(turns)}`, `failedTurns=${String(failed)}`, `failureKind=${kind}`],
      instruction: template.instruction,
      source: 'repoArtifact',
    },
  ];
}
