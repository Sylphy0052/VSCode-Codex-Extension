import { describe, expect, it } from 'vitest';
import {
  activeSavedFilter,
  cycleSavedFilter,
  findSelectedTask,
  formatCapturedAt,
  formatCostTotal,
  formatUsageProjection,
  formatUsageSummary,
  formatUsageWindow,
  fromFilterSpec,
  isUsageLimited,
  isWindowStale,
  oneLine,
  projectUsage,
  sameFilter,
  taskOpBlockReason,
  toFilterSpec,
  totalCost,
} from '../../src/webview/missionControl/globalLogic';
import type { McFilter } from '../../src/webview/missionControl/logic';
import type {
  McRunTask,
  McSavedFilter,
  McSession,
  McUsageWindow,
} from '../../src/webview/missionControl/protocol';

const NOW = 1_800_000_000_000;

function win(overrides: Partial<McUsageWindow> = {}): McUsageWindow {
  return { label: '週次', limited: false, stale: false, ...overrides };
}

function task(taskId: string, overrides: Partial<McRunTask> = {}): McRunTask {
  return {
    taskId,
    title: `${taskId}のタイトル`,
    stage: '実装',
    badges: [],
    warn: false,
    done: false,
    ...overrides,
  };
}

const ALL: McFilter = {
  repoKey: undefined,
  provider: 'all',
  currentWindowOnly: false,
  query: '',
  activity: undefined,
};

describe('totalCost / formatCostTotal', () => {
  it('費用とトークン数を、分かったセッションだけ足す', () => {
    const sessions = [
      { costUsd: 1.5 },
      { costUsd: 0.25, tokens: Number.NaN },
      { tokens: 12_000 },
      { costUsd: Number.POSITIVE_INFINITY },
      {},
    ] as unknown as McSession[];
    const total = totalCost(sessions);
    expect(total).toEqual({ costUsd: 1.75, costSessions: 2, tokens: 12_000, tokenSessions: 1 });
    expect(formatCostTotal(total)).toBe('$1.75（Claude 2件） · 12.0k tokens（Codex 1件）');
  });

  it('どちらも分からなければ「取得できない」', () => {
    expect(formatCostTotal(totalCost([]))).toBe('取得できない');
  });
});

describe('利用枠の表示', () => {
  it('リセット前の窓は使用率・到達・残り時間を出す', () => {
    const w = win({ usedPercent: 42.4, resetsAt: NOW + 2 * 3_600_000 });
    expect(formatUsageWindow(w, NOW)).toBe('週次 42% ・あと2時間');
    expect(formatUsageWindow(win({ usedPercent: 100, limited: true }), NOW)).toBe('週次 100% 到達');
  });

  it('リセット時刻を過ぎた窓は使用率を出さない（上限に達していれば解除待ち）', () => {
    const past = win({ usedPercent: 80, resetsAt: NOW - 1 });
    expect(isWindowStale(past, NOW)).toBe(true);
    expect(formatUsageWindow(past, NOW)).toBe('週次 --（リセット済み）');
    expect(formatUsageWindow({ ...past, limited: true }, NOW)).toBe('週次 解除待ち');
    // ホストが付けたstaleも見る
    expect(isWindowStale(win({ stale: true }), NOW)).toBe(true);
    expect(isWindowStale(win({ resetsAt: NOW + 1 }), NOW)).toBe(false);
  });

  it('要約は今効いている窓のうち最も逼迫したものを出す', () => {
    const source = {
      windows: [
        win({ label: '5時間', usedPercent: 30, resetsAt: NOW + 60_000 }),
        win({ label: '週次', usedPercent: 90, resetsAt: NOW - 1 }),
        win({ label: '月次', usedPercent: 60 }),
      ],
    };
    expect(formatUsageSummary(source, NOW)).toBe('月次 60%');
    expect(
      formatUsageSummary({ windows: [...source.windows, win({ label: 'X', limited: true })] }, NOW),
    ).toBe('X 到達');
  });

  it('全部リセット済みなら、その中から出す。取得元が無ければ「取得できない」', () => {
    const stale = { windows: [win({ usedPercent: 10, resetsAt: NOW - 1 })] };
    expect(formatUsageSummary(stale, NOW)).toBe('週次 --（リセット済み）');
    expect(formatUsageSummary(undefined, NOW)).toBe('取得できない');
    expect(formatUsageSummary({ windows: [] }, NOW)).toBe('取得できない');
  });

  it('取得時刻と上限の有無', () => {
    expect(formatCapturedAt({ windows: [], capturedAt: NOW - 180_000 }, NOW)).toBe('3分前の値');
    expect(formatCapturedAt({ windows: [] }, NOW)).toBe('');
    expect(formatCapturedAt(undefined, NOW)).toBe('');
    expect(isUsageLimited({ windows: [win(), win({ limited: true })] })).toBe(true);
    expect(isUsageLimited({ windows: [win()] })).toBe(false);
    expect(isUsageLimited(undefined)).toBe(false);
  });

  it('窓の名前は1行にして長さを切る', () => {
    expect(formatUsageWindow(win({ label: '週\n次 偽の行' }), NOW)).toBe('週 次 偽の行');
  });
});

