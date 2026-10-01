import { SANDBOX_MODES } from '../codex/types';
import type { Logger } from '../log';
import { DEFAULT_ADVISOR_CODEX_MODEL } from '../loop/loopAdvisor';
import {
  awaitSingleTurn,
  plannerApprovalModeFor,
  runSingleTurnTask,
  SingleTurnCancelledError,
  SingleTurnTimeoutError,
} from '../orchestrator/planner';
import type { TaskSession, TaskSessionHost, TaskSessionInput } from '../orchestrator/taskSession';
import type { Provider } from '../orchestrator/workflow';
import { describeRedaction, redactCredentials } from '../secondOpinion/redact';
import type { AutoReplyStopReason } from './autoReply';
import { buildAutoReplyRolePrompt, buildAutoReplyTurnPrompt } from './autoReply';

/**
 * 自動返信モード（Issue #1353）の「返信役」セッション管理。
 *
 * `vscode` には依存しない。`runSingleTurnTask` / `awaitSingleTurn`（`planner.ts`）・
 * `redactCredentials`（`secondOpinion/redact.ts`）という、`AdvisorSession`（`secondOpinion/advisorSession.ts`）と
 * 同じ基盤プリミティブを使う。`AdvisorSession`自体を直接使わないのは、あちらが
 * セカンドオピニオン固有の概念（候補・下書き・材料の世代管理・bundle）を多く抱えており、
 * 自動返信には要らないため。同じ基盤の上に、必要な分だけの薄いラッパーを別に持つ。
 *
 * 返信役は会話中のCLIと同じプロバイダで開く（Issue #1602）。当初は常にCodexで開いていたが、
 * ホストにはClaude Code画面自身を渡していたため、Claudeのセッションへ Codex向けの入力
 * （`approvalMode: never`・`gpt-6.1-sol`）が渡り、起動直後に失敗していた。
 */

const AUTO_REPLY_LABEL = '自動返信の返信役';
const AUTO_REPLY_LOG_PREFIX = '[autoReply]';

/** `agent.chat.autoReply.model`が`auto`のとき、Claude Code画面の返信役に使うモデル。 */
export const DEFAULT_AUTO_REPLY_CLAUDE_MODEL = 'sonnet';

/**
 * 無操作で返信役を閉じるまでの既定時間。`AdvisorSession`の
 * `DEFAULT_ADVISOR_IDLE_TIMEOUT_MS`と同じ30分を踏襲する（Issue「無操作が続いたとき
 * （`DEFAULT_ADVISOR_IDLE_TIMEOUT_MS`相当）に閉じる」）。
 */
export const DEFAULT_AUTO_REPLY_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * 返信役のモデル設定の`auto`を、返信役を開くプロバイダに合わせて解決する（Issue #1602）。
 *
 * 明示されたモデル名はそのまま使う。終了サマリと共用の`resolveAdvisorModel`はClaudeの
 * `auto`をCLIの既定モデルへ委ねるが、返信役は往復のたびに走るため軽量な`sonnet`へ倒す。
 */
export function resolveAutoReplyModel(model: string, provider: Provider): string {
  if (model !== 'auto' && model !== '') {
    return model;
  }
  return provider === 'claude' ? DEFAULT_AUTO_REPLY_CLAUDE_MODEL : DEFAULT_ADVISOR_CODEX_MODEL;
}

/**
 * 自動返信用の`TaskSessionInput`を組み立てる。
 *
 * 権限は分解セッションと同じ固定値（Codex: `approvalMode: never`、Claude: `manual`。
 * `plannerApprovalModeFor`）にする。`runSingleTurnTask`の起動前検査がこの値と照合する。
 * `sandbox: 'read-only'`とMCP・skill無効はCodex側だけに効き、Claude側は無視する。`effort`は
 * 空文字（拡張機能の既定に委ねる）で、Issueはeffortの設定を要求していない。
 */
export function buildAutoReplySessionInput(
  provider: Provider,
  cwd: string,
  model: string,
): TaskSessionInput {
  return {
    cwd,
    config: { model, effort: '', approvalMode: plannerApprovalModeFor(provider) },
    sandbox: SANDBOX_MODES[0],
    disableMcpServers: true,
    disableSkills: true,
  };
}

export type AutoReplyTurnResult =
  { ok: true; response: string } | { ok: false; kind: 'failed' | 'cancelled'; reason: string };

/** 返信役を閉じた理由。`describeAutoReplyStopReason`とは別に、返信役固有の理由を持つ。 */
export type AutoReplyAgentCloseReason =
  'userDisabled' | 'tabClosed' | 'idleTimeout' | 'replaced' | 'shutdown' | 'stopMarker' | 'failed';

