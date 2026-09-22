import { SANDBOX_MODES, type ApprovalMode } from '../codex/types';
import type { Logger } from '../log';
import { resolveAdvisorModel } from '../loop/loopAdvisor';
import {
  awaitSingleTurn,
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
 * `redactCredentials`（`secondOpinion/redact.ts`）・`resolveAdvisorModel`
 * （`loop/loopAdvisor.ts`）という、`AdvisorSession`（`secondOpinion/advisorSession.ts`）と
 * 同じ基盤プリミティブを使う。`AdvisorSession`自体を直接使わないのは、あちらが
 * セカンドオピニオン固有の概念（候補・下書き・材料の世代管理・bundle）を多く抱えており、
 * 自動返信には要らないため。同じ基盤の上に、必要な分だけの薄いラッパーを別に持つ。
 *
 * 返信役は常にCodexセッションとして開く（Issue本文「返信役は...Codexセッションとし」）。
 */

const AUTO_REPLY_APPROVAL_MODE: ApprovalMode = 'never';
const AUTO_REPLY_LABEL = '自動返信の返信役';
const AUTO_REPLY_LOG_PREFIX = '[autoReply]';
const AUTO_REPLY_PROVIDER: Provider = 'codex';

/**
 * 無操作で返信役を閉じるまでの既定時間。`AdvisorSession`の
 * `DEFAULT_ADVISOR_IDLE_TIMEOUT_MS`と同じ30分を踏襲する（Issue「無操作が続いたとき
 * （`DEFAULT_ADVISOR_IDLE_TIMEOUT_MS`相当）に閉じる」）。
 */
export const DEFAULT_AUTO_REPLY_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * 自動返信用の`TaskSessionInput`を組み立てる。
 *
 * `secondOpinion/run.ts`の`buildSecondOpinionSessionInput`と同じ方針で権限を固定する
 * （`sandbox: 'read-only'` / `approvalMode: 'never'` / MCP・skill無効）。`effort`は
 * 空文字（拡張機能の既定に委ねる）で、Issueはeffortの設定を要求していない。
 */
export function buildAutoReplySessionInput(cwd: string, model: string): TaskSessionInput {
  return {
    cwd,
    config: { model, effort: '', approvalMode: AUTO_REPLY_APPROVAL_MODE },
    sandbox: SANDBOX_MODES[0],
    disableMcpServers: true,
    disableSkills: true,
  };
}

export type AutoReplyTurnResult =
  | { ok: true; response: string }
  | { ok: false; kind: 'failed' | 'cancelled'; reason: string };

/** 返信役を閉じた理由。`describeAutoReplyStopReason`とは別に、返信役固有の理由を持つ。 */
export type AutoReplyAgentCloseReason =
  | 'userDisabled'
  | 'tabClosed'
  | 'idleTimeout'
  | 'replaced'
  | 'shutdown'
  | 'stopMarker'
  | 'failed';

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
export function autoReplyAgentCloseReasonFor(reason: AutoReplyStopReason): AutoReplyAgentCloseReason {
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
  /** 元セッションと同じ作業ディレクトリ。 */
  cwd: string;
  /** 設定 `agent.chat.autoReply.model`（`'auto'`等、`resolveAdvisorModel`で解決する前の生値）。 */
  model: string;
  /** 1ターンあたりのタイムアウト（設定 `agent.chat.autoReply.timeoutSeconds` 由来）。 */
  timeoutMs: number;
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
   * 初回呼び出し時だけセッションを開き、役割文（`buildAutoReplyRolePrompt`）と最初の材料を
   * まとめて送る。2回目以降は同じセッションへ`buildAutoReplyTurnPrompt`だけを送り、
   * 周をまたいで文脈を保つ。
   */
  async reply(lastAgentMessage: string): Promise<AutoReplyTurnResult> {
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
          : await this.sendTurn(this.session, buildAutoReplyTurnPrompt(lastAgentMessage), controller.signal);
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

  private async openAndSendFirstTurn(lastAgentMessage: string, signal: AbortSignal): Promise<string> {
    const model = resolveAdvisorModel(this.options.model, AUTO_REPLY_PROVIDER);
    const prompt = `${buildAutoReplyRolePrompt(this.options.originalRequest)}\n\n${buildAutoReplyTurnPrompt(lastAgentMessage)}`;
    const redaction = redactCredentials(prompt);
    this.logRedaction(redaction);
    return runSingleTurnTask(
      this.options.host,
      AUTO_REPLY_PROVIDER,
      buildAutoReplySessionInput(this.options.cwd, model),
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

  private async sendTurn(session: TaskSession, prompt: string, signal: AbortSignal): Promise<string> {
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
