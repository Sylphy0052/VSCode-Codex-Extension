import { describe, expect, it } from 'vitest';
import { progressStyles } from '../../src/view/progressStyles';

/**
 * 進捗画面のスタイル（`src/view/progressStyles.ts`）はテンプレートリテラルの文字列で、
 * tscにもESLintにも検査されない。ここでは崩れると見た目が黙って壊れる規則だけを押さえる。
 */
describe('progressStyles（issue #748）', () => {
  const css = progressStyles();

  it('チェックリストの行はアイコンを1行目に留める（baselineではない）', () => {
    // 陽性対照: `.todo`の規則自体はこの文字列の中にある（空振りで通る検査ではない）
    expect(css).toContain('.todo {');
    expect(css).toContain('.todo { display: flex; gap: 6px; align-items: flex-start; }');
    expect(css).not.toContain('.todo { display: flex; gap: 6px; align-items: baseline; }');
  });

  it('チェックリストの印は縮まず、1行目の中央へ寄せる', () => {
    const mark = css.slice(css.indexOf('.todo .mark {'));
    expect(mark).toContain('flex: none;');
    expect(mark.slice(0, mark.indexOf('}'))).toContain('margin-top: 0.2em;');
  });
});
