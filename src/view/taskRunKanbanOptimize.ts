import type { OptimizeTrialRecord } from '../orchestrator/optimizeLedger';
import type { OrchestratedTask } from '../orchestrator/taskRunState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';

/** 試行の一覧に出す件数。多いと新しい方だけ残す（省いた件数は`omitted`）。 */
export const OPTIMIZE_ROWS_MAX = 30;
const HYPOTHESIS_MAX_LENGTH = 200;
const REASON_MAX_LENGTH = 200;

/** 推移のグラフの座標系（viewBox）。 */
export const OPTIMIZE_TREND_WIDTH = 200;
export const OPTIMIZE_TREND_HEIGHT = 40;

export type TaskRunKanbanOptimizeOutcome = 'adopted' | 'rejected' | 'invalid';

export interface TaskRunKanbanOptimizeRow {
  trial: number;
  outcome: TaskRunKanbanOptimizeOutcome;
  outcomeLabel: string;
  /** 指標の中央値。測れなかった試行は`undefined`。 */
  metric: number | undefined;
  /** 採否の理由（台帳の要約）。1行へ均した外部由来のテキスト。 */
  reason: string;
  /** 試行の仮説。LLMが書いた外部由来のテキストを1行へ均したもの。 */
  hypothesis: string;
}

export interface TaskRunKanbanOptimizePoint {
  /** 0〜`OPTIMIZE_TREND_WIDTH`。 */
  x: number;
  /** 0〜`OPTIMIZE_TREND_HEIGHT`。上が良い方向ではなく、値が大きいほど上。 */
  y: number;
  /** 基準値は`baseline`。 */
  kind: 'baseline' | TaskRunKanbanOptimizeOutcome;
  value: number;
  /** 点の説明（基準値、または「#試行」）。 */
  label: string;
}

/** タスクのカードに出す、最適化の基準値・最良値・試行の記録（Issue #2109）。 */
export interface TaskRunKanbanOptimize {
  baseline: number | undefined;
  best: number | undefined;
  trials: number;
  rows: TaskRunKanbanOptimizeRow[];
  /** `OPTIMIZE_ROWS_MAX`を超えて省いた古い試行の件数。 */
  omitted: number;
  /** 指標の推移。基準値（あれば）と、測れた試行の指標を試行順に並べた点。 */
  trend: TaskRunKanbanOptimizePoint[];
}

const OUTCOME_LABELS: Record<TaskRunKanbanOptimizeOutcome, string> = {
  adopted: '採用',
  rejected: '不採用',
  invalid: '無効',
};

function isOutcome(value: unknown): value is TaskRunKanbanOptimizeOutcome {
  return value === 'adopted' || value === 'rejected' || value === 'invalid';
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? sanitizeInlineText(value, max) : '';
}

/** 台帳の1行は手で直せるファイルなので、形を信用せずに読む。 */
function toRow(record: OptimizeTrialRecord): TaskRunKanbanOptimizeRow | undefined {
  const trial = finiteOrUndefined(record.trial);
  if (trial === undefined) {
    return undefined;
  }
  const outcome = isOutcome(record.decision?.outcome) ? record.decision.outcome : 'invalid';
  return {
    trial,
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    metric: finiteOrUndefined(record.metric?.median),
    reason: oneLine(record.decision?.reason, REASON_MAX_LENGTH),
    hypothesis: oneLine(record.llm?.hypothesis, HYPOTHESIS_MAX_LENGTH),
  };
}

function buildTrend(
  baseline: number | undefined,
  rows: readonly TaskRunKanbanOptimizeRow[],
): TaskRunKanbanOptimizePoint[] {
  const raw: { kind: TaskRunKanbanOptimizePoint['kind']; value: number; label: string }[] = [];
  if (baseline !== undefined) {
    raw.push({ kind: 'baseline', value: baseline, label: '基準値' });
  }
  for (const row of rows) {
    if (row.metric !== undefined) {
      raw.push({ kind: row.outcome, value: row.metric, label: `#${String(row.trial)}` });
    }
  }
  if (raw.length === 0) {
    return [];
  }
  const values = raw.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return raw.map((p, i) => ({
    x: raw.length === 1 ? OPTIMIZE_TREND_WIDTH / 2 : (i / (raw.length - 1)) * OPTIMIZE_TREND_WIDTH,
    // 値が大きいほど上（SVGのyは下向きなので反転する）
    y:
      span === 0 ? OPTIMIZE_TREND_HEIGHT / 2 : (1 - (p.value - min) / span) * OPTIMIZE_TREND_HEIGHT,
    kind: p.kind,
    value: p.value,
    label: p.label,
  }));
}

/**
 * タスクの最適化の表示を作る。基準値・最良値・試行の数はTaskRunの状態（`optimizeLoop`、無ければ
 * `optimizeSummary`）から取り、新しい状態を持たない。試行ごとの採否と理由は台帳の記録から取る。
 * 状態も台帳も無いタスクは`undefined`（表示を変えない）。
 */
export function buildOptimizeView(
  task: OrchestratedTask,
  records: readonly OptimizeTrialRecord[] | undefined,
): TaskRunKanbanOptimize | undefined {
  const loop = task.optimizeLoop;
  const summary = task.optimizeSummary;
  const ledger = records ?? [];
  if (loop === undefined && summary === undefined && ledger.length === 0) {
    return undefined;
  }
  const allRows = ledger
    .map(toRow)
    .filter((r): r is TaskRunKanbanOptimizeRow => r !== undefined)
    .sort((a, b) => a.trial - b.trial);
  const baseline =
    finiteOrUndefined(loop?.baseline?.metric) ?? finiteOrUndefined(summary?.baseline);
  const best = finiteOrUndefined(loop?.best?.metric) ?? finiteOrUndefined(summary?.best);
  const rows = allRows.slice(-OPTIMIZE_ROWS_MAX);
  return {
    baseline,
    best,
    trials: Math.max(loop?.trials ?? 0, summary?.trials ?? 0, allRows.length),
    rows,
    omitted: allRows.length - rows.length,
    trend: buildTrend(baseline, rows),
  };
}
