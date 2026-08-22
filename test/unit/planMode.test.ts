import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { applyEvent, describePlan, initialChatState } from '../../src/appserver/chatState';
import type { AppServerConnection } from '../../src/appserver/connection';
import { PLAN_POLICY, readTurnPolicy, turnPolicyFor } from '../../src/appserver/planMode';
import { emptyConfig } from '../../src/codex/types';
import type { Logger } from '../../src/log';

/** thread/start の応答。実測した形のうち、ここで使うものだけ持つ。 */
const START_RESULT = {
  thread: { id: 'th-1' },
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
};

describe('readTurnPolicy', () => {
  it('開始時の応答から効いている権限を読む', () => {
    expect(readTurnPolicy(START_RESULT)).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    });
  });

  it('権限が入っていない応答では何も返さない', () => {
    expect(readTurnPolicy({ thread: { id: 'th-1' } })).toBeUndefined();
    expect(readTurnPolicy(undefined)).toBeUndefined();
    expect(readTurnPolicy({ approvalPolicy: 'never' })).toBeUndefined();
  });
});

describe('turnPolicyFor', () => {
  const baseline = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };

  it('計画モード中は読み取り専用にする', () => {
    expect(turnPolicyFor(true, baseline, false, '')).toEqual(PLAN_POLICY);
  });

  it('設定のサンドボックスより計画モードを優先する', () => {
    expect(turnPolicyFor(true, baseline, false, 'danger-full-access')).toEqual(PLAN_POLICY);
  });

  it('読み取り専用のとき承認を求めない', () => {
    // 書き込みの失敗がサンドボックス脱出の承認要求へ化けると、そこで許可されてしまう
    expect(PLAN_POLICY.approvalPolicy).toBe('never');
    expect(PLAN_POLICY.sandboxPolicy).toEqual({ type: 'readOnly' });
  });

  it('設定が空で一度も入っていなければ権限に触らない', () => {
    expect(turnPolicyFor(false, baseline, false, '')).toBeUndefined();
  });

  it('設定のサンドボックスを毎ターン渡す', () => {
    expect(turnPolicyFor(false, baseline, false, 'read-only')).toEqual({
      sandboxPolicy: { type: 'readOnly' },
    });
  });

  it('抜けたあとは開始時の権限へ戻す', () => {
    // turn/start の指定は「このターン以降」に効くため、明示的に戻さないと読み取り専用のまま
    expect(turnPolicyFor(false, baseline, true, '')).toEqual(baseline);
  });

  it('抜けたあとに設定があれば、承認方針だけ戻して設定のサンドボックスを使う', () => {
    expect(turnPolicyFor(false, baseline, true, 'danger-full-access')).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('戻し先が判らなければ何も送らない', () => {
    expect(turnPolicyFor(false, undefined, true, '')).toBeUndefined();
  });

  it('bypassのときはサンドボックスを張らず承認も求めない（issue #222）', () => {
    // thread/start は SandboxMode の3値しか取らないため、フラグ相当の指定は
    // ターン側の sandboxPolicy でしか表現できない
    expect(turnPolicyFor(false, baseline, false, '', undefined, true)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'externalSandbox' },
    });
  });

  it('bypassは設定のサンドボックスより優先する', () => {
    expect(turnPolicyFor(false, baseline, false, 'read-only', undefined, true)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'externalSandbox' },
    });
  });

  it('計画モードはbypassより優先する', () => {
    // 読み取り専用の保証は人の承認を前提にしている。保護を外す指定に負けてはいけない
    expect(turnPolicyFor(true, baseline, false, '', undefined, true)).toEqual(PLAN_POLICY);
  });

  it('書き込み範囲とネットワークの指定を載せる', () => {
    expect(
      turnPolicyFor(false, baseline, false, 'workspace-write', {
        writableRoots: ['/tmp/work'],
        networkAccess: true,
      }),
    ).toEqual({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/work'],
        networkAccess: true,
      },
    });
  });
});

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function fakeSession(startResult: unknown = START_RESULT): {
  session: ChatSession;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request(method: string, params: unknown) {
      sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return { result: method === 'thread/start' ? startResult : {} };
    },
  } as unknown as AppServerConnection;
  const log = {
    info() {},
    warn() {},
    error() {},
  } as unknown as Logger;
  return { session: new ChatSession(connection, log, () => undefined), sent };
}

