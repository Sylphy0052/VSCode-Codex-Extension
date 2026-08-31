import { describe, expect, it } from 'vitest';

import {
  parseDecisionsJsonl,
  parseScreeningEntry,
  summarizeScreening,
  validateScreeningEntry,
  validateScreeningLog,
  type GroundTruthBasis,
  type ScreeningDecision,
  type ScreeningDisposition,
  type ScreeningEntry,
  type ScreeningFinding,
} from '../bench/secondOpinionEval/screeningResult';

const ORDER = [{ prNumber: 621 }, { prNumber: 650 }, { prNumber: 429 }];

function finding(basis: GroundTruthBasis, overrides: Partial<ScreeningFinding> = {}) {
  return {
    finding: '早期returnで後片付けが飛ぶ',
    groundTruthBasis: basis,
    evidence: '後続PRが再現テストを足している',
    evidenceRefs: ['#700'],
    primary: ['empirical', 'independent-report', 'independent-human'].includes(basis),
    ...overrides,
  } satisfies ScreeningFinding;
}

function decision(overrides: Partial<ScreeningDecision> = {}): ScreeningDecision {
  return {
    type: 'decision',
    orderIndex: 0,
    prNumber: 621,
    primaryCase: true,
    findings: [finding('empirical')],
    disposition: 'primary',
    rationale: '後続の再現テストで真だと確認できる',
    ...overrides,
  };
}

describe('validateScreeningEntry', () => {
  it('整合した判定には問題を返さない', () => {
    expect(validateScreeningEntry(decision(), ORDER)).toEqual([]);
  });

  it('凍結した順と違うPRを書いていたら検出する', () => {
    const problems = validateScreeningEntry(decision({ orderIndex: 1 }), ORDER);
    expect(problems).toEqual([expect.stringContaining('#650')]);
  });

  it('groundTruthBasis と primary の食い違いを検出する', () => {
    const entry = decision({
      findings: [finding('model-derived', { primary: true })],
    });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('groundTruthBasis=model-derived'),
    );
  });

  it('primary な finding があるのに primaryCase が false なら検出する', () => {
    const entry = decision({ primaryCase: false, disposition: 'no-relevant-finding' });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('primaryCase=false'),
    );
  });

  it('primary な finding が無いのに primaryCase が true なら検出する', () => {
    const entry = decision({
      primaryCase: true,
      findings: [finding('model-derived')],
      disposition: 'primary',
    });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('primaryCase=true'),
    );
  });

  it('根拠の空欄を検出する', () => {
    const entry = decision({ findings: [finding('empirical', { evidence: '  ' })] });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('evidence が空です'),
    );
  });

  it('primary なのに参照先が無ければ検出する', () => {
    const entry = decision({ findings: [finding('empirical', { evidenceRefs: [] })] });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('evidenceRefs が空です'),
    );
  });

  it('finding の本文が空なら検出する', () => {
    const entry = decision({ findings: [finding('empirical', { finding: '   ' })] });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('finding が空です'),
    );
  });

  it('空の参照先を検出する', () => {
    const entry = decision({ findings: [finding('empirical', { evidenceRefs: ['  '] })] });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('evidenceRefs に空の参照があります'),
    );
  });

  it('判定の理由が空なら検出する', () => {
    expect(validateScreeningEntry(decision({ rationale: '' }), ORDER)).toContainEqual(
      expect.stringContaining('rationale が空です'),
    );
  });

  it('AI由来だけの案件は model-derived-only を要求する', () => {
    const base = {
      primaryCase: false,
      findings: [finding('model-derived'), finding('model-derived')],
    };
    expect(
      validateScreeningEntry(decision({ ...base, disposition: 'model-derived-only' }), ORDER),
    ).toEqual([]);
    expect(
      validateScreeningEntry(decision({ ...base, disposition: 'retrospective-only' }), ORDER),
    ).toContainEqual(expect.stringContaining('model-derived-only'));
  });

  it('非primaryの根拠が混ざる案件は other-non-primary で記録できる', () => {
    const base = {
      primaryCase: false,
      findings: [finding('model-derived'), finding('retrospective')],
    };
    expect(
      validateScreeningEntry(decision({ ...base, disposition: 'other-non-primary' }), ORDER),
    ).toEqual([]);
    // *-only はどれも当てはまらない
    expect(
      validateScreeningEntry(decision({ ...base, disposition: 'model-derived-only' }), ORDER),
    ).toContainEqual(expect.stringContaining('other-non-primary'));
  });

  it('finding が無い案件に *-only を付けたら検出する', () => {
    const entry = decision({
      primaryCase: false,
      findings: [],
      disposition: 'model-derived-only',
    });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('insufficient-evidence'),
    );
  });

  it('finding があるのに no-relevant-finding としたら検出する', () => {
    const entry = decision({
      primaryCase: false,
      findings: [finding('retrospective')],
      disposition: 'no-relevant-finding',
    });
    expect(validateScreeningEntry(entry, ORDER)).toContainEqual(
      expect.stringContaining('finding が 1 件あります'),
    );
  });
});

