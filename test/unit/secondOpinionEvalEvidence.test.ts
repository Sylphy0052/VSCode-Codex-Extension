import { describe, expect, it } from 'vitest';

import {
  authorKindOf,
  changeTypeOf,
  collectCandidates,
  FOLLOW_UP_FILE_PAGE,
  isTestPath,
  summarizeChannels,
  verifySourceCoverage,
  type RawCrossReference,
  type RawPrEvidence,
} from '../bench/secondOpinionEval/evidenceChannels';

const MERGED_AT = '2026-08-20T00:00:00Z';

function rawEvidence(overrides: Partial<RawPrEvidence> = {}): RawPrEvidence {
  return {
    prNumber: 100,
    mergedAt: MERGED_AT,
    comments: [],
    reviews: [],
    closingIssues: [],
    crossReferences: [],
    truncated: [],
    ...overrides,
  };
}

function crossRef(overrides: Partial<RawCrossReference> = {}): RawCrossReference {
  return {
    createdAt: '2026-08-21T00:00:00Z',
    kind: 'PullRequest',
    number: 200,
    title: 'fix: 直す',
    authorLogin: 'Sylphy0052',
    sourceCreatedAt: '2026-08-21T00:00:00Z',
    mergedAt: '2026-08-21T01:00:00Z',
    ...overrides,
  };
}

describe('authorKindOf', () => {
  it('既知のAIレビュアーを model として扱う', () => {
    expect(authorKindOf('chatgpt-codex-connector')).toBe('model');
    expect(authorKindOf('Copilot')).toBe('model');
  });

  it('GitHub App の [bot] を model として扱う', () => {
    expect(authorKindOf('github-actions[bot]')).toBe('model');
  });

  it('それ以外のloginは account であって human ではない', () => {
    // このリポジトリのコメントはAIエージェントがアカウント名で書いていることがある。
    // 「人間が書いた」と決められるのはここではない
    expect(authorKindOf('Sylphy0052')).toBe('account');
  });

  it('削除済みアカウントは unknown', () => {
    expect(authorKindOf(undefined)).toBe('unknown');
  });
});

describe('changeTypeOf', () => {
  it('Conventional Commits の型を読む', () => {
    expect(changeTypeOf('fix: 直す')).toBe('fix');
    expect(changeTypeOf('fix(scope)!: 直す')).toBe('fix');
    expect(changeTypeOf('feat: 足す')).toBe('feat');
  });

  it('GitHubの自動revertタイトルを revert として読む', () => {
    expect(changeTypeOf('Revert "feat: 足す"')).toBe('revert');
  });

  it('型が読めなければ undefined', () => {
    expect(changeTypeOf('なんとなく直した')).toBeUndefined();
  });
});

describe('isTestPath', () => {
  it('テストのパスを見分ける', () => {
    expect(isTestPath('test/unit/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.spec.ts')).toBe(true);
    expect(isTestPath('src/foo.ts')).toBe(false);
    // 名前にtestを含むだけの実装ファイルを拾わない
    expect(isTestPath('src/testHelpers.ts')).toBe(false);
  });
});

