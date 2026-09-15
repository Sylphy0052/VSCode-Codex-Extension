import { describe, expect, it } from 'vitest';
import {
  formatWindowLabel,
  mergeRateLimitWindows,
  parseTokenCountLine,
  readRateLimits,
  readRateLimitSnapshotWindows,
  summarizeRateLimitWindows,
  type RateLimitWindowInfo,
} from '../../src/codex/usage';

/**
 * 制限枠の窓（issue #1212）。Codexの制限は枠（`limitId`）ごとに短い窓（primary）と
 * 長い窓（secondary）を持ち、片方だけが100%に達しうる。
 */
const win = (
  slot: 'primary' | 'secondary',
  usedPercent: number,
  windowMinutes: number | undefined = undefined,
  resetsAt: number | undefined = undefined,
  limitId: string | undefined = 'codex',
): RateLimitWindowInfo => ({ limitId, slot, usedPercent, windowMinutes, resetsAt });

describe('summarizeRateLimitWindows', () => {
  it('窓が無ければ何も決めない', () => {
    expect(summarizeRateLimitWindows([])).toEqual({
      usedPercent: undefined,
      windowMinutes: undefined,
      resetsAt: undefined,
      limited: undefined,
    });
  });

  it('secondaryだけが上限でも上限として扱う', () => {
    const summary = summarizeRateLimitWindows([
      win('primary', 20, 300, 1_000),
      win('secondary', 100, 10080, 9_000),
    ]);
    expect(summary.limited).toBe(true);
    // 見出しの数字は最も逼迫した窓
    expect(summary.usedPercent).toBe(100);
    // 待ち時間の基準は阻害している窓
    expect(summary.resetsAt).toBe(9_000);
    expect(summary.windowMinutes).toBe(10080);
  });

  it('上限に達した窓が複数あれば、最も遅いリセット時刻を採る', () => {
    const summary = summarizeRateLimitWindows([
      win('primary', 100, 300, 1_000),
      win('secondary', 100, 10080, 9_000),
    ]);
    expect(summary.resetsAt).toBe(9_000);
  });

  it('上限が無ければ最も逼迫した窓のリセット時刻を採る', () => {
    const summary = summarizeRateLimitWindows([
      win('primary', 20, 300, 1_000),
      win('secondary', 80, 10080, 9_000),
    ]);
    expect(summary.limited).toBe(false);
    expect(summary.usedPercent).toBe(80);
    expect(summary.resetsAt).toBe(9_000);
  });

  it('別のlimitIdの窓が上限でも上限として扱う', () => {
    const summary = summarizeRateLimitWindows([
      win('primary', 5, 300, 1_000, 'codex'),
      win('primary', 100, 300, 2_000, 'codex-mini'),
    ]);
    expect(summary.limited).toBe(true);
    expect(summary.resetsAt).toBe(2_000);
  });
});

describe('mergeRateLimitWindows', () => {
  it('疎な更新で触れられていない窓は残る', () => {
    const merged = mergeRateLimitWindows(
      [win('primary', 10, 300, 1_000), win('secondary', 100, 10080, 9_000)],
      [win('primary', 30, 300, 1_000)],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((w) => w.slot === 'primary')?.usedPercent).toBe(30);
    expect(merged.find((w) => w.slot === 'secondary')?.usedPercent).toBe(100);
  });

  it('更新に長さ・リセット時刻が無ければ前の値を引き継ぐ', () => {
    const merged = mergeRateLimitWindows(
      [win('primary', 10, 300, 1_000)],
      [win('primary', 40, undefined, undefined)],
    );
    expect(merged[0]).toEqual(win('primary', 40, 300, 1_000));
  });

  it('別のlimitIdは別の窓として足す', () => {
    const merged = mergeRateLimitWindows(
      [win('primary', 10, 300, 1_000, 'codex')],
      [win('primary', 90, 300, 2_000, 'codex-mini')],
    );
    expect(merged).toHaveLength(2);
  });
});

describe('readRateLimitSnapshotWindows', () => {
  it('primaryとsecondaryの両方を読む', () => {
    const windows = readRateLimitSnapshotWindows({
      limitId: 'codex',
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_000 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 9_000 },
    });
    expect(windows).toEqual([win('primary', 20, 300, 1_000), win('secondary', 100, 10080, 9_000)]);
  });

  it('使用率が数値でない窓は採らない', () => {
    const windows = readRateLimitSnapshotWindows({
      limitId: 'codex',
      primary: { usedPercent: 'ninety' },
      secondary: null,
    });
    expect(windows).toEqual([]);
  });
});