const AUTO_REPLY_CLOSE_REASON_LABELS: Record<AutoReplyAgentCloseReason, string> = {
  userDisabled: '自動返信がOFFにされました',
  tabClosed: '元のタブが閉じられました',
  idleTimeout: '一定時間操作がありませんでした',
  replaced: '新しい返信役に差し替えられました',
  shutdown: '拡張機能の終了により閉じました',
  stopMarker: '返信役が停止の目印を返しました',
  failed: '実行に失敗しました',
};

/**
 * モードレベルの停止理由（`AutoReplyStopReason`、会話に残す1行の理由）から、返信役を
 * 閉じる理由（`AutoReplyAgentCloseReason`、ログ用のより細かい分類）へ写す。
 *
 * 直接対応するもの（停止の目印・無操作・タブを閉じた）はそのまま、それ以外
 * （回数上限・停滞・利用者の操作・ループ開始等、いずれもモードを明示的にOFFにした結果）は
 * `userDisabled`へ、返信役自体の失敗・タイムアウトは`failed`へまとめる。
 */
export function autoReplyAgentCloseReasonFor(
  reason: AutoReplyStopReason,
): AutoReplyAgentCloseReason {
  switch (reason) {
    case 'stopMarker':
      return 'stopMarker';
    case 'idleTimeout':
      return 'idleTimeout';
    case 'tabClosed':
      return 'tabClosed';
    case 'advisorFailed':
      return 'failed';
    default:
      return 'userDisabled';
  }
}

export interface AutoReplyAgentOptions {
  /** 返信役のセッションを開く土台（`chatView.ts` / `claudeChatView.ts` 自身）。 */
  host: TaskSessionHost;
  /** 返信役を開くプロバイダ。`host`の画面が会話しているCLIと揃える。 */
  provider: Provider;
  /** 元セッションと同じ作業ディレクトリ。 */
  cwd: string;
  /** 設定 `agent.chat.autoReply.model`（`'auto'`等、`resolveAutoReplyModel`で解決する前の生値）。 */
  model: string;
  /** 1ターンあたりのタイムアウト（設定 `agent.chat.autoReply.timeoutSeconds` 由来）。 */
  timeoutMs: number;
  /** 失敗・タイムアウト時に開き直して再試行する回数（設定 `agent.chat.autoReply.retryCount` 由来）。 */
  retryCount: number;
  /** 元セッションの最初の依頼文。役割文に含める。 */
  originalRequest: string;
  idleTimeoutMs?: number;
  log?: Logger;
  /** 閉じたときに呼ばれる。`close()`の中から同期で呼ぶ。 */
  onClosed?: (agent: AutoReplyAgent, reason: AutoReplyAgentCloseReason) => void;
}

/**
 * 保持した1本の返信役セッション。周をまたいで同じ会話を保持する。
 *
 * `close()`は冪等。`AdvisorSession.close()`と同じく「走っているターンを打ち切る →
 * `dispose()`」の順で行う。
 */
export class AutoReplyAgent {
  private readonly options: AutoReplyAgentOptions;
  private readonly idleTimeoutMs: number;
  private session: TaskSession | undefined;
  private closed = false;
  private closeReason: AutoReplyAgentCloseReason | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private turnController: AbortController | undefined;

  constructor(options: AutoReplyAgentOptions) {
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_AUTO_REPLY_IDLE_TIMEOUT_MS;
    this.armIdleTimer();
  }

  isClosed(): boolean {
    return this.closed;
  }

  closedReason(): AutoReplyAgentCloseReason | undefined {
    return this.closeReason;
  }

  /** 走っているターンがあるか。二重送信の防止に使う。 */
  isBusy(): boolean {
    return this.turnController !== undefined;
  }

  /**
   * 直前のエージェント出力を渡し、返信役の返事を受け取る。
   *
   * 失敗（途中までの応答も無いタイムアウトを含む）したときは、セッションを閉じて開き直し、
   * `retryCount`回まで再試行する（Issue #1602）。打ち切られた（`cancelled`）ときと、
   * 返信役自体が閉じられたときは再試行しない。`onAttempt`は各試行の直前に1始まりの試行番号と
   * 試行回数の上限で呼ばれ、画面の表示に使う。
   */
  async reply(
    lastAgentMessage: string,
    onAttempt?: (attempt: number, attempts: number) => void,
  ): Promise<AutoReplyTurnResult> {
    const attempts = this.options.retryCount + 1;
    for (let attempt = 1; ; attempt++) {
      onAttempt?.(attempt, attempts);
      const result = await this.replyOnce(lastAgentMessage);
      if (result.ok || result.kind === 'cancelled' || this.closed || attempt >= attempts) {
        return result;
      }
      this.options.log?.warn(
        `${AUTO_REPLY_LOG_PREFIX} 返信役が失敗したため開き直して再試行します（${attempt}/${attempts - 1}回目）: ${result.reason}`,
      );
      this.discardSession();
    }
  }

