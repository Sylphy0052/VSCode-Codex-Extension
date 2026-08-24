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

  it('応答中かどうかを外枠の色で示す規則がある（issue #701）', () => {
    const css = chatStyles();
    // 待機中は青、応答中は赤。色はテーマ変数から取る
    expect(css).toMatch(/body::after\s*\{[^}]*border:[^}]*var\(--vscode-charts-blue\)/);
    expect(css).toMatch(/body\.busy::after\s*\{[^}]*var\(--vscode-charts-red\)/);
    // レイアウトを動かさず、下の要素の操作も妨げない
    expect(css).toMatch(/body::after\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/body::after\s*\{[^}]*pointer-events:\s*none/);
  });

  it('外枠のbusyクラスをスクリプトが付け外しする（issue #701）', () => {
    const script = chatScript('Codex', { mode: 'quickPick' });
    expect(script).toContain("document.body.classList.toggle('busy'");
  });

  it('ツール出力の既定折りたたみ用クラスが定義されている（issue #679）', () => {
    const css = chatStyles();
    expect(css).toContain('.body-fold');
    expect(css).toContain('.body-content');
  });

  it('エージェントの応答に縁取りがある（issue #712）', () => {
    const css = chatStyles();
    // 応答に境界が無いとターンの切れ目が分からない。色はテーマ変数から取る
    expect(css).toMatch(/\.agent \.body\s*\{[^}]*border-left:[^}]*var\(--vscode-/);
  });

  it('応答中の色が応答の縁取りより後に来て上書きする（issue #712）', () => {
    const css = chatStyles();
    // 詳細度でも順序でも .item.running が勝たないと、実行中の合図が消える
    expect(css.indexOf('.item.running .body')).toBeGreaterThan(css.indexOf('.agent .body'));
  });

  it('ターンの切れ目を余白でも示す（issue #712）', () => {
    const css = chatStyles();
    // 自分の発言の手前を空け、同じターンに連なる思考・ツール出力は詰める
    expect(css).toMatch(/\.item\.user\s*\{[^}]*margin-top:/);
    expect(css).toMatch(/\.item\.reasoning,\s*\.item\.tool\s*\{[^}]*margin-bottom:/);
  });
});

describe('controlPanelStyles', () => {
  it('hidden属性を打ち消す規則がある', () => {
    expect(hasHiddenReset(controlPanelStyles())).toBe(true);
  });

  it('括弧が対応している', () => {
    expect(balanced(controlPanelStyles())).toBe(true);
  });

  it('セクションの折りたたみ（details/summary）用のスタイルがある（issue #225）', () => {
    const css = controlPanelStyles();
    expect(css).toContain('.section');
    expect(css).toContain('summary.sectionTitle');
    expect(css).toContain('.sectionLoading');
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
