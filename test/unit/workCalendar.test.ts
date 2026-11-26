import { describe, expect, it } from 'vitest';
import { buildWorkCalendar, validCalendarMonth } from '../../src/view/workCalendar';
import type {
  WorkHistoryRecord,
  WorkHistorySessionRecord,
  WorkHistoryUsageRecord,
} from '../../src/view/workHistory';
import {
  calendarDayKey,
  formatCalendarSession,
  formatCellSummary,
  formatDaySkills,
  monthGrid,
  shiftDay,
  shiftMonth,
  workLevel,
} from '../../src/webview/missionControl/workCalendarLogic';
import { resolveKey } from '../../src/webview/missionControl/keys';

const MIN = 60 * 1000;
/** 2026-11-20 09:00（ローカル時刻）。 */
const D20 = new Date(2026, 10, 20, 9, 0, 0).getTime();
const D21 = new Date(2026, 10, 21, 9, 0, 0).getTime();

function sess(
  at: number,
  threadId: string,
  event: WorkHistorySessionRecord['event'],
  extra: Partial<WorkHistorySessionRecord> = {},
): WorkHistorySessionRecord {
  return {
    v: 1,
    kind: 'session',
    at,
    event,
    windowId: 'w1',
    provider: 'claude',
    threadId,
    ...extra,
  };
}

function usage(at: number, usedPercent: number): WorkHistoryUsageRecord {
  return {
    v: 1,
    kind: 'usage',
    at,
    windowId: 'w1',
    provider: 'claude',
    windows: [
      { label: '5h', usedPercent, resetsAt: D20 + 5 * 60 * MIN, sampledAt: at, limited: false },
    ],
  };
}

describe('buildWorkCalendar', () => {
  it('日ごとにセッション数・作業単位・skill・費用の増分を出し、閉じたものを含めて全セッションを並べる', () => {
    const records: WorkHistoryRecord[] = [
      // 前の月の記録（費用の差し引きにだけ使う）
      sess(new Date(2026, 9, 31, 23, 0).getTime(), 'a', 'start', { costUsd: 0.5, issue: 2179 }),
      sess(D20, 'a', 'update', { title: '実装', issue: 2179, costUsd: 1.0 }),
      sess(D20 + 10 * MIN, 'a', 'skill', { skill: 'review' }),
      sess(D20 + 20 * MIN, 'a', 'turn', { costUsd: 1.5 }),
      usage(D20 + 5 * MIN, 10),
      usage(D20 + 25 * MIN, 14),
      sess(D20 + 30 * MIN, 'b', 'start', { title: '調査\n2行目', costUsd: 0.2 }),
      sess(D20 + 40 * MIN, 'b', 'skill', { skill: 'review' }),
      sess(D20 + 50 * MIN, 'b', 'end', { reason: 'closed' }),
      // 翌日も続くセッション: 費用は前日までの最大値を差し引く
      sess(D21, 'a', 'turn', { costUsd: 2.0 }),
    ];
    const calendar = buildWorkCalendar(records, 2026, 11);
    expect(calendar.days.map((d) => d.day)).toEqual(['2026-11-20', '2026-11-21']);

    const day20 = calendar.days[0];
    expect(day20?.sessionCount).toBe(2);
    expect(day20?.skills).toEqual([{ name: 'review', count: 2 }]);
    // aは11月の分だけ（1.5 − 前月の0.5）、bは0.2
    expect(day20?.costUsd).toBeCloseTo(1.2);
    expect(day20?.units.map((u) => u.key).sort()).toEqual(['chain:claude:b', 'issue:2179']);
    expect(day20?.usage).toEqual([{ provider: 'claude', label: '5h', percent: 4 }]);
    const [a, b] = day20?.sessions ?? [];
    expect(a?.threadId).toBe('a');
    expect(a?.issue).toBe(2179);
    expect(a?.ended).toBe(false);
    expect(a?.turns).toBe(1);
    expect(b?.threadId).toBe('b');
    expect(b?.ended).toBe(true);
    expect(b?.title).not.toContain('\n');

    const day21 = calendar.days[1];
    expect(day21?.sessionCount).toBe(1);
    expect(day21?.costUsd).toBeCloseTo(0.5);
  });

  it('日の境目はローカル時刻の0時で、月の外の記録は日に入れない', () => {
    const lastNight = new Date(2026, 10, 20, 23, 59).getTime();
    const midnight = new Date(2026, 10, 21, 0, 0).getTime();
    const nextMonth = new Date(2026, 11, 1, 0, 0).getTime();
    const calendar = buildWorkCalendar(
      [sess(lastNight, 'x', 'start'), sess(midnight, 'y', 'start'), sess(nextMonth, 'z', 'start')],
      2026,
      11,
    );
    expect(calendar.days.map((d) => [d.day, d.sessions.map((s) => s.threadId)])).toEqual([
      ['2026-11-20', ['x']],
      ['2026-11-21', ['y']],
    ]);
  });

  it('不正なIssue番号は捨てる', () => {
    const calendar = buildWorkCalendar([sess(D20, 'a', 'start', { issue: -3 })], 2026, 11);
    expect(calendar.days[0]?.sessions[0]?.issue).toBeUndefined();
  });
});

