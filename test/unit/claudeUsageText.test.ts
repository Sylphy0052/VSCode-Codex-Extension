import { describe, expect, it } from 'vitest';
import { formatClaudeUsage } from '../../src/claude/usageText';

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
