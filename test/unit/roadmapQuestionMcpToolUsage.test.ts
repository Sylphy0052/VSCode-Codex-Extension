import { describe, expect, it } from 'vitest';

import type { McpHttpTarget } from '../../src/orchestrator/mcpHttpServer';
import type { JsonRpcResponse, McpToolDefinition } from '../../src/orchestrator/messaging';
import {
  RoadmapQuestionMcpServer,
  type RoadmapQuestionMcpDeps,
} from '../../src/orchestrator/roadmapQuestionMcp';

/**
 * オーケストレータモードの接続のツール利用の計測（Issue #2188）。
 * HTTP層はフェイクへ差し替え、トークンから引いた接続先へJSON-RPCを直接流す。
 */

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const TOOLS: McpToolDefinition[] = [
  { name: 'get_run_state', description: 'a', inputSchema: SCHEMA },
  { name: 'start_task', description: 'b', inputSchema: SCHEMA },
];

function createServer(metrics?: RoadmapQuestionMcpDeps['toolUsageMetrics']) {
  let resolveToken: ((token: string) => McpHttpTarget | undefined) | undefined;
  const warnings: string[] = [];
  const deps: RoadmapQuestionMcpDeps = {
    startServer: (resolve) => {
      resolveToken = resolve;
      return Promise.resolve({
        baseUrl: 'http://127.0.0.1:1',
        urlForToken: (token) => `http://127.0.0.1:1/${token}`,
        close: () => Promise.resolve(),
      });
    },
    logWarn: (message) => {
      warnings.push(message);
    },
  };
  if (metrics !== undefined) {
    deps.toolUsageMetrics = metrics;
  }
  const server = new RoadmapQuestionMcpServer(deps);
  const rpc = async (token: string, method: string, params: unknown): Promise<JsonRpcResponse> => {
    const target = resolveToken?.(token);
    if (target === undefined) {
      throw new Error('トークンが未登録');
    }
    return new Promise((resolve) => {
      let handler: ((request: unknown) => void) | undefined;
      target.handle({
        taskId: target.connectionId,
        send: resolve,
        onRequest: (h) => {
          handler = h as (request: unknown) => void;
        },
        onClose: () => undefined,
      });
      handler?.({ jsonrpc: '2.0', id: 1, method, params });
    });
  };
  const callTool = (token: string, name: string): Promise<JsonRpcResponse> =>
    rpc(token, 'tools/call', { name, arguments: {} });
  return { server, rpc, callTool, warnings };
}

function createMetrics(initial = true) {
  const lines: string[] = [];
  const state = { enabled: initial };
  return {
    lines,
    state,
    port: { enabled: () => state.enabled, log: (line: string) => lines.push(line) },
  };
}

const ok = () => Promise.resolve({ text: 'ok', isError: false });

