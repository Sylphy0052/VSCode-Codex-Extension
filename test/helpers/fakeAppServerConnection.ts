import type {
  AppServerConnectionPort,
  NotificationHandler,
  ServerRequestHandler,
} from '../../src/appserver/connection';
import type { JsonRpcMessage } from '../../src/codex/jsonRpc';

interface RecordedRequest {
  id: number;
  method: string;
  params: unknown;
}

/**
 * `AppServerConnection` の差し替え。子プロセスを起動せず、`thread/start` 等の応答を
 * テストコードから任意のタイミングで返せるようにする。
 *
 * Codexは1接続で複数スレッドを多重化する（`ChatViewManager` は接続を1つしか持たない）ため、
 * 並列開始時の誤配送（design.md §16.10の3）を検証するテストは、このフェイクを介して
 * 複数の `thread/start` 要求を意図的に未解決のまま並べる必要がある。
 */
export class FakeAppServerConnection implements AppServerConnectionPort {
  readonly requests: RecordedRequest[] = [];
  private nextId = 1;
  private readonly waiting = new Map<number, (message: JsonRpcMessage) => void>();

  constructor(
    private readonly onNotification: NotificationHandler,
    private readonly onServerRequest: ServerRequestHandler,
    /** 接続断コールバック（issue #354）。`simulateDisconnect()`から呼ぶためだけに持つ。 */
    private readonly onDisconnect: () => void = () => undefined,
  ) {}

  ensureStarted(): Promise<void> {
    return Promise.resolve();
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId;
    this.nextId += 1;
    this.requests.push({ id, method, params });
    return new Promise<JsonRpcMessage>((resolve) => {
      this.waiting.set(id, resolve);
    });
  }

  dispose(): void {
    this.waiting.clear();
  }

  /** 指定した要求idへ応答する。 */
  resolve(id: number, result: unknown): void {
    const resolver = this.waiting.get(id);
    if (resolver === undefined) {
      throw new Error(`保留中の要求がありません: id=${id}`);
    }
    this.waiting.delete(id);
    resolver({ id, result });
  }

  /** methodに一致する、まだ応答していない最初の要求へ応答する。呼び出し順を気にせず書けるようにする。 */
  resolveFirst(method: string, result: unknown): number {
    const entry = this.requests.find((r) => r.method === method && this.waiting.has(r.id));
    if (entry === undefined) {
      throw new Error(`保留中の ${method} 要求がありません`);
    }
    this.resolve(entry.id, result);
    return entry.id;
  }

  /** app-server発の通知を模す。 */
  notify(method: string, params: Record<string, unknown>): void {
    this.onNotification(method, params);
  }

  /** app-server発の要求（承認等）を模す。応答が解決するまで待つ。 */
  serverRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.onServerRequest({ id, method, params });
  }

  /**
   * app-serverのクラッシュ等による接続断を模す（issue #354）。
   * 実物の`AppServerConnection.reset()`が`onDisconnect`を呼ぶのと同じ経路。
   */
  simulateDisconnect(): void {
    this.onDisconnect();
  }
}

/** `ChatViewManager` のコンストラクタへ渡す `connectionFactory`。生成した接続を外へ持ち出す。 */
export function fakeConnectionFactory(): {
  factory: (
    onNotification: NotificationHandler,
    onServerRequest: ServerRequestHandler,
    onDisconnect?: () => void,
  ) => FakeAppServerConnection;
  connection: () => FakeAppServerConnection;
} {
  let created: FakeAppServerConnection | undefined;
  return {
    factory: (onNotification, onServerRequest, onDisconnect) => {
      created = new FakeAppServerConnection(onNotification, onServerRequest, onDisconnect);
      return created;
    },
    connection: () => {
      if (created === undefined) {
        throw new Error('connectionFactoryがまだ呼ばれていません');
      }
      return created;
    },
  };
}
