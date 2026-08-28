import type { ChatState } from '../appserver/chatState';
import {
  detectStalledLoop,
  extractTurnSignature,
  pushTurnSignature,
  DEFAULT_STALL_REPEAT_COUNT,
} from './stallDetector';
import {
  appendLoopEngineeringInstruction,
  declaresEscalate,
  type LoopEngineeringConfig,
  type LoopEngineeringPhase,
} from './loopEngineering';
import {
  appendEvidence,
  buildWorkerReportEvidence,
  collectCommandEvidence,
  collectRecentTurns,
  DEFAULT_MAX_INDETERMINATE,
  isSettledCommandItem,
  normalizeGoalDefinition,
  type GoalEvaluator,
  type GoalEvidence,
  type GoalLoopConfig,
} from './goalLoop';
import { buildNextTurnPrompt, indeterminate } from './goalPrompt';
import { buildResponseSummary } from '../orchestrator/taskSummary';

/**
 * ループの終了をエージェント自身に宣言させるための合図。
 *
 * 会話に紛れない綴りにしてある。エージェントの発言にこれが現れたら条件成立とみなす。
 */
export const LOOP_DONE_TOKEN = '<<LOOP_DONE>>';

/** 暴走を止めるための上限。画面から指定できる回数もここで頭打ちにする。 */
export const LOOP_ITERATION_LIMIT = 200;

export interface LoopPlan {
  /** 1回目に送る指示。空なら継続指示で始める。 */
  initialPrompt: string;
  /** 2回目以降に繰り返す指示。 */
  continuePrompt: string;
  /** 送信回数の上限。1回目を含めて数える。 */
  maxIterations: number;
  /** 終了条件。空でなければ指示へ添えて、成立時に合図を出すよう頼む。 */
  condition: string;
  /**
   * ループ全体の時間上限（ミリ秒）。省略すると時間では止めない（issue #891）。
   *
   * 反復上限（`maxIterations`）だけでは、1ターンが長いループを縛れない。単独の停止条件は
   * どれも壊れる（回数だけでは伸びしろがあるのに止まり、条件だけでは頭打ちのまま回り続ける）
   * ため、`maxIterations` / `maxDurationMs` / 停滞検知の3本を並立させる。
   */
  maxDurationMs?: number;
  /**
   * ループエンジニアリングモードの設定（issue #891）。省略すると指示文を足さない。
   *
   * 有効なとき、`dispatch`が1回目は`initialInstruction`を、2回目以降は
   * `continueInstruction`を送信文の末尾へ連結する。設定の読み出しは呼び出し側の責務
   * （`stallThreshold`と同じく、`LoopController`自身は`vscode`に依存させない）。
   */
  engineering?: LoopEngineeringConfig;
  /**
   * ゴール駆動ループの設定（issue #892）。省略すると従来どおり`continuePrompt`を繰り返す。
   *
   * 有効なとき、各ターンの完了後に別セッションのEvaluatorへ判定させ、その結果から
   * 次のターンの指示文を組み立てて送る。**完了判定の所有権はWorkerからEvaluatorへ移る**
   * ため、この設定があるときは`condition`（`<<LOOP_DONE>>`の依頼）を送信文へ添えない。
   */
  goal?: GoalLoopConfig;
}

