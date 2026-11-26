import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McPendingItem, McSnapshot } from '../../src/webview/missionControl/protocol';
import {
  McNotifier,
  NOTIFY_BATCH_MS,
  notificationMessage,
  type McNotification,
} from '../../src/view/missionControlNotifier';

function item(id: string, over: Partial<McPendingItem> = {}): McPendingItem {
  return {
    id,
    kind: 'workflowApproval',
    windowId: 'w',
    threadId: id,
    provider: 'codex',
    isCurrentWindow: false,
    repoKey: 'r',
    title: `title-${id}`,
    summary: '',
    createdAt: 0,
    answer: 'decision',
    ...over,
  };
}

function snap(...pending: McPendingItem[]): McSnapshot {
  return { pending } as unknown as McSnapshot;
}

function setup(enabled = true) {
  const shown: McNotification[] = [];
  const state = { enabled };
  const notifier = new McNotifier({
    enabled: () => state.enabled,
    show: (n) => shown.push(n),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { notifier, shown, state };
}

describe('notificationMessage', () => {
  it('1件でタイトルがあればタイトルを出す', () => {
    expect(notificationMessage({ count: 1, title: 'A' })).toBe(
      'Mission Control: 「A」が待っています',
    );
  });
  it('複数、またはタイトル無しは件数', () => {
    expect(notificationMessage({ count: 3, title: undefined })).toBe('Mission Control: 3件待ち');
    expect(notificationMessage({ count: 1, title: undefined })).toBe('Mission Control: 1件待ち');
  });
});

describe('McNotifier（Issue #2138）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('最初のobserveは既存分を既読にするだけで通知しない', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS * 2);
    expect(shown).toEqual([]);
  });

  it('増えた1件は窓の後にタイトル付きで通知する', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([{ count: 1, title: 'title-a' }]);
  });

  it('窓の間に増えた分を1件の「N件待ち」にまとめる（窓は最初の1件から数える）', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(2000);
    notifier.observe(snap(item('a'), item('b')), false);
    vi.advanceTimersByTime(1000);
    expect(shown).toEqual([{ count: 2, title: undefined }]);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS * 3);
    expect(shown).toHaveLength(1);
  });

  it('同じ項目を再通知しない', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toHaveLength(1);
  });

  it('一覧から消えた項目は再び現れたら新規として数える', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toHaveLength(2);
  });

  it('このウィンドウの承認・質問・codexPromptは数えない', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(
      snap(
        item('a', { isCurrentWindow: true, kind: 'toolApproval' }),
        item('b', { isCurrentWindow: true, kind: 'askUserQuestion' }),
        item('c', { isCurrentWindow: true, kind: 'codexPrompt' }),
      ),
      false,
    );
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([]);
  });

  it('このウィンドウでも会話の通知を持たない種類は数える。他ウィンドウの承認も数える', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(
      snap(
        item('a', { isCurrentWindow: true, kind: 'taskRunQuestion' }),
        item('b', { isCurrentWindow: true, kind: 'handoff' }),
        item('c', { isCurrentWindow: false, kind: 'toolApproval' }),
      ),
      false,
    );
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([{ count: 3, title: undefined }]);
  });

  it('前面にある間は通知せず、溜めていた分とタイマーも捨てる', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    notifier.observe(snap(item('a')), true);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS * 2);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('前面中に増えた分は、後で背面に戻っても通知しない（既読になる）', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), true);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([]);
  });

  it('窓の間に答え終わって消えた項目は件数から外す', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a'), item('b')), false);
    notifier.observe(snap(item('b')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([{ count: 1, title: 'title-b' }]);
  });

  it('全部消えたら通知しない', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    notifier.observe(snap(), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([]);
  });

  it('設定が無効なら通知しない（発火時に判定する）', () => {
    const { notifier, shown, state } = setup(true);
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    state.enabled = false;
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([]);
  });

  it('通知後に増えた分は次の窓で別の通知になる', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    notifier.observe(snap(item('a'), item('b')), false);
    vi.advanceTimersByTime(NOTIFY_BATCH_MS);
    expect(shown).toEqual([
      { count: 1, title: 'title-a' },
      { count: 1, title: 'title-b' },
    ]);
  });

  it('dispose: 保留中のタイマーを解除し通知しない', () => {
    const { notifier, shown } = setup();
    notifier.observe(snap(), false);
    notifier.observe(snap(item('a')), false);
    notifier.dispose();
    vi.advanceTimersByTime(NOTIFY_BATCH_MS * 2);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
