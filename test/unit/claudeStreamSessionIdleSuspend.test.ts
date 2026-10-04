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

  describe('発言の無い再開と、再開の失敗・dispose後の文言（Issue #1859）', () => {
    /** 書き込み済みのcontrol_requestから、指定した種類のrequest_idを取る。 */
    function requestIdOf(proc: FakeChildProcess, subtype: string): string {
      for (const w of proc.writes) {
        const parsed = JSON.parse(w) as { request_id?: string; request?: { subtype?: string } };
        if (parsed.request?.subtype === subtype && parsed.request_id !== undefined) {
          return parsed.request_id;
        }
      }
      throw new Error(`${subtype}のcontrol_requestが書き込まれていない`);
    }

    function respondOk(proc: FakeChildProcess, requestId: string, response: unknown): void {
      proc.emitStdout(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response },
        }),
      );
    }

    async function flush(): Promise<void> {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    it('休止中のcheckMcpStatusは、initializeの成功応答で再開を確定してから問い合わせる', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const status = session.checkMcpStatus();
      await flush();
      expect(procs).toHaveLength(2);
      expect(session.getState().processSuspension).toBe('resuming');
      // systemのinitは発言を送るまで届かない。initializeの応答だけで進む
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'initialize'), {});
      await flush();
      expect(session.getState().processSuspension).toBeUndefined();
      const mcpRequestId = requestIdOf(procs[1]!, 'mcp_status');
      respondOk(procs[1]!, mcpRequestId, { mcpServers: [{ name: 'a', status: 'connected' }] });
      await expect(status).resolves.toHaveLength(1);
      // 発言の無い再開は成功を通知しない（MCPの比較材料が無い）
      expect(outcomes).toHaveLength(0);
    });

    it('発言の無い再開が失敗したら、操作は再開できていない旨で失敗する', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const answer = session.askSideQuestion('これは？', []);
      await flush();
      procs[1]!.emitExit(1);
      await expect(answer).resolves.toMatchObject({
        ok: false,
        error: { message: '休止していた会話を再開できていません' },
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ kind: 'failed', text: '' });
    });

    /** 発言の無い再開をexitで失敗させ、`resumeFailed`にする。 */
    async function resumeFailedSession() {
      const ctx = createSession();
      await suspendSession(ctx.session, ctx.procs[0]!);
      const trigger = ctx.session.askSideQuestion('起こす', []);
      await flush();
      ctx.procs[1]!.emitExit(1);
      await trigger;
      expect(ctx.session.getState().processSuspension).toBe('resumeFailed');
      return ctx;
    }

    it('再開に失敗した後は、MCP追加・ファイル巻き戻し・会話巻き戻し・MCP確認も再開できていない旨で失敗する', async () => {
      const { session } = await resumeFailedSession();
      (session as unknown as { isForkSession: boolean }).isForkSession = true;
      await expect(session.ensureMcpServer('x', { command: 'c', args: [] })).rejects.toThrow(
        '休止していた会話を再開できていません',
      );
      await expect(session.previewRewindFiles('u1')).resolves.toMatchObject({
        ok: false,
        error: '休止していた会話を再開できていません',
      });
      await expect(session.applyRewindFiles('u1')).resolves.toMatchObject({
        ok: false,
        error: '休止していた会話を再開できていません',
      });
      await expect(session.rewindConversationToTurn(['u1'], 'u1')).resolves.toMatchObject({
        ok: false,
        error: { message: '休止していた会話を再開できていません' },
      });
      await expect(session.checkMcpStatus()).resolves.toBeUndefined();
    });

    it('dispose後は、各操作も起動していない旨で失敗する', async () => {
      const { session } = createSession();
      session.dispose();
      (session as unknown as { isForkSession: boolean }).isForkSession = true;
      await expect(session.ensureMcpServer('x', { command: 'c', args: [] })).rejects.toThrow(
        'セッションが起動していません',
      );
      await expect(session.previewRewindFiles('u1')).resolves.toMatchObject({
        error: 'セッションが起動していません',
      });
      await expect(session.rewindConversationToTurn(['u1'], 'u1')).resolves.toMatchObject({
        error: { message: 'セッションが起動していません' },
      });
    });

    function respondError(proc: FakeChildProcess, requestId: string, error: string): void {
      proc.emitStdout(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error },
        }),
      );
    }

    it('発言の無い再開でinitializeが失敗応答でも、CLIは動いているので再開を確定する', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const status = session.checkMcpStatus();
      await flush();
      // 通常の起動と同じく、承認を受けられないだけで会話は続く
      respondError(procs[1]!, requestIdOf(procs[1]!, 'initialize'), '初期化できません');
      await flush();
      expect(session.getState().processSuspension).toBeUndefined();
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'mcp_status'), { mcpServers: [] });
      await expect(status).resolves.toHaveLength(0);
      expect(outcomes).toHaveLength(0);
      expect(procs[1]!.kill).not.toHaveBeenCalled();
    });

    it('再開の最中に発言が来たら、initializeの成功応答では確定せずinitを待つ', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const status = session.checkMcpStatus();
      await flush();
      session.send('続き');
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'initialize'), {});
      await flush();
      expect(session.getState().processSuspension).toBe('resuming');
      procs[1]!.emitStdout(initEvent([]));
      await flush();
      expect(session.getState().processSuspension).toBeUndefined();
      expect(outcomes).toEqual([{ kind: 'resumed', mcpServers: [] }]);
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'mcp_status'), { mcpServers: [] });
      await expect(status).resolves.toHaveLength(0);
    });

    it('再開の最中に発言が来た後のinitialize失敗は確定せず、終了したら発言を添えて失敗を知らせる', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      void session.checkMcpStatus();
      await flush();
      session.send('続き');
      respondError(procs[1]!, requestIdOf(procs[1]!, 'initialize'), '初期化できません');
      await flush();
      expect(session.getState().processSuspension).toBe('resuming');
      procs[1]!.emitExit(1);
      expect(session.getState().processSuspension).toBe('resumeFailed');
      expect(outcomes).toEqual([expect.objectContaining({ kind: 'failed', text: '続き' })]);
    });

    it('再開の最中にdisposeしたら、待っている操作が戻り起動していない旨で失敗する', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const answer = session.askSideQuestion('これは？', []);
      await flush();
      expect(session.getState().processSuspension).toBe('resuming');
      session.dispose();
      await expect(answer).resolves.toMatchObject({
        ok: false,
        error: { message: 'セッションが起動していません' },
      });
      expect(() => session.send('続き')).toThrow('セッションが起動していません');
      expect(outcomes).toHaveLength(0);
    });

    it('initializeの成功で確定した後にCLIが終了しても、再開の失敗にはしない', async () => {
      const { session, procs, outcomes } = createSession();
      await suspendSession(session, procs[0]!);
      const status = session.checkMcpStatus();
      await flush();
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'initialize'), {});
      await flush();
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'mcp_status'), { mcpServers: [] });
      await status;
      procs[1]!.emitExit(1);
      // 再開は済んでいる。通常の「CLIが落ちた」と同じ扱い（`resumeFailed`の表示も新しい会話の提案も出さない）
      expect(session.getState().processSuspension).toBeUndefined();
      expect(outcomes).toHaveLength(0);
      expect(() => session.send('続き')).toThrow('セッションが起動していません');
    });

    it('発言の無い再開では、MCPの接続状態の比較を次に届くinitまで持ち越す', async () => {
      const { session, procs, outcomes } = createSession();
      session.send('最初');
      procs[0]!.emitStdout(initEvent([{ name: 'a', status: 'connected' }]));
      procs[0]!.emitStdout(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
      );
      await suspendSession(session, procs[0]!);
      const status = session.checkMcpStatus();
      await flush();
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'initialize'), {});
      await flush();
      respondOk(procs[1]!, requestIdOf(procs[1]!, 'mcp_status'), { mcpServers: [] });
      await status;
      expect(outcomes).toHaveLength(0);
      session.send('続き');
      procs[1]!.emitStdout(initEvent([{ name: 'a', status: 'failed' }]));
      expect(outcomes).toEqual([
        { kind: 'resumed', mcpServers: [{ name: 'a', status: 'failed' }] },
      ]);
      // 2回目以降のinitでは報告しない
      procs[1]!.emitStdout(initEvent([{ name: 'a', status: 'connected' }]));
      expect(outcomes).toHaveLength(1);
    });

    it('再開に失敗した後のsendは、再開できていない旨で弾く', async () => {
      const { session, procs } = createSession();
      await suspendSession(session, procs[0]!);
      session.send('続き');
      procs[1]!.emitExit(1);
      expect(() => session.send('もう一度')).toThrow('休止していた会話を再開できていません');
    });

    it('dispose後のsendは、再開の失敗ではなく起動していない旨で弾く', () => {
      const { session } = createSession();
      session.dispose();
      expect(() => session.send('続き')).toThrow('セッションが起動していません');
    });

    it('休止中にdisposeしても、その後のsendと操作は起動していない旨で失敗する', async () => {
      const { session, procs } = createSession();
      await suspendSession(session, procs[0]!);
      session.dispose();
      expect(() => session.send('続き')).toThrow('セッションが起動していません');
      await expect(session.askSideQuestion('これは？', [])).resolves.toMatchObject({
        ok: false,
        error: { message: 'セッションが起動していません' },
      });
      expect(procs).toHaveLength(1);
    });
  });
});

describe('ClaudeStreamSession: 効いている承認方法の後始末（Issue #1888・#1890）', () => {
  const statusEvent = (permissionMode: string): string =>
    JSON.stringify({ type: 'system', subtype: 'status', permissionMode, uuid: 's1' });

  it('CLIのプロセスが消えたら、効いている承認方法をundefinedへ戻す', () => {
    const { session, procs } = createSession();
    procs[0]!.emitStdout(statusEvent('acceptEdits'));
    expect(session.getState().permissionMode).toBe('acceptEdits');

    procs[0]!.emitExit(1);

    expect(session.hasProcess).toBe(false);
    expect(session.getState().permissionMode).toBeUndefined();
  });

  it('休止させたら、効いている承認方法をundefinedへ戻す', async () => {
    const { session, procs } = createSession();
    procs[0]!.emitStdout(statusEvent('acceptEdits'));
    expect(session.getState().permissionMode).toBe('acceptEdits');

    await suspendSession(session, procs[0]!);

    expect(session.getState().permissionMode).toBeUndefined();
  });
});
