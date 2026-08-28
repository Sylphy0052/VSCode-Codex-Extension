import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import {
  interruptFailedNoticeId,
  interruptedCommandsNoticeId,
} from '../../src/appserver/chatState';
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

interface Fake {
  session: ChatSession;
  sent: Sent[];
  /** `turn/interrupt` の応答を保留していた場合に、まとめて返す。 */
  releaseInterrupt: () => void;
}

/**
 * `chatSessionRecap.test.ts` と同じ方針の最小フェイク。要求だけを記録する。
 *
 * `gateInterrupt` を立てると `turn/interrupt` の応答を `releaseInterrupt()` まで保留する。
 * 応答を待つ間に中断がもう一度呼ばれる状況（`Esc` の連打）を再現するために使う。
 *
 * `failInterrupt` を立てると `turn/interrupt` を失敗させる。要求のタイムアウトや接続断を
 * 再現するために使う（issue #261）。
 */
function fakeSession(options?: { gateInterrupt?: boolean; failInterrupt?: boolean }): Fake {
  const sent: Sent[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request(method: string, params: unknown) {
      sent.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === 'thread/start') {
        return { result: START_RESULT };
      }
      if (method === 'turn/interrupt' && options?.gateInterrupt === true) {
        await gate;
      }
      if (method === 'turn/interrupt' && options?.failInterrupt === true) {
        throw new Error('app-serverが応答しません: turn/interrupt');
      }
      return { result: {} };
    },
  } as unknown as AppServerConnection;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  return {
    session: new ChatSession(connection, log, () => undefined),
    sent,
    releaseInterrupt: () => release(),
  };
}

