import type { GoalEvaluatorInput } from './goalLoop';

/**
 * ループのAdvisor（issue #957）の型。
 *
 * ゴール駆動ループ（issue #892）のEvaluatorは「ゴールを達成したか」だけを見る**止める側**
 * であり、進め方が妥当かは誰も問うていなかった。Advisorはその欠けを埋める第三者で、
 * Evaluatorと**並列に**走り、同じ材料を別の目で見る。
 *
 * `goalLoop.ts`と同じく`vscode`には依存しない。実際の呼び出し（プロセス起動）は
 * `loopAdvisorProcess.ts`が持ち、ここには型だけを置く。
 */

/**
 * Advisorの深刻度。**`blocker`のときだけループを止める。**
 *
 * 3値にしているのは、止める/止めないの2値だと「気になるが続けてよい」を表せず、
 * Advisorが止めるか黙るかの二択を迫られるためである。黙られると指摘が次のターンへ
 * 伝わらず、止められると人の手が要る。
 */
export type AdviceSeverity = 'blocker' | 'concern' | 'note';

/**
 * Advisorの出力。**自由文の指示（次ターンのユーザープロンプトそのもの）は含めない。**
 *
 * 理由は`GoalEvaluation`と同じ。指示文の組み立ては`LoopController`側の責務とし、
 * Advisorへ完全なプロンプト生成権限を渡さない。issue #929が人ゲートで守ろうとした
 * 「Advisorの生の分析をそのまま作業指示にしない」という原則を、構造で代替する。
 */
export interface LoopAdvice {
  severity: AdviceSeverity;
  /** 指摘。1件1行の観察であって、命令形の指示ではない。 */
  findings: string[];
  /** 次のターンで見直すべき点。1〜2文。 */
  nextFocus: string;
  /** 判断の根拠にした証拠。 */
  evidence: string[];
}

/**
 * Advisorの呼び出し。
 *
 * 入力はEvaluatorと同じ`GoalEvaluatorInput`を使い回す。Advisorのために別途
 * `thread/fork`して材料を作り直すと、1ターンあたりの待ち時間がもう1本増えるうえ、
 * 同じターンについてEvaluatorとAdvisorが違う材料を見ることになる。
 *
 * **失敗時も例外を投げず`noAdvice()`を返す実装を期待する。**
 */
export type LoopAdvisorFn = (input: GoalEvaluatorInput) => Promise<LoopAdvice>;

/** Advisorを呼ぶ間隔の既定（毎ターン）。 */
export const DEFAULT_ADVISOR_EVERY_N_TURNS = 1;

/** `LoopPlan`へ載せるAdvisorの設定。省略するとAdvisorを呼ばない。 */
export interface LoopAdvisorConfig {
  advise: LoopAdvisorFn;
  /** 何ターンごとに呼ぶか。既定は`DEFAULT_ADVISOR_EVERY_N_TURNS`。 */
  everyNTurns?: number;
  /**
   * 会話へ残すための差し込み口（view層が渡す）。省略すると会話には残らない。
   *
   * `LoopController`は`vscode`にも`ChatSession`にも依存しないため、実際の差し込みは
   * 呼び出し側の責務にしてある（`evaluate`を設定側から渡しているのと同じ流儀）。
   */
  note?: (advice: LoopAdvice, iteration: number) => void;
}

/**
 * 指摘なしの結果。Advisorの呼び出しに失敗したときにも使う。
 *
 * **失敗を`blocker`に倒さない。** Advisorが落ちただけでループ全体が人待ちになると、
 * 脇役の不調が本編を止めることになる。逆に失敗を握り潰していることが分からないと
 * 困るため、呼び出し側（`loopAdvisorProcess.ts`）はログへ理由を残す。
 */
export function noAdvice(): LoopAdvice {
  return { severity: 'note', findings: [], nextFocus: '', evidence: [] };
}

/**
 * このターンでAdvisorを呼ぶか。
 *
 * `everyNTurns`が2以上のときは、そのターン数ごとにだけ呼ぶ。0以下・数値でない値は
 * 毎ターン（既定）として扱う——「呼ばない」に倒すと、設定の誤りでAdvisorが黙ったまま
 * 走り続けることになる。
 */
export function shouldAdvise(iteration: number, everyNTurns: number | undefined): boolean {
  const interval =
    everyNTurns === undefined || !Number.isFinite(everyNTurns) || everyNTurns < 1
      ? DEFAULT_ADVISOR_EVERY_N_TURNS
      : Math.floor(everyNTurns);
  return iteration % interval === 0;
}
