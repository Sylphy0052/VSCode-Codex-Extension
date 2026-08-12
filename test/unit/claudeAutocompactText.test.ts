import { describe, expect, it } from 'vitest';
import { parseAutocompactReport } from '../../src/claude/autocompactText';

describe('parseAutocompactReport（issue #201）', () => {
  it('問い合わせ応答（未設定=auto）を読む', () => {
    const text =
      "Auto-compact window: auto\nAuto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.\nThe auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance.";
    expect(parseAutocompactReport(text)).toEqual({ mode: 'auto', tokens: undefined });
  });

  it('問い合わせ応答（設定済み・from settings付き）を読む', () => {
    const text =
      "Auto-compact window: 300k tokens (from settings)\nAuto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.";
    expect(parseAutocompactReport(text)).toEqual({ mode: 'fixed', tokens: 300000 });
  });

  it('変更後の確認応答（固定値）を読む', () => {
    expect(parseAutocompactReport('Auto-compact window set to 300k tokens')).toEqual({
      mode: 'fixed',
      tokens: 300000,
    });
  });

  it('変更後の確認応答（autoへ戻す）を読む', () => {
    expect(parseAutocompactReport('Auto-compact window set to auto')).toEqual({
      mode: 'auto',
      tokens: undefined,
    });
  });

  it('kが付かない生のトークン数も読む', () => {
    expect(parseAutocompactReport('Auto-compact window set to 200000 tokens')).toEqual({
      mode: 'fixed',
      tokens: 200000,
    });
  });

  it('範囲外・書式不正の失敗応答は undefined（値は変わっていない）', () => {
    // 実測（design.md §14.37）: 100k未満・1M超過・auto/数値のどちらでもない入力は
    // すべて同じ形の失敗応答で拒否される
    expect(
      parseAutocompactReport(
        "Couldn't parse '50000'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
      ),
    ).toBeUndefined();
    expect(
      parseAutocompactReport(
        "Couldn't parse '2000000'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
      ),
    ).toBeUndefined();
    expect(
      parseAutocompactReport(
        "Couldn't parse 'banana'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
      ),
    ).toBeUndefined();
  });

  it('無関係な文言では undefined（読めなければ黙って諦める）', () => {
    expect(parseAutocompactReport('こんにちは')).toBeUndefined();
    expect(parseAutocompactReport('')).toBeUndefined();
    // /recapの自然文要約など、他の<synthetic>応答を誤検出しないことも確かめる
    expect(
      parseAutocompactReport('1+1を聞かれ、2と答えた。それだけのやり取りで、進行中の作業はない。'),
    ).toBeUndefined();
  });
});
