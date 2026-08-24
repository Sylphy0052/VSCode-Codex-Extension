import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
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

interface Fake {
  session: ChatSession;
  sent: Sent[];
}

/** `chatSessionInterrupt.test.ts` と同じ方針の最小フェイク。要求だけを記録する。 */
function fakeSession(): Fake {
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

/** ターンが動いている状態を作る。 */
async function runningTurn(): Promise<Fake> {
  const fake = fakeSession();
  await fake.session.start('/w', emptyConfig);
  fake.session.applyNotification('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } });
  fake.sent.length = 0; // thread/startの記録を落とし、以降のsendOrQueue()だけを見る
  return fake;
}

describe('ChatSession.sendOrQueue（キューを既定にし、割込は明示操作に限る）', () => {
  it('応答していなければ普通に送る', async () => {
    const fake = fakeSession();
    await fake.session.start('/w', emptyConfig);
    fake.sent.length = 0;

    const result = await fake.session.sendOrQueue('1から100まで', emptyConfig);

    expect(result).toBe('sent');
    expect(fake.sent).toEqual([{ method: 'turn/start', params: expect.anything() }]);
  });

  it('応答中はターンidが判っていても割り込まず待ち行列へ積む', async () => {
    const fake = await runningTurn();

    const result = await fake.session.sendOrQueue('次はこれ', emptyConfig);

    expect(result).toBe('queued');
    expect(fake.sent).toEqual([]);
    expect(fake.session.getState().queued.map((q) => q.text)).toEqual(['次はこれ']);
  });

  it('応答中に複数回送るとFIFOで積み上がる', async () => {
    const fake = await runningTurn();

    await fake.session.sendOrQueue('1つめ', emptyConfig);
    await fake.session.sendOrQueue('2つめ', emptyConfig);

    expect(fake.sent).toEqual([]);
    expect(fake.session.getState().queued.map((q) => q.text)).toEqual(['1つめ', '2つめ']);
  });
});
