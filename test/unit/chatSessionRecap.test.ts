import { describe, expect, it } from 'vitest';
import { ChatSession, RECAP_INSTRUCTION } from '../../src/appserver/chatSession';
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

/** `chatReview.test.ts` と同じ方針の最小フェイク。要求だけを記録する。 */
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

describe('ChatSession.recap（issue #228、design.md §14.41）', () => {
  it('会話が空のときはturn/startを送らず、一言だけ会話に残す', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    sent.length = 0; // thread/startの記録を落とし、以降のrecap()呼び出しだけを見る

    await session.recap(emptyConfig);

    expect(sent).toEqual([]);
    const state = session.getState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'settingsChanged',
      detail: 'まだ要約できる会話がありません。まず何か送ってから試してください',
    });
  });

  it('会話があるときはRECAP_INSTRUCTIONを通常のターンとして送る', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    // 会話が1件以上ある状態を作る（item/startedはapp-server発の通知を模す経路）
    session.applyNotification('item/started', {
      threadId: 'th-1',
      item: {
        type: 'userMessage',
        id: 'u1',
        content: [{ type: 'text', text: 'こんにちは' }],
      },
    });
    sent.length = 0;

    await session.recap(emptyConfig);

    const call = sent.find((s) => s.method === 'turn/start');
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      threadId: 'th-1',
      input: [{ type: 'text', text: RECAP_INSTRUCTION }],
    });
    // 会話が空のときに残す通知（settingsChanged）は増えていない
    expect(session.getState().items.some((i) => i.kind === 'settingsChanged')).toBe(false);
  });

  it('スレッド未開始では投げ、何も送らない', async () => {
    const { session, sent } = fakeSession();
    await expect(session.recap(emptyConfig)).rejects.toThrow(/スレッドが開始されていません/u);
    expect(sent).toEqual([]);
  });
});