describe('validCalendarMonth', () => {
  it('2000〜9999年・1〜12月の整数だけを受け付ける', () => {
    expect(validCalendarMonth(2026, 11)).toBe(true);
    expect(validCalendarMonth(2026, 0)).toBe(false);
    expect(validCalendarMonth(2026, 13)).toBe(false);
    expect(validCalendarMonth(2026.5, 1)).toBe(false);
    expect(validCalendarMonth('2026', 1)).toBe(false);
    expect(validCalendarMonth(1999, 1)).toBe(false);
  });
});

describe('workCalendarLogic', () => {
  it('月のマス目は日曜始まりで、前後の月のマスは空ける', () => {
    // 2026-11-01は日曜
    const weeks = monthGrid(2026, 11);
    expect(weeks[0]?.[0]).toBe(1);
    expect(weeks.flat().filter((d) => d !== undefined)).toHaveLength(30);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 2026-12-01は火曜
    expect(monthGrid(2026, 12)[0]?.slice(0, 3)).toEqual([undefined, undefined, 1]);
  });

  it('日・月の移動は月と年をまたぎ、日は月の日数に収める', () => {
    expect(shiftDay({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(shiftDay({ year: 2026, month: 3, day: 3 }, -7)).toEqual({
      year: 2026,
      month: 2,
      day: 24,
    });
    expect(shiftMonth({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(calendarDayKey({ year: 2026, month: 3, day: 4 })).toBe('2026-03-04');
  });

  it('作業量の段階は月の最大に対する比で1〜4、記録なしは0', () => {
    const calendar = buildWorkCalendar(
      [
        sess(D20, 'a', 'start'),
        sess(D20, 'b', 'start'),
        sess(D20, 'c', 'start'),
        sess(D21, 'd', 'start'),
      ],
      2026,
      11,
    );
    const [d20, d21] = calendar.days;
    expect(workLevel(d20, 3)).toBe(4);
    expect(workLevel(d21, 3)).toBe(2);
    expect(workLevel(undefined, 3)).toBe(0);
    expect(formatCellSummary(d20)).toBe('3件');
    expect(formatCellSummary(undefined)).toBe('');
  });

  it('1日の表示文字列', () => {
    const calendar = buildWorkCalendar(
      [
        sess(D20, 'a', 'start', { costUsd: 0.4 }),
        sess(D20 + MIN, 'a', 'skill', { skill: 'commit' }),
        sess(D20 + 2 * MIN, 'a', 'end', { reason: 'closed' }),
      ],
      2026,
      11,
    );
    const day = calendar.days[0];
    if (day === undefined) throw new Error('day');
    expect(formatDaySkills(day)).toBe('commit ×1');
    const text = formatCalendarSession(day.sessions[0] ?? (undefined as never));
    expect(text).toContain('閉じた');
    expect(text).toContain('$0.40');
    expect(text).toContain('skill: commit');
  });

  it('mでカレンダーを開く', () => {
    expect(
      resolveKey({ key: 'm', ctrlKey: false, metaKey: false, altKey: false, inEditable: false })
        ?.command,
    ).toEqual({ kind: 'workCalendar' });
  });
});