export type LoopStopReason =
  /** エージェントが終了条件の成立を宣言した */
  | 'done'
  /** 指定回数を送り終えた */
  | 'maxReached'
  /** ターンが失敗した、またはCLIが落ちた */
  | 'failed'
  /** ループ停止ボタン */
  | 'manual'
  /** 手動の発言や中断が割り込んだ */
  | 'interrupted'
  /**
   * 同じ応答が一定回数連続し、進捗の無いまま回っていると判定された（design.md §16.27、
   * Issue #336）。**`failed`とは区別する。** 送信そのものは成功しておりCLIも落ちていない
   * ため、`failed`（ターンの失敗）と同一視すると「壊れた」のか「同じ内容を繰り返して
   * いるだけ」なのかが失われる。`applyLoopStopReason`（`runState.ts`）は`taskStopped`と
   * 同じ扱い（`retries`を消費する自動再試行の経路には乗せない）にしつつ、`failure.kind`は
   * 別の値（`stalled`）にしてViewから区別できるようにする。セッションは`maxReached`と
   * 同じく残す（`runner.ts`の`onTaskFinished`）——停滞はセッションや会話が壊れたわけでは
   * ないため、「続ける」（`continueTask`）で同じ会話のまま続きを試せる余地を残す。
   */
  | 'stalled'
  /**
   * エージェント自身が「自力では解決できない」と宣言した（issue #891）。応答の最終行が
   * `LOOP_ESCALATE_TOKEN`と完全一致したときに成立する（`declaresEscalate`）。
   *
   * `stalled`が「同じ応答の反復」という**機械的な**停滞検知なのに対し、こちらは
   * エージェント自身による**意味的な**行き詰まりの申告である。停止の三層
   * （反復上限・時間上限 / 停滞検知 / 撤退の申告）のうちの1つ。
   *
   * 扱いは`stalled`と同格。`failed`（ターンの失敗・CLIの落ち）とは区別し、`retries`を
   * 消費する自動再試行の経路には乗せず、セッションも残す。原因を変えずに機械的へやり直しても
   * 同じ地点で行き詰まる可能性が高く、人・オーケストレーターの判断を挟む価値があるため。
   */
  | 'escalated'
  /**
   * `LoopPlan.maxDurationMs` の時間上限に達した（issue #891）。
   *
   * 判定は**ターンの完了時**（`observe`）に行う。走行中のターンへ割り込んで止めることは
   * しないため、実際に止まるのは上限を超えた直後のターン境界になる。ターンの途中で
   * 打ち切ると、そこまでの作業が中途半端な状態のまま残るうえ、`interrupt`と区別の付かない
   * 停止理由が増えるため。
   *
   * 扱いは`stalled` / `escalated`と同格（自動再試行に乗せず、セッションは残す）。
   * 時間切れはCLIやセッションが壊れたわけではなく、「続ける」で続きを試す余地がある。
   */
  | 'timedOut'
  /**
   * ワークフローViewの「タスク停止」操作（design.md §16.8）による停止。
   *
   * `manual`（チャット画面自身のループ停止ボタン）と区別する。`manual`/`interrupted` は
   * 「人がそのタスクの画面へ直接介入した」ことを表し、`runState.ts`ではそのタスク自身の
   * 状態を変えず実行全体だけを止める（design.md §16.5）。一方「タスク停止」は
   * オーケストレータ経由でそのタスク**だけ**を`failed`に確定させる別の操作であり、
   * 同じ`manual`を使い回すと両者を`onFinished`側で区別できなくなる。
   */
  | 'taskStopped';

export interface LoopStatus {
  running: boolean;
  /** 送信済みの回数。 */
  iteration: number;
  maxIterations: number;
  condition: string;
  /** 直前に止まった理由。走り出すと消える。 */
  stopReason: LoopStopReason | undefined;
}