describe('collectCandidates', () => {
  it('マージ前からある参照を後続として数えない', () => {
    const candidates = collectCandidates(
      rawEvidence({
        crossReferences: [
          crossRef({ createdAt: '2026-08-19T00:00:00Z', number: 201 }),
          crossRef({ createdAt: '2026-08-21T00:00:00Z', number: 202 }),
        ],
      }),
      new Map(),
    );

    expect(candidates.followUpPrs.map((pr) => pr.number)).toEqual([202]);
  });

  it('後続がfix型でなければ follow-up-fix にしない', () => {
    const candidates = collectCandidates(
      rawEvidence({ crossReferences: [crossRef({ title: 'feat: 別の機能' })] }),
      new Map(),
    );

    expect(candidates.followUpPrs).toHaveLength(1);
    expect(candidates.channels).not.toContain('follow-up-fix');
  });

  it('後続fixがテストを触っていれば follow-up-test が立つ', () => {
    const candidates = collectCandidates(
      rawEvidence({ crossReferences: [crossRef({ number: 200 })] }),
      new Map([[200, ['src/foo.ts', 'test/unit/foo.test.ts']]]),
    );

    expect(candidates.channels).toContain('follow-up-fix');
    expect(candidates.channels).toContain('follow-up-test');
  });

  it('ファイル一覧が無ければ touchesTests は undefined で、テスト有りとは数えない', () => {
    const candidates = collectCandidates(
      rawEvidence({ crossReferences: [crossRef({ number: 200 })] }),
      new Map(),
    );

    expect(candidates.followUpPrs[0]?.touchesTests).toBeUndefined();
    expect(candidates.channels).toContain('follow-up-fix');
    expect(candidates.channels).not.toContain('follow-up-test');
  });

  it('ファイル一覧が上限まで埋まっていれば、テスト無しとは断定しない', () => {
    // 上限で切れた一覧にテストが見えないのは「触っていない」ではなく「見えていない」
    const files = Array.from({ length: FOLLOW_UP_FILE_PAGE }, (_, index) => `src/f${index}.ts`);
    const candidates = collectCandidates(
      rawEvidence({ crossReferences: [crossRef({ number: 200 })] }),
      new Map([[200, files]]),
    );

    expect(candidates.followUpPrs[0]?.touchesTests).toBeUndefined();
    expect(candidates.channels).not.toContain('follow-up-test');
  });

  it('上限に達していなければ、テストが無いことを false として数える', () => {
    const candidates = collectCandidates(
      rawEvidence({ crossReferences: [crossRef({ number: 200 })] }),
      new Map([[200, ['src/foo.ts']]]),
    );

    expect(candidates.followUpPrs[0]?.touchesTests).toBe(false);
  });

  it('Codexのコメントだけでは account-comment が立たない', () => {
    const candidates = collectCandidates(
      rawEvidence({
        comments: [
          {
            authorLogin: 'chatgpt-codex-connector',
            createdAt: '2026-08-20T01:00:00Z',
            body: 'Codex Review Summary',
          },
        ],
      }),
      new Map(),
    );

    expect(candidates.modelCommentCount).toBe(1);
    expect(candidates.accountCommentCount).toBe(0);
    expect(candidates.channels).not.toContain('account-comment');
  });

  it('Codexレビューを数えるが、系統としては立てない', () => {
    const candidates = collectCandidates(
      rawEvidence({
        reviews: [{ authorLogin: 'chatgpt-codex-connector', state: 'COMMENTED', body: '指摘' }],
      }),
      new Map(),
    );

    expect(candidates.modelReviewCount).toBe(1);
    expect(candidates.channels).toEqual([]);
  });

  it('非modelのレビューしか無いPRを候補ゼロに数えない', () => {
    // コメントだけを候補にすると、レビューで指摘されたPRが「材料なし」として落ちる
    const candidates = collectCandidates(
      rawEvidence({
        reviews: [{ authorLogin: 'Sylphy0052', state: 'CHANGES_REQUESTED', body: '' }],
      }),
      new Map(),
    );

    expect(candidates.accountReviewCount).toBe(1);
    expect(candidates.channels).toEqual(['account-review']);
  });

  it('closing Issue の件数は取れた分ではなく総数を出す', () => {
    const candidates = collectCandidates(
      rawEvidence({
        closingIssues: [
          {
            number: 500,
            title: '元のIssue',
            authorLogin: 'Sylphy0052',
            body: '',
            comments: [
              { authorLogin: 'Sylphy0052', createdAt: '2026-08-19T00:00:00Z', body: '1件目' },
            ],
            commentTotalCount: 120,
          },
        ],
      }),
      new Map(),
    );

    expect(candidates.closingIssues[0]?.commentCount).toBe(120);
  });

  it('後続PRにも openedAfterMerge を残す', () => {
    const candidates = collectCandidates(
      rawEvidence({
        crossReferences: [
          crossRef({ number: 200, sourceCreatedAt: '2026-08-01T00:00:00Z' }),
          crossRef({ number: 201, sourceCreatedAt: '2026-08-21T00:00:00Z' }),
        ],
      }),
      new Map(),
    );

    expect(candidates.followUpPrs.map((pr) => pr.openedAfterMerge)).toEqual([false, true]);
  });

  it('マージ後に立ったIssueの参照は follow-up-issue になる', () => {
    const candidates = collectCandidates(
      rawEvidence({
        crossReferences: [crossRef({ kind: 'Issue', number: 300, title: 'バグ報告' })],
      }),
      new Map(),
    );

    expect(candidates.channels).toContain('follow-up-issue');
    expect(candidates.followUpPrs).toHaveLength(0);
    expect(candidates.followUpIssues[0]?.openedAfterMerge).toBe(true);
  });

  it('マージ前から存在するIssueは openedAfterMerge を立てない', () => {
    // 参照は後でも、Issue自体が前からあるなら「このPRを受けて立った報告」ではない
    const candidates = collectCandidates(
      rawEvidence({
        crossReferences: [
          crossRef({
            kind: 'Issue',
            number: 300,
            title: '前からある計画Issue',
            createdAt: '2026-08-25T00:00:00Z',
            sourceCreatedAt: '2026-08-01T00:00:00Z',
          }),
        ],
      }),
      new Map(),
    );

    expect(candidates.channels).toContain('follow-up-issue');
    expect(candidates.followUpIssues[0]?.openedAfterMerge).toBe(false);
  });

  it('候補がひとつも無いPRを数える', () => {
    const summary = summarizeChannels([
      collectCandidates(rawEvidence({ prNumber: 1 }), new Map()),
      collectCandidates(
        rawEvidence({ prNumber: 2, crossReferences: [crossRef()] }),
        new Map([[200, ['test/unit/foo.test.ts']]]),
      ),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.noChannel).toBe(1);
    expect(summary.perChannel.find((entry) => entry.channel === 'follow-up-test')?.count).toBe(1);
  });
});

describe('verifySourceCoverage', () => {
  const expected = [1, 2, 3];

  it('同じ集合なら通す', () => {
    expect(() =>
      verifySourceCoverage([{ prNumber: 3 }, { prNumber: 1 }, { prNumber: 2 }], expected),
    ).not.toThrow();
  });

  it('欠けている素を拒否する', () => {
    // 件数が減った素をそのまま集計すると、分母が静かに変わる
    expect(() => verifySourceCoverage([{ prNumber: 1 }, { prNumber: 2 }], expected)).toThrow(
      /欠け: 3/,
    );
  });

  it('重複している素を拒否する', () => {
    expect(() =>
      verifySourceCoverage(
        [{ prNumber: 1 }, { prNumber: 1 }, { prNumber: 2 }, { prNumber: 3 }],
        expected,
      ),
    ).toThrow(/重複: 1/);
  });

  it('frame外のPRが混じった素を拒否する', () => {
    expect(() =>
      verifySourceCoverage(
        [{ prNumber: 1 }, { prNumber: 2 }, { prNumber: 3 }, { prNumber: 99 }],
        expected,
      ),
    ).toThrow(/余分: 99/);
  });
});
