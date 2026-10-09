import { parseCdpEndpoint } from './discussion';

/**
 * Chrome DevTools Protocol（CDP）の最小限のクライアント（Issue #1901）。
 *
 * 画像生成のMCPサーバが、ログイン済みChromeでタブを1つ開いて操作するためだけに使う。
 * `playwright-core`を依存へ足すとvsixが大きくなり、esbuildでの同梱も難しいため、
 * Node.jsのグローバル`WebSocket`でブラウザのエンドポイントへ直接つなぐ。
 */

const COMMAND_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** 接続が切れた後の失敗。ページの読み込み待ちなど、再試行してよい失敗と区別する。 */
export class CdpClosedError extends Error {}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CdpBrowser {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: CdpClosedError | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () =>
      this.failAll(new CdpClosedError('Chromeとの接続が切れました')),
    );
  }

  /** `endpoint`（`http://127.0.0.1:9222`形式）のブラウザへつなぐ。 */
  static async connect(rawEndpoint: string): Promise<CdpBrowser> {
    if (typeof WebSocket !== 'function') {
      throw new Error('このVS CodeのNode.jsはWebSocketに対応していません。VS Codeを更新してください');
    }
    const endpoint = parseCdpEndpoint(rawEndpoint);
    const response = await fetch(`${endpoint}/json/version`, {
      redirect: 'error',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error('CDP接続先が正常な応答を返しません');
    }
    const version: unknown = await response.json();
    const url =
      typeof version === 'object' && version !== null && 'webSocketDebuggerUrl' in version
        ? version.webSocketDebuggerUrl
        : undefined;
    if (typeof url !== 'string' || !isLoopbackWebSocket(url, endpoint)) {
      throw new Error('CDP接続先からブラウザのWebSocket URLを読み取れません');
    }
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error('ChromeのCDPへ接続できません'));
        const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
        socket.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener('error', fail, { once: true });
        socket.addEventListener('close', fail, { once: true });
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpBrowser(socket);
  }

  /** CDPのコマンドを送る。`sessionId`を渡すとそのタブ宛てになる。 */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closedError !== undefined) {
      return Promise.reject(this.closedError);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromeが応答しません（${method}）`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      } catch {
        // 閉じかけの接続では同期で投げる
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpClosedError('Chromeとの接続が切れました'));
      }
    });
  }

  close(): void {
    this.failAll(new CdpClosedError('Chromeとの接続を閉じました'));
    this.socket.close();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null || !('id' in message)) return;
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (pending === undefined || typeof message.id !== 'number') return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) {
      const error = message.error;
      const text =
        typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message)
          : 'CDPのコマンドが失敗しました';
      pending.reject(new Error(text));
      return;
    }
    const result = 'result' in message ? message.result : undefined;
    pending.resolve(
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {},
    );
  }

  private failAll(error: CdpClosedError): void {
    this.closedError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * ブラウザが返したURLもループバックに限る。接続先の検証（`parseCdpEndpoint`）と揃える。
 * ポートも接続先と同じに限る。同じホストの別のポートで待ち受ける別プロセスへ、
 * 応答の書き換えで誘導されないようにするため（Issue #1903）。
 */
function isLoopbackWebSocket(value: string, endpoint: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'ws:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === new URL(endpoint).port
    );
  } catch {
    return false;
  }
}

/** ページ内で式を評価し、値を返す。式が例外を投げたら`Error`にする。 */
export async function evaluateInPage(
  browser: CdpBrowser,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const response = await browser.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  const exceptionDetails = response['exceptionDetails'];
  if (exceptionDetails !== undefined) {
    throw new Error(`ChatGPTの画面でスクリプトが失敗しました: ${exceptionSummary(exceptionDetails)}`);
  }
  const result = response['result'];
  return typeof result === 'object' && result !== null && 'value' in result
    ? result.value
    : undefined;
}

/** 例外の1行目（`TypeError: ...`）を、セレクタの見直しの手がかりとして短く取り出す。 */
function exceptionSummary(details: unknown): string {
  const record = typeof details === 'object' && details !== null ? details : {};
  const exception = 'exception' in record ? record.exception : undefined;
  const description =
    typeof exception === 'object' && exception !== null && 'description' in exception
      ? exception.description
      : undefined;
  const text =
    typeof description === 'string' ? description : 'text' in record ? record.text : undefined;
  return typeof text === 'string' ? (text.split('\n')[0] ?? '').slice(0, 200) : '詳細不明';
}
