import { describe, expect, it } from 'vitest';
import { readRateLimits } from '../../src/codex/usage';

const result = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1786937045 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: '1000' },
    planType: 'prolite',
  },
};

describe('readRateLimits', () => {
  it('primaryの使用率とリセット時刻を読む', () => {
    const snapshot = readRateLimits(result, '2026-08-10T09:00:00Z');
    expect(snapshot?.usedPercent).toBe(4);
    expect(snapshot?.windowMinutes).toBe(10080);
    expect(snapshot?.resetsAt).toBe(1786937045);
  });

  it('プランとクレジットを読む', () => {
    const snapshot = readRateLimits(result, '2026-08-10T09:00:00Z');
    expect(snapshot?.planType).toBe('prolite');
    expect(snapshot?.creditsBalance).toBe('1000');
    expect(snapshot?.hasCredits).toBe(true);
  });

  it('取得時刻を添える', () => {
    // 能動的に問い合わせた値なので、いつ時点かを必ず持たせる
    expect(readRateLimits(result, '2026-08-10T09:00:00Z')?.capturedAt).toBe('2026-08-10T09:00:00Z');
  });

  it('形が違えば undefined', () => {
    expect(readRateLimits(undefined, 'now')).toBeUndefined();
    expect(readRateLimits({}, 'now')).toBeUndefined();
    expect(readRateLimits({ rateLimits: { primary: null } }, 'now')).toBeUndefined();
  });

  it('使用率が数値でなければ採らない', () => {
    const broken = { rateLimits: { primary: { usedPercent: 'ninety' } } };
    expect(readRateLimits(broken, 'now')).toBeUndefined();
  });
});
