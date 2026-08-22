import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killWithEscalation, KILL_ESCALATION_DELAY_MS } from '../../src/process/childProcess';
import { createFakeChildProcess } from '../helpers/fakeChildProcess';

describe('killWithEscalation（issue #402、2点目）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('まずSIGTERM相当（既定シグナル）を送る', () => {
    const { proc, kill } = createFakeChildProcess();
    killWithEscalation(proc);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith();
  });

  it('猶予時間内にexitが届かなければSIGKILLへエスカレーションする', () => {
    const { proc, kill } = createFakeChildProcess();
    killWithEscalation(proc);
    vi.advanceTimersByTime(KILL_ESCALATION_DELAY_MS);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('猶予時間内にexitが届けばSIGKILLを送らず、タイマーも残らない（自己レビュー: 正常終了後の残留確認）', () => {
    const { proc, kill, emitExit } = createFakeChildProcess();
    killWithEscalation(proc);
    emitExit(0, null);
    vi.advanceTimersByTime(KILL_ESCALATION_DELAY_MS);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('kill()が同期的にexitを発火させても、TDZのReferenceErrorを踏まない（issue #419、2点目）', () => {
    // `dispose()`の途中で同期的にexitを出すフェイク（JSDocが「EventEmitterベースの
    // フェイクをそのまま使える」と誘っている形）を再現する。修正前は`const timer`が
    // `proc.kill()`の後に置かれており、`once('exit', ...)`ハンドラのクロージャに
    // 閉じ込めた`timer`をこの時点で参照するとTDZの`ReferenceError`が飛んでいた
    const { proc, kill } = createFakeChildProcess({ syncExitOnKill: true });
    expect(() => killWithEscalation(proc)).not.toThrow();
    // 同期的にexitが確定しているため、SIGKILLへのエスカレーションタイマーは不要
    // （猶予時間を進めてもSIGKILLは送られない）
    vi.advanceTimersByTime(KILL_ESCALATION_DELAY_MS);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
