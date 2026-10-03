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
function fakeSession(options: { rejectTurnStart?: boolean } = {}): Fake {
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
      if (method === 'turn/start' && options.rejectTurnStart === true) {
        throw new Error('turn/start failed');
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

describe('ChatSession.send（turn/startの失敗でbusyを戻す、issue #1873）', () => {
  it('turn/startがrejectされたら、busyを戻して例外をそのまま投げる', async () => {
    const fake = fakeSession({ rejectTurnStart: true });
    await fake.session.start('/w', emptyConfig);

    await expect(fake.session.send('続けて', emptyConfig)).rejects.toThrow('turn/start failed');

    expect(fake.session.getState().busy).toBe(false);
  });

  it('busyが戻るので、次のsendOrQueueは待ち行列へ積まず送る', async () => {
    const fake = fakeSession({ rejectTurnStart: true });
    await fake.session.start('/w', emptyConfig);
    await expect(fake.session.send('1回目', emptyConfig)).rejects.toThrow();
    fake.sent.length = 0;

    await expect(fake.session.sendOrQueue('2回目', emptyConfig)).rejects.toThrow();

    expect(fake.sent.map((s) => s.method)).toEqual(['turn/start']);
    expect(fake.session.getState().queued).toEqual([]);
  });
});

describe('ChatSession.popLastQueuedForInput（Escでの書き戻し、issue #677レビュー指摘）', () => {
  it('末尾を取り出し、待ち行列から取り除く', async () => {
    const fake = await runningTurn();
    await fake.session.sendOrQueue('1つめ', emptyConfig);
    await fake.session.sendOrQueue('2つめ', emptyConfig);

    const popped = fake.session.popLastQueuedForInput();

    expect(popped?.text).toBe('2つめ');
    expect(fake.session.getState().queued.map((q) => q.text)).toEqual(['1つめ']);
  });

  it('空なら取り出さない', async () => {
    const fake = await runningTurn();

    expect(fake.session.popLastQueuedForInput()).toBeUndefined();
  });

  it('添付があると入力欄へ戻せず黙って消えるため、取り出さない', async () => {
    const fake = await runningTurn();
    const image = { id: 'a1', name: 'shot.png', mediaType: 'image/png', data: 'QUJD', bytes: 3 };
    await fake.session.sendOrQueue('画像付き', emptyConfig, [image]);

    const popped = fake.session.popLastQueuedForInput();

    expect(popped).toBeUndefined();
    expect(fake.session.getState().queued.map((q) => q.text)).toEqual(['画像付き']);
  });

  it('拡張側の最新stateから直接取り出すため、自動デキュー直後でも別の指示を取り消さない', async () => {
    // ターン完了によるsendNextQueuedの自動デキューと、Escによる書き戻しが競合しても、
    // UI側の古いスナップショットではなく拡張側の現在のqueuedを見るためズレない
    const fake = await runningTurn();
    await fake.session.sendOrQueue('1つめ', emptyConfig);
    await fake.session.sendOrQueue('2つめ', emptyConfig);

    // ターン完了相当。先頭を自動的に取り出して送る
    await fake.session.sendNextQueued(emptyConfig);
    expect(fake.session.getState().queued.map((q) => q.text)).toEqual(['2つめ']);

    const popped = fake.session.popLastQueuedForInput();

    expect(popped?.text).toBe('2つめ');
    expect(fake.session.getState().queued).toEqual([]);
  });
});
