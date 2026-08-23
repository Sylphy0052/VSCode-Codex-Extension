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

/** `review/start` の応答をテストごとに差し替えられるfakeSession。 */
function fakeSession(reviewResult: unknown): { session: ChatSession; sent: Sent[] } {
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
      if (method === 'review/start') {
        return { result: reviewResult };
      }
      return { result: {} };
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return { session: new ChatSession(connection, log, () => undefined), sent };
}

describe('ChatSession.startReview', () => {
  it('threadIdとtargetをreview/startへ渡す（inlineはdeliveryを載せない）', async () => {
    const { session, sent } = fakeSession({ reviewThreadId: 'th-1', turn: {} });
    await session.start('/w', emptyConfig);
    const reviewThreadId = await session.startReview({ type: 'uncommittedChanges' }, 'inline');

    expect(reviewThreadId).toBe('th-1');
    const call = sent.find((s) => s.method === 'review/start');
    expect(call?.params).toEqual({
      threadId: 'th-1',
      target: { type: 'uncommittedChanges' },
    });
  });

  it('detachedはdeliveryを載せる', async () => {
    const { session, sent } = fakeSession({ reviewThreadId: 'th-review', turn: {} });
    await session.start('/w', emptyConfig);
    await session.startReview({ type: 'baseBranch', branch: 'main' }, 'detached');

    const call = sent.find((s) => s.method === 'review/start');
    expect(call?.params).toEqual({
      threadId: 'th-1',
      target: { type: 'baseBranch', branch: 'main' },
      delivery: 'detached',
    });
  });

  it('inlineは呼び出し直後にbusyを立てる', async () => {
    const { session } = fakeSession({ reviewThreadId: 'th-1', turn: {} });
    await session.start('/w', emptyConfig);
    const promise = session.startReview({ type: 'uncommittedChanges' }, 'inline');
    expect(session.getState().busy).toBe(true);
    await promise;
  });

  it('detachedはこのセッションのbusyに触れない', async () => {
    const { session } = fakeSession({ reviewThreadId: 'th-review', turn: {} });
    await session.start('/w', emptyConfig);
    await session.startReview({ type: 'uncommittedChanges' }, 'detached');
    expect(session.getState().busy).toBe(false);
  });

  it('スレッド未開始では投げる', async () => {
    const { session } = fakeSession({ reviewThreadId: 'th-1', turn: {} });
    await expect(session.startReview({ type: 'uncommittedChanges' }, 'inline')).rejects.toThrow(
      /スレッドが開始されていません/u,
    );
  });

  it('reviewThreadIdを読み取れなければ投げ、inlineのbusyを戻す', async () => {
    const { session } = fakeSession({ turn: {} });
    await session.start('/w', emptyConfig);
    await expect(session.startReview({ type: 'uncommittedChanges' }, 'inline')).rejects.toThrow(
      /reviewThreadId/u,
    );
    expect(session.getState().busy).toBe(false);
  });
});