export const idleLoopStatus: LoopStatus = {
  running: false,
  iteration: 0,
  maxIterations: 0,
  condition: '',
  stopReason: undefined,
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 時間上限として受け付ける最大の分数（issue #891）。24時間。
 *
 * `LOOP_ITERATION_LIMIT`と同じ役割で、画面から指定できる値をここで頭打ちにする。
 */
export const LOOP_DURATION_LIMIT_MINUTES = 24 * 60;

/**
 * 画面から届いた入力をループの計画に整える。
 * 指示が空、回数が1未満といった走らせようのない指定は受け付けない。
 *
 * 時間上限（`maxDurationMinutes`）は**省略可**で、空・0以下・数値でない値はいずれも
 * 「時間では止めない」として扱う（回数の指定と違い、無指定でも走らせようがあるため
 * `undefined`を返して計画そのものを弾いたりはしない）。
 *
 * `engineering`は画面からの入力ではなく設定（`agent.chat.loopEngineering.*`）由来のため、
 * `raw`からは読まずに引数で受け取る。webviewから届く値を指示文の差し替えに使わせない
 * （webview側の値を信用して送信文を組み立てない）ためでもある。
 */
export function normalizeLoopPlan(
  raw: unknown,
  engineering?: LoopEngineeringConfig,
  goalOptions?: GoalLoopOptions,
): LoopPlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const initialPrompt = str(value['initialPrompt']).trim();
  const continuePrompt = str(value['continuePrompt']).trim();
  const goal = normalizeGoalLoop(value['goal'], goalOptions);
  // ゴール駆動ループでは2回目以降の指示文をEvaluatorの判定から組み立てるため、
  // `continuePrompt`は使わない。従来のループでだけ必須にする
  if (continuePrompt === '' && goal === undefined) {
    return undefined;
  }

  const rawMax = value['maxIterations'];
  const parsed = typeof rawMax === 'number' ? rawMax : Number.parseInt(str(rawMax), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return {
    initialPrompt,
    continuePrompt,
    maxIterations: Math.min(Math.floor(parsed), LOOP_ITERATION_LIMIT),
    // ゴール駆動では終了条件をWorkerへ渡さない（完了判定はEvaluatorが持つ）。
    // 計画の時点で落としておき、「画面に入っているのに効かない値」を残さない
    condition: goal === undefined ? str(value['condition']).trim() : '',
    ...normalizeMaxDuration(value['maxDurationMinutes']),
    ...(engineering === undefined ? {} : { engineering }),
    ...(goal === undefined ? {} : { goal }),
  };
}

/**
 * ゴール駆動ループを組み立てるために、画面の入力とは別に呼び出し側から渡すもの（issue #892）。
 *
 * `evaluate`（Evaluatorの実際の呼び出し）はプロセス起動を伴うため、webviewから届く値では
 * 作れない。`engineering`と同じく、設定に由来する値はwebviewの`raw`から読まない。
 */
export interface GoalLoopOptions {
  evaluate: GoalEvaluator;
  /** `indeterminate`が続くのを許す回数。省略時は`DEFAULT_MAX_INDETERMINATE`。 */
  maxIndeterminate?: number;
}

/**
 * 画面から届いたゴールの入力と、呼び出し側のEvaluatorを合わせて設定にする。
 *
 * 目的と受入基準が揃っていない、またはEvaluatorが渡されていないときは`undefined`
 * （＝従来の繰り返しループとして扱う）。
 */
function normalizeGoalLoop(
  raw: unknown,
  options: GoalLoopOptions | undefined,
): GoalLoopConfig | undefined {
  if (options === undefined) {
    return undefined;
  }
  const definition = normalizeGoalDefinition(raw);
  if (definition === undefined) {
    return undefined;
  }
  return {
    definition,
    evaluate: options.evaluate,
    ...(options.maxIndeterminate === undefined
      ? {}
      : { maxIndeterminate: options.maxIndeterminate }),
  };
}

/**
 * 時間上限の入力（分）をミリ秒へ直す。指定が無い・読めない・0以下なら**キーごと返さない**
 * （`exactOptionalPropertyTypes`の下では、`maxDurationMs: undefined`を書き込むことと
 * キーが無いことは別物のため）。
 */
function normalizeMaxDuration(raw: unknown): { maxDurationMs?: number } {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(str(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {};
  }
  const minutes = Math.min(Math.floor(parsed), LOOP_DURATION_LIMIT_MINUTES);
  return { maxDurationMs: minutes * 60_000 };
}

/**
 * 終了条件を指示へ添える。
 *
 * 回数だけでは測れない条件（「20話まで書き終える」など）を、エージェント自身に
 * 判定させるための頼み。条件が空なら何も足さない。
 */
export function decoratePrompt(prompt: string, condition: string): string {
  if (condition === '') {
    return prompt;
  }
  return `${prompt}\n\n（終了条件「${condition}」を満たしている場合は、作業をせず ${LOOP_DONE_TOKEN} とだけ出力してください）`;
}

/** 直近のエージェント発言が終了を宣言しているか。 */
export function declaresDone(state: ChatState): boolean {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind === 'agentMessage') {
      return item.text.includes(LOOP_DONE_TOKEN);
    }
  }
  return false;
}

