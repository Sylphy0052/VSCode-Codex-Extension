import type { GoalDefinition, GoalEvaluation, GoalEvidence, GoalVerdict } from './goalLoop';
import type { TurnFocus } from './turnFocus';

/**
 * ループのAdvisor（issue #957）の型。
 *
 * ゴール駆動ループ（issue #892）のEvaluatorは「ゴールを達成したか」だけを見る**止める側**
 * であり、進め方が妥当かは誰も問うていなかった。Advisorはその欠けを埋める第三者である。
 *
 * **Advisorは毎ターンは呼ばない（issue #1323）。** Evaluatorの判定を受けてから、行き詰まり
 * が見えた周にだけ呼ぶ。材料も証拠の全文ではなくEvaluatorの構造化された判定へ置き換える
 * （`AdvisorInput`）。以前は毎ターンEvaluatorと並列に走らせ、同じ材料（最大30,000字）を
 * 2本へ送っていたため、200ターンのループでは同じ本文を二重に送り続けていた。
 *
 * **統合はしない。** Evaluatorの判定とAdvisorの助言を1回の生成へまとめると、評価を前提に
 * した助言になり（self-anchoring）、評価の誤りを助言側が独立して訂正できなくなる。止める
 * 権限はEvaluatorに残したままで、呼ぶ回数だけを減らす。
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
 * 証拠の見出し（issue #1323）。**本文（`detail`）は持たない。**
 *
 * Advisorへ渡すのは「何をどこで測って、通ったか落ちたか」までで、出力の全文は渡さない。
 * 進め方の妥当性を見るのに本文は要らず、本文こそが送信量の大半を占めていた。落ちた証拠の
 * 中身まで読む必要があるのはEvaluator（達成判定の側）である。
 */
export interface AdvisorEvidenceRef {
  kind: GoalEvidence['kind'];
  /** 実行したコマンド行など、証拠の出どころ。関連するファイルパスはここに現れる。 */
  source: string;
  status: GoalEvidence['status'];
  iteration: number;
}

/** Advisorへ渡す証拠の見出しの上限件数。新しいものを残す。 */
export const ADVISOR_EVIDENCE_REF_LIMIT = 20;

/**
 * 証拠のledgerを見出しだけへ落とす（issue #1323）。**`detail`は落とす。**
 *
 * 件数の絞り込みはここでは行わない（`formatEvidenceRefs`が新しい分だけを載せる）。
 * 何件あったかをAdvisorへ伝えられるよう、落とす判断はプロンプトの組み立て側に寄せる。
 */
export function toAdvisorEvidenceRefs(
  evidence: readonly GoalEvidence[],
): readonly AdvisorEvidenceRef[] {
  return evidence.map((item) => ({
    kind: item.kind,
    source: item.source,
    status: item.status,
    iteration: item.iteration,
  }));
}

/**
 * Advisorを呼んだ理由（issue #1323）。**どれか1つが成立した周にだけ呼ぶ。**
 *
 * - `repeated-gaps`: 同じ未達の受入条件が続いている（同じ場所で足踏みしている）
 * - `no-progress`: 応答テキストが変わっていない（作業自体が進んでいない）
 * - `indeterminate-streak`: 証拠不足で判定できない周が続いている（測り方が噛み合っていない）
 *
 * 理由をそのままAdvisorへ渡すのは、「なぜ今あなたに訊いているか」が分かる方が指摘が
 * 噛み合うためである。値は列挙であり、Advisorへ送る文面は`advisorPrompt.ts`の固定文から
 * 組み立てる（自由文を外から差し込ませない）。
 */
export type AdvisorTrigger = 'repeated-gaps' | 'no-progress' | 'indeterminate-streak';

/**
 * Advisorへ渡す材料（issue #1323）。
 *
 * 証拠の全文・直近の応答本文・要約は渡さない。Evaluatorが構造化して出した判定
 * （`evaluation`）と、ゴール本文、証拠の見出しだけを渡す。
 */
export interface AdvisorInput {
  goal: GoalDefinition;
  /** 何回目のターンか。 */
  iteration: number;
  /** この周のEvaluatorの判定。Advisorが見る「現状」はこれが正本。 */
  evaluation: GoalEvaluation;
  /** 証拠の見出し（本文なし）。 */
  evidenceRefs: readonly AdvisorEvidenceRef[];
  /** この周にAdvisorを呼んだ理由。 */
  trigger: AdvisorTrigger;
}

/**
 * Advisorの呼び出し。
 *
 * **失敗時も例外を投げず`advisorFailed(...)`を返す実装を期待する。**
 */
export type LoopAdvisorFn = (
  input: AdvisorInput,
  signal?: AbortSignal,
) => Promise<LoopAdvisorResult>;

/** Advisorを呼ぶ間隔の既定（毎ターン）。 */
export const DEFAULT_ADVISOR_EVERY_N_TURNS = 1;