  /**
   * 1回だけ問い合わせる。
   *
   * セッションが無ければ開き、役割文（`buildAutoReplyRolePrompt`）と最初の材料を
   * まとめて送る。あれば同じセッションへ`buildAutoReplyTurnPrompt`だけを送り、
   * 周をまたいで文脈を保つ。
   */
  private async replyOnce(lastAgentMessage: string): Promise<AutoReplyTurnResult> {
    if (this.closed) {
      return { ok: false, kind: 'failed', reason: 'この返信役は既に終了しています' };
    }
    if (this.turnController !== undefined) {
      return { ok: false, kind: 'failed', reason: '返信役は別の問い合わせを実行中です' };
    }
    this.clearIdleTimer();
    const controller = new AbortController();
    this.turnController = controller;
    try {
      const response =
        this.session === undefined
          ? await this.openAndSendFirstTurn(lastAgentMessage, controller.signal)
          : await this.sendTurn(
              this.session,
              buildAutoReplyTurnPrompt(lastAgentMessage),
              controller.signal,
            );
      if (response.trim() === '') {
        return { ok: false, kind: 'failed', reason: '返信役の応答が空でした' };
      }
      return { ok: true, response };
    } catch (e) {
      if (e instanceof SingleTurnTimeoutError && e.partialText !== undefined) {
        return { ok: true, response: e.partialText };
      }
      if (e instanceof SingleTurnCancelledError) {
        if (e.partialText !== undefined) {
          return { ok: true, response: e.partialText };
        }
        return { ok: false, kind: 'cancelled', reason: e.message };
      }
      return { ok: false, kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    } finally {
      this.turnController = undefined;
      if (!this.closed) {
        this.armIdleTimer();
      }
    }
  }

  private async openAndSendFirstTurn(
    lastAgentMessage: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { provider } = this.options;
    const model = resolveAutoReplyModel(this.options.model, provider);
    const prompt = `${buildAutoReplyRolePrompt(this.options.originalRequest)}\n\n${buildAutoReplyTurnPrompt(lastAgentMessage)}`;
    const redaction = redactCredentials(prompt);
    this.logRedaction(redaction);
    return runSingleTurnTask(
      this.options.host,
      provider,
      buildAutoReplySessionInput(provider, this.options.cwd, model),
      redaction.text,
      {
        timeoutMs: this.options.timeoutMs,
        log: this.options.log,
        openPanel: false,
        label: AUTO_REPLY_LABEL,
        logPrefix: AUTO_REPLY_LOG_PREFIX,
        partialOnTimeout: true,
        signal,
        // 周をまたいで同じセッションを保持する。閉じる責任はこのクラスの`close()`が持つ
        disposeSession: false,
        onSessionOpened: (session) => {
          this.session = session;
        },
      },
    );
  }

  private async sendTurn(
    session: TaskSession,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const redaction = redactCredentials(prompt);
    this.logRedaction(redaction);
    return awaitSingleTurn(session, redaction.text, {
      timeoutMs: this.options.timeoutMs,
      log: this.options.log,
      label: AUTO_REPLY_LABEL,
      logPrefix: AUTO_REPLY_LOG_PREFIX,
      partialOnTimeout: true,
      signal,
    });
  }

  /**
   * 再試行の前に今のセッションを閉じ、次の問い合わせで役割文から開き直させる。
   * 失敗したセッションは応答待ちのまま固まっていることがあり、同じセッションへ送り直さない。
   */
  private discardSession(): void {
    const session = this.session;
    this.session = undefined;
    try {
      session?.dispose();
    } catch (e) {
      this.options.log?.warn(
        `${AUTO_REPLY_LOG_PREFIX} 再試行前に返信役を閉じられませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private logRedaction(redaction: ReturnType<typeof redactCredentials>): void {
    const note = describeRedaction(redaction);
    if (note !== undefined) {
      this.options.log?.info(`${AUTO_REPLY_LOG_PREFIX} ${note}`);
    }
  }

  /**
   * 閉じる。冪等。順は「タイマー解除 → 走っているターンを打ち切る → `dispose()`」
   * （`AdvisorSession.close()`と同じ順）。
   */
  close(reason: AutoReplyAgentCloseReason): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = reason;
    this.clearIdleTimer();
    try {
      this.turnController?.abort();
    } finally {
      try {
        this.session?.dispose();
      } catch (e) {
        this.options.log?.warn(
          `${AUTO_REPLY_LOG_PREFIX} 返信役を閉じられませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.options.log?.info(
        `${AUTO_REPLY_LOG_PREFIX} 返信役を閉じました（${AUTO_REPLY_CLOSE_REASON_LABELS[reason]}）`,
      );
      this.options.onClosed?.(this, reason);
    }
  }

  private armIdleTimer(): void {
    this.idleTimer = setTimeout(() => this.close('idleTimeout'), this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
