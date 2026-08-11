import { describe, expect, it } from 'vitest';
import { parseSessionCost } from '../../src/claude/costText';

describe('parseSessionCost', () => {
  // 実測（CLI 2.1.227、issue #37 Phase 0 Z-13 追試）した get_usage の応答の一部。
  // 金額はテスト用に丸めている。rate_limits / behaviors は別機能（レート制限表示）の
  // ものなので読まない。
  const payload = {
    session: {
      total_cost_usd: 0.2177,
      total_api_duration_ms: 1945,
      total_duration_ms: 4154,
      total_lines_added: 3,
      total_lines_removed: 1,
      model_usage: { 'claude-opus-5[1m]': { costUSD: 0.2177 } },
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 58 } },
  };

  it('コストと行数増減、サブスクリプション種別を読む', () => {
    expect(parseSessionCost(payload, 12345)).toEqual({
      totalCostUsd: 0.2177,
      totalLinesAdded: 3,
      totalLinesRemoved: 1,
      subscriptionType: 'max',
      capturedAt: 12345,
    });
  });

  it('ターンを1回も回していないセッションは0円になる（実測）', () => {
    const zero = {
      session: { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 },
      subscription_type: 'max',
    };
    expect(parseSessionCost(zero, 1)?.totalCostUsd).toBe(0);
  });

  it('サブスクリプション種別が無ければ undefined（APIキー利用などを想定）', () => {
    const noSub = { session: { total_cost_usd: 1.5 } };
    expect(parseSessionCost(noSub, 1)).toEqual({
      totalCostUsd: 1.5,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      subscriptionType: undefined,
      capturedAt: 1,
    });
  });

  it('行数が数値でなければ0にする（省略されている場合を含む）', () => {
    const noLines = { session: { total_cost_usd: 1 } };
    const cost = parseSessionCost(noLines, 1);
    expect(cost?.totalLinesAdded).toBe(0);
    expect(cost?.totalLinesRemoved).toBe(0);
  });

  it('total_cost_usd が数値でなければ何も返さない（0円と誤解させない）', () => {
    expect(parseSessionCost({ session: { total_cost_usd: null } }, 1)).toBeUndefined();
    expect(parseSessionCost({ session: { total_cost_usd: '0' } }, 1)).toBeUndefined();
    expect(parseSessionCost({ session: {} }, 1)).toBeUndefined();
  });

  it('sessionそのものが読めなければ何も返さない', () => {
    expect(parseSessionCost(undefined, 1)).toBeUndefined();
    expect(parseSessionCost({}, 1)).toBeUndefined();
    expect(parseSessionCost({ session: 'x' }, 1)).toBeUndefined();
  });

  it('未知のフィールドが増えても落ちない', () => {
    const withExtra = {
      session: { total_cost_usd: 0.1, some_new_field: { nested: true } },
      subscription_type: 'pro',
      some_other_top_level: [1, 2, 3],
    };
    expect(parseSessionCost(withExtra, 1)?.totalCostUsd).toBe(0.1);
  });
});
