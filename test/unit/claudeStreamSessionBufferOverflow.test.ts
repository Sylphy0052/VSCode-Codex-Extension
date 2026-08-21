import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../../src/claude/streamSession';
import { emptyClaudeConfig } from '../../src/claude/types';
import type { Logger } from '../../src/log';
import { KILL_ESCALATION_DELAY_MS } from '../../src/codex/jsonRpc';
import { MAX_LINE_BUFFER_BYTES } from '../../src/util/ndjson';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/**
 * `child_process.spawn` の最低限の形を模したフェイク（`claudeStreamSessionExitRelease.test.ts`
 * と同じ方針）。`EventEmitter`を継承しているため`kill()`後の`once('exit', ...)`
 * （issue #402のSIGKILLエスカレーション）もそのまま扱える。
 */
class FakeChildProcess extends EventEmitter {
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write: (_chunk: string) => true,
    end: () => undefined,
  });
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

function createStartedSession(
  onCommands: (commands: readonly { name: string }[]) => void = () => undefined,
): {
  session: ClaudeStreamSession;
  proc: FakeChildProcess;
} {
  const proc = new FakeChildProcess();
  const spawnProcess: ClaudeSpawnPort = () => proc as unknown as ChildProcessWithoutNullStreams;
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    () => undefined,
    onCommands,
    undefined,
    spawnProcess,
  );
  session.start({
    cwd: '/w',
    target: { kind: 'new' },
    sessionId: '11111111-1111-1111-1111-111111111111',
    config: emptyClaudeConfig,
  });
  return { session, proc };
}

describe('ClaudeStreamSession: 受信バッファの上限（issue #402、1点目）', () => {
  it('改行を含まない出力が上限を超えて届くと、セッションを打ち切りturnFailedにする', () => {
    const { session, proc } = createStartedSession();

    // 改行を一切含まない巨大な出力（診断ログの乱れ・バイナリ混入等を模す）
    session.receive('x'.repeat(MAX_LINE_BUFFER_BYTES + 1));

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(session.getState().busy).toBe(false);
    expect(session.getState().turnFailed).toBe(true);
  });

  it('上限以内の出力（改行なしでも）ではプロセスを打ち切らない', () => {
    const { session, proc } = createStartedSession();

    session.receive('x'.repeat(1024));

    expect(proc.kill).not.toHaveBeenCalled();
    expect(session.getState().turnFailed).toBe(false);
  });

  it('同じチャンクに正常なイベントと上限超過の未完成行が同居しても、正常なイベントは処理される（レビュー指摘・MEDIUM）', () => {
    const { session, proc } = createStartedSession();

    const commandsChangedLine = `${JSON.stringify({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'compact', description: '要約する', argumentHint: '' }],
    })}
`;
    // 同じチャンクの中に、改行を含まない上限超過分（未完成行）を同居させる
    const overflowTail = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);
    session.receive(commandsChangedLine + overflowTail);

    // overflowより先にvaluesが処理されるため、正常だったイベントは握りつぶされない
    expect(session.commands.map((c) => c.name)).toEqual(['compact']);
    // その後、上限超過分でセッションは打ち切られる
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(session.getState().turnFailed).toBe(true);
  });

  it('onCommandsが同期的に例外を投げても、overflow時の後始末（プロセス打ち切り）は行われる（レビュー指摘・LOW）', () => {
    const { session, proc } = createStartedSession(() => {
      throw new Error('boom');
    });

    const commandsChangedLine = `${JSON.stringify({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'compact', description: '要約する', argumentHint: '' }],
    })}
`;
    const overflowTail = 'x'.repeat(MAX_LINE_BUFFER_BYTES + 1);

    // onCommandsの例外はforループ内で起きるため、receive()の外まで伝播する
    // （try/finallyは握り潰さない。ここではfinallyでの後始末だけを確かめる）
    expect(() => {
      session.receive(commandsChangedLine + overflowTail);
    }).toThrow('boom');

    // 例外が起きても、finally側の後始末（プロセス打ち切り）は実行される
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(session.getState().turnFailed).toBe(true);
  });
});

describe('ClaudeStreamSession: SIGKILLエスカレーション（issue #402、2点目）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispose()後、SIGTERMに応答しないプロセスは猶予後にSIGKILLされる', () => {
    const { session, proc } = createStartedSession();

    session.dispose();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenNthCalledWith(1);

    vi.advanceTimersByTime(KILL_ESCALATION_DELAY_MS);
    expect(proc.kill).toHaveBeenCalledTimes(2);
    expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('dispose()後にexitが届けば、SIGKILLタイマーは残らない（自己レビュー: 正常終了後の残留確認）', () => {
    const { session, proc } = createStartedSession();

    session.dispose();
    proc.emit('exit', 0);
    vi.advanceTimersByTime(KILL_ESCALATION_DELAY_MS);

    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});
