import {
  isTaskDone,
  listTasks,
  TASK_STAGES,
  type OrchestratedTask,
  type StageReviewResult,
  type TaskRun,
} from './taskRunState';
import { normalizeFailureCause } from './taskStagePrompts';
import { sanitizeInlineText } from './untrustedText';

/**
 * review工程の結果と台帳の集計（Issue #2192）。Orchestratorが結果を見て計画を直す材料にする。
 * 指標はLLMに書かせず、拡張が保存済みの状態から決定的に計算する（#2090の原則）。ここは純関数だけ。
 *
 * 後続（#2193〜#2195）が項目を足しやすいよう、集計は名前付きの数の集まりにしてある。足すときは
 * `TaskRunTally`に項目を足し、`tallyTaskRun`で数え、`formatTaskRunTally`に載せる。
 */

/** run全体の集計。 */
export interface TaskRunTally {
  /** タスク数（ロードマップで完了済みのタスクも含む）。 */
  taskCount: number;
  /** 全工程が終わったタスクの数（`isTaskDone`）。 */
  doneTaskCount: number;
  /** review工程の結果を持つタスクの数（差し戻し後も最後の結果を数える）。 */
  reviewedTaskCount: number;
  /** そのうち`reviewPassed`が真のタスクの数。 */
  passedReviewCount: number;
  /** 直さずに残った指摘（`remainingFindings`）の総数。 */
  remainingFindingCount: number;
  /** 台帳の本来の場面のうち未実測のものの総数。 */
  unsettledSceneCount: number;
  /** 台帳の「未対応」の指摘の総数。 */
  openLedgerFindingCount: number;
  /** review工程の報告に台帳が無かった（読めなかった）タスクの数。 */
  missingLedgerCount: number;
  /**
   * 同じ原因の失敗の数。同じタスク・同じ工程で、前に開いた「工程の失敗」の関門と原因
   * （`normalizeFailureCause`）が同じ関門を数える。刈られた関門は数えない。
   */
  repeatedFailureCount: number;
}

/** run全体を集計する。LLMを呼ばない純関数。 */
export function tallyTaskRun(run: TaskRun): TaskRunTally {
  const tally: TaskRunTally = {
    taskCount: 0,
    doneTaskCount: 0,
    reviewedTaskCount: 0,
    passedReviewCount: 0,
    remainingFindingCount: 0,
    unsettledSceneCount: 0,
    openLedgerFindingCount: 0,
    missingLedgerCount: 0,
    repeatedFailureCount: 0,
  };
  for (const task of listTasks(run)) {
    tally.taskCount += 1;
    if (isTaskDone(task)) {
      tally.doneTaskCount += 1;
    }
    tally.repeatedFailureCount += countRepeatedFailures(task);
    const { review } = task;
    if (review === undefined) {
      continue;
    }
    tally.reviewedTaskCount += 1;
    if (review.passed) {
      tally.passedReviewCount += 1;
    }
    tally.remainingFindingCount += review.remainingFindings.length;
    if (review.ledger?.kind === 'parsed') {
      tally.unsettledSceneCount += review.ledger.digest.unsettledSceneCount;
      tally.openLedgerFindingCount += review.ledger.digest.openFindingCount;
    } else if (review.ledger?.kind === 'none') {
      tally.missingLedgerCount += 1;
    }
  }
  return tally;
}

function countRepeatedFailures(task: OrchestratedTask): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const gate of task.gates ?? []) {
    if (gate.kind !== 'stageFailed') {
      continue;
    }
    const key = `${gate.stage}\u0000${normalizeFailureCause(gate.detail)}`;
    if (seen.has(key)) {
      repeated += 1;
    } else {
      seen.add(key);
    }
  }
  return repeated;
}

