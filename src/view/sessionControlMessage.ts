import type { SessionControlAction, SessionControlResult } from './chatManagerBase';
import { parseAskUserQuestionAnswers, parsePromptSubmission } from './pendingItem';
import { isSharedApprovalDecision, isSharedHandoffDecision, isWindowIdShape } from './sessionHub';

/**
 * 画面（Mission Control）から届くセッション操作のメッセージを確かめる。
 *
 * 旧セッション統括ページ（`sessionKanbanView.ts`。Issue #2138で廃止）にあった関数を、
 * 画面と切り離してここへ移した。webviewは信頼境界の外側として扱い、形の合わない
 * メッセージは`undefined`にする。
 */

/** 操作の相手。どのウィンドウのどのセッションか。 */
export interface SessionControlTarget {
  windowId: string;
  provider: 'codex' | 'claude';
  threadId: string;
}

/**
 * セッションへ操作を届ける（Issue #1258）。
 *
 * 自ウィンドウか別ウィンドウかの判定と、別ウィンドウ宛ての要求ファイルの送受信は
 * `extension.ts`側が持つ。画面は「誰に何をするか」だけを渡し、結果を受け取って出す。
 */
export type SessionControl = (
  target: SessionControlTarget,
  action: SessionControlAction,
) => Promise<SessionControlResult>;

/** 会話のidの長さの上限。CodexのthreadId・ClaudeのセッションidはUUIDで、これより十分短い。 */
const MAX_THREAD_ID_LENGTH = 256;

/**
 * 宛先を確かめる。一覧（スナップショット）と照合する前に形で弾く: windowIdはUUID、threadIdは
 * 空でなく上限より短い1行（Issue #2150。#2149のレビューの指摘）。
 */
export function parseTarget(message: Record<string, unknown>): SessionControlTarget | undefined {
  if (
    !isWindowIdShape(message.windowId) ||
    typeof message.threadId !== 'string' ||
    message.threadId === '' ||
    message.threadId.length > MAX_THREAD_ID_LENGTH ||
    /[\r\n]/u.test(message.threadId) ||
    (message.provider !== 'codex' && message.provider !== 'claude')
  ) {
    return undefined;
  }
  return {
    windowId: message.windowId,
    provider: message.provider,
    threadId: message.threadId,
  };
}

export function parseAction(message: Record<string, unknown>): SessionControlAction | undefined {
  switch (message.action) {
    case 'open':
      return { kind: 'open' };
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'pauseLoop':
      return { kind: 'pauseLoop' };
    case 'resumeLoop':
      return { kind: 'resumeLoop' };
    case 'send':
      return typeof message.text === 'string' ? { kind: 'send', text: message.text } : undefined;
    case 'approvalDetail':
      return { kind: 'approvalDetail' };
    case 'recentTurns':
      return typeof message.limit === 'number'
        ? {
            kind: 'recentTurns',
            limit: message.limit,
            before: typeof message.before === 'number' ? message.before : undefined,
          }
        : undefined;
    case 'sideQuestion':
      return typeof message.text === 'string'
        ? { kind: 'sideQuestion', text: message.text }
        : undefined;
    case 'sideQuestionResult':
      return typeof message.sideQuestionId === 'string'
        ? { kind: 'sideQuestionResult', sideQuestionId: message.sideQuestionId }
        : undefined;
    case 'approvalDecision':
      // webviewは信頼境界の外側（`chatView.ts`と同じ扱い）。決定はホワイトリストで確かめる
      return typeof message.approvalRequestId === 'string' &&
        isSharedApprovalDecision(message.decision)
        ? {
            kind: 'approvalDecision',
            approvalRequestId: message.approvalRequestId,
            decision: message.decision,
          }
        : undefined;
    case 'handoffDetail':
      return { kind: 'handoffDetail' };
    case 'handoffDecision':
      // 承認の決定と同じ扱い。model / effortは受け取った側（`PendingHandoffChoice`）が
      // 公開した候補と突き合わせるので、ここでは形だけ確かめる
      return typeof message.handoffRequestId === 'string' &&
        isSharedHandoffDecision(message.decision)
        ? {
            kind: 'handoffDecision',
            handoffRequestId: message.handoffRequestId,
            decision: message.decision,
            model: typeof message.model === 'string' ? message.model : undefined,
            effort: typeof message.effort === 'string' ? message.effort : undefined,
          }
        : undefined;
    // 質問への回答（Issue #2135）。中身は受け取った側が質問・入力欄と突き合わせて確かめる
    case 'answerQuestion': {
      const answers = parseAskUserQuestionAnswers(message.answers);
      return typeof message.pendingRequestId === 'string' && answers !== undefined
        ? { kind: 'answerQuestion', pendingRequestId: message.pendingRequestId, answers }
        : undefined;
    }
    case 'answerPrompt': {
      const submission = parsePromptSubmission(message.submission);
      return typeof message.pendingRequestId === 'string' && submission !== undefined
        ? { kind: 'answerPrompt', pendingRequestId: message.pendingRequestId, submission }
        : undefined;
    }
    case 'answerTaskRunQuestion':
      return typeof message.pendingId === 'string' && typeof message.text === 'string'
        ? { kind: 'answerTaskRunQuestion', pendingId: message.pendingId, text: message.text }
        : undefined;
    default:
      return undefined;
  }
}
