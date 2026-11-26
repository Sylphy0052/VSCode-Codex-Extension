import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildUsageHistory,
  loadUsageHistory,
  MAX_USAGE_HISTORY_POINTS,
  thin,
  USAGE_HISTORY_DAYS,
  usageHistorySince,
} from '../../src/view/usageHistory';
import {
  dayFileName,
  WORK_HISTORY_DIR_NAME,
  type WorkHistoryRecord,
  type WorkHistoryUsageRecord,
  type WorkHistoryUsageWindow,
} from '../../src/view/workHistory';
import {
  dailyScale,
  dailyTotal,
  formatDayLabel,
  formatPercent,
  latestPoint,
  maxPercent,
  percentToY,
  segmentPoints,
  timeToX,
} from '../../src/webview/missionControl/usageHistoryLogic';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 26, 12, 0, 0).getTime();
const WEEK_MS = 7 * DAY;

function at(day: number, hour: number): number {
  return new Date(2026, 10, day, hour, 0, 0).getTime();
}

function usage(
  time: number,
  windows: WorkHistoryUsageWindow[],
  overrides: Partial<WorkHistoryUsageRecord> = {},
): WorkHistoryUsageRecord {
  return { v: 1, kind: 'usage', at: time, windowId: 'w', provider: 'codex', windows, ...overrides };
}

function weekly(usedPercent: number, resetsAt: number, sampledAt?: number): WorkHistoryUsageWindow {
  return { label: '週次', usedPercent, resetsAt, windowMs: WEEK_MS, sampledAt, limited: false };
}

describe('usageHistorySince', () => {
  it('今日を含むN日前の0時を返す', () => {
    expect(usageHistorySince(NOW, 14)).toBe(new Date(2026, 10, 13, 0, 0, 0).getTime());
    expect(usageHistorySince(NOW, 1)).toBe(new Date(2026, 10, 26, 0, 0, 0).getTime());
  });
});