const turnStarts = (sent: Sent[]): Record<string, unknown>[] =>
  sent.filter((s) => s.method === 'turn/start').map((s) => s.params);

/**
 * `start()`が想定外の応答を受けたときに投げることの確認（issue #460の穴1）。
 *
 * 同型の穴は`loadForkedThread`側では`chatSideQuestion.test.ts`「threadIdを読み取れない
 * 応答は投げる」で既に塞がれている。`readThreadId()`は両者が共有する関数だが、
 * `start()`側だけ確認が無い非対称だったため、`readThreadId()`が`undefined`を返す
 * 4条件（thread無し・threadがオブジェクトでない・idが文字列でない・idが空文字）を
 * 全て確認する。1条件だけでは「たまたま通った」可能性を消せず、`readThreadId()`の
 * 実装（`src/appserver/chatSession.ts`）を変えたときに一部の分岐だけ壊れて見逃す
 * おそれがあるため、コストが低い（`fakeSession`の応答を差し替えるだけ）ことも踏まえて
 * 網羅する判断にした。
 */
describe('ChatSession.start の想定外応答', () => {
  it('threadが無い応答は投げる', async () => {
    const { session } = fakeSession({});
    await expect(session.start('/w', emptyConfig)).rejects.toThrow(
      /スレッドを開始できませんでした/u,
    );
  });

  it('threadがオブジェクトでない応答は投げる', async () => {
    const { session } = fakeSession({ thread: 'th-1' });
    await expect(session.start('/w', emptyConfig)).rejects.toThrow(
      /スレッドを開始できませんでした/u,
    );
  });

  it('idが文字列でない応答は投げる', async () => {
    const { session } = fakeSession({ thread: { id: 123 } });
    await expect(session.start('/w', emptyConfig)).rejects.toThrow(
      /スレッドを開始できませんでした/u,
    );
  });

  it('idが空文字の応答は投げる', async () => {
    const { session } = fakeSession({ thread: { id: '' } });
    await expect(session.start('/w', emptyConfig)).rejects.toThrow(
      /スレッドを開始できませんでした/u,
    );
  });
});

