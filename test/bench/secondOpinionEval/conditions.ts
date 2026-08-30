/**
 * 比較する条件の定義（Issue #1044）。
 *
 * 条件は「現行からの介入を1つずつ足していく」形で並べる。差が出たときにどの介入が効いたのかを
 * 言えるようにするためで、複数の介入をまとめて入れた条件は作らない。
 *
 * 現時点で実装があるのはAとBだけである。C以降は後続Issueで足す。**先に空の条件を置かない。**
 * 実行できない条件を一覧へ並べておくと、結果ファイルに条件名だけが残り、走らせたのか失敗したのか
 * 後から区別できなくなる。
 */

import type { EvalCondition } from './types';

/** 現行のまま。ベースライン。 */
const CONDITION_A: EvalCondition = {
  id: 'A',
  description: '現行（ベースライン）',
  apply: (input) => input,
};

/**
 * 依頼文をプロンプト末尾へ置き直す（`SecondOpinionInput.restateRequestAtEnd`）。
 *
 * 最初の介入にこれを選んだのは、実装が数行で済み、効果があってもなくても以後の判断材料になるため
 * （Issue #1044）。
 */
const CONDITION_B: EvalCondition = {
  id: 'B',
  description: 'A + 依頼文をプロンプト末尾へ再掲',
  apply: (input) => ({ ...input, restateRequestAtEnd: true }),
};

export const EVAL_CONDITIONS: readonly EvalCondition[] = [CONDITION_A, CONDITION_B];

/** 条件名から引く。未知の名前は `undefined`。 */
export function findCondition(id: string): EvalCondition | undefined {
  return EVAL_CONDITIONS.find((condition) => condition.id === id);
}
