import { describe, expect, it, vi } from 'vitest';
import {
  canWriteStdin,
  guardStdinErrors,
  safeWriteStdin,
  type StdinProcessLike,
} from '../../src/process/stdinSafety';

interface FakeProc {
  proc: StdinProcessLike;
  write: ReturnType<typeof vi.fn>;
  emitError: (error: Error) => void;
}

function fakeProc(
  overrides: Partial<{ killed: boolean; destroyed: boolean; writable: boolean }> = {},
): FakeProc {
  const errorListeners: Array<(error: Error) => void> = [];
  const write = vi.fn(() => true);
  const proc: StdinProcessLike = {
    killed: overrides.killed ?? false,
    stdin: {
      destroyed: overrides.destroyed ?? false,
      writable: overrides.writable ?? true,
      write,
      on: (event, listener) => {
        if (event === 'error') {
          errorListeners.push(listener);
        }
      },
    },
  };
  return {
    proc,
    write,
    emitError: (error: Error) => {
      for (const listener of errorListeners) {
        listener(error);
      }
    },
  };
}

describe('canWriteStdin', () => {
  it('プロセスもstdinも生きていればtrue', () => {
    const { proc } = fakeProc();
    expect(canWriteStdin(proc)).toBe(true);
  });

  it('プロセスがkilledならfalse', () => {
    const { proc } = fakeProc({ killed: true });
    expect(canWriteStdin(proc)).toBe(false);
  });

  it('stdinがdestroyedならfalse', () => {
    const { proc } = fakeProc({ destroyed: true });
    expect(canWriteStdin(proc)).toBe(false);
  });

  it('stdinがwritableでないならfalse', () => {
    const { proc } = fakeProc({ writable: false });
    expect(canWriteStdin(proc)).toBe(false);
  });
});

describe('safeWriteStdin', () => {
  it('生存判定を通れば書き込んでtrueを返す', () => {
    const { proc, write } = fakeProc();
    expect(safeWriteStdin(proc, 'hello')).toBe(true);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('死んでいれば書き込まずfalseを返す（killed）', () => {
    const { proc, write } = fakeProc({ killed: true });
    expect(safeWriteStdin(proc, 'hello')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('死んでいれば書き込まずfalseを返す（stdin destroyed）', () => {
    const { proc, write } = fakeProc({ destroyed: true });
    expect(safeWriteStdin(proc, 'hello')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('guardStdinErrors', () => {
  it('stdinのerrorイベントをonErrorへ転送する', () => {
    const { proc, emitError } = fakeProc();
    const onError = vi.fn();
    guardStdinErrors(proc, onError);

    const error = new Error('write EPIPE');
    emitError(error);

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('複数回errorが飛んでも都度転送する', () => {
    const { proc, emitError } = fakeProc();
    const onError = vi.fn();
    guardStdinErrors(proc, onError);

    emitError(new Error('write EPIPE'));
    emitError(new Error('write EPIPE'));

    expect(onError).toHaveBeenCalledTimes(2);
  });
});