describe('利用枠の到達見込み（Issue #2174）', () => {
  const HOUR = 3_600_000;
  const FIVE_HOURS = 5 * HOUR;

  it('使用率 ÷ 経過割合 でリセット時の見込みを出し、届かなければ到達時刻は無い', () => {
    // 5時間窓の半分が過ぎて30% → リセット時60%
    const w = win({
      label: '5時間',
      usedPercent: 30,
      resetsAt: NOW + 2.5 * HOUR,
      windowMs: FIVE_HOURS,
    });
    expect(projectUsage(w, NOW)).toEqual({ atResetPercent: 60 });
    expect(formatUsageProjection(w, NOW)).toBe('見込み リセット時60%');
  });

  it('100%を超える見込みなら到達時刻を出す', () => {
    // 5時間窓の2時間が過ぎて80% → リセット時200%、2.5時間目（あと30分）で100%
    const w = win({
      label: '5時間',
      usedPercent: 80,
      resetsAt: NOW + 3 * HOUR,
      windowMs: FIVE_HOURS,
    });
    const projection = projectUsage(w, NOW);
    expect(projection?.atResetPercent).toBeCloseTo(200);
    expect(projection?.reachAt).toBe(NOW + 0.5 * HOUR);
    expect(formatUsageProjection(w, NOW)).toMatch(
      /^見込み リセット時200%・100%到達 \d{2}:\d{2}（あと30分）$/,
    );
  });

  it('長さ・リセット時刻・使用率のどれかが無い窓、到達済み・リセット済みの窓には出さない', () => {
    const base = { usedPercent: 50, resetsAt: NOW + HOUR, windowMs: FIVE_HOURS };
    expect(projectUsage(win({ ...base, windowMs: undefined }), NOW)).toBeUndefined();
    expect(projectUsage(win({ ...base, resetsAt: undefined }), NOW)).toBeUndefined();
    expect(projectUsage(win({ ...base, usedPercent: undefined }), NOW)).toBeUndefined();
    expect(projectUsage(win({ ...base, limited: true }), NOW)).toBeUndefined();
    // 到達の通知より先に使用率が100%に届いた窓
    expect(projectUsage(win({ ...base, usedPercent: 100 }), NOW)).toBeUndefined();
    expect(projectUsage(win({ ...base, usedPercent: 99 }), NOW)?.reachAt).toEqual(
      expect.any(Number),
    );
    expect(projectUsage(win({ ...base, resetsAt: NOW - 1 }), NOW)).toBeUndefined();
    expect(projectUsage(win({ ...base, windowMs: 0 }), NOW)).toBeUndefined();
    expect(formatUsageProjection(win({ ...base, windowMs: undefined }), NOW)).toBe('');
  });

  it('窓の始めの短い間と、リセット時刻が窓の長さより先にある窓には出さない', () => {
    // 経過5%未満（5時間窓で15分未満）
    const early = win({
      usedPercent: 1,
      resetsAt: NOW + FIVE_HOURS - 10 * 60_000,
      windowMs: FIVE_HOURS,
    });
    expect(projectUsage(early, NOW)).toBeUndefined();
    // 窓の長さより先のリセット時刻は、窓がまだ始まっていない（経過が負）
    const future = win({ usedPercent: 1, resetsAt: NOW + 2 * FIVE_HOURS, windowMs: FIVE_HOURS });
    expect(projectUsage(future, NOW)).toBeUndefined();
  });

  it('使用率0%なら見込みも0%で、到達時刻は無い', () => {
    const w = win({ usedPercent: 0, resetsAt: NOW + HOUR, windowMs: FIVE_HOURS });
    expect(projectUsage(w, NOW)).toEqual({ atResetPercent: 0 });
  });
});

