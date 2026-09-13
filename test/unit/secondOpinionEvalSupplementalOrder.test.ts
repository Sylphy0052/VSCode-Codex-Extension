import { describe, expect, it } from 'vitest';

import { type EvidenceCandidates } from '../bench/secondOpinionEval/evidenceChannels';
import {
  isSupplementalCandidate,
  screeningOrderOf,
  supplementalOrderOf,
  verifyDisjoint,
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

describe('isSupplementalCandidate', () => {
  it('強い証拠を持つ案件は追加poolへ入れない（先に読む側と重複するため）', () => {
    expect(
      isSupplementalCandidate(
        candidate({ channels: ['follow-up-fix', 'follow-up-test', 'account-review'] }),
      ),
    ).toBe(false);
    expect(
      isSupplementalCandidate(
        candidate({
          channels: ['follow-up-issue', 'account-review'],
          followUpIssues: [followUpIssue(true)],
        }),
      ),
    ).toBe(false);
  });

  it('追加の系統をどれか1つ持てば入れる', () => {
    for (const channel of ['follow-up-fix', 'account-review', 'account-comment', 'closing-issue']) {
      expect(
        isSupplementalCandidate(
          candidate({ channels: [channel as EvidenceCandidates['channels'][number]] }),
        ),
      ).toBe(true);
    }
  });

  it('追加の系統をどれも持たない案件は入れない', () => {
    expect(
      isSupplementalCandidate(
        candidate({ channels: ['follow-up-issue'], followUpIssues: [followUpIssue(false)] }),
      ),
    ).toBe(false);
    expect(isSupplementalCandidate(candidate({ channels: [] }))).toBe(false);
  });
});

describe('supplementalOrderOf', () => {
  const candidates = [
    candidate({ prNumber: 11, channels: ['account-review'] }),
    candidate({ prNumber: 22, channels: ['closing-issue'] }),
    candidate({ prNumber: 33, channels: ['follow-up-fix', 'follow-up-test'] }),
    candidate({ prNumber: 44, channels: ['account-comment'] }),
    candidate({ prNumber: 55, channels: [] }),
  ];

  it('同じ入力からは何度実行しても同じ順を返す', () => {
    expect(supplementalOrderOf(candidates)).toEqual(supplementalOrderOf(candidates));
  });

  it('入力の並び順を変えても同じ順になる', () => {
    expect(supplementalOrderOf([...candidates].reverse())).toEqual(supplementalOrderOf(candidates));
  });

  it('seedを変えれば鍵が変わる', () => {
    const a = supplementalOrderOf(candidates, 'seed-a:');
    const b = supplementalOrderOf(candidates, 'seed-b:');
    expect(a.map((entry) => entry.shuffleKey)).not.toEqual(b.map((entry) => entry.shuffleKey));
  });

  it('強い証拠を持つ案件と系統の無い案件を落とす', () => {
    expect(
      supplementalOrderOf(candidates)
        .map((entry) => entry.prNumber)
        .sort(),
    ).toEqual([11, 22, 44]);
  });

  it('強い証拠のpoolと1件も重ならない', () => {
    const supplemental = supplementalOrderOf(candidates);
    const strong = screeningOrderOf(candidates);
    expect(() => {
      verifyDisjoint(supplemental, strong);
    }).not.toThrow();
    expect(strong.map((entry) => entry.prNumber)).toEqual([33]);
  });
});

describe('verifyDisjoint', () => {
  it('重なりがあれば止める（同じ案件が2つの分母へ二重に入るため）', () => {
    expect(() => {
      verifyDisjoint([{ prNumber: 7 }, { prNumber: 8 }], [{ prNumber: 8 }]);
    }).toThrow(/#8/);
  });

  it('重なりが無ければ通す', () => {
    expect(() => {
      verifyDisjoint([{ prNumber: 7 }], [{ prNumber: 8 }]);
    }).not.toThrow();
  });
});