/** ターンが動いていて、コマンドが1件実行中の状態を作る。 */
async function runningCommand(options?: {
  gateInterrupt?: boolean;
  failInterrupt?: boolean;
}): Promise<Fake> {
  const fake = fakeSession(options);
  await fake.session.start('/w', emptyConfig);
  fake.session.applyNotification('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } });
  fake.session.applyNotification('item/started', {
    threadId: 'th-1',
    turnId: 'turn-1',
    item: { id: 'cmd_1', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' },
  });
  fake.sent.length = 0; // thread/startの記録を落とし、以降のinterrupt()だけを見る
  return fake;
}

/** 中断の注記だけを拾う。idはターンごとに変わる（issue #258）ため接頭辞で見る。 */
function noticesOf(session: ChatSession): string[] {
  return session
    .getState()
    .items.filter((i) => i.id.startsWith('interruptedCommands'))
    .map((i) => i.id);
}

describe('ChatSession.interrupt（issue #246、design.md §9.6）', () => {
  it('turn/interruptを送り、実行中のコマンドへ印と注記を残す', async () => {
    const { session, sent } = await runningCommand();

    await session.interrupt();

    expect(sent).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'th-1', turnId: 'turn-1' } },
    ]);
    const state = session.getState();
    expect(state.busy).toBe(false);
    expect(state.turnId).toBeUndefined();
    expect(state.items.find((i) => i.id === 'cmd_1')?.interruptedWhileRunning).toBe(true);
    const notice = state.items.find((i) => i.id === interruptedCommandsNoticeId('turn-1'));
    expect(notice?.detail).toContain('走り続けることがあります');
  });

  it('中断した後もCLIから届く出力で印は消えない', async () => {
    const { session } = await runningCommand();
    await session.interrupt();

    // 中断してもコマンドの子プロセスは残るため、出力と更新は届き続ける
    session.applyNotification('item/commandExecution/outputDelta', {
      itemId: 'cmd_1',
      delta: 'まだ出力が続いている',
    });
    session.applyNotification('item/updated', {
      threadId: 'th-1',
      turnId: 'turn-1',
      item: { id: 'cmd_1', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' },
    });

    expect(session.getState().items.find((i) => i.id === 'cmd_1')?.interruptedWhileRunning).toBe(
      true,
    );
  });

  it('応答を待つ間にもう一度中断されても注記は1行のまま（issue #258）', async () => {
    // `Esc` を連打すると、応答が返る前に2回目のinterrupt()が走る。注記のidを
    // その時点の state.turnId から作ると、2回目は turnId が落ちていて別idの行が増えてしまう
    const { session, releaseInterrupt } = await runningCommand({ gateInterrupt: true });

    const first = session.interrupt();
    const second = session.interrupt();
    releaseInterrupt();
    await Promise.all([first, second]);

    expect(noticesOf(session)).toEqual([interruptedCommandsNoticeId('turn-1')]);
  });

  it('turn/interruptが失敗しても応答中の見た目のまま固まらない（issue #261）', async () => {
    const { session } = await runningCommand({ failInterrupt: true });

    await expect(session.interrupt()).rejects.toThrow('app-serverが応答しません');

    const state = session.getState();
    expect(state.busy).toBe(false);
    // ターンは終わっていない可能性が高い。turnIdも実行中コマンドの印も触らない
    expect(state.turnId).toBe('turn-1');
    expect(state.items.find((i) => i.id === 'cmd_1')?.interruptedWhileRunning).toBeUndefined();
    const notice = state.items.find((i) => i.id === interruptFailedNoticeId('turn-1'));
    expect(notice?.detail).toContain('中断できませんでした');
  });

  it('応答を待つ間の2回目は要求そのものを送らない（issue #261）', async () => {
    // 同じturnIdへ2回目の`turn/interrupt`を送ると、app-serverは応答を返さない（実測）。
    // 要求が120秒のタイムアウトまで宙に浮くため、送る前で止める
    const { session, sent, releaseInterrupt } = await runningCommand({ gateInterrupt: true });

    const first = session.interrupt();
    const second = session.interrupt();
    releaseInterrupt();
    await Promise.all([first, second]);

    expect(sent).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'th-1', turnId: 'turn-1' } },
    ]);
  });

  it('応答を待つ間に別のターンが始まれば、そちらの中断は送る（issue #261）', async () => {
    // 番人はターンごとに持つ。1回目の応答待ちを理由に、別のターンの中断まで
    // 握り潰してしまうと中断そのものが効かなくなる
    const { session, sent, releaseInterrupt } = await runningCommand({ gateInterrupt: true });

    const first = session.interrupt();
    session.applyNotification('turn/started', { threadId: 'th-1', turn: { id: 'turn-2' } });
    const second = session.interrupt();
    releaseInterrupt();
    await Promise.all([first, second]);

    expect(sent).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'th-1', turnId: 'turn-1' } },
      { method: 'turn/interrupt', params: { threadId: 'th-1', turnId: 'turn-2' } },
    ]);
  });

  it('進行中のターンが無ければ何も送らず、注記も残さない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    sent.length = 0;

    await session.interrupt();

    expect(sent).toEqual([]);
    expect(noticesOf(session)).toEqual([]);
  });
});

describe('中断したターンの確定はturn/completedだけが行う（issue #939）', () => {
  it('interrupt()自身はturnCompletionSeqを進めない', async () => {
    const { session } = await runningCommand();
    const before = session.getState().turnCompletionSeq;

    await session.interrupt();

    // app-serverは`turn/interrupt`が成功したターンも`turn/completed`
    // （`status: "interrupted"`）で終わらせる。ここで進めると同じターンを2回確定させる
    expect(session.getState().turnCompletionSeq).toBe(before);
  });

  it('中断の後に届くturn/completedで、1回だけ確定する', async () => {
    const { session } = await runningCommand();
    const before = session.getState().turnCompletionSeq;

    await session.interrupt();
    session.applyNotification('turn/completed', { threadId: 'th-1' });

    expect(session.getState().turnCompletionSeq).toBe(before + 1);
  });

  it('中断が失敗したときも進めない（ターンは続いている可能性が高い）', async () => {
    const { session } = await runningCommand({ failInterrupt: true });
    const before = session.getState().turnCompletionSeq;

    await expect(session.interrupt()).rejects.toThrow();

    expect(session.getState().turnCompletionSeq).toBe(before);
  });
});
