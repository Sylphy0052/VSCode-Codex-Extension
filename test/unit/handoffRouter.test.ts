import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import {
  EFFORT_LADDER,
  MODEL_TIERS,
  applyCorrections,
  effortIndexFor,
  isProfileChange,
  resolveProfile,
  tierFor,
  type TaskAssessment,
} from '../../src/view/handoffRouter';

function model(slug: string, efforts: readonly string[]): ModelInfo {
  return {
    slug,
    displayName: slug,
    description: undefined,
    defaultEffort: undefined,
    supportsEffort: efforts.length > 0,
    efforts: efforts.map((effort) => ({ effort, description: undefined })),
  };
}

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Codex側のカタログを模した一覧（Terra < Sol < Astra）。 */
function codexModels(): ModelInfo[] {
  return [
    model('gpt-5.6-luna', FIVE),
    model('gpt-5.6-terra', FIVE),
    model('gpt-5.6-sol', FIVE),
    model('gpt-5.6-astra', FIVE),
  ];
}

/** Claude Code側のカタログを模した一覧（Sonnet < Opus < Fable）。 */
function claudeModels(): ModelInfo[] {
  return [model('haiku', []), model('sonnet', FIVE), model('opus', FIVE), model('fable', FIVE)];
}

function assess(over: Partial<TaskAssessment> = {}): TaskAssessment {
  return {
    taskType: 'implementation',
    difficulty: 0,
    scope: 0,
    ambiguity: 0,
    risk: 0,
    autonomy: 0,
    confidence: 0.9,
    reasons: [],
    switchSafe: true,
    switchReason: '',
    handoffSuggested: false,
    handoffSuggestReason: '',
    awaitingUserAnswer: false,
    awaitingUserAnswerReason: '',
    ...over,
  };
}

const current = { model: 'gpt-5.6-sol', effort: 'high' };
const noFailure = { turnFailed: false };

describe('段の定義', () => {
  it('ティアは3段で、最下位にhaiku/lunaを含めない', () => {
    expect(MODEL_TIERS).toHaveLength(3);
    const flat = MODEL_TIERS.flat();
    expect(flat).not.toContain('haiku');
    expect(flat).not.toContain('luna');
  });

  it('effortは3段でlowとmaxを含めない', () => {
    expect([...EFFORT_LADDER]).toEqual(['medium', 'high', 'xhigh']);
  });
});

describe('effortはdifficultyだけで決まる', () => {
  it('difficulty 0/1/2 → medium/high/xhigh', () => {
    expect(effortIndexFor(assess({ difficulty: 0 })).index).toBe(0);
    expect(effortIndexFor(assess({ difficulty: 1 })).index).toBe(1);
    expect(effortIndexFor(assess({ difficulty: 2 })).index).toBe(2);
  });

  it('scopeやriskが高くてもdifficultyが低ければeffortは上がらない（riskは2を除く）', () => {
    expect(effortIndexFor(assess({ difficulty: 0, scope: 2, ambiguity: 2 })).index).toBe(0);
  });

  it('debugging / security_review / review_spec / risk=2 はhigh以上', () => {
    for (const taskType of ['debugging', 'security_review', 'review_spec'] as const) {
      const result = effortIndexFor(assess({ difficulty: 0, taskType }));
      expect(result.index).toBe(1);
      expect(result.notes).toContain('effort floor: high');
    }
    expect(effortIndexFor(assess({ difficulty: 0, risk: 2 })).index).toBe(1);
  });
});

describe('modelはscope+ambiguity+risk+autonomyで決まる', () => {
  it('合計2以下は最下位、5以下は中位、6以上は最上位', () => {
    expect(tierFor(assess()).tier).toBe(0);
    expect(tierFor(assess({ scope: 1, ambiguity: 1 })).tier).toBe(0);
    expect(tierFor(assess({ scope: 1, ambiguity: 1, risk: 1 })).tier).toBe(1);
    expect(tierFor(assess({ scope: 2, ambiguity: 2, risk: 1 })).tier).toBe(1);
    expect(tierFor(assess({ scope: 2, ambiguity: 2, risk: 2 })).tier).toBe(2);
  });

  it('difficultyが高くてもmodelは上がらない（Sonnet/xhigh を表現できる）', () => {
    const resolved = resolveProfile(assess({ difficulty: 2 }), noFailure, claudeModels(), {
      model: 'opus',
      effort: 'high',
    });
    expect(resolved).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
  });

  it('広く曖昧でもdifficultyが低ければ Opus/medium になりうる', () => {
    const resolved = resolveProfile(
      assess({ difficulty: 0, scope: 2, ambiguity: 1, autonomy: 1 }),
      noFailure,
      claudeModels(),
      { model: 'sonnet', effort: 'high' },
    );
    expect(resolved).toMatchObject({ model: 'opus', effort: 'medium' });
  });
});

