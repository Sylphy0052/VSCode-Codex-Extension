import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { INTERRUPTED_COMMANDS_NOTICE_ID } from '../../src/appserver/chatState';
import type { AppServerConnection } from '../../src/appserver/connection';
import { emptyConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

const START_RESULT = {
  thread: { id: 'th-1' },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

/** `chatSessionRecap.test.ts` と同じ方針の最小フェイク。要求だけを記録する。 */
function fakeSession(): { session: ChatSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request(method: string, params: unknown) {
      sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === 'thread/start') {
        return { result: START_RESULT };
      }
      return { result: {} };
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return { session: new ChatSession(connection, log, () => undefined), sent };
}

/** ターンが動いていて、コマンドが1件実行中の状態を作る。 */
async function runningCommand(): Promise<{ session: ChatSession; sent: Sent[] }> {
  const { session, sent } = fakeSession();
  await session.start('/w', emptyConfig);
  session.applyNotification('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } });
  session.applyNotification('item/started', {
    threadId: 'th-1',
    turnId: 'turn-1',
    item: { id: 'cmd_1', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' },
  });
  sent.length = 0; // thread/startの記録を落とし、以降のinterrupt()だけを見る
  return { session, sent };
}

describe('ChatSession.interrupt（issue #246、design.md §9.6）', () => {
  it('turn/interruptを送り、実行中のコマンドへ印と注記を残す', async () => {
    const { session, sent } = await runningCommand();

    await session.interrupt();

    expect(sent).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'th-1', turnId: 'turn-1' } },
    ]);
    const state = session.getState();
    expect(state.busy).toBe(false);
    expect(state.turnId).toBeUndefined();
    expect(state.items.find((i) => i.id === 'cmd_1')?.interruptedWhileRunning).toBe(true);
    expect(state.items.find((i) => i.id === INTERRUPTED_COMMANDS_NOTICE_ID)?.detail).toContain(
      '走り続けることがあります',
    );
  });

  it('中断した後もCLIから届く出力で印は消えない', async () => {
    const { session } = await runningCommand();
    await session.interrupt();

    // 中断してもコマンドの子プロセスは残るため、出力と更新は届き続ける
    session.applyNotification('item/commandExecution/outputDelta', {
      itemId: 'cmd_1',
      delta: 'まだ出力が続いている',
    });
    session.applyNotification('item/updated', {
      threadId: 'th-1',
      turnId: 'turn-1',
      item: { id: 'cmd_1', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' },
    });

    expect(session.getState().items.find((i) => i.id === 'cmd_1')?.interruptedWhileRunning).toBe(
      true,
    );
  });

  it('進行中のターンが無ければ何も送らず、注記も残さない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    sent.length = 0;

    await session.interrupt();

    expect(sent).toEqual([]);
    expect(session.getState().items.some((i) => i.id === INTERRUPTED_COMMANDS_NOTICE_ID)).toBe(
      false,
    );
  });
});
