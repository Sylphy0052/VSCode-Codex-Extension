import type { ApprovalDecision } from '../appserver/approvals';
import type { PendingApproval } from '../appserver/chatState';
import { describeTool } from './transcript';

/**
 * `claude` の stream-json 入出力に流す制御メッセージ。
 *
 * この制御プロトコルは公式ドキュメントに無く、SDKが使っている形に合わせている。
 * CLIの更新で形が変わりうるため、**扱えなければ静かに劣化する**（承認カードが
 * 出ないだけで会話は続く）ことを前提に組み立てる。
 */

export interface IncomingControlRequest {
  requestId: string;
  subtype: string;
  payload: Record<string, unknown>;
}

export interface ControlResponse {
  requestId: string;
  ok: boolean;
  error: string | undefined;
}

/** stdinへ書く発言。1行で書き切る。 */
export function buildUserMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

export function buildControlRequest(requestId: string, request: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}

/** CLIからの要求への応答。返さないとCLIは待ち続ける。 */
export function buildControlResponse(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

export function readControlRequest(
  event: Record<string, unknown>,
): IncomingControlRequest | undefined {
  if (str(event['type']) !== 'control_request') {
    return undefined;
  }
  const requestId = str(event['request_id']);
  const payload = rec(event['request']);
  if (requestId === '' || payload === undefined) {
    return undefined;
  }
  return { requestId, subtype: str(payload['subtype']), payload };
}

export function readControlResponse(event: Record<string, unknown>): ControlResponse | undefined {
  if (str(event['type']) !== 'control_response') {
    return undefined;
  }
  const response = rec(event['response']);
  const requestId = str(response?.['request_id']);
  if (response === undefined || requestId === '') {
    return undefined;
  }
  const ok = str(response['subtype']) !== 'error';
  return { requestId, ok, error: ok ? undefined : str(response['error']) || '不明なエラー' };
}

/** `can_use_tool` 要求を承認カードにする。 */
export function describeCanUseTool(
  requestId: string,
  request: Record<string, unknown>,
): PendingApproval | undefined {
  const name = str(request['tool_name']);
  if (name === '') {
    return undefined;
  }
  const input = rec(request['input']) ?? {};
  const tool = describeTool(name, input);

  if (tool.kind === 'commandExecution') {
    return {
      requestId,
      kind: 'command',
      title: 'コマンドの実行を許可しますか',
      detail: tool.detail,
    };
  }
  if (tool.kind === 'fileChange') {
    return {
      requestId,
      kind: 'fileChange',
      title: 'ファイルの変更を許可しますか',
      detail: tool.detail,
    };
  }
  return {
    requestId,
    kind: 'permissions',
    title: `${name} の実行を許可しますか`,
    detail: tool.detail === name ? summarizeInput(input) : tool.detail,
  };
}

/**
 * 承認の決定を応答の形にする。
 * CLI側に「この会話では常に許可」の区別が無いため、許可として返す。
 */
export function buildCanUseToolResponse(
  decision: ApprovalDecision,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (decision === 'accept' || decision === 'acceptForSession') {
    return { behavior: 'allow', updatedInput: input };
  }
  return { behavior: 'deny', message: 'ユーザーが拒否しました' };
}

/** ユーザーに聞けない要求への既定応答。拒否側に倒す。 */
export function defaultDenyControlResponse(): Record<string, unknown> {
  return { behavior: 'deny', message: '対応する画面がありません' };
}

function summarizeInput(input: Record<string, unknown>): string {
  const text = JSON.stringify(input);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
