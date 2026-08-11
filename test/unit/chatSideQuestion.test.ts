import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import type { AppServerConnection } from '../../src/appserver/connection';
import type { Logger } from '../../src/log';

/**
 * `thread/fork`（ephemeral: true）の実際の応答形（実測。CLI 0.147.0）を模した固定値。
 * `thread/resume` と同じ形（ルートに `approvalPolicy` / `sandbox`、`thread.turns` に
 * 既存の会話）を持つ。
 */
const FORK_RESULT = {
  thread: {
    id: 'th-side-1',
    name: null,
    turns: [
      {
        id: 'turn-1',
        items: [
          { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'hi' }] },
          { type: 'agentMessage', id: 'item-2', text: 'こんにちは', phase: 'final_answer' },
        ],
      },
    ],
  },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

function noopSession(): ChatSession {
  // loadForkedThreadは通信を行わないため、connectionは呼ばれない前提のダミーでよい
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

describe('ChatSession.loadForkedThread', () => {
  it('fork応答からthreadIdと会話を直接復元する（通信を行わない）', () => {
    const session = noopSession();
    const threadId = session.loadForkedThread(FORK_RESULT);

    expect(threadId).toBe('th-side-1');
    expect(session.threadId).toBe('th-side-1');
    expect(session.getState().items.length).toBeGreaterThan(0);
  });

  it('threadIdを読み取れない応答は投げる', () => {
    const session = noopSession();
    expect(() => session.loadForkedThread({})).toThrow(/脇道のスレッドid/u);
  });

  it('元のセッションの状態には触れない（別インスタンスなので独立）', () => {
    const original = noopSession();
    const side = noopSession();
    side.loadForkedThread(FORK_RESULT);

    expect(original.threadId).toBeUndefined();
    expect(original.getState().items).toEqual([]);
  });
});
