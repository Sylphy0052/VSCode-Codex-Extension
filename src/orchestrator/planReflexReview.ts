/**
 * LLMが提案した計画をReflexで判定する共通処理。ロードマップ実行（Issue #1465、
 * `roadmapPlanProposal.ts`）とオーケストレータモード（Issue #1505、`taskRunPlanReview.ts`）の
 * どちらも、計画をそのまま実行に使う前にReflexへ1問（3択）だけ聞き、「妥当」が最上位かつ
 * 閾値以上のときだけ自動で先へ進める。判定を得られない場合（時間切れ、不正なJSON、
 * 「判定できない」）は必ず利用者の判断待ちにする。
 *
 * `situation`・`state`・`question`の文面はドメインごとに異なるため、ここでは持たない
 * （呼び出し側が組む）。判定器の呼び出しと閾値の比較だけをここに集約し、#1465の挙動は
 * 変えずに#1554へ流用する。
 */
import { judge, type ReflexJudgeDeps } from '../reflex/reflexJudge';

/** Reflexの「妥当」の確率がこれ以上なら、利用者に聞かずに進める。確率は較正されていない仮置き。 */
export const DEFAULT_PLAN_APPROVE_THRESHOLD = 0.8;

export const REVIEW_VALID = '妥当';
export const REVIEW_WRONG = '誤りがある';
export const REVIEW_UNKNOWN = '判定できない';
export const REVIEW_OPTIONS = [REVIEW_VALID, REVIEW_WRONG, REVIEW_UNKNOWN] as const;

export type PlanReflexVerdict =
  | { kind: 'approved'; summary: string }
  | { kind: 'needsUser'; summary: string };

/**
 * `situation`・`state`・`question`でReflexへ判定を1問（3択）だけ聞く。「妥当」が最上位かつ
 * `threshold`以上のときだけ`approved`。判定を得られなければ`needsUser`。
 */
export async function reviewPlanWithReflex(
  reflex: ReflexJudgeDeps,
  situation: string,
  state: string,
  question: string,
  threshold: number,
): Promise<PlanReflexVerdict> {
  const answers = await judge(reflex, {
    situation,
    state,
    questions: [{ kind: 'choice', question, options: REVIEW_OPTIONS }],
  });
  const answer = answers?.[0];
  if (answer?.kind !== 'choice') {
    return { kind: 'needsUser', summary: 'Reflexの判定を得られませんでした' };
  }
  const summary = REVIEW_OPTIONS.map(
    (label) => `${label} ${(answer.probabilities[label] ?? 0).toFixed(2)}`,
  ).join(' / ');
  const valid = answer.probabilities[REVIEW_VALID] ?? 0;
  return answer.best === REVIEW_VALID && valid >= threshold
    ? { kind: 'approved', summary }
    : { kind: 'needsUser', summary };
}

export type { ReflexJudgeDeps };
