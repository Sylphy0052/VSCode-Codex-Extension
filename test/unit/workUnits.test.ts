import { describe, expect, it } from 'vitest';
import type {
  WorkHistoryRecord,
  WorkHistorySessionRecord,
  WorkHistoryUsageRecord,
} from '../../src/view/workHistory';
import { aggregateWorkUnits, validIssueNumber } from '../../src/view/workUnits';
import type { McWorkUnit } from '../../src/webview/missionControl/protocol';
import {
  formatWorkUnitConsumption,
  nextWorkUnitPeriod,
  nextWorkUnitSort,
  sortWorkUnits,
  workUnitHeading,
} from '../../src/webview/missionControl/workUnitsLogic';

const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();

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

function usage(
  at: number,
  usedPercent: number,
  extra: { resetsAt?: number; label?: string; provider?: 'claude' | 'codex' } = {},
): WorkHistoryUsageRecord {
  return {
    v: 1,
    kind: 'usage',
    at,
    windowId: 'w1',
    provider: extra.provider ?? 'claude',
    windows: [
      {
        label: extra.label ?? '5h',
        usedPercent,
        resetsAt: extra.resetsAt ?? T0 + 5 * 60 * MIN,
        sampledAt: at,
        limited: false,
      },
    ],
  };
}

function unitFor(units: McWorkUnit[], key: string): McWorkUnit {
  const unit = units.find((u) => u.key === key);
  if (unit === undefined) throw new Error(`no unit ${key}: ${units.map((u) => u.key).join(',')}`);
  return unit;
}