describe('buildUsageHistory', () => {
  it('期間の日を古い順に並べる', () => {
    const history = buildUsageHistory([], NOW, 3);
    expect(history.days).toEqual(['2026-11-24', '2026-11-25', '2026-11-26']);
    expect(history.since).toBe(at(24, 0));
    expect(history.until).toBe(NOW);
    expect(history.series).toEqual([]);
  });

  it('窓ごとの推移と、最大値を更新した分の日別の使用量を出す', () => {
    const reset = at(30, 0);
    const records: WorkHistoryRecord[] = [
      usage(at(24, 9), [weekly(10, reset)]),
      usage(at(24, 15), [weekly(14, reset)]),
      usage(at(25, 9), [weekly(20, reset)]),
      usage(at(26, 9), [weekly(25, reset)]),
    ];
    const history = buildUsageHistory(records, NOW, 3);
    expect(history.series).toHaveLength(1);
    const [series] = history.series;
    expect(series?.label).toBe('週次');
    expect(series?.windowMs).toBe(WEEK_MS);
    expect(series?.segments).toEqual([
      [
        { at: at(24, 9), usedPercent: 10 },
        { at: at(24, 15), usedPercent: 14 },
        { at: at(25, 9), usedPercent: 20 },
        { at: at(26, 9), usedPercent: 25 },
      ],
    ]);
    // 最初の点（10%）はそれより前の使用量が分からないので数えない
    expect(series?.daily).toEqual([4, 6, 5]);
  });

  it('リセット時刻が変わったら区切りを分け、リセット後は0から数える', () => {
    const records: WorkHistoryRecord[] = [
      usage(at(25, 9), [{ ...weekly(80, at(25, 12)), label: '5時間', windowMs: 5 * HOUR }]),
      usage(at(25, 11), [{ ...weekly(90, at(25, 12)), label: '5時間', windowMs: 5 * HOUR }]),
      usage(at(25, 13), [{ ...weekly(7, at(25, 18)), label: '5時間', windowMs: 5 * HOUR }]),
      usage(at(26, 9), [{ ...weekly(3, at(26, 14)), label: '5時間', windowMs: 5 * HOUR }]),
    ];
    const [series] = buildUsageHistory(records, NOW, 2).series;
    expect(series?.segments.map((s) => s.map((p) => p.usedPercent))).toEqual([[80, 90], [7], [3]]);
    expect(series?.daily).toEqual([10 + 7, 3]);
  });

  it('同じ区切りで値が上下しても、最大値を超えた分だけ数える', () => {
    const reset = at(30, 0);
    const records: WorkHistoryRecord[] = [
      usage(at(26, 1), [weekly(10, reset)]),
      usage(at(26, 2), [weekly(12, reset)]),
      usage(at(26, 3), [weekly(11, reset)], { windowId: 'other' }),
      usage(at(26, 4), [weekly(12, reset)]),
      usage(at(26, 5), [weekly(15, reset)]),
    ];
    const [series] = buildUsageHistory(records, NOW, 1).series;
    expect(series?.daily).toEqual([5]);
    expect(series?.segments).toHaveLength(1);
  });

  it('リセット時刻の数分の揺れでは区切らない', () => {
    const records: WorkHistoryRecord[] = [
      usage(at(26, 1), [weekly(10, at(30, 0))]),
      usage(at(26, 2), [weekly(12, at(30, 0) + 2 * 60 * 1000)]),
    ];
    const [series] = buildUsageHistory(records, NOW, 1).series;
    expect(series?.segments).toHaveLength(1);
    expect(series?.daily).toEqual([2]);
  });

  it('リセット時刻の分からない窓は、大きく下がったらリセットとみなす', () => {
    const window = (used: number): WorkHistoryUsageWindow => ({
      label: 'セッション',
      usedPercent: used,
      limited: false,
    });
    const records: WorkHistoryRecord[] = [
      usage(at(26, 1), [window(40)], { provider: 'claude' }),
      usage(at(26, 2), [window(38)], { provider: 'claude' }),
      usage(at(26, 3), [window(50)], { provider: 'claude' }),
      usage(at(26, 4), [window(5)], { provider: 'claude' }),
    ];
    const [series] = buildUsageHistory(records, NOW, 1).series;
    expect(series?.segments.map((s) => s.length)).toEqual([3, 1]);
    expect(series?.daily).toEqual([10 + 5]);
  });

  it('計測時刻があればそれを使い、複数ウィンドウの同じ値は1点にする', () => {
    const reset = at(30, 0);
    const sampled = at(26, 8);
    const records: WorkHistoryRecord[] = [
      usage(at(26, 9), [weekly(20, reset, sampled)]),
      usage(at(26, 10), [weekly(20, reset, sampled)], { windowId: 'other' }),
    ];
    const [series] = buildUsageHistory(records, NOW, 1).series;
    expect(series?.segments).toEqual([[{ at: sampled, usedPercent: 20 }]]);
  });

  it('計測時刻の無い窓は、全部の枠の最古の受け取り時刻（capturedAt）でなく値が変わった記録の時刻を使う', () => {
    // `capturedAt`は前日に届いた別の枠の時刻のまま。使うと全部の点が前日の1時刻へ寄る
    const captured = at(25, 8);
    const session = (used: number): WorkHistoryUsageWindow => ({
      label: 'セッション',
      usedPercent: used,
      limited: false,
    });
    const records: WorkHistoryRecord[] = [
      usage(at(26, 9), [session(10)], { provider: 'claude', capturedAt: captured }),
      usage(at(26, 10), [session(20)], { provider: 'claude', capturedAt: captured }),
      usage(at(26, 11), [session(30)], { provider: 'claude', capturedAt: captured }),
    ];
    const [series] = buildUsageHistory(records, NOW, 2).series;
    expect(series?.segments).toEqual([
      [
        { at: at(26, 9), usedPercent: 10 },
        { at: at(26, 10), usedPercent: 20 },
        { at: at(26, 11), usedPercent: 30 },
      ],
    ]);
    expect(series?.daily).toEqual([0, 20]);
  });

  it('計測時刻の無い窓で、別のウィンドウが古い値を書き直しても区切らず二重に数えない', () => {
    const session = (used: number): WorkHistoryUsageWindow => ({
      label: 'セッション',
      usedPercent: used,
      limited: false,
    });
    const records: WorkHistoryRecord[] = [
      usage(at(26, 1), [session(20)], { provider: 'claude', windowId: 'b' }),
      usage(at(26, 2), [session(40)], { provider: 'claude', windowId: 'a' }),
      // `b`はほかの枠が変わっただけで、古い20%を新しい時刻で書き直す
      usage(at(26, 3), [session(20)], { provider: 'claude', windowId: 'b' }),
      usage(at(26, 4), [session(45)], { provider: 'claude', windowId: 'a' }),
    ];
    const [series] = buildUsageHistory(records, NOW, 1).series;
    expect(series?.segments.map((s) => s.map((p) => p.usedPercent))).toEqual([[20, 40, 45]]);
    expect(series?.daily).toEqual([25]);
  });

  it('リセット時刻を過ぎてから残った値・期間外・使用率の無い窓は捨てる', () => {
    const records: WorkHistoryRecord[] = [
      usage(at(26, 9), [weekly(50, at(26, 8))]),
      usage(at(10, 9), [weekly(50, at(30, 0))]),
      usage(at(26, 9), [{ label: '週次', resetsAt: at(30, 0), limited: true }]),
    ];
    expect(buildUsageHistory(records, NOW, 3).series).toEqual([]);
  });

  it('Codex → Claude、窓の短い順に並べ、表示名を1行にする', () => {
    const reset = at(30, 0);
    const records: WorkHistoryRecord[] = [
      usage(at(26, 1), [weekly(10, reset)], { provider: 'claude' }),
      usage(at(26, 1), [
        weekly(10, reset),
        { ...weekly(5, at(26, 5)), label: '5時間\n偽の行', windowMs: 5 * HOUR },
      ]),
    ];
    const history = buildUsageHistory(records, NOW, 1);
    expect(history.series.map((s) => [s.provider, s.windowMs])).toEqual([
      ['codex', 5 * HOUR],
      ['codex', WEEK_MS],
      ['claude', WEEK_MS],
    ]);
    const label = history.series[0]?.label ?? '';
    expect(label.startsWith('5時間')).toBe(true);
    expect(label).toContain('偽の行');
    expect(label).not.toContain('\n');
  });

  it('点が多すぎたら間引く', () => {
    const reset = at(30, 0);
    const records: WorkHistoryRecord[] = [];
    for (let i = 0; i < MAX_USAGE_HISTORY_POINTS * 3; i += 1) {
      records.push(usage(at(26, 0) + i * 1000, [weekly((i / 30) % 100, reset)]));
    }
    const [series] = buildUsageHistory(records, NOW, 1).series;
    const total = series?.segments.reduce((sum, s) => sum + s.length, 0) ?? 0;
    expect(total).toBeLessThanOrEqual(MAX_USAGE_HISTORY_POINTS + 2);
    expect(total).toBeGreaterThan(0);
  });

  it('session記録は無視する', () => {
    const records: WorkHistoryRecord[] = [
      {
        v: 1,
        kind: 'session',
        at: at(26, 1),
        event: 'start',
        windowId: 'w',
        provider: 'codex',
        threadId: 't',
      },
    ];
    expect(buildUsageHistory(records, NOW, 1).series).toEqual([]);
  });
});

