import type { McWorkUnit, McWorkUnitSort } from './protocol';

/**
 * 作業単位の一覧（Issue #2177）の並べ替えと表示の文字列。DOMの型もPreactも使わない
 * （単体テストから直接呼ぶ）。
 */

/** 並べ替えの基準の順（`s`で次へ回す）と表示名。先頭が既定。 */
export const WORK_UNIT_SORTS: ReadonlyArray<readonly [McWorkUnitSort, string]> = [
  ['cost', '費用'],
  ['usage', '利用枠の消費'],
  ['tokens', 'トークン'],
  ['sessions', 'セッション数'],
  ['period', '期間'],
  ['recent', '新しい順'],
];

/** 集計する期間の候補（日数。0は保持期間の全部。`p`で次へ回す）。先頭が既定。 */
export const WORK_UNIT_PERIODS: readonly number[] = [30, 7, 90, 0];

export function nextWorkUnitSort(current: McWorkUnitSort): McWorkUnitSort {
  const index = WORK_UNIT_SORTS.findIndex(([key]) => key === current);
  return (WORK_UNIT_SORTS[(index + 1) % WORK_UNIT_SORTS.length] ??
    WORK_UNIT_SORTS[0] ?? ['cost'])[0];
}

export function nextWorkUnitPeriod(current: number): number {
  const index = WORK_UNIT_PERIODS.indexOf(current);
  return WORK_UNIT_PERIODS[(index + 1) % WORK_UNIT_PERIODS.length] ?? 30;
}

export function workUnitSortLabel(sort: McWorkUnitSort): string {
  return WORK_UNIT_SORTS.find(([key]) => key === sort)?.[1] ?? sort;
}

export function workUnitPeriodLabel(days: number): string {
  return days > 0 ? `直近${String(days)}日` : '保持期間の全部';
}

function metric(unit: McWorkUnit, sort: McWorkUnitSort): number {
  switch (sort) {
    case 'cost':
      return unit.costUsd ?? 0;
    case 'usage':
      return unit.usageScore;
    case 'tokens':
      return unit.tokens ?? 0;
    case 'sessions':
      return unit.sessionCount;
    case 'period':
      return unit.lastAt - unit.firstAt;
    case 'recent':
      return unit.lastAt;
  }
}

/**
 * 基準の多い順（`recent`は新しい順）に並べた新しい配列を返す。同じ値なら費用・利用枠の消費・
 * トークン・最後の記録の順で比べ、最後はkeyで決める（並びが揺れないように）。
 */
export function sortWorkUnits(units: readonly McWorkUnit[], sort: McWorkUnitSort): McWorkUnit[] {
  const order: McWorkUnitSort[] = [sort, 'cost', 'usage', 'tokens', 'recent'];
  return [...units].sort((a, b) => {
    for (const key of order) {
      const diff = metric(b, key) - metric(a, key);
      if (diff !== 0) return diff;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** 単位の見出し（`#123 タイトル`。Issue番号が無ければ「handoffの連鎖」）。 */
export function workUnitHeading(unit: McWorkUnit): string {
  const others = unit.issues.filter((n) => n !== unit.issue);
  const issue =
    unit.issue === undefined
      ? 'Issue番号なし（handoffの連鎖）'
      : `#${String(unit.issue)}${others.length > 0 ? `（ほか${others.map((n) => `#${String(n)}`).join(' ')}）` : ''}`;
  return unit.title === '' ? issue : `${issue} ${unit.title}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)}分`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${String(hours)}時間`;
  return `${String(Math.round(hours / 24))}日`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1)}/${String(d.getDate())}`;
}

/** 期間の表記（`11/20〜11/26（6日）`）。同じ日なら日付は1つ。 */
export function formatWorkUnitPeriod(unit: McWorkUnit): string {
  const from = formatDate(unit.firstAt);
  const to = formatDate(unit.lastAt);
  const range = from === to ? from : `${from}〜${to}`;
  return `${range}（${formatDuration(unit.lastAt - unit.firstAt)}）`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/** 消費の要約（`$1.23 · 45.6k tok · 5h 12% / 週 3%`）。何も無ければ「記録なし」。 */
export function formatWorkUnitConsumption(unit: McWorkUnit): string {
  const parts: string[] = [];
  if (unit.costUsd !== undefined) parts.push(`$${unit.costUsd.toFixed(2)}`);
  if (unit.tokens !== undefined) parts.push(`${formatTokens(unit.tokens)} tok`);
  const usage = unit.usage
    .filter((u) => u.percent >= 0.05)
    .map(
      (u) => `${u.provider === 'claude' ? 'Claude' : 'Codex'} ${u.label} ${u.percent.toFixed(1)}%`,
    );
  if (usage.length > 0) parts.push(`利用枠 ${usage.join(' / ')}`);
  return parts.length > 0 ? parts.join(' · ') : '費用・利用枠の記録なし';
}
