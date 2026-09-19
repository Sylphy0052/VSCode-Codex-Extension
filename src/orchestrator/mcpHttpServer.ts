import * as http from 'node:http';

import type { JsonRpcRequest, McpConnection } from './messaging';

/**
 * メッセージング用MCPサーバのHTTP層（design.md §16.21、Issue #105・#1305）。
 *
 * 元は`messaging.ts`の`startHttpMcpTransport`が直接持っていた。ワークフローのrun用
 * （タスクごとにURLを発行する）と、通常のチャットセッション用（セッションごとにURLを
 * 発行する。`sessionMessagingHost.ts`）の2つが同じHTTP層を要るようになったため、
 * 「トークンから接続先を解決する関数」だけを差し替えられる形でここへ切り出した。
 *
 * **方式の選定理由**（`startHttpMcpTransport`のJSDocから引き継ぐ）:
 *
 * - トークンは推測不能な128bit（`randomBytes(16)`）で、URLパス（`/mcp/<token>`）へ
 *   埋め込む。**トークンはURLの一部であり、ツールの引数ではない。** サーバは受け取った
 *   リクエストのパスからしか接続先を判別せず、リクエストボディの中身（`tools/call`の
 *   `arguments`）は一切信用しない（design.md「引数で名乗らせない」を構造的に保証する）
 * - `127.0.0.1`のエフェメラルポートで待ち受ける。他プロセスから推測されうる固定ポートを
 *   避けるため
 * - HTTPの1リクエストは1接続に対応する短命なやり取りだが、`McpConnection`が要求する
 *   `onRequest`/`send`/`onClose`は「1回のリクエストに対して1回だけ呼ばれる」形で満たせる
 */

/** トークン1つが指す接続先。 */
export interface McpHttpTarget {
  /**
   * 接続の識別子。run用は`taskId`、セッション用は宛先ref（`session:...`）。
   *
   * ボディの受信完了時に、トークンがまだ同じ識別子を指しているかを照合するために使う
   * （Issue #1113。下の`handle`の呼び出し条件を参照）。
   */
  connectionId: string;
  /** 1リクエスト分の接続をMCPサーバへ渡す。 */
  handle(connection: McpConnection): void;
}

export interface HttpMcpServerHandle {
  /** サーバの待受アドレス（`http://127.0.0.1:<port>`）。 */
  baseUrl: string;
  /** トークンから接続用URLを組み立てる。 */
  urlForToken(token: string): string;
  close(): Promise<void>;
}

export const MCP_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * HTTPリクエストボディの受信バイト数の上限（Issue #132 PRレビューでのセキュリティ監査、
 * Info）。`MAX_MESSAGE_BODY_LENGTH`（4000文字）はJSONをパースし終えた後の
 * `validateSendMessage`で効くため、パース前の受信量そのものには効かない。ローカル
 * ループバック（`127.0.0.1`）+ 128bitトークン付きURLでしか到達できず外部からの悪用は
 * 考えにくいが、そのCLIプロセス自身が巨大なボディを送る経路は残るため、受信を
 * 打ち切る上限を別に設ける。
 *
 * `tools/call`の正規のリクエストは`send_message`の本文（最大4000文字）にJSON-RPCの
 * envelope・UTF-8での多バイト文字・JSON文字列内のエスケープ（`\uXXXX`で1文字が最大6バイトに
 * 膨らみうる）を足しても数万バイトに収まる。64KiBは余裕を持たせつつ「数十KB程度」に収める値。
 */
const MAX_MCP_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * HTTPのMCPサーバを1つ立てる。`resolve`はトークンから接続先を解決する関数で、
 * 失効したトークンには`undefined`を返す（以後そのURLは404になる）。
 */
export function startHttpMcpServer(
  resolve: (token: string) => McpHttpTarget | undefined,
): Promise<HttpMcpServerHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/mcp\/([0-9a-f]{32})$/u.exec(url.pathname);
    const token = match?.[1];
    const target =
      token !== undefined && MCP_TOKEN_PATTERN.test(token) ? resolve(token) : undefined;

    if (req.method !== 'POST' || token === undefined || target === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const connectionId = target.connectionId;

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejectedForSize = false;
    req.on('data', (chunk: Buffer) => {
      if (rejectedForSize) {
        return;
      }
      receivedBytes += chunk.length;
      // 上限を超えた時点でボディの蓄積を打ち切る（`MAX_MCP_REQUEST_BODY_BYTES`参照）。既に
      // 受け取った分もチャンクへ積まず捨て、以後のチャンクも無視する
      if (receivedBytes > MAX_MCP_REQUEST_BODY_BYTES) {
        rejectedForSize = true;
        chunks.length = 0;
        res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
        // ここで`req.destroy()`をするとソケットが即座に壊れ、まだ本文を送っている途中の
        // クライアントはTCPのRSTを受けて`ECONNRESET`になる。413を返しても相手がそれを
        // 読めないうえ、テストも並列実行で不安定になっていた（Issue #152）。残りの受信は
        // `resume()`で読み流して捨てる。`chunks`へ積まないためメモリは増えず、
        // 「上限を超えた分は受け取らない」という意図はそのまま満たせる
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejectedForSize) {
        return;
      }
      // ヘッダー受信時に決めた接続先を、本文の受信完了時にもう一度照合する（Issue #1113）。
      // ヘッダーだけ送って本文を保留したまま再登録が走ると、失効したはずの古いトークンの
      // 要求が新しいセッションと同じ識別子として処理されてしまう。トークンがまだ同じ
      // 接続先へ紐づいていることをここで確かめ、失効していれば拒否する
      const current = resolve(token);
      if (current === undefined || current.connectionId !== connectionId) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid json');
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('jsonrpc' in parsed) ||
        !('method' in parsed)
      ) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid request');
        return;
      }
      const request = parsed as JsonRpcRequest;
      // 接続の識別子は常にURLのトークンから解決した値（上のJSDoc参照）。リクエスト自体に
      // taskId/fromらしきフィールドがあっても、connection経由では一切渡していない
      const connection: McpConnection = {
        taskId: connectionId,
        send(response) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
        },
        onRequest(handler) {
          handler(request);
        },
        onClose() {
          // HTTPは1リクエストごとに完結するため、明示的に閉じる操作は無い
        },
      };
      current.handle(connection);
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolvePromise({
        baseUrl,
        urlForToken: (token) => `${baseUrl}/mcp/${token}`,
        close(): Promise<void> {
          return new Promise((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}
