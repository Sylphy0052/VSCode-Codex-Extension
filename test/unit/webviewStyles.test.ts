import { describe, expect, it } from 'vitest';
import { chatCsp } from '../../src/view/chatCsp';
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
    const script = chatScript('Codex', { mode: 'quickPick' });
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

describe('chatCsp', () => {
  const csp = chatCsp('vscode-resource://x', 'nonce123');

  it('添付のサムネイル（データURL）を許す', () => {
    // default-src 'none' なので、書き忘れると画像が黙って出なくなる
    expect(csp).toContain('img-src data:');
  });

  it('既定は全部塞ぐ', () => {
    expect(csp).toContain("default-src 'none'");
  });

  it('スクリプトはnonce付きだけ許す', () => {
    expect(csp).toContain("script-src 'nonce-nonce123'");
  });

  it('外部の読み込み先を開けない', () => {
    // データURL以外の画像取得（http/https）を許すと、会話の内容が外へ漏れうる
    expect(csp).not.toContain('img-src *');
    expect(csp).not.toMatch(/img-src[^;]*https?:/u);
  });
});
