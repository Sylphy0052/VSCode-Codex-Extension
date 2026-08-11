import { describe, expect, it } from 'vitest';
import {
  buildReviewStartParams,
  buildReviewTarget,
  readReviewThreadId,
} from '../../src/codex/reviewTarget';

describe('buildReviewTarget', () => {
  it('未コミットの変更は入力を無視して固定の形になる', () => {
    expect(buildReviewTarget('uncommittedChanges', '')).toEqual({ type: 'uncommittedChanges' });
    expect(buildReviewTarget('uncommittedChanges', '無視されるはず')).toEqual({
      type: 'uncommittedChanges',
    });
  });

  it('ベースブランチは前後の空白を落とす', () => {
    expect(buildReviewTarget('baseBranch', ' main ')).toEqual({
      type: 'baseBranch',
      branch: 'main',
    });
  });

  it('ベースブランチが空なら組み立てない', () => {
    expect(buildReviewTarget('baseBranch', '')).toBeUndefined();
    expect(buildReviewTarget('baseBranch', '   ')).toBeUndefined();
  });

  it('コミットはSHAをそのまま持つ', () => {
    expect(buildReviewTarget('commit', 'abc1234')).toEqual({ type: 'commit', sha: 'abc1234' });
  });

  it('コミットのSHAが空なら組み立てない', () => {
    expect(buildReviewTarget('commit', '')).toBeUndefined();
  });

  it('自由記述は指示文をそのまま持つ', () => {
    expect(buildReviewTarget('custom', 'エラーハンドリングだけ見て')).toEqual({
      type: 'custom',
      instructions: 'エラーハンドリングだけ見て',
    });
  });

  it('自由記述が空なら組み立てない', () => {
    expect(buildReviewTarget('custom', '')).toBeUndefined();
    expect(buildReviewTarget('custom', '\n\t')).toBeUndefined();
  });
});

describe('buildReviewStartParams', () => {
  it('inlineのときはdeliveryを載せない', () => {
    expect(buildReviewStartParams('th-1', { type: 'uncommittedChanges' }, 'inline')).toEqual({
      threadId: 'th-1',
      target: { type: 'uncommittedChanges' },
    });
  });

  it('detachedのときはdeliveryを載せる', () => {
    expect(
      buildReviewStartParams('th-1', { type: 'baseBranch', branch: 'main' }, 'detached'),
    ).toEqual({
      threadId: 'th-1',
      target: { type: 'baseBranch', branch: 'main' },
      delivery: 'detached',
    });
  });
});

describe('readReviewThreadId', () => {
  it('reviewThreadIdを読む', () => {
    expect(readReviewThreadId({ reviewThreadId: 'th-2', turn: {} })).toBe('th-2');
  });

  it('無い・壊れている場合はundefined', () => {
    expect(readReviewThreadId({})).toBeUndefined();
    expect(readReviewThreadId({ reviewThreadId: '' })).toBeUndefined();
    expect(readReviewThreadId({ reviewThreadId: 123 })).toBeUndefined();
    expect(readReviewThreadId(undefined)).toBeUndefined();
    expect(readReviewThreadId(null)).toBeUndefined();
  });
});
