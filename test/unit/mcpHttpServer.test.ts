import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startHttpMcpServer,
  type HttpMcpServerHandle,
  type McpHttpTarget,
} from '../../src/orchestrator/mcpHttpServer';

/**
 * `id`の無いリクエストの扱い（Issue #1903・#1905）と、トークンがサーバ（ポート）に
 * 紐づくこと。
 */

const TOKEN = '0123456789abcdef0123456789abcdef';

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('startHttpMcpServer', () => {
  const servers: HttpMcpServerHandle[] = [];
  const start = async (
    resolve: (token: string) => McpHttpTarget | undefined,
  ): Promise<HttpMcpServerHandle> => {
    const server = await startHttpMcpServer(resolve);
    servers.push(server);
    return server;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('idの無いnotifications/は本文なしの202で、MCPサーバへは渡さない', async () => {
    const handle = vi.fn();
    const server = await start((token) =>
      token === TOKEN ? { connectionId: 'c1', handle } : undefined,
    );

    const response = await post(server.urlForToken(TOKEN), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(handle).not.toHaveBeenCalled();
  });

  it('idの無い通知以外のリクエストは-32600で断り、MCPサーバへは渡さない', async () => {
    const handle = vi.fn();
    const server = await start((token) =>
      token === TOKEN ? { connectionId: 'c1', handle } : undefined,
    );

    const response = await post(server.urlForToken(TOKEN), {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'x', arguments: {} },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: unknown; error: { code: number } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(handle).not.toHaveBeenCalled();
  });

  it('methodが文字列でないidなしリクエストも通知として扱わず-32600で断る', async () => {
    const handle = vi.fn();
    const server = await start(() => ({ connectionId: 'c1', handle }));

    const response = await post(server.urlForToken(TOKEN), { jsonrpc: '2.0', method: 1 });

    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
    expect(handle).not.toHaveBeenCalled();
  });

  it('URLのポートはサーバごとに別で、別サーバのトークンは受け付けない', async () => {
    const a = await start((token) =>
      token === TOKEN ? { connectionId: 'a', handle: vi.fn() } : undefined,
    );
    const b = await start(() => undefined);

    expect(new URL(a.urlForToken(TOKEN)).port).toBe(new URL(a.baseUrl).port);
    expect(new URL(a.baseUrl).port).not.toBe(new URL(b.baseUrl).port);

    // Aで有効なトークンでも、ポートの違うBへ送れば404
    const mismatched = await post(b.urlForToken(TOKEN), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(mismatched.status).toBe(404);

    const matched = await post(a.urlForToken(TOKEN), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(matched.status).toBe(202);
  });
});
