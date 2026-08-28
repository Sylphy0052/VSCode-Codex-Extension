import type { ChatItem, ChatState } from '../appserver/chatState';
import {
  detectStalledLoop,
  extractTurnSignature,
  pushTurnSignature,
  DEFAULT_STALL_REPEAT_COUNT,
} from './stallDetector';
import {
  agentMessageFinalLine,
  appendLoopEngineeringInstruction,
  declaresEscalate,
  lastAgentMessage,
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
 * 会話に紛れない綴りにしてある。判定は`declaresDone`が行い、**エージェントの発言の最後の
 * 非空行がこの綴りと完全に一致する場合だけ**条件成立とみなす（issue #914）。本文の途中に
 * 現れただけでは成立しない。
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
  return `${prompt}\n\n（終了条件「${condition}」を満たしている場合は、作業をせず、応答の最後の非空行に ${LOOP_DONE_TOKEN} だけを出力し、それ以降は何も出力しないでください）`;
}

/**
 * **渡された発言が**終了を宣言しているか。
 *
 * **発言の最終行が`LOOP_DONE_TOKEN`と完全に一致する場合だけ**成立とする（issue #914）。
 * 以前は`includes`で本文中に現れれば成立としていたが、この合図を教えるのは
 * `decoratePrompt`が終了条件へ添える文そのものであり、その綴りが会話に残る。そのため
 * 「まだ <<LOOP_DONE>> は出しません」といった説明文だけでループが終了していた。
 * `declaresEscalate`（issue #891）が同じ理由で最終行の完全一致にしてあり、判定方式を
 * 揃えた（共通の取り出しは`agentMessageFinalLine`）。
 *
 * **これは挙動の変更である。** 合図を文中へ埋めて返していたエージェントでは、これまで
 * 終了していたループが終了しなくなる。`decoratePrompt`の依頼文も、合図だけを最後の行へ
 * 出すよう明示する文面へ合わせて直してある。
 *
 * **その発言が現在のターンのものかは、この関数では判断しない**（issue #937）。会話全体
 * から直近の`agentMessage`を探す形にしていた頃は、ツール実行だけで本文を返さなかった
 * ターンで過去の発言を拾い、ループを始める前に残っていた合図で停止しえた。どの発言を
 * 渡すかは`observe()`が`lastMessageBoundary`と比べて決める。
 */
export function declaresDone(item: ChatItem): boolean {
  return agentMessageFinalLine(item) === LOOP_DONE_TOKEN;
}

/** ターン境界で覚えておく目印を作る。発言が無ければ`undefined`。 */
function toMessageBoundary(item: ChatItem | undefined): AgentMessageBoundary | undefined {
  return item === undefined ? undefined : { id: item.id, finalLine: agentMessageFinalLine(item) };
}

/**
 * 2つの境界が同じ発言を指しているか。
 *
 * `id`と最終行の**両方**が一致したときだけ同じと見る。`id`だけを比べると、Claude側で
 * `message.id`が取れず`assistant:text:0`が毎ターン同じ値になる場面（`streamJson.ts`の
 * `blockId` / `partialId`）で、新しい発言を前と同じものと取り違える。最終行だけを比べると、
 * 別の発言がたまたま同じ行で終わったときに取り違える。
 *
 * 残る取りこぼしは「同じ`id`で最終行も同じ発言が2ターン続く」場合だけで、その最終行が
 * 合図なら1ターン目で既に止まっているため、合図の判定としては到達しない。
 */
function isSameBoundary(
  a: AgentMessageBoundary | undefined,
  b: AgentMessageBoundary | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.id === b.id && a.finalLine === b.finalLine;
}

/**
 * ターン境界で覚えておく、最後の`agentMessage`の目印（issue #937）。
 *
 * `id`と最終行の**両方**が前の境界と一致していれば、そのターンは新しい発言を出して
 * いないと見る。片方だけでは足りない理由は`LoopController.lastMessageBoundary`のJSDoc。
 */
