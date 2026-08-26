import { describe, expect, it } from 'vitest';
import { chatCsp } from '../../src/view/chatCsp';
import { chatScript } from '../../src/view/chatScript';
import { chatStyles } from '../../src/view/chatStyles';
import { CODE_TOKEN_TYPES } from '../../src/view/highlight';
import { controlPanelStyles } from '../../src/view/controlPanelStyles';
import { progressStyles } from '../../src/view/progressStyles';
import { sharedStyles } from '../../src/view/sharedStyles';
import { workflowStyles } from '../../src/view/workflowStyles';

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

/** 画面をまたいで同じことを確かめる検査の対象。画面を足したらここへ足す。 */
const styleSources: ReadonlyArray<readonly [string, () => string]> = [
  ['chatStyles', chatStyles],
  ['controlPanelStyles', controlPanelStyles],
  ['progressStyles', progressStyles],
  ['workflowStyles', workflowStyles],
];

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
    expect(css).toMatch(/\.agent \.body\s*\{[^}]*border-left:[^}]*var\(--(vscode|agent)-/);
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
    // 見出しに隠されると会話ナビゲーションもスラッシュコマンド候補も押せなくなる
    expect(zOf('.item .head')).toBeLessThan(zOf('#conversationNavigation'));
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

  it('表示密度の寸法をカスタムプロパティで持つ（issue #718）', () => {
    const css = stripComments(chatStyles());
    const props = [
      '--chat-turn-gap',
      '--chat-item-gap',
      '--chat-sub-gap',
      '--chat-body-padding',
      '--chat-line-height',
    ];
    const compact = css.match(/body\.density-compact\s*\{([^}]*)\}/);
    expect(compact, 'body.density-compact の規則が見つからない').not.toBeNull();
    // 先頭の改行と字下げで 'body' 単独の規則に限定する（body.density-compact と分ける）
    const body = css.match(/\n {2}body\s*\{([^}]*)\}/);
    expect(body, 'body の規則が見つからない').not.toBeNull();
    for (const prop of props) {
      // comfortable は body 側の既定。compact はその5つを漏れなく上書きする
      expect(body![1] ?? '', prop + ' の既定が body に無い').toContain(prop + ':');
      expect(compact![1] ?? '', prop + ' を compact が上書きしていない').toContain(prop + ':');
    }
  });

  it('密度に関わる寸法を規則へ直接書かない（issue #718）', () => {
    const css = stripComments(chatStyles());
    // 直接書くと、密度を切り替えても片方だけ変わらないという壊れ方をする
    expect(css).toMatch(/\.item\s*\{[^}]*margin-bottom:\s*var\(--chat-item-gap\)/);
    expect(css).toMatch(/\.item\.user\s*\{[^}]*margin-top:\s*var\(--chat-turn-gap\)/);
    expect(css).toMatch(
      /\.item\.reasoning,\s*\.item\.tool\s*\{[^}]*margin-bottom:\s*var\(--chat-sub-gap\)/,
    );
    expect(css).toMatch(/\.body\s*\{[^}]*padding:\s*var\(--chat-body-padding\)/);
    expect(css).toMatch(/\.body\s*\{[^}]*line-height:\s*var\(--chat-line-height\)/);
  });

  it('発言をカードにする（issue #719）', () => {
    const css = stripComments(chatStyles());
    // margin だけを持つ先頭の .item 規則とは別に、囲いの規則がある
    const card = css.match(
      /\.item\s*\{[^}]*border:[^}]*var\(--(vscode|agent)-[^}]*border-radius:[^}]*background-color:[^}]*\}/,
    );
    expect(card, 'カードの規則が見つからない').not.toBeNull();
  });

  it('カードの中で枠が二重にならない（issue #719）', () => {
    const css = stripComments(chatStyles());
    // 内側が自前の囲いを持つと、カードの枠と合わせて二重・三重の線になる
    expect(css).toMatch(/\.item\.agent \.body\s*\{[^}]*border-left:\s*none/);
    expect(css).toMatch(/\.item \.body-fold\s*\{[^}]*border:\s*none/);
  });

  it('カード化しても実行中の合図が残る（issue #719）', () => {
    const css = stripComments(chatStyles());
    // 同じ詳細度（0-3-0）なので、後に来たほうが勝つ。前に置くと動いている項目の線が消える
    expect(css.indexOf('.item.running .body')).toBeGreaterThan(css.indexOf('.item.agent .body'));
  });

  it('貼り付いた見出しの背景をカードに合わせる（issue #719）', () => {
    const css = stripComments(chatStyles());
    // エディタの背景のままだと、カードの中に色の違う帯が浮く
    const heads = [...css.matchAll(/\.item \.head\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(heads.length, '.item .head の規則が見つからない').toBeGreaterThan(0);
    const last = heads[heads.length - 1] ?? '';
    expect(last).toContain('background-color: var(--vscode-editorWidget-background)');
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
    // 読み込み中の表示は issue #745 で .stateBlock / .state-loading へ移した
    expect(css).toContain('.stateBlock');
  });

  it('一覧の状態表示が色以外でも見分けられる（issue #745）', () => {
    const css = stripComments(controlPanelStyles());

    // 0件と取得失敗は形（アイコン）、読み込み中は動き（帯）で示す
    expect(css).toContain('.stateIcon');
    const bar = css.match(/\.stateBar::after \{([^}]*)\}/);
    expect(bar, '.stateBar::after の規則が見つからない').not.toBeNull();
    expect(bar?.[1]).toContain('animation:');
    expect(css).toContain('@keyframes stateBarSlide');

    // 取得失敗の色は descriptionForeground へ落とさない。落とすと0件と同じ色になり、
    // 形と色の2つあった手掛かりが形だけに減る
    const err = css.match(/\.state-error \{([^}]*)\}/);
    expect(err, '.state-error の規則が見つからない').not.toBeNull();
    expect(err?.[1]).toContain('--vscode-errorForeground');
    expect(err?.[1]).not.toContain('descriptionForeground');
  });

  it('セクションごとの空・エラー用スタイルが共通化されている（issue #745）', () => {
    const css = stripComments(controlPanelStyles());

    // 母数は、セクションごとに同じ内容を書き写していた旧いクラス名。
    // 先に検査が実在のクラス名を拾えることを確かめてから0件を主張する
    const legacy = /\.\w+(Empty|Error) *[,{]/;
    expect(legacy.test('.mcpEmpty, .mcpError {'), '検査の正規表現が旧いクラス名を拾えない').toBe(
      true,
    );
    expect(css).not.toMatch(legacy);

    // 警告（--vscode-charts-yellow）はこの置き換えの対象外。巻き込んで消していないこと
    expect(css).toContain('.hooksWarning');
    expect(css).toContain('.skillsWarning');
    expect(css).toContain('.pluginsWarning');
  });

  it('再試行ボタンが全幅のボタン指定を引き継がない（issue #745）', () => {
    const css = stripComments(controlPanelStyles());
    // 全体の button は width: 100%。一覧の中に置く小さいボタンは文字幅へ戻す
    const retry = css.match(/\.stateRetry \{([^}]*)\}/);
    expect(retry, '.stateRetry の規則が見つからない').not.toBeNull();
    expect(retry?.[1]).toContain('width: auto');
  });

  it('セクション見出しのアイコンが三角マーカーを潰さない（issue #739）', () => {
    const css = stripComments(controlPanelStyles());
    const icon = css.match(/\.sectionIcon \{([^}]*)\}/);
    expect(icon, '.sectionIcon の規則が見つからない').not.toBeNull();
    // summary の display を変えると ::marker（折りたたみの三角）が消える。
    // アイコン側をインラインで包むことで、summary の display を既定のまま保つ
    const summary = css.match(/\.section summary\.sectionTitle \{([^}]*)\}/);
    expect(summary, 'summary.sectionTitle の規則が見つからない').not.toBeNull();
    expect(summary?.[1]).not.toMatch(/display:/);
    expect(summary?.[1]).not.toMatch(/list-style/);
    // 色はSVG側の currentColor に任せる。ここで色を指定すると見出しの文字と食い違う
    expect(icon?.[1]).not.toMatch(/color:/);
  });

  it('承認レベルの選択肢に選択中・危険・ホバーの見た目がある（issue #744）', () => {
    const css = stripComments(controlPanelStyles());
    // 選択中は枠と背景で示す。:has が効かない環境でもネイティブのラジオの点が残る
    expect(css).toContain('.levelOption:has(input:checked)');
    // 保護を全て外すレベルは選ぶ前から注意色で縁取る
    const unsafe = css.match(/\.levelOption-unsafe \{([^}]*)\}/);
    expect(unsafe, '.levelOption-unsafe の規則が見つからない').not.toBeNull();
    expect(unsafe?.[1]).toMatch(/border-color:/);
    expect(css).toContain('.levelOption-unsafe:has(input:checked)');
    // キーボードで移動したときに、どの選択肢にいるか分かる
    expect(css).toContain('.levelOption:focus-within');
    expect(css).toContain('.levelOption:hover');
  });

  it('状態を表すバッジすべてに色以外の手掛かりがある（issue #759）', () => {
    // 色だけで分けると、グレースケールやハイコントラストで種別が消える。
    // 「色を指定している状態バッジ」を母数にして、その全部に記号か線種があることを確かめる
    const css = stripComments(controlPanelStyles());
    const colored = new Set<string>();
    const cued = new Set<string>();
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css)) !== null) {
      const selector = (m[1] ?? '').trim();
      const body = m[2] ?? '';
      for (const part of selector.split(',')) {
        const one = part.trim();
        // 状態を表すのは .xxxBadge-yyy の形。土台の .xxxBadge には色を載せていない
        const isStateBadge = /^\.\w+Badge-\w+(::before)?$/.test(one);
        if (!isStateBadge) {
          continue;
        }
        const base = one.replace('::before', '');
        if (one.endsWith('::before') && body.includes('content:')) {
          cued.add(base);
        } else if (body.includes('border-style:')) {
          cued.add(base);
        } else if (body.includes('color:')) {
          colored.add(base);
        }
      }
    }
    // 陽性対照: 母数が空だとこの検査は何も確かめていない
    expect(colored.size).toBeGreaterThan(0);
    expect(cued.size).toBeGreaterThan(0);
    for (const selector of colored) {
      expect(cued.has(selector), `${selector} に色以外の手掛かりが無い`).toBe(true);
    }
  });

  it('一覧のカードすべてにホバー時の背景がある（issue #746）', () => {
    // カードを1種類足したときにホバーだけ付け忘れても見た目では気付けない。
    // 「カードの書式を持つ規則」を母数にして、その全部にホバーがあることを確かめる
    const css = stripComments(controlPanelStyles());
    const cardSelectors = new Set<string>();
    const hoverSelectors = new Set<string>();
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css)) !== null) {
      const selector = (m[1] ?? '').trim();
      const body = m[2] ?? '';
      const isCard = body.includes('padding: 6px 8px') && body.includes('var(--agent-border');
      const isHover = body.includes('var(--vscode-list-hoverBackground)');
      for (const part of selector.split(',')) {
        const one = part.trim();
        if (isCard) {
          cardSelectors.add(one);
        }
        if (isHover && one.endsWith(':hover')) {
          hoverSelectors.add(one.slice(0, -':hover'.length));
        }
      }
    }
    // 陽性対照: どちらかが空だとこの検査は何も確かめていない
    expect(cardSelectors.size).toBeGreaterThan(0);
    expect(hoverSelectors.size).toBeGreaterThan(0);
    for (const selector of cardSelectors) {
      expect(hoverSelectors.has(selector), `${selector} にホバーの規則が無い`).toBe(true);
    }
  });

  it('選択中のタブが背景と2pxの下線で分かる（issue #743）', () => {
    const css = stripComments(controlPanelStyles());
    const selected = css.match(/\.tabs button\[aria-selected='true'\] \{([^}]*)\}/);
    expect(selected, '選択中のタブの規則が見つからない').not.toBeNull();
    expect(selected?.[1]).toMatch(/background-color:[^;]*var\(--vscode-tab-activeBackground/);
    expect(selected?.[1]).toMatch(/color:\s*var\(--vscode-foreground\)/);
    // 非選択側も同じ太さの透明な下線を持たせ、切り替えで高さが動かないようにする
    const base = css.match(/\n\s*\.tabs button \{([^}]*)\}/);
    expect(base, '.tabs button の規則が見つからない').not.toBeNull();
    expect(base?.[1]).toMatch(/border-bottom:\s*2px solid transparent/);
  });

  it('非選択のタブをopacityで薄くしない（issue #743）', () => {
    // opacity は文字だけでなく button:focus のフォーカスリングまで薄くする
    const base = stripComments(controlPanelStyles()).match(/\n\s*\.tabs button \{([^}]*)\}/);
    expect(base, '.tabs button の規則が見つからない').not.toBeNull();
    expect(base?.[1]).not.toMatch(/opacity:/);
    expect(base?.[1]).toMatch(/color:\s*var\(--vscode-descriptionForeground\)/);
  });

  it('タブのhoverが選択中の背景を打ち消さない（issue #743）', () => {
    // 同じ詳細度なら後に来た規則が勝つ。hover が選択中にも当たると選択が見えなくなる
    const css = stripComments(controlPanelStyles());
    expect(css).toContain(".tabs button:not([aria-selected='true']):hover");
  });

  it('使用量バーの太さがワークフロー画面と揃っている（issue #742、issue #757で共通化）', () => {
    // 画面ごとに太さが違うと、同じ意味の表示に見えない。値は sharedStyles が持つので、
    // ここでは「両画面が同じ変数を使っていること」と「その変数が1度だけ定義されること」を見る
    const bar = stripComments(controlPanelStyles()).match(/\n\s*\.bar \{([^}]*)\}/);
    expect(bar, '.bar の規則が見つからない').not.toBeNull();
    expect(bar?.[1]).toMatch(/height:\s*var\(--agent-bar-height\)/);
    expect(bar?.[1]).toMatch(/border-radius:\s*var\(--agent-bar-radius\)/);
    const workflowBar = stripComments(workflowStyles()).match(/\n\s*#progressBar \{([^}]*)\}/);
    expect(workflowBar, '#progressBar の規則が見つからない').not.toBeNull();
    expect(workflowBar?.[1]).toMatch(/height:\s*var\(--agent-bar-height\)/);
    expect(workflowBar?.[1]).toMatch(/border-radius:\s*var\(--agent-bar-radius\)/);
  });

  it('使用量バーのトラックがopacityではなく色で薄くしてある（issue #742）', () => {
    // opacity は子要素にも掛かるうえ、ハイコントラストテーマで背景と同化する
    const css = stripComments(controlPanelStyles());
    const bar = css.match(/\n\s*\.bar \{([^}]*)\}/);
    expect(bar, '.bar の規則が見つからない').not.toBeNull();
    expect(bar?.[1]).not.toMatch(/opacity:/);
    // 薄め方の実体は --agent-bar-track（issue #757）。同じCSSの中にある定義まで見る
    expect(bar?.[1]).toMatch(/background-color:\s*var\(--agent-bar-track\)/);
    expect(css).toMatch(/--agent-bar-track:\s*color-mix\(/);
    // ハイコントラストテーマでだけ描かれる輪郭。レイアウトを動かさない outline で出す
    expect(bar?.[1]).toMatch(/outline:[^;]*var\(--vscode-contrastBorder/);
  });

  it('使用量バーの塗りが幅の変化をなめらかにする（issue #742）', () => {
    // 動きを減らす設定では reducedMotionStyles() が止める
    const fill = stripComments(controlPanelStyles()).match(/\.bar \.fill \{([^}]*)\}/);
    expect(fill, '.bar .fill の規則が見つからない').not.toBeNull();
    expect(fill?.[1]).toMatch(/transition:\s*width/);
    expect(fill?.[1]).not.toMatch(/opacity:/);
  });

  it('使用量の内訳が.hintより読みやすい（issue #742）', () => {
    const meta = stripComments(controlPanelStyles()).match(/\.usage-meta \{([^}]*)\}/);
    expect(meta, '.usage-meta の規則が見つからない').not.toBeNull();
    // 中身が空でも高さを保ち、値が入ったときに下の要素が動かないようにする
    expect(meta?.[1]).toMatch(/min-height:/);
    expect(meta?.[1]).toMatch(/var\(--vscode-foreground\)/);
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

/**
 * 枠線のフォールバック（issue #758）。
 *
 * `--vscode-widget-border` はすべてのテーマが定義しているわけではない。未定義のテーマで
 * `transparent` へ落とすと、枠は描かれないのに幅だけが残り、カード・セクション・タブの
 * 区切りが消える。フォールバック先には実在する変数を置くこと。
 */
describe('枠線のフォールバック（issue #758）', () => {
  for (const [name, build] of styleSources) {
    it(`${name}: --vscode-widget-border を transparent へ落とさない`, () => {
      const css = build();
      // 変数を使っていないスタイルで素通りしないよう、拾えること自体を先に確かめる
      expect(css, '検査対象の変数が使われていない').toContain('--vscode-widget-border');
      expect(css).not.toContain('--vscode-widget-border, transparent');
    });
  }
});

/**
 * 画面をまたぐ共通のスタイル（issue #757）。
 *
 * 4画面が同じ意味の要素を別々の値で書いていたため、寸法と枠線をカスタムプロパティへ
 * 集約した。集約が効いているかは「各画面の出力に定義が入っていること」と「各画面が
 * 生の値ではなく変数を使っていること」の2点で見る。
 */
describe('共通スタイル（issue #757）', () => {
  const TOKENS = [
    '--agent-radius-sm',
    '--agent-radius-md',
    '--agent-radius-lg',
    '--agent-radius-pill',
    '--agent-bar-height',
    '--agent-bar-radius',
    '--agent-bar-track',
    '--agent-border',
  ];

  it('共通スタイルがトークンを定義する', () => {
    const css = sharedStyles();
    for (const token of TOKENS) {
      expect(css, `${token} の定義が無い`).toMatch(new RegExp(`${token}:`));
    }
  });

  it('共通スタイルが hidden の打ち消しを持つ', () => {
    // 各画面から重複を消したので、ここが唯一の定義になった
    expect(hasHiddenReset(sharedStyles())).toBe(true);
  });

  for (const [name, build] of styleSources) {
    it(`${name}: 共通スタイルを連結している`, () => {
      const css = build();
      for (const token of TOKENS) {
        expect(css, `${token} の定義が届いていない`).toMatch(new RegExp(`${token}:`));
      }
    });

    it(`${name}: 角丸を生の値で書かない`, () => {
      const css = stripComments(build());
      // 陽性対照: そもそも角丸の指定を拾えているか（拾えていないと0件で素通りする）
      expect(css, '角丸の指定が見つからない').toMatch(/border-radius:/);
      // 0 と 50% は寸法ではなく形の指定なので対象外
      const literals = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
        .map((m) => (m[1] ?? '').trim())
        .filter((value) => value !== '0' && value !== '50%' && !value.startsWith('var('));
      expect(literals).toEqual([]);
    });
  }
});

/**
 * 動きを減らす設定への追随（issue #760）。
 *
 * 抑制はアニメーションを名指しせず全称セレクタで掛ける。名指しにすると、後から足した
 * アニメーションが漏れたまま誰にも気付かれない。
 */
describe('prefers-reduced-motion（issue #760）', () => {
  for (const [name, build] of styleSources) {
    it(`${name}: 動きを減らす設定で抑制する規則がある`, () => {
      const css = build();
      const rule = css.match(
        /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/,
      );
      expect(rule, '抑制の規則が見つからない').not.toBeNull();
      // 全称セレクタは詳細度0で、個別の規則にはまず負ける。1つでも !important が
      // 欠けるとそのプロパティだけ抑制が効かないため、値まで含めて見る
      for (const property of [
        'animation-duration',
        'animation-iteration-count',
        'transition-duration',
        'scroll-behavior',
      ]) {
        expect(rule![1], `${property} に !important が無い`).toMatch(
          new RegExp(`${property}:[^;]*!important`),
        );
      }
    });
  }
});
