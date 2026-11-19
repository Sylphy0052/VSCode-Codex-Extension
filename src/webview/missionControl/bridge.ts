import type {
  McApprovalDetail,
  McControlAction,
  McHostMessage,
  McSnapshot,
  McTarget,
  McTurn,
} from './protocol';

/** webviewの`acquireVsCodeApi()`が返すもの（使う分だけ）。 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface ControlResult {
  ok: boolean;
  error?: string | undefined;
  approvals?: McApprovalDetail[] | undefined;
  turns?: McTurn[] | undefined;
}

export interface Bridge {
  request(target: McTarget, action: McControlAction): Promise<ControlResult>;
  onSnapshot(listener: (snapshot: McSnapshot) => void): () => void;
  /** 画面がメッセージを受けられるようになったことを知らせる。拡張ホストは最初の一覧を返す。 */
  ready(): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** `window`のうち使う分だけ。DOMの型に依らず単体テストから渡せるようにする。 */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** 応答が来ない操作を打ち切るまでの時間。拡張ホスト側は別ウィンドウ宛てを5秒で打ち切る。 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 拡張ホストとのやり取り。操作には通し番号（`seq`）を振り、`controlResult`の応答と結び付ける。
 * 拡張ホストから届くメッセージは`type`で振り分け、知らない形は捨てる。
 */
export function createBridge(api: VsCodeApi, target: MessageTarget): Bridge {
  let seq = 0;
  const waiting = new Map<number, (result: ControlResult) => void>();
  const listeners = new Set<(snapshot: McSnapshot) => void>();
  target.addEventListener('message', (event) => {
    const message = event.data as McHostMessage | undefined;
    if (typeof message !== 'object' || message === null) {
      return;
    }
    if (message.type === 'snapshot') {
      for (const listener of listeners) {
        listener(message.snapshot);
      }
      return;
    }
    if (message.type === 'controlResult') {
      const resolve = waiting.get(message.seq);
      if (resolve !== undefined) {
        waiting.delete(message.seq);
        resolve({
          ok: message.ok,
          error: message.error,
          approvals: message.approvals,
          turns: message.turns,
        });
      }
    }
  });
  return {
    request(to, action) {
      seq += 1;
      const id = seq;
      return new Promise<ControlResult>((resolve) => {
        const timer = setTimeout(() => {
          if (waiting.delete(id)) {
            resolve({ ok: false, error: '拡張機能から応答がありませんでした' });
          }
        }, REQUEST_TIMEOUT_MS);
        waiting.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        // 宛先は3つの値だけを載せる（Inboxの項目をそのまま渡されても、余計な値を送らない）
        api.postMessage({
          type: 'control',
          seq: id,
          windowId: to.windowId,
          provider: to.provider,
          threadId: to.threadId,
          ...action,
        });
      });
    },
    onSnapshot(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: () => api.postMessage({ type: 'ready' }),
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
  };
}