describe('ChatSession の計画モード', () => {
  it('普段はサンドボックスに触らない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    await session.send('やって', emptyConfig);
    expect(turnStarts(sent)[0]).not.toHaveProperty('sandboxPolicy');
  });

  it('計画モード中は読み取り専用で送る', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    session.setPlanMode(true);
    await session.send('計画して', emptyConfig);
    expect(turnStarts(sent)[0]).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
  });

  it('設定の承認方針より計画モードを優先する', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', { ...emptyConfig, approvalMode: 'on-request' });
    session.setPlanMode(true);
    await session.send('計画して', { ...emptyConfig, approvalMode: 'on-request' });
    expect(turnStarts(sent)[0]?.['approvalPolicy']).toBe('never');
  });

  it('抜けたあとの最初のターンで開始時の権限へ戻す', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    session.setPlanMode(true);
    await session.send('計画して', emptyConfig);
    session.setPlanMode(false);
    await session.send('やって', emptyConfig);
    expect(turnStarts(sent)[1]).toMatchObject({
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
      approvalPolicy: 'on-request',
    });
  });

  it('設定のサンドボックスを毎ターン渡す（会話の途中で変えられる）', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', { ...emptyConfig, sandbox: 'read-only' });
    await session.send('調べて', { ...emptyConfig, sandbox: 'read-only' });
    await session.send('直して', { ...emptyConfig, sandbox: 'workspace-write' });

    expect(turnStarts(sent)[0]?.['sandboxPolicy']).toEqual({ type: 'readOnly' });
    expect(turnStarts(sent)[1]?.['sandboxPolicy']).toEqual({ type: 'workspaceWrite' });
  });

  it('計画モード中は設定のサンドボックスを無視する', async () => {
    const { session, sent } = fakeSession();
    const config = { ...emptyConfig, sandbox: 'danger-full-access' };
    await session.start('/w', config);
    session.setPlanMode(true);
    await session.send('計画して', config);
    expect(turnStarts(sent)[0]).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
  });

  it('計画モードを抜けたら設定のサンドボックスへ戻る', async () => {
    const { session, sent } = fakeSession();
    const config = { ...emptyConfig, sandbox: 'workspace-write' };
    await session.start('/w', config);
    session.setPlanMode(true);
    await session.send('計画して', config);
    session.setPlanMode(false);
    await session.send('やって', config);
    expect(turnStarts(sent)[1]?.['sandboxPolicy']).toEqual({ type: 'workspaceWrite' });
  });

  it('切り替えは会話に残る', async () => {
    const { session } = fakeSession();
    await session.start('/w', emptyConfig);
    session.setPlanMode(true);
    session.setPlanMode(false);
    const notices = session.getState().items.filter((i) => i.kind === 'settingsChanged');
    expect(notices).toHaveLength(2);
    expect(notices[0]?.detail).toContain('計画モードに入りました');
    expect(notices[1]?.detail).toContain('計画モードを抜けました');
  });

  it('同じ状態への切り替えは何もしない', async () => {
    const { session } = fakeSession();
    await session.start('/w', emptyConfig);
    session.setPlanMode(false);
    expect(session.getState().items).toEqual([]);
    expect(session.getState().planMode).toBe(false);
  });

  it('戻し先が判らないスレッドでは入れない', async () => {
    // 入れてしまうと読み取り専用から出られなくなる
    const { session } = fakeSession({ thread: { id: 'th-1' } });
    await session.start('/w', emptyConfig);
    expect(() => session.setPlanMode(true)).toThrow(/計画モードに入れません/u);
    expect(session.getState().planMode).toBe(false);
  });
});

describe('describePlan', () => {
  it('ステップと進み具合を並べる', () => {
    expect(
      describePlan([
        { step: '調べる', status: 'completed' },
        { step: '直す', status: 'inProgress' },
        { step: '確かめる', status: 'pending' },
      ]),
    ).toBe('[x] 調べる\n[~] 直す\n[ ] 確かめる');
  });

  it('未知の状態はCLIの表記のまま出す', () => {
    expect(describePlan([{ step: 'なにか', status: 'blocked' }])).toBe('[blocked] なにか');
  });

  it('読めないものは何も返さない', () => {
    expect(describePlan(undefined)).toBe('');
    expect(describePlan([])).toBe('');
    expect(describePlan([{ status: 'pending' }])).toBe('');
  });
});

describe('applyEvent / turn/plan/updated', () => {
  const notification = (status: string) => ({
    threadId: 'th-1',
    turnId: 'tu-1',
    explanation: '先に調べてから直す',
    plan: [{ step: '調べる', status }],
  });

  it('計画を項目にする', () => {
    const state = applyEvent(initialChatState, 'turn/plan/updated', notification('pending'));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: 'plan:tu-1',
      kind: 'plan',
      text: '[ ] 調べる',
      detail: '先に調べてから直す',
      turnId: 'tu-1',
    });
  });

  it('進んでも項目は増えない（同じ計画を書き換える）', () => {
    const first = applyEvent(initialChatState, 'turn/plan/updated', notification('pending'));
    const next = applyEvent(first, 'turn/plan/updated', notification('completed'));
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.text).toBe('[x] 調べる');
  });

  it('読めない通知では状態を変えない', () => {
    expect(applyEvent(initialChatState, 'turn/plan/updated', {})).toBe(initialChatState);
  });
});
