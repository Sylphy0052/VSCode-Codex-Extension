import { describe, expect, it } from 'vitest';
import { applyEvent, initialChatState, type ChatState } from '../../src/appserver/chatState';
import { stoppedByUsageLimit } from '../../src/view/chatView';

/**
 * 上限で失敗したターンの扱い（issue #1199）。
 *
 * Codex CLI 0.154.0の`ServerNotification`に`turn/failed`は無く、失敗は`turn/completed`が
 * `turn.status`で運ぶ。statusを読まないと上限で落ちたターンが成功として扱われ、自動再開の
 * 対象から外れる。
 */

/** `turn/completed` のparamsを組み立てる。 */
function completed(status: string, codexErrorInfo?: unknown): Record<string, unknown> {
  return {
    threadId: 'th-1',
    turn: {
      id: 't-1',
      status,
      error: codexErrorInfo === undefined ? null : { message: '上限に達しました', codexErrorInfo },
    },
  };
}

const afterStart = (): ChatState =>
  applyEvent(initialChatState, 'turn/started', { threadId: 'th-1', turn: { id: 't-1' } });

describe('applyEvent: turn/completed の status から失敗を決める', () => {
  it('status:"failed" を失敗として扱う', () => {
    const state = applyEvent(afterStart(), 'turn/completed', completed('failed', 'other'));

    expect(state.turnFailed).toBe(true);
    expect(state.busy).toBe(false);
  });

  it('status:"completed" は失敗にしない（対照）', () => {
    const state = applyEvent(afterStart(), 'turn/completed', completed('completed'));

    expect(state.turnFailed).toBe(false);
    expect(state.turnFailureKind).toBeUndefined();
  });

  it('status:"interrupted"（手動中断）は失敗にしない', () => {
    const state = applyEvent(afterStart(), 'turn/completed', completed('interrupted'));

    expect(state.turnFailed).toBe(false);
    expect(state.turnFailureKind).toBeUndefined();
  });

  it('turnを持たない完了通知でも落ちず、失敗にもしない', () => {
    const state = applyEvent(afterStart(), 'turn/completed', {});

    expect(state.turnFailed).toBe(false);
    expect(state.turnFailureKind).toBeUndefined();
  });

  it('待てば解ける上限は usageLimit として区別する', () => {
    for (const info of ['usageLimitExceeded', 'rateLimitExceeded']) {
      const state = applyEvent(afterStart(), 'turn/completed', completed('failed', info));

      expect(state.turnFailureKind).toBe('usageLimit');
    }
  });

  it('時間では戻らない失敗は other にする', () => {
    for (const info of [
      'sessionBudgetExceeded',
      'contextWindowExceeded',
      'unauthorized',
      { httpConnectionFailed: { httpStatusCode: 500 } },
    ]) {
      const state = applyEvent(afterStart(), 'turn/completed', completed('failed', info));

      expect(state.turnFailureKind).toBe('other');
    }
  });

  it('errorが届かない失敗では理由を決め打ちしない', () => {
    const state = applyEvent(afterStart(), 'turn/completed', {
      threadId: 'th-1',
      turn: { id: 't-1', status: 'failed', error: null },
    });

    expect(state.turnFailed).toBe(true);
    expect(state.turnFailureKind).toBeUndefined();
  });

  it('次のターンが始まれば失敗と理由を消す', () => {
    const failed = applyEvent(
      afterStart(),
      'turn/completed',
      completed('failed', 'usageLimitExceeded'),
    );
    const next = applyEvent(failed, 'turn/started', { threadId: 'th-1', turn: { id: 't-2' } });

    expect(next.turnFailed).toBe(false);
    expect(next.turnFailureKind).toBeUndefined();
  });

  it('古いCLI向けの turn/failed は従来どおり失敗にし、理由は持たない', () => {
    const state = applyEvent(afterStart(), 'turn/failed', {});

    expect(state.turnFailed).toBe(true);
    expect(state.turnFailureKind).toBeUndefined();
  });
});

const withUsage = (state: ChatState, limited: boolean): ChatState => ({
  ...state,
  usage: { ...(state.usage ?? {}), limited } as ChatState['usage'],
});

describe('stoppedByUsageLimit: 自動再開の対象を上限で止まった会話に絞る', () => {
  it('失敗していないターンは対象外（上限の通知が出ていても）', () => {
    const state = withUsage(
      applyEvent(afterStart(), 'turn/completed', completed('completed')),
      true,
    );

    expect(stoppedByUsageLimit(state)).toBe(false);
  });

  it('上限で失敗していれば、レート制限の通知が未着でも対象にする', () => {
    const state = applyEvent(
      afterStart(),
      'turn/completed',
      completed('failed', 'usageLimitExceeded'),
    );

    expect(state.usage).toBeUndefined();
    expect(stoppedByUsageLimit(state)).toBe(true);
  });

  it('上限以外の失敗は、上限の通知が出ていても対象にしない', () => {
    const state = withUsage(
      applyEvent(afterStart(), 'turn/completed', completed('failed', 'contextWindowExceeded')),
      true,
    );

    expect(stoppedByUsageLimit(state)).toBe(false);
  });

  it('理由が届かない失敗は、従来どおりレート制限の通知で判断する', () => {
    const failed = applyEvent(afterStart(), 'turn/failed', {});

    expect(stoppedByUsageLimit(withUsage(failed, true))).toBe(true);
    expect(stoppedByUsageLimit(withUsage(failed, false))).toBe(false);
    expect(stoppedByUsageLimit(failed)).toBe(false);
  });

  it('理由が判らない失敗（turn.errorを受け取れない確定）は前のターンの区分を持ち越さない', () => {
    // 上限で失敗した直後に、次のターンの`turn/started`を受け取れないまま失敗が確定する
    // 経路（接続断など）。前の`'usageLimit'`が残ると、上限ではない失敗まで再開してしまう
    const limited = applyEvent(
      afterStart(),
      'turn/completed',
      completed('failed', 'usageLimitExceeded'),
    );
    const cleared: ChatState = { ...limited, turnFailureKind: undefined };

    expect(stoppedByUsageLimit(cleared)).toBe(false);
  });
});