describe('oneLine', () => {
  it('制御文字・改行を空白にし、連続する空白を詰め、文字数で切る', () => {
    expect(oneLine(' a\r\n\tb\u0000c ', 10)).toBe('a b c');
    expect(oneLine('あいうえお', 3)).toBe('あいう…');
    // サロゲートペアを途中で切らない
    expect(oneLine('😀😀😀', 2)).toBe('😀😀…');
  });
});

describe('保存した絞り込み', () => {
  const codex: McSavedFilter = {
    name: 'Codex',
    filter: { provider: 'codex', currentWindowOnly: false, query: '' },
  };
  const repo: McSavedFilter = {
    name: 'repo',
    filter: { provider: 'all', currentWindowOnly: true, query: 'x', repoKey: '/r' },
  };
  const saved = [codex, repo];

  it('toFilterSpec / fromFilterSpecで往復でき、undefinedのキーは保存しない', () => {
    const spec = toFilterSpec(ALL);
    expect(Object.keys(spec).sort()).toEqual(['currentWindowOnly', 'provider', 'query']);
    expect(fromFilterSpec(spec)).toEqual(ALL);
    const full: McFilter = { ...ALL, repoKey: '/r', activity: 'running' };
    expect(fromFilterSpec(toFilterSpec(full))).toEqual(full);
    expect(sameFilter(full, toFilterSpec(full))).toBe(true);
    expect(sameFilter(ALL, toFilterSpec(full))).toBe(false);
  });

  it('今の絞り込みと同じ中身の保存を見つける', () => {
    expect(activeSavedFilter(saved, fromFilterSpec(repo.filter))).toBe(repo);
    expect(activeSavedFilter(saved, ALL)).toBeUndefined();
  });

  it('] / [ で回す。どれとも違えば ] は先頭、[ は末尾', () => {
    expect(cycleSavedFilter(saved, ALL, 1)).toBe(codex);
    expect(cycleSavedFilter(saved, ALL, -1)).toBe(repo);
    expect(cycleSavedFilter(saved, fromFilterSpec(codex.filter), 1)).toBe(repo);
    expect(cycleSavedFilter(saved, fromFilterSpec(repo.filter), 1)).toBe(codex);
    expect(cycleSavedFilter(saved, fromFilterSpec(codex.filter), -1)).toBe(repo);
    expect(cycleSavedFilter([], ALL, 1)).toBeUndefined();
  });
});

describe('runのタスク単位の操作の対象', () => {
  const tasks = [task('T1', { canRetry: true }), task('T2', { canStop: true })];

  it('選んだidが今のrunに無ければ、先頭のタスクを選んだ扱いにしない', () => {
    expect(findSelectedTask(tasks, undefined)).toBeUndefined();
    expect(findSelectedTask(tasks, 'T9')).toBeUndefined();
    expect(findSelectedTask(tasks, 'T2')?.taskId).toBe('T2');
    expect(findSelectedTask([], 'T1')).toBeUndefined();
  });

  it('選んでいない・今のrunに無いタスクへの操作は送らない', () => {
    expect(taskOpBlockReason(tasks, undefined, 'retry')).toBe(
      'タスクを選んでください（Shift+J / Shift+K）',
    );
    // 別のrunで選んだidは、今のrunに無ければ選んでいない扱い
    expect(taskOpBlockReason(tasks, 'T9', 'stop')).toBe(
      'タスクを選んでください（Shift+J / Shift+K）',
    );
  });

  it('やり直せない・止められないタスクへの操作は送らない', () => {
    expect(taskOpBlockReason(tasks, 'T1', 'retry')).toBeUndefined();
    expect(taskOpBlockReason(tasks, 'T1', 'stop')).toBe('T1は今止められる工程がありません');
    expect(taskOpBlockReason(tasks, 'T2', 'stop')).toBeUndefined();
    expect(taskOpBlockReason(tasks, 'T2', 'retry')).toBe('T2は今やり直せません');
  });
});
