import { describe, expect, it } from 'vitest';

import { type EvidenceCandidates } from '../bench/secondOpinionEval/evidenceChannels';
import {
  hasStrongEvidence,
  screeningOrderOf,
  shuffleKeyOf,
} from '../bench/secondOpinionEval/screeningPool';

function candidate(overrides: Partial<EvidenceCandidates> = {}): EvidenceCandidates {
  return {
    prNumber: 1,
    followUpPrs: [],
    followUpIssues: [],
    closingIssues: [],
    accountCommentCount: 0,
    modelCommentCount: 0,
    accountReviewCount: 0,
    modelReviewCount: 0,
    channels: [],
    ...overrides,
  };
}

function followUpIssue(openedAfterMerge: boolean): EvidenceCandidates['followUpIssues'][number] {
  return {
    number: 500,
    title: 'バグ報告',
    createdAt: '2026-08-21T00:00:00Z',
    sourceCreatedAt: openedAfterMerge ? '2026-08-21T00:00:00Z' : '2026-08-01T00:00:00Z',
    openedAfterMerge,
    authorKind: 'account',
  };
}

describe('hasStrongEvidence', () => {
  it('後続fixがテストを触っていれば強い候補', () => {
    expect(hasStrongEvidence(candidate({ channels: ['follow-up-fix', 'follow-up-test'] }))).toBe(
      true,
    );
  });

  it('マージ後に立ったIssueを持てば強い候補', () => {
    expect(
      hasStrongEvidence(
        candidate({ channels: ['follow-up-issue'], followUpIssues: [followUpIssue(true)] }),
      ),
    ).toBe(true);
  });

  it('前からあるIssueが後で言及されただけでは強い候補にしない', () => {
    expect(
      hasStrongEvidence(
        candidate({ channels: ['follow-up-issue'], followUpIssues: [followUpIssue(false)] }),
      ),
    ).toBe(false);
  });

  it('closing Issue やコメントだけでは強い候補にしない', () => {
    expect(hasStrongEvidence(candidate({ channels: ['closing-issue', 'account-comment'] }))).toBe(
      false,
    );
  });
});

describe('screeningOrderOf', () => {
  const candidates = [1, 2, 3, 4, 5].map((prNumber) =>
    candidate({ prNumber, channels: ['follow-up-test'] }),
  );

  it('同じ入力からは常に同じ順を返す', () => {
    const first = screeningOrderOf(candidates).map((entry) => entry.prNumber);
    const second = screeningOrderOf([...candidates].reverse()).map((entry) => entry.prNumber);

    expect(second).toEqual(first);
  });

  it('PR番号の昇順にはしない（時間順で読むと時期が偏る）', () => {
    const order = screeningOrderOf(candidates).map((entry) => entry.prNumber);

    expect(order).toHaveLength(5);
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(order).not.toEqual([1, 2, 3, 4, 5]);
  });

  it('seedを変えると別の順になる', () => {
    const a = screeningOrderOf(candidates, 'seed-a:').map((entry) => entry.prNumber);
    const b = screeningOrderOf(candidates, 'seed-b:').map((entry) => entry.prNumber);

    expect(b).not.toEqual(a);
  });

  it('強い証拠を持たない案件を順序へ入れない', () => {
    const order = screeningOrderOf([
      ...candidates,
      candidate({ prNumber: 6, channels: ['closing-issue'] }),
    ]);

    expect(order.map((entry) => entry.prNumber)).not.toContain(6);
  });
});

describe('shuffleKeyOf', () => {
  it('PR番号だけで決まる', () => {
    expect(shuffleKeyOf(42)).toBe(shuffleKeyOf(42));
    expect(shuffleKeyOf(42)).not.toBe(shuffleKeyOf(43));
  });
});
