import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import {
  EFFORT_LADDER,
  MODEL_TIERS,
  resolveLevelSettings,
  type HandoffLevel,
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

const current = { model: 'gpt-5.6-sol', effort: 'high' };

describe('レベルの段の定義', () => {
  it('ティアは3段で、最下位にhaiku/lunaを含めない', () => {
    expect(MODEL_TIERS).toHaveLength(3);
    const flat = MODEL_TIERS.flat();
    expect(flat).not.toContain('haiku');
    expect(flat).not.toContain('luna');
  });

  it('effortは4段でmaxを含めない', () => {
    expect([...EFFORT_LADDER]).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('resolveLevelSettings: Codexのカタログ', () => {
  const cases: [HandoffLevel, string, string][] = [
    [0, 'gpt-5.6-terra', 'low'],
    [1, 'gpt-5.6-terra', 'medium'],
    [2, 'gpt-5.6-sol', 'medium'],
    [3, 'gpt-5.6-sol', 'high'],
    [4, 'gpt-5.6-astra', 'high'],
    [5, 'gpt-5.6-astra', 'xhigh'],
  ];

  for (const [level, expectedModel, expectedEffort] of cases) {
    it(`L${level} は ${expectedModel} / ${expectedEffort}`, () => {
      const resolved = resolveLevelSettings(level, codexModels(), current);
      expect(resolved).toEqual({ model: expectedModel, effort: expectedEffort });
    });
  }

  it('カタログにmaxがあってもL5では選ばない', () => {
    expect(resolveLevelSettings(5, codexModels(), current).effort).toBe('xhigh');
  });

  it('lunaはどのレベルでも選ばれない', () => {
    const models = codexModels();
    for (const level of [0, 1, 2, 3, 4, 5] as HandoffLevel[]) {
      expect(resolveLevelSettings(level, models, current).model).not.toContain('luna');
    }
  });
});

describe('resolveLevelSettings: Claude Codeのカタログ', () => {
  it('L0/L1はsonnet、L2/L3はopus、L4/L5はfable', () => {
    const models = claudeModels();
    expect(resolveLevelSettings(0, models, { model: 'opus', effort: 'high' }).model).toBe('sonnet');
    expect(resolveLevelSettings(2, models, { model: 'opus', effort: 'high' }).model).toBe('opus');
    expect(resolveLevelSettings(5, models, { model: 'opus', effort: 'high' }).model).toBe('fable');
  });

  it('haikuはどのレベルでも選ばれない', () => {
    const models = claudeModels();
    for (const level of [0, 1, 2, 3, 4, 5] as HandoffLevel[]) {
      expect(resolveLevelSettings(level, models, { model: 'opus', effort: 'high' }).model).not.toBe(
        'haiku',
      );
    }
  });
});

describe('resolveLevelSettings: カタログが揃わないとき', () => {
  it('ティアに合うモデルがカタログに無ければ引き継ぎ元のモデルを据え置く', () => {
    const onlyTop = [model('gpt-5.6-astra', FIVE)];
    // L0が求めるのは最下位ティア（terra）。無いので据え置き
    expect(resolveLevelSettings(0, onlyTop, current).model).toBe(current.model);
    // L4が求めるのは最上位ティア。こちらは見つかる
    expect(resolveLevelSettings(4, onlyTop, current).model).toBe('gpt-5.6-astra');
  });

  it('effort非対応のモデルにはeffortを渡さない', () => {
    const models = [model('sonnet', [])];
    expect(resolveLevelSettings(0, models, { model: 'sonnet', effort: '' })).toEqual({
      model: 'sonnet',
      effort: '',
    });
  });

  it('カタログのeffortが一部しか無ければ、その中の端へ丸める', () => {
    const models = [model('gpt-5.6-terra', ['low', 'medium'])];
    // L1が求めるのはmedium（ladderの2番目）。そのまま取れる
    expect(resolveLevelSettings(1, models, current).effort).toBe('medium');
    // L5が求めるのはxhighだが無いので、選べる中の最上位へ丸める
    expect(resolveLevelSettings(5, models, current).effort).toBe('medium');
  });

  it('カタログのeffortがladderに載っていない値だけなら未指定にする', () => {
    const models = [model('gpt-5.6-terra', ['max'])];
    expect(resolveLevelSettings(3, models, current).effort).toBe('');
  });

  it('カタログが空ならfallbackのeffort一覧から選び、モデルは据え置く', () => {
    const resolved = resolveLevelSettings(4, [], current, FIVE);
    expect(resolved.model).toBe(current.model);
    expect(resolved.effort).toBe('high');
  });
});
