import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import { interruptedCommandsNoticeId } from '../../src/appserver/chatState';
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
 */
function fakeSession(options?: { gateInterrupt?: boolean }): Fake {
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
async function runningCommand(options?: { gateInterrupt?: boolean }): Promise<Fake> {
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

  it('進行中のターンが無ければ何も送らず、注記も残さない', async () => {
    const { session, sent } = fakeSession();
    await session.start('/w', emptyConfig);
    sent.length = 0;

    await session.interrupt();

    expect(sent).toEqual([]);
    expect(noticesOf(session)).toEqual([]);
  });
});
