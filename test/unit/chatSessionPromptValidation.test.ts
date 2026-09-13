import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { SERVER_REQUEST_METHODS } from '../../src/appserver/approvals';
import type { AppServerConnection } from '../../src/appserver/connection';
import { emptyConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

/**
 * issue #1188: スキーマの必須・整数の制約に反する回答を、ホスト側が送らずに差し戻す。
 *
 * 送ってしまうと、要求元が拒否したときには回答待ちもカードも消えており、同じ
 * フォームで直せない。
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
      days: { type: 'integer', minimum: 1 },
    },
    required: ['city'],
  },
};

/** 応答がまだ返っていないことを、実際に待って確かめる。 */
const settled = async (responded: Promise<unknown>): Promise<unknown> =>
  Promise.race([responded, Promise.resolve('まだ応答していない')]);

describe('制約に反する回答を差し戻す（issue #1188）', () => {
  it('必須の空欄では応答せず、カードと理由を残す', async () => {
    const session = fakeSession();
    await session.start('/w', emptyConfig);

    const responded = session.requestApproval({
      id: 7,
      method: SERVER_REQUEST_METHODS.elicitation,
      params: ELICITATION_PARAMS,
    });

    session.answerPrompt(7, { action: 'submit', values: { city: [''], days: ['3'] } });

    expect(await settled(responded)).toBe('まだ応答していない');
    const [prompt] = session.getState().prompts;
    expect(prompt?.requestId).toBe(7);
    expect(prompt?.errors).toEqual({ city: '必須項目です' });

    // 直せば送れる。差し戻しで回答待ちを壊していない
    session.answerPrompt(7, { action: 'submit', values: { city: ['Tokyo'], days: ['3'] } });
    await expect(responded).resolves.toEqual({
      action: 'accept',
      content: { city: 'Tokyo', days: 3 },
    });
    expect(session.getState().prompts).toEqual([]);
  });

  it('整数の項目への小数でも応答しない', async () => {
    const session = fakeSession();
    await session.start('/w', emptyConfig);

    const responded = session.requestApproval({
      id: 8,
      method: SERVER_REQUEST_METHODS.elicitation,
      params: ELICITATION_PARAMS,
    });

    session.answerPrompt(8, { action: 'submit', values: { city: ['Tokyo'], days: ['1.5'] } });

    expect(await settled(responded)).toBe('まだ応答していない');
    expect(session.getState().prompts[0]?.errors).toEqual({ days: '整数を入力してください' });

    // 取り消しは検証しない。答えないための経路を塞がない
    session.answerPrompt(8, { action: 'cancel', values: {} });
    await expect(responded).resolves.toEqual({ action: 'cancel' });
  });
});
