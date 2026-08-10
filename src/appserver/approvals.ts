import type { PendingApproval } from './chatState';

/** UIに出す選択肢。protocolのdecision値に対応する。 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/**
 * app-serverがこちらへ投げてくる要求。
 *
 * `codex app-server generate-json-schema` の ServerRequest がこの10種で、
 * **すべてに応答を返さないとapp-serverは待ち続ける**。
 * 応答の形は要求ごとに違うので、揃っていない値を返すと相手側で失敗する。
 */
export const SERVER_REQUEST_METHODS = {
  /** 承認カードに出す。応答は `{ decision }` */
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  /** 応答は `{ permissions, scope }` */
  permissions: 'item/permissions/requestApproval',
  /** 旧形式。応答は `{ decision: ReviewDecision }` で語彙が異なる */
  applyPatch: 'applyPatchApproval',
  execCommand: 'execCommandApproval',
  /** ツールからユーザーへの問い合わせ。応答は `{ answers: { <questionId>: { answers } } }` */
  requestUserInput: 'item/tool/requestUserInput',
  /** MCPサーバからの入力要求。応答は `{ action, content? }` */
  elicitation: 'mcpServer/elicitation/request',
  /** クライアント側でツールを実行させる要求。応答は `{ success, contentItems }` */
  toolCall: 'item/tool/call',
  /** 応答に `token` が要る。こちらでは作れない */
  attestation: 'attestation/generate',
  /** 応答に `accessToken` と `chatgptAccountId` が要る。こちらでは作れない */
  authTokensRefresh: 'account/chatgptAuthTokens/refresh',
} as const;

/** 承認カードに出せる要求。以前からある3種の別名を保つ。 */
export const APPROVAL_METHODS = {
  command: SERVER_REQUEST_METHODS.command,
  fileChange: SERVER_REQUEST_METHODS.fileChange,
  permissions: SERVER_REQUEST_METHODS.permissions,
  applyPatch: SERVER_REQUEST_METHODS.applyPatch,
  execCommand: SERVER_REQUEST_METHODS.execCommand,
} as const;

/**
 * 承認要求が別の経路で解決されたことを知らせる通知。
 *
 * 同じスレッドを別のウィンドウやTUIでも開いている場合、そちらの承認でこちらの
 * カードが宙に浮く。この通知で取り下げる。
 */
export const SERVER_REQUEST_RESOLVED = 'serverRequest/resolved';

/** 拒否をCodexへ伝える文言。ReviewDecisionの `denied` はrejectionを要求する。 */
const REJECTION = 'ユーザーが拒否しました';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * 承認要求を表示用に整える。
 * 承認カードに出せない要求は undefined を返す（勝手に許可しないため）。
 */
export function describeApproval(
  requestId: number | string,
  method: string,
  params: Record<string, unknown>,
): PendingApproval | undefined {
  if (method === APPROVAL_METHODS.command) {
    return {
      requestId,
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: withCwd(str(params['command']), str(params['cwd'])),
    };
  }

  if (method === APPROVAL_METHODS.fileChange) {
    return {
      requestId,
      kind: 'fileChange',
      title: 'ファイルの変更を許可しますか',
      detail: describeChanges(params['changes']) || str(params['reason']),
    };
  }

  if (method === APPROVAL_METHODS.permissions) {
    return {
      requestId,
      kind: 'permissions',
      title: '権限の昇格を許可しますか',
      detail: str(params['reason']),
    };
  }

  // 旧形式。paramsの形が新しい要求と違うため、取り出し方を分ける
  if (method === APPROVAL_METHODS.applyPatch) {
    return {
      requestId,
      kind: 'applyPatch',
      title: 'ファイルの変更を許可しますか',
      detail: describeFileChangeMap(params['fileChanges']) || str(params['reason']),
    };
  }

  if (method === APPROVAL_METHODS.execCommand) {
    return {
      requestId,
      kind: 'execCommand',
      title: 'コマンドの実行を許可しますか',
      detail: withCwd(joinCommand(params['command']), str(params['cwd'])),
    };
  }

  return undefined;
}

