import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import { MissionControlViewManager } from '../../src/view/missionControlView';
import type { McSnapshot } from '../../src/webview/missionControl/protocol';
import { __mock, Uri, type FakeWebviewPanel } from '../mocks/vscode';

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