/**
 * 同じ指示を条件成立まで送り続ける。
 *
 * ターンの完了は `ChatState.busy` の立ち下がりで見る。CodexとClaude Codeで
 * 状態の形が共通なので、この制御はプロバイダを問わず同じものを使える。
 * 画面ではなく拡張機能側に置くのは、タブの再描画やウィンドウのリロードで
 * 進行中のループが消えないようにするため。
 */
export class LoopController {
  private plan: LoopPlan | undefined;
  private status: LoopStatus = idleLoopStatus;
  /** 送った指示のターンが始まったのを見たか。始まる前の busy=false と区別する。 */
  private sawBusy = false;
  /**
   * `pause()` で一時停止中か（design.md §16.21「waitingReplyへの遷移」）。
   *
   * `true` の間、`observe()` はターンの完了を検知しても `continuePrompt` を送らない
   * （回数上限・終了条件の判定そのものへも進ませない。`resume()` が呼ばれるまで
   * ループは実際に止まったまま待つ。`running` 自体は `true` のまま保つ
   * （`stop()` は呼ばない）。タスクのセッションは生きているため、design.mdの
   * 「waitingReplyも並列の枠を占める」という状態と整合する。
   */
  private paused = false;
  /**
   * 直近ターンの応答テキストの履歴（design.md §16.27、Issue #336）。`stallThreshold`件を
   * 超えた古い分は持たない。`start()`・`stop()`で空に戻す（前のループ実行の履歴を
   * 次の実行へ持ち越さない）。
   */
  private stallHistory: string[] = [];
  /**
   * `start()`を呼んだ時刻（issue #891）。`LoopPlan.maxDurationMs`の判定に使う。
   * 走っていない間は`undefined`。`stop()`で戻す（前の実行の開始時刻を次へ持ち越さない）。
   */
  private startedAt: number | undefined;
  /**
   * ゴール駆動ループの証拠のledger（issue #892）。`start()`・`stop()`で空に戻す。
   * 上限は`MAX_EVIDENCE_ITEMS`で、古いものから落ちる。
   */
  private goalEvidence: GoalEvidence[] = [];
  /** 既に証拠として拾った項目のid。同じコマンド実行を毎ターン積み直さないため。 */
  private seenEvidenceIds = new Set<string>();
  /** `indeterminate`が連続した回数。`achieved`/`continue`/`escalate`で0に戻す。 */
  private indeterminateStreak = 0;
  /**
   * Evaluatorの応答を待っている間か。待っている間に届く`observe()`で二重に評価を
   * 走らせない（評価はターンごとに1回）。
   */
  private evaluating = false;
  /**
   * 一時停止中にターンが完了したため、送らずに保留している次の指示（issue #909）。
   *
   * `resume()`がこれをそのまま送る。`undefined`は「まだ送るべき指示が決まっていない」
   * ——ターンが走行中か、停止判定で止まったか——を表し、この場合`resume()`は何も送らない
   * （走行中のターンの完了時に`observe()`が続きを決める）。`start()`・`stop()`で戻す。
   */
  private pendingPrompt: string | undefined;

