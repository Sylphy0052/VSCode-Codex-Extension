import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `start()`を2回呼び、1回目のプロセス（古い世代）と2回目のプロセス（現世代）の両方を
 * 露出する。`connection.ts`のCRITICAL（issue #419）と同種の欠陥が`streamSession.ts`にも
 * 残っていたため（レビュー指摘・HIGH 2）、古い世代からの遅延通知が新しい世代のターンを
 * 壊さないことを確かめる。
 */
function createSessionWithStaleGeneration(): {
  session: ClaudeStreamSession;
  proc1: ChildProcessWithoutNullStreams;
  proc2: ChildProcessWithoutNullStreams;
} {
  const { proc: proc1 } = createFakeChildProcess();
  const { proc: proc2 } = createFakeChildProcess();
  const procs = [proc1, proc2];
  let calls = 0;
  const spawnProcess: ClaudeSpawnPort = () => {
    const proc = procs[calls] ?? proc2;
    calls += 1;
    return proc;
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
  const startOptions = {
    cwd: '/w',
    target: { kind: 'new' as const },
    sessionId: '11111111-1111-1111-1111-111111111111',
    config: emptyClaudeConfig,
  };
  session.start(startOptions);
  // 2回目のstart()で新しい世代（proc2）へ切り替える。以降proc1は古い世代となる
  session.start({ ...startOptions, sessionId: '22222222-2222-2222-2222-222222222222' });
  return { session, proc1, proc2 };
}

describe('ClaudeStreamSession: 古い世代のプロセスからの通知を捨てる（issue #419、レビュー指摘・HIGH 2）', () => {
  it('古い世代（proc1）のexitが遅れて届いても、新しいターンをturnFailedにしない', () => {
    const { session, proc1 } = createSessionWithStaleGeneration();
    expect(session.getState().turnFailed).toBe(false);

    // 修正前はexitハンドラが世代を見ずに`this.proc = undefined` + `turnFailed: true`を
    // 適用してしまい、proc2で始まったばかりの新しいターンを落としていた
    proc1.emit('exit', 1);

    expect(session.getState().turnFailed).toBe(false);
  });

  it('古い世代（proc1）のerrorが遅れて届いても、新しいターンをturnFailedにしない', () => {
    const { session, proc1 } = createSessionWithStaleGeneration();

    proc1.emit('error', new Error('old generation crashed late'));

    expect(session.getState().turnFailed).toBe(false);
  });

  it('古い世代（proc1）のstdinエラーが遅れて届いても、新しいターンをturnFailedにしない', () => {
    const { session, proc1 } = createSessionWithStaleGeneration();

    proc1.stdin.emit('error', new Error('EPIPE'));

    expect(session.getState().turnFailed).toBe(false);
  });

  it('古い世代（proc1）のstdout出力が遅れて届いても、新しいセッションの状態を汚さない', () => {
    const { session, proc1 } = createSessionWithStaleGeneration();

    // commands_changedのような、状態を書き換えるイベントを古い世代から流し込む。
    // 修正前は世代を見ずに`this.receive()`が動くため、これがそのまま反映されてしまっていた
    const line = `${JSON.stringify({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'stale-command', description: '古い世代由来', argumentHint: '' }],
    })}\n`;
    proc1.stdout.emit('data', Buffer.from(line));

    expect(session.commands).toEqual([]);
    expect(session.getState().turnFailed).toBe(false);
  });
});
