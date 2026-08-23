import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `start()` は実プロセスを起動するため、`spawnProcess`（Issue #186の差し替え口）を
 * フェイクへ差し替えて実行する。`claudeStreamSessionRewind.test.ts`（`proc`を直接
 * 差し込む方式）と違い、こちらは`start()`自体を実際に呼んで`target.kind`による
 * ガード（`isForkSession`）を経由させる必要があるため、`spawnProcess`を差し替える。
 */
function startSession(targetKind: 'fork' | 'resume' | 'new'): {
  session: ClaudeStreamSession;
  written: string[];
} {
  const written: string[] = [];
  const noop = (): void => undefined;
  const fakeProc = {
    killed: false,
    stdin: {
      write: (line: string) => {
        written.push(line);
        return true;
      },
      destroyed: false,
      writable: true,
      on: noop,
    },
    stdout: { on: noop },
    stderr: { on: noop },
    on: noop,
  } as unknown as ChildProcessWithoutNullStreams;

  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    undefined,
    undefined,
    undefined,
    () => fakeProc,
  );

  const target =
    targetKind === 'fork'
      ? ({ kind: 'fork', sessionId: '11111111-1111-1111-1111-111111111111' } as const)
      : targetKind === 'resume'
        ? ({ kind: 'resume', sessionId: '11111111-1111-1111-1111-111111111111' } as const)
        : ({ kind: 'new' } as const);

  session.start({
    cwd: '/w',
    target,
    sessionId: targetKind === 'new' ? '22222222-2222-2222-2222-222222222222' : undefined,
    config: {
      model: '',
      effort: '',
      permissionMode: '',
      agent: '',
      additionalArgs: [],
    },
  });
  // handshake（initialize）の書き込みも written に混ざるため、以降のテストは
  // written.length を基準にせず、rewind_conversation の要求だけを絞って見る
  return { session, written };
}

function rewindRequestsWritten(written: string[]): Array<{ request_id: string; request: unknown }> {
  return written
    .map(
      (line) => JSON.parse(line.trim()) as { type: string; request_id: string; request: unknown },
    )
    .filter(
      (event) =>
        event.type === 'control_request' &&
        (event.request as { subtype?: string }).subtype === 'rewind_conversation',
    )
    .map((event) => ({ request_id: event.request_id, request: event.request }));
}