  constructor(
    private readonly send: (text: string) => void | Promise<void>,
    private readonly onStatus: (status: LoopStatus) => void = () => undefined,
    /**
     * 停滞と判定するまでに必要な、同一応答の連続回数（design.md §16.27）。
     * `agent.workflows.stallRepeatCount`（`config.ts`）の値を呼び出し側が渡す想定。
     * `LoopController`自身はvscodeに依存させないため、設定の読み出しは呼び出し側の責務。
     */
    private readonly stallThreshold: number = DEFAULT_STALL_REPEAT_COUNT,
    /**
     * 現在時刻の取得（issue #891）。時間上限の判定にだけ使う。
     * テストから任意の時刻を流し込めるよう差し替え可能にしてある（既定は`Date.now`）。
     */
    private readonly now: () => number = () => Date.now(),
  ) {}

  getStatus(): LoopStatus {
    return this.status;
  }

  get running(): boolean {
    return this.status.running;
  }

  /**
   * ループを一時停止する（design.md §16.21「自分のターンを終えたあと、返信が届くまで
   * 次の指示を受け取らない」）。
   *
   * 走っていなければ何もしない。進行中のターンには割り込まない（`interrupt()`とは別物）。
   * そのターンが完了した時点で `observe()` が `continuePrompt` を送らずに止める。
   */
  pause(): void {
    if (!this.status.running) {
      return;
    }
    this.paused = true;
  }

  /**
   * `pause()` で止めたループを再開し、**保留していた指示があればそれを送る**
   * （design.md §16.21「返信が届いたら running へ戻し、返信の本文を添えて次の指示を送る」。
   * 本文を添える処理自体は `TaskSession.setPromptTransform` 側で行う）。
   *
   * 送る指示は`sendNext`が保留したもの（issue #909）。ここで組み立て直さないのは、
   * ゴール駆動で直前の評価の`gaps`・`nextFocus`を失わないため。一時停止中に上限へ達した
   * ・撤退が申告された等で既に止まっている場合は、そもそも保留が無いので何も送らない。
   *
   * 走っていない、または一時停止中でなければ何もしない。
   */
  resume(): void {
    if (!this.status.running || !this.paused || this.plan === undefined) {
      return;
    }
    this.paused = false;
    const pending = this.pendingPrompt;
    if (pending === undefined) {
      // 送るべき指示がまだ決まっていない（issue #909）。ターンが走行中なら、その完了時の
      // `observe()`が停止判定を経て続きを決める。ここで送ると、完了を見ないまま次の指示を
      // 重ねて送ってしまう
      return;
    }
    this.pendingPrompt = undefined;
    this.dispatch(pending, 'continue');
  }

  /**
   * 初回に送る指示（issue #892）。
   *
   * ゴール駆動では`continuePrompt`を使わない（次の指示文はEvaluatorの判定から組み立てる）
   * ため、空文字を送ってしまわないよう元の目的だけを添えた文にする。まだ1度も評価して
   * いないため、`gaps`や`nextFocus`は付けようがない。
   *
   * 再開（`resume`）ではこれを使わない。保留していた指示をそのまま送る（issue #909）。
   */
  private continuationPrompt(plan: LoopPlan): string {
    if (plan.goal === undefined) {
      return plan.continuePrompt;
    }
    return buildNextTurnPrompt(indeterminate(''), plan.goal.definition.purpose);
  }

  /** ループを開始し、1回目の指示を送る。 */
  start(plan: LoopPlan): void {
    this.plan = plan;
    this.stallHistory = [];
    this.startedAt = this.now();
    this.goalEvidence = [];
    this.seenEvidenceIds = new Set();
    this.indeterminateStreak = 0;
    this.evaluating = false;
    this.pendingPrompt = undefined;
    this.status = {
      running: true,
      iteration: 0,
      maxIterations: plan.maxIterations,
      condition: plan.condition,
      stopReason: undefined,
    };
    // 初回指示が空なら継続指示の文面で始めるが、**ループとしては1回目**なので
    // ループエンジニアリングの指示は`initial`（完全な方針文）を連結する
    this.dispatch(
      plan.initialPrompt === '' ? this.continuationPrompt(plan) : plan.initialPrompt,
      'initial',
    );
  }