describe('summarizeScreening', () => {
  const entries: ScreeningEntry[] = [
    decision(),
    decision({
      orderIndex: 1,
      prNumber: 650,
      primaryCase: false,
      findings: [finding('model-derived')],
      disposition: 'model-derived-only',
    }),
    decision({
      orderIndex: 2,
      prNumber: 429,
      findings: [finding('empirical'), finding('independent-report'), finding('retrospective')],
    }),
  ];

  it('未読を不成立に混ぜない', () => {
    const summary = summarizeScreening(entries, 98);
    expect(summary).toMatchObject({
      screenedCases: 3,
      primaryCases: 2,
      nonPrimaryCases: 1,
      unreadCases: 95,
    });
  });

  it('finding の総数は案件数と別に数える', () => {
    // #621 が1件、#429 が2件。retrospective は primary ではないので入らない
    expect(summarizeScreening(entries, 98).primaryFindings).toBe(3);
  });

  it('非primaryの内訳を disposition ごとに出す', () => {
    const breakdown = summarizeScreening(entries, 98).nonPrimaryBreakdown;
    const counts = new Map(breakdown.map((row) => [row.disposition, row.count]));
    expect(counts.get('model-derived-only')).toBe(1);
    expect(counts.get('retrospective-only')).toBe(0);
    // 0件の種別も落とさない（funnelの読み手が母数を追えるように）
    const dispositions: ScreeningDisposition[] = [
      'model-derived-only',
      'retrospective-only',
      'mixed-only',
      'other-non-primary',
      'insufficient-evidence',
      'no-relevant-finding',
    ];
    expect(breakdown.map((row) => row.disposition)).toEqual(dispositions);
  });

  it('訂正は後の行が有効になり、案件を二重に数えない', () => {
    const corrected: ScreeningEntry[] = [
      ...entries,
      {
        ...decision({ primaryCase: false, findings: [], disposition: 'insufficient-evidence' }),
        type: 'supersede',
        supersedes: 0,
        reason: '再現テストは別の問題を対象にしていた',
      },
    ];
    expect(summarizeScreening(corrected, 98)).toMatchObject({
      screenedCases: 3,
      primaryCases: 1,
      nonPrimaryCases: 2,
    });
  });
});

describe('parseScreeningEntry', () => {
  it('型どおりのJSONを受け取る', () => {
    expect(parseScreeningEntry(JSON.parse(JSON.stringify(decision())))).toEqual(decision());
  });

  it('type のtypoを通さない', () => {
    // as ScreeningEntry で受けていたときは、集計には入るのに順序確認から外れて食い違った
    expect(() => parseScreeningEntry({ ...decision(), type: 'decison' })).toThrow(/type/);
  });

  it('groundTruthBasis のtypoを通さない', () => {
    const entry = { ...decision(), findings: [finding('empirical')] };
    entry.findings[0]!.groundTruthBasis = 'independent-humna' as GroundTruthBasis;
    expect(() => parseScreeningEntry(entry)).toThrow(/groundTruthBasis/);
  });

  it('disposition のtypoを通さない', () => {
    expect(() => parseScreeningEntry({ ...decision(), disposition: 'primaryy' })).toThrow(
      /disposition/,
    );
  });

  it('数値の欄が数でなければ投げる', () => {
    expect(() => parseScreeningEntry({ ...decision(), orderIndex: '0' })).toThrow(/orderIndex/);
    expect(() => parseScreeningEntry({ ...decision(), orderIndex: -1 })).toThrow(/orderIndex/);
    expect(() => parseScreeningEntry({ ...decision(), orderIndex: 1.5 })).toThrow(/orderIndex/);
    expect(() => parseScreeningEntry({ ...decision(), prNumber: 0 })).toThrow(/prNumber/);
  });

  it('真偽値の欄が真偽値でなければ投げる', () => {
    expect(() => parseScreeningEntry({ ...decision(), primaryCase: 'true' })).toThrow(
      /primaryCase/,
    );
  });

  it('findings が配列でなければ投げる', () => {
    expect(() => parseScreeningEntry({ ...decision(), findings: {} })).toThrow(/findings/);
  });

  it('evidenceRefs の要素が文字列でなければ投げる', () => {
    const entry = { ...decision(), findings: [{ ...finding('empirical'), evidenceRefs: [700] }] };
    expect(() => parseScreeningEntry(entry)).toThrow(/evidenceRefs\[0\]/);
  });

  it('supersede には supersedes と reason を要求する', () => {
    const entry = { ...decision(), type: 'supersede' };
    expect(() => parseScreeningEntry(entry)).toThrow(/supersedes/);
    expect(() => parseScreeningEntry({ ...entry, supersedes: 0 })).toThrow(/reason/);
  });
});

