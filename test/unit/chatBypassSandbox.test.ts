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

const BYPASS = config({ bypassApprovalsAndSandbox: true });

describe('承認もサンドボックスも外す指定（issue #222）', () => {
  it('thread/start には承認まわりを一切載せない', async () => {
    // `ThreadStartParams.sandbox` は `SandboxMode` の3値しか取らず、サンドボックスを
    // 張らない指定を表現できない。中途半端な値を送るより、載せずにターン側で決める
    const { session, sent } = fakeSession();
    await session.start(
      '/w',
      config({
        bypassApprovalsAndSandbox: true,
        sandbox: 'read-only',
        approvalMode: 'untrusted',
        approvalsReviewer: 'auto_review',
      }),
    );

    const params = paramsOf(sent, 'thread/start');
    expect(params).toEqual({ cwd: '/w' });
  });

  it('turn/start で externalSandbox と never を組にして送る', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', BYPASS);
    await session.send('やって', BYPASS);

    expect(paramsOf(sent, 'turn/start')).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'externalSandbox' },
    });
  });

  it('設定の承認方針や自動レビューに打ち消されない', async () => {
    const withOthers = config({
      bypassApprovalsAndSandbox: true,
      approvalMode: 'untrusted',
      approvalsReviewer: 'auto_review',
      sandbox: 'read-only',
    });
    const { session, sent } = fakeSession();
    await session.start('/w', withOthers);
    await session.send('やって', withOthers);

    const params = paramsOf(sent, 'turn/start');
    expect(params?.['approvalPolicy']).toBe('never');
    expect(params?.['sandboxPolicy']).toEqual({ type: 'externalSandbox' });
    expect(params?.['approvalsReviewer']).toBeUndefined();
  });

  it('計画モード中は読み取り専用が勝つ', async () => {
    // 読み取り専用の保証は人の承認を前提にしている。保護を外す指定に負けてはいけない
    const { session, sent } = fakeSession();
    await session.start('/w', BYPASS);
    session.setPlanMode(true);
    await session.send('調べて', BYPASS);

    expect(paramsOf(sent, 'turn/start')).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
    });
  });
});
