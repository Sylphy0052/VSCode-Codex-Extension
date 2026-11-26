import { sanitizeInlineText } from '../orchestrator/untrustedText';
import type {
  McCalendarDay,
  McCalendarSession,
  McCalendarSkill,
  McProvider,
  McWorkCalendar,
  McWorkUnit,
  McWorkUnitUsage,
} from '../webview/missionControl/protocol';
import type { WorkHistoryRecord } from './workHistory';
import { aggregateWorkUnits, localDay, validIssueNumber } from './workUnits';

/**
 * 作業履歴カレンダー（Mission Control 段階23。Issue #2179）。作業履歴（`readWorkHistory`の結果）
 * から、1か月分の日ごとのセッション数・作業単位・skill・使用量と、日ごとの全セッションを作る。
 *
 * - 日の境目はローカル時刻の0時（`localDay`と同じ。夏時間の日は23・25時間になる）
 * - 作業単位・費用・トークン・利用枠の概算は、`aggregateWorkUnits`をその日の範囲で呼んだ結果
 *   （費用・トークンは累計値なので、その日より前の記録を差し引いた増分。利用枠は`usageCarryIn`で
 *   0時をまたぐ区間を終点の日に入れる）
 * - セッションはprovider＋threadIdで1つと数え、その日に記録のあったものを全部出す（閉じたものも）
 *
 * vscodeに依らない。
 */

const TITLE_MAX = 200;
const BRANCH_MAX = 200;
const SKILL_MAX = 80;
export const MIN_CALENDAR_YEAR = 2000;
export const MAX_CALENDAR_YEAR = 9999;

/** 受け付ける年月か（年は2000〜9999、月は1〜12の整数）。 */
export function validCalendarMonth(year: unknown, month: unknown): boolean {
  return (
    typeof year === 'number' &&
    Number.isInteger(year) &&
    year >= MIN_CALENDAR_YEAR &&
    year <= MAX_CALENDAR_YEAR &&
    typeof month === 'number' &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  );
}

interface DaySessionAcc {
  provider: McProvider;
  threadId: string;
  title: string | undefined;
  branch: string | undefined;
  issue: number | undefined;
  firstAt: number;
  lastAt: number;
  lastEvent: string;
  turns: number;
  skills: Map<string, number>;
  /** その日より前の累計値の最大値。 */
  baseCost: number | undefined;
  baseTokens: number | undefined;
  /** その日の累計値の最大値。 */
  maxCost: number | undefined;
  maxTokens: number | undefined;
}

interface DayAcc {
  start: number;
  end: number;
  sessions: Map<string, DaySessionAcc>;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function increment(max: number | undefined, base: number | undefined): number | undefined {
  return max === undefined ? undefined : Math.max(0, max - (base ?? 0));
}

function sumDefined(values: ReadonlyArray<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const v of values) {
    if (v !== undefined) total = (total ?? 0) + v;
  }
  return total;
}

/** 外部由来の値を1行にして長さを制限する。空になれば無い。 */
function cleanLine(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = sanitizeInlineText(value.replace(/\s+/gu, ' ').trim(), max);
  return cleaned === '' ? undefined : cleaned;
}

/** 日ごとの使用率の増分を、作業単位の分から合計する（多い順）。 */
function sumUsage(units: readonly McWorkUnit[]): McWorkUnitUsage[] {
  const totals = new Map<string, McWorkUnitUsage>();
  for (const unit of units) {
    for (const u of unit.usage) {
      const key = `${u.provider}\u0000${u.label}`;
      const cur = totals.get(key);
      totals.set(key, {
        provider: u.provider,
        label: u.label,
        percent: (cur?.percent ?? 0) + u.percent,
      });
    }
  }
  return [...totals.values()].sort((a, b) => b.percent - a.percent);
}

