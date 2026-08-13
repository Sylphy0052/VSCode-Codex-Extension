import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import type { AppServerConnection } from '../../src/appserver/connection';
import { emptyConfig, type CodexConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

/** thread/start の応答。承認方針の読み取り（planMode.ts）が働く形にしておく。 */
const START_RESULT = {
  thread: { id: 'th-1' },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

const config = (over: Partial<CodexConfig> = {}): CodexConfig => ({ ...emptyConfig, ...over });

function fakeSession(): { session: ChatSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request(method: string, params: unknown) {
      sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return { result: method === 'thread/start' ? START_RESULT : {} };
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return { session: new ChatSession(connection, log, () => undefined), sent };
}

const paramsOf = (sent: Sent[], method: string): Record<string, unknown> | undefined =>
  sent.find((s) => s.method === method)?.params;

describe('承認要求の回し先（approvalsReviewer）', () => {
  it('設定した回し先を thread/start へ載せる', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'auto_review' }));
    expect(paramsOf(sent, 'thread/start')).toMatchObject({ approvalsReviewer: 'auto_review' });
  });

  it('user も明示して送る（Codex側の既定に依らず画面の表示と一致させる）', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'user' }));
    expect(paramsOf(sent, 'thread/start')).toMatchObject({ approvalsReviewer: 'user' });
  });

  it('空ならプロパティごと省いてCodexの設定へ委譲する', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config());
    expect(paramsOf(sent, 'thread/start')).not.toHaveProperty('approvalsReviewer');
  });

  it('会話の途中で変えられるよう turn/start にも毎回載せる', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config());
    await session.send('やって', config({ approvalsReviewer: 'auto_review' }));
    expect(paramsOf(sent, 'turn/start')).toMatchObject({ approvalsReviewer: 'auto_review' });
  });

  it('未知の値は送らない（app-serverへ不明な値を渡さない）', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'guardian_subagent' }));
    await session.send('やって', config({ approvalsReviewer: 'guardian_subagent' }));
    expect(paramsOf(sent, 'thread/start')).not.toHaveProperty('approvalsReviewer');
    expect(paramsOf(sent, 'turn/start')).not.toHaveProperty('approvalsReviewer');
  });

  it('計画モード中は自動レビューを送らない（読み取り専用の保証を機械判定へ委ねない）', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config());
    session.setPlanMode(true);
    await session.send('計画して', config({ approvalsReviewer: 'auto_review' }));
    expect(paramsOf(sent, 'turn/start')).not.toHaveProperty('approvalsReviewer');
  });
});

describe('自動レビューで拒否された操作の覆し', () => {
  const denied = {
    reviewId: 'r-9',
    threadId: 'th-1',
    turnId: 't-1',
    action: { type: 'command', command: 'curl https://example.com', cwd: '/w', source: 'shell' },
    review: { status: 'denied', riskLevel: 'high', rationale: '外部への送信' },
  };

  it('拒否の通知を受けた操作を、人の指示で承認し直せる', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'auto_review' }));
    session.applyNotification('item/autoApprovalReview/completed', denied);

    await session.approveDeniedReview('r-9');

    const request = paramsOf(sent, 'thread/approveGuardianDeniedAction');
    expect(request).toMatchObject({ threadId: 'th-1' });
    // 覆しに要る `event`（GuardianAssessmentEvent）はスキーマ上「シリアライズ済み」としか
    // 定義されていないため、届いた通知をそのまま返す
    expect(request?.['event']).toEqual(denied);
  });

  it('知らないreviewIdでは何も送らない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config());
    await session.approveDeniedReview('r-unknown');
    expect(paramsOf(sent, 'thread/approveGuardianDeniedAction')).toBeUndefined();
  });

  it('承認された審査は覆しの対象にしない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config());
    session.applyNotification('item/autoApprovalReview/completed', {
      ...denied,
      review: { status: 'approved' },
    });
    await session.approveDeniedReview('r-9');
    expect(paramsOf(sent, 'thread/approveGuardianDeniedAction')).toBeUndefined();
  });
});
