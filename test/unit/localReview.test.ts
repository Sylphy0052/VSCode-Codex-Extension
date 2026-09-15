import { describe, expect, it } from 'vitest';
import {
  isChangedLineSelection,
  noReviewCandidateMessage,
  reviewCandidates,
  reviewDeliveryFailureMessage,
  reviewMessages,
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
