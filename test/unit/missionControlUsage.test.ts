import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../src/codex/usage';
import { buildMcUsage } from '../../src/view/missionControlUsage';
import { parseRunTaskOp } from '../../src/view/missionControlRuns';
import { projectUsage } from '../../src/webview/missionControl/globalLogic';

const NOW = 1_800_000_000_000;
const NOW_SEC = NOW / 1000;

function codex(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    capturedAt: undefined,
    usedPercent: 40,
    windowMinutes: 10080,
    resetsAt: NOW_SEC + 3600,
    windows: [],
    planType: undefined,
    creditsBalance: undefined,
    ...overrides,
  } as UsageSnapshot;
}

describe('buildMcUsage', () => {
  it('取得できていない取得元は返さない', () => {
    expect(
      buildMcUsage({ codex: undefined, claude: [], claudeReceivedAt: undefined }, NOW),
    ).toEqual({});
    expect(
      buildMcUsage(
        { codex: codex({ usedPercent: undefined }), claude: [], claudeReceivedAt: undefined },
        NOW,
      ),
    ).toEqual({});
  });

  it('Codexの代表値を1つの窓にし、取得時刻とプラン名を付ける', () => {
    const usage = buildMcUsage(
      {
        codex: codex({ capturedAt: new Date(NOW - 60_000).toISOString(), planType: 'pro\nX' }),
        claude: [],
        claudeReceivedAt: undefined,
      },
      NOW,
    );
    expect(usage.codex).toEqual({
      windows: [
        {
          label: '週次',
          usedPercent: 40,
          resetsAt: NOW + 3_600_000,
          windowMs: 10080 * 60_000,
          limited: false,
          stale: false,
        },
      ],
      capturedAt: NOW - 60_000,
      plan: 'pro X',
    });
  });

  it('窓ごとの値があれば窓ごとに出し、100%は到達、リセット時刻を過ぎたものはstale', () => {
    const usage = buildMcUsage(
      {
        codex: codex({
          capturedAt: 'not a date',
          windows: [
            {
              limitId: undefined,
              slot: 'primary',
              usedPercent: 100,
              windowMinutes: 300,
              resetsAt: NOW_SEC - 1,
            },
            {
              limitId: undefined,
              slot: 'secondary',
              usedPercent: 20,
              windowMinutes: 10080,
              resetsAt: NOW_SEC + 60,
            },
          ] as UsageSnapshot['windows'],
        }),
        claude: [],
        claudeReceivedAt: undefined,
      },
      NOW,
    );
    expect(usage.codex?.capturedAt).toBeUndefined();
    expect(usage.codex?.windows.map((w) => [w.limited, w.stale, w.usedPercent])).toEqual([
      [true, true, 100],
      [false, false, 20],
    ]);
    expect(usage.codex?.windows[1]?.label).toBe('週次');
    // 窓ごとの長さを見込みのために渡す（Issue #2174）
    expect(usage.codex?.windows.map((w) => w.windowMs)).toEqual([300 * 60_000, 10080 * 60_000]);
  });

  it('Claudeは値のある枠だけを出し、受け取った時刻を付け、上限は解除の通知まで残す', () => {
    const usage = buildMcUsage(
      {
        codex: undefined,
        claude: [
          { label: '5時間', usedPercent: 70, resetsAt: NOW_SEC + 60, limited: undefined },
          { label: undefined, usedPercent: undefined, resetsAt: undefined, limited: undefined },
          { label: '週次\n偽', usedPercent: undefined, resetsAt: NOW_SEC - 1, limited: true },
          { label: 'x', usedPercent: Number.NaN, resetsAt: Number.NaN, limited: true },
        ],
        claudeReceivedAt: NOW - 5000,
      },
      NOW,
    );
    expect(usage.claude).toEqual({
      windows: [
        {
          label: '5時間',
          usedPercent: 70,
          resetsAt: NOW + 60_000,
          windowMs: 5 * 3_600_000,
          limited: false,
          stale: false,
        },
        { label: '週次 偽', resetsAt: NOW - 1000, limited: true, stale: true },
        { label: 'x', limited: true, stale: false },
      ],
      capturedAt: NOW - 5000,
    });
  });

  it('Claudeは表示名から長さが決まる枠（5時間・週次）だけに窓の長さを付ける', () => {
    const usage = buildMcUsage(
      {
        codex: undefined,
        claude: [
          { label: '5時間', usedPercent: 10, resetsAt: NOW_SEC + 60, limited: undefined },
          { label: '週次', usedPercent: 20, resetsAt: NOW_SEC + 60, limited: undefined },
          { label: 'セッション', usedPercent: 30, resetsAt: NOW_SEC + 60, limited: undefined },
          { label: 'toString', usedPercent: 40, resetsAt: NOW_SEC + 60, limited: undefined },
          { label: undefined, usedPercent: 50, resetsAt: NOW_SEC + 60, limited: undefined },
        ],
        claudeReceivedAt: undefined,
      },
      NOW,
    );
    expect(usage.claude?.windows.map((w) => [w.label, w.windowMs])).toEqual([
      ['5時間', 5 * 3_600_000],
      ['週次', 7 * 24 * 3_600_000],
      ['セッション', undefined],
      ['toString', undefined],
      ['制限', undefined],
    ]);
  });

  it('/usageの5時間枠と週次を同じ表示名の枠へ重ね、見込みに要る組を揃える（Issue #2174）', () => {
    const usage = buildMcUsage(
      {
        codex: undefined,
        claude: [
          // rate_limit_event由来: リセット時刻と到達だけ
          { label: '5時間', usedPercent: undefined, resetsAt: NOW_SEC + 7200, limited: true },
          // /usage由来: 使用率だけ
          { label: 'セッション', usedPercent: 16, resetsAt: undefined, limited: undefined },
        ],
        claudeReceivedAt: NOW - 5000,
        claudeSlots: {
          slots: {
            fiveHour: { pct: 16, resetsAt: NOW + 3_600_000 },
            weekly: { pct: 23, resetsAt: NOW + 86_400_000 },
          },
          readAt: NOW - 60_000,
        },
      },
      NOW,
    );
    expect(usage.claude).toEqual({
      windows: [
        {
          label: '5時間',
          usedPercent: 16,
          resetsAt: NOW + 3_600_000,
          windowMs: 5 * 3_600_000,
          limited: true,
          stale: false,
        },
        { label: 'セッション', usedPercent: 16, limited: false, stale: false },
        {
          label: '週次',
          usedPercent: 23,
          resetsAt: NOW + 86_400_000,
          windowMs: 7 * 24 * 3_600_000,
          limited: false,
          stale: false,
        },
      ],
      // 重ねた値のうち最も古い受け取り時刻
      capturedAt: NOW - 60_000,
    });
    // 画面側の計算に渡すと見込みが出る（週次の6/7が過ぎて23% → リセット時約27%）
    const weekly = usage.claude?.windows[2];
    expect(weekly && projectUsage(weekly, NOW)?.atResetPercent).toBeCloseTo((23 * 7) / 6);
  });

  it('/usageの値のリセット時刻を過ぎていれば、ステータスバーの枠をそのまま使う（Issue #2174）', () => {
    const entry = {
      label: '5時間',
      usedPercent: undefined,
      resetsAt: NOW_SEC + 7200,
      limited: false,
    };
    const usage = buildMcUsage(
      {
        codex: undefined,
        claude: [entry],
        claudeReceivedAt: NOW - 5000,
        claudeSlots: {
          slots: { fiveHour: { pct: 90, resetsAt: NOW - 1000 }, weekly: undefined },
          readAt: NOW - 6 * 3_600_000,
        },
      },
      NOW,
    );
    expect(usage.claude).toEqual({
      windows: [
        {
          label: '5時間',
          resetsAt: NOW + 7_200_000,
          windowMs: 5 * 3_600_000,
          limited: false,
          stale: false,
        },
      ],
      capturedAt: NOW - 5000,
    });
  });

  it('Claudeに値のある枠が無ければ返さない', () => {
    const usage = buildMcUsage(
      {
        codex: undefined,
        claude: [{ label: 'a', usedPercent: undefined, resetsAt: undefined, limited: false }],
        claudeReceivedAt: NOW,
      },
      NOW,
    );
    expect(usage.claude).toBeUndefined();
  });
});