describe('thin', () => {
  it('区切りの最初と最後を残して間引く', () => {
    const segment = Array.from({ length: 10 }, (_, i) => ({ at: i, usedPercent: i }));
    const thinned = thin([segment], 5);
    expect(thinned[0]?.[0]).toEqual({ at: 0, usedPercent: 0 });
    expect(thinned[0]?.[thinned[0].length - 1]).toEqual({ at: 9, usedPercent: 9 });
    expect(thinned[0]?.length).toBeLessThan(10);
  });

  it('上限以下ならそのまま', () => {
    const segment = [{ at: 1, usedPercent: 1 }];
    expect(thin([segment], 5)).toEqual([segment]);
  });
});

describe('loadUsageHistory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-history-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('作業履歴のファイルから利用枠の推移を組む', async () => {
    const historyDir = join(dir, WORK_HISTORY_DIR_NAME);
    await mkdir(historyDir, { recursive: true });
    const reset = at(30, 0);
    const lines = [
      usage(at(25, 9), [weekly(10, reset)]),
      usage(at(26, 9), [weekly(18, reset)]),
      {
        v: 1,
        kind: 'session',
        at: at(26, 9),
        event: 'start',
        windowId: 'w',
        provider: 'codex',
        threadId: 't',
      },
    ];
    await writeFile(
      join(historyDir, dayFileName(at(25, 9))),
      `${JSON.stringify(lines[0])}\n`,
      'utf8',
    );
    await writeFile(
      join(historyDir, dayFileName(at(26, 9))),
      `${JSON.stringify(lines[1])}\n${JSON.stringify(lines[2])}\nnot json\n`,
      'utf8',
    );
    const history = await loadUsageHistory(dir, NOW);
    expect(history.days).toHaveLength(USAGE_HISTORY_DAYS);
    expect(history.series).toHaveLength(1);
    expect(history.series[0]?.daily.slice(-2)).toEqual([0, 8]);
  });

  it('作業履歴が無ければ空の推移を返す', async () => {
    const history = await loadUsageHistory(dir, NOW, 2);
    expect(history.series).toEqual([]);
    expect(history.days).toEqual(['2026-11-25', '2026-11-26']);
  });
});

