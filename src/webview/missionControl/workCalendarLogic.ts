import type { McCalendarDay, McCalendarSession, McWorkCalendar } from './protocol';

/**
 * 作業履歴カレンダー（Issue #2179）の日付の計算と表示の文字列。DOMの型もPreactも使わない
 * （単体テストから直接呼ぶ）。日付はローカル時刻で扱う（ホストの`localDay`と同じ境目）。
 */

/** カレンダーで選んでいる日。`month`は1〜12。 */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export const WEEKDAY_LABELS: readonly string[] = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD`（ホストの`localDay`と同じ書式）。 */
export function calendarDayKey(date: CalendarDate): string {
  return `${String(date.year)}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function todayDate(now: number = Date.now()): CalendarDate {
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 日を`delta`日ずらす（月・年をまたいでよい）。 */
export function shiftDay(date: CalendarDate, delta: number): CalendarDate {
  const d = new Date(date.year, date.month - 1, date.day + delta);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** 月を`delta`か月ずらす。日はその月の日数に収める。 */
export function shiftMonth(date: CalendarDate, delta: number): CalendarDate {
  const first = new Date(date.year, date.month - 1 + delta, 1);
  const year = first.getFullYear();
  const month = first.getMonth() + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/**
 * 月のマス目（日曜始まりの週ごと）。前後の月にはみ出すマスは`undefined`。
 */
export function monthGrid(year: number, month: number): Array<Array<number | undefined>> {
  const lead = new Date(year, month - 1, 1).getDay();
  const total = daysInMonth(year, month);
  const cells: Array<number | undefined> = [
    ...Array.from({ length: lead }, () => undefined),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(undefined);
  const weeks: Array<Array<number | undefined>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 日（`YYYY-MM-DD`）から1日分を引く表。 */
export function calendarDayMap(calendar: McWorkCalendar | undefined): Map<string, McCalendarDay> {
  return new Map((calendar?.days ?? []).map((d) => [d.day, d]));
}

/**
 * 作業量の段階（0〜4）。0は記録なし。月の中で最もセッションの多い日を4として比で割り振る。
 */
export function workLevel(day: McCalendarDay | undefined, maxSessions: number): number {
  if (day === undefined || day.sessionCount <= 0 || maxSessions <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((day.sessionCount / maxSessions) * 4)));
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/** マスに出す短い要約（`3件 $1.20`）。記録が無ければ空文字。 */
export function formatCellSummary(day: McCalendarDay | undefined): string {
  if (day === undefined) return '';
  const parts = [`${String(day.sessionCount)}件`];
  if (day.costUsd !== undefined) parts.push(`$${day.costUsd.toFixed(2)}`);
  else if (day.tokens !== undefined) parts.push(`${formatTokens(day.tokens)} tok`);
  return parts.join(' ');
}

/** マスの説明（読み上げ・title用）。 */
export function formatCellLabel(date: CalendarDate, day: McCalendarDay | undefined): string {
  const head = `${String(date.month)}月${String(date.day)}日`;
  if (day === undefined) return `${head} 記録なし`;
  return `${head} ${formatDaySummary(day)}`;
}

/** 1日の要約（`3セッション · 作業単位2 · $1.20 · 45.6k tok · 利用枠 Claude 5h 12.0%`）。 */
export function formatDaySummary(day: McCalendarDay): string {
  const parts = [`${String(day.sessionCount)}セッション`, `作業単位${String(day.units.length)}`];
  if (day.costUsd !== undefined) parts.push(`$${day.costUsd.toFixed(2)}`);
  if (day.tokens !== undefined) parts.push(`${formatTokens(day.tokens)} tok`);
  const usage = day.usage
    .filter((u) => u.percent >= 0.05)
    .map(
      (u) => `${u.provider === 'claude' ? 'Claude' : 'Codex'} ${u.label} ${u.percent.toFixed(1)}%`,
    );
  if (usage.length > 0) parts.push(`利用枠 ${usage.join(' / ')}`);
  return parts.join(' · ');
}

/** skillの一覧（`review ×3, commit ×1`）。無ければ「なし」。 */
export function formatDaySkills(day: McCalendarDay): string {
  if (day.skills.length === 0) return 'なし';
  return day.skills.map((s) => `${s.name} ×${String(s.count)}`).join(', ');
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** セッションの見出し（`#123 タイトル`。タイトルが無ければthreadIdの先頭）。 */
export function calendarSessionHeading(session: McCalendarSession): string {
  const title = session.title === '' ? `(無題 ${session.threadId.slice(0, 8)})` : session.title;
  return session.issue === undefined ? title : `#${String(session.issue)} ${title}`;
}

/** セッションの詳細（`09:10〜11:45 · 閉じた · 12ターン · $0.80 · skill: review`）。 */
export function formatCalendarSession(session: McCalendarSession): string {
  const from = formatClock(session.firstAt);
  const to = formatClock(session.lastAt);
  const parts = [from === to ? from : `${from}〜${to}`];
  if (session.ended) parts.push('閉じた');
  parts.push(`${String(session.turns)}ターン`);
  if (session.costUsd !== undefined) parts.push(`$${session.costUsd.toFixed(2)}`);
  if (session.tokens !== undefined) parts.push(`${formatTokens(session.tokens)} tok`);
  if (session.skills.length > 0) parts.push(`skill: ${session.skills.join(', ')}`);
  return parts.join(' · ');
}
