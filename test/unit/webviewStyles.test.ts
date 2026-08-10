import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
import { chatStyles } from '../../src/view/chatStyles';
import { controlPanelStyles } from '../../src/view/controlPanelStyles';

/**
 * Webviewのスタイルはテンプレートリテラルの中身で、型検査もlintも効かない。
 * `hidden` を付けたのに display 指定へ負けて出しっぱなしになる事故が二度あったため、
 * 打ち消し規則の有無と、括弧の対応だけは機械的に確かめる。
 */
const hasHiddenReset = (css: string): boolean =>
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);

const balanced = (css: string): boolean => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (withoutComments.match(/\{/g) ?? []).length;
  const close = (withoutComments.match(/\}/g) ?? []).length;
  return open === close;
};

describe('chatStyles', () => {
  it('hidden属性を打ち消す規則がある', () => {
    expect(hasHiddenReset(chatStyles())).toBe(true);
  });

  it('括弧が対応している', () => {
    expect(balanced(chatStyles())).toBe(true);
  });

  it('隠す領域はすべてスクリプトから開閉できる', () => {
    // hidden を切り替える対象が消えると、開いたまま／閉じたままになる
    const script = chatScript('Codex');
    for (const id of ['queue', 'loop', 'loopBar', 'settings']) {
      expect(script.includes(id), `${id} を扱う処理が無い`).toBe(true);
    }
  });
});

describe('controlPanelStyles', () => {
  it('hidden属性を打ち消す規則がある', () => {
    expect(hasHiddenReset(controlPanelStyles())).toBe(true);
  });

  it('括弧が対応している', () => {
    expect(balanced(controlPanelStyles())).toBe(true);
  });
});
