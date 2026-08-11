import type { SessionCostView } from '../appserver/chatState';

/**
 * `get_usage` control requestの応答からセッションのコストを読む（issue #37、design.md TP-60）。
 *
 * 実測（CLI 2.1.227）した形の一部:
 * `{ session: { total_cost_usd, total_lines_added, total_lines_removed, model_usage },
 *   subscription_type, rate_limits_available, rate_limits, behaviors }`。
 *
 * `rate_limits` はレート制限の消費率（既存の `usageProbe.ts` / `usageText.ts` が別経路で
 * 表示している）、`behaviors` はセッション分析（`/insights` が会話に出す内容と重なる）で、
 * どちらもこの機能の対象外（混同を避けるため読まない）。
 *
 * `total_cost_usd` が数値で読めない場合は `undefined` を返す。0円と決め付けて表示すると、
 * 実際には取得できていないだけの場合に「無料だった」と誤解させるため
 * （欠けている値を0へ丸めない。design.md「黙って何も起きない状態を作らない」）。
 */
export function parseSessionCost(
  payload: unknown,
  capturedAt: number,
): SessionCostView | undefined {
  const session = rec(rec(payload)?.['session']);
  const totalCostUsd = num(session?.['total_cost_usd']);
  if (session === undefined || totalCostUsd === undefined) {
    return undefined;
  }

  return {
    totalCostUsd,
    totalLinesAdded: num(session['total_lines_added']) ?? 0,
    totalLinesRemoved: num(session['total_lines_removed']) ?? 0,
    subscriptionType: strOrUndefined(rec(payload)?.['subscription_type']),
    capturedAt,
  };
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const strOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
