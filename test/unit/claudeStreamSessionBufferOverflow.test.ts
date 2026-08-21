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

function createStartedSession(): {
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
    () => undefined,
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
