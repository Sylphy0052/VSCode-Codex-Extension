/**
 * 比較する条件の定義（Issue #1044）。
 *
 * 条件は「現行から**1つだけ**変える」形で並べる。1つの条件で複数を同時に変えると、差が出ても
 * どれが効いたのかを言えない。
 *
 * 現時点で実装があるのはA・B-pos・B-repeatだけである。C以降は後続Issueで足す。**先に空の条件を
 * 置かない。** 実行できない条件を一覧へ並べておくと、結果ファイルに条件名だけが残り、走らせたのか
 * 失敗したのか後から区別できなくなる。
 */

import type { EvalCondition } from './types';

/** 現行のまま。ベースライン。 */
const CONDITION_A: EvalCondition = {
  id: 'A',
  description: '現行（ベースライン）',
  apply: (input) => input,
};

/**
 * 依頼の区画を末尾へ**移動**する（`SecondOpinionInput.requestPosition`）。
 *
 * 位置だけを変える条件。見出し・本文・トークン数・出現回数が条件Aと同一で、違うのは並びだけに
 * なる。「資料を読み終えた直後に依頼がある」ことに効果があるのかを、これで単独に測る。
 */
const CONDITION_B_POS: EvalCondition = {
  id: 'B-pos',
  description: '依頼を末尾へ移動（位置のみを変える）',
  apply: (input) => ({ ...input, requestPosition: 'end' }),
};

/**
 * 依頼を末尾へ再掲する（`SecondOpinionInput.restateRequestAtEnd`）。
 *
 * こちらは**実用寄りの介入**で、位置の実験ではない。冒頭の依頼を残したまま末尾へ再掲するので、
 * 位置に加えて「同じ依頼が2回出ること」「最終確認という見出し」「読み直しを促す一文」が同時に
 * 変わる。B-posと差が出たら、その差が位置以外の要素の寄与になる。
 */
const CONDITION_B_REPEAT: EvalCondition = {
  id: 'B-repeat',
  description: 'A + 依頼文をプロンプト末尾へ再掲（位置以外も変わる実用介入）',
  apply: (input) => ({ ...input, restateRequestAtEnd: true }),
};

export const EVAL_CONDITIONS: readonly EvalCondition[] = [
  CONDITION_A,
  CONDITION_B_POS,
  CONDITION_B_REPEAT,
];

/** 条件名から引く。未知の名前は `undefined`。 */
export function findCondition(id: string): EvalCondition | undefined {
  return EVAL_CONDITIONS.find((condition) => condition.id === id);
}
