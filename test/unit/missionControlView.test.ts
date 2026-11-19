import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { readMissionControlStallMs } from '../../src/view/missionControlLauncher';
import { MissionControlViewManager } from '../../src/view/missionControlView';
import type { McSnapshot } from '../../src/webview/missionControl/protocol';
import { __mock, env, Uri, type FakeWebviewPanel } from '../mocks/vscode';

const log: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

function snapshot(pendingCount: number): McSnapshot {
  return {
    now: 0,
    windowId: 'w1',
    repos: [],
    sessions: [],
    stallMs: 300_000,
    pending: Array.from({ length: pendingCount }, (_, i) => ({
      id: `p${String(i)}`,
      kind: 'toolApproval' as const,
      windowId: 'w1',
      threadId: 't',
      provider: 'codex' as const,
      isCurrentWindow: true,
      repoKey: 'r',
      title: 'x',
      summary: '',
      createdAt: 0,
      answer: 'decision' as const,
    })),
  };
}

function open(read: () => McSnapshot, control = vi.fn()) {
  const view = new MissionControlViewManager(read, control, Uri.file('/ext') as never, log);
  view.show();
  const panel = __mock.lastCreatedPanel() as FakeWebviewPanel;
  return { view, panel, control };
}

describe('MissionControlViewManager（Issue #2136）', () => {
  it('copyRef: 確かめた宛先からセッションidを組み立ててコピーし、形の合わない宛先は断る（Issue #2138）', async () => {
    const { panel } = open(() => snapshot(0));
    env.clipboard.written.length = 0;
    panel.webview.simulateMessage({
      type: 'copyRef',
      seq: 3,
      windowId: 'w2',
      provider: 'claude',
      threadId: 't9',
    });
    await vi.waitFor(() =>
      expect(panel.webview.sent.at(-1)).toMatchObject({ type: 'reply', seq: 3, ok: true }),
    );
    expect(env.clipboard.written).toEqual(['session:claude:w2:t9']);
    panel.webview.simulateMessage({
      type: 'copyRef',
      seq: 4,
      windowId: 'w2',
      provider: 'x',
      threadId: 't9',
    });
    expect(panel.webview.sent.at(-1)).toMatchObject({ type: 'reply', seq: 4, ok: false });
    expect(env.clipboard.written).toHaveLength(1);
  });

  it('タブ名に件数を出し、CSPはdefault-src noneとnonce付きの1ファイルだけ', () => {
    const { panel } = open(() => snapshot(2));
    expect(panel.viewType).toBe('agent.missionControl');
    expect(panel.title).toBe('MC (2)');
    const html = panel.webview.html;
    expect(html).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([^']+)'/u.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${String(nonce)}" src="/ext/dist/missionControl.js">`);
    expect(html.match(/<script/gu)).toHaveLength(1);
  });

  it('readyに一覧を返し、件数の変化をタブ名へ反映する', () => {
    let count = 1;
    const { view, panel } = open(() => snapshot(count));
    panel.webview.simulateMessage({ type: 'ready' });
    expect(panel.webview.sent.at(-1)).toMatchObject({ type: 'snapshot' });
    count = 4;
    vi.useFakeTimers();
    view.refresh();
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    expect(panel.title).toBe('MC (4)');
  });

  it('操作は形を確かめてから渡し、結果を同じseqで返す', async () => {
    const control = vi.fn(() => Promise.resolve({ ok: true }));
    const { panel } = open(() => snapshot(0), control);
    panel.webview.simulateMessage({
      type: 'control',
      seq: 7,
      windowId: 'w2',
      provider: 'claude',
      threadId: 't',
      action: 'approvalDecision',
      approvalRequestId: '1',
      decision: 'accept',
    });
    // 知らない決定は渡さない
    panel.webview.simulateMessage({
      type: 'control',
      seq: 8,
      windowId: 'w2',
      provider: 'claude',
      threadId: 't',
      action: 'approvalDecision',
      approvalRequestId: '1',
      decision: 'acceptForSession',
    });
    await vi.waitFor(() =>
      expect(panel.webview.sent).toContainEqual(
        expect.objectContaining({ type: 'controlResult', seq: 7, ok: true }),
      ),
    );
    expect(control).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledWith(
      { windowId: 'w2', provider: 'claude', threadId: 't' },
      { kind: 'approvalDecision', approvalRequestId: '1', decision: 'accept' },
    );
  });

  describe('ライブtail（Issue #2137の3）', () => {
    const okTurns = () => Promise.resolve({ ok: true, turns: [] });
    const liveCount = (panel: FakeWebviewPanel) =>
      panel.webview.sent.filter((m) => (m as { type?: string }).type === 'liveTurns').length;

    it('他ウィンドウのセッションは選択中・表示中だけ取り直し、隠す・外す・閉じると止まる', async () => {
      vi.useFakeTimers();
      try {
        const control = vi.fn(okTurns);
        const { view, panel } = open(() => snapshot(0), control);
        panel.webview.simulateMessage({ type: 'ready' });
        panel.webview.simulateMessage({
          type: 'watch',
          target: { windowId: 'w2', provider: 'codex', threadId: 't' },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(control).toHaveBeenCalledTimes(1);
        expect(control).toHaveBeenLastCalledWith(
          { windowId: 'w2', provider: 'codex', threadId: 't' },
          { kind: 'recentTurns', limit: 6 },
        );
        await vi.advanceTimersByTimeAsync(4_000);
        expect(control).toHaveBeenCalledTimes(3);
        expect(liveCount(panel)).toBe(3);

        // 背面へ回ると止まり、表へ戻ると再開する
        panel.simulateVisibilityChange(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(control).toHaveBeenCalledTimes(3);
        panel.simulateVisibilityChange(true);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(control).toHaveBeenCalledTimes(5);

        // 選択を外すと止まる
        panel.webview.simulateMessage({ type: 'watch', target: undefined });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(control).toHaveBeenCalledTimes(5);

        // 閉じると止まり、タイマーも残らない
        panel.webview.simulateMessage({
          type: 'watch',
          target: { windowId: 'w2', provider: 'codex', threadId: 't' },
        });
        await vi.advanceTimersByTimeAsync(0);
        const before = control.mock.calls.length;
        view.dispose();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(control).toHaveBeenCalledTimes(before);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('自ウィンドウのセッションは間隔で取り直さず、状態の変化ごとに送る', async () => {
      vi.useFakeTimers();
      try {
        const control = vi.fn(okTurns);
        const { view, panel } = open(() => snapshot(0), control);
        panel.webview.simulateMessage({ type: 'ready' });
        panel.webview.simulateMessage({
          type: 'watch',
          target: { windowId: 'w1', provider: 'codex', threadId: 't' },
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(control).toHaveBeenCalledTimes(1);
        view.refresh();
        await vi.advanceTimersByTimeAsync(300);
        expect(control).toHaveBeenCalledTimes(2);
        view.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('webviewからの起動の要求は形を確かめ、不正ならlauncherへ渡さずに理由を返す', async () => {
    const launch = vi.fn();
    const launcher = { options: vi.fn(), pickFolder: vi.fn(), launch };
    const view = new MissionControlViewManager(
      () => snapshot(0),
      vi.fn(),
      Uri.file('/ext') as never,
      log,
      launcher,
    );
    view.show();
    const panel = __mock.lastCreatedPanel() as FakeWebviewPanel;
    for (const [seq, bad] of [
      [1, { cwd: 'relative/dir', provider: 'codex', prompt: '', worktree: false }],
      [2, { cwd: '/a\nb', provider: 'codex', prompt: '', worktree: false }],
      [3, { cwd: '/repo', provider: 'gpt', prompt: '', worktree: false }],
      [4, { cwd: '/repo', provider: 'codex', prompt: 1, worktree: false }],
      [5, { cwd: '/repo', provider: 'codex', prompt: '', worktree: 'yes' }],
    ] as const) {
      panel.webview.simulateMessage({ type: 'launch', seq, ...bad });
    }
    await vi.waitFor(() =>
      expect(
        panel.webview.sent.filter((m) => (m as { type?: string }).type === 'reply'),
      ).toHaveLength(5),
    );
    expect(launch).not.toHaveBeenCalled();
    for (const m of panel.webview.sent.filter((x) => (x as { type?: string }).type === 'reply')) {
      expect(m).toMatchObject({ ok: false });
    }
    view.dispose();
  });

  it('停滞の設定は既定5分で、範囲外・数値でない値は既定へ丸める（Issue #2137の5）', () => {
    const cases: Array<[unknown, number]> = [
      [undefined, 300_000],
      [10, 600_000],
      [1, 60_000],
      [1440, 86_400_000],
      [0, 300_000],
      [1441, 300_000],
      ['10', 300_000],
      [Number.NaN, 300_000],
    ];
    try {
      for (const [value, expected] of cases) {
        __mock.setConfig(
          'agent',
          value === undefined ? {} : { missionControl: { stallMinutes: value } },
        );
        expect(readMissionControlStallMs()).toBe(expected);
      }
    } finally {
      __mock.setConfig('agent', {});
    }
  });

  it('Reload後の復元でパネルを引き取り、2枚目は持たない', () => {
    const { view, panel } = open(() => snapshot(0));
    const restored = { ...panel, disposed: false };
    const dispose = vi.fn();
    view.restore({ ...restored, dispose } as never);
    expect(dispose).toHaveBeenCalled();
    view.dispose();
    const fresh = new MissionControlViewManager(
      () => snapshot(1),
      vi.fn(),
      Uri.file('/ext') as never,
      log,
    );
    const panel2 = __mock.lastCreatedPanel() as FakeWebviewPanel;
    fresh.restore(panel2 as never);
    expect(panel2.webview.html).toContain('missionControl.js');
  });
});
