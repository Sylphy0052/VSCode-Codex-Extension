import { describe, expect, it } from 'vitest';
import {
  REVIEW_UNKNOWN,
  REVIEW_VALID,
  REVIEW_WRONG,
  reviewPlanWithReflex,
} from '../../src/orchestrator/planReflexReview';
import { REFLEX_PROCESS_ERROR, REFLEX_TIMEOUT, reflexAnswers, reflexStub } from '../helpers/reflexStub';

/** Issue #1717: 計画審査（`reviewPlanWithReflex`）の判定結果ごとの分岐。 */

const THRESHOLD = 0.8;

function review(stub: ReturnType<typeof reflexStub>) {
  return reviewPlanWithReflex(stub.deps, '前提', '計画の本文', '計画は妥当か', THRESHOLD);
}

function probs(valid: number, wrong: number, unknown: number) {
  return { probs: { [REVIEW_VALID]: valid, [REVIEW_WRONG]: wrong, [REVIEW_UNKNOWN]: unknown } };
}

describe('reviewPlanWithReflex', () => {
  it('「妥当」が最上位かつ閾値以上ならapproved', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.85, 0.1, 0.05)));
    await expect(review(stub)).resolves.toEqual({
      kind: 'approved',
      summary: '妥当 0.85 / 誤りがある 0.10 / 判定できない 0.05',
    });
    expect(stub.prompts).toHaveLength(1);
  });

  it('閾値ちょうどはapproved', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.8, 0.15, 0.05)));
    await expect(review(stub)).resolves.toMatchObject({ kind: 'approved' });
  });

  it('「妥当」が最上位でも閾値未満ならneedsUser', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.6, 0.3, 0.1)));
    await expect(review(stub)).resolves.toEqual({
      kind: 'needsUser',
      summary: '妥当 0.60 / 誤りがある 0.30 / 判定できない 0.10',
    });
  });

  it('「誤りがある」が最上位ならneedsUser', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.1, 0.85, 0.05)));
    await expect(review(stub)).resolves.toMatchObject({ kind: 'needsUser' });
  });

  it('「判定できない」が最上位ならneedsUser', async () => {
    const stub = reflexStub(reflexAnswers(probs(0.05, 0.05, 0.9)));
    await expect(review(stub)).resolves.toMatchObject({ kind: 'needsUser' });
  });

  it.each([
    ['時間切れ', REFLEX_TIMEOUT],
    ['CLIの失敗', REFLEX_PROCESS_ERROR],
    ['不正なJSON', { ok: true as const, text: '判定できません' }],
    ['確率の合計が1から外れた答え（Issue #1715）', reflexAnswers(probs(0.5, 0.05, 0))],
  ])('%sはneedsUser', async (_label, outcome) => {
    const stub = reflexStub(outcome);
    await expect(review(stub)).resolves.toEqual({
      kind: 'needsUser',
      summary: 'Reflexの判定を得られませんでした',
    });
  });

  it('CLIの呼び出しが例外を投げてもneedsUser', async () => {
    const stub = reflexStub(new Error('spawn failed'));
    await expect(review(stub)).resolves.toMatchObject({ kind: 'needsUser' });
  });
});