/**
 * Advisorを動かすプロバイダの既定（issue #994）。
 *
 * `inherit`（会話しているのと同じCLI）にはしない。Advisorの役割は「別の目で進め方を見る」
 * ことであり、どちらの画面からループを回したかで相談先が変わると、指摘の出所が安定しない。
 */
export const DEFAULT_ADVISOR_PROVIDER = 'codex';

/**
 * `model: auto` のとき、Codexで動かすAdvisorに使うモデル（issue #994）。
 *
 * セカンドオピニオンの既定候補（`DEFAULT_SECOND_OPINION_CANDIDATES`）とモデル名を揃えて
 * ある。ただし reasoning effort は揃っていない——Advisorの起動引数には effort を渡す経路が
 * 無く、`Sol (high)` と同じ条件にはならない。
 *
 * **これはCodex用であり、設定の既定値そのものではない。** `agent.chat.loopAdvisor.model` の
 * 既定は `auto` のままにしてある。設定側をモデル名で固定してしまうと、`provider` だけを
 * `claude` へ変えた利用者にCodex用のモデル名がそのまま渡る（`buildClaudeHeadlessArgs` は
 * `auto` 以外を素通しする）。解決は実効プロバイダが決まる場所で行う。
 */
export const DEFAULT_ADVISOR_CODEX_MODEL = 'gpt-6-sol';

/**
 * `agent.chat.loopAdvisor.model` を、実際に起動するCLIに合わせて解決する（issue #994）。
 *
 * 明示されたモデル名は必ず優先する。`auto` のときだけプロバイダごとの既定へ倒す。
 */
