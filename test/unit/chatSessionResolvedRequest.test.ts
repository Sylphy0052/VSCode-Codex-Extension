import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { SERVER_REQUEST_METHODS } from '../../src/appserver/approvals';
import type { AppServerConnection } from '../../src/appserver/connection';
import { emptyConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

/**
 * issue #1192: 質問フォームが `serverRequest/resolved` を受けても取り下げられず、
 * 遅れて届いたWebviewの回答が用済みの要求へ応答を返してしまう経路を塞ぐ。
 */

const START_RESULT = {
  thread: { id: 'th-1' },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

function fakeSession(): ChatSession {
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request(method: string) {
      return { result: method === 'thread/start' ? START_RESULT : {} };
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return new ChatSession(connection, log, () => undefined);
}

const ELICITATION_PARAMS = {
  serverName: 'weather',
  threadId: 'th-1',
  turnId: null,
  mode: 'form',
  message: '教えて',
  requestedSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  },
};

/** 応答がまだ返っていないことを、実際に待って確かめる。 */
const settled = async (responded: Promise<unknown>): Promise<unknown> =>
  Promise.race([responded, Promise.resolve('まだ応答していない')]);

describe('質問フォームの解決済み通知（issue #1192）', () => {
  it('serverRequest/resolvedで質問カードを取り下げる', async () => {
    const session = fakeSession();
    await session.start('/w', emptyConfig);

    void session.requestApproval({
      id: 9,
      method: SERVER_REQUEST_METHODS.elicitation,
      params: ELICITATION_PARAMS,
    });
    expect(session.getState().prompts).toHaveLength(1);

    session.applyNotification('serverRequest/resolved', { requestId: 9, threadId: 'th-1' });

    expect(session.getState().prompts).toEqual([]);
  });

  it('取り下げ後に遅れて届いた回答は、用済みの要求へ応答を返さない', async () => {
    const session = fakeSession();
    await session.start('/w', emptyConfig);

    const responded = session.requestApproval({
      id: 10,
      method: SERVER_REQUEST_METHODS.elicitation,
      params: ELICITATION_PARAMS,
    });

    session.applyNotification('serverRequest/resolved', { requestId: 10, threadId: 'th-1' });

    // 別経路が既に応答した後、Webview側の回答が遅れて届く
    session.answerPrompt(10, { action: 'submit', values: { city: ['Tokyo'] } });

    expect(await settled(responded)).toBe('まだ応答していない');
  });
});