interface AgentMessageBoundary {
  id: string;
  finalLine: string | undefined;
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
   * **`true` の間も停止条件の判定は行い、止めるのは次の指示の送信だけ**（issue #909）。
   * 撤退の申告・終了条件・停滞・時間上限・回数上限はターンの完了時にそのまま評価し、
   * 送るはずだった指示を`sendNext()`が`pendingPrompt`へ保留して`resume()`が送る。
   * `running` 自体は `true` のまま保つ（`stop()` は呼ばない）。タスクのセッションは
   * 生きているため、design.mdの「waitingReplyも並列の枠を占める」という状態と整合する。
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
  /**
   * ループ実行の世代（issue #933）。`start()`と`stop()`で1つ進める。
   *
   * **非同期の処理が、自分を始めた実行がもう終わっていることに気づくための印。**
   * Evaluatorの応答待ちや送信の`Promise`は、ループを止めた後・別の計画で始め直した後に
   * 解決することがある。開始時点の世代を捕まえておき、解決した時点で
   * `this.runGeneration`と違っていれば何もしない。`this.plan !== plan`の参照比較では
   * `.finally()`や`Promise.catch()`のように計画を持たない経路を守れず、同じ計画の
   * オブジェクトを使い回されると誤って一致してしまう。
   */
  private runGeneration = 0;
  /**
   * 前のターン境界で見えていた、最後の`agentMessage`の目印（issue #937）。
   *
   * 完了・撤退の合図は**そのターンで新しく出た発言にだけ**効かせる。会話全体から直近の
   * `agentMessage`を探すと、ツール実行だけで本文を返さなかったターンで過去のターンの
   * 発言が判定に掛かり、ループを始める前に残っていた`<<LOOP_DONE>>`で即座に停止しうる。
   *
   * ターンの絞り込みに`ChatItem.turnId`も`ChatState.turnResultText`も使えない。
   * `appendDelta`（`chatState.ts`）が作る項目は`turnId`が`undefined`のままになることが
   * あり、`summarizeTurn`がそれを落とすため`turnResultText`が空になる（`planner.ts`が
   * この取りこぼしにフォールバックを入れている）。合図を`turnResultText`だけで見ると、
   * その場合に**正しく合図を返しているのに止まらない**。停止できない側へ倒れる誤りは
   * 避ける。
   *
   * `id`だけでなく最終行も持つのは、`id`がターンを跨いで再利用されうるため。Claude側の
   * `blockId` / `partialId`（`claude/streamJson.ts`）は`message.id`が取れないとき
   * `assistant`へフォールバックし、`assistant:text:0`が毎ターン同じ値になる。`id`だけを
   * 比べると、この状況で新しい発言を「前と同じ」と見て合図を取りこぼす。
   */
  private lastMessageBoundary: AgentMessageBoundary | undefined;

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
     * 経過時間の計測（issue #891）。時間上限の判定にだけ使う。
     *
     * 既定は`performance.now`（issue #914）。使うのは`start()`時点との差だけなので
     * 基準時刻に意味は無く、NTP同期や手動の時刻変更で飛ばないことの方が重要である
     * （`Date.now` は経過時間の計測には向かない）。テストから任意の値を流し込めるよう
     * 差し替え可能にしてある。
     *
     * **OS・実行環境のサスペンド中の時間は数えない**（Linuxでの基準は`CLOCK_MONOTONIC`
     * 相当で、サスペンドを含める`CLOCK_BOOTTIME`とは違う）。この値は進行中のターンへ
     * 割り込まないsoft deadlineであり、実時間に対する厳密な期限管理ではない。
     */
    private readonly now: () => number = () => performance.now(),
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
    // 保留してから再開までの待ち時間で時間上限を跨いでいないかを、送る直前にもう一度見る
    // （issue #914）。ターンが完了した時点では超えていなくても、返信を待っている間に
    // 上限へ達することがある——人が2時間後に答えることもある。回数上限を見直さないのは、
    // 待っている間に`iteration`が進むことはなく、保留を作った時点の判定で足りるため
    if (this.hasExceededDuration(this.plan)) {
      this.stop('timedOut');
      return;
    }
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

