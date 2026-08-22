import type { ChatState } from '../appserver/chatState';
import {
  detectStalledLoop,
  extractTurnSignature,
  pushTurnSignature,
  DEFAULT_STALL_REPEAT_COUNT,
} from './stallDetector';

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
 * 画面から届いた入力をループの計画に整える。
 * 指示が空、回数が1未満といった走らせようのない指定は受け付けない。
 */
export function normalizeLoopPlan(raw: unknown): LoopPlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const initialPrompt = str(value['initialPrompt']).trim();
  const continuePrompt = str(value['continuePrompt']).trim();
  if (continuePrompt === '') {
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
    condition: str(value['condition']).trim(),
  };
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

  constructor(
    private readonly send: (text: string) => void | Promise<void>,
    private readonly onStatus: (status: LoopStatus) => void = () => undefined,
    /**
     * 停滞と判定するまでに必要な、同一応答の連続回数（design.md §16.27）。
     * `agent.workflows.stallRepeatCount`（`config.ts`）の値を呼び出し側が渡す想定。
     * `LoopController`自身はvscodeに依存させないため、設定の読み出しは呼び出し側の責務。
     */
    private readonly stallThreshold: number = DEFAULT_STALL_REPEAT_COUNT,
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
   * `pause()` で止めたループを再開し、直ちに次の `continuePrompt` を送る
   * （design.md §16.21「返信が届いたら running へ戻し、返信の本文を添えて次の指示を送る」。
   * 本文を添える処理自体は `TaskSession.setPromptTransform` 側で行う）。
   *
   * 走っていない、または一時停止中でなければ何もしない。
   */
  resume(): void {
    if (!this.status.running || !this.paused || this.plan === undefined) {
      return;
    }
    this.paused = false;
    this.dispatch(this.plan.continuePrompt);
  }

  /** ループを開始し、1回目の指示を送る。 */
  start(plan: LoopPlan): void {
    this.plan = plan;
    this.stallHistory = [];
    this.status = {
      running: true,
      iteration: 0,
      maxIterations: plan.maxIterations,
      condition: plan.condition,
      stopReason: undefined,
    };
    this.dispatch(plan.initialPrompt === '' ? plan.continuePrompt : plan.initialPrompt);
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
    if (this.paused) {
      // waitingReply（design.md §16.21）。resume()が呼ばれるまでここで待つ。
      // 回数上限・終了条件の判定はresume後の次回observe()で改めて行う
      return;
    }
    if (plan.condition !== '' && declaresDone(state)) {
      this.stop('done');
      return;
    }
    // 停滞判定（design.md §16.27、Issue #336）。回数上限に達する前に、同じ応答が
    // `stallThreshold`回連続していないかを見る。履歴の更新は判定の対象になった
    // ターンの直後、maxReachedの判定より先に行う——停滞と回数切れが同時に成立しうる
    // 最終ターンでは、進捗の無さそのものを理由にできる停滞判定を優先する
    this.stallHistory = pushTurnSignature(
      this.stallHistory,
      extractTurnSignature(state),
      this.stallThreshold,
    );
    if (detectStalledLoop(this.stallHistory, this.stallThreshold)) {
      this.stop('stalled');
      return;
    }
    if (this.status.iteration >= plan.maxIterations) {
      this.stop('maxReached');
      return;
    }
    this.dispatch(plan.continuePrompt);
  }

  private dispatch(prompt: string): void {
    const plan = this.plan;
    if (plan === undefined) {
      return;
    }
    this.sawBusy = false;
    this.status = { ...this.status, iteration: this.status.iteration + 1 };
    this.onStatus(this.status);

    try {
      const result = this.send(decoratePrompt(prompt, plan.condition));
      if (result instanceof Promise) {
        result.catch(() => this.stop('failed'));
      }
    } catch {
      this.stop('failed');
    }
  }
}
