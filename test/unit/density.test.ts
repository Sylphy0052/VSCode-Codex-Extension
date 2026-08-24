import { describe, expect, it } from 'vitest';
import {
  CHAT_DENSITIES,
  DEFAULT_CHAT_DENSITY,
  densityBodyClass,
  normalizeChatDensity,
} from '../../src/view/density';

describe('normalizeChatDensity（issue #718）', () => {
  it('設定に書ける値はそのまま通す', () => {
    for (const density of CHAT_DENSITIES) {
      expect(normalizeChatDensity(density)).toBe(density);
    }
  });

  it('未知の値・型違いは既定へ丸める', () => {
    // 設定ファイルは手で書けるため、enumを外れた値や型違いが届きうる
    for (const value of [undefined, null, '', 'dense', 'COMPACT', 1, true, {}, []]) {
      expect(normalizeChatDensity(value), String(value)).toBe(DEFAULT_CHAT_DENSITY);
    }
  });

  it('既定は comfortable（設定を書いていない利用者の見た目を変えない）', () => {
    expect(DEFAULT_CHAT_DENSITY).toBe('comfortable');
  });
});

describe('densityBodyClass（issue #718）', () => {
  it('密度ごとに違うクラス名を返す', () => {
    expect(densityBodyClass('compact')).toBe('density-compact');
    expect(densityBodyClass('comfortable')).toBe('density-comfortable');
  });

  it('設定に書ける値すべてでクラス名が重複しない', () => {
    const names = new Set(CHAT_DENSITIES.map(densityBodyClass));
    expect(names.size).toBe(CHAT_DENSITIES.length);
  });
});