function controlResponseLine(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

describe('ClaudeStreamSession の会話フォーク（rewind_conversation、issue #333、design.md §14.61）', () => {
  it('forkしていないセッション（resume）へは送らない', async () => {
    const { session, written } = startSession('resume');

    const result = await session.rewindConversationToTurn(['u1', 'u2'], 'u1');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/fork/);
    // streamSession.ts自身のガードが返す非CLI由来のエラー（issue #340横断レビュー指摘）
    expect(result.error?.origin).toBe('app');
    expect(rewindRequestsWritten(written)).toEqual([]);
  });

  it('新規セッション（fork指定なし）へも送らない', async () => {
    const { session, written } = startSession('new');

    const result = await session.rewindConversationToTurn(['u1'], 'u1');

    expect(result.ok).toBe(false);
    expect(rewindRequestsWritten(written)).toEqual([]);
  });

  it('forkしたセッションへは interrupt_if_running:true を付けて送る', () => {
    const { session, written } = startSession('fork');

    void session.rewindConversationToTurn(['u1', 'u2'], 'u1');

    const requests = rewindRequestsWritten(written);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request).toEqual({
      subtype: 'rewind_conversation',
      target_message_uuid: 'u2',
      interrupt_if_running: true,
    });
  });

  it('逐次送信: 前の応答が届くまで次を送らない', async () => {
    const { session, written } = startSession('fork');

    void session.rewindConversationToTurn(['u1', 'u2', 'u3'], 'u1');

    // 最初はu3（最新）だけを送り、u2・u1の要求はまだ書き込まれない
    expect(rewindRequestsWritten(written)).toHaveLength(1);
    expect(rewindRequestsWritten(written)[0]!.request).toMatchObject({
      target_message_uuid: 'u3',
    });

    const firstId = rewindRequestsWritten(written)[0]!.request_id;
    session.receive(
      controlResponseLine(firstId, {
        rewound: true,
        targetMessageUuid: 'u3',
        prefillText: null,
        precedingAssistantUuid: 'a-1',
      }),
    );
    // forkFromTurn（forkFromTurn.ts）は応答をawaitしてから次を送るため、次の書き込みは
    // マイクロタスクを1つ挟んだ後に起きる。receive()の戻り値を待つだけでは足りない
    await Promise.resolve();
    await Promise.resolve();

    // 応答が届いて初めてu2の要求が書き込まれる
    expect(rewindRequestsWritten(written)).toHaveLength(2);
    expect(rewindRequestsWritten(written)[1]!.request).toMatchObject({
      target_message_uuid: 'u2',
    });
  });

  it('途中で rewound:false が返ったら打ち切り、エラーが result.error に伝わる', async () => {
    const { session, written } = startSession('fork');

    const promise = session.rewindConversationToTurn(['u1', 'u2', 'u3'], 'u1');
    const firstId = rewindRequestsWritten(written)[0]!.request_id;

    session.receive(
      controlResponseLine(firstId, {
        rewound: false,
        targetMessageUuid: null,
        prefillText: null,
        precedingAssistantUuid: null,
        error: 'stale target',
      }),
    );

    await expect(promise).resolves.toEqual({
      ok: false,
      prefillText: undefined,
      error: { message: 'stale target', origin: 'cli' },
      // 最初（u3）で失敗したため1件も成功していない
      succeededCount: 0,
    });
    // u2・u1への要求は送られない（打ち切り）
    expect(rewindRequestsWritten(written)).toHaveLength(1);
  });

  it('最後（対象自身）まで戻し切ると prefillText を返す', async () => {
    const { session, written } = startSession('fork');

    const promise = session.rewindConversationToTurn(['u1', 'u2'], 'u1');
    const firstId = rewindRequestsWritten(written)[0]!.request_id;
    session.receive(
      controlResponseLine(firstId, {
        rewound: true,
        targetMessageUuid: 'u2',
        prefillText: null,
        precedingAssistantUuid: 'a-1',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const secondId = rewindRequestsWritten(written)[1]!.request_id;
    session.receive(
      controlResponseLine(secondId, {
        rewound: true,
        targetMessageUuid: 'u1',
        prefillText: '最初の発言',
        precedingAssistantUuid: undefined,
      }),
    );

    await expect(promise).resolves.toEqual({
      ok: true,
      prefillText: '最初の発言',
      error: undefined,
      succeededCount: 2,
    });
  });

  it('ok だけで成功判定していない（失敗封筒でも subtype:success で届く実測どおり）', async () => {
    const { session, written } = startSession('fork');

    const promise = session.rewindConversationToTurn(['u1'], 'u1');
    const requestId = rewindRequestsWritten(written)[0]!.request_id;

    // control_response自体のsubtypeは"success"（=ControlResponse.ok:trueになる）が、
    // payloadのrewoundがfalseの失敗応答（実測どおり）
    session.receive(
      controlResponseLine(requestId, {
        rewound: false,
        targetMessageUuid: null,
        prefillText: null,
        precedingAssistantUuid: null,
        error: 'no preceding assistant',
      }),
    );

    await expect(promise).resolves.toEqual({
      ok: false,
      prefillText: undefined,
      error: { message: 'no preceding assistant', origin: 'cli' },
      succeededCount: 0,
    });
  });

  it('プロセスが終了すると応答待ちが解放される（issue #355と同じ流儀）', async () => {
    const { session, written } = startSession('fork');
    const promise = session.rewindConversationToTurn(['u1', 'u2'], 'u1');
    expect(rewindRequestsWritten(written)).toHaveLength(1);

    (session as unknown as { proc: unknown }).proc = undefined;
    (session as unknown as { releasePendingWaiters: () => void }).releasePendingWaiters();

    await expect(promise).resolves.toMatchObject({ ok: false });
  });
});