describe('parseDecisionsJsonl', () => {
  it('空行を飛ばして1行1件で読む', () => {
    const text = `${JSON.stringify(decision())}\n\n${JSON.stringify(
      decision({ orderIndex: 1, prNumber: 650 }),
    )}\n`;
    expect(parseDecisionsJsonl(text).map((entry) => entry.prNumber)).toEqual([621, 650]);
  });

  it('壊れた行は行番号を添えて投げる', () => {
    expect(() => parseDecisionsJsonl(`${JSON.stringify(decision())}\n{壊れている\n`)).toThrow(
      /2 行目/,
    );
  });

  it('型に合わない行も行番号を添えて投げる', () => {
    const broken = JSON.stringify({ ...decision(), type: 'decison' });
    expect(() => parseDecisionsJsonl(`${JSON.stringify(decision())}\n${broken}\n`)).toThrow(
      /2 行目.*type/s,
    );
  });
});

describe('validateScreeningLog', () => {
  it('凍結した順の先頭から読んでいれば通る', () => {
    const entries = [decision(), decision({ orderIndex: 1, prNumber: 650 })];
    expect(validateScreeningLog(entries, ORDER)).toEqual([]);
  });

  it('順を飛ばして読んでいたら検出する', () => {
    const entries = [decision(), decision({ orderIndex: 2, prNumber: 429 })];
    expect(validateScreeningLog(entries, ORDER)).toContainEqual(
      expect.stringContaining('順を飛ばさずに'),
    );
  });

  it('訂正は読んだ順の連番に数えない', () => {
    const entries: ScreeningEntry[] = [
      decision(),
      {
        ...decision({ primaryCase: false, findings: [], disposition: 'insufficient-evidence' }),
        type: 'supersede',
        supersedes: 0,
        reason: '読み違えていた',
      },
      decision({ orderIndex: 1, prNumber: 650 }),
    ];
    expect(validateScreeningLog(entries, ORDER)).toEqual([]);
  });

  it('訂正が自分自身を指していたら検出する', () => {
    const entries: ScreeningEntry[] = [
      decision(),
      {
        ...decision({ primaryCase: false, findings: [], disposition: 'insufficient-evidence' }),
        type: 'supersede',
        supersedes: 1,
        reason: '自己参照',
      },
    ];
    expect(validateScreeningLog(entries, ORDER)).toContainEqual(
      expect.stringContaining('自分自身か後の行'),
    );
  });

  it('訂正の理由が空なら検出する', () => {
    const entries: ScreeningEntry[] = [
      decision(),
      {
        ...decision({ primaryCase: false, findings: [], disposition: 'insufficient-evidence' }),
        type: 'supersede',
        supersedes: 0,
        reason: '  ',
      },
    ];
    expect(validateScreeningLog(entries, ORDER)).toContainEqual(
      expect.stringContaining('reason が空です'),
    );
  });

  it('2回目の訂正は直前の訂正を置き換える', () => {
    const correction = (supersedes: number): ScreeningEntry => ({
      ...decision({ primaryCase: false, findings: [], disposition: 'insufficient-evidence' }),
      type: 'supersede',
      supersedes,
      reason: '読み違えていた',
    });
    // 1回目の訂正(行1)を飛ばして最初のdecision(行0)を指すのは、履歴が枝分かれする
    expect(validateScreeningLog([decision(), correction(0), correction(0)], ORDER)).toContainEqual(
      expect.stringContaining('直前の判定を置き換えて'),
    );
    expect(validateScreeningLog([decision(), correction(0), correction(1)], ORDER)).toEqual([]);
  });

  it('訂正が別の案件を指していたら検出する', () => {
    const entries: ScreeningEntry[] = [
      decision(),
      {
        ...decision({ orderIndex: 1, prNumber: 650 }),
        type: 'supersede',
        supersedes: 0,
        reason: '行を間違えている',
      },
    ];
    expect(validateScreeningLog(entries, ORDER)).toContainEqual(
      expect.stringContaining('supersedes の指す行'),
    );
  });
});
