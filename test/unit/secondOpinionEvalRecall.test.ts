import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  eligibilityKey,
  selectPrimaryFindingIndexes,
  validateScore,
  verifyFrozenInputs,
  type Score,
} from '../bench/secondOpinionEval/recall';
import type { FindingEligibility, KnownFinding } from '../bench/secondOpinionEval/types';

function finding(overrides: Partial<KnownFinding> = {}): KnownFinding {
  return {
    finding: '予約idの大小文字がファイル名へそのまま出る',
    recallCriteria: ['原因に触れている', '症状に触れている'],
    evidence: 'src/x.ts:12',
    severity: 'critical',
    provenance: 'issue',
    groundTruthBasis: 'empirical',
    evidencePaths: ['base/src/x.ts'],
    ...overrides,
  };
}

function judgment(overrides: Partial<FindingEligibility> = {}): FindingEligibility {
  return {
    caseId: 'c1',
    findingIndex: 0,
    conditionId: 'A',
    discoverable: true,
    explicitlyExposed: false,
    rationale: '差分だけで導ける',
    ...overrides,
  };
}

function eligibilityMap(entries: readonly FindingEligibility[]): Map<string, FindingEligibility> {
  return new Map(
    entries.map((entry) => [
      eligibilityKey(entry.caseId, entry.findingIndex, entry.conditionId),
      entry,
    ]),
  );
}

function score(overrides: Partial<Score> = {}): Score {
  return {
    scoringId: 's1',
    totalFindings: 3,
    actionableFindings: 2,
    verifiedNonActionableFindings: 1,
    indeterminateFindings: 0,
    hallucinatedFindings: 0,
    recalledFindingIndexes: [0],
    constraintViolations: 0,
    unnecessaryInvestigationRequests: 0,
    ...overrides,
  };
}

describe('selectPrimaryFindingIndexes', () => {
  it('モデル判断だけを根拠にしたラベルを分母から外す', () => {
    const findings = [finding(), finding({ groundTruthBasis: 'model-derived' })];
    const result = selectPrimaryFindingIndexes(
      findings,
      eligibilityMap([judgment(), judgment({ findingIndex: 1 })]),
      'c1',
      'A',
    );

    expect(result.primary).toEqual([0]);
    expect(result.excluded).toBe(1);
    expect(result.unjudged).toBe(0);
  });

  it('複数の根拠が混じったラベルも分母から外す', () => {
    const findings = [finding({ groundTruthBasis: 'mixed' })];
    const result = selectPrimaryFindingIndexes(findings, eligibilityMap([judgment()]), 'c1', 'A');

    expect(result.primary).toEqual([]);
    expect(result.excluded).toBe(1);
  });

  it('その条件の材料から発見できないラベルを分母から外す', () => {
    const result = selectPrimaryFindingIndexes(
      [finding()],
      eligibilityMap([judgment({ discoverable: false })]),
      'c1',
      'A',
    );

    expect(result.primary).toEqual([]);
    expect(result.excluded).toBe(1);
  });

  it('入力に答えが書かれているラベルを分母から外す', () => {
    const result = selectPrimaryFindingIndexes(
      [finding()],
      eligibilityMap([judgment({ explicitlyExposed: true })]),
      'c1',
      'A',
    );

    expect(result.primary).toEqual([]);
    expect(result.excluded).toBe(1);
  });

  it('判定の無いラベルは分母へ入れず、除外とは別に数える', () => {
    const result = selectPrimaryFindingIndexes([finding()], eligibilityMap([]), 'c1', 'A');

    expect(result.primary).toEqual([]);
    expect(result.unjudged).toBe(1);
    expect(result.excluded).toBe(0);
  });

  it('同じラベルでも条件が変われば分母が変わる', () => {
    const findings = [finding()];
    const eligibility = eligibilityMap([
      judgment({ conditionId: 'A', discoverable: false, rationale: '差分の外にある' }),
      judgment({ conditionId: 'C-repo', discoverable: true, rationale: 'repo全体を探索できる' }),
    ]);

    const underA = selectPrimaryFindingIndexes(findings, eligibility, 'c1', 'A');
    const underC = selectPrimaryFindingIndexes(findings, eligibility, 'c1', 'C-repo');

    expect(underA.primary).toEqual([]);
    expect(underC.primary).toEqual([0]);
  });

  it('別の案件の判定を取り違えない', () => {
    const result = selectPrimaryFindingIndexes(
      [finding()],
      eligibilityMap([judgment({ caseId: 'c2' })]),
      'c1',
      'A',
    );

    expect(result.unjudged).toBe(1);
  });
});

