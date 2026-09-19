import { randomBytes } from 'node:crypto';

import { startHttpMcpServer, type HttpMcpServerHandle } from './mcpHttpServer';
import {
  MessagingMcpServer,
  TaskMessagingHub,
  type DispatchErrorLogPort,
  type McpConnection,
  type McpTransportPort,
} from './messaging';
import {
  formatSessionTarget,
  type SessionBridgePort,
  type SessionProvider,
} from './sessionBridge';

/**
 * 通常のチャットセッション向けのメッセージング用MCPサーバ（Issue #1305）。
 *
 * ワークフローのrunは`runner.ts`がrunごとにMCPサーバを立てるが（`startHttpMcpTransport`）、
 * `codex.newChat` / `claude.newChat`で開いた普通の会話にはその口が無く、エージェントは
 * `list_sessions` も `send_message` も呼べなかった。ここはウィンドウにつき1つのHTTPサーバを
 * 立て、セッション1つにつき1つのURLを発行する。
 *
 * **hubはセッションごとに作り、HTTPサーバだけを共有する。** `TaskMessagingHub`は
 * 「セッション宛に送った総数」（`MAX_MESSAGES_PER_RUN`）をインスタンスごとに数える。
 * ウィンドウで1つのhubを共有すると、VS Codeを開いている限りカウンタが累積し、いずれ
 * どのセッションからも送れなくなる。セッション単位で持てば上限もセッション単位で効く。
 *
 * hubへ渡すのは`sessionBridge`だけで、`orchestratorControl`（ワークフローの制御）と
 * `handoff`（ファイル受け渡し）は渡さない。通常の会話にワークフロー由来の権限を与えない。
 */

/** セッション1つ分の登録。CLIへ渡すURLと、宛先が確定したときの束縛口を持つ。 */
export interface SessionMessagingRegistration {
  /** CLIの起動設定へ書き込むMCPサーバのURL。 */
  url: string;
  /**
   * このセッションのスレッドid（Codexは`threadId`、Claude Codeは`sessionId`）が確定した
   * 時点で呼ぶ。これを呼ぶまでURLは404のままで、要求を一切受け付けない。
   *
   * 送信元の名乗り（`from`）はここで組み立てた宛先refに固定され、リクエストの中身からは
   * 一切取らない（`mcpHttpServer.ts`のJSDoc参照）。
   */
  bind(threadId: string): void;
  /** セッションが閉じたときに呼ぶ。トークンを失効させ、以後そのURLは404になる。 */
  dispose(): void;
}

export interface SessionMessagingHost {
  /**
   * セッション1つ分のURLを発行する。`bind`を呼ぶまでは宛先が未確定で、要求は通らない。
   *
   * Codexは`thread/start`の応答でしかスレッドidが判らないため、起動前にここでURLを取り、
   * 起動後に`bind`する。Claude Codeは起動前にセッションidが決まるため、発行直後に
   * `bind`できる。
   */
  register(provider: SessionProvider): SessionMessagingRegistration;
  close(): Promise<void>;
}

export interface SessionMessagingHostDeps {
  /** このウィンドウのid（`SessionHubWriter`が書くファイル名と同じ値）。宛先refの組み立てに使う。 */
  windowId: string;
  /** セッション宛の解決。`extension.ts`が組み立てた実体を毎回読む（値で持たない）。 */
  sessionBridge: () => SessionBridgePort | undefined;
  logPort?: DispatchErrorLogPort;
}

interface SessionEntry {
  provider: SessionProvider;
  /** 宛先ref。`bind`されるまでは`undefined`で、その間この接続は使えない。 */
  ref: string | undefined;
  /** この接続へ1リクエストを渡す。`MessagingMcpServer`が登録したハンドラ。 */
  handler: ((connection: McpConnection) => void) | undefined;
}

export async function startSessionMessagingHost(
  deps: SessionMessagingHostDeps,
): Promise<SessionMessagingHost> {
  const entries = new Map<string, SessionEntry>();

  const server: HttpMcpServerHandle = await startHttpMcpServer((token) => {
    const entry = entries.get(token);
    if (entry?.ref === undefined || entry.handler === undefined) {
      return undefined;
    }
    const handler = entry.handler;
    return { connectionId: entry.ref, handle: (connection) => handler(connection) };
  });

  return {
    register(provider: SessionProvider): SessionMessagingRegistration {
      const token = randomBytes(16).toString('hex');
      const entry: SessionEntry = { provider, ref: undefined, handler: undefined };
      const transport: McpTransportPort = {
        onConnection(handler) {
          entry.handler = handler;
        },
      };
      const hub = new TaskMessagingHub({
        // 通常の会話はワークフローのrunに属さない。run内のタスクは1つも無い
        listRunTasks: () => [],
        sessionBridge: deps.sessionBridge,
        sessionOnly: true,
      });
      const mcpServer = new MessagingMcpServer(hub, transport, deps.logPort);
      void mcpServer; // 生成することで`transport.onConnection`にハンドラを登録させる
      entries.set(token, entry);
      return {
        url: server.urlForToken(token),
        bind(threadId: string): void {
          entry.ref = formatSessionTarget({ windowId: deps.windowId, provider, threadId });
        },
        dispose(): void {
          entries.delete(token);
        },
      };
    },
    async close(): Promise<void> {
      await server.close();
      entries.clear();
    },
  };
}
