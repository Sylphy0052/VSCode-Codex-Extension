import type { GoalEvaluatorInput } from './goalLoop';
import type { TurnFocus } from './turnFocus';

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
  /**
   * 次のターンで見直すべき点（自由文）。**これは参考であって指示ではない。**
   *
   * Workerへ送る指示文は`focus`の固定文から組み立てる（issue #962）。
   */
  nextFocus: string;
  /** 次のターンの焦点。列挙値。省略時は`none`として扱う。 */
  focus?: TurnFocus;
  /** 判断の根拠にした証拠。 */
  evidence: string[];
}

/**
 * Advisorが動けなかった理由（issue #964）。
 *
 * `invalid-response`は「応答は返ったがJSONとして読めなかった」で、`process-error`は
 * 「起動できなかった・異常終了した・何も返らなかった」である。人が次に取る手が違う
 * （前者はモデルやプロンプトの問題、後者は実行ファイルや環境の問題）ため潰さない。
 */
export type LoopAdvisorFailureReason = 'timeout' | 'invalid-response' | 'process-error';

/**
 * Advisorの呼び出し結果（issue #964）。
 *
 * **「見たうえで指摘が無かった」と「そもそも動けなかった」を型で分ける。** 以前は失敗も
 * `noAdvice()`（`severity: 'note'`・空の`findings`）へ倒しており、会話の表示では
 * 「指摘はありませんでした」と出て、Advisorが一度も動いていないことが利用者に伝わって
 * いなかった。失敗でループを止めない方針（`noAdvice`のコメント）はそのまま維持する。
 */
export type LoopAdvisorResult =
  | { readonly status: 'ok'; readonly advice: LoopAdvice }
  | { readonly status: 'failed'; readonly reason: LoopAdvisorFailureReason };

/** `LoopAdvisorResult`の`ok`側を作る。 */
export function advisorOk(advice: LoopAdvice): LoopAdvisorResult {
  return { status: 'ok', advice };
}

/** `LoopAdvisorResult`の`failed`側を作る。 */
export function advisorFailed(reason: LoopAdvisorFailureReason): LoopAdvisorResult {
  return { status: 'failed', reason };
}

/**
 * Advisorの呼び出し。
 *
 * 入力はEvaluatorと同じ`GoalEvaluatorInput`を使い回す。Advisorのために別途
 * `thread/fork`して材料を作り直すと、1ターンあたりの待ち時間がもう1本増えるうえ、
 * 同じターンについてEvaluatorとAdvisorが違う材料を見ることになる。
 *
 * **失敗時も例外を投げず`advisorFailed(...)`を返す実装を期待する。**
 */
export type LoopAdvisorFn = (input: GoalEvaluatorInput) => Promise<LoopAdvisorResult>;

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
   *
   * **実装は例外を投げないこと。** Advisorは脇役であり、その表示が失敗しただけで本編
   * （停止判定・次ターンの送信）が止まってはならない。`LoopController`側でも呼び出しを
   * `try`で囲んで守るが、契約としてもここに書いておく（issue #964）。
   */
  note?: (note: LoopAdvisorNote, iteration: number) => void;
}

/**
 * 会話へ残すAdvisorの記録（issue #964）。
 *
 * 失敗のときは連続回数を添える。1回の失敗は流してよいが、**Advisorが実質無効になって
 * いること**は利用者に分かる必要がある。回数を数えるのは`LoopController`の責務で、
 * 表示側はその値で言い方を変えるだけにする。
 */
export type LoopAdvisorNote =
  | { readonly status: 'ok'; readonly advice: LoopAdvice }
  | {
      readonly status: 'failed';
      readonly reason: LoopAdvisorFailureReason;
      /** このターンを含めて、Advisorが連続で動けなかった回数。1以上。 */
      readonly consecutiveFailures: number;
    };

/**
 * 連続失敗を「Advisorが実質無効になっている」と見なす回数。
 *
 * 1回で騒ぐと、単発の時間切れでも警告が出て慣れの対象になる。2回続いた時点から言い方を
 * 変える。
 */
export const ADVISOR_FAILURE_ALERT_THRESHOLD = 2;

/**
 * 指摘なしの結果。**Advisorが動いたうえで指摘が無かった周**にだけ使う。
 *
 * 呼び出しに失敗した周へは使わない（issue #964）。失敗を「指摘なし」に倒すと、
 * 会話の表示で「見たうえで無かった」と区別できなくなる。失敗は`advisorFailed(...)`で返し、
 * `LoopController`が連続回数を数えて表示側へ渡す。
 *
 * **失敗を`blocker`にも倒さない。** Advisorが落ちただけでループ全体が人待ちになると、
 * 脇役の不調が本編を止めることになる。失敗を握り潰していることが分からないと困るため、
 * 呼び出し側（`loopAdvisorProcess.ts`）はログへ理由を残す。
 */
export function noAdvice(): LoopAdvice {
  return { severity: 'note', findings: [], nextFocus: '', evidence: [], focus: 'none' };
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
