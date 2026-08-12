import * as http from 'node:http';

/**
 * タスク間メッセージング（design.md §16.21、Issue #171）用のMCPサーバへ、テストから
 * 実際にHTTPで話すための最小クライアント。
 *
 * ツール呼び出しをtransport経由で通すのは、**送信元の判別を本物に通す**ため。サーバは
 * URLのトークン（`/mcp/<token>`）からしか送信元タスクを決めないので、テストが引数で
 * `from` を名乗っても無視されることまで確かめられる（`messaging.ts` の
 * `MessagingMcpServer.handleToolCall`）。
 */

interface JsonRpcResponseLike {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

function post(url: string, payload: unknown): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** ツール呼び出しの結果（`content[0].text` をそのまま返す）。 */
export interface ToolCallResult {
  text: string;
  isError: boolean;
}

async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await post(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (response.status !== 200) {
    throw new Error(`MCPサーバがエラーを返した（status=${response.status}）: ${response.body}`);
  }
  const parsed = JSON.parse(response.body) as JsonRpcResponseLike;
  if (parsed.error !== undefined) {
    throw new Error(`JSON-RPCエラー: ${parsed.error.code} ${parsed.error.message}`);
  }
  return {
    text: parsed.result?.content?.[0]?.text ?? '',
    isError: parsed.result?.isError === true,
  };
}

/**
 * `send_message` を呼ぶ。`extraArgs` には、送信元を偽る `from` のような**サーバが無視
 * すべき引数**を混ぜられる（design.md §16.21「引数で名乗らせない」の検証用）。
 */
export function sendMessage(
  url: string,
  args: { to: string; body: string; expectReply: boolean },
  extraArgs: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  return callTool(url, 'send_message', { ...args, ...extraArgs });
}

/** `list_tasks` を呼び、返ってきたJSONをそのまま返す。 */
export async function listTasks(
  url: string,
): Promise<Array<{ id: string; state: string; summary: string }>> {
  const result = await callTool(url, 'list_tasks', {});
  return JSON.parse(result.text) as Array<{ id: string; state: string; summary: string }>;
}
