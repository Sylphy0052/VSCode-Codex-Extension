import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import type { AppServerConnection } from '../../src/appserver/connection';
import type { Logger } from '../../src/log';

/**
 * `thread/resume` の応答は、ターンIDを**外側**（`thread.turns[].id`）に持ち、項目自身は
 * 持たない（実測: codex-cli 0.154.0、2026-09-13。`turns[0].items[0]` のキーは
 * `{type, id, clientId, content}`）。この形を模した固定値（Issue #1155）。
 *
 * `loadForkedThread` は `thread/resume` と同じ `applyThreadSnapshot` を通るため、
 * 通信を伴わないこちらから取り込み結果を見る。
 */
const RESUME_RESULT = {
  thread: {
    id: 'th-1',
    name: null,
    turns: [
      {
        id: 'turn-1',
        items: [
          { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: '1つ目' }] },
          { type: 'agentMessage', id: 'item-2', text: 'はい', phase: 'final_answer' },
        ],
      },
      {
        id: 'turn-2',
        items: [
          { type: 'userMessage', id: 'item-3', content: [{ type: 'text', text: '2つ目' }] },
          { type: 'agentMessage', id: 'item-4', text: 'どうぞ', phase: 'final_answer' },
        ],
      },
    ],
  },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

function noopSession(): ChatSession {
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request() {
      throw new Error('この経路は呼ばれないはず');
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return new ChatSession(connection, log, () => undefined);
}

function itemsOf(result: unknown): ReturnType<ChatSession['getState']>['items'] {
  const session = noopSession();
  session.loadForkedThread(result);
  return session.getState().items;
}

describe('復元した会話のターンID（Issue #1155）', () => {
  it('外側のturns[].idを各項目のturnIdへ移す', () => {
    const items = itemsOf(RESUME_RESULT);

    expect(items.map((i) => [i.id, i.turnId])).toEqual([
      ['item-1', 'turn-1'],
      ['item-2', 'turn-1'],
      ['item-3', 'turn-2'],
      ['item-4', 'turn-2'],
    ]);
  });

  it('2ターン目以降のユーザー発言は、手前のターンを分岐対象にできる', () => {
    // 画面側（chatScript.ts）は「直前のユーザー発言のturnId」を lastTurnId に使う。
    // turnIdが埋まっていないと分岐ボタンも編集再送の宛先も決められない
    const users = itemsOf(RESUME_RESULT).filter((i) => i.kind === 'userMessage');

    expect(users).toHaveLength(2);
    expect(users[0]?.turnId).toBe('turn-1');
    expect(users[1]?.turnId).toBe('turn-2');
  });

  it('ターンIDが無い・空のターンでは、項目のturnIdはundefinedのままにする', () => {
    const items = itemsOf({
      thread: {
        id: 'th-2',
        turns: [
          { items: [{ type: 'userMessage', id: 'a', content: [{ type: 'text', text: 'x' }] }] },
          { id: '', items: [{ type: 'agentMessage', id: 'b', text: 'y' }] },
          { id: 42, items: [{ type: 'agentMessage', id: 'c', text: 'z' }] },
        ],
      },
    });

    expect(items.map((i) => [i.id, i.turnId])).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['c', undefined],
    ]);
  });

  it('itemsが配列でないターンは飛ばす（従来どおり落ちない）', () => {
    const items = itemsOf({
      thread: {
        id: 'th-3',
        turns: [
          { id: 'turn-1' },
          { id: 'turn-2', items: 'こわれている' },
          { id: 'turn-3', items: [{ type: 'agentMessage', id: 'ok', text: 'OK' }] },
        ],
      },
    });

    expect(items.map((i) => [i.id, i.turnId])).toEqual([['ok', 'turn-3']]);
  });
});
