import { describe, expect, it } from 'vitest';
import {
  CHAT_SKINS,
  DEFAULT_CHAT_SKIN,
  normalizeChatSkin,
  skinBodyClass,
} from '../../src/view/skin';

describe('normalizeChatSkin（issue #1249）', () => {
  it('設定に書ける値はそのまま通す', () => {
    for (const skin of CHAT_SKINS) {
      expect(normalizeChatSkin(skin)).toBe(skin);
    }
  });

  it('未知の値・型違いは既定へ丸める', () => {
    // 設定ファイルは手で書けるため、enumを外れた値や型違いが届きうる
    for (const value of [undefined, null, '', 'neon', 'CYBER', 1, true, {}, []]) {
      expect(normalizeChatSkin(value), String(value)).toBe(DEFAULT_CHAT_SKIN);
    }
  });

  it('既定は cyber', () => {
    expect(DEFAULT_CHAT_SKIN).toBe('cyber');
  });
});

describe('skinBodyClass（issue #1249）', () => {
  it('外装ごとに違うクラス名を返す', () => {
    expect(skinBodyClass('cyber')).toBe('skin-cyber');
    expect(skinBodyClass('plain')).toBe('skin-plain');
  });

  it('設定に書ける値すべてでクラス名が重複しない', () => {
    const names = new Set(CHAT_SKINS.map(skinBodyClass));
    expect(names.size).toBe(CHAT_SKINS.length);
  });
});