function withCwd(command: string, cwd: string): string {
  return [command, cwd === '' ? '' : `(${cwd})`].filter((s) => s !== '').join('\n');
}

/** 旧形式のコマンドは配列で届く。 */
function joinCommand(command: unknown): string {
  if (typeof command === 'string') {
    return command;
  }
  if (!Array.isArray(command)) {
    return '';
  }
  return command.filter((part): part is string => typeof part === 'string').join(' ');
}

function describeChanges(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return '';
  }
  return changes
    .map((c) => str(rec(c)?.['path']) || str(rec(c)?.['file']))
    .filter((p) => p !== '')
    .join('\n');
}

/** 旧形式の変更はパスをキーにしたオブジェクトで届く。 */
function describeFileChangeMap(fileChanges: unknown): string {
  const changes = rec(fileChanges);
  return changes === undefined ? '' : Object.keys(changes).join('\n');
}

/**
 * 決定を応答の形に変換する。
 *
 * 要求ごとに語彙が違う。権限要求は decision を持たず、旧形式は ReviewDecision の語彙を使う。
 */
export function buildApprovalResponse(
  kind: PendingApproval['kind'],
  decision: ApprovalDecision,
  params: Record<string, unknown>,
): unknown {
  if (kind === 'permissions') {
    if (decision === 'accept' || decision === 'acceptForSession') {
      return {
        permissions: params['permissions'] ?? {},
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    }
    return { permissions: {}, scope: 'turn' };
  }

  if (kind === 'applyPatch' || kind === 'execCommand') {
    return { decision: reviewDecision(decision) };
  }

  return { decision };
}

/** 旧形式の応答に使う ReviewDecision。 */
function reviewDecision(decision: ApprovalDecision): unknown {
  switch (decision) {
    case 'accept':
      return 'approved';
    case 'acceptForSession':
      return 'approved_for_session';
    case 'cancel':
      // 中断。次の指示まで何もさせない
      return 'abort';
    default:
      return { denied: { rejection: REJECTION } };
  }
}

/**
 * ユーザーに聞けない要求への既定応答。拒否側に倒す。
 *
 * 応答の値を組み立てられない要求では undefined を返す。呼び出し側はJSON-RPCの
 * エラーで応答すること。**黙って返さないとapp-serverが待ち続ける**。
 */
export function defaultDenyResponse(
  method: string,
  params: Record<string, unknown>,
): unknown | undefined {
  switch (method) {
    case SERVER_REQUEST_METHODS.command:
    case SERVER_REQUEST_METHODS.fileChange:
      return { decision: 'decline' };

    case SERVER_REQUEST_METHODS.permissions:
      return { permissions: {}, scope: 'turn' };

    case SERVER_REQUEST_METHODS.applyPatch:
    case SERVER_REQUEST_METHODS.execCommand:
      return { decision: { denied: { rejection: REJECTION } } };

    case SERVER_REQUEST_METHODS.requestUserInput:
      // 質問には答えられないが、idを揃えた空の回答なら形が合う
      return { answers: emptyAnswers(params['questions']) };

    case SERVER_REQUEST_METHODS.elicitation:
      return { action: 'decline' };

    case SERVER_REQUEST_METHODS.toolCall:
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: 'この拡張機能はツールを実行できません' }],
      };

    default:
      // attestation/generate と account/chatgptAuthTokens/refresh を含む。
      // 値を捏造すると認証や検証が誤って通るため、応答しない
      return undefined;
  }
}

function emptyAnswers(questions: unknown): Record<string, { answers: string[] }> {
  if (!Array.isArray(questions)) {
    return {};
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const id = str(rec(question)?.['id']);
    if (id !== '') {
      answers[id] = { answers: [] };
    }
  }
  return answers;
}