export function resolveAdvisorModel(model: string, provider: 'claude' | 'codex'): string {
  if (model !== 'auto' && model !== '') {
    return model;
  }
  return provider === 'codex' ? DEFAULT_ADVISOR_CODEX_MODEL : 'auto';
}

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
  note?: (note: LoopAdvisorNote, iteration: number, runId: number) => void;
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
    }
  /**
   * 連続失敗が続いたため、この実行の残りではAdvisorを呼ばないと決めた（issue #1009）。
   *
   * `failed`の連続と違い、**この先はもう呼ばれない**ことを伝える。1回だけ出す。
   */
  | {
      readonly status: 'disabled';
      readonly reason: LoopAdvisorFailureReason;
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
 * 連続失敗が何回続いたら、その実行でAdvisorを呼ぶのをやめるか（issue #1009）。
 *
 * 1回の呼び出しは最大`timeoutSeconds`（既定120秒）待つ。時間切れが続く状態は、指摘が
 * 得られないまま毎ターン待たされるだけなので、実質無効になったところで打ち切る。
 * `ADVISOR_FAILURE_ALERT_THRESHOLD`（警告の文面を変える回数）より大きくしてある——
 * 警告を出す前に呼ぶのをやめると、利用者が気づく前に黙って止まることになる。
 */
export const ADVISOR_FAILURE_DISABLE_THRESHOLD = 3;

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
 * 同じ未達の受入条件が続いたと見なす回数（issue #1323）。**この回数に達した周で呼ぶ。**
 *
 * 3にしてあるのは、受入条件は達成までの何周かは未達のまま残るのが普通で、2周では
 * 「足踏み」と「順当に進んでいる途中」を分けられないためである。1では未達が出た周に必ず
 * 呼ぶことになり、条件付きにした意味が無くなる。
 */
export const ADVISOR_REPEATED_GAPS_THRESHOLD = 3;

/**
 * 一度Advisorを呼んだあと、次に呼べるようになるまでの間隔（issue #1323）。
 *
 * **これが無いと、行き詰まりの連続数は増え続けるため毎ターン呼ぶのと変わらなくなる。**
 * 同じ受入条件が未達のまま10周続けば、しきい値を超えた後の8周はすべて条件を満たす。
 * 助言を受けた周の次からは、その助言を試す周を与える。
 */
export const ADVISOR_COOLDOWN_TURNS = 3;

/**
 * 応答が変わらないターンが続いたと見なす回数（issue #1323）。
 *
 * ループ自体を止める停滞判定（`DEFAULT_STALL_REPEAT_COUNT`は4）より手前に置く。止める前に
 * 一度は別の目を入れて抜け道を探させるためで、止めてから人が見るのでは遅い。
 *
 * ただしこの前後関係が保たれるのは`agent.workflows.stallRepeatCount`が既定のときだけで
 * ある。利用者が下限の`MIN_STALL_REPEAT_COUNT`（2）まで下げると、応答が2周同じになった
 * 時点でループ自体が止まり、この理由でAdvisorを呼ぶ周は来なくなる。止める設定を明示的に
 * 狭めた利用者の意図を優先し、こちらのしきい値は連動させない。
 */
export const ADVISOR_NO_PROGRESS_THRESHOLD = 2;

/**
 * 証拠不足の判定が続いたと見なす回数（issue #1323）。
 *
 * `DEFAULT_MAX_INDETERMINATE`（3回で人へ渡す）より手前で呼ぶ。証拠が取れていない原因は
 * 進め方にあることが多く、人へ渡す前にAdvisorへ見せる価値がある。
 *
 * `ADVISOR_NO_PROGRESS_THRESHOLD`と同じく、この前後関係は
 * `agent.chat.goalEvaluator.maxIndeterminate`が既定（3）のときのものである。利用者が1や2へ
 * 下げると、Advisorを呼ぶ前に人へ渡る。人へ渡す回数を明示的に狭めた設定を、こちらの都合で
 * 押し戻さない。
 */
export const ADVISOR_INDETERMINATE_THRESHOLD = 2;

/** `decideAdvisorTrigger`が見るループの状態。いずれの連続数もこのターンを含む。 */
export interface AdvisorTriggerState {
  /** この周のEvaluatorの判定。 */
  verdict: GoalVerdict;
  /**
   * 前回Advisorを呼んでから何ターン経ったか。**まだ一度も呼んでいなければ`undefined`。**
   *
   * 0以下（同じ周で二度見る）はありえないが、来たときは呼ばない側へ倒す。
   */
  turnsSinceLastAdvice: number | undefined;
  /** 同じ未達の受入条件（`gaps`）が続いた回数。 */
  repeatedGapsStreak: number;
  /** 応答テキストが変わらなかったターンの連続数。 */
  noProgressStreak: number;
  /** `indeterminate`の連続数。 */
  indeterminateStreak: number;
}

/**
 * この周でAdvisorを呼ぶ理由があるか（issue #1323）。無ければ`undefined`。
 *
 * **終局の判定（`achieved` / `escalate`）では呼ばない。** 達成した周に進め方を訊いても
 * 次のターンは無く、人へ渡す周は人が見る。呼ぶのは「まだ続くが行き詰まっている」周だけ。
 *
 * 理由が複数成立したときは`repeated-gaps` → `no-progress` → `indeterminate-streak`の順で
 * 返す。どれで呼んでも呼ぶこと自体は変わらないため、原因として具体的な順に並べてある。
 *
 * 一度呼んだ後は`ADVISOR_COOLDOWN_TURNS`の間は呼ばない。助言を試す周を与えないまま
 * 続けて相談しても、同じ材料から同じ指摘が返るだけである。
 */
export function decideAdvisorTrigger(state: AdvisorTriggerState): AdvisorTrigger | undefined {
  if (state.verdict === 'achieved' || state.verdict === 'escalate') {
    return undefined;
  }
  // 直前に相談したばかりの周は呼ばない。行き詰まりの連続数は解消するまで増え続けるため、
  // 間隔を空けないと「しきい値を超えて以降は毎ターン」になる
  if (
    state.turnsSinceLastAdvice !== undefined &&
    state.turnsSinceLastAdvice < ADVISOR_COOLDOWN_TURNS
  ) {
    return undefined;
  }
  if (state.repeatedGapsStreak >= ADVISOR_REPEATED_GAPS_THRESHOLD) {
    return 'repeated-gaps';
  }
  if (state.noProgressStreak >= ADVISOR_NO_PROGRESS_THRESHOLD) {
    return 'no-progress';
  }
  if (state.indeterminateStreak >= ADVISOR_INDETERMINATE_THRESHOLD) {
    return 'indeterminate-streak';
  }
  return undefined;
}

/**
 * 未達の受入条件（`gaps`）の署名。**同じ場所で足踏みしているかの比較にだけ使う。**
 *
 * 並び順の違いで別物と見なさないよう並べ替える。空（未達の指摘が無い）ときは`undefined`を
 * 返し、比較不能として扱う——空が続くことを「同じ場所で足踏み」と読み替えない。
 */
export function gapsSignature(gaps: readonly string[]): string | undefined {
  const normalized = gaps.map((gap) => gap.trim()).filter((gap) => gap !== '');
  if (normalized.length === 0) {
    return undefined;
  }
  return [...normalized].sort().join('\n');
}

/**
 * このターンでAdvisorを呼んでよい間隔か。
 *
 * `everyNTurns`が2以上のときは、そのターン数ごとにだけ呼ぶ。0以下・数値でない値は
 * 毎ターン（既定）として扱う——「呼ばない」に倒すと、設定の誤りでAdvisorが黙ったまま
 * 走り続けることになる。
 *
 * **これは上限であって呼ぶ条件ではない（issue #1323）。** 既定（毎ターン）でも実際に呼ぶ
 * のは`decideAdvisorTrigger`が理由を返した周だけで、この関数は「その周に呼んでよいか」を
 * 間隔の側から絞るだけである。
 */
export function shouldAdvise(iteration: number, everyNTurns: number | undefined): boolean {
  const interval =
    everyNTurns === undefined || !Number.isFinite(everyNTurns) || everyNTurns < 1
      ? DEFAULT_ADVISOR_EVERY_N_TURNS
      : Math.floor(everyNTurns);
  return iteration % interval === 0;
}
