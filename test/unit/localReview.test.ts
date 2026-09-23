import { describe, expect, it } from 'vitest';
import {
  isChangedLineSelection,
  noReviewCandidateMessage,
  PendingReviewFeedback,
  REVIEW_DISCARD_ACTION,
  REVIEW_QUEUED_MESSAGE,
  REVIEW_RETRY_ACTION,
  reviewCandidates,
  reviewDeliveryFailureMessage,
  reviewFailureOf,
  reviewMessages,
  reviewRetryPrompt,
  type LocalReviewSession,
} from '../../src/view/localReview';

const source = { provider: 'codex' as const, threadId: 'source', cwd: '/workspace/repo' };

function session(overrides: Partial<LocalReviewSession> = {}): LocalReviewSession {
  return {
    provider: 'claude',
    threadId: 'target',
    title: '対象会話',
    cwd: '/workspace/repo',
    activity: 'running',
    ...overrides,
  };
}

describe('ローカルレビューの送信境界（Issue#1234）', () => {
  it('変更行だけを選択範囲として許可する', () => {
    const ranges = [{ start: 3, end: 5 }];
    expect(isChangedLineSelection(3, 5, ranges)).toBe(true);
    expect(isChangedLineSelection(2, 5, ranges)).toBe(false);
    expect(isChangedLineSelection(3, 6, ranges)).toBe(false);
  });

  it('同じworkspace・worktreeで実行中の別会話だけを送信先にする', () => {
    const candidates = reviewCandidates(
      [
        session(),
        session({ threadId: 'source', provider: 'codex' }),
        session({ threadId: 'idle', activity: 'idle' }),
        session({ threadId: 'other-worktree', cwd: '/workspace/repo-other' }),
        session({ threadId: 'outside', cwd: '/outside' }),
      ],
      source,
      ['/workspace'],
      '/workspace/repo/src/file.ts',
    );

    expect(candidates.map((candidate) => candidate.threadId)).toEqual(['target']);
  });

  it('worktree不一致を候補なしの理由として区別する', () => {
    expect(
      noReviewCandidateMessage([session({ cwd: '/workspace/another-worktree' })], source, [
        '/workspace',
      ]),
    ).toContain('worktreeが一致しません');
  });

  it('確認画面と送信本文へ同じ対象・範囲・指摘・引用を載せる', () => {
    const messages = reviewMessages({
      provider: 'claude',
      file: 'src/file.ts',
      startLine: 4,
      endLine: 6,
      comment: 'nullを確認してください',
      selected: 'const value = input.value;',
    });

    for (const value of [
      'src/file.ts',
      '4-6',
      'nullを確認してください',
      'const value = input.value;',
    ]) {
      expect(messages.payload).toContain(value);
      expect(messages.confirmation).toContain(value);
    }
  });

  it('会話終了とprovider送信失敗を別の復旧案として表示する', () => {
    expect(reviewDeliveryFailureMessage('sessionUnavailable')).toContain('会話は終了');
    expect(reviewDeliveryFailureMessage('deliveryFailed')).toContain('providerへの送信に失敗');
  });
});

describe('送れなかった指摘の保持と送り直し（Issue #1376）', () => {
  it('送信済みとキュー待ちは失敗として扱わず、それ以外は理由を返す', () => {
    expect(reviewFailureOf('sent')).toBeUndefined();
    expect(reviewFailureOf('queued')).toBeUndefined();
    expect(reviewFailureOf('sessionUnavailable')).toBe('sessionUnavailable');
    expect(reviewFailureOf('deliveryFailed')).toBe('deliveryFailed');
  });

  it('キュー待ちの文言は送信済みと区別する', () => {
    expect(REVIEW_QUEUED_MESSAGE).toContain('待ち行列');
  });

  it('送り直しの案内は失敗の理由ごとに原因を示し、指摘を保持していると伝える', () => {
    expect(reviewRetryPrompt('stale')).toContain('状態が変わりました');
    expect(reviewRetryPrompt('sessionUnavailable')).toContain('会話は終了');
    expect(reviewRetryPrompt('deliveryFailed')).toContain('providerへの送信に失敗');
    for (const reason of ['stale', 'sessionUnavailable', 'deliveryFailed'] as const) {
      expect(reviewRetryPrompt(reason)).toContain('指摘は保持しています');
      expect(reviewRetryPrompt(reason)).toContain(REVIEW_RETRY_ACTION);
    }
  });

  it('送り直しを選ぶと保持したまま再試行し、送れたら手放す', () => {
    const pending = new PendingReviewFeedback<object>();
    const feedback = {};
    pending.hold(feedback);
    expect(pending.decide(feedback, REVIEW_RETRY_ACTION)).toBe('retry');
    expect(pending.held).toBe(feedback);
    pending.release(feedback);
    expect(pending.held).toBeUndefined();
  });

  it('破棄を選ぶか通知を閉じると保持を解く', () => {
    const pending = new PendingReviewFeedback<object>();
    for (const choice of [REVIEW_DISCARD_ACTION, undefined]) {
      const feedback = {};
      pending.hold(feedback);
      expect(pending.decide(feedback, choice)).toBe('discard');
      expect(pending.held).toBeUndefined();
    }
  });

  it('保持は1件だけで、新しい指摘を保持すると古い指摘は送り直せない', () => {
    const pending = new PendingReviewFeedback<object>();
    const older = {};
    const newer = {};
    pending.hold(older);
    pending.hold(newer);
    expect(pending.decide(older, REVIEW_RETRY_ACTION)).toBe('superseded');
    pending.release(older);
    expect(pending.held).toBe(newer);
    expect(pending.decide(newer, REVIEW_RETRY_ACTION)).toBe('retry');
  });
});
