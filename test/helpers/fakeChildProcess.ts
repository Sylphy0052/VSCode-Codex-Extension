import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { vi } from 'vitest';

/**
 * `child_process.spawn`が返す最低限の形を模したフェイク（issue #419、5点目）。
 *
 * `connection.test.ts` / `appServerClientRobustness.test.ts` /
 * `claudeStreamSessionExitRelease.test.ts` / `claudeStreamSessionBufferOverflow.test.ts` /
 * `jsonRpc.test.ts`（現`childProcess.test.ts`）がそれぞれ独自に持っていた、ほぼ同一の
 * フェイク実装を1本化する。`proc`自体が`EventEmitter`を継承しているため、
 * `proc.emit('exit', code)` / `proc.stdout.emit('data', chunk)`のように直接扱うことも、
 * `emitExit()` / `emitStdout()`の補助関数越しに扱うこともできる。
 */
export interface FakeChildProcess {
  /** `ChildProcessWithoutNullStreams`として渡せるフェイク本体（`EventEmitter`を継承）。 */
  proc: ChildProcessWithoutNullStreams;
  /** `vi.fn`化した`kill`。呼び出し回数・引数（SIGTERM相当かSIGKILLか）を検証できる。 */
  kill: ReturnType<typeof vi.fn>;
  /** `stdin.write()`に渡された内容を送信順に集める（`request()`の要求id取り出し等に使う）。 */
  writes: string[];
  /** stdoutへ1行分（改行込み）のデータを流す。 */
  emitStdout: (line: string) => void;
  /** `exit`イベントを発火する。 */
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

export interface FakeChildProcessOptions {
  /**
   * `kill()`を呼んだ瞬間に同期的に`exit`を発火させるか（既定は`false`）。
   *
   * `killWithEscalation`のTDZ回帰テスト（issue #419、2点目）専用のオプション。
   * `kill()`が同期的に`exit`を出す実装を再現し、`timer`変数の初期化前に
   * `once('exit', ...)`ハンドラが走ってもエラーにならないことを確かめる。
   */
  syncExitOnKill?: boolean;
}

export function createFakeChildProcess(options: FakeChildProcessOptions = {}): FakeChildProcess {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => undefined,
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams & { killed: boolean };

  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    proc.killed = true;
    if (options.syncExitOnKill) {
      emitter.emit('exit', null, typeof signal === 'string' ? signal : null);
    }
    return true;
  });
  Object.assign(proc, { kill });

  return {
    proc,
    kill,
    writes,
    emitStdout: (line: string) => stdout.emit('data', Buffer.from(`${line}\n`)),
    emitExit: (code: number | null, signal: NodeJS.Signals | null = null) =>
      emitter.emit('exit', code, signal),
  };
}