  /**
   * ループを止める。**実際に走っていたループを止められたかを`boolean`で返す**（issue #514）。
   *
   * 既に止まっている（`!this.status.running`）ループへの呼び出しはno-opで、これまでどおり
   * `false`を返す。呼び出し側（`TaskSession.stopLoop`経由で`WorkflowRunner.stopTask`）は、
   * この戻り値だけを「止める先が実際にあったか」の根拠にする。**セッションや管理用のMapに
   * エントリが残っているかどうか（存在チェック）では判定しない。** 完了済みタスクの
   * エントリは`onTaskFinished`後も`live.tasks`から消えない（design.md参照）ため、存在チェック
   * だけでは「past形として残っているだけの、実際には何も起きなかった呼び出し」を「成功」と
   * 誤判定してしまう。人はViewを見て「止まっていない」に気づけるが、オーケストレーターは
   * 戻り値の`accepted`しか見ないため、一度でも嘘の成功を返すとその経路を二度と再試行しない。
   */
  stop(reason: LoopStopReason): boolean {
    if (!this.status.running) {
      return false;
    }
    this.plan = undefined;
    this.sawBusy = false;
    this.paused = false;
    this.stallHistory = [];
    this.startedAt = undefined;
    this.goalEvidence = [];
    this.seenEvidenceIds = new Set();
    this.indeterminateStreak = 0;
    this.evaluating = false;
    this.pendingPrompt = undefined;
    this.status = { ...this.status, running: false, stopReason: reason };
    this.onStatus(this.status);
    return true;
  }

  /**
   * 手動の発言や中断が入ったとき。ループ中なら割り込みとみなして止める。
   * 利用者の操作とループの指示が交互に飛ぶ状態を作らないため。
   */
  noteUserAction(): void {
    this.stop('interrupted');
  }

  /** 会話の状態が変わるたびに呼ぶ。ターンの完了を見て次の指示を送る。 */
  observe(state: ChatState): void {
    const plan = this.plan;
    if (!this.status.running || plan === undefined) {
      return;
    }
    if (state.busy) {
      this.sawBusy = true;
      return;
    }
    // 承認待ちのまま止まっている間は次を送らない。利用者の判断を待つ
    if (state.approvals.length > 0) {
      return;
    }
    // 手で積まれた指示が先。捌け切るまでループの指示を割り込ませない
    if (state.queued.length > 0) {
      return;
    }
    if (this.evaluating) {
      // Evaluatorの判定を待っている（issue #892）。評価はターンごとに1回だけ行う
      return;
    }
    if (!this.sawBusy) {
      // 送った指示のターンがまだ始まっていない
      return;
    }
    this.sawBusy = false;

    if (state.turnFailed) {
      // 一時停止中でも、ターン自体が失敗していれば止める。「返信待ちのまま実は
      // 失敗していた」を黙って握り潰さない（安全側の判断。最終報告に記載）
      this.stop('failed');
      return;
    }
    // 撤退の申告（issue #891）は終了条件（`condition`）の有無に関わらず見る。
    // 「解決できないので止めてくれ」は条件の成立とは独立した申し出であり、条件を
    // 設定していないループでも効かせる必要がある。完了（`done`）より先に判定するのは、
    // 同じ応答が両方の合図を含んでいた場合に「終わった」と誤って扱わないため
    if (declaresEscalate(state)) {
      this.stop('escalated');
      return;
    }
    // ゴール駆動ループ（issue #892）ではWorkerへ`<<LOOP_DONE>>`を頼まないため、
    // 自己申告による完了は見ない。完了判定はEvaluatorだけが持つ
    if (plan.goal === undefined && plan.condition !== '' && declaresDone(state)) {
      this.stop('done');
      return;
    }
    // 停滞判定（design.md §16.27、Issue #336）に使う履歴を、判定の対象になったターンの
    // 直後に更新する。**履歴の更新はゴール駆動かどうかに関わらずここで行い、判定の位置
    // だけが違う**（ゴール駆動ではEvaluatorの後ろ。issue #909）。判定そのものは`finishTurn`
    this.stallHistory = pushTurnSignature(
      this.stallHistory,
      extractTurnSignature(state),
      this.stallThreshold,
    );
    // ゴール駆動ループ（issue #892）はここから先を非同期で行う。停滞・時間上限・回数切れの
    // 判定を評価より後ろに置くのは、**最終ターンで達成していた場合を取りこぼさない**ため。
    // 先に止めると、達成していたループが`stalled`や`maxReached`（未達扱い）で終わってしまう。
    // 完了判定の所有権をEvaluatorへ渡した以上、終局の判定はEvaluatorに先に見せる（issue #909）
    if (plan.goal !== undefined) {
      this.evaluating = true;
      void this.runGoalTurn(plan, state).finally(() => {
        this.evaluating = false;
      });
      return;
    }
    this.finishTurn(plan, plan.continuePrompt);
  }

