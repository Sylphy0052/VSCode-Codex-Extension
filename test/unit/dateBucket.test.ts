import { describe, expect, it } from 'vitest';
import { dateBucketFor } from '../../src/util/dateBucket';

/** ローカル時刻の日時からISO文字列を作る（`Date.parse`との往復でTZに依存させないため）。 */
const iso = (y: number, m: number, d: number, h = 0, mi = 0): string =>
  new Date(y, m - 1, d, h, mi).toISOString();

// 2026-08-16(日) 12:00 を「今」とする
const NOW = new Date(2026, 7, 16, 12, 0).getTime();

describe('dateBucketFor（issue #293、design.md §14.54）', () => {
  it('直近12時間は日付に関わらず12時間以内', () => {
    expect(dateBucketFor(iso(2026, 8, 16, 0, 0), NOW)).toBe('recent');
    expect(dateBucketFor(iso(2026, 8, 16, 11, 59), NOW)).toBe('recent');
  });

  it('同じ暦日でも12時間より前なら今日', () => {
    expect(dateBucketFor(iso(2026, 8, 16, 0, 0), NOW + 1)).toBe('today');
    expect(dateBucketFor(iso(2026, 8, 16, 23, 59), NOW)).toBe('today');
  });

  it('前日の暦日は昨日（時刻に関わらず）', () => {
    expect(dateBucketFor(iso(2026, 8, 15, 0, 0), NOW)).toBe('yesterday');
    expect(dateBucketFor(iso(2026, 8, 15, 23, 59), NOW)).toBe('yesterday');
  });

  it('2日前〜7日前は今週', () => {
    expect(dateBucketFor(iso(2026, 8, 14, 23, 59), NOW)).toBe('thisWeek');
    expect(dateBucketFor(iso(2026, 8, 9, 0, 0), NOW)).toBe('thisWeek');
  });

  it('8日以上前はそれ以前', () => {
    expect(dateBucketFor(iso(2026, 8, 8, 23, 59), NOW)).toBe('older');
    expect(dateBucketFor(iso(2026, 1, 1, 0, 0), NOW)).toBe('older');
  });

  it('日付をまたいでも直近12時間なら12時間以内になる', () => {
    const midnightNow = new Date(2026, 7, 16, 0, 30).getTime();
    expect(dateBucketFor(iso(2026, 8, 15, 23, 59), midnightNow)).toBe('recent');
    expect(dateBucketFor(iso(2026, 8, 16, 0, 5), midnightNow)).toBe('recent');
  });

  it('未来のタイムスタンプは今日に丸める（クロックのずれ対策）', () => {
    expect(dateBucketFor(iso(2026, 8, 20, 0, 0), NOW)).toBe('today');
  });

  it('解釈できない値はそれ以前に倒す（未知の入力で壊さない）', () => {
    expect(dateBucketFor('not-a-date', NOW)).toBe('older');
  });
});
