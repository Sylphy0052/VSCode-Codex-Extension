import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

interface FakeProc {
  killed: boolean;
  stdin: { write: (line: string) => void; destroyed: boolean; writable: boolean };
}

/**
 * `start()` は実プロセスを起動するため、ここでは `proc` に書き込みを記録するだけの
 * フェイクを直接差し込む（`claudeStreamSessionRewind.test.ts` と同じ方針）。
 *
 * `killed` / `stdin.destroyed` / `stdin.writable` は`write()`が書き込み前に見る生存判定
 * （issue #155、`src/process/stdinSafety.ts`）が通るよう「生きているプロセス」を模す。
 */
function createSessionWithFakeProc(): {
  session: ClaudeStreamSession;
  written: string[];
} {
  const written: string[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
  );
  const fakeProc: FakeProc = {
    killed: false,
    stdin: { write: (line) => written.push(line), destroyed: false, writable: true },
  };
  (session as unknown as { proc: FakeProc }).proc = fakeProc;
  return { session, written };
}

function controlResponseLine(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

function controlErrorLine(requestId: string, error: string): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  })}\n`;
}

describe('ClaudeStreamSession.checkMcpStatus（design.md §16.21「ツールの可視性の確認」）', () => {
  it('mcp_statusのcontrol_requestを書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    void session.checkMcpStatus();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'mcp_status' },
    });
  });

  it('応答が届くとMCPサーバー一覧で解決する', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.checkMcpStatus();
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(
      controlResponseLine(requestId, {
        mcpServers: [
          {
            name: 'task-messaging',
            status: 'connected',
            serverInfo: { name: 'vscode-codex-extension-messaging', version: '1' },
            tools: [{ name: 'list_tasks' }, { name: 'send_message' }],
          },
        ],
      }),
    );

    const servers = await promise;
    expect(servers).toEqual([
      { name: 'task-messaging', state: 'connected', toolCount: 2, version: '1', reason: undefined },
    ]);
  });

  it('応答がエラーならundefinedで解決する', async () => {
    const { session, written } = createSessionWithFakeProc();
    const promise = session.checkMcpStatus();
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(controlErrorLine(requestId, 'Unsupported control request subtype'));

    await expect(promise).resolves.toBeUndefined();
  });

  it('プロセスが無ければ何も書き込まず、undefinedで即解決する', async () => {
    const session = new ClaudeStreamSession(
      () => 'claude',
      fakeLogger,
      () => undefined,
    );
    await expect(session.checkMcpStatus()).resolves.toBeUndefined();
  });

  it('dispose()すると応答待ちのcheckMcpStatusもundefinedで解放される（放置して待たせ続けない）', async () => {
    const { session } = createSessionWithFakeProc();
    // dispose()はprocのstdin.end()/kill()も呼ぶため、フェイクにも用意しておく
    (
      session as unknown as { proc: FakeProc & { stdin: { end: () => void }; kill: () => void } }
    ).proc.stdin.end = () => undefined;
    (session as unknown as { proc: { kill: () => void } }).proc.kill = () => undefined;

    const promise = session.checkMcpStatus();
    session.dispose();
    await expect(promise).resolves.toBeUndefined();
  });
});
