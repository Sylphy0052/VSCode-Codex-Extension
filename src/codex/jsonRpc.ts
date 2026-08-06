export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface FrameResult {
  messages: JsonRpcMessage[];
  /** 次のチャンクと連結するために残す、行として完成していない部分。 */
  rest: string;
}

/**
 * 改行区切りJSONのストリームを、完成した行だけメッセージに変換する。
 * パースできない行は捨てる（app-serverは診断メッセージを混ぜることがあるため）。
 */
export function consumeFrames(buffer: string): FrameResult {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;

  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline === -1) {
      break;
    }
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line === '') {
      continue;
    }
    const parsed = parseMessage(line);
    if (parsed !== undefined) {
      messages.push(parsed);
    }
  }

  return { messages, rest };
}

function parseMessage(line: string): JsonRpcMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  return raw as JsonRpcMessage;
}

export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

/** サーバーからの要求への応答。返さないとCodexは待ち続ける。 */
export function encodeResponse(id: number | string, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

export function encodeErrorResponse(id: number | string, message: string): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`;
}

/** サーバー要求か（idを持つ通知）。応答が必須のものを見分ける。 */
export function isServerRequest(message: JsonRpcMessage): boolean {
  return message.method !== undefined && message.id !== undefined;
}

/** `thread/fork` の応答から新しいスレッドidを取り出す。 */
export function readForkedThreadId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const thread = (result as Record<string, unknown>)['thread'];
  if (typeof thread !== 'object' || thread === null) {
    return undefined;
  }
  const t = thread as Record<string, unknown>;
  const id = t['id'] ?? t['sessionId'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
