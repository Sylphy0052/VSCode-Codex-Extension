import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/codex/modelCatalog';
import {
  effortIndexFor,
  isCostPreset,
  resolveProfile,
  tierFor,
  type TaskAssessment,
} from '../../src/view/handoffRouter';

/**
 * 引き継ぎ先のmodel / effortに被せるコスト方針（Issue #1214）。
 *
 * 見立て（assessment）からの割り当てそのものは `handoffRouter.test.ts` が見る。ここでは
 * 「同じ見立てでもプリセット次第で結果が下がる」ことだけを確かめる。
 */

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];

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

/** Claude Code側のカタログを模した一覧（Sonnet < Opus）。 */
function claudeModels(): ModelInfo[] {
  return [model('haiku', []), model('sonnet', FIVE), model('opus', FIVE)];
}

/** Codex側のカタログを模した一覧（GPT-6-Luna < GPT-6.1-Sol）。 */
function codexModels(): ModelInfo[] {
  return [model('gpt-6-luna', FIVE), model('gpt-6.1-sol', FIVE)];
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

const noFailure = { turnFailed: false };
const current = { model: 'gpt-6.1-sol', effort: 'medium' };

/** 最上位のティアとeffortを引き当てる見立て（scope + ambiguity + risk + autonomy = 8）。 */
const heaviest = assess({ difficulty: 2, scope: 2, ambiguity: 2, risk: 2, autonomy: 2 });

describe('コスト方針のプリセット（Issue #1214）', () => {
  it('省略時は full（従来どおりの割り当て）', () => {
    expect(tierFor(heaviest).tier).toBe(1);
    expect(effortIndexFor(heaviest).index).toBe(2);
    expect(resolveProfile(heaviest, noFailure, claudeModels(), current)).toMatchObject({
      model: 'opus',
      effort: 'xhigh',
    });
  });

  it('low はxhighを使わない（モデルのティアは変えない）', () => {
    expect(
      resolveProfile(heaviest, noFailure, claudeModels(), current, undefined, 'low'),
    ).toMatchObject({ model: 'opus', effort: 'high' });
    expect(
      resolveProfile(heaviest, noFailure, codexModels(), current, undefined, 'low'),
    ).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('low は制限を掛けた理由を残す', () => {
    const resolved = resolveProfile(heaviest, noFailure, claudeModels(), current, undefined, 'low');
    expect(resolved.reasons).toContain('コスト方針=low: effortをhighへ制限');
  });

  it('low でも effort floor（high）は残る', () => {
    expect(effortIndexFor(assess({ difficulty: 0, taskType: 'debugging' }), 'low').index).toBe(1);
  });

  it('ティアはコスト方針で変わらない（最大ティアは1）', () => {
    expect(tierFor(heaviest).tier).toBe(1);
    expect(tierFor(assess({ scope: 1, ambiguity: 1, risk: 1 })).tier).toBe(1);
    expect(tierFor(assess({ scope: 1, ambiguity: 1 })).tier).toBe(0);
  });

  it('balanced は effort を制限しない', () => {
    expect(effortIndexFor(heaviest, 'balanced').index).toBe(2);
    expect(
      resolveProfile(heaviest, noFailure, claudeModels(), current, undefined, 'balanced').effort,
    ).toBe('xhigh');
  });

  it('full は制限を掛けた理由を足さない', () => {
    const resolved = resolveProfile(
      heaviest,
      noFailure,
      claudeModels(),
      current,
      undefined,
      'full',
    );
    expect(resolved.reasons.filter((r) => r.startsWith('コスト方針='))).toEqual([]);
  });

  it('isCostPreset は列挙した値だけを受け付ける', () => {
    expect(isCostPreset('low')).toBe(true);
    expect(isCostPreset('balanced')).toBe(true);
    expect(isCostPreset('full')).toBe(true);
    expect(isCostPreset('max')).toBe(false);
    expect(isCostPreset(undefined)).toBe(false);
  });
});
