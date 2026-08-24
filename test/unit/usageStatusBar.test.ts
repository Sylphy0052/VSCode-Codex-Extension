import { beforeEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../src/codex/usage';
import { UsageStatusBar } from '../../src/view/usageStatusBar';
import { __mock } from '../mocks/vscode';

/** 実装が持つ `vscode.StatusBarItem`（モックは `FakeStatusBarItem`）を覗く。 */
function textOf(bar: InstanceType<typeof UsageStatusBar>): string {
  return (bar as unknown as { item: { text: string } })['item'].text;
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

  it('未取得のときの表示は変わらない', () => {
    const bar = new UsageStatusBar();
    bar.update(undefined);
    expect(textOf(bar)).toBe('$(pulse) Codex --');
    bar.update(snapshot(undefined));
    expect(textOf(bar)).toBe('$(pulse) Codex --');
  });
});
