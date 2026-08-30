import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';
import type { SessionKanbanBoard } from '../../src/view/sessionKanbanModel';
import { SessionKanbanViewManager } from '../../src/view/sessionKanbanView';
import { __mock, type FakeWebviewPanel } from '../mocks/vscode';

/**
 * セッションカンバンの表示更新（Issue #1012）。
 *
 * `dirty`（非表示中の保留）・まとめ送信のタイマー・webviewからの`ready`・可視性の
 * 変化が独立に動くため、順序の組み合わせで「古い盤面が残る」「最後の1回が届かない」
 * が起きうる。ここではその順序を直接なぞる。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

function board(total: number): SessionKanbanBoard {
  return { cards: { approvalPending: [], running: [], idle: [] }, total };
}

interface Harness {
  view: SessionKanbanViewManager;
  /** `read`が次に返す盤面を差し替える */
  setTotal: (total: number) => void;
  /** webviewへ送られた盤面の`total`の並び */
  sentTotals: () => number[];
  panel: FakeWebviewPanel;
}

function open(): Harness {
  let total = 0;
  const view = new SessionKanbanViewManager(
    () => board(total),
    () => true,
    fakeLogger,
  );
  view.show();
  const panel = __mock.lastCreatedPanel();
  if (panel === undefined) {
    throw new Error('パネルが作られていない');
  }
  return {
    view,
    setTotal: (next: number) => {
      total = next;
    },
    sentTotals: () =>
      panel.webview.sent
        .filter(
          (m: unknown): m is { type: string; board: SessionKanbanBoard } =>
            typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'board',
        )
        .map((m: { board: SessionKanbanBoard }) => m.board.total),
    panel,
  };
}

/** webview側のスクリプトが読み込みを終えた合図 */
function ready(h: Harness): void {
  h.panel.webview.simulateMessage({ type: 'ready' });
}

describe('SessionKanbanViewManager（issue #1012、盤面の送信）', () => {
  beforeEach(() => {
    __mock.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('パネルを作った直後には送らず、webviewのreadyで初回を送る', () => {
    const h = open();
    expect(h.sentTotals()).toEqual([]);
    h.setTotal(3);
    ready(h);
    expect(h.sentTotals()).toEqual([3]);
  });

  it('非表示の間の更新は溜め、表に戻ったときに最新の盤面を1回だけ送る', () => {
    const h = open();
    ready(h);
    h.panel.simulateVisibilityChange(false);
    h.setTotal(1);
    h.view.refresh();
    h.setTotal(2);
    h.view.refresh();
    expect(h.sentTotals()).toEqual([0]);

    h.panel.simulateVisibilityChange(true);
    vi.advanceTimersByTime(1000);
    expect(h.sentTotals()).toEqual([0, 2]);
  });

  it('溜めた更新が無ければ、表に戻っても送らない', () => {
    const h = open();
    ready(h);
    h.panel.simulateVisibilityChange(false);
    h.panel.simulateVisibilityChange(true);
    vi.advanceTimersByTime(1000);
    expect(h.sentTotals()).toEqual([0]);
  });

  it('まとめ待ちの間に非表示へ移っても、表に戻れば最新の盤面が届く', () => {
    const h = open();
    ready(h);
    // 直前の送信からの間隔を空けずに更新して、まとめ待ちのタイマーを作る
    h.setTotal(1);
    h.view.refresh();
    h.panel.simulateVisibilityChange(false);
    h.setTotal(2);
    vi.advanceTimersByTime(1000);
    // 非表示のまま発火した分は届いた保証が無いので、表に戻ってもう一度送る
    h.panel.simulateVisibilityChange(true);
    vi.advanceTimersByTime(1000);
    expect(h.sentTotals().at(-1)).toBe(2);
  });

  it('連続した更新をまとめても、最後の状態は必ず送る', () => {
    const h = open();
    ready(h);
    for (let i = 1; i <= 20; i += 1) {
      h.setTotal(i);
      h.view.refresh();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(1000);
    const sent = h.sentTotals();
    expect(sent.at(-1)).toBe(20);
    // 毎回送っていれば21件になる。まとめが効いていることを見る
    expect(sent.length).toBeLessThan(21);
  });

  it('送るのは送信時点の盤面で、まとめ待ちの間に進んだ状態を巻き戻さない', () => {
    const h = open();
    ready(h);
    h.setTotal(1);
    h.view.refresh();
    // タイマーが発火する前に状態がさらに進む
    h.setTotal(9);
    vi.advanceTimersByTime(1000);
    expect(h.sentTotals().at(-1)).toBe(9);
  });

  it('パネルを閉じたあとはタイマーが発火しても送らない', () => {
    const h = open();
    ready(h);
    h.setTotal(1);
    h.view.refresh();
    h.view.dispose();
    const before = h.sentTotals().length;
    vi.advanceTimersByTime(1000);
    expect(h.sentTotals().length).toBe(before);
  });

  it('パネルが無い間のrefreshは何もしない', () => {
    const view = new SessionKanbanViewManager(
      () => board(0),
      () => true,
      fakeLogger,
    );
    expect(() => {
      view.refresh();
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
    expect(__mock.createdPanels).toEqual([]);
  });

  it('開いているパネルをもう一度showすると、表に出して最新の盤面を送る', () => {
    const h = open();
    ready(h);
    h.setTotal(5);
    h.view.show();
    vi.advanceTimersByTime(1000);
    expect(h.panel.revealCount).toBe(1);
    expect(h.sentTotals().at(-1)).toBe(5);
  });
});
