import type { ChatState } from '../appserver/chatState';

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
  | 'interrupted';

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

  constructor(
    private readonly send: (text: string) => void | Promise<void>,
    private readonly onStatus: (status: LoopStatus) => void = () => undefined,
  ) {}

  getStatus(): LoopStatus {
    return this.status;
  }

  get running(): boolean {
    return this.status.running;
  }

  /** ループを開始し、1回目の指示を送る。 */
  start(plan: LoopPlan): void {
    this.plan = plan;
    this.status = {
      running: true,
      iteration: 0,
      maxIterations: plan.maxIterations,
      condition: plan.condition,
      stopReason: undefined,
    };
    this.dispatch(plan.initialPrompt === '' ? plan.continuePrompt : plan.initialPrompt);
  }

  stop(reason: LoopStopReason): void {
    if (!this.status.running) {
      return;
    }
    this.plan = undefined;
    this.sawBusy = false;
    this.status = { ...this.status, running: false, stopReason: reason };
    this.onStatus(this.status);
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
    if (!this.sawBusy) {
      // 送った指示のターンがまだ始まっていない
      return;
    }
    this.sawBusy = false;

    if (state.turnFailed) {
      this.stop('failed');
      return;
    }
    if (plan.condition !== '' && declaresDone(state)) {
      this.stop('done');
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
