import { describe, expect, it } from 'vitest';
import type { ChatUsage } from '../../src/appserver/chatState';
import {
  formatClaudeLimitLines,
  formatClaudeUsage,
  mergeClaudeUsage,
  parseUsageReport,
  summarizeClaudeLimits,
  type ClaudeLimitEntry,
} from '../../src/claude/usageText';

const NOW = Date.UTC(2026, 7, 10, 6, 0, 0);
const inHours = (h: number) => Math.floor(NOW / 1000) + h * 3600;

describe('formatClaudeUsage', () => {
  it('制限の種類とリセットまでの時間を並べる', () => {
    const text = formatClaudeUsage(
      { usedPercent: undefined, resetsAt: inHours(3), limitLabel: '5時間', limited: false },
      NOW,
    );
    expect(text).toBe('Claude 5時間 ・ 3時間後');
  });

  it('消費率が分かればそちらを優先する', () => {
    const text = formatClaudeUsage(
      { usedPercent: 16, resetsAt: inHours(3), limitLabel: '5時間', limited: false },
      NOW,
    );
    expect(text).toBe('Claude 16% ・ 3時間後');
  });

  it('制限に到達していれば示す', () => {
    const text = formatClaudeUsage(
      { usedPercent: undefined, resetsAt: inHours(2), limitLabel: '週次', limited: true },
      NOW,
    );
    expect(text).toBe('Claude 週次 到達 ・ 2時間後');
  });

  it('種類が不明ならリセットだけ出す', () => {
    const text = formatClaudeUsage(
      { usedPercent: undefined, resetsAt: inHours(1), limitLabel: undefined, limited: false },
      NOW,
    );
    expect(text).toBe('Claude 1時間後');
  });

  it('何も分からなければ空を返す', () => {
    expect(formatClaudeUsage(undefined, NOW)).toBe('');
    expect(
      formatClaudeUsage(
        { usedPercent: undefined, resetsAt: undefined, limitLabel: undefined, limited: undefined },
        NOW,
      ),
    ).toBe('');
  });
});

describe('parseUsageReport', () => {
  const report = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 16% used · resets Aug 10, 8:09pm (Asia/Tokyo)',
    'Current week (all models): 10% used · resets Aug 14, 6:59am (Asia/Tokyo)',
    'Current week (Fable): 2% used · resets Aug 14, 6:59am (Asia/Tokyo)',
  ].join('\n');

  it('セッションの消費率を読む', () => {
    // 直近で効いてくるのはセッションの枠。週次より先に頭打ちになる
    expect(parseUsageReport(report)?.usedPercent).toBe(16);
  });

  it('制限の種類を添える', () => {
    expect(parseUsageReport(report)?.limitLabel).toBe('セッション');
  });

  it('セッションの行が無ければ週次を使う', () => {
    const weekly = 'Current week (all models): 10% used · resets Aug 14, 6:59am';
    expect(parseUsageReport(weekly)?.usedPercent).toBe(10);
    expect(parseUsageReport(weekly)?.limitLabel).toBe('週次');
  });

  it('使用量の文でなければ undefined', () => {
    expect(parseUsageReport('こんにちは')).toBeUndefined();
    expect(parseUsageReport('')).toBeUndefined();
  });

  it('文言が変わっても落ちない', () => {
    // 英文をあてにしているので、読めなければ黙って諦める
    expect(parseUsageReport('Session usage is 16 percent')).toBeUndefined();
  });
});

const usage = (over: Partial<ChatUsage>): ChatUsage => ({
  usedPercent: undefined,
  resetsAt: undefined,
  limitLabel: undefined,
  limited: undefined,
  ...over,
});

describe('mergeClaudeUsage（issue #1221）', () => {
  it('同じ枠の値を重ね、届かなかった項目は前の値を残す', () => {
    const first = mergeClaudeUsage([], usage({ limitLabel: '週次', limited: true, resetsAt: 100 }));
    const merged = mergeClaudeUsage(first, usage({ limitLabel: '週次', usedPercent: 100 }));
    expect(merged).toEqual([{ label: '週次', usedPercent: 100, resetsAt: 100, limited: true }]);
  });

  it('別の枠は混ぜずに増やす', () => {
    const first = mergeClaudeUsage([], usage({ limitLabel: '週次', limited: true, resetsAt: 100 }));
    const merged = mergeClaudeUsage(first, usage({ limitLabel: 'セッション', usedPercent: 16 }));
    expect(merged).toHaveLength(2);
    // 到達とリセット時刻を別の枠の割合が引き継がない
    expect(merged[1]).toEqual({
      label: 'セッション',
      usedPercent: 16,
      resetsAt: undefined,
      limited: undefined,
    });
  });

  it('元の配列を書き換えない', () => {
    const prev = mergeClaudeUsage([], usage({ limitLabel: '週次', usedPercent: 10 }));
    mergeClaudeUsage(prev, usage({ limitLabel: '週次', usedPercent: 99 }));
    expect(prev[0]?.usedPercent).toBe(10);
  });

  it('中身の無い値では枠を増やさない', () => {
    expect(mergeClaudeUsage([], usage({ limitLabel: '週次' }))).toEqual([]);
  });
});

describe('summarizeClaudeLimits（issue #1221）', () => {
  const entry = (over: Partial<ClaudeLimitEntry>): ClaudeLimitEntry => ({
    label: undefined,
    usedPercent: undefined,
    resetsAt: undefined,
    limited: undefined,
    ...over,
  });

  it('到達した枠を割合だけの枠より優先する', () => {
    const summary = summarizeClaudeLimits([
      entry({ label: 'セッション', usedPercent: 16 }),
      entry({ label: '週次', limited: true, resetsAt: 100 }),
    ]);
    expect(summary).toEqual({
      usedPercent: undefined,
      resetsAt: 100,
      limitLabel: '週次',
      limited: true,
    });
  });

  it('到達が複数あればリセットの遅いほうを選ぶ', () => {
    const summary = summarizeClaudeLimits([
      entry({ label: '5時間', limited: true, resetsAt: 100 }),
      entry({ label: '週次', limited: true, resetsAt: 900 }),
    ]);
    expect(summary?.limitLabel).toBe('週次');
  });

  it('到達が無ければ最も逼迫した枠を選ぶ', () => {
    const summary = summarizeClaudeLimits([
      entry({ label: 'セッション', usedPercent: 16 }),
      entry({ label: '週次', usedPercent: 80 }),
    ]);
    expect(summary?.limitLabel).toBe('週次');
  });

  it('何も保持していなければ undefined', () => {
    expect(summarizeClaudeLimits([])).toBeUndefined();
  });
});

describe('formatClaudeLimitLines（issue #1221）', () => {
  it('枠ごとに割合・到達・リセットを並べる', () => {
    const lines = formatClaudeLimitLines(
      [
        { label: 'セッション', usedPercent: 16, resetsAt: undefined, limited: undefined },
        { label: '週次', usedPercent: 100, resetsAt: inHours(2), limited: true },
      ],
      NOW,
    );
    expect(lines).toEqual([
      '- セッション: 16% 使用',
      '- 週次: 100% 使用 ・ 到達 ・ リセット 2時間後',
    ]);
  });

  it('出せる値の無い枠は行にしない', () => {
    expect(
      formatClaudeLimitLines(
        [{ label: '週次', usedPercent: undefined, resetsAt: undefined, limited: false }],
        NOW,
      ),
    ).toEqual([]);
  });
});
