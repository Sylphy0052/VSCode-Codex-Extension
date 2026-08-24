import { describe, expect, it } from 'vitest';
import {
  findLastTokenCount,
  formatResetsIn,
  formatUsageGauge,
  formatWindow,
  parseTokenCountLine,
  severityOf,
} from '../../src/codex/usage';

/** 実データ（rollout の event_msg:token_count）を模したもの。 */
const tokenCountLine = (usedPercent: number, timestamp = '2026-08-06T18:46:34.665Z') =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 693202, output_tokens: 10130, total_tokens: 703332 },
        last_token_usage: { total_tokens: 35202 },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1786388667 },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: '1000' },
        plan_type: 'prolite',
      },
    },
  });

describe('parseTokenCountLine', () => {
  it('実データからレート制限とトークン量を取り出す', () => {
    const s = parseTokenCountLine(tokenCountLine(90));
    expect(s).toBeDefined();
    expect(s?.usedPercent).toBe(90);
    expect(s?.windowMinutes).toBe(10080);
    expect(s?.resetsAt).toBe(1786388667);
    expect(s?.planType).toBe('prolite');
    expect(s?.creditsBalance).toBe('1000');
    expect(s?.hasCredits).toBe(true);
    expect(s?.totalTokens).toBe(703332);
    expect(s?.contextWindow).toBe(258400);
    expect(s?.capturedAt).toBe('2026-08-06T18:46:34.665Z');
  });

  it('rate_limitsが無い行でもトークン量だけ返す', () => {
    const line = JSON.stringify({
      timestamp: '2026-08-06T18:00:00Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } } },
    });
    const s = parseTokenCountLine(line);
    expect(s?.totalTokens).toBe(10);
    expect(s?.usedPercent).toBeUndefined();
  });

  it('token_count以外のイベントは受け付けない', () => {
    const other = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'hi' },
    });
    expect(parseTokenCountLine(other)).toBeUndefined();
    expect(parseTokenCountLine(JSON.stringify({ type: 'session_meta' }))).toBeUndefined();
  });

  it('壊れた行はundefined', () => {
    expect(parseTokenCountLine('{"type":"event_msg"')).toBeUndefined();
    expect(parseTokenCountLine('')).toBeUndefined();
    expect(parseTokenCountLine('null')).toBeUndefined();
  });
});

describe('findLastTokenCount', () => {
  it('末尾に近いものを採用する', () => {
    const chunk = [tokenCountLine(10), tokenCountLine(50), tokenCountLine(90)].join('\n');
    expect(findLastTokenCount(chunk)?.usedPercent).toBe(90);
  });

  it('他のイベントが後ろにあっても最後のtoken_countを拾う', () => {
    const chunk = [
      tokenCountLine(42),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n');
    expect(findLastTokenCount(chunk)?.usedPercent).toBe(42);
  });

  it('先頭が欠けた行を読み飛ばす（末尾読みの前提）', () => {
    const chunk = `count":{"total_tokens":1}}}\n${tokenCountLine(7)}`;
    expect(findLastTokenCount(chunk)?.usedPercent).toBe(7);
  });

  it('token_countが無ければundefined', () => {
    expect(findLastTokenCount('{"type":"event_msg"}')).toBeUndefined();
    expect(findLastTokenCount('')).toBeUndefined();
  });
});

describe('formatWindow', () => {
  it('分数を人間向けの単位にする', () => {
    expect(formatWindow(10080)).toBe('週次');
    expect(formatWindow(20160)).toBe('2週');
    expect(formatWindow(1440)).toBe('1日');
    expect(formatWindow(300)).toBe('5時間');
    expect(formatWindow(45)).toBe('45分');
  });

  it('未指定や0は空文字', () => {
    expect(formatWindow(undefined)).toBe('');
    expect(formatWindow(0)).toBe('');
  });
});

describe('formatResetsIn', () => {
  const now = Date.parse('2026-08-07T00:00:00Z');
  const at = (offsetMs: number) => Math.floor((now + offsetMs) / 1000);

  it('残り時間を丸めて返す', () => {
    expect(formatResetsIn(at(30 * 60_000), now)).toBe('30分後');
    expect(formatResetsIn(at(5 * 3_600_000), now)).toBe('5時間後');
    expect(formatResetsIn(at(3 * 86_400_000), now)).toBe('3日後');
  });

  it('過ぎていればまもなく', () => {
    expect(formatResetsIn(at(-1000), now)).toBe('まもなく');
  });

  it('1分未満でも0分後にはしない', () => {
    expect(formatResetsIn(at(10_000), now)).toBe('1分後');
  });

  it('未指定は空文字', () => {
    expect(formatResetsIn(undefined, now)).toBe('');
  });
});

describe('severityOf', () => {
  it('閾値で強調度が変わる', () => {
    expect(severityOf(10)).toBe('normal');
    expect(severityOf(74.9)).toBe('normal');
    expect(severityOf(75)).toBe('warning');
    expect(severityOf(89.9)).toBe('warning');
    expect(severityOf(90)).toBe('critical');
    expect(severityOf(undefined)).toBe('normal');
  });
});

describe('formatUsageGauge', () => {
  it('使用率に応じて埋まる目盛りが増える', () => {
    expect(formatUsageGauge(0)).toBe('▯▯▯▯▯');
    expect(formatUsageGauge(30)).toBe('▮▮▯▯▯');
    expect(formatUsageGauge(50)).toBe('▮▮▮▯▯');
    expect(formatUsageGauge(100)).toBe('▮▮▮▮▮');
  });

  it('使用率が変わっても幅が変わらない', () => {
    const widths = new Set(
      [0, 1, 17, 42, 63, 88, 99, 100].map((percent) => [...formatUsageGauge(percent)].length),
    );
    expect([...widths]).toEqual([5]);
  });

  it('0%でない限り1目盛りは埋まり、100%でない限り1目盛りは空く', () => {
    expect(formatUsageGauge(0.4)).toBe('▮▯▯▯▯');
    expect(formatUsageGauge(99.9)).toBe('▮▮▮▮▯');
  });

  it('範囲外の値は0%と100%へ丸める', () => {
    expect(formatUsageGauge(-10)).toBe('▯▯▯▯▯');
    expect(formatUsageGauge(140)).toBe('▮▮▮▮▮');
  });

  it('取得できていないときと目盛り0のときは空文字', () => {
    expect(formatUsageGauge(undefined)).toBe('');
    expect(formatUsageGauge(Number.NaN)).toBe('');
    expect(formatUsageGauge(50, 0)).toBe('');
  });

  it('目盛り数を変えられる', () => {
    expect(formatUsageGauge(50, 10)).toBe('▮▮▮▮▮▯▯▯▯▯');
  });
});