  /**
   * ループを開始し、1回目の指示を送る。
   *
   * `existingItems`には**開始時点の会話の項目**を渡す（issue #933）。ここで既に終了コードの
   * 出ているコマンド実行を「拾い済み」として記録しておかないと、ゴール駆動ループの最初の
   * 評価で、ループを始める前に実行されたコマンドまで`iteration=1`の証拠として積まれる
   * （`ChatState.items`は会話全体を持ち続けるため）。「開始前に`npm test`が通っていた」
   * だけで受入基準を満たしたと判定され、現在のコードを一度も検証しないまま止まりうる。
   * 省略時は空として扱う（従来ループでは証拠を使わないため影響しない）。
   *
   * 同じ`existingItems`から、完了・撤退の合図の境界（`lastMessageBoundary`）も作る
   * （issue #937）。開始前に残っていた`<<LOOP_DONE>>`で1ターン目に止まらないようにする。
   */
  start(plan: LoopPlan, existingItems: readonly ChatItem[] = []): void {
    this.plan = plan;
    this.runGeneration += 1;
    this.stallHistory = [];
    this.startedAt = this.now();
    this.goalEvidence = [];
    this.seenEvidenceIds = new Set(
      existingItems.filter(isSettledCommandItem).map((item) => item.id),
    );
    this.lastMessageBoundary = toMessageBoundary(lastAgentMessage(existingItems));
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
    // 走っていた実行の世代を閉じる（issue #933）。停止後に解決する非同期の処理は、
    // 自分の世代と食い違うことで「もう自分の実行ではない」と気づける
    this.runGeneration += 1;
    this.sawBusy = false;
    this.paused = false;
    this.stallHistory = [];
    this.startedAt = undefined;
    this.goalEvidence = [];
    this.seenEvidenceIds = new Set();
    this.indeterminateStreak = 0;
    this.evaluating = false;
    this.pendingPrompt = undefined;
    this.lastMessageBoundary = undefined;
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

    // このターンで新しい発言が出たかを、合図の判定より前に確定させる（issue #937）。
    // 更新を分岐の後ろに置くと、どこかの`return`で更新を忘れて次のターンの判定が
    // 狂う。境界の更新と「新しいか」の記録をここで済ませ、以降は`hasNewMessage`だけを見る
    const lastMessage = lastAgentMessage(state.items);
    const previousBoundary = this.lastMessageBoundary;
    this.lastMessageBoundary = toMessageBoundary(lastMessage);
    const newMessage =
      lastMessage !== undefined && !isSameBoundary(previousBoundary, this.lastMessageBoundary)
        ? lastMessage
        : undefined;

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
    if (newMessage !== undefined && declaresEscalate(newMessage)) {
      this.stop('escalated');
      return;
    }
    // ゴール駆動ループ（issue #892）ではWorkerへ`<<LOOP_DONE>>`を頼まないため、
    // 自己申告による完了は見ない。完了判定はEvaluatorだけが持つ
    if (
      newMessage !== undefined &&
      plan.goal === undefined &&
      plan.condition !== '' &&
      declaresDone(newMessage)
    ) {
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
      // 世代を捕まえてから始める（issue #933）。この評価が終わる前にループが止まり、
      // 別の実行が始まっていた場合、その実行の`evaluating`を折らないため
      const generation = this.runGeneration;
      void this.runGoalTurn(plan, state, generation).finally(() => {
        if (generation === this.runGeneration) {
          this.evaluating = false;
        }
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
  private async runGoalTurn(plan: LoopPlan, state: ChatState, generation: number): Promise<void> {
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

    // 評価を待っている間に止められた・別の実行が始まっていた場合は何もしない
    // （issue #933。`this.plan !== plan`だけでは、同じ計画のオブジェクトを使い回されると
    // 別の実行を自分の実行と取り違える）
    if (!this.status.running || this.plan !== plan || generation !== this.runGeneration) {
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
        // 送信が失敗しても、その頃には別の実行が始まっていることがある（issue #933）。
        // 古い送信のrejectで今のループを止めない
        const generation = this.runGeneration;
        result.catch(() => {
          if (generation === this.runGeneration) {
            this.stop('failed');
          }
        });
      }
    } catch {
      this.stop('failed');
    }
  }
}
