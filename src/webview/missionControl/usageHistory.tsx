import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Bridge } from './bridge';
import { oneLine } from './globalLogic';
import { keyLabelFor } from './keys';
import type { McProvider, McUsageHistory, McUsageHistorySeries } from './protocol';
import {
  dailyScale,
  dailyTotal,
  formatDayLabel,
  formatPercent,
  formatPointTime,
  latestPoint,
  maxPercent,
  percentToY,
  segmentPoints,
  timeToX,
  type PlotArea,
} from './usageHistoryLogic';

/**
 * 利用枠の推移グラフ（Issue #2176）。作業履歴（Issue #2175）に残した値から、窓ごとの使用率の
 * 推移と日別の使用量を出す。開くたびに拡張ホストへ取り寄せる。
 */

/** 窓の表示名の長さの上限（拡張ホストの`LABEL_MAX_LENGTH`と同じ）。 */
const LABEL_MAX_CHARS = 40;

const VIEW_WIDTH = 480;
const LINE_HEIGHT = 120;
const BAR_HEIGHT = 96;
/** 折れ線の描画範囲（左に使用率、下に日付の目盛りを置く）。 */
const LINE_AREA: PlotArea = { left: 34, top: 6, width: VIEW_WIDTH - 40, height: LINE_HEIGHT - 24 };
/** 棒の描画範囲（上に値、下に日付を置く）。 */
const BAR_AREA: PlotArea = { left: 4, top: 14, width: VIEW_WIDTH - 8, height: BAR_HEIGHT - 30 };
const PERCENT_TICKS = [0, 50, 100] as const;

const PROVIDERS: ReadonlyArray<readonly [McProvider, string]> = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
];

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; history: McUsageHistory };

export function UsageHistoryDialog(props: { bridge: Bridge; onClose: () => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void props.bridge.usageHistory().then((result) => {
      if (!alive) {
        return;
      }
      if (result.ok && result.usageHistory !== undefined) {
        setState({ status: 'ready', history: result.usageHistory });
      } else {
        setState({ status: 'error', error: result.error ?? '利用枠の推移を読めませんでした' });
      }
    });
    return () => {
      alive = false;
    };
  }, [props.bridge]);
  return (
    <div class="help" role="dialog" aria-label="利用枠の推移">
      <div class="help-box usage-history">
        <h2>利用枠の推移</h2>
        {state.status === 'loading' ? <p class="notice">作業履歴を読んでいます…</p> : null}
        {state.status === 'error' ? (
          <p class="notice" data-usage-history="error">
            {oneLine(state.error, 200)}
          </p>
        ) : null}
        {state.status === 'ready' ? <UsageHistoryBody history={state.history} /> : null}
        <div class="actions">
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる（Esc / {keyLabelFor('usageHistory') ?? ''}）
          </button>
        </div>
      </div>
    </div>
  );
}

function UsageHistoryBody(props: { history: McUsageHistory }): JSX.Element {
  const { history } = props;
  const first = history.days[0];
  const last = history.days[history.days.length - 1];
  return (
    <>
      <p class="notice">
        {first === undefined || last === undefined
          ? ''
          : `${formatDayLabel(first)}〜${formatDayLabel(last)}（${String(history.days.length)}日間）。`}
        日別の使用量は、その窓の上限に対する使用率の増えた分を日ごとに足したものです（リセット後は0から数え、期間の最初の値より前の分は含みません）。
      </p>
      {PROVIDERS.map(([provider, label]) => {
        const series = history.series.filter((s) => s.provider === provider);
        return (
          <section key={provider} data-usage-history={provider}>
            <h3>{label}の利用枠</h3>
            {series.length === 0 ? (
              <p class="notice">記録がありません（利用枠の値が届くと作業履歴に残ります）</p>
            ) : (
              series.map((s) => <SeriesChart key={s.label} series={s} history={history} />)
            )}
          </section>
        );
      })}
    </>
  );
}