function toSession(acc: DaySessionAcc): McCalendarSession {
  return {
    provider: acc.provider,
    threadId: acc.threadId,
    title: acc.title ?? '',
    issue: acc.issue,
    branch: acc.branch,
    firstAt: acc.firstAt,
    lastAt: acc.lastAt,
    ended: acc.lastEvent === 'end',
    turns: acc.turns,
    skills: [...acc.skills.keys()].sort(),
    costUsd: increment(acc.maxCost, acc.baseCost),
    tokens: increment(acc.maxTokens, acc.baseTokens),
  };
}

function daySkills(sessions: readonly DaySessionAcc[]): McCalendarSkill[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const [name, count] of s.skills) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `year`年`month`月（1〜12）のカレンダーを作る。`records`は順不同でよく、その月より前の記録も
 * 渡すこと（費用・トークンの差し引きと、handoffのつながりに使う）。
 */
export function buildWorkCalendar(
  records: readonly WorkHistoryRecord[],
  year: number,
  month: number,
): McWorkCalendar {
  const monthStart = new Date(year, month - 1, 1).getTime();
  const monthEnd = new Date(year, month, 1).getTime();
  const sorted = records.filter((r) => r.at < monthEnd).sort((a, b) => a.at - b.at);

  const days = new Map<string, DayAcc>();
  /** セッションごとの、今見ている記録より前の累計値の最大値。 */
  const running = new Map<string, { cost: number | undefined; tokens: number | undefined }>();

  for (const record of sorted) {
    if (record.kind !== 'session') continue;
    const key = `${record.provider}:${record.threadId}`;
    const prev = running.get(key) ?? { cost: undefined, tokens: undefined };
    if (record.at >= monthStart) {
      const dayKey = localDay(record.at);
      let day = days.get(dayKey);
      if (day === undefined) {
        const d = new Date(record.at);
        day = {
          start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
          end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
          sessions: new Map(),
        };
        days.set(dayKey, day);
      }
      let acc = day.sessions.get(key);
      if (acc === undefined) {
        // 記録は時刻順なので、この時点の`running`はその日より前の記録だけの最大値
        acc = {
          provider: record.provider,
          threadId: record.threadId,
          title: undefined,
          branch: undefined,
          issue: undefined,
          firstAt: record.at,
          lastAt: record.at,
          lastEvent: record.event,
          turns: 0,
          skills: new Map(),
          baseCost: prev.cost,
          baseTokens: prev.tokens,
          maxCost: undefined,
          maxTokens: undefined,
        };
        day.sessions.set(key, acc);
      }
      acc.lastAt = record.at;
      acc.lastEvent = record.event;
      acc.title = cleanLine(record.title, TITLE_MAX) ?? acc.title;
      acc.branch = cleanLine(record.branch, BRANCH_MAX) ?? acc.branch;
      acc.issue = validIssueNumber(record.issue) ?? acc.issue;
      acc.maxCost = maxDefined(acc.maxCost, record.costUsd);
      acc.maxTokens = maxDefined(acc.maxTokens, record.tokens);
      if (record.event === 'turn') acc.turns += 1;
      if (record.event === 'skill') {
        const skill = cleanLine(record.skill, SKILL_MAX);
        if (skill !== undefined) acc.skills.set(skill, (acc.skills.get(skill) ?? 0) + 1);
      }
    }
    running.set(key, {
      cost: maxDefined(prev.cost, record.costUsd),
      tokens: maxDefined(prev.tokens, record.tokens),
    });
  }

  const result: McCalendarDay[] = [];
  for (const [dayKey, day] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const accs = [...day.sessions.values()];
    const sessions = accs.map(toSession).sort((a, b) => a.firstAt - b.firstAt);
    // 0時をまたぐ利用枠の区間は終点の日に入れる（前日にも翌日にも入らず落ちるのを防ぐ）
    const units = aggregateWorkUnits(sorted, {
      since: day.start,
      until: day.end,
      usageCarryIn: true,
    });
    result.push({
      day: dayKey,
      sessionCount: sessions.length,
      units,
      skills: daySkills(accs),
      costUsd: sumDefined(sessions.map((s) => s.costUsd)),
      tokens: sumDefined(sessions.map((s) => s.tokens)),
      usage: sumUsage(units),
      sessions,
    });
  }
  return { year, month, days: result };
}
