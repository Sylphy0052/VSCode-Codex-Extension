import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime, formatRelativeTime } from '../../src/view/relativeTime';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('1分未満はたった今', () => {
    expect(formatRelativeTime(ago(30 * SECOND), NOW)).toBe('たった今');
  });

  it('分・時間・日で丸める', () => {
    expect(formatRelativeTime(ago(3 * MINUTE), NOW)).toBe('3分前');
    expect(formatRelativeTime(ago(2 * HOUR), NOW)).toBe('2時間前');
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe('3日前');
  });

  it('境界を跨いだ表記が変わる', () => {
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe('59分前');
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe('1時間前');
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe('23時間前');
  });

  it('1〜2日前は昨日', () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe('昨日');
    expect(formatRelativeTime(ago(2 * DAY - 1), NOW)).toBe('昨日');
  });

  it('7日以上前は日付にする', () => {
    expect(formatRelativeTime('2026-06-01T00:00:00Z', NOW)).toMatch(/^2026\/06\/0[12]$/);
  });

  it('未来の時刻でも壊れない', () => {
    expect(formatRelativeTime(new Date(NOW + HOUR).toISOString(), NOW)).toBe('たった今');
  });

  it('解釈できない値は空文字', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('formatAbsoluteTime', () => {
  it('日時を組み立てる', () => {
    expect(formatAbsoluteTime('2026-08-07T12:34:00Z')).toMatch(/^2026\/08\/0[78] \d{2}:\d{2}$/);
  });

  it('解釈できない値はそのまま返す', () => {
    expect(formatAbsoluteTime('unknown')).toBe('unknown');
  });
});
