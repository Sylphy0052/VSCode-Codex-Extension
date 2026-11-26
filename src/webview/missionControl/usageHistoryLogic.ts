import type { McUsageHistoryPoint, McUsageHistorySeries } from './protocol';

/**
 * 利用枠の推移グラフ（Issue #2176）の座標と表記。DOMに依らない計算だけを置き、単体テストから
 * 呼べるようにする。
 */

/** 描画範囲（SVGのviewBox上の座標）。 */
export interface PlotArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `YYYY-MM-DD`を`M/D`にする。形が違えばそのまま返す。 */
export function formatDayLabel(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(day);
  if (match === null) {
    return day;
  }
  return `${String(Number(match[1]))}/${String(Number(match[2]))}`;
}

/** 時刻を`M/D HH:MM`（地方時）にする。 */
export function formatPointTime(at: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${hh}:${mm}`;
}

/** 時刻のx座標。期間の外は端へ寄せる。 */
export function timeToX(at: number, since: number, until: number, area: PlotArea): number {
  const span = until - since;
  if (span <= 0) {
    return area.left + area.width;
  }
  const ratio = Math.min(Math.max((at - since) / span, 0), 1);
  return round1(area.left + ratio * area.width);
}

/** 使用率（%）のy座標。0〜100%の外は端へ寄せる。 */
export function percentToY(percent: number, area: PlotArea): number {
  const ratio = Math.min(Math.max(percent / 100, 0), 1);
  return round1(area.top + (1 - ratio) * area.height);
}

/** 区切り1つ分の折れ線（`<polyline points>`の値）。 */
export function segmentPoints(
  segment: readonly McUsageHistoryPoint[],
  since: number,
  until: number,
  area: PlotArea,
): string {
  return segment
    .map(
      (p) =>
        `${String(timeToX(p.at, since, until, area))},${String(percentToY(p.usedPercent, area))}`,
    )
    .join(' ');
}

/** 最後の点。点が無ければ`undefined`。 */
export function latestPoint(series: McUsageHistorySeries): McUsageHistoryPoint | undefined {
  for (let i = series.segments.length - 1; i >= 0; i -= 1) {
    const segment = series.segments[i];
    const last = segment?.[segment.length - 1];
    if (last !== undefined) {
      return last;
    }
  }
  return undefined;
}

/** 期間内の使用率の最大値。点が無ければ`undefined`。 */
export function maxPercent(series: McUsageHistorySeries): number | undefined {
  let max: number | undefined;
  for (const segment of series.segments) {
    for (const point of segment) {
      if (max === undefined || point.usedPercent > max) {
        max = point.usedPercent;
      }
    }
  }
  return max;
}

/** 日別の棒の高さの基準。最大値を10%刻みで切り上げる（小さな値を大きく見せすぎない）。 */
export function dailyScale(daily: readonly number[]): number {
  const max = Math.max(0, ...daily);
  return Math.max(10, Math.ceil(max / 10) * 10);
}

/** 期間内の日別の使用量の合計（小数1桁）。 */
export function dailyTotal(daily: readonly number[]): number {
  return round1(daily.reduce((sum, value) => sum + value, 0));
}

/** `12.5%`のような表記。整数は小数を付けない。 */
export function formatPercent(value: number): string {
  return `${String(round1(value))}%`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