describe('aggregateWorkUnits', () => {
  it('handoffで分かれたセッションを1つのIssueの単位にまとめ、費用はセッションごとの最大値を足す', () => {
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'start', {
        title: 'Issue #2177 の実装',
        branch: 'feature/2177/x',
        issue: 2177,
      }),
      sess(T0 + 10 * MIN, 'a', 'turn', { issue: 2177, costUsd: 1 }),
      sess(T0 + 20 * MIN, 'a', 'turn', { issue: 2177, costUsd: 2.5 }),
      sess(T0 + 30 * MIN, 'a', 'handoff', { childThreadId: 'b' }),
      // 引き継ぎ先はタイトルにもブランチにもIssue番号が無い
      sess(T0 + 31 * MIN, 'b', 'start', { title: '引き継ぎ' }),
      sess(T0 + 60 * MIN, 'b', 'turn', { costUsd: 0.5 }),
      sess(T0 + 61 * MIN, 'b', 'handoff', { childThreadId: 'c' }),
      sess(T0 + 24 * 60 * MIN, 'c', 'turn', { title: '続き', costUsd: 0.25 }),
    ];
    const units = aggregateWorkUnits(records);
    expect(units).toHaveLength(1);
    const unit = unitFor(units, 'issue:2177');
    expect(unit.issue).toBe(2177);
    expect(unit.sessionCount).toBe(3);
    expect(unit.costUsd).toBeCloseTo(3.25);
    expect(unit.tokens).toBeUndefined();
    expect(unit.firstAt).toBe(T0);
    expect(unit.lastAt).toBe(T0 + 24 * 60 * MIN);
    expect(unit.days).toEqual(['2026-11-20', '2026-11-21']);
    expect(unit.title).toBe('続き');
    expect(unit.branch).toBe('feature/2177/x');
  });

  it('Issue番号の無い連鎖はhandoffで1単位にまとめ、つながらないセッションは別の単位にする', () => {
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'start', { title: '調査' }),
      sess(T0 + MIN, 'a', 'handoff', { childThreadId: 'b' }),
      sess(T0 + 2 * MIN, 'b', 'start', { title: '調査の続き' }),
      sess(T0 + 3 * MIN, 'z', 'start', { title: '別件' }),
    ];
    const units = aggregateWorkUnits(records);
    expect(units).toHaveLength(2);
    const chain = unitFor(units, 'chain:claude:a');
    expect(chain.issue).toBeUndefined();
    expect(chain.sessionCount).toBe(2);
    expect(unitFor(units, 'chain:claude:z').sessionCount).toBe(1);
  });

  it('handoffでつながっていなくても同じIssue番号は1単位にし、別々のIssue番号の親子はつながない', () => {
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'start', { issue: 10, title: '#10' }),
      sess(T0 + MIN, 'b', 'start', { issue: 10, title: '#10 別の日' }),
      sess(T0 + 2 * MIN, 'c', 'start', { issue: 20 }),
      sess(T0 + 3 * MIN, 'c', 'handoff', { childThreadId: 'd', issue: 20 }),
      sess(T0 + 4 * MIN, 'd', 'start', { issue: 30 }),
    ];
    const units = aggregateWorkUnits(records);
    expect(unitFor(units, 'issue:10').sessionCount).toBe(2);
    expect(unitFor(units, 'issue:20').sessionCount).toBe(1);
    expect(unitFor(units, 'issue:30').sessionCount).toBe(1);
  });

  it('番号の無いセッションを挟んでも、別々のIssue番号の単位どうしはつながない', () => {
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'start', { issue: 10 }),
      sess(T0 + MIN, 'a', 'handoff', { childThreadId: 'b', issue: 10 }),
      sess(T0 + 2 * MIN, 'b', 'start', {}),
      sess(T0 + 3 * MIN, 'b', 'handoff', { childThreadId: 'c' }),
      sess(T0 + 4 * MIN, 'c', 'start', { issue: 20 }),
      sess(T0 + 5 * MIN, 'z', 'start', { issue: 20 }),
    ];
    const units = aggregateWorkUnits(records);
    expect(units).toHaveLength(2);
    expect(unitFor(units, 'issue:10')).toMatchObject({ issues: [10], sessionCount: 2 });
    expect(unitFor(units, 'issue:20')).toMatchObject({ issues: [20], sessionCount: 2 });
  });

  it('期間を渡すと範囲内の記録だけを数え、費用・トークンは期間前の累計を差し引く', () => {
    const DAY = 24 * 60 * MIN;
    const since = T0 + 3 * DAY;
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'turn', { issue: 1, costUsd: 50, title: '期間前' }),
      sess(T0 + 5 * DAY, 'a', 'turn', { issue: 1, costUsd: 51 }),
      sess(T0 + 5 * DAY, 'x', 'turn', { issue: 3, provider: 'codex', tokens: 1000 }),
      sess(T0 + 6 * DAY, 'x', 'turn', { issue: 3, provider: 'codex', tokens: 1500 }),
      sess(T0 + 5 * DAY, 'b', 'turn', { issue: 2, costUsd: 10 }),
      // 期間前だけのセッションは数えない
      sess(T0, 'old', 'turn', { issue: 9, costUsd: 100 }),
    ];
    const units = aggregateWorkUnits(records, { since });
    expect(units.map((u) => u.key).sort()).toEqual(['issue:1', 'issue:2', 'issue:3']);
    expect(unitFor(units, 'issue:1').costUsd).toBeCloseTo(1);
    expect(unitFor(units, 'issue:1').firstAt).toBe(T0 + 5 * DAY);
    expect(unitFor(units, 'issue:1').title).toBe('');
    expect(unitFor(units, 'issue:2').costUsd).toBeCloseTo(10);
    expect(unitFor(units, 'issue:3').tokens).toBe(1500);
    expect(sortWorkUnits(units, 'cost').map((u) => u.key)).toEqual([
      'issue:2',
      'issue:1',
      'issue:3',
    ]);
    // untilより後の記録は数えない
    const until = aggregateWorkUnits(records, { since, until: T0 + 6 * DAY });
    expect(unitFor(until, 'issue:3').tokens).toBe(1000);
  });

  it('数字として正しくないIssue番号は使わない', () => {
    const records = [
      sess(T0, 'a', 'start', { issue: 1.5 }),
      sess(T0, 'b', 'start', { issue: -3 }),
      sess(T0, 'c', 'start', { issue: Number.MAX_SAFE_INTEGER }),
      sess(T0, 'd', 'start', { issue: '12' as unknown as number }),
    ];
    const units = aggregateWorkUnits(records);
    expect(units.every((u) => u.issue === undefined && u.key.startsWith('chain:'))).toBe(true);
    expect(validIssueNumber(2177)).toBe(2177);
    expect(validIssueNumber(0)).toBeUndefined();
    expect(validIssueNumber(Number.NaN)).toBeUndefined();
  });

  it('利用枠の増分を、計測の間にターンを終えたセッションへターンの回数の比で割り当てる', () => {
    const records: WorkHistoryRecord[] = [
      sess(T0, 'a', 'start', { issue: 1 }),
      sess(T0, 'b', 'start', { issue: 2 }),
      usage(T0 + MIN, 10),
      sess(T0 + 2 * MIN, 'a', 'turn', { issue: 1 }),
      sess(T0 + 3 * MIN, 'a', 'turn', { issue: 1 }),
      sess(T0 + 4 * MIN, 'b', 'turn', { issue: 2 }),
      usage(T0 + 5 * MIN, 16),
      // 同じ計測を別のウィンドウが書いても二重に数えない
      { ...usage(T0 + 5 * MIN, 16), windowId: 'w2' },
      // ターンの無い区間は、記録のあったセッションへ等分する
      sess(T0 + 6 * MIN, 'b', 'update', { issue: 2 }),
      usage(T0 + 7 * MIN, 18),
    ];
    const units = aggregateWorkUnits(records);
    expect(unitFor(units, 'issue:1').usageScore).toBeCloseTo(4);
    expect(unitFor(units, 'issue:2').usageScore).toBeCloseTo(4);
    expect(unitFor(units, 'issue:2').usage).toEqual([
      { provider: 'claude', label: '5h', percent: expect.closeTo(4) },
    ]);
  });

  it('リセットをまたぐ区間は後の計測値そのものを増分にし、別のproviderの記録には割り当てない', () => {
    const resetA = T0 + 10 * MIN;
    const resetB = T0 + 5 * 60 * MIN;
    const records: WorkHistoryRecord[] = [
      usage(T0, 80, { resetsAt: resetA }),
      sess(T0 + 15 * MIN, 'a', 'turn', { issue: 1 }),
      sess(T0 + 15 * MIN, 'x', 'turn', { issue: 9, provider: 'codex' }),
      usage(T0 + 20 * MIN, 3, { resetsAt: resetB }),
    ];
    const units = aggregateWorkUnits(records);
    expect(unitFor(units, 'issue:1').usageScore).toBeCloseTo(3);
    expect(unitFor(units, 'issue:9').usageScore).toBe(0);
  });
});

