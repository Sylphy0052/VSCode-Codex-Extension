import { describe, expect, it } from 'vitest';
import {
  cardStatus,
  cardStatusLabel,
  DEFAULT_REPLY_WAIT_MS,
  isReplyWaiting,
  isUnreadReply,
} from '../../src/webview/missionControl/logic';
import type { McSession } from '../../src/webview/missionControl/protocol';
import { MARK_READ_RETRY_MS, ReadMarker } from '../../src/view/missionControlSessions';
import { parseAction, toSessionControlAction } from '../../src/view/sessionControlMessage';
import { readMcPrefs } from '../../src/view/missionControlPrefs';

// Issue #2171: 待機中のセッションを「返事待ち」と表示し、長い待ちの強調と未読の印を付ける

const MIN = 60_000;

function session(overrides: Partial<McSession> = {}): McSession {
  return {
    key: 'session:claude:w1:t1',
    windowId: 'w1',
    threadId: 't1',
    provider: 'claude',
    isCurrentWindow: true,
    repoKey: '/repo',
    title: 't',
    activity: 'idle',
    activitySince: 0,
    cwdLabel: 'repo',
    cwdFull: '/repo',
    pendingCount: 0,
    ...overrides,
  };
}

describe('返事待ちの判定', () => {
  it('通常チャットのidleは返事待ち、taskManaged・handoffKeptのidleは返事待ちでない', () => {
    expect(isReplyWaiting(session())).toBe(true);
    expect(isReplyWaiting(session({ taskManaged: true }))).toBe(false);
    expect(isReplyWaiting(session({ handoffKept: true }))).toBe(false);
    expect(isReplyWaiting(session({ activity: 'running' }))).toBe(false);
    expect(isReplyWaiting(session({ activity: 'approvalPending' }))).toBe(false);
  });

  it('設定の分数を超えると強調（replyWaitLong）になり、分数を変えると反映される', () => {
    const s = session({ activitySince: 0 });
    expect(cardStatus(s, 29 * MIN, 5 * MIN, 30 * MIN)).toBe('replyWait');
    expect(cardStatus(s, 30 * MIN, 5 * MIN, 30 * MIN)).toBe('replyWaitLong');
    expect(cardStatus(s, 10 * MIN, 5 * MIN, 10 * MIN)).toBe('replyWaitLong');
    expect(cardStatus(s, 10 * MIN, 5 * MIN, 60 * MIN)).toBe('replyWait');
  });

  it('分数を渡さなければ既定の30分で判定する', () => {
    expect(DEFAULT_REPLY_WAIT_MS).toBe(30 * MIN);
    expect(cardStatus(session(), 31 * MIN, 5 * MIN)).toBe('replyWaitLong');
  });

  it('taskManagedのidleは長く待っても強調せず、待機のまま', () => {
    expect(cardStatus(session({ taskManaged: true }), 999 * MIN, 5 * MIN, MIN)).toBe('idle');
    expect(cardStatus(session({ handoffKept: true }), 999 * MIN, 5 * MIN, MIN)).toBe('idle');
  });

  it('ピルの文言は「返事待ち」', () => {
    expect(cardStatusLabel('replyWait')).toBe('返事待ち');
    expect(cardStatusLabel('replyWaitLong')).toBe('返事待ち');
    expect(cardStatusLabel('idle')).toBe('待機');
    expect(cardStatusLabel('stalled')).toBe('停滞');
  });

  it('未読の印は返事待ちのものだけに出す', () => {
    expect(isUnreadReply(session({ unread: true }))).toBe(true);
    expect(isUnreadReply(session({ unread: false }))).toBe(false);
    expect(isUnreadReply(session({ unread: true, activity: 'running' }))).toBe(false);
    expect(isUnreadReply(session({ unread: true, taskManaged: true }))).toBe(false);
  });
});

describe('ReadMarker（詳細ペインで表示したら既読の要求を送る）', () => {
  const target = { windowId: 'w1', provider: 'claude' as const, threadId: 't1' };

  it('未読のセッションを表示したら1回だけ要求し、間隔を空けたら送り直す', () => {
    let now = 1_000;
    const marker = new ReadMarker(() => now);
    const sessions = [session({ unread: true })];
    expect(marker.take(sessions, target)).toBe(true);
    expect(marker.take(sessions, target)).toBe(false);
    now += MARK_READ_RETRY_MS;
    expect(marker.take(sessions, target)).toBe(true);
  });

  it('未読でない・表示していない・一覧に無いなら送らない', () => {
    const marker = new ReadMarker(() => 0);
    expect(marker.take([session()], target)).toBe(false);
    expect(marker.take([session({ unread: true })], undefined)).toBe(false);
    expect(marker.take(undefined, target)).toBe(false);
    expect(marker.take([session({ unread: true, key: 'other' })], target)).toBe(false);
  });

  it('既読になってから再び未読になったら、すぐに要求する', () => {
    const marker = new ReadMarker(() => 0);
    expect(marker.take([session({ unread: true })], target)).toBe(true);
    expect(marker.take([session()], target)).toBe(false);
    expect(marker.take([session({ unread: true })], target)).toBe(true);
  });
});

describe('markReadの操作', () => {
  it('webviewからも別ウィンドウの要求ファイルからも受け付ける', () => {
    expect(parseAction({ action: 'markRead' })).toEqual({ kind: 'markRead' });
    expect(toSessionControlAction({ kind: 'markRead' })).toEqual({ kind: 'markRead' });
  });
});

describe('設定 agent.missionControl.replyWaitMinutes', () => {
  it('既定は30分、範囲外は既定へ丸める', () => {
    expect(readMcPrefs(() => undefined)['missionControl.replyWaitMinutes']).toBe(30);
    expect(
      readMcPrefs((key) => (key === 'missionControl.replyWaitMinutes' ? 45 : undefined))[
        'missionControl.replyWaitMinutes'
      ],
    ).toBe(45);
    expect(
      readMcPrefs((key) => (key === 'missionControl.replyWaitMinutes' ? 0 : undefined))[
        'missionControl.replyWaitMinutes'
      ],
    ).toBe(30);
  });
});
