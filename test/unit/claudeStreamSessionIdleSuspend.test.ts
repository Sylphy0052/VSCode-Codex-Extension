import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeStreamSession,
  type ClaudeSpawnPort,
  type ResumeOutcome,
} from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { createFakeChildProcess, type FakeChildProcess } from '../helpers/fakeChildProcess';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

/** 起動のたびに新しいフェイクのプロセスを返し、起動引数を記録する。 */
function createSession(): {
  session: ClaudeStreamSession;
  procs: FakeChildProcess[];
  spawnArgs: string[][];
  outcomes: ResumeOutcome[];
} {
  const procs: FakeChildProcess[] = [];
  const spawnArgs: string[][] = [];
  const spawnProcess: ClaudeSpawnPort = (_command, args) => {
    const fake = createFakeChildProcess();
    procs.push(fake);
    spawnArgs.push([...args]);
    return fake.proc;
  };
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    () => undefined,
    () => undefined,
    undefined,
    spawnProcess,
  );
  const outcomes: ResumeOutcome[] = [];
  session.setResumeListener((o) => outcomes.push(o));
  session.start({
    cwd: '/w',
    target: { kind: 'new' },
    sessionId: SESSION_ID,
    config: emptyClaudeConfig,
  });
  return { session, procs, spawnArgs, outcomes };
}

const relaunch = { cwd: '/w', config: () => emptyClaudeConfig };

function initEvent(mcpServers: { name: string; status: string }[]): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    mcp_servers: mcpServers,
  });
}

/** 休止させ、終了を見届けた状態にする。 */
async function suspendSession(session: ClaudeStreamSession, proc: FakeChildProcess) {
  const done = session.suspend(relaunch, 60_000);
  expect(session.getState().processSuspension).toBe('stopping');
  proc.emitExit(0);
  await expect(done).resolves.toBe(true);
}

describe('ClaudeStreamSession: 使っていないCLIの休止と再開（Issue #1808）', () => {
  it('何もしていないセッションは休止でき、休止中と表示する', async () => {
    const { session, procs } = createSession();
    expect(session.idleForSuspend).toBe(true);
    await suspendSession(session, procs[0]!);
    expect(session.suspended).toBe(true);
    expect(session.pid).toBeUndefined();
    expect(session.getState().processSuspension).toBe('suspended');
    expect(session.getState().turnFailed).toBe(false);
  });

  it('応答中は休止しない', async () => {
    const { session, procs } = createSession();
    session.send('hi');
    expect(session.idleForSuspend).toBe(false);
    await expect(session.suspend(relaunch)).resolves.toBe(false);
    expect(procs[0]!.kill).not.toHaveBeenCalled();
  });

  it('次の送信で同じsession-idを--resumeして起動し、発言を送る', async () => {
    const { session, procs, spawnArgs } = createSession();
    await suspendSession(session, procs[0]!);
    session.send('続き');
    expect(procs).toHaveLength(2);
    const args = spawnArgs[1]!;
    // `-r`は`--resume`の短縮形（`argvBuilder.ts`の`targetArgs`）
    expect(args[args.indexOf('-r') + 1]).toBe(SESSION_ID);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--fork-session');
    expect(session.getState().processSuspension).toBe('resuming');
    expect(procs[1]!.writes.some((w) => w.includes('続き'))).toBe(true);
  });

  it('再開中に続けて送っても2本目のCLIを起動しない', async () => {
    const { session, procs } = createSession();
    await suspendSession(session, procs[0]!);
    expect(session.sendOrQueue('1件目')).toBe('sent');
    expect(session.sendOrQueue('2件目')).toBe('queued');
    expect(procs).toHaveLength(2);
  });

  it('initが届いたら再開を確定し、MCPの接続状態をタブへ残す', async () => {
    const { session, procs, outcomes } = createSession();
    // 1ターン走らせて終了前の接続状態を覚えさせる（initはターンの始めに届く）
    session.send('最初');
    procs[0]!.emitStdout(initEvent([{ name: 'messaging', status: 'connected' }]));
    procs[0]!.emitStdout(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    );
    await suspendSession(session, procs[0]!);
    session.send('続き');
    procs[1]!.emitStdout(initEvent([{ name: 'messaging', status: 'failed' }]));
    expect(session.getState().processSuspension).toBeUndefined();
    expect(session.suspended).toBe(false);
    expect(outcomes).toEqual([
      { kind: 'resumed', mcpServers: [{ name: 'messaging', status: 'failed' }] },
    ]);
    const texts = JSON.stringify(session.getState().items);
    expect(texts).toContain('messaging（failed）');
  });

  it('再開に失敗したら黙って新しい会話にせず、発言を添えて知らせる', async () => {
    const { session, procs, outcomes } = createSession();
    await suspendSession(session, procs[0]!);
    session.send('続き');
    procs[1]!.emitStdout(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        errors: [`No conversation found with session ID: ${SESSION_ID}`],
      }),
    );
    procs[1]!.emitExit(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: 'failed', text: '続き' });
    expect(session.getState().processSuspension).toBe('resumeFailed');
    // 新しい会話のCLIを勝手に起動しない
    expect(procs).toHaveLength(2);
  });

  it('終了を待つ間に来た送信は積んでおき、終了後に再開して送る', async () => {
    const { session, procs } = createSession();
    const done = session.suspend(relaunch, 60_000);
    expect(session.sendOrQueue('待ち中の発言')).toBe('queued');
    expect(procs).toHaveLength(1);
    procs[0]!.emitExit(0);
    await done;
    expect(procs).toHaveLength(2);
    expect(procs[1]!.writes.some((w) => w.includes('待ち中の発言'))).toBe(true);
    expect(session.getState().queued).toHaveLength(0);
  });

  it('入力を閉じても終わらなければシグナルで止める', async () => {
    vi.useFakeTimers();
    try {
      const { session, procs } = createSession();
      const done = session.suspend(relaunch, 5_000);
      vi.advanceTimersByTime(5_000);
      expect(procs[0]!.kill).toHaveBeenCalled();
      procs[0]!.emitExit(null, 'SIGTERM');
      await expect(done).resolves.toBe(true);
      expect(session.suspended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