function unit(partial: Partial<McWorkUnit> & { key: string }): McWorkUnit {
  return {
    issues: [],
    title: '',
    providers: ['claude'],
    firstAt: T0,
    lastAt: T0,
    days: [],
    sessionCount: 1,
    usage: [],
    usageScore: 0,
    ...partial,
  };
}

describe('workUnitsLogic', () => {
  it('基準の多い順に並べ、同じ値は費用で比べる', () => {
    const units = [
      unit({ key: 'a', costUsd: 1, sessionCount: 3 }),
      unit({ key: 'b', costUsd: 5, sessionCount: 1 }),
      unit({ key: 'c', costUsd: 2, sessionCount: 3 }),
    ];
    expect(sortWorkUnits(units, 'cost').map((u) => u.key)).toEqual(['b', 'c', 'a']);
    expect(sortWorkUnits(units, 'sessions').map((u) => u.key)).toEqual(['c', 'a', 'b']);
    // 元の配列は変えない
    expect(units.map((u) => u.key)).toEqual(['a', 'b', 'c']);
  });

  it('並べ替えと期間を順に回す', () => {
    expect(nextWorkUnitSort('cost')).toBe('usage');
    expect(nextWorkUnitSort('recent')).toBe('cost');
    expect(nextWorkUnitPeriod(30)).toBe(7);
    expect(nextWorkUnitPeriod(0)).toBe(30);
  });

  it('見出しと消費の要約を作る', () => {
    expect(workUnitHeading(unit({ key: 'k', issue: 5, issues: [5, 7], title: 'T' }))).toBe(
      '#5（ほか#7） T',
    );
    expect(workUnitHeading(unit({ key: 'k' }))).toBe('Issue番号なし（handoffの連鎖）');
    expect(
      formatWorkUnitConsumption(
        unit({
          key: 'k',
          costUsd: 1.234,
          tokens: 45_600,
          usage: [{ provider: 'claude', label: '5h', percent: 12.34 }],
        }),
      ),
    ).toBe('$1.23 · 45.6k tok · 利用枠 Claude 5h 12.3%');
    expect(formatWorkUnitConsumption(unit({ key: 'k' }))).toBe('費用・利用枠の記録なし');
  });
});