describe('usageHistoryLogic', () => {
  const area = { left: 10, top: 0, width: 100, height: 50 };

  it('日付と使用率の表記', () => {
    expect(formatDayLabel('2026-11-05')).toBe('11/5');
    expect(formatDayLabel('bad')).toBe('bad');
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(7)).toBe('7%');
  });

  it('座標は描画範囲の中へ収める', () => {
    expect(timeToX(50, 0, 100, area)).toBe(60);
    expect(timeToX(-10, 0, 100, area)).toBe(10);
    expect(timeToX(200, 0, 100, area)).toBe(110);
    expect(timeToX(5, 5, 5, area)).toBe(110);
    expect(percentToY(100, area)).toBe(0);
    expect(percentToY(0, area)).toBe(50);
    expect(percentToY(150, area)).toBe(0);
    expect(
      segmentPoints(
        [
          { at: 0, usedPercent: 0 },
          { at: 100, usedPercent: 50 },
        ],
        0,
        100,
        area,
      ),
    ).toBe('10,50 110,25');
  });

  it('最新・最大・日別の基準と合計', () => {
    const series = {
      provider: 'codex' as const,
      label: '週次',
      segments: [[{ at: 1, usedPercent: 40 }], [{ at: 2, usedPercent: 5 }], []],
      daily: [3.25, 0, 12],
    };
    expect(latestPoint(series)).toEqual({ at: 2, usedPercent: 5 });
    expect(maxPercent(series)).toBe(40);
    expect(latestPoint({ ...series, segments: [] })).toBeUndefined();
    expect(maxPercent({ ...series, segments: [] })).toBeUndefined();
    expect(dailyScale(series.daily)).toBe(20);
    expect(dailyScale([0, 1])).toBe(10);
    expect(dailyTotal(series.daily)).toBe(15.3);
  });
});
