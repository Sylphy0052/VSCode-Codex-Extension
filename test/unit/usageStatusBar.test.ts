import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatUsage } from '../../src/appserver/chatState';
import { readRateLimits, type UsageSnapshot } from '../../src/codex/usage';
import { UsageStatusBar } from '../../src/view/usageStatusBar';
import { __mock } from '../mocks/vscode';

/** 実装が持つ `vscode.StatusBarItem`（モックは `FakeStatusBarItem`）を覗く。 */
function textOf(bar: InstanceType<typeof UsageStatusBar>): string {
  return (bar as unknown as { item: { text: string } })['item'].text;
}

function tooltipOf(bar: InstanceType<typeof UsageStatusBar>): string {
  return (
    (bar as unknown as { item: { tooltip: { value: string } | undefined } })['item'].tooltip
      ?.value ?? ''
  );
}

function backgroundOf(bar: InstanceType<typeof UsageStatusBar>): string | undefined {
  return (bar as unknown as { item: { backgroundColor: { id: string } | undefined } })['item']
    .backgroundColor?.id;
}

const snapshot = (usedPercent: number | undefined): UsageSnapshot => ({
  capturedAt: undefined,
  usedPercent,
  windowMinutes: undefined,
  resetsAt: undefined,
  windows: [],
  planType: undefined,
  creditsBalance: undefined,
  hasCredits: undefined,
  totalTokens: undefined,
  contextWindow: undefined,
});

describe('UsageStatusBar のゲージ（issue #756）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定ではゲージを数字の手前へ添える', () => {
    const bar = new UsageStatusBar();
    bar.update(snapshot(62));
    expect(textOf(bar)).toBe('$(pulse) Codex ▮▮▮▯▯ 62%');
  });

  it('設定を無効にすると数字だけに戻る', () => {
    __mock.setConfig('codex', { 'usage.statusBarGauge': false });
    const bar = new UsageStatusBar();
    bar.update(snapshot(62));
    expect(textOf(bar)).toBe('$(pulse) Codex 62%');
  });

  it('使用量が増減してもゲージの幅は変わらない', () => {
    const bar = new UsageStatusBar();
    const widths = new Set<number>();
    for (const percent of [0, 3, 25, 51, 77, 99, 100]) {
      bar.update(snapshot(percent));
      const gauge = textOf(bar).replace('$(pulse) Codex ', '').split(' ')[0] ?? '';
      // 陽性対照: そもそもゲージ部分を取り出せているか（取り出せていないと幅が揃って見える）
      expect(gauge).toMatch(/^[▮▯]+$/);
      widths.add([...gauge].length);
    }
    expect([...widths]).toEqual([5]);
  });

  it('危険域の背景色はゲージを添えても従来どおり付く', () => {
    const bar = new UsageStatusBar();
    bar.update(snapshot(50));
    expect(backgroundOf(bar)).toBeUndefined();
    bar.update(snapshot(80));
    expect(backgroundOf(bar)).toBe('statusBarItem.warningBackground');
    bar.update(snapshot(95));
    expect(backgroundOf(bar)).toBe('statusBarItem.errorBackground');
  });

  it('ゲージを作れない値でも余分な空白を残さない', () => {
    const bar = new UsageStatusBar();
    // `usedPercent` が undefined でなければ表示へ進むため、NaN はここまで来る
    bar.update(snapshot(Number.NaN));
    expect(textOf(bar)).not.toContain('Codex  ');
  });

  it('未取得のときの表示は変わらない', () => {
    const bar = new UsageStatusBar();
    bar.update(undefined);
    expect(textOf(bar)).toBe('$(pulse) Codex --');
    bar.update(snapshot(undefined));
    expect(textOf(bar)).toBe('$(pulse) Codex --');
  });
});

describe('UsageStatusBar のツールチップ（issue #1212）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('窓ごとに1行出す', () => {
    const bar = new UsageStatusBar();
    // 取得応答から組み立てる。窓の配列を直接作ると、読み取り側が primary しか採らなくても
    // このテストは通ってしまう
    const fromApi = readRateLimits(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 20, windowDurationMins: 300 },
          secondary: { usedPercent: 100, windowDurationMins: 10080 },
        },
      },
      '2026-09-14T00:00:00Z',
    );
    bar.update(fromApi);
    expect(tooltipOf(bar)).toContain('- 5時間: 20% 使用');
    expect(tooltipOf(bar)).toContain('- 週次: 100% 使用');
    // 見出しは最も逼迫した窓
    expect(textOf(bar)).toContain('100%');
  });

  it('窓が届いていなければ従来どおり代表値の1行だけ出す', () => {
    const bar = new UsageStatusBar();
    bar.update({ ...snapshot(62), windowMinutes: 10080 });
    expect(tooltipOf(bar)).toContain('- 週次: 62% 使用');
  });
});

