/* eslint-disable no-console -- 測定結果を出すのがこのファイルの目的 */
/**
 * `tools/list` が返すJSONの規模を測る（Issue #1324 受入基準3）。
 *
 * 実行: `npx tsx test/bench/messagingToolsSize.ts`
 *
 * 接続の種別ごとに `MessagingMcpServer` を1つ立て、`tools/list` の応答をそのまま
 * `JSON.stringify` して文字数を数える。ツール定義の合計ではなく実際に返るJSONを測るのは、
 * 削減の効果をCLIが受け取る形のまま比べるため。VSCode APIは使わないので、拡張機能を
 * 起動せずに単体で動く。
 */
import { ORCHESTRATOR_CONNECTION_ID } from '../../src/orchestrator/orchestratorSession';
import type { SessionBridgePort } from '../../src/orchestrator/sessionBridge';
import {
  MessagingMcpServer,
  TaskMessagingHub,
  type HandoffPort,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpConnection,
  type McpTransportPort,
  type OrchestratorControlPort,
} from '../../src/orchestrator/messaging';

class BenchConnection implements McpConnection {
  readonly sent: JsonRpcResponse[] = [];
  private handler: ((request: JsonRpcRequest) => void) | undefined;

  constructor(readonly taskId: string) {}

  send(response: JsonRpcResponse): void {
    this.sent.push(response);
  }
  onRequest(handler: (request: JsonRpcRequest) => void): void {
    this.handler = handler;
  }
  onClose(): void {
    // このベンチでは使わない
  }
  fireRequest(request: JsonRpcRequest): void {
    this.handler?.(request);
  }
}

class BenchTransport implements McpTransportPort {
  private handler: ((connection: McpConnection) => void) | undefined;

  onConnection(handler: (connection: McpConnection) => void): void {
    this.handler = handler;
  }
  connect(connection: BenchConnection): void {
    this.handler?.(connection);
  }
}

/** 公開されうるものをすべて公開する配線（最大の件数を測るため）。 */
const handoff: HandoffPort = {
  write: async () => ({ ok: true, value: { taskId: 'T1', slug: 's', relativePath: 'p' } }),
  read: async () => ({ ok: true, value: '' }),
  list: async () => ({ ok: true, value: [] }),
};

const sessionBridge = {
  listSessions: () => [],
  send: async () => ({ ok: true }),
  ask: async () => ({ ok: true, questionId: 'q-1' }),
  askResult: async () => ({ ok: true, status: 'done', answer: '' }),
} as unknown as SessionBridgePort;

const accepted = { accepted: true, reason: '' };
const control = {
  getRunStatus: () => ({}),
  stopTask: () => accepted,
  retryTask: () => accepted,
  continueTask: () => accepted,
  decideApproval: () => accepted,
  updateTaskPrompt: () => accepted,
  updateTask: () => accepted,
  askUser: () => accepted,
  decideFinalMerge: () => accepted,
  addTask: () => accepted,
  removeTask: () => accepted,
  updateTaskDependencies: () => accepted,
  createIssue: async () => accepted,
  updateIssue: async () => accepted,
  updateRoadmapIssue: async () => accepted,
} as unknown as OrchestratorControlPort;

function listTools(taskId: string): { names: string[]; chars: number } {
  const transport = new BenchTransport();
  const hub = new TaskMessagingHub({
    listRunTasks: () => [],
    handoff,
    sessionBridge: () => sessionBridge,
    orchestratorControl: control,
  });
  new MessagingMcpServer(hub, transport);
  const connection = new BenchConnection(taskId);
  transport.connect(connection);
  connection.fireRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = connection.sent[0];
  if (response === undefined || !('result' in response)) {
    throw new Error('tools/list が応答しませんでした');
  }
  const result = response.result as { tools: { name: string }[] };
  return { names: result.tools.map((t) => t.name), chars: JSON.stringify(result).length };
}

for (const [label, taskId] of [
  ['タスク接続', 'T1'],
  ['オーケストレーター接続', ORCHESTRATOR_CONNECTION_ID],
] as const) {
  const { names, chars } = listTools(taskId);
  console.log(`${label}: ${names.length}ツール / ${chars}字`);
  console.log(`  ${names.join(', ')}`);
}