describe('補正', () => {
  it('security_review は risk=2', () => {
    const { assessment, notes } = applyCorrections(
      assess({ taskType: 'security_review', risk: 0 }),
      noFailure,
    );
    expect(assessment.risk).toBe(2);
    expect(notes).toContain('security_review: risk=2');
  });

  it('debugging は difficulty=2', () => {
    const { assessment } = applyCorrections(assess({ taskType: 'debugging' }), noFailure);
    expect(assessment.difficulty).toBe(2);
  });

  it('spec / planning は ambiguity を1以上にする', () => {
    expect(applyCorrections(assess({ taskType: 'spec' }), noFailure).assessment.ambiguity).toBe(1);
    expect(
      applyCorrections(assess({ taskType: 'planning', ambiguity: 2 }), noFailure).assessment
        .ambiguity,
    ).toBe(2);
  });

  it('直前のターンが失敗していれば difficulty を1段上げる（上限2）', () => {
    const raised = applyCorrections(assess({ difficulty: 1 }), { turnFailed: true });
    expect(raised.assessment.difficulty).toBe(2);
    expect(raised.notes).toContain('previous attempt failed: difficulty=2');

    const capped = applyCorrections(assess({ difficulty: 2 }), { turnFailed: true });
    expect(capped.assessment.difficulty).toBe(2);
    expect(capped.notes).toHaveLength(0);
  });

  it('補正は元の見立てを書き換えない', () => {
    const original = assess({ taskType: 'security_review', risk: 0 });
    applyCorrections(original, noFailure);
    expect(original.risk).toBe(0);
  });
});

describe('resolveProfile: Codexのカタログ', () => {
  it('局所・明確・定型 → Terra / medium', () => {
    expect(resolveProfile(assess(), noFailure, codexModels(), current)).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'medium',
    });
  });

  it('複数ファイル・複数ステップ → Terra / high', () => {
    expect(
      resolveProfile(assess({ difficulty: 1, scope: 1 }), noFailure, codexModels(), current),
    ).toMatchObject({ model: 'gpt-5.6-terra', effort: 'high' });
  });

  it('リポジトリ横断・曖昧・高リスク・自律 → Astra / xhigh', () => {
    expect(
      resolveProfile(
        assess({ difficulty: 2, scope: 2, ambiguity: 2, risk: 2, autonomy: 2 }),
        noFailure,
        codexModels(),
        current,
      ),
    ).toMatchObject({ model: 'gpt-5.6-astra', effort: 'xhigh' });
  });

  it('lunaはどの見立てでも選ばれない', () => {
    expect(resolveProfile(assess(), noFailure, codexModels(), current).model).not.toContain('luna');
  });

  it('理由に見立ての内訳と補正を残す', () => {
    const resolved = resolveProfile(
      assess({ taskType: 'debugging' }),
      { turnFailed: true },
      codexModels(),
      current,
    );
    expect(resolved.reasons[0]).toContain('debugging difficulty=2');
    expect(resolved.reasons).toContain('debugging: difficulty=2');
  });
});

describe('resolveProfile: カタログが揃わないとき', () => {
  it('ティアに合うモデルがカタログに無ければ引き継ぎ元のモデルを据え置く', () => {
    const onlyTop = [model('gpt-5.6-astra', FIVE)];
    expect(resolveProfile(assess(), noFailure, onlyTop, current).model).toBe(current.model);
    expect(
      resolveProfile(assess({ scope: 2, ambiguity: 2, risk: 2 }), noFailure, onlyTop, current)
        .model,
    ).toBe('gpt-5.6-astra');
  });

  it('effort非対応のモデルにはeffortを渡さない', () => {
    const models = [model('sonnet', [])];
    expect(
      resolveProfile(assess({ difficulty: 2 }), noFailure, models, { model: 'sonnet', effort: '' }),
    ).toMatchObject({ model: 'sonnet', effort: '' });
  });

  it('カタログのeffortが一部しか無ければ、選べる中の最上位へ丸める', () => {
    const models = [model('gpt-5.6-terra', ['low', 'medium'])];
    expect(resolveProfile(assess({ difficulty: 2 }), noFailure, models, current).effort).toBe(
      'medium',
    );
  });

  it('カタログのeffortがladderに載っていない値だけなら未指定にする', () => {
    const models = [model('gpt-5.6-terra', ['max'])];
    expect(resolveProfile(assess(), noFailure, models, current).effort).toBe('');
  });

  it('カタログが空ならfallbackのeffort一覧から選び、モデルは据え置く', () => {
    const resolved = resolveProfile(assess({ difficulty: 1 }), noFailure, [], current, FIVE);
    expect(resolved.model).toBe(current.model);
    expect(resolved.effort).toBe('high');
  });
});

describe('isProfileChange（Issue #1090）', () => {
  it('モデルが変われば「変わった」', () => {
    expect(
      isProfileChange({ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'medium' }),
    ).toBe(true);
  });

  it('effortの1段差では「変わった」にしない', () => {
    expect(
      isProfileChange({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'xhigh' }),
    ).toBe(false);
  });

  it('effortが2段動けば「変わった」', () => {
    expect(
      isProfileChange({ model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'medium' }),
    ).toBe(true);
  });

  it('effortが未指定・ladder外なら比較材料が無いので「変わっていない」', () => {
    expect(isProfileChange({ model: 'opus', effort: '' }, { model: 'opus', effort: 'xhigh' })).toBe(
      false,
    );
    expect(
      isProfileChange({ model: 'opus', effort: 'low' }, { model: 'opus', effort: 'xhigh' }),
    ).toBe(false);
  });
});