/** run全体の集計の1行。数だけで外部由来の文を含まない。 */
export function formatTaskRunTally(tally: TaskRunTally): string {
  return (
    `run全体の集計: タスク${String(tally.taskCount)}件（完了${String(tally.doneTaskCount)}件）` +
    ` / review済み${String(tally.reviewedTaskCount)}件（合格${String(tally.passedReviewCount)}件）` +
    ` / 残った指摘${String(tally.remainingFindingCount)}件` +
    ` / 未実測の場面${String(tally.unsettledSceneCount)}件` +
    ` / 台帳の未対応の指摘${String(tally.openLedgerFindingCount)}件` +
    ` / 台帳なし${String(tally.missingLedgerCount)}件` +
    ` / 同じ原因の失敗${String(tally.repeatedFailureCount)}件`
  );
}

/** reviewの結果の要約（1行、数だけ）。`get_run_state`の既定の表示とmerge時の促しで使う。 */
export function formatReviewTally(review: StageReviewResult): string {
  const parts = [
    `review: ${review.passed ? '合格' : '不合格'}`,
    `残った指摘${String(review.remainingFindings.length)}件`,
  ];
  const { ledger } = review;
  if (ledger === undefined) {
    parts.push('台帳: 未集計');
  } else if (ledger.kind === 'none') {
    parts.push('台帳: なし');
  } else {
    const d = ledger.digest;
    parts.push(
      `台帳: 本来の場面${String(d.genuineSceneCount)}件・未実測${String(d.unsettledSceneCount)}件・未対応の指摘${String(d.openFindingCount)}件${d.filled ? '（埋まった）' : ''}`,
    );
  }
  return parts.join(' / ');
}

/**
 * 未実測の場面の一覧（1件1行）。場面の文は外部由来なので`sanitizeInlineText`で1行に均す
 * （改行で偽のエントリを作らせない）。呼び出し側は一覧ごと`formatUntrusted`の囲いへ入れる。
 */
export function formatUnsettledSceneLines(
  review: StageReviewResult,
  indent: string,
  maxLength: number,
): string[] {
  if (review.ledger?.kind !== 'parsed') {
    return [];
  }
  const { digest } = review.ledger;
  const lines = digest.unsettledScenes.map(
    (s) => `${indent}${sanitizeInlineText(s.id, 20)} ${sanitizeInlineText(s.text, maxLength)}`,
  );
  const rest = digest.unsettledSceneCount - digest.unsettledScenes.length;
  if (rest > 0) {
    lines.push(`${indent}ほか${String(rest)}件`);
  }
  return lines;
}

/**
 * タスクの工程の要約・reviewの結果の全項目（`get_run_state`でtaskIdsを指定したとき）。
 * 外部由来の文はすべて`sanitizeInlineText`で1行に均す。呼び出し側は一覧ごと`formatUntrusted`で囲む。
 */
export function formatTaskResultDetailLines(task: OrchestratedTask, maxLength: number): string[] {
  const lines: string[] = [];
  const summaries = task.stageSummaries ?? {};
  for (const stage of TASK_STAGES) {
    const summary = summaries[stage];
    if (summary !== undefined) {
      lines.push(`  工程の要約 ${stage}: ${sanitizeInlineText(summary, maxLength)}`);
    }
  }
  const { review } = task;
  if (review === undefined) {
    return lines;
  }
  lines.push(`  ${formatReviewTally(review)}`);
  lines.push(`    reviewの要約: ${sanitizeInlineText(review.summary, maxLength)}`);
  if (review.remainingFindings.length > 0) {
    lines.push('    残った指摘:');
    for (const finding of review.remainingFindings) {
      lines.push(`      - ${sanitizeInlineText(finding, maxLength)}`);
    }
  }
  const scenes = formatUnsettledSceneLines(review, '      - ', maxLength);
  if (scenes.length > 0) {
    lines.push('    未実測の場面:', ...scenes);
  }
  return lines;
}

/** 工程の要約を持つ工程の一覧（既定の表示で「全文はtaskIdsで」と示す1行）。無ければ`undefined`。 */
export function formatStageSummaryHint(task: OrchestratedTask): string | undefined {
  const summaries = task.stageSummaries ?? {};
  const stages = TASK_STAGES.filter((s) => summaries[s] !== undefined);
  return stages.length === 0
    ? undefined
    : `  工程の要約あり: ${stages.join(', ')}（全文と残った指摘はtaskIdsで取得）`;
}