  /**
   * ターンの後始末（停滞・時間・回数の判定と、次の指示の送信）。
   *
   * ゴール駆動と従来のループで共通の後段。ゴール駆動ではEvaluatorの終局判定
   * （`achieved` / `escalate`）を先に見たうえでここへ来る（issue #909）。
   */
  private finishTurn(plan: LoopPlan, nextPrompt: string): void {
    // 停滞判定（design.md §16.27、Issue #336）。回数上限・時間上限より先に見る——
    // 停滞は「進んでいない」という原因を名指しできる分だけ理由として具体的で、
    // 時間切れ・回数切れより優先する価値がある
    if (detectStalledLoop(this.stallHistory, this.stallThreshold)) {
      this.stop('stalled');
      return;
    }
    // 時間上限（issue #891）。停滞・回数切れと並ぶ3本目の縛りで、ターン境界で見る
    if (this.hasExceededDuration(plan)) {
      this.stop('timedOut');
      return;
    }
    if (this.status.iteration >= plan.maxIterations) {
      this.stop('maxReached');
      return;
    }
    this.sendNext(nextPrompt);
  }

  /**
   * 次のターンを送る。**一時停止中なら送らず、送るはずだった指示を保留する**（issue #909）。
   *
   * `pause()`が止めるのは次の指示の送信だけであり、ターンの後始末（停止判定）ではない。
   * 保留した指示は`resume()`がそのまま送る。ここで捨てて`resume()`側で組み立て直すと、
   * ゴール駆動では直前の評価の`gaps`・`nextFocus`が失われる。
   */
  private sendNext(prompt: string): void {
    if (this.paused) {
      this.pendingPrompt = prompt;
      return;
    }
    this.dispatch(prompt, 'continue');
  }

