import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_STRATA,
  MIN_EXTREME_TAIL,
  MIN_PER_CHANGE_SIZE_STRATUM,
  SELECTION_TARGET_SIZE,
  STRATUM_QUOTAS,
  balanceShortfalls,
  selectStratifiedSample,
  shuffledOrderOf,
  verifyAgainstFrame,
  verifyPool,
  verifyPositivesEligible,
  type ChangeSizeStratum,
  type DifficultyStratum,
  type EligibilityEntry,
  type FramePullRequest,
  type SelectionCandidate,
} from '../bench/secondOpinionEval/stratifiedSample';

const CHANGE_SIZES: ChangeSizeStratum[] = ['S', 'M', 'L', 'XL'];

function candidate(
  index: number,
  stratum: DifficultyStratum,
  overrides: Partial<SelectionCandidate> = {},
): SelectionCandidate {
  return {
    caseId: `pr-${index}`,
    prNumber: index,
    stratum,
    kind: 'codeReview',
    // 層内で S/M/L/XL が均等に混ざるようにする（バランス制約を通すため）
    changeSizeStratum: CHANGE_SIZES[index % 4] as ChangeSizeStratum,
    tags: index % 5 === 0 ? ['extreme-tail'] : [],
    ...overrides,
  };
}

/** 各層に必要数の2倍を用意した母集団。 */
function pool(): SelectionCandidate[] {
  const candidates: SelectionCandidate[] = [];
  let index = 1;
  for (const stratum of DIFFICULTY_STRATA) {
    for (let i = 0; i < STRATUM_QUOTAS[stratum] * 2; i += 1) {
      candidates.push(candidate(index, stratum));
      index += 1;
    }
  }
  return candidates;
}

function eligibility(
  candidates: readonly SelectionCandidate[],
  overrides: Partial<EligibilityEntry> = {},
): EligibilityEntry[] {
  return candidates.map((entry) => ({
    caseId: entry.caseId,
    conditionId: 'C-repo',
    discoverable: true,
    explicitlyExposed: false,
    ...overrides,
  }));
}

describe('層ごとの必要数', () => {
  it('合計が24件になる', () => {
    const total = DIFFICULTY_STRATA.reduce((sum, stratum) => sum + STRATUM_QUOTAS[stratum], 0);
    expect(total).toBe(SELECTION_TARGET_SIZE);
  });
});

describe('shuffledOrderOf', () => {
  it('入力の並び順によらず同じ順を返す', () => {
    const candidates = pool();
    const forward = shuffledOrderOf(candidates, 'seed:').map((entry) => entry.caseId);
    const reversed = shuffledOrderOf([...candidates].reverse(), 'seed:').map(
      (entry) => entry.caseId,
    );
    expect(reversed).toEqual(forward);
  });

  it('seedが違えば別の順になる', () => {
    const candidates = pool();
    const a = shuffledOrderOf(candidates, 'seed-a:').map((entry) => entry.caseId);
    const b = shuffledOrderOf(candidates, 'seed-b:').map((entry) => entry.caseId);
    expect(b).not.toEqual(a);
  });
});

describe('verifyPool', () => {
  it('層の候補が足りなければ止める', () => {
    const candidates = pool().filter(
      (entry) => entry.stratum !== 'hard-positive' || entry.prNumber < 5,
    );
    expect(() => verifyPool(candidates)).toThrow(/層の候補が足りません/);
  });

  it('caseIdが重複していれば止める', () => {
    const candidates = pool();
    const first = candidates[0] as SelectionCandidate;
    candidates.push({ ...first, prNumber: 9999 });
    expect(() => verifyPool(candidates)).toThrow(/caseId が重複/);
  });
});

describe('verifyPositivesEligible', () => {
  it('正例に判定が無ければ止める', () => {
    const candidates = pool();
    const positives = candidates.filter((entry) => entry.stratum === 'hard-positive');
    const entries = eligibility(candidates).filter(
      (entry) => entry.caseId !== positives[0]?.caseId,
    );
    expect(() => verifyPositivesEligible(candidates, entries, 'C-repo')).toThrow(
      /条件 C-repo の判定がありません/,
    );
  });

  it('別の条件の判定では通さない', () => {
    const candidates = pool();
    const entries = eligibility(candidates, { conditionId: 'A' });
    expect(() => verifyPositivesEligible(candidates, entries, 'C-repo')).toThrow(
      /判定がありません/,
    );
  });

  it('discoverable でない、または explicitlyExposed なら止める', () => {
    const candidates = pool();
    expect(() =>
      verifyPositivesEligible(
        candidates,
        eligibility(candidates, { discoverable: false }),
        'C-repo',
      ),
    ).toThrow(/discoverable かつ explicitlyExposed でない/);
    expect(() =>
      verifyPositivesEligible(
        candidates,
        eligibility(candidates, { explicitlyExposed: true }),
        'C-repo',
      ),
    ).toThrow(/discoverable かつ explicitlyExposed でない/);
  });

  it('負例と判断保留には判定を要求しない', () => {
    const candidates = pool();
    const positivesOnly = eligibility(
      candidates.filter(
        (entry) => entry.stratum === 'hard-positive' || entry.stratum === 'normal-positive',
      ),
    );
    expect(() => verifyPositivesEligible(candidates, positivesOnly, 'C-repo')).not.toThrow();
  });
});