describe('validateScore', () => {
  it('正しい採点は通す', () => {
    expect(validateScore(score(), 2)).toBeUndefined();
  });

  it('recalledFindingIndexes の重複を弾く', () => {
    expect(validateScore(score({ recalledFindingIndexes: [0, 0] }), 2)).toMatch(/重複/);
  });

  it('recalledFindingIndexes の範囲外を弾く', () => {
    expect(validateScore(score({ recalledFindingIndexes: [2] }), 2)).toMatch(/範囲外/);
    expect(validateScore(score({ recalledFindingIndexes: [-1] }), 2)).toMatch(/範囲外/);
    expect(validateScore(score({ recalledFindingIndexes: [1.5] }), 2)).toMatch(/範囲外/);
  });

  it('recalledFindingIndexes が配列でなければ弾く', () => {
    const broken = score();
    (broken as { recalledFindingIndexes: unknown }).recalledFindingIndexes = 1;

    expect(validateScore(broken, 2)).toMatch(/配列ではありません/);
  });

  it('件数が負や非整数なら弾く', () => {
    expect(validateScore(score({ actionableFindings: -1 }), 2)).toMatch(/actionableFindings/);
    expect(validateScore(score({ totalFindings: 1.5 }), 2)).toMatch(/totalFindings/);
  });
});

describe('verifyFrozenInputs', () => {
  async function makeRun(manifestOverrides: Record<string, unknown> = {}): Promise<{
    resultsDir: string;
    casesPath: string;
    eligibilityPath: string;
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'so-eval-freeze-'));
    const casesPath = path.join(dir, 'cases.json');
    const eligibilityPath = path.join(dir, 'eligibility.json');
    await fs.writeFile(casesPath, '[{"caseId":"c1"}]', 'utf8');
    await fs.writeFile(eligibilityPath, '[{"caseId":"c1"}]', 'utf8');
    const sha = async (p: string): Promise<string> =>
      createHash('sha256')
        .update(await fs.readFile(p, 'utf8'))
        .digest('hex');
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        casesSha256: await sha(casesPath),
        eligibilitySha256: await sha(eligibilityPath),
        ...manifestOverrides,
      }),
      'utf8',
    );
    return { resultsDir: dir, casesPath, eligibilityPath };
  }

  it('凍結したときと同じ内容なら通す', async () => {
    const run = await makeRun();

    await expect(
      verifyFrozenInputs(run.resultsDir, run.casesPath, run.eligibilityPath),
    ).resolves.toBeUndefined();
  });

  it('案件ファイルが変わっていれば止める', async () => {
    const run = await makeRun();
    await fs.writeFile(run.casesPath, '[{"caseId":"c2"}]', 'utf8');

    await expect(
      verifyFrozenInputs(run.resultsDir, run.casesPath, run.eligibilityPath),
    ).rejects.toThrow(/案件ファイルが実行時から変わっています/);
  });

  it('判定ファイルが変わっていれば止める', async () => {
    const run = await makeRun();
    await fs.writeFile(run.eligibilityPath, '[{"caseId":"c2"}]', 'utf8');

    await expect(
      verifyFrozenInputs(run.resultsDir, run.casesPath, run.eligibilityPath),
    ).rejects.toThrow(/判定ファイルが実行時から変わっています/);
  });

  it('判定ファイル無しで実行した run は集計しない', async () => {
    const run = await makeRun({ eligibilitySha256: undefined });

    await expect(
      verifyFrozenInputs(run.resultsDir, run.casesPath, run.eligibilityPath),
    ).rejects.toThrow(/--eligibility 無しで実行されています/);
  });
});
