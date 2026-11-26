import type { SessionControlAction, SessionControlResult } from './chatManagerBase';
import {
  LONG_REPLY_TIMEOUT_MS,
  type SessionHubReply,
  type SessionHubRequestPort,
} from './sessionHub';
import type { SessionControlTarget } from './sessionControlMessage';

/**
 * セッション1件への操作をどこで行うかを決め、別ウィンドウ宛ての要求の形を組む（Issue #2160）。
 *
 * `extension.ts`の`controlSessionAnywhere`はactivateの中のクロージャでunitテストから
 * 呼べないため、振り分けと要求の組み立てをここへ切り出した。送受信そのものは持たない。
 */

/**
 * 操作の行き先。
 *
 * - `taskRunQuestion`: このウィンドウのtask runの質問へ答える（会話に属さない。Issue #2135）
 * - `local`: このウィンドウの`controlSession`で行う
 * - `remote`: 宛先のウィンドウへ要求ファイルで回す
 */
export type SessionControlRoute = 'taskRunQuestion' | 'local' | 'remote';

/**
 * 宛先のウィンドウを問わず、このウィンドウで済ませる操作。
 *
 * ピン留めは全ウィンドウ共通の印（`globalState`）で、Mission Controlの表示もこのウィンドウの
 * `globalState`から読む。宛先へ回すと、要求元の表示へ効くのが相手の書き込みの伝わった後になる。
 */
const ANY_WINDOW_LOCAL_KINDS: ReadonlySet<SessionControlAction['kind']> = new Set(['pin', 'unpin']);

/**
 * 別ウィンドウ宛てで応答を長く待つ操作（Issue #2158）。画像を載せた要求は書き込み・読み込みに、
 * 候補の取り寄せはファイルの走査・CLIへの問い合わせに、既定の5秒を超えうる。
 */
const LONG_REPLY_KINDS: ReadonlySet<SessionControlAction['kind']> = new Set([
  'sendWithAttachments',
  'fileCandidates',
  'commandCandidates',
  // 全承認へ上げるときは宛先のウィンドウで同意のダイアログを待つ（Issue #2159）
  'changeSetting',
  // 名前の保存・分岐・タブの作り直し・CLIへの巻き戻しの問い合わせ（Issue #2160）
  'rename',
  'fork',
  'clear',
  'rewindPreview',
  'rewind',
]);

export function routeSessionControl(
  target: SessionControlTarget,
  action: SessionControlAction,
  selfWindowId: string,
): SessionControlRoute {
  const isSelf = target.windowId === selfWindowId;
  if (action.kind === 'answerTaskRunQuestion' && isSelf) {
    return 'taskRunQuestion';
  }
  if (isSelf || ANY_WINDOW_LOCAL_KINDS.has(action.kind)) {
    return 'local';
  }
  return 'remote';
}

/** 別ウィンドウ宛ての要求の中身。`SessionHubRequestPort.request`の第2引数。 */
export type RemoteControlInput = Parameters<SessionHubRequestPort['request']>[1];

/** 別ウィンドウ宛ての要求の中身を、操作の種類に合う欄だけ埋めて組む。 */
export function toRemoteControlInput(
  target: SessionControlTarget,
  action: SessionControlAction,
): RemoteControlInput {
  return {
    kind: action.kind,
    provider: target.provider,
    threadId: target.threadId,
    text:
      action.kind === 'send' ||
      action.kind === 'sideQuestion' ||
      action.kind === 'answerTaskRunQuestion' ||
      action.kind === 'sendWithAttachments'
        ? action.text
        : undefined,
    attachments: action.kind === 'sendWithAttachments' ? action.attachments : undefined,
    query: action.kind === 'fileCandidates' ? action.query : undefined,
    index: action.kind === 'cancelQueued' ? action.index : undefined,
    queuedId: action.kind === 'cancelQueued' ? action.queuedId : undefined,
    setting: action.kind === 'changeSetting' ? action.change.setting : undefined,
    settingValue: action.kind === 'changeSetting' ? action.change.value : undefined,
    name: action.kind === 'rename' ? action.name : undefined,
    messageId:
      action.kind === 'rewindPreview' || action.kind === 'rewind' ? action.messageId : undefined,
    pendingId: action.kind === 'answerTaskRunQuestion' ? action.pendingId : undefined,
    sideQuestionId: action.kind === 'sideQuestionResult' ? action.sideQuestionId : undefined,
    approvalRequestId: action.kind === 'approvalDecision' ? action.approvalRequestId : undefined,
    decision: action.kind === 'approvalDecision' ? action.decision : undefined,
    limit: action.kind === 'recentTurns' ? action.limit : undefined,
    before: action.kind === 'recentTurns' ? action.before : undefined,
    handoffRequestId: action.kind === 'handoffDecision' ? action.handoffRequestId : undefined,
    handoffDecision: action.kind === 'handoffDecision' ? action.decision : undefined,
    handoffModel: action.kind === 'handoffDecision' ? action.model : undefined,
    handoffEffort: action.kind === 'handoffDecision' ? action.effort : undefined,
    pendingRequestId:
      action.kind === 'answerQuestion' || action.kind === 'answerPrompt'
        ? action.pendingRequestId
        : undefined,
    answers: action.kind === 'answerQuestion' ? action.answers : undefined,
    submission: action.kind === 'answerPrompt' ? action.submission : undefined,
  };
}

/** 別ウィンドウ宛ての応答を待つ上限。`undefined`は既定（5秒）。 */
export function remoteReplyTimeoutMs(kind: SessionControlAction['kind']): number | undefined {
  return LONG_REPLY_KINDS.has(kind) ? LONG_REPLY_TIMEOUT_MS : undefined;
}

/** 別ウィンドウの応答を、画面へ返す結果の形へ移す。 */
export function fromRemoteReply(reply: SessionHubReply): SessionControlResult {
  return {
    ok: reply.ok,
    error: reply.error,
    approvals: reply.payload?.approvals,
    turns: reply.payload?.turns,
    capturedAt: reply.payload?.capturedAt,
    turnStart: reply.payload?.turnStart,
    turnTotal: reply.payload?.turnTotal,
    handoff: reply.payload?.handoff,
    sideQuestion: reply.payload?.sideQuestion,
    files: reply.payload?.files,
    commands: reply.payload?.commands,
    queued: reply.payload?.queued,
    settings: reply.payload?.settings,
    rewindFiles: reply.payload?.rewindFiles,
  };
}