function SeriesChart(props: {
  series: McUsageHistorySeries;
  history: McUsageHistory;
}): JSX.Element {
  const { series, history } = props;
  const label = oneLine(series.label, LABEL_MAX_CHARS);
  const latest = latestPoint(series);
  const max = maxPercent(series);
  const facts: string[] = [];
  if (latest !== undefined) {
    facts.push(`最新 ${formatPercent(latest.usedPercent)}（${formatPointTime(latest.at)}）`);
  }
  if (max !== undefined) {
    facts.push(`期間内の最大 ${formatPercent(max)}`);
  }
  facts.push(`日別の合計 ${formatPercent(dailyTotal(series.daily))}`);
  return (
    <div class="usage-history-series" data-usage-series={label}>
      <h4>{label}</h4>
      <p class="notice">{facts.join('・')}</p>
      <LineChart series={series} history={history} label={label} />
      <DailyBars series={series} days={history.days} label={label} />
    </div>
  );
}

function LineChart(props: {
  series: McUsageHistorySeries;
  history: McUsageHistory;
  label: string;
}): JSX.Element {
  const { series, history } = props;
  const { since, until } = history;
  const area = LINE_AREA;
  const bottom = area.top + area.height;
  const first = history.days[0];
  const last = history.days[history.days.length - 1];
  return (
    <svg
      class="usage-chart"
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(LINE_HEIGHT)}`}
      role="img"
      aria-label={`${props.label}の使用率の推移`}
    >
      {PERCENT_TICKS.map((tick) => {
        const y = percentToY(tick, area);
        return (
          <g key={String(tick)}>
            <line
              class="usage-chart-grid"
              x1={area.left}
              x2={area.left + area.width}
              y1={y}
              y2={y}
            />
            <text class="usage-chart-text" x={area.left - 4} y={y + 3} text-anchor="end">
              {`${String(tick)}%`}
            </text>
          </g>
        );
      })}
      {first === undefined ? null : (
        <text class="usage-chart-text" x={area.left} y={bottom + 14} text-anchor="start">
          {formatDayLabel(first)}
        </text>
      )}
      {last === undefined ? null : (
        <text class="usage-chart-text" x={area.left + area.width} y={bottom + 14} text-anchor="end">
          {formatDayLabel(last)}
        </text>
      )}
      {series.segments.map((segment, i) =>
        segment.length === 1 && segment[0] !== undefined ? (
          <circle
            key={String(i)}
            class="usage-chart-dot"
            cx={timeToX(segment[0].at, since, until, area)}
            cy={percentToY(segment[0].usedPercent, area)}
            r={2}
          />
        ) : (
          <polyline
            key={String(i)}
            class="usage-chart-line"
            points={segmentPoints(segment, since, until, area)}
          />
        ),
      )}
    </svg>
  );
}

function DailyBars(props: {
  series: McUsageHistorySeries;
  days: readonly string[];
  label: string;
}): JSX.Element {
  const { series, days } = props;
  const area = BAR_AREA;
  const scale = dailyScale(series.daily);
  const slot = days.length === 0 ? area.width : area.width / days.length;
  const barWidth = Math.max(2, slot * 0.6);
  const bottom = area.top + area.height;
  return (
    <svg
      class="usage-chart"
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(BAR_HEIGHT)}`}
      role="img"
      aria-label={`${props.label}の日別の使用量`}
    >
      <line
        class="usage-chart-grid"
        x1={area.left}
        x2={area.left + area.width}
        y1={bottom}
        y2={bottom}
      />
      {days.map((day, i) => {
        const value = series.daily[i] ?? 0;
        const height = (value / scale) * area.height;
        const center = area.left + slot * i + slot / 2;
        return (
          <g key={day}>
            <title>{`${formatDayLabel(day)}: ${formatPercent(value)}`}</title>
            {value > 0 ? (
              <>
                <rect
                  class="usage-chart-bar"
                  x={center - barWidth / 2}
                  y={bottom - height}
                  width={barWidth}
                  height={height}
                />
                <text
                  class="usage-chart-text"
                  x={center}
                  y={bottom - height - 3}
                  text-anchor="middle"
                >
                  {String(Math.round(value * 10) / 10)}
                </text>
              </>
            ) : null}
            <text class="usage-chart-text" x={center} y={bottom + 12} text-anchor="middle">
              {formatDayLabel(day)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
