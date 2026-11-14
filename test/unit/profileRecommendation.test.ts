import { describe, expect, it } from 'vitest';
import { extractProfileRecommendation } from '../../src/claude/profileRecommendation';

describe('extractProfileRecommendation', () => {
  it('理由ありの行を読む', () => {
    expect(
      extractProfileRecommendation(
        '前置き\n推奨: model=opus / effort=xhigh (未知データの設計判断で探索が支配的)\n後ろ',
      ),
    ).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('理由なしの行を読む。全角括弧の理由も受ける', () => {
    expect(extractProfileRecommendation('推奨: model=sonnet / effort=medium')).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(extractProfileRecommendation('推奨: model=fable / effort=high（理由）')).toEqual({
      model: 'fable',
      effort: 'high',
    });
  });

  it('既知の集合に無い値の行は対象にしない', () => {
    expect(extractProfileRecommendation('推奨: model=gpt5 / effort=xhigh')).toBeUndefined();
    expect(extractProfileRecommendation('推奨: model=opus / effort=ultra')).toBeUndefined();
    expect(extractProfileRecommendation('推奨: model=opus / effort=high extra')).toBeUndefined();
  });

  it('行頭でない行、推奨行が無い本文は対象にしない', () => {
    expect(extractProfileRecommendation('  推奨: model=opus / effort=high')).toBeUndefined();
    expect(
      extractProfileRecommendation('これは推奨: model=opus / effort=high です'),
    ).toBeUndefined();
    expect(extractProfileRecommendation('普通の応答')).toBeUndefined();
    expect(extractProfileRecommendation('')).toBeUndefined();
  });

  it('複数行あれば最後の有効な行を採る', () => {
    expect(
      extractProfileRecommendation(
        '推奨: model=haiku / effort=low\n推奨: model=bad / effort=low\n推奨: model=opus / effort=max',
      ),
    ).toEqual({ model: 'opus', effort: 'max' });
  });

  it('コードブロックの中の行は対象にしない', () => {
    const fence = '```';
    expect(
      extractProfileRecommendation(`${fence}\n推奨: model=opus / effort=high\n${fence}`),
    ).toBeUndefined();
  });
});