describe('readRateLimits / 複数の制限枠', () => {
  it('rateLimitsByLimitIdの全枠を読み、上限の枠を優先する', () => {
    const snapshot = readRateLimits(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_000 },
          secondary: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_000 },
            secondary: null,
          },
          'codex-mini': {
            limitId: 'codex-mini',
            primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 9_000 },
            secondary: null,
          },
        },
      },
      '2026-09-14T00:00:00Z',
    );
    expect(snapshot?.windows).toHaveLength(2);
    expect(snapshot?.usedPercent).toBe(100);
    expect(snapshot?.resetsAt).toBe(9_000);
  });

  it('枠が識別子を持たなければマップのキーで区別する', () => {
    // `RateLimitSnapshot.limitId` は null を取りうる。キーで区別しないと、識別子無しの
    // 2枠が同じ枠と見なされ、窓を重ねるときに互いを消す
    const snapshot = readRateLimits(
      {
        rateLimits: null,
        rateLimitsByLimitId: {
          codex: { limitId: null, primary: { usedPercent: 10 }, secondary: null },
          'codex-mini': { limitId: null, primary: { usedPercent: 100 }, secondary: null },
        },
      },
      'now',
    );
    expect(snapshot?.windows.map((w) => w.limitId)).toEqual(['codex', 'codex-mini']);
    expect(mergeRateLimitWindows([], snapshot?.windows ?? [])).toHaveLength(2);
    expect(snapshot?.usedPercent).toBe(100);
  });

  it('後方互換の単一枠は同じlimitIdなら重ねない', () => {
    const bucket = {
      limitId: 'codex',
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_000 },
      secondary: null,
    };
    const snapshot = readRateLimits(
      { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } },
      'now',
    );
    expect(snapshot?.windows).toHaveLength(1);
  });

  it('rateLimitsByLimitIdが無ければ従来どおりrateLimitsだけを読む', () => {
    const snapshot = readRateLimits(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1786937045 },
          secondary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1787937045 },
        },
        rateLimitsByLimitId: null,
      },
      'now',
    );
    expect(snapshot?.windows).toHaveLength(2);
    expect(snapshot?.resetsAt).toBe(1787937045);
  });
});

describe('parseTokenCountLine / 制限枠の窓', () => {
  /** primary と secondary の両方を持つ `token_count`。実データは secondary が null だった。 */
  const twoWindows = (primary: number, secondary: number): string =>
    JSON.stringify({
      timestamp: '2026-09-12T03:15:58.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: primary, window_minutes: 300, resets_at: 1789000000 },
          secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1789619651 },
        },
      },
    });

  it('secondaryだけが上限でも上限として扱い、リセット時刻はsecondaryのもの', () => {
    const snapshot = parseTokenCountLine(twoWindows(20, 100));
    expect(snapshot?.usedPercent).toBe(100);
    expect(snapshot?.resetsAt).toBe(1789619651);
    expect(snapshot?.windowMinutes).toBe(10080);
    expect(snapshot?.windows).toHaveLength(2);
  });

  it('どちらも上限未満なら最も逼迫した窓を代表にする', () => {
    const snapshot = parseTokenCountLine(twoWindows(60, 40));
    expect(snapshot?.usedPercent).toBe(60);
    expect(snapshot?.windowMinutes).toBe(300);
    expect(snapshot?.resetsAt).toBe(1789000000);
  });
});

describe('formatWindowLabel', () => {
  it('窓の長さで呼び、primary/secondaryの名前は出さない', () => {
    const windows = [win('primary', 10, 300), win('secondary', 10, 10080)];
    expect(formatWindowLabel(windows[0] as RateLimitWindowInfo, windows)).toBe('5時間');
    expect(formatWindowLabel(windows[1] as RateLimitWindowInfo, windows)).toBe('週次');
  });

  it('枠が2つ以上あるときだけ識別子を添える', () => {
    const windows = [
      win('primary', 10, 300, undefined, 'codex'),
      win('primary', 10, 300, undefined, 'codex-mini'),
    ];
    expect(formatWindowLabel(windows[0] as RateLimitWindowInfo, windows)).toBe('codex 5時間');
    const single = [win('primary', 10, 300, undefined, 'codex')];
    expect(formatWindowLabel(single[0] as RateLimitWindowInfo, single)).toBe('5時間');
  });
});