describe('verifyAgainstFrame', () => {
  const frameOf = (candidates: readonly SelectionCandidate[]): FramePullRequest[] =>
    candidates.map((entry) => ({
      prNumber: entry.prNumber,
      changeSizeStratum: entry.changeSizeStratum,
      tags: entry.tags,
      excludedBy: undefined,
    }));

  it('frameと一致していれば通す', () => {
    const candidates = pool();
    expect(() => verifyAgainstFrame(candidates, frameOf(candidates))).not.toThrow();
  });

  it('poolがextreme-tailを勝手に足していれば止める', () => {
    const candidates = pool();
    const frame = frameOf(candidates);
    const tampered = candidates.map((entry, index) =>
      index === 0 ? { ...entry, tags: [...entry.tags, 'extreme-tail'] } : entry,
    );
    expect(() => verifyAgainstFrame(tampered, frame)).toThrow(/tags が frame と違います/);
  });

  it('poolが変更規模の層を書き換えていれば止める', () => {
    const candidates = pool();
    const frame = frameOf(candidates);
    const tampered = candidates.map((entry, index) =>
      index === 0 ? { ...entry, changeSizeStratum: 'XL' as ChangeSizeStratum } : entry,
    );
    expect(() => verifyAgainstFrame(tampered, frame)).toThrow(
      /changeSizeStratum が frame と違います/,
    );
  });

  it('frameに無いPRなら止める', () => {
    const candidates = pool();
    expect(() => verifyAgainstFrame(candidates, frameOf(candidates).slice(1))).toThrow(
      /sampling frame にありません/,
    );
  });

  it('frameで除外済みのPRなら止める', () => {
    const candidates = pool();
    const frame = frameOf(candidates).map((pr, index) =>
      index === 0 ? { ...pr, excludedBy: 'docs-only' } : pr,
    );
    expect(() => verifyAgainstFrame(candidates, frame)).toThrow(/docs-only により除外済み/);
  });
});

describe('balanceShortfalls', () => {
  it('変更規模の層が最低件数に満たなければ挙げる', () => {
    const selected = Array.from({ length: SELECTION_TARGET_SIZE }, (_unused, i) =>
      candidate(i + 1, 'hard-positive', { changeSizeStratum: 'S', tags: ['extreme-tail'] }),
    );
    const shortfalls = balanceShortfalls(selected);
    expect(shortfalls).toHaveLength(3);
    expect(shortfalls.join(' ')).toContain(`最低 ${MIN_PER_CHANGE_SIZE_STRATUM}`);
  });

  it('extreme-tail が1件も無ければ挙げる', () => {
    const selected = Array.from({ length: SELECTION_TARGET_SIZE }, (_unused, i) =>
      candidate(i + 1, 'hard-positive', { tags: [] }),
    );
    expect(balanceShortfalls(selected).join(' ')).toContain(
      `extreme-tail が 0 件（最低 ${MIN_EXTREME_TAIL}）`,
    );
  });
});

describe('selectStratifiedSample', () => {
  it('層ごとの必要数どおりに24件を抜く', () => {
    const result = selectStratifiedSample(pool());
    expect(result.selected).toHaveLength(SELECTION_TARGET_SIZE);
    for (const stratum of DIFFICULTY_STRATA) {
      expect(result.byStratum[stratum]).toBe(STRATUM_QUOTAS[stratum]);
    }
  });

  it('同じ母集団からは何度でも同じ24件を返す', () => {
    const first = selectStratifiedSample(pool()).selected.map((entry) => entry.caseId);
    const second = selectStratifiedSample([...pool()].reverse()).selected.map(
      (entry) => entry.caseId,
    );
    expect(second).toEqual(first);
  });

  it('採用した結果はバランス制約を満たしている', () => {
    const result = selectStratifiedSample(pool());
    expect(balanceShortfalls(result.selected)).toEqual([]);
    expect(result.attempts[result.attempts.length - 1]?.shortfalls).toEqual([]);
  });

  it('落ちた試行も履歴に残す', () => {
    // extreme-tail を1件だけにして、ほとんどの試行が制約で落ちるようにする
    const candidates = pool().map((entry, index) => ({
      ...entry,
      tags: index === 0 ? ['extreme-tail'] : [],
    }));
    const result = selectStratifiedSample(candidates);
    // 引き直しが実際に起きていないと、履歴の主張が素通りする
    expect(result.acceptedAttempt).toBeGreaterThan(0);
    expect(result.attempts).toHaveLength(result.acceptedAttempt + 1);
    expect(result.attempts.filter((attempt) => attempt.shortfalls.length > 0)).toHaveLength(
      result.acceptedAttempt,
    );
  });

  it('引き直しの上限に達したら、seedを増やさずに止める', () => {
    // extreme-tail が母集団に1件も無いので、何度引いても制約を満たせない
    const candidates = pool().map((entry) => ({ ...entry, tags: [] }));
    expect(() => selectStratifiedSample(candidates, { maxAttempts: 5 })).toThrow(
      /5 回引いても変更規模のバランス制約を満たせませんでした/,
    );
  });

  it('候補が足りなければ抽出そのものを止める', () => {
    const candidates = pool().filter((entry) => entry.stratum !== 'indeterminate');
    expect(() => selectStratifiedSample(candidates)).toThrow(/層の候補が足りません/);
  });
});
