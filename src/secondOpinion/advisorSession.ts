/**
 * 相談を続けられるAdvisorセッション（Issue #929）。
 *
 * これまでのセカンドオピニオン（Issue #894）は、1ターン送って回答を受け取り、その場で
 * セッションを閉じていた。もう一度聞きたければ最初から起動し直すことになり、前回の回答は
 * 引き継がれない。ここは**回答が返った後もセッションを保持し、同じAdvisorへ追加の質問を
 * 送れる**ようにするための層である。
 *
 * 独立性の定義は変わらない（design.md §14.80）。Advisorは作業担当AIのセッション状態を
 * 継承せず、材料は起動時に渡したものと、その後に**利用者自身**が足したものだけである。
 * 利用者からの追加入力は作業担当AIからの影響ではなく、意思決定者からの入力なので、
 * 独立性を損なわない。
 *
 * `vscode` には依存しない。UI（追加質問の入力・結果の差し込み）は view 層の責務。
 */

import type { Logger } from '../log';
import {
  awaitSingleTurn,
  SingleTurnCancelledError,
  SingleTurnTimeoutError,
} from '../orchestrator/planner';
import type { TaskSession } from '../orchestrator/taskSession';
import type { SecondOpinionCandidate } from './candidates';

/**
 * Advisorセッションの状態（Issue #929 受入基準）。
 *
 * - `consulting`: 相談中。追加の質問を送れる
 * - `handoffDrafted`: メインAIへの指示の下書きができている。編集・再生成・承認ができる
 * - `approved`: 利用者が承認した。送信はこの後にExtensionが行う
 * - `closed`: 閉じた。以後どの操作も受け付けない
 *
 * `handoffDrafted` で追加の相談をしたら `consulting` へ戻す。相談を続けた後の下書きは、
 * その相談を踏まえていない古い内容だからである。古い下書きを承認できる状態のまま
 * 残すと、利用者は「いま合意した方針」だと思って送ってしまう。
 */
export type AdvisorSessionState = 'consulting' | 'handoffDrafted' | 'approved' | 'closed';

/** 1ターンの結果。 */
export type AdvisorTurnResult =
  | {
      ok: true;
      response: string;
      /** 打ち切られ、そこまでに出ていた分だけを返した場合の理由（Issue #907 と同じ扱い）。 */
      partialReason?: string | undefined;
    }
  | {
      ok: false;
      /**
       * 失敗の種類。
       *
       * - `closed`: 既に閉じている（no-opで黙らない。黙るとUIが応答を待ち続ける）
       * - `busy`: このセッションで別のターンが走っている
       * - `cancelled`: 利用者が止めた、または閉じられた
       * - `failed`: それ以外（タイムアウト・プロバイダ側の失敗）
       */
      kind: 'closed' | 'busy' | 'cancelled' | 'failed';
      reason: string;
    };

/** 閉じた理由。ログと会話へ残す文言に使う。 */
export type AdvisorCloseReason =
  | 'userEnded'
  | 'idleTimeout'
  | 'instructionSent'
  | 'parentDisposed'
  | 'replaced'
  | 'shutdown'
  | 'failed';

const CLOSE_REASON_LABELS: Record<AdvisorCloseReason, string> = {
  userEnded: '利用者が相談を終了しました',
  idleTimeout: '一定時間操作がなかったため閉じました',
  instructionSent: 'メインAIへ指示を送ったため閉じました',
  parentDisposed: '元の会話が閉じられたため閉じました',
  replaced: '新しいセカンドオピニオンを開始したため閉じました',
  shutdown: '拡張機能の終了により閉じました',
  failed: '実行に失敗したため閉じました',
};

/**
 * 無操作でセッションを閉じるまでの既定時間（30分）。
 *
 * Advisorセッションは常駐app-serverのスレッドとして生きており、タブを開かない設定
 * （`agent.secondOpinion.headless`、既定`true`）では画面に何も出ない。利用者が相談を
 * 終える操作を忘れると、閉じる契機が無いまま残る。
 */
export const DEFAULT_ADVISOR_IDLE_TIMEOUT_MS = 30 * 60_000;

const ADVISOR_LOG_PREFIX = '[secondOpinion]';

const ADVISOR_LABEL = 'セカンドオピニオン';

export interface AdvisorSessionOptions {
  /** 保持する `TaskSession`。閉じる責任はこのクラスが持つ。 */
  session: TaskSession;
  /** 重複起動の判定に使う親セッションのid。 */
  parentSessionId: string;
  candidate: SecondOpinionCandidate;
  /** 追加ターン1回あたりの上限。既定は呼び出し側の設定値をそのまま渡す。 */
  timeoutMs: number;
  /** 無操作で閉じるまでの時間。既定は {@link DEFAULT_ADVISOR_IDLE_TIMEOUT_MS}。 */
  idleTimeoutMs?: number | undefined;
  log?: Logger | undefined;
  /**
   * 閉じたときに呼ばれる。`AdvisorSessionStore` が自分の持ち物から外すために使う。
   *
   * `close()` の中から同期で呼ぶ。ここで投げても `dispose()` は済ませてある。
   */
  onClosed?: ((session: AdvisorSession, reason: AdvisorCloseReason) => void) | undefined;
}

