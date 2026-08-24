import { describe, expect, it } from 'vitest';
import { chatCsp } from '../../src/view/chatCsp';
import { chatScript } from '../../src/view/chatScript';
import { chatStyles } from '../../src/view/chatStyles';
import { CODE_TOKEN_TYPES } from '../../src/view/highlight';
import { controlPanelStyles } from '../../src/view/controlPanelStyles';
import { progressStyles } from '../../src/view/progressStyles';

/**
 * Webviewのスタイルはテンプレートリテラルの中身で、型検査もlintも効かない。
 * `hidden` を付けたのに display 指定へ負けて出しっぱなしになる事故が二度あったため、
 * 打ち消し規則の有無と、括弧の対応だけは機械的に確かめる。
 */
const hasHiddenReset = (css: string): boolean =>
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);

/** コメントを落とす。セレクタ名はコメント中にも出るため、規則を検査する前に外す。 */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const balanced = (css: string): boolean => {
  const withoutComments = stripComments(css);
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

  it('本文に行間の指定がある（issue #713）', () => {
    const css = chatStyles();
    expect(css).toMatch(/\.body\s*\{[^}]*line-height:/);
  });

  it('本文の行長に上限がある（issue #713）', () => {
    const css = stripComments(chatStyles());
    // 上限値は1箇所（--chat-measure）に持つ
    expect(css).toMatch(/--chat-measure:\s*\d+ch/);
    // 掛ける先は '.body' 直下の文章要素。セレクタの列挙を取り出して中身を確かめる
    // （末尾がどれかに依存すると、要素を1つ足しただけで壊れる）
    const selectors = css.match(
      /((?:\s*\.body > [a-z0-9]+,)+\s*\.body > [a-z0-9]+)\s*\{\s*max-width: var\(--chat-measure\)/,
    );
    expect(selectors, '行長の上限を掛ける規則が見つからない').not.toBeNull();
    for (const selector of ['.body > p', '.body > ul', '.body > blockquote', '.body > hr']) {
      expect(selectors![1]).toContain(selector);
    }
    // Markdownを描画しない設定では '.body' 自身が本文を持つ
    expect(css).toMatch(/\.body\.plain\s*\{\s*max-width: var\(--chat-measure\)/);
  });

  it('表とコードブロックには行長の上限を掛けない（issue #713）', () => {
    // コメントを落としてから見る。セレクタ名はコメント中にも出るため、そのまま
    // 検査すると「コメントに書いた名前」と後続の規則がつながって偽陽性になる
    const css = stripComments(chatStyles());
    // 掛けると横へ伸びられなくなる。表は横スクロールで見せる設計（design.md §14.60）
    expect(css).not.toMatch(/\.md-table-wrap[^{}]*\{[^}]*max-width/);
    expect(css).not.toMatch(/\.md-code[^{}]*\{[^}]*max-width/);
    // 検査そのものが効いていること（規則を見つけられる形になっているか）を対照で示す
    expect(css).toMatch(/\.md-table-wrap[^{}]*\{[^}]*overflow-x/);
    expect(css).toMatch(/\.md-code pre[^{}]*\{[^}]*overflow/);
  });

  it('失敗した実行の見出しをエラー色にする（issue #715）', () => {
    const css = stripComments(chatStyles());
    expect(css).toMatch(/\.item\.status-failed \.head\s*\{[^}]*var\(--vscode-errorForeground\)/);
    expect(css).toMatch(/\.item\.status-running \.head\s*\{[^}]*var\(--vscode-/);
  });

  it('見出しのアイコンとラベルの並びを決めている（issue #714）', () => {
    const css = stripComments(chatStyles());
    // アイコンで子が3つになるため、ラベルを伸ばさないと操作ボタンが右端へ寄らない
    expect(css).toMatch(/\.item \.head \.head-icon\s*\{[^}]*flex: none/);
    expect(css).toMatch(/\.item \.head \.head-label\s*\{[^}]*flex: 1/);
  });

  it('見出しがスクロール中も項目の上端に残る（issue #716）', () => {
    const css = stripComments(chatStyles());
    const head = css.match(/\.item \.head\s*\{([^}]*)\}/);
    expect(head, '.item .head の規則が見つからない').not.toBeNull();
    expect(head![1]).toMatch(/position:\s*sticky/);
    expect(head![1]).toMatch(/top:\s*0/);
    // 塗らないと本文が見出しの下を通り抜けて重なる（body に背景指定が無い）
    expect(head![1]).toMatch(/background-color:\s*var\(--vscode-editor-background/);
  });

  it('貼り付いた見出しが浮き出すメニュー類より前へ出ない（issue #716）', () => {
    const css = stripComments(chatStyles());
    const zOf = (selector: string): number => {
      const rule = css.match(new RegExp(selector.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
      expect(rule, selector + ' の規則が見つからない').not.toBeNull();
      const z = (rule![1] ?? '').match(/z-index:\s*(\d+)/);
      expect(z, selector + ' に z-index が無い').not.toBeNull();
      return Number(z![1]);
    };
    // 見出しに隠されると「一番下へ」もスラッシュコマンド候補も押せなくなる
    expect(zOf('.item .head')).toBeLessThan(zOf('#scrollToBottom'));
    expect(zOf('.item .head')).toBeLessThan(zOf('#commands'));
  });

  it('構文強調の分類すべてに色がある（issue #717）', () => {
    const css = stripComments(chatStyles());
    // plain は地の文なので色を持たない。それ以外は色が無いと分類しただけで終わる
    for (const type of CODE_TOKEN_TYPES) {
      if (type === 'plain') continue;
      expect(css, type + ' の色が無い').toMatch(
        new RegExp('\\.md-code \\.tok-' + type + '\\s*\\{[^}]*color:\\s*var\\(--vscode-'),
      );
    }
  });

  it('状態の色が実行中の見出し色より後に来て上書きする（issue #715）', () => {
    const css = stripComments(chatStyles());
    // 前に置くと .item.running .head（同じ詳細度）に負けて、色が出ない
    expect(css.indexOf('.item.status-running .head')).toBeGreaterThan(
      css.indexOf('.item.running .head'),
    );
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

describe('progressStyles', () => {
  it('hidden属性を打ち消す規則がある（issue #721）', () => {
    expect(hasHiddenReset(progressStyles())).toBe(true);
  });

  it('括弧が対応している', () => {
    expect(balanced(progressStyles())).toBe(true);
  });

  it('色をテーマ変数から取る（ハードコードした色値を増やさない）', () => {
    expect(progressStyles()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