describe('RoadmapQuestionMcpServerのツール利用の計測', () => {
  it('有効なとき、登録の解除で接続の種類が分かる1行を出す', async () => {
    const metrics = createMetrics();
    const { server, callTool } = createServer(metrics.port);
    const { token } = await server.registerTools('-task-run-orchestrator-2', TOOLS, ok, {
      runId: 'run-1',
      connection: 'orchestrator-2',
    });
    await callTool(token, 'get_run_state');
    await callTool(token, 'get_run_state');
    await callTool(token, 'start_task');
    expect(metrics.lines).toEqual([]);
    server.unregister(token);
    expect(metrics.lines).toEqual([
      '[toolUsageMetrics task-run:run-1/orchestrator-2] calls=3 kinds=2 tools=get_run_state:2,start_task:1',
    ]);
    // 2回目の解除では出さない
    server.unregister(token);
    expect(metrics.lines).toHaveLength(1);
  });

  it('工程セッションは工程名とtaskIdを見出しに入れ、登録ごとに別の行を出す', async () => {
    const metrics = createMetrics();
    const { server, callTool } = createServer(metrics.port);
    const a = await server.registerTools('task:run-1#T1:a1', TOOLS, ok, {
      runId: 'run-1',
      connection: 'stage-implement:T1',
    });
    const b = await server.registerTools('task:run-1#T1:a2', TOOLS, ok, {
      runId: 'run-1',
      connection: 'stage-review:T1',
    });
    await callTool(a.token, 'start_task');
    await callTool(b.token, 'get_run_state');
    server.unregister(a.token);
    server.unregister(b.token);
    expect(metrics.lines).toEqual([
      '[toolUsageMetrics task-run:run-1/stage-implement:T1] calls=1 kinds=1 tools=start_task:1',
      '[toolUsageMetrics task-run:run-1/stage-review:T1] calls=1 kinds=1 tools=get_run_state:1',
    ]);
  });

  it('無効なときは数えず、出力の時点で無効なら途中まで数えた分も出さない', async () => {
    const metrics = createMetrics(false);
    const { server, callTool } = createServer(metrics.port);
    const label = { runId: 'run-1', connection: 'orchestrator-1' };
    const first = await server.registerTools('c1', TOOLS, ok, label);
    await callTool(first.token, 'start_task');
    metrics.state.enabled = true;
    server.unregister(first.token);
    expect(metrics.lines).toEqual([]);

    const second = await server.registerTools('c2', TOOLS, ok, label);
    await callTool(second.token, 'start_task');
    metrics.state.enabled = false;
    server.unregister(second.token);
    expect(metrics.lines).toEqual([]);
  });

  it('未知のツール名は数えず、1度も呼ばれなかった登録は行を出さない', async () => {
    const metrics = createMetrics();
    const { server, callTool } = createServer(metrics.port);
    const label = { runId: 'run-1', connection: 'orchestrator-1' };
    const used = await server.registerTools('c1', TOOLS, ok, label);
    const unused = await server.registerTools('c2', TOOLS, ok, label);
    const response = await callTool(used.token, 'no_such_tool');
    expect(response).toMatchObject({ error: { code: -32602 } });
    server.unregister(used.token);
    server.unregister(unused.token);
    expect(metrics.lines).toEqual([]);
  });

  it('disposeでは解除されていない登録の分も出す', async () => {
    const metrics = createMetrics();
    const { server, callTool } = createServer(metrics.port);
    const { token } = await server.registerTools('c1', TOOLS, ok, {
      runId: 'run-1',
      connection: 'stage-issuePlan:T2',
    });
    await callTool(token, 'start_task');
    server.dispose();
    expect(metrics.lines).toEqual([
      '[toolUsageMetrics task-run:run-1/stage-issuePlan:T2] calls=1 kinds=1 tools=start_task:1',
    ]);
  });

  it('ラベルを渡さない登録と、計測の口を渡さないサーバは今までどおり動き、何も出さない', async () => {
    const metrics = createMetrics();
    const withPort = createServer(metrics.port);
    const unlabeled = await withPort.server.registerTools('c1', TOOLS, ok);
    const response = await withPort.callTool(unlabeled.token, 'start_task');
    expect(response).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
    withPort.server.unregister(unlabeled.token);
    expect(metrics.lines).toEqual([]);

    const withoutPort = createServer();
    const labeled = await withoutPort.server.registerTools('c1', TOOLS, ok, {
      runId: 'run-1',
      connection: 'orchestrator-1',
    });
    const second = await withoutPort.callTool(labeled.token, 'start_task');
    expect(second).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
    withoutPort.server.unregister(labeled.token);
  });

  it('計測が投げてもツール呼び出しの結果と登録の解除を止めない', async () => {
    const { server, callTool, warnings } = createServer({
      enabled: () => {
        throw new Error('設定を読めない');
      },
      log: () => {
        throw new Error('書けない');
      },
    });
    const { token } = await server.registerTools('c1', TOOLS, ok, {
      runId: 'run-1',
      connection: 'orchestrator-1',
    });
    const response = await callTool(token, 'start_task');
    expect(response).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(warnings.some((w) => w.includes('ツール利用の計測に失敗'))).toBe(true);
    expect(() => server.unregister(token)).not.toThrow();
  });

  it('出力で投げても登録の解除は済む', async () => {
    const lines: string[] = [];
    let throwOnLog = true;
    const { server, callTool } = createServer({
      enabled: () => true,
      log: (line) => {
        if (throwOnLog) throw new Error('書けない');
        lines.push(line);
      },
    });
    const { token } = await server.registerTools('c1', TOOLS, ok, {
      runId: 'run-1',
      connection: 'orchestrator-1',
    });
    await callTool(token, 'start_task');
    expect(() => server.unregister(token)).not.toThrow();
    throwOnLog = false;
    await expect(callTool(token, 'start_task')).rejects.toThrow('トークンが未登録');
    expect(lines).toEqual([]);
  });

  it('解除した登録はdisposeで二重に出さず、disposeの出力で投げてもサーバは閉じる', async () => {
    const metrics = createMetrics();
    const { server, callTool } = createServer(metrics.port);
    const label = { runId: 'run-1', connection: 'orchestrator-1' };
    const released = await server.registerTools('c1', TOOLS, ok, label);
    await callTool(released.token, 'start_task');
    server.unregister(released.token);
    server.dispose();
    expect(metrics.lines).toEqual([
      '[toolUsageMetrics task-run:run-1/orchestrator-1] calls=1 kinds=1 tools=start_task:1',
    ]);

    const throwing = createServer({
      enabled: () => true,
      log: () => {
        throw new Error('書けない');
      },
    });
    const { token } = await throwing.server.registerTools('c1', TOOLS, ok, label);
    await throwing.callTool(token, 'start_task');
    expect(() => throwing.server.dispose()).not.toThrow();
    await expect(throwing.callTool(token, 'start_task')).rejects.toThrow('トークンが未登録');
  });

  it('計測の有無でtools/listとツール呼び出しの結果は変わらない', async () => {
    const results = [];
    for (const port of [undefined, createMetrics().port]) {
      const { server, rpc } = createServer(port);
      const { token } = await server.registerTools('c1', TOOLS, ok, {
        runId: 'run-1',
        connection: 'orchestrator-1',
      });
      results.push({
        list: await rpc(token, 'tools/list', {}),
        call: await rpc(token, 'tools/call', { name: 'start_task', arguments: {} }),
      });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.list).toMatchObject({
      result: { tools: TOOLS.map((t) => ({ name: t.name })) },
    });
  });
});