/**
 * 保持した1本のAdvisorセッション。
 *
 * 閉じ忘れると常駐app-server側のスレッドが残るため、閉じる経路をこのクラスへ集約する。
 * {@link close} は冪等で、何度呼んでも `dispose()` は1回しか走らない。
 */
export class AdvisorSession {
  private state: AdvisorSessionState = 'consulting';
  private readonly session: TaskSession;
  private readonly options: AdvisorSessionOptions;
  private readonly idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** 実行中のターンを止めるためのハンドル。走っていなければ `undefined`。 */
  private turn: AbortController | undefined;
  private closeReason: AdvisorCloseReason | undefined;

  constructor(options: AdvisorSessionOptions) {
    this.options = options;
    this.session = options.session;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ADVISOR_IDLE_TIMEOUT_MS;
    this.armIdleTimer();
  }

  get parentSessionId(): string {
    return this.options.parentSessionId;
  }

  get candidate(): SecondOpinionCandidate {
    return this.options.candidate;
  }

  currentState(): AdvisorSessionState {
    return this.state;
  }

  /** 走っているターンがあるか。UIの押下可否の判定に使う。 */
  isBusy(): boolean {
    return this.turn !== undefined;
  }

  /**
   * 追加の質問を送る（Issue #929 Consult）。
   *
   * メインセッションへは何も送らない。送るのはこのAdvisorセッションだけである。
   *
   * `handoffDrafted` からこれを呼ぶと `consulting` へ戻る。相談を続けた以上、前の
   * 下書きは古いものになるため、承認できる状態のまま残さない。
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<AdvisorTurnResult> {
    return this.runTurn(prompt, signal, () => {
      // 追加の相談は下書きを無効化する。承認済みの状態からも相談へ戻す（送信前なら
      // 考え直せるべきで、承認を取り消す専用の操作を別に置く理由が無い）
      this.state = 'consulting';
    });
  }

  /**
   * メインAIへの指示の下書きを作らせる（Issue #929 Handoff）。
   *
   * 返すのは生の応答本文だけで、その解釈（`userSummary` / `mainInstruction` への分解）は
   * 呼び出し側の責務とする。ここで解釈まで抱えると、パースの失敗と、ターンの失敗が
   * 同じ型の中で混ざる。
   *
   * 状態は呼び出し側が {@link markHandoffDrafted} で進める。パースに成功したときだけ
   * `handoffDrafted` にしたいためである（形式が読めない応答は下書きとして扱わない）。
   */
  async draftHandoff(prompt: string, signal?: AbortSignal): Promise<AdvisorTurnResult> {
    return this.runTurn(prompt, signal);
  }

  /** 下書きが読めたことを記録する。`closed` では何もしない。 */
  markHandoffDrafted(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'handoffDrafted';
    this.armIdleTimer();
  }

  /**
   * 利用者が下書きを承認したことを記録する。
   *
   * 承認できるのは `handoffDrafted` からだけである。相談中や閉じた後から承認へ飛べると、
   * 「何を承認したのか」が定まらない。
   */
  markApproved(): boolean {
    if (this.state !== 'handoffDrafted') {
      return false;
    }
    this.state = 'approved';
    this.armIdleTimer();
    return true;
  }