describe('parseRunTaskOp', () => {
  it('操作・run・タスクの固定idの形が合えば受ける', () => {
    expect(
      parseRunTaskOp({ type: 'runTaskOp', op: 'retry', runId: 'run-1', taskId: 'T6' }),
    ).toEqual({ op: 'retry', runId: 'run-1', taskId: 'T6' });
    expect(parseRunTaskOp({ op: 'stop', runId: 'abc', taskId: '_t-1' })).toEqual({
      op: 'stop',
      runId: 'abc',
      taskId: '_t-1',
    });
  });

  it('知らない操作・型の違う値・__proto__などを拒む', () => {
    for (const op of ['delete', '__proto__', 'toString', 1, undefined, ['retry']]) {
      expect(parseRunTaskOp({ op, runId: 'run-1', taskId: 'T1' })).toBe('操作が正しくありません');
    }
  });

  it('不正なrunのidを拒む', () => {
    for (const runId of ['', '../x', '-run', 'a b', 'x'.repeat(65), 1, null, '__proto__']) {
      expect(parseRunTaskOp({ op: 'stop', runId, taskId: 'T1' })).toBe('runが正しくありません');
    }
  });

  it('不正なタスクのidを拒む', () => {
    for (const taskId of [
      '',
      '-T1',
      'T 1',
      'T1\n',
      '../T1',
      'T.1',
      '__proto__',
      'constructor',
      'prototype',
      'x'.repeat(51),
      1,
      null,
      {},
      ['T1'],
    ]) {
      expect(parseRunTaskOp({ op: 'stop', runId: 'run-1', taskId })).toBe(
        'タスクが正しくありません',
      );
    }
  });

  it('継承したプロパティ・JSONの__proto__キーからは値を読まない', () => {
    const inherited = Object.create({ op: 'retry', runId: 'run-1', taskId: 'T1' }) as Record<
      string,
      unknown
    >;
    expect(parseRunTaskOp(inherited)).toBe('操作が正しくありません');
    const polluted = JSON.parse(
      '{"__proto__":{"op":"retry","runId":"run-1","taskId":"T1"}}',
    ) as Record<string, unknown>;
    expect(parseRunTaskOp(polluted)).toBe('操作が正しくありません');
  });
});
