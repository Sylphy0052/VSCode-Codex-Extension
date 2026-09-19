import { afterEach, describe, expect, it } from 'vitest';

import type { SessionBridgePort, SessionSummary } from '../../src/orchestrator/sessionBridge';
import {
  startSessionMessagingHost,
  type SessionMessagingHost,
} from '../../src/orchestrator/sessionMessagingHost';

/**
 * 通常のチャットセッション向けメッセージング用MCPサーバ（Issue #1305）。
 *
 * 確かめるのは「宛先が束縛されるまで・失効した後は誰も名乗れない」ことと、
 * 「runを前提にした道具が通常の会話へ漏れない」ことの2点。どちらも実体（`extension.ts`）を
 * 通さずHTTPの口から直接叩いて見る。
 */

const WINDOW_ID = '11111111-2222-3333-4444-555555555555';

function fakeBridge(): SessionBridgePort & { sent: { to: string; body: string }[] } {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    listSessions: (): readonly SessionSummary[] => [],
    send: async (target, body) => {
      sent.push({ to: target.threadId, body });
      return { ok: true };
    },
    ask: async () => ({ ok: true, questionId: 'q1' }),
    askResult: async () => ({ ok: true, status: 'done' as const, answer: 'a' }),
  };
}

function toolCall(url: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

function toolsList(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('startSessionMessagingHost（Issue #1305）', () => {
  let host: SessionMessagingHost | undefined;

  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  it('bindするまでは404、bindすると宛先refを送信元として通り、disposeすると再び404になる', async () => {
    const bridge = fakeBridge();
    host = await startSessionMessagingHost({ windowId: WINDOW_ID, sessionBridge: () => bridge });
    const registration = host.register('codex');

    // スレッドidが確定する前は、URLを知っていても一切受け付けない
    const beforeBind = await toolsList(registration.url);
    expect(beforeBind.status).toBe(404);

    registration.bind('thread-1');
    const afterBind = await toolCall(registration.url, 'send_message', {
      to: `session:claude:${WINDOW_ID}:thread-2`,
      body: 'hello',
      expectReply: false,
    });
    expect(afterBind.status).toBe(200);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]?.to).toBe('thread-2');
    // 送信元の名乗りはURLのトークンから解決した宛先refに固定される（引数では名乗れない）
    expect(bridge.sent[0]?.body).toContain(`session:codex:${WINDOW_ID}:thread-1`);

    registration.dispose();
    const afterDispose = await toolsList(registration.url);
    expect(afterDispose.status).toBe(404);
    // 二度disposeしても壊れない（タブを閉じたときと明示的な解放が重なりうる）
    expect(() => registration.dispose()).not.toThrow();
  });

  it('runを前提にした道具は見えず、名前を推測して呼んでも拒否される', async () => {
    const bridge = fakeBridge();
    host = await startSessionMessagingHost({ windowId: WINDOW_ID, sessionBridge: () => bridge });
    const registration = host.register('claude');
    registration.bind('thread-1');

    const listed = await toolsList(registration.url);
    const body = (await listed.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['ask_session', 'ask_session_result', 'list_sessions', 'send_message']);

    const listTasks = await toolCall(registration.url, 'list_tasks', {});
    const rejected = (await listTasks.json()) as { error?: { code: number } };
    expect(rejected.error?.code).toBe(-32602);

    const askOrchestrator = await toolCall(registration.url, 'ask_orchestrator', {
      question: 'これは通るべきではない',
      blocking: false,
    });
    const rejectedAsk = (await askOrchestrator.json()) as { error?: { code: number } };
    expect(rejectedAsk.error?.code).toBe(-32602);
  });
});