  /**
   * 閉じる。冪等。
   *
   * 順は「タイマー解除 → 走っているターンを止める → `dispose()`」。`dispose()` は
   * 進行中のターンを止めない（`ChatSession.dispose()` は保留中の承認を解放するだけで、
   * app-server側のターンには触れない。Issue #926 D）ため、先に打ち切りを要求する。
   *
   * `dispose()` は `finally` で呼ぶ。打ち切りの要求が投げても、セッションは必ず閉じる。
   */
  close(reason: AdvisorCloseReason): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.closeReason = reason;
    this.clearIdleTimer();
    try {
      // 走っているターンがあれば止める。`awaitSingleTurn` は `SingleTurnCancelledError`
      // で決着し、待っている `runTurn` は `cancelled` を返す
      this.turn?.abort();
    } finally {
      try {
        this.session.dispose();
      } catch (e) {
        this.options.log?.warn(
          `${ADVISOR_LOG_PREFIX} Advisorセッションを閉じられませんでした: ${errorMessage(e)}`,
        );
      }
      this.options.log?.info(
        `${ADVISOR_LOG_PREFIX} Advisorセッションを閉じました（${CLOSE_REASON_LABELS[reason]}）`,
      );
      this.options.onClosed?.(this, reason);
    }
  }

  /** 閉じた理由。閉じていなければ `undefined`。 */
  closedReason(): AdvisorCloseReason | undefined {
    return this.closeReason;
  }

  /**
   * 1ターン分の共通処理。
   *
   * このクラス自身で直列化する。コマンド層の `SecondOpinionRegistry` だけに任せると、
   * 別の呼び出し経路（追加質問と下書き生成）が同時に走る余地が残る。同じスレッドへ2本の
   * ターンを送ると、どちらの回答がどちらの問いに対するものか分からなくなる。
   */
  private async runTurn(
    prompt: string,
    signal: AbortSignal | undefined,
    onStart?: () => void,
  ): Promise<AdvisorTurnResult> {
    if (this.isClosed()) {
      return { ok: false, kind: 'closed', reason: 'この相談は既に終了しています' };
    }
    if (this.turn !== undefined) {
      return { ok: false, kind: 'busy', reason: 'この相談では別の問い合わせが実行中です' };
    }
    onStart?.();
    this.clearIdleTimer();
    const controller = new AbortController();
    this.turn = controller;
    // 呼び出し側の停止（会話の項目の「停止」ボタン）と、`close()` からの打ち切りの
    // どちらでも止まるようにする
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward);
    if (signal?.aborted === true) {
      controller.abort();
    }
    try {
      const response = await awaitSingleTurn(this.session, prompt, {
        timeoutMs: this.options.timeoutMs,
        log: this.options.log,
        label: ADVISOR_LABEL,
        logPrefix: ADVISOR_LOG_PREFIX,
        partialOnTimeout: true,
        signal: controller.signal,
      });
      if (response.trim() === '') {
        return { ok: false, kind: 'failed', reason: 'セカンドオピニオンの応答が空でした' };
      }
      return { ok: true, response };
    } catch (e) {
      if (e instanceof SingleTurnTimeoutError && e.partialText !== undefined) {
        return { ok: true, response: e.partialText, partialReason: e.message };
      }
      if (e instanceof SingleTurnCancelledError) {
        if (e.partialText !== undefined) {
          return { ok: true, response: e.partialText, partialReason: e.message };
        }
        return { ok: false, kind: 'cancelled', reason: e.message };
      }
      return { ok: false, kind: 'failed', reason: errorMessage(e) };
    } finally {
      signal?.removeEventListener('abort', forward);
      this.turn = undefined;
      // 閉じた後にタイマーを張り直さない（閉じたセッションを生かし続けることになる）
      if (!this.isClosed()) {
        this.armIdleTimer();
      }
    }
  }

  /**
   * 閉じているか。
   *
   * `this.state` を直に比べる形にすると、`await` を挟んだ後も型の絞り込みが残り、
   * 「閉じられているかもしれない」再確認が不要と判定されてしまう（実際には待っている
   * 間に `close()` が走りうる）。メソッド越しに読むことで毎回評価させる。
   */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.close('idleTimeout');
    }, this.idleTimeoutMs);
    // タイマーだけがイベントループを生かし続けないようにする（テストのプロセスが
    // 終わらなくなる。`unref` を持たない実行環境では何もしない）
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 親セッションごとに保持しているAdvisorセッションの置き場（Issue #929）。
 *
 * 1つの親につき1本だけ持つ。並行して2本の相談を持てるようにすると、会話の項目から
 * 「どちらへの追加質問か」を選ばせる導線が要るうえ、`SecondOpinionRegistry` が
 * 親ごとに1本しか実行を許さないことと噛み合わない。
 */
export class AdvisorSessionStore {
  private readonly sessions = new Map<string, AdvisorSession>();

  get(parentSessionId: string): AdvisorSession | undefined {
    return this.sessions.get(parentSessionId);
  }

  /**
   * 保持する。同じ親の古いセッションは閉じる。
   *
   * 閉じてから登録する。逆にすると、古いセッションの `close()` から届く
   * {@link remove} が、いま登録したばかりの新しいセッションを消す。
   */
  set(session: AdvisorSession): void {
    this.sessions.get(session.parentSessionId)?.close('replaced');
    this.sessions.set(session.parentSessionId, session);
  }

  /**
   * 登録から外す。**同じインスタンスのときだけ**消す。
   *
   * 古いセッションの後始末が、後から登録された別のセッションを消してしまうのを防ぐ
   * （`SecondOpinionRegistry.end()` が `runId` で守っているのと同じ形の穴）。
   */
  remove(session: AdvisorSession): void {
    if (this.sessions.get(session.parentSessionId) === session) {
      this.sessions.delete(session.parentSessionId);
    }
  }

  /** 親の会話が閉じたときに呼ぶ。 */
  closeFor(parentSessionId: string, reason: AdvisorCloseReason): void {
    this.sessions.get(parentSessionId)?.close(reason);
  }

  /** 拡張機能の終了時に呼ぶ。保持しているセッションを全部閉じる。 */
  closeAll(reason: AdvisorCloseReason): void {
    for (const session of [...this.sessions.values()]) {
      session.close(reason);
    }
    this.sessions.clear();
  }
}
