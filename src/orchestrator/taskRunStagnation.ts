import { countRepeatedFailures } from './taskRunDigest';
import { readTaskRunEndReview } from './taskRunEndReview';
import { isReviewRoundsExhausted, MAX_REVIEW_ROUNDS } from './taskRunGates';
import { readTaskRunGoal } from './taskRunGoal';
import { isTaskDone, listTasks, type OrchestratedTask, type TaskRun } from './taskRunState';
import { sanitizeInlineText } from './untrustedText';

/**
 * runの停滞の信号（Issue #2195）。merge件数の倍数で文言を足す代わりに、保存済みの状態から
 * 信号を決定的に計算する（#2090「指標はLLMに書かせず拡張が計算する」）。ここは純関数だけ。
 *
 * 閾値は自律改善の対象外（#2090「関門・上限値・承認判定・指標の計算」）。変えるときは人が
 * ここの定数を直す。
 *
 * 一度立った信号がrunの終わりまで消えず、方式を変えた後も見直しを求め続けないよう、どの信号も
 * 「今も続いている」ものだけを見る。
 * - 信号1（同じ原因の失敗）は、まだ終わっていないタスクだけを見る。失敗をやり直して直したうえで
 *   mergeしたタスクは、もう続いていない
 * - 信号2（差し戻しの上限）は、まだ終わっていないタスクと直近にmergeしたタスクを見る。上限に
 *   達したまま指摘を残して進めたmergeは、それ自体が停滞の根拠になる
 * - 信号4（終了レビューの未達）は、終了レビューの後のmergeが1件以下の間だけ立てる。再開後の
 *   最初のmergeで見直しを求めれば足り、出し直した計画の全mergeに付け続けない
 */

/** 信号1: 同じ原因の失敗がこの件数以上で立つ。 */
export const STAGNATION_REPEATED_FAILURE_THRESHOLD = 1;
/** 信号2: 差し戻しが上限に達したタスクがこの件数以上で立つ。 */
export const STAGNATION_EXHAUSTED_TASK_THRESHOLD = 1;
/**
 * 信号3: 直近この件数のmergeで、各タスクの残り（残った指摘と未実測の場面の和）が1件以上かつ
 * 前のmerge以上なら立つ。2件だと残りが1件ずつのmergeが続いただけで立ち、不要な方式変更を招く。
 */
export const STAGNATION_LEFTOVER_WINDOW = 3;
/** 信号4: goalがあるrunで、終了レビューの判定が未達のまま続けて再開した回数がこれ以上で立つ。 */
export const STAGNATION_UNMET_REOPEN_THRESHOLD = 2;
/** 信号4: 終了レビューの後のmergeがこの件数以下の間だけ立てる（再開後の最初のmergeで知らせる）。 */
export const STAGNATION_UNMET_REOPEN_NOTICE_MERGES = 1;

/** 根拠に載せるタスクIDの長さの上限。 */
const TASK_ID_MAX_LENGTH = 16;

export type StagnationSignalKind =
  'repeatedFailure' | 'reviewRoundsExhausted' | 'leftoverNotDecreasing' | 'endReviewUnmetReopens';

export interface StagnationSignal {
  kind: StagnationSignalKind;
  /** 信号が立っているか。 */
  active: boolean;
  /** 根拠の数値（信号3は直近のmergeのうち残りが減らなかった件数）。 */
  value: number;
  threshold: number;
  /**
   * 根拠の1行。数とタスクID（`T<数字>`に限って保存されている）だけで、外部由来の自由文を含まない。
   * 判定できない（mergeが足りない・goalが無い）ときはその旨を書く。
   */
  detail: string;
}

export interface StagnationAssessment {
  /** 4つの信号。並びは`StagnationSignalKind`の順で固定。 */
  signals: StagnationSignal[];
  /** いずれかの信号が立っているか。 */
  stagnant: boolean;
}

function taskIdText(task: OrchestratedTask): string {
  return sanitizeInlineText(task.taskId, TASK_ID_MAX_LENGTH);
}

function isMerged(task: OrchestratedTask): boolean {
  return task.stages.mergeCleanup.status === 'done' && task.closedWithoutMerge === undefined;
}

/** mergeしたタスクをmergeの古い順に並べる。同時刻・時刻の無い保存データは計画の順（時刻の無いものが先）。 */
function mergedTasksInOrder(run: TaskRun): OrchestratedTask[] {
  return listTasks(run)
    .filter(isMerged)
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const at = a.task.stages.mergeCleanup.completedAt ?? '';
      const bt = b.task.stages.mergeCleanup.completedAt ?? '';
      return at === bt ? a.index - b.index : at < bt ? -1 : 1;
    })
    .map(({ task }) => task);
}

function isUnfinished(task: OrchestratedTask): boolean {
  return !isTaskDone(task) && task.closedWithoutMerge === undefined;
}

/** タスクの残り（残った指摘と未実測の場面の和）。reviewの結果が無ければ`undefined`。 */
function leftoverCount(task: OrchestratedTask): number | undefined {
  const { review } = task;
  if (review === undefined) {
    return undefined;
  }
  const scenes = review.ledger?.kind === 'parsed' ? review.ledger.digest.unsettledSceneCount : 0;
  return review.remainingFindings.length + scenes;
}

function repeatedFailureSignal(run: TaskRun): StagnationSignal {
  const value = listTasks(run)
    .filter(isUnfinished)
    .reduce((sum, task) => sum + countRepeatedFailures(task), 0);
  return {
    kind: 'repeatedFailure',
    active: value >= STAGNATION_REPEATED_FAILURE_THRESHOLD,
    value,
    threshold: STAGNATION_REPEATED_FAILURE_THRESHOLD,
    detail: `未完了のタスクの同じ原因の失敗${String(value)}件`,
  };
}

