import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { SERVER_REQUEST_METHODS } from '../../src/appserver/approvals';
import type { AppServerConnection } from '../../src/appserver/connection';
import { emptyConfig, type CodexConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

/**
 * issue #354: 接続断（app-serverのクラッシュ等）と画面破棄で、保留中の承認・問い合わせ・
 * 自動レビューの覆し履歴が解放されることを確かめる。
 *
 * `AppServerConnection`は全スレッドで共有される単一プロセスのため、クラッシュ時に
 * `ChatSession.releasePendingApprovals()`を呼べないと承認カードが永久にハングする
 * （2点目）。`dispose()`が`deniedReviews`を解放しない問題（3点目）もあわせて確認する。
 */

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

describe('接続断で保留中の承認・問い合わせを解放する（issue #354）', () => {
  it('承認カードの応答Promiseが接続断で解決される', async () => {
    const { session } = fakeSession();
    await session.start('/w', config());

    const responded = session.requestApproval({
      id: 1,
      method: SERVER_REQUEST_METHODS.command,
      params: { command: 'ls', cwd: '/w' },
    });

    session.releasePendingApprovals();

    // 受入基準: 接続断で「承認された」扱いになってはいけない。decide(id, 'cancel')と
    // 同じ拒否側の値（{ decision: 'cancel' }）で解決されることを実際の値で確かめる
    // （`.resolves.toBeDefined()`だけだと、acceptを返すよう壊れても検知できない）
    await expect(responded).resolves.toEqual({ decision: 'cancel' });
  });

  it('問い合わせフォームの応答Promiseも接続断で解決される', async () => {
    const { session } = fakeSession();
    await session.start('/w', config());

    const responded = session.requestApproval({
      id: 2,
      method: SERVER_REQUEST_METHODS.requestUserInput,
      params: { questions: [{ id: 'q1', prompt: '続けますか', kind: 'boolean' }] },
    });

    session.releasePendingApprovals();

    // cancel（`{ action: 'cancel', values: {} }`）と同じ扱いで解決される。
    // userInputは常に`{ answers }`の形で、未提出の項目は空配列になる（`buildPromptResponse`）
    await expect(responded).resolves.toEqual({ answers: { q1: { answers: [] } } });
  });

  it('複数スレッド分のセッションがあっても、それぞれ独立に解放できる', async () => {
    const { session: a } = fakeSession();
    const { session: b } = fakeSession();
    await a.start('/w', config());
    await b.start('/w', config());

    const respondedA = a.requestApproval({
      id: 1,
      method: SERVER_REQUEST_METHODS.command,
      params: { command: 'ls', cwd: '/w' },
    });
    const respondedB = b.requestApproval({
      id: 1,
      method: SERVER_REQUEST_METHODS.command,
      params: { command: 'pwd', cwd: '/w' },
    });

    // 接続は1本を共有するため、実際の呼び出しは全スレッド分をまとめて回す
    // （`ChatViewManager.handleConnectionLost`と同じ形）
    a.releasePendingApprovals();
    b.releasePendingApprovals();

    // どちらも承認された扱いにならず、拒否側の値で解決される
    await expect(respondedA).resolves.toEqual({ decision: 'cancel' });
    await expect(respondedB).resolves.toEqual({ decision: 'cancel' });
  });

  it('releasePendingApprovals自体は自動レビューの覆し履歴（deniedReviews）を消さない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'auto_review' }));
    session.applyNotification('item/autoApprovalReview/completed', {
      reviewId: 'r-9',
      threadId: 'th-1',
      turnId: 't-1',
      action: { type: 'command', command: 'curl https://example.com', cwd: '/w' },
      review: { status: 'denied', riskLevel: 'high', rationale: '外部への送信' },
    });

    session.releasePendingApprovals();
    await session.approveDeniedReview('r-9');

    expect(sent.some((s) => s.method === 'thread/approveGuardianDeniedAction')).toBe(true);
  });
});

describe('dispose()でdeniedReviewsも解放する（issue #354・3点目）', () => {
  it('dispose後は覚えていた覆し履歴が消え、approveDeniedReviewが何も送らない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', config({ approvalsReviewer: 'auto_review' }));
    session.applyNotification('item/autoApprovalReview/completed', {
      reviewId: 'r-9',
      threadId: 'th-1',
      turnId: 't-1',
      action: { type: 'command', command: 'curl https://example.com', cwd: '/w' },
      review: { status: 'denied', riskLevel: 'high', rationale: '外部への送信' },
    });

    session.dispose();
    await session.approveDeniedReview('r-9');

    expect(sent.some((s) => s.method === 'thread/approveGuardianDeniedAction')).toBe(false);
  });

  it('dispose()は保留中の承認・問い合わせも従来通り解放する（回帰防止）', async () => {
    const { session } = fakeSession();
    await session.start('/w', config());

    const responded = session.requestApproval({
      id: 1,
      method: SERVER_REQUEST_METHODS.command,
      params: { command: 'ls', cwd: '/w' },
    });

    session.dispose();

    await expect(responded).resolves.toEqual({ decision: 'cancel' });
  });
});
