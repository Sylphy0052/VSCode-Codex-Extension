import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ChatState } from '../../src/appserver/chatState';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import type { ApprovalHandlerResult } from '../../src/orchestrator/taskSession';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

/**
 * 承認の自動判定を待っている間にプロセスが終わったときの扱い（issue #1197）。
 *
 * 判定はawaitを挟むため、戻ってきた時点ではプロセスが既に居ないことがある。終了時の解放
 * （`releasePendingWaiters()`）が回収できるのはその時点で`waiting`にある分だけなので、
 * 判定中の要求は取りこぼす。そこへ承認カードを出しても、`write()`はプロセスが無ければ
 * 何も送らないため、押しても応答が返らない承認待ちが残る。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

interface Deferred {
  /** セッションへ渡す判定ハンドラ。呼ばれても解決せず、テストが明示的に解決する。 */
  handler: () => Promise<ApprovalHandlerResult>;
  /** 判定が呼ばれた回数。 */
  calls: () => number;
  /** 判定を解決する。 */
  resolve: (result: ApprovalHandlerResult) => void;
  /** 判定を失敗させる。 */
  reject: (error: Error) => void;
}

function deferredHandler(): Deferred {
  let settle: ((result: ApprovalHandlerResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let calls = 0;
  return {
    handler: () => {
      calls += 1;
      return new Promise<ApprovalHandlerResult>((res, rej) => {
        settle = res;
        fail = rej;
      });
    },
    calls: () => calls,
    resolve: (result) => settle?.(result),
    reject: (error) => fail?.(error),
  };
}

interface Started {
  session: ClaudeStreamSession;
  proc: ChildProcessWithoutNullStreams;
  states: ChatState[];
  writes: string[];
  /** 同じセッションを新しいプロセスで起こし直す（2つ目のフェイクを返す）。 */
  restart: () => { proc: ChildProcessWithoutNullStreams; writes: string[] };
}

const startOptions = {
  cwd: '/w',
  target: { kind: 'new' },
  sessionId: '11111111-1111-1111-1111-111111111111',
  config: emptyClaudeConfig,
} as const;

/** `start()`まで済ませたセッションと、フェイクプロセス・観測用の配列を返す。 */
function createStartedSession(interceptApproval: () => Promise<ApprovalHandlerResult>): Started {
  const { proc, writes } = createFakeChildProcess();
  const spawned: Array<{ proc: ChildProcessWithoutNullStreams; writes: string[] }> = [];
  const spawnProcess: ClaudeSpawnPort = () => {
    const next = spawned.shift();
    return next === undefined ? proc : next.proc;
  };
  const states: ChatState[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    (state) => states.push(state),
    () => undefined,
    () => undefined,
    interceptApproval,
    spawnProcess,
  );
  session.start({ ...startOptions, target: { kind: 'new' } });
  // start()が積む初期状態は、以降の「承認カードが増えたか」の判定に混ぜない
  states.length = 0;
  writes.length = 0;
  return {
    session,
    proc,
    states,
    writes,
    restart: () => {
      const next = createFakeChildProcess();
      spawned.push(next);
      session.start({ ...startOptions, target: { kind: 'new' } });
      next.writes.length = 0;
      return { proc: next.proc, writes: next.writes };
    },
  };
}

function canUseToolLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
  })}\n`;
}

/** 判定のPromiseチェーンが流れきるまでマイクロタスクを回す。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** `requestId`宛のcontrol_responseだけを取り出す。 */
function responsesFor(writes: readonly string[], requestId: string): unknown[] {
  return writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['type'] === 'control_response')
    .map((event) => event['response'] as Record<string, unknown>)
    .filter((response) => response['request_id'] === requestId)
    .map((response) => response['response']);
}

const approvalsOf = (states: readonly ChatState[]): number =>
  states.reduce((max, state) => Math.max(max, state.approvals.length), 0);

describe('ClaudeStreamSession: 判定中にセッションが終わった承認（issue #1197）', () => {
  it('生きたままaskが戻れば従来どおり承認カードを出す（対照）', async () => {
    const pending = deferredHandler();
    const { session, states } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    pending.resolve({ kind: 'ask' });
    await drain();

    expect(pending.calls()).toBe(1);
    expect(approvalsOf(states)).toBe(1);
  });

  it('判定中にプロセスが終了したら、askが戻っても承認カードを出さない', async () => {
    const pending = deferredHandler();
    const { session, proc, states } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    proc.emit('exit', 1);
    states.length = 0;
    pending.resolve({ kind: 'ask' });
    await drain();

    expect(approvalsOf(states)).toBe(0);
  });

  it('判定中にdispose()されたら、askが戻っても承認カードを出さない', async () => {
    const pending = deferredHandler();
    const { session, states } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    session.dispose();
    states.length = 0;
    pending.resolve({ kind: 'ask' });
    await drain();

    expect(approvalsOf(states)).toBe(0);
  });

  // この2件は`write()`（プロセスが無ければ書かない）でも守られており、世代の確認だけを
  // 見張る検査ではない。応答を送らないことを挙動として固定しておく
  it('判定中にプロセスが終了したら、autoが戻っても応答を送らない（送り先が無い）', async () => {
    const pending = deferredHandler();
    const { session, proc, writes } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    proc.emit('exit', 1);
    writes.length = 0;
    pending.resolve({ kind: 'auto', decision: 'accept' });
    await drain();

    expect(responsesFor(writes, 'r1')).toEqual([]);
  });

  it('判定が失敗したら、要求を放置せず拒否で応答する', async () => {
    const pending = deferredHandler();
    const { session, states, writes } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    pending.reject(new Error('判定器が落ちた'));
    await drain();

    expect(responsesFor(writes, 'r1')).toEqual([
      { behavior: 'deny', message: '内容を読み取れないため拒否しました' },
    ]);
    // 承認カードも出さない（人に聞ける状態ではない）
    expect(approvalsOf(states)).toBe(0);
  });

  it('判定が失敗し、かつプロセスも終わっていたら応答も送らない', async () => {
    const pending = deferredHandler();
    const { session, proc, writes } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    proc.emit('exit', 1);
    writes.length = 0;
    pending.reject(new Error('判定器が落ちた'));
    await drain();

    expect(responsesFor(writes, 'r1')).toEqual([]);
  });

  it('判定中に別のプロセスへ入れ替わったら、新しいプロセスへ応答を書かない', async () => {
    const pending = deferredHandler();
    const { session, writes, restart } = createStartedSession(pending.handler);

    session.receive(canUseToolLine('r1'));
    await drain();
    // 古いプロセスが落ち、同じセッションが新しいプロセスで起き直した状況
    const next = restart();
    writes.length = 0;
    pending.resolve({ kind: 'auto', decision: 'accept' });
    await drain();

    // 古い世代宛の許可を新しいプロセスへ書くと、別のツール実行を勝手に許すことになる
    expect(responsesFor(next.writes, 'r1')).toEqual([]);
    expect(responsesFor(writes, 'r1')).toEqual([]);
  });
});
