import { parseAttachmentInputs } from '../provider/attachments';
import type { SessionControlAction, SessionControlResult } from './chatManagerBase';
import { parseAskUserQuestionAnswers, parsePromptSubmission } from './pendingItem';
import {
  isSharedApprovalDecision,
  isSharedHandoffDecision,
  isWindowIdShape,
  type SessionHubReplyPayload,
  type SessionHubRequest,
} from './sessionHub';

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

/** `@`の補完で絞り込む文字列の長さの上限（Issue #2158）。パスの断片として十分な長さ。 */
export const MAX_CANDIDATE_QUERY_CHARS = 500;

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
    // Issue #2158: 添付・補完・送信キュー
    case 'sendWithAttachments': {
      const attachments = parseAttachmentInputs(message.attachments);
      return typeof message.text === 'string' && attachments !== undefined
        ? { kind: 'sendWithAttachments', text: message.text, attachments }
        : undefined;
    }
    case 'fileCandidates':
      return typeof message.query === 'string' && message.query.length <= MAX_CANDIDATE_QUERY_CHARS
        ? { kind: 'fileCandidates', query: message.query }
        : undefined;
    case 'commandCandidates':
      return { kind: 'commandCandidates' };
    case 'queuedMessages':
      return { kind: 'queuedMessages' };
    case 'cancelQueued':
      return Number.isSafeInteger(message.index) &&
        (message.index as number) >= 0 &&
        typeof message.text === 'string'
        ? { kind: 'cancelQueued', index: message.index as number, text: message.text }
        : undefined;
    default:
      return undefined;
  }
}

/** 操作の結果から、別ウィンドウへ返す応答の`payload`を作る。 */
export function toReplyPayload(result: SessionControlResult): SessionHubReplyPayload | undefined {
  if (result.approvals !== undefined) {
    return { approvals: result.approvals };
  }
  if (result.turns !== undefined) {
    return {
      turns: result.turns,
      capturedAt: result.capturedAt,
      turnStart: result.turnStart,
      turnTotal: result.turnTotal,
    };
  }
  if (result.handoff !== undefined) {
    return { handoff: result.handoff };
  }
  if (result.sideQuestion !== undefined) {
    return { sideQuestion: result.sideQuestion };
  }
  if (result.files !== undefined) {
    return { files: result.files };
  }
  if (result.commands !== undefined) {
    return { commands: result.commands };
  }
  if (result.queued !== undefined) {
    return { queued: result.queued };
  }
  return undefined;
}

/**
 * 要求ファイルの`kind`を、チャット画面への操作へ変える（Issue #1258、#1259）。
 *
 * `kind`を`string`として扱うのは、共有ディレクトリへ書き込むのが版の違う別プロセス
 * だから（`SessionHubRequestWatcher`は未知の`kind`もそのまま渡す）。知らない操作は
 * `undefined`を返し、呼び出し側が「扱えない」と応答して、送った側をタイムアウトまで
 * 待たせない。`decision`も同じ理由で、ここでホワイトリスト検証してから通す。
 */
export function toSessionControlAction(
  request: Pick<
    SessionHubRequest,
    | 'kind'
    | 'text'
    | 'approvalRequestId'
    | 'decision'
    | 'limit'
    | 'before'
    | 'sideQuestionId'
    | 'handoffRequestId'
    | 'handoffDecision'
    | 'handoffModel'
    | 'handoffEffort'
    | 'pendingRequestId'
    | 'answers'
    | 'submission'
    | 'attachments'
    | 'query'
    | 'index'
  >,
): SessionControlAction | undefined {
  const { text, approvalRequestId, decision, limit, sideQuestionId } = request;
  switch (request.kind as string) {
    case 'open':
      return { kind: 'open' };
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'pauseLoop':
      return { kind: 'pauseLoop' };
    case 'resumeLoop':
      return { kind: 'resumeLoop' };
    case 'send':
      return text === undefined ? undefined : { kind: 'send', text };
    case 'approvalDetail':
      return { kind: 'approvalDetail' };
    case 'recentTurns':
      // 件数は受信側（`controlSession`）が範囲へ丸める。ここでは形だけ確かめる
      return {
        kind: 'recentTurns',
        limit: typeof limit === 'number' ? limit : 1,
        before: typeof request.before === 'number' ? request.before : undefined,
      };
    case 'sideQuestion':
      // 質問文の空・長さは受信側（`controlSession`）が確かめる
      return text === undefined ? undefined : { kind: 'sideQuestion', text };
    case 'sideQuestionResult':
      return sideQuestionId === undefined
        ? undefined
        : { kind: 'sideQuestionResult', sideQuestionId };
    case 'approvalDecision':
      return approvalRequestId === undefined || !isSharedApprovalDecision(decision)
        ? undefined
        : { kind: 'approvalDecision', approvalRequestId, decision };
    case 'handoffDetail':
      return { kind: 'handoffDetail' };
    case 'handoffDecision':
      // model / effortは受信側（`PendingHandoffChoice`）が候補と突き合わせて弾く。
      // ここは`decision`だけをホワイトリストで確かめる
      return request.handoffRequestId === undefined ||
        !isSharedHandoffDecision(request.handoffDecision)
        ? undefined
        : {
            kind: 'handoffDecision',
            handoffRequestId: request.handoffRequestId,
            decision: request.handoffDecision,
            model: request.handoffModel,
            effort: request.handoffEffort,
          };
    case 'answerQuestion':
      // 質問との突き合わせは受信側（`controlSession`）が行う。ここは形だけ確かめる
      return request.pendingRequestId === undefined || request.answers === undefined
        ? undefined
        : {
            kind: 'answerQuestion',
            pendingRequestId: request.pendingRequestId,
            answers: request.answers,
          };
    case 'answerPrompt': {
      const submission = parsePromptSubmission(request.submission);
      return request.pendingRequestId === undefined || submission === undefined
        ? undefined
        : { kind: 'answerPrompt', pendingRequestId: request.pendingRequestId, submission };
    }
    // Issue #2158: 添付・補完・送信キュー。形は`parseAction`（webviewの入口）と同じ規則で確かめる
    case 'sendWithAttachments':
      return text === undefined || request.attachments === undefined
        ? undefined
        : { kind: 'sendWithAttachments', text, attachments: request.attachments };
    case 'fileCandidates':
      return parseAction({ action: 'fileCandidates', query: request.query });
    case 'commandCandidates':
      return { kind: 'commandCandidates' };
    case 'queuedMessages':
      return { kind: 'queuedMessages' };
    case 'cancelQueued':
      return parseAction({ action: 'cancelQueued', index: request.index, text });
    default:
      return undefined;
  }
}
