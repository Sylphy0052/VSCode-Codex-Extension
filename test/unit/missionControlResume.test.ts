import { describe, expect, it, vi } from 'vitest';
import {
  parseRunningTurns,
  RUNNING_TURN_REMOVAL_DELAY_MS,
  RunningTurnJournal,
  type RunningTurnEntry,
  type RunningTurnSession,
} from '../../src/view/missionControlResume';

function session(over: Partial<RunningTurnSession> = {}): RunningTurnSession {
  return {
    provider: 'codex',
    threadId: 't1',
    title: 'タイトル',
    cwd: '/w/app',
    activity: 'running',
    ...over,
  };
}

function setup(initial: unknown = []) {
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  const update = vi.fn((_value: RunningTurnEntry[]) => Promise.resolve());
  let clock = 1000;
  const journal = new RunningTurnJournal({ get: () => initial, update }, () => clock, {
    set: (cb, ms) => {
      const t = { cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clear: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return {
    journal,
    update,
    timers,
    tick: (ms: number) => {
      clock += ms;
    },
    fire: (i: number) => timers[i]?.cb(),
  };
}

describe('parseRunningTurns（Issue #2138）', () => {
  it('配列でなければ空', () => {
    expect(parseRunningTurns(undefined)).toEqual([]);
    expect(parseRunningTurns({})).toEqual([]);
  });

  it('形の合わない要素を捨て、cwdが文字列でなければundefinedにする', () => {
    const good = { provider: 'claude', threadId: 'a', title: 'T', since: 1, cwd: '/x' };
    const result = parseRunningTurns([
      good,
      null,
      'str',
      { ...good, provider: 'gemini' },
      { ...good, threadId: '' },
      { ...good, threadId: 5 },
      { ...good, title: 1 },
      { ...good, since: '1' },
      { ...good, threadId: 'b', cwd: 3 },
    ]);
    expect(result).toEqual([
      { provider: 'claude', threadId: 'a', title: 'T', since: 1, cwd: '/x' },
      { provider: 'claude', threadId: 'b', title: 'T', since: 1, cwd: undefined },
    ]);
  });

  it('先頭50件だけ読む', () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      provider: 'codex',
      threadId: `t${String(i)}`,
      title: 'T',
      since: 1,
    }));
    expect(parseRunningTurns(items)).toHaveLength(50);
  });
});

describe('RunningTurnJournal', () => {
  it('takePrevious: 前回の分を返し、保存領域を空にする', () => {
    const { journal, update } = setup([
      { provider: 'codex', threadId: 'a', title: 'T', since: 1 },
      { bad: true },
    ]);
    expect(journal.takePrevious()).toHaveLength(1);
    expect(update).toHaveBeenCalledWith([]);
  });

  it('実行中の会話を書く。idle以外（承認待ち等）も実行中扱い', () => {
    const { journal, update } = setup();
    journal.observe([session(), session({ threadId: 't2', activity: 'approvalPending' })]);
    expect(update).toHaveBeenCalledTimes(1);
    const written = update.mock.calls[0]?.[0] ?? [];
    expect(written.map((e) => e.threadId)).toEqual(['t1', 't2']);
    expect(written[0]).toMatchObject({ provider: 'codex', title: 'タイトル', since: 1000 });
  });

  it('同じ内容の再observeでは書き直さない', () => {
    const { journal, update } = setup();
    journal.observe([session()]);
    journal.observe([session()]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('タイトルやcwdが変わったら書き直す', () => {
    const { journal, update } = setup();
    journal.observe([session()]);
    journal.observe([session({ title: '別' })]);
    journal.observe([session({ title: '別', cwd: '/w/b' })]);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('idleへ戻ってもすぐには外さず、待ち時間後に外す', () => {
    const { journal, update, timers, fire } = setup();
    journal.observe([session()]);
    journal.observe([session({ activity: 'idle' })]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(RUNNING_TURN_REMOVAL_DELAY_MS);
    expect(update).toHaveBeenCalledTimes(1);
    fire(0);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toEqual([]);
  });

  it('待ち時間中に実行中へ戻れば外す予約を取り消す', () => {
    const { journal, update, timers } = setup();
    journal.observe([session()]);
    journal.observe([session({ activity: 'idle' })]);
    journal.observe([session()]);
    expect(timers[0]?.cleared).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('一覧から消えた会話も待ってから外す。二重に予約しない', () => {
    const { journal, update, timers, fire } = setup();
    journal.observe([session()]);
    journal.observe([]);
    journal.observe([]);
    expect(timers).toHaveLength(1);
    fire(0);
    expect(update).toHaveBeenLastCalledWith([]);
  });

  it('外す前にObserveされていない（未記録の）idleは予約しない', () => {
    const { journal, timers } = setup();
    journal.observe([session({ activity: 'idle' })]);
    expect(timers).toHaveLength(0);
  });

  it('dispose: 予約中のタイマーを解除する', () => {
    const { journal, timers } = setup();
    journal.observe([session()]);
    journal.observe([]);
    journal.dispose();
    expect(timers[0]?.cleared).toBe(true);
  });

  it('50件を超えて書かない', () => {
    const { journal, update } = setup();
    journal.observe(Array.from({ length: 60 }, (_, i) => session({ threadId: `t${String(i)}` })));
    expect(update.mock.calls[0]?.[0]).toHaveLength(50);
  });
});
