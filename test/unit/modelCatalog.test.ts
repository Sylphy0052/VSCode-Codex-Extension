import { describe, expect, it } from 'vitest';
import {
  FALLBACK_EFFORTS,
  effortsFor,
  findModel,
  isEffortToken,
  parseModelCatalog,
} from '../../src/codex/modelCatalog';

/** 実際の models_cache.json を模したもの。 */
const catalog = JSON.stringify({
  fetched_at: '2026-08-06T18:39:06Z',
  models: [
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      description: 'Balanced model.',
      default_reasoning_level: 'medium',
      visibility: 'list',
      priority: 2,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Deep' },
      ],
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' },
      ],
    },
    {
      slug: 'gpt-5.6-sol-wm',
      display_name: '内部用',
      visibility: 'hide',
      priority: 1,
      supported_reasoning_levels: [{ effort: 'low' }],
    },
  ],
});

describe('parseModelCatalog', () => {
  it('priority昇順で並べる', () => {
    expect(parseModelCatalog(catalog).map((m) => m.slug)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('visibilityがlistでないモデルを除く', () => {
    expect(findModel(parseModelCatalog(catalog), 'gpt-5.6-sol-wm')).toBeUndefined();
  });

  it('表示名・説明・既定effortを取り出す', () => {
    const model = findModel(parseModelCatalog(catalog), 'gpt-5.6-terra');
    expect(model?.displayName).toBe('GPT-5.6-Terra');
    expect(model?.description).toBe('Balanced model.');
    expect(model?.defaultEffort).toBe('medium');
    expect(model?.efforts.map((e) => e.effort)).toEqual(['low', 'medium', 'high']);
  });

  it('display_nameが無ければslugで代用する', () => {
    const content = JSON.stringify({
      models: [{ slug: 'bare', visibility: 'list', priority: 1 }],
    });
    expect(parseModelCatalog(content)[0]?.displayName).toBe('bare');
  });

  it('壊れたJSONや想定外の形なら空配列を返す', () => {
    expect(parseModelCatalog('{')).toEqual([]);
    expect(parseModelCatalog('null')).toEqual([]);
    expect(parseModelCatalog('{}')).toEqual([]);
    expect(parseModelCatalog(JSON.stringify({ models: 'x' }))).toEqual([]);
  });

  it('個々の壊れたエントリだけを捨てる', () => {
    const content = JSON.stringify({
      models: [null, { visibility: 'list' }, { slug: 'ok', visibility: 'list', priority: 1 }],
    });
    expect(parseModelCatalog(content).map((m) => m.slug)).toEqual(['ok']);
  });

  it('引数として渡せない形のeffortを捨てる', () => {
    const content = JSON.stringify({
      models: [
        {
          slug: 'ok',
          visibility: 'list',
          priority: 1,
          supported_reasoning_levels: [{ effort: 'high' }, { effort: '--search' }, { effort: '' }],
        },
      ],
    });
    expect(parseModelCatalog(content)[0]?.efforts.map((e) => e.effort)).toEqual(['high']);
  });
});

describe('effortsFor', () => {
  const models = parseModelCatalog(catalog);

  it('指定モデルの対応effortを返す', () => {
    expect(effortsFor(models, 'gpt-5.6-terra')).toEqual(['low', 'medium', 'high']);
  });

  it('モデル未指定なら全モデルの和集合を返す', () => {
    expect(effortsFor(models, '')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('カタログが空ならフォールバックを返す', () => {
    expect(effortsFor([], 'gpt-5.6-terra')).toEqual([...FALLBACK_EFFORTS]);
  });

  it('一覧にないモデルを指定したら和集合にフォールバックする', () => {
    expect(effortsFor(models, 'unknown-model')).toContain('ultra');
  });
});

describe('isEffortToken', () => {
  it('引数として安全な形のみ許可する', () => {
    expect(isEffortToken('xhigh')).toBe(true);
    expect(isEffortToken('very-high')).toBe(true);
    expect(isEffortToken('')).toBe(false);
    expect(isEffortToken('--search')).toBe(false);
    expect(isEffortToken('high value')).toBe(false);
    expect(isEffortToken('High')).toBe(false);
  });
});