/** Claude側の項目。Codexとは別のStatusBarItemを持つ。 */
function claudeTextOf(bar: InstanceType<typeof UsageStatusBar>): string {
  return (bar as unknown as { claudeItem: { text: string } })['claudeItem'].text;
}

function claudeTooltipOf(bar: InstanceType<typeof UsageStatusBar>): string {
  return (
    (bar as unknown as { claudeItem: { tooltip: { value: string } | undefined } })['claudeItem']
      .tooltip?.value ?? ''
  );
}

function claudeBackgroundOf(bar: InstanceType<typeof UsageStatusBar>): string | undefined {
  return (bar as unknown as { claudeItem: { backgroundColor: { id: string } | undefined } })[
    'claudeItem'
  ].backgroundColor?.id;
}

const claudeUsage = (over: Partial<ChatUsage>): ChatUsage => ({
  usedPercent: undefined,
  resetsAt: undefined,
  limitLabel: undefined,
  limited: undefined,
  ...over,
});

/**
 * 表示は実時刻を見るため、テストからは現在時刻からの相対で時刻を作る。
 * 残り時間は切り捨てで出すので、1分の余裕を足して境界をまたがないようにする。
 */
const inHours = (hours: number): number => Math.ceil(Date.now() / 1000) + hours * 3600 + 60;

describe('UsageStatusBar のClaude制限表示（issue #1221）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('割合だけの取得が到達とリセット時刻を消さない', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: inHours(2) }));
    bar.updateClaude(claudeUsage({ limitLabel: 'セッション', usedPercent: 16 }));
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 2時間後');
    expect(claudeBackgroundOf(bar)).toBe('statusBarItem.warningBackground');
    // 見出しに出ない枠はツールチップで読める
    expect(claudeTooltipOf(bar)).toContain('- セッション: 16% 使用');
  });

  it('取得の順序が逆でも同じ表示になる', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: 'セッション', usedPercent: 16 }));
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: inHours(2) }));
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 2時間後');
    expect(claudeBackgroundOf(bar)).toBe('statusBarItem.warningBackground');
    expect(claudeTooltipOf(bar)).toContain('- セッション: 16% 使用');
  });

  it('同じ枠の新しい値は上書きし、届かなかった項目は前の値を残す', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '5時間', limited: true, resetsAt: inHours(3) }));
    bar.updateClaude(claudeUsage({ limitLabel: '5時間', limited: false }));
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 5時間 ・ 3時間後');
    expect(claudeBackgroundOf(bar)).toBeUndefined();
  });

  it('到達した枠が複数あればリセットの遅いほうを見出しにする', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '5時間', limited: true, resetsAt: inHours(2) }));
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: inHours(30) }));
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 1日後');
  });

  it('一度も届いていなければ項目を隠す', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(undefined);
    expect(claudeTextOf(bar)).toBe('');
  });
});

describe('UsageStatusBar の定期描画（issue #1224）', () => {
  /** 時計を止めて進める。実装は `Date.now()` と `setInterval` を直接使う。 */
  const START = Date.UTC(2026, 8, 14, 0, 0, 0);
  const epochIn = (hours: number): number => Math.floor(START / 1000) + hours * 3600;

  beforeEach(() => {
    __mock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('通知を追加せず時刻だけ進めるとClaudeの残り時間が進む', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: epochIn(2) }));
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 2時間後');

    vi.advanceTimersByTime(60 * 60 * 1000);

    // 陽性対照: 表示そのものが消えたのではなく、残り時間だけが変わっている
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 1時間後');
    bar.dispose();
  });

  it('Codex側の残り時間も進む', () => {
    const bar = new UsageStatusBar();
    bar.update({ ...snapshot(62), resetsAt: epochIn(2) });
    expect(textOf(bar)).toContain('2時間後');

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(textOf(bar)).toContain('1時間後');
    bar.dispose();
  });

  it('リセット時刻を過ぎたら解除待ちとして出し、警告背景を保つ', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: epochIn(1) }));

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // 「まもなく」だと時刻が過ぎたことと上限が解けたことを読み分けられない
    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 解除待ち');
    expect(claudeBackgroundOf(bar)).toBe('statusBarItem.warningBackground');
    expect(claudeTooltipOf(bar)).toContain('リセット時刻を過ぎましたが解除の通知は届いていません');
    bar.dispose();
  });

  it('解除の通知が届けば解除待ちの表示をやめる', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: epochIn(1) }));
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(claudeTextOf(bar)).toContain('解除待ち');

    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: false }));

    expect(claudeTextOf(bar)).not.toContain('解除待ち');
    expect(claudeBackgroundOf(bar)).toBeUndefined();
    bar.dispose();
  });

  it('disposeすると描き直さなくなる', () => {
    const bar = new UsageStatusBar();
    bar.updateClaude(claudeUsage({ limitLabel: '週次', limited: true, resetsAt: epochIn(2) }));
    bar.dispose();

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(claudeTextOf(bar)).toBe('$(pulse) Claude 週次 到達 ・ 2時間後');
  });
});
