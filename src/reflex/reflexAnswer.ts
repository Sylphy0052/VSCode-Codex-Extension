import type { ReflexAnswer } from './reflexJudge';

/**
 * `judge()`の答えを呼出元で扱うための共通処理（Issue #1728）。
 *
 * 答えの種類の検査・確率の取り出し・表示の整形を、判定ごとに書き写さないためにまとめる。
 * 閾値の意味と既定値、結果の型は判定ごとに違うため、ここでは持たない。
 */

export type ChoiceAnswer = Extract<ReflexAnswer, { kind: 'choice' }>;
export type NoulAnswer = Extract<ReflexAnswer, { kind: 'noul' }>;

/**
 * 判定できなかったとき（呼出の失敗・読めない応答・想定外の種類の答え）の扱い。
 * 呼出元ごとに1つを選び、`*_FALLBACK`の定数で明示する。
 *
 * - `askHuman`: 人の判断へ回す（計画審査・工程の質問）
 * - `stop`: 安全側で止める（危険度ゲート）
 * - `withoutReflex`: Reflexなしの動作に戻す（自動返信の完了検証・skill選択）
 * - `none`: 何もしない（引き継ぎの区切り）
 * - `treatAsDone`: 完了扱いで止める（ループ完了）
 */
export type ReflexFallback = 'askHuman' | 'stop' | 'withoutReflex' | 'none' | 'treatAsDone';

/** 答えが`choice`ならそれを返す。欠けている・種類が違うときは`undefined`。 */
export function choiceAnswer(answer: ReflexAnswer | undefined): ChoiceAnswer | undefined {
  return answer?.kind === 'choice' ? answer : undefined;
}

/** 答えが`noul`ならそれを返す。欠けている・種類が違うときは`undefined`。 */
export function noulAnswer(answer: ReflexAnswer | undefined): NoulAnswer | undefined {
  return answer?.kind === 'noul' ? answer : undefined;
}

/** 選択肢の確率。答えに無い選択肢は0。 */
export function choiceProbability(answer: ChoiceAnswer, label: string): number {
  return answer.probabilities[label] ?? 0;
}

/** 最上位の選択肢の確率。 */
export function bestChoiceProbability(answer: ChoiceAnswer): number {
  return choiceProbability(answer, answer.best);
}

/** 確率の表示。判定の要約とログで同じ桁数に揃える。 */
export function formatReflexProbability(p: number): string {
  return p.toFixed(2);
}

/** 選択肢ごとの確率を`a 0.12 / b 0.80`の形で並べる。答えに無い選択肢は0。 */
export function describeReflexChoice(
  labels: readonly string[],
  probabilities: Readonly<Record<string, number>>,
): string {
  return labels
    .map((label) => `${label} ${formatReflexProbability(probabilities[label] ?? 0)}`)
    .join(' / ');
}