  /**
   * ゴール駆動ループの1ターン分の後処理（issue #892）。
   *
   * 証拠を積む → Evaluatorへ判定させる → 判定と上限から継続/停止を決める、の順で進む。
   * **次のターンの指示文はここ（`LoopController`）で組み立てる。** Evaluatorが返した
   * 文字列をそのままユーザープロンプトとして送る経路は作らない。
   */
  private async runGoalTurn(plan: LoopPlan, state: ChatState): Promise<void> {
    const goal = plan.goal;
    if (goal === undefined) {
      return;
    }
    const iteration = this.status.iteration;
    this.ingestEvidence(state, iteration);

    // Evaluatorの実装が例外を投げてもループを壊さない。判定できなかったこと自体を
    // `indeterminate`として扱い、続けるか止めるかは下の共通の分岐へ委ねる
    const evaluation = await goal
      .evaluate({
        goal: goal.definition,
        evidence: this.goalEvidence,
        summary: buildResponseSummary(state),
        recentTurns: collectRecentTurns(state.items),
        iteration,
      })
      .catch(() => indeterminate('Evaluatorの呼び出しが失敗しました'));

    // 評価を待っている間に止められた・別の計画で開始し直された場合は何もしない
    if (!this.status.running || this.plan !== plan) {
      return;
    }
    if (evaluation.verdict === 'achieved') {
      this.stop('done');
      return;
    }
    if (evaluation.verdict === 'escalate') {
      this.stop('escalated');
      return;
    }
    if (evaluation.verdict === 'indeterminate') {
      // 証拠不足は「未達」ではない。黙って回し続けず、続いたら人へ渡す
      this.indeterminateStreak += 1;
      // 0以下を設定されても最初の1回で止めない。少なくとも1回は判定を試みる
      const limit = Math.max(1, goal.maxIndeterminate ?? DEFAULT_MAX_INDETERMINATE);
      if (this.indeterminateStreak >= limit) {
        this.stop('escalated');
        return;
      }
    } else {
      this.indeterminateStreak = 0;
    }
    // ここへ来るのは終局でない判定のときだけ——`continue`か、連続上限に達していない
    // `indeterminate`（上限に達した分は上で`escalated`として返している）。Evaluatorの
    // 終局判定を停滞より先に見るのが issue #909 の順序
    this.finishTurn(plan, buildNextTurnPrompt(evaluation, goal.definition.purpose));
  }

  /** このターンで新しく得た証拠をledgerへ積む。 */
  private ingestEvidence(state: ChatState, iteration: number): void {
    const added = collectCommandEvidence(state.items, this.seenEvidenceIds, iteration);
    for (const item of state.items) {
      // **終了コードが読める項目だけを「拾った」ものとして記録する（issue #909）。**
      // 実行中の項目まで記録すると、終了コードが出た次のターンで`collectCommandEvidence`が
      // `seen`に弾かれ、そのコマンドは二度と証拠にならない。「実行中のものは次のターンで
      // 拾う」という`collectCommandEvidence`の前提を壊さないため、判定を揃える
      if (isSettledCommandItem(item)) {
        this.seenEvidenceIds.add(item.id);
      }
    }
    const report = buildWorkerReportEvidence(state, iteration);
    this.goalEvidence = appendEvidence(this.goalEvidence, [
      ...added,
      ...(report === undefined ? [] : [report]),
    ]);
  }

  /** 時間上限に達したか。上限の指定が無い場合と、開始時刻が分からない場合は達していない扱い。 */
  private hasExceededDuration(plan: LoopPlan): boolean {
    const limit = plan.maxDurationMs;
    if (limit === undefined || this.startedAt === undefined) {
      return false;
    }
    return this.now() - this.startedAt >= limit;
  }

  private dispatch(prompt: string, phase: LoopEngineeringPhase): void {
    const plan = this.plan;
    if (plan === undefined) {
      return;
    }
    this.sawBusy = false;
    this.status = { ...this.status, iteration: this.status.iteration + 1 };
    this.onStatus(this.status);

    try {
      // 方針（ループエンジニアリング）を先に、終了条件を後ろに置く。終了条件は
      // 「満たしていれば作業せず合図だけ返せ」という最後の指示のため、末尾に来る方が読み違えにくい
      const withPolicy = appendLoopEngineeringInstruction(prompt, plan.engineering, phase);
      // ゴール駆動ループ（issue #892）では終了条件をWorkerへ渡さない。完了判定は
      // Evaluatorが持つため、Workerに`<<LOOP_DONE>>`を出させると判定の所有権が二重になる
      const result = this.send(
        plan.goal === undefined ? decoratePrompt(withPolicy, plan.condition) : withPolicy,
      );
      if (result instanceof Promise) {
        result.catch(() => this.stop('failed'));
      }
    } catch {
      this.stop('failed');
    }
  }
}
