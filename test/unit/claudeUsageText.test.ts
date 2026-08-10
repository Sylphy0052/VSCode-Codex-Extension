import { describe, expect, it } from 'vitest';
import { formatClaudeUsage, parseUsageReport } from '../../src/claude/usageText';

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
