import { describe, expect, it } from 'vitest';
import {
  STANDBY_PROBE_INTERVAL_MS,
  effectivePct,
  highestEffectivePct,
  isStandbyStale,
  pickReturnTarget,
  pickSwitchTarget,
  probeIntervalMs,
  reachedThreshold,
} from '../../src/claude/accountPolicy';
import type { SavedAccountLimit, SavedAccountView } from '../../src/claude/accountStore';

const NOW = 1_000_000_000;

function lim(pct: number, resetsAt?: number): SavedAccountLimit {
  return { pct, resetsAt };
}

function acct(
  id: string,
  priority: number,
  opts: {
    current?: boolean;
    five?: SavedAccountLimit;
    weekly?: SavedAccountLimit;
    noUsage?: boolean;
    recordedAt?: number;
  } = {},
): SavedAccountView {
  return {
    id,
    name: id,
    priority,
    email: undefined,
    current: opts.current ?? false,
    usage: opts.noUsage
      ? undefined
      : { recordedAt: opts.recordedAt ?? NOW, fiveHour: opts.five, weekly: opts.weekly },
  };
}

describe('isStandbyStale', () => {
  it('稼働中は古くない', () => {
    expect(isStandbyStale(acct('a', 1, { current: true, noUsage: true }), NOW)).toBe(false);
  });
  it('記録が無ければ古い', () => {
    expect(isStandbyStale(acct('a', 1, { noUsage: true }), NOW)).toBe(true);
  });
  it('間隔以上経っていれば古く、未満なら古くない', () => {
    expect(isStandbyStale(acct('a', 1, { recordedAt: NOW - STANDBY_PROBE_INTERVAL_MS }), NOW)).toBe(
      true,
    );
    expect(
      isStandbyStale(acct('a', 1, { recordedAt: NOW - STANDBY_PROBE_INTERVAL_MS + 1 }), NOW),
    ).toBe(false);
  });
});

describe('probeIntervalMs', () => {
  it('使用率の段階ごとの間隔', () => {
    expect(probeIntervalMs(0)).toBe(15 * 60_000);
    expect(probeIntervalMs(50)).toBe(15 * 60_000);
    expect(probeIntervalMs(51)).toBe(10 * 60_000);
    expect(probeIntervalMs(75)).toBe(10 * 60_000);
    expect(probeIntervalMs(76)).toBe(5 * 60_000);
    expect(probeIntervalMs(90)).toBe(5 * 60_000);
    expect(probeIntervalMs(91)).toBe(2 * 60_000);
  });
});

describe('effectivePct', () => {
  it('枠が無ければ0', () => {
    expect(effectivePct(undefined, NOW)).toBe(0);
  });
  it('解除時刻を過ぎていれば0', () => {
    expect(effectivePct(lim(80, NOW), NOW)).toBe(0);
    expect(effectivePct(lim(80, NOW - 1), NOW)).toBe(0);
  });
  it('解除時刻が未来または不明ならそのまま', () => {
    expect(effectivePct(lim(80, NOW + 1), NOW)).toBe(80);
    expect(effectivePct(lim(80), NOW)).toBe(80);
  });
});

describe('highestEffectivePct / reachedThreshold', () => {
  it('高い方を返す', () => {
    expect(highestEffectivePct(acct('a', 1, { five: lim(30), weekly: lim(60) }), NOW)).toBe(60);
    expect(highestEffectivePct(acct('a', 1, { five: lim(70), weekly: lim(60) }), NOW)).toBe(70);
  });
  it('記録が無ければ0', () => {
    expect(highestEffectivePct(acct('a', 1, { noUsage: true }), NOW)).toBe(0);
  });
  it('閾値以上で到達', () => {
    const a = acct('a', 1, { five: lim(95) });
    expect(reachedThreshold(a, 95, NOW)).toBe(true);
    expect(reachedThreshold(a, 96, NOW)).toBe(false);
  });
});

describe('pickSwitchTarget', () => {
  it('稼働中と閾値以上を除き、優先度順に選ぶ', () => {
    const list = [
      acct('cur', 1, { current: true }),
      acct('full', 2, { five: lim(99) }),
      acct('c', 4),
      acct('b', 3, { five: lim(10) }),
    ];
    expect(pickSwitchTarget(list, 95, NOW)?.id).toBe('b');
  });
  it('同じ優先度ならidの順', () => {
    const list = [acct('z', 2), acct('a', 2)];
    expect(pickSwitchTarget(list, 95, NOW)?.id).toBe('a');
  });
  it('リセット済みの枠は余裕あり。候補が無ければundefined', () => {
    expect(pickSwitchTarget([acct('x', 1, { five: lim(99, NOW - 1) })], 95, NOW)?.id).toBe('x');
    expect(pickSwitchTarget([acct('x', 1, { five: lim(99) })], 95, NOW)).toBeUndefined();
  });
});

describe('pickReturnTarget', () => {
  it('稼働中が無ければundefined', () => {
    expect(pickReturnTarget([acct('a', 1)], 95, NOW)).toBeUndefined();
  });
  it('稼働中より優先度が高く記録があり余裕のあるものを選ぶ', () => {
    const list = [
      acct('cur', 5, { current: true }),
      acct('norec', 1, { noUsage: true }),
      acct('full', 2, { weekly: lim(99) }),
      acct('lower', 6),
      acct('ok2', 4),
      acct('ok1', 3),
    ];
    expect(pickReturnTarget(list, 95, NOW)?.id).toBe('ok1');
  });
  it('最優先のアカウントが稼働中ならundefined', () => {
    expect(
      pickReturnTarget([acct('cur', 1, { current: true }), acct('b', 2)], 95, NOW),
    ).toBeUndefined();
  });
});
