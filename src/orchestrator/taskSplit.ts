import { sanitizeInlineText } from './untrustedText';

/**
 * 走行中のタスクの規模から、分けたほうがよいタスクを見つける（Issue #1508、ロードマップH4）。
 *
 * 分解はワークフローの生成時に1回しか行われず、「1タスク」の中身はタスクごとに大きく違う
 * （Issueの背景参照）。規模の実測値が閾値を超えたら、オーケストレーターへ分割を提案する。
 * 分けるかどうかはオーケストレーターが決める（W4の`add_task`等で分ける）。自動では分けない。
 *
 * このファイルは純粋な判定と通知本文の組み立てだけを持つ。実測は`taskOverlap.ts`の
 * `measureWorktreeChanges`、通知は`runnerTaskSplit.ts`が担う。
 */

/** `agent.workflows.splitSuggestFileCount`の既定値 */
export const DEFAULT_SPLIT_SUGGEST_FILE_COUNT = 15;
/** `agent.workflows.splitSuggestLineCount`の既定値 */
export const DEFAULT_SPLIT_SUGGEST_LINE_COUNT = 800;
/** `agent.workflows.splitSuggestTurnCount`の既定値 */
export const DEFAULT_SPLIT_SUGGEST_TURN_COUNT = 10;
/** 閾値の設定値の上限。これを超える値は既定値へ丸める */
export const MAX_SPLIT_SUGGEST_THRESHOLD = 1_000_000;

/** 分割を提案する閾値。0の指標は判定に使わない */
export interface SplitSuggestThresholds {
  /** 変更ファイル数 */
  readonly fileCount: number;
  /** 追加行数と削除行数の合計 */
  readonly lineCount: number;
  /** 試行の中で確定したターン数 */
  readonly turnCount: number;
}

export const DEFAULT_SPLIT_SUGGEST_THRESHOLDS: SplitSuggestThresholds = {
  fileCount: DEFAULT_SPLIT_SUGGEST_FILE_COUNT,
  lineCount: DEFAULT_SPLIT_SUGGEST_LINE_COUNT,
  turnCount: DEFAULT_SPLIT_SUGGEST_TURN_COUNT,
};

export type TaskSizeMetric = keyof SplitSuggestThresholds;

/**
 * 1タスク分の規模の実測値。変更ファイル数・変更行数は、gitのworktreeで走るタスクを
 * 測れたときだけ埋まる。ターン数は常に埋まる。
 */
export interface TaskSizeObservation {
  readonly fileCount: number | undefined;
  readonly lineCount: number | undefined;
  readonly turnCount: number;
}

/** 閾値を超えた指標1件 */
export interface ExceededMetric {
  readonly metric: TaskSizeMetric;
  readonly actual: number;
  readonly threshold: number;
}

const METRIC_ORDER: readonly TaskSizeMetric[] = ['fileCount', 'lineCount', 'turnCount'];

const METRIC_LABEL: Readonly<Record<TaskSizeMetric, string>> = {
  fileCount: '変更ファイル数',
  lineCount: '変更行数（追加と削除の合計）',
  turnCount: '確定したターン数',
};

/** 閾値を超えた指標を返す。超えていなければ空。閾値が0の指標と、測れていない指標は見ない */
export function findExceededMetrics(
  observation: TaskSizeObservation,
  thresholds: SplitSuggestThresholds,
): ExceededMetric[] {
  const exceeded: ExceededMetric[] = [];
  for (const metric of METRIC_ORDER) {
    const actual = observation[metric];
    const threshold = thresholds[metric];
    if (actual !== undefined && threshold > 0 && actual > threshold) {
      exceeded.push({ metric, actual, threshold });
    }
  }
  return exceeded;
}

/** 一覧に載せるファイル名1件の上限（文字数）。`runnerInstruction.ts`と同じ値 */
const FILE_NAME_MAX_LENGTH = 200;
/** 本文に載せる変更ファイルの上限（件数） */
export const MAX_SPLIT_SUGGEST_LISTED_FILES = 20;

/**
 * `taskSplitSuggested`の本文。ファイル名はリポジトリ由来の文字列なので、1件ずつ1行化して
 * から載せる（改行を残すと、一覧の1要素に見せかけて偽の見出しを仕込めるため）。
 */
export function buildTaskSplitSuggestedEventBody(
  taskId: string,
  exceeded: readonly ExceededMetric[],
  files: readonly string[],
): string {
  const sorted = [...files].sort();
  const listed = sorted
    .slice(0, MAX_SPLIT_SUGGEST_LISTED_FILES)
    .map((file) => `- ${sanitizeInlineText(file, FILE_NAME_MAX_LENGTH)}`);
  const rest = sorted.length - listed.length;
  return [
    `タスク ${taskId} の規模が、分割を提案する閾値を超えました。`,
    '',
    '## 超えた指標（拡張機能が測った値）',
    ...exceeded.map(
      ({ metric, actual, threshold }) =>
        `- ${METRIC_LABEL[metric]}: ${actual}（閾値 ${threshold}）`,
    ),
    '',
    `## 変更ファイル（${sorted.length}件）`,
    ...(listed.length === 0 ? ['- （測れていない）'] : listed),
    ...(rest > 0 ? [`- ほか${rest}件`] : []),
    '',
    '## 判断してほしいこと',
    '残りの作業を分けたほうがよいかを判断してください。分ける場合は、add_taskで残りを別タスクとして' +
      '足し（dependsOnにこのタスクを入れると、このタスクの完了後に始まる）、このタスクの後に続く' +
      'pendingのタスクがあればupdate_task_dependenciesで新しいタスクの後ろへ付け替え、' +
      'update_task_promptかsend_messageでこのタスクへ狭めた範囲を伝えます。' +
      '分けずにこのまま続けても構いません。この提案は、このタスクの今回の試行では再び送りません。',
  ].join('\n');
}