function exhaustedSignal(run: TaskRun, merged: readonly OrchestratedTask[]): StagnationSignal {
  const latest = merged.at(-1);
  const exhausted = listTasks(run)
    .filter((task) => task === latest || isUnfinished(task))
    .filter(isReviewRoundsExhausted);
  const ids = exhausted.map(taskIdText).join(', ');
  return {
    kind: 'reviewRoundsExhausted',
    active: exhausted.length >= STAGNATION_EXHAUSTED_TASK_THRESHOLD,
    value: exhausted.length,
    threshold: STAGNATION_EXHAUSTED_TASK_THRESHOLD,
    detail: `差し戻しが上限（${String(MAX_REVIEW_ROUNDS)}回）に達したタスク${String(exhausted.length)}件${ids === '' ? '' : `（${ids}）`}`,
  };
}

function leftoverSignal(merged: readonly OrchestratedTask[]): StagnationSignal {
  const recent = merged.slice(-STAGNATION_LEFTOVER_WINDOW);
  const counts = recent.map(leftoverCount);
  const base = {
    kind: 'leftoverNotDecreasing' as const,
    threshold: STAGNATION_LEFTOVER_WINDOW,
  };
  if (recent.length < STAGNATION_LEFTOVER_WINDOW) {
    return {
      ...base,
      active: false,
      value: 0,
      detail: `残りの推移は未判定（merge${String(merged.length)}件、${String(STAGNATION_LEFTOVER_WINDOW)}件から判定）`,
    };
  }
  const known = counts.filter((c): c is number => c !== undefined);
  if (known.length < counts.length) {
    return {
      ...base,
      active: false,
      value: 0,
      detail: `残りの推移は未判定（直近${String(STAGNATION_LEFTOVER_WINDOW)}件のmergeにreviewの結果が無いタスクがある）`,
    };
  }
  // 1件目は比べる前が無いので、残りが1件以上なら「減っていない」に数える
  let value = 0;
  for (const [i, count] of known.entries()) {
    const previous = i === 0 ? count : (known[i - 1] ?? count);
    if (count > 0 && count >= previous) {
      value += 1;
    }
  }
  const trend = known.map(String).join('→');
  const ids = recent.map(taskIdText).join('→');
  return {
    ...base,
    active: value >= STAGNATION_LEFTOVER_WINDOW,
    value,
    detail: `直近${String(STAGNATION_LEFTOVER_WINDOW)}件のmerge（${ids}）の残った指摘と未実測の場面: ${trend}件`,
  };
}

function unmetReopenSignal(run: TaskRun, merged: readonly OrchestratedTask[]): StagnationSignal {
  const base = {
    kind: 'endReviewUnmetReopens' as const,
    threshold: STAGNATION_UNMET_REOPEN_THRESHOLD,
  };
  if (readTaskRunGoal(run) === undefined) {
    return { ...base, active: false, value: 0, detail: '終了レビューの判定は対象外（goalなし）' };
  }
  const review = readTaskRunEndReview(run);
  // 直近の判定が達していれば、未達の続きは途切れている（再開時に0へ戻すのと同じ扱いを再開前から）
  const value = review?.lastVerdict === 'met' ? 0 : (review?.unmetReopens ?? 0);
  const detail = `終了レビューで完了条件が未達のまま再開${String(value)}回`;
  if (review === undefined || value < STAGNATION_UNMET_REOPEN_THRESHOLD) {
    return { ...base, active: false, value, detail };
  }
  const sentAt = review.sentAt;
  const mergedSince = merged.filter(
    (task) => (task.stages.mergeCleanup.completedAt ?? '') > sentAt,
  ).length;
  if (mergedSince > STAGNATION_UNMET_REOPEN_NOTICE_MERGES) {
    return {
      ...base,
      active: false,
      value,
      detail: `${detail}（再開後のmerge${String(mergedSince)}件で知らせ済み）`,
    };
  }
  return { ...base, active: true, value, detail };
}

/** runの停滞の信号を判定する。LLMを呼ばない純関数。 */
export function assessStagnation(run: TaskRun): StagnationAssessment {
  const merged = mergedTasksInOrder(run);
  const signals = [
    repeatedFailureSignal(run),
    exhaustedSignal(run, merged),
    leftoverSignal(merged),
    unmetReopenSignal(run, merged),
  ];
  return { signals, stagnant: signals.some((s) => s.active) };
}

/**
 * merge時の促しに添える停滞の1行。立った信号だけを根拠の数値付きで載せる。立っていなければ`undefined`。
 */
export function formatStagnationLine(assessment: StagnationAssessment): string | undefined {
  const active = assessment.signals.filter((s) => s.active);
  if (active.length === 0) {
    return undefined;
  }
  const reasons = active.map((s) => `${s.detail}（閾値${String(s.threshold)}）`).join(' / ');
  return `停滞: ${reasons}。方式そのものを見直してください。`;
}

/** `get_run_state`の集計に載せる信号の状態の1行。立っていない信号も根拠の数値を載せる。 */
export function formatStagnationStatus(assessment: StagnationAssessment): string {
  const parts = assessment.signals.map(
    (s) => `${s.active ? '[立つ] ' : ''}${s.detail}（閾値${String(s.threshold)}）`,
  );
  return `停滞の信号: ${assessment.stagnant ? 'あり' : 'なし'}（${parts.join(' / ')}）`;
}
