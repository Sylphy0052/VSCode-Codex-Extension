import type { SavedAccountLimit, SavedAccountView } from './accountStore';

/**
 * Claude Codeのアカウントを自動で切り替える判断（Issue #1924）。
 *
 * ファイルや画面には触れない純関数だけを置く。記録（`usage.json`）の読み書きは
 * `accountStore.ts`、いつ呼ぶかは呼び出し側が持つ。
 */

/** 自動切り替えの既定の閾値（%）。99%では取得間隔の間に上限を飛び越えうるため手前に置く。 */
export const DEFAULT_SWITCH_THRESHOLD_PCT = 95;

/** 使用率の取得間隔（分）。50%以下・75%以下・90%以下・90%超の順。 */
const INTERVAL_MINUTES = [15, 10, 5, 2] as const;

/**
 * 待機中のアカウントを計測し直すまでの最短の間隔（Issue #1943）。計測のたびにCLIが
 * トークンをrefreshしうるので、回数と `429` の危険を減らすため長めに取る。
 */
export const STANDBY_PROBE_INTERVAL_MS = 60 * 60_000;

/**
 * 待機中のアカウントの記録が古く、計測し直すべきか。記録が無いか、記録から
 * {@link STANDBY_PROBE_INTERVAL_MS} 以上経っていれば古い。解除時刻を過ぎた枠も
 * この間隔の中で拾い直すので、別に判定しない。
 */
export function isStandbyStale(account: SavedAccountView, nowMs: number): boolean {
  if (account.current) {
    return false;
  }
  const recordedAt = account.usage?.recordedAt;
  return recordedAt === undefined || nowMs - recordedAt >= STANDBY_PROBE_INTERVAL_MS;
}

/** 稼働中のアカウントの、使用率に応じた次の取得までの間隔（ミリ秒）。 */
export function probeIntervalMs(highestPct: number): number {
  const index = highestPct <= 50 ? 0 : highestPct <= 75 ? 1 : highestPct <= 90 ? 2 : 3;
  return INTERVAL_MINUTES[index] * 60_000;
}

/**
 * 1つの枠の、今の使用率の見積もり。記録したリセット時刻を過ぎていれば、その枠は
 * 戻っているはずなので0とする。実際の値は、そのアカウントに切り替えて取るまで判らない。
 */
export function effectivePct(limit: SavedAccountLimit | undefined, nowMs: number): number {
  if (limit === undefined) {
    return 0;
  }
  if (limit.resetsAt !== undefined && limit.resetsAt <= nowMs) {
    return 0;
  }
  return limit.pct;
}

/** 5時間枠と週次のうち高い方の使用率の見積もり。 */
export function highestEffectivePct(account: SavedAccountView, nowMs: number): number {
  return Math.max(
    effectivePct(account.usage?.fiveHour, nowMs),
    effectivePct(account.usage?.weekly, nowMs),
  );
}

/** 稼働中のアカウントを切り替えるべき使用率か。 */
export function reachedThreshold(
  account: SavedAccountView,
  thresholdPct: number,
  nowMs: number,
): boolean {
  return highestEffectivePct(account, nowMs) >= thresholdPct;
}

/**
 * 稼働中の次に切り替える先。優先度の高い順に、閾値に余裕のあるアカウントを選ぶ。
 * 記録が無いアカウントは使用率が判らないので、余裕があるものとして扱う。
 * 候補が無ければ `undefined`（全アカウントが閾値以上なら切り替えない）。
 */
export function pickSwitchTarget(
  accounts: readonly SavedAccountView[],
  thresholdPct: number,
  nowMs: number,
): SavedAccountView | undefined {
  return [...accounts]
    .filter((a) => !a.current && highestEffectivePct(a, nowMs) < thresholdPct)
    .sort(byPriority)[0];
}

/**
 * 優先度の高いアカウントへ戻す先。稼働中より優先度が高く、使用率の記録があり、閾値に
 * 余裕のあるもののうち最も優先度が高いもの。稼働中が最も優先度の高いアカウントなら `undefined`。
 */
export function pickReturnTarget(
  accounts: readonly SavedAccountView[],
  thresholdPct: number,
  nowMs: number,
): SavedAccountView | undefined {
  const current = accounts.find((a) => a.current);
  if (current === undefined) {
    return undefined;
  }
  return [...accounts]
    .filter(
      (a) =>
        !a.current &&
        // 記録が無いと戻した先が上限かどうか判らず、行き来しかねない
        a.usage !== undefined &&
        a.priority < current.priority &&
        highestEffectivePct(a, nowMs) < thresholdPct,
    )
    .sort(byPriority)[0];
}

function byPriority(a: SavedAccountView, b: SavedAccountView): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}
