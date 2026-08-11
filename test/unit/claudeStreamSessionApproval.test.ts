import { describe, expect, it, vi } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { ChatState } from '../../src/appserver/chatState';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `start()` を呼ばず（実プロセスを起動せず）に `receive()` へ直接control_requestを
 * 流し込む。承認の分岐は`this.proc`に依存しないため、これでハンドラの差し込みだけを
 * 検証できる（design.md §16.10の6）。
 */
function createSession(interceptApproval: ConstructorParameters<typeof ClaudeStreamSession>[5]): {
  session: ClaudeStreamSession;
  states: ChatState[];
} {
  const states: ChatState[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    (state) => states.push(state),
    () => undefined,
    () => undefined,
    interceptApproval,
  );
  return { session, states };
}

function canUseToolLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
  })}\n`;
}

describe('ClaudeStreamSession の承認ハンドラ差し込み（design.md §16.10の6）', () => {
  it('ハンドラが未設定なら従来通り必ず承認カードを出す', async () => {
    const { session, states } = createSession(undefined);

    session.receive(canUseToolLine('r1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const last = states[states.length - 1];
    expect(last?.approvals).toHaveLength(1);
  });

  it('ハンドラがautoを返せば承認カードを出さずに応答する', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'auto', decision: 'accept' });
    const { session, states } = createSession(handler);

    session.receive(canUseToolLine('r1'));
    // ハンドラの解決を待つ（Promiseチェーンなのでマイクロタスクを挟む）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    const last = states[states.length - 1];
    // 承認カードは一度も積まれない（stateの変化そのものが起きない）
    expect(last).toBeUndefined();
  });

  it('ハンドラがaskを返せば従来どおり承認カードを出して人を待つ', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'ask' });
    const { session, states } = createSession(handler);

    session.receive(canUseToolLine('r1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    const last = states[states.length - 1];
    expect(last?.approvals).toHaveLength(1);
  });

  it('askで承認カードが出たあとも、decide()で通常通り解決できる', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'ask' });
    const { session, states } = createSession(handler);

    session.receive(canUseToolLine('r1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(states[states.length - 1]?.approvals).toHaveLength(1);

    session.decide('r1', 'accept');

    const last = states[states.length - 1];
    expect(last?.approvals).toHaveLength(0);
  });
});
