import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
import { approvalLevelMeta } from '../../src/provider/approvalLevel';
import { controlPanelScript } from '../../src/view/controlPanelScript';
import { progressScript } from '../../src/view/progressScript';
import { progressStyles } from '../../src/view/progressStyles';
import { workflowScript } from '../../src/view/workflowScript';
import { workflowStyles } from '../../src/view/workflowStyles';

/**
 * Webviewのスクリプトはテンプレートリテラルの中身で、型検査もlintも効かない。
 * 壊れると画面が黙って動かなくなるため、構文だけは機械的に確かめる。
 *
 * `new Function` は本体を実行せず構文解析だけ行うので、`acquireVsCodeApi` などの
 * ブラウザ側APIが無い環境でも検査できる。
 */
const parses = (source: string): void => {
  new Function(source);
};

describe('chatScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(chatScript('Codex', { mode: 'quickPick' }))).not.toThrow();
  });

  it('承認レベルのメタを注入してもスクリプトが壊れず、両プロバイダで同じ語彙になる', () => {
    const meta = JSON.stringify(approvalLevelMeta());
    for (const provider of ['codex', 'claude'] as const) {
      const source = chatScript(
        'Codex',
        { mode: 'quickPick' },
        false,
        ['ask', 'auto'],
        false,
        true,
        'ctrlEnter',
        meta,
        provider,
      );
      expect(() => parses(source)).not.toThrow();
      expect(source).toContain('全確認');
      // Shift+Tabは3段階を回す。生の承認方法を直接送る経路は残っていない
      expect(source).toContain("type: 'approvalLevel'");
      expect(source).not.toContain("type: 'config', key: 'approvalMode'");
    }
  });

  it('プロバイダ名を差し替えても壊れない', () => {
    expect(() =>
      parses(chatScript('Claude Code', { mode: 'command', commandName: 'code-review' })),
    ).not.toThrow();
  });

  it('showRewindを立てても構文として成立している（Claude Code画面のみ使う）', () => {
    expect(() =>
      parses(chatScript('Claude Code', { mode: 'command', commandName: 'code-review' }, true)),
    ).not.toThrow();
  });

  it('外周の枠色は、バックグラウンドターミナルとセカンドオピニオンのどちらでも黄になる（Issue #905）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    // 枠色の判定は1か所（applyBackgroundRunning）に集約し、状態更新とメッセージ受信の
    // 両方から呼ぶ。片方だけでクラスを付け外しすると、次の状態更新で消える
    expect(source).toContain('function applyBackgroundRunning(busy)');
    expect(source).toContain('!busy && (hasBackgroundTerminals || secondOpinionRunning)');
    expect(source).toContain('secondOpinionRunning = data.running;');
    // 状態更新側も同じ関数を通る（旧実装のように条件式を直接書かない）
    expect(source).toContain('applyBackgroundRunning(!!state.busy);');
    expect(source).not.toContain("'background-running',\n      !state.busy &&");
  });

  it('showRewindを省略すると巻き戻しボタンを出さない（既定はfalse）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('SHOW_REWIND = false');
  });

  it('showRewindを立てるとその値が埋め込まれる', () => {
    const source = chatScript('Claude Code', { mode: 'command', commandName: 'code-review' }, true);
    expect(source).toContain('SHOW_REWIND = true');
    expect(source).toContain("type: 'rewind'");
  });

  it('showTurnForkを省略すると既定でfalseが埋め込まれる（issue #333、design.md §14.61）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('SHOW_TURN_FORK = false');
  });

  it('showTurnForkを立ててもスクリプトが構文として成立している', () => {
    expect(() =>
      parses(
        chatScript(
          'Claude Code',
          { mode: 'command', commandName: 'code-review' },
          true,
          [],
          false,
          true,
          'ctrlEnter',
          '{}',
          'claude',
          true,
        ),
      ),
    ).not.toThrow();
  });

  it('showTurnForkを立てるとその値が埋め込まれ、分岐ボタンの対象が発言自身のidになる', () => {
    const source = chatScript(
      'Claude Code',
      { mode: 'command', commandName: 'code-review' },
      true,
      [],
      false,
      true,
      'ctrlEnter',
      '{}',
      'claude',
      true,
    );
    expect(source).toContain('SHOW_TURN_FORK = true');
    // Codex画面は「直前の発言」を対象にするが、Claude Code画面は「押した発言自身」を
    // 対象にする（`rewind_conversation`の向きがCodexの`thread/fork`と逆のため）
    expect(source).toContain('return SHOW_TURN_FORK ? item.id : previousTurnId');
    expect(source).toContain("type: 'fork', turnId: node.forkTarget");
  });

  it('脇道の質問（sideQuestion）とセカンドオピニオン（Issue #894）の本文もMarkdown描画経路に載る（issue #332×#334、issue #340横断レビュー指摘）', () => {
    // chatScript.tsのuseMarkdown判定はvitestのnode環境では実行できない
    // （実VSCode webviewが無いため。design.md §14.60参照）ため、生成されたソースの
    // 判定条件に'sideQuestion'が含まれることを固定し、回帰（X1のMarkdown描画対象から
    // 脇道の質問が外れる）を検出する。実際に表・ネストしたリスト・引用として描画される
    // ことはdocs/manual-test.mdのU-32で手動確認する
    const source = chatScript('Claude Code', { mode: 'quickPick' });
    expect(source).toContain(
      [
        "(item.kind === 'userMessage' ||",
        "        item.kind === 'agentMessage' ||",
        "        item.kind === 'sideQuestion' ||",
        "        item.kind === 'secondOpinion')",
      ].join('\n'),
    );
  });

  it('ワークフロー・カンバン・進捗・引き継ぎのボタンがメッセージを送る', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    for (const id of [
      'workflowMenu',
      'teamWorkflow',
      'workflowView',
      'sessionKanban',
      'openProgress',
      'handoffToNewSession',
    ]) {
      expect(source).toContain(`el('${id}')`);
      expect(source).toContain(`type: '${id}'`);
    }
  });

  it('ワークフローのボタンは応答中も無効化しない（issue #250）', () => {
    // 送信中に落とす要素は state.busy を見て disabled を立てている。
    // ワークフローは会話と独立した操作なので、その一覧に入っていないことを確かめる。
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).not.toContain("el('workflowMenu').disabled");
  });

  it('三点メニューは表示可能な側へ開き、表示可能な高さでスクロールする', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).toContain('function positionOverflowMenu()');
    expect(source).toContain('const above = Math.max(0, rect.top - gap)');
    expect(source).toContain('const below = Math.max(0, window.innerHeight - rect.bottom - gap)');
    expect(source).toContain('composerOverflowMenu.style.maxHeight');
  });

  it('showInputModeHintsを省略すると !/# の案内を出さない（既定はfalse、issue #5/#6）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('SHOW_INPUT_MODE_HINTS = false');
  });

  it('showInputModeHintsを立てるとその値が埋め込まれる（Claude Code画面のみ使う）', () => {
    const source = chatScript(
      'Claude Code',
      { mode: 'command', commandName: 'code-review' },
      true,
      [],
      true,
    );
    expect(() => parses(source)).not.toThrow();
    expect(source).toContain('SHOW_INPUT_MODE_HINTS = true');
    expect(source).toContain('inputModeHint');
  });

  it('文字列リテラルが改行で分断されていない', () => {
    // テンプレートリテラル内に `\n` と書くと実際の改行に展開され、
    // 文字列リテラルが途中で切れて構文エラーになる。
    const lines = chatScript('Codex', { mode: 'quickPick' }).split('\n');
    const broken = lines.filter((line) => (line.match(/'/g)?.length ?? 0) % 2 === 1);
    expect(broken).toEqual([]);
  });

  it('テンプレートリテラルを閉じる文字が混ざっていない', () => {
    // スクリプトはテンプレートリテラルの中身。バッククォートや ${ } の展開が
    // 紛れ込むと、そこでリテラルが切れて別物になる
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source.includes('`')).toBe(false);
    expect(/\$\{/.test(source)).toBe(false);
  });

  it('Web検索結果のクリックはホストへopenUrlを送るだけで、動的な文字列をHTMLへ組み込まない（issue #18）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain("type: 'openUrl'");
    // タイトル・URLはtextContentで入れる（innerHTML系を使うとHTMLとして解釈されうる）
    expect(source.includes('innerHTML')).toBe(false);
    expect(source.includes('outerHTML')).toBe(false);
    expect(source.includes('insertAdjacentHTML')).toBe(false);
  });

  it('追加クレジット（issue #204）: 上限到達時にフッターから/usage-creditsを送る導線を含む', () => {
    const source = chatScript('Claude Code', { mode: 'command', commandName: 'code-review' });
    expect(source).toContain('usageCreditsLimited');
    expect(source).toContain('formatExtraUsage');
    expect(source).toContain("type: 'usageCreditsRequest'");
  });

  it('デバッグログ（issue #205）: 設定行の導線がopenDebugLog/debugCommandを送る', () => {
    const source = chatScript('Claude Code', { mode: 'command', commandName: 'code-review' });
    expect(source).toContain("type: 'openDebugLog'");
    expect(source).toContain("type: 'debugCommand'");
  });

  it('sendOnを省略すると既定のctrlEnterが埋め込まれる（issue #288）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('SEND_ON = "ctrlEnter"');
  });

  it('sendOnを指定するとその値が埋め込まれる（issue #288）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' }, false, [], false, true, 'enter');
    expect(() => parses(source)).not.toThrow();
    expect(source).toContain('SEND_ON = "enter"');
  });

  it('IME変換の追跡とdecideSendKeyActionの呼び出しを配線している（issue #288）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('compositionstart');
    expect(source).toContain('compositionend');
    expect(source).toContain('decideSendKeyAction(');
  });

  it('入力欄の履歴移動はキャレットが端にあるときだけ発火する（issue #698）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(() => parses(source)).not.toThrow();
    // 行頭ではなく入力全体の先頭・末尾で判定する（1行目の途中で押しても履歴へ飛ばない）
    expect(source).toContain('function atInputStart(input)');
    expect(source).toContain('function atInputEnd(input)');
    expect(source).toContain('input.selectionStart === 0 && input.selectionEnd === 0');
    // 行単位の旧判定は残さない（残ると列位置を見ない経路が復活する）
    expect(source).not.toContain('atFirstLine');
    expect(source).not.toContain('atLastLine');
    // 連続で押している間はキャレットが末尾でも履歴をたどり続ける
    expect(source).toContain('navigable || atInputStart(input)');
    expect(source).toContain('navigable || atInputEnd(input)');
    expect(source).toContain('historyNavigating = true');
  });

  it('セッション累計のトークン数（issue #294）: state.sessionTokensがフッターへ出る配線がある', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    expect(source).toContain('formatSessionTokens');
    expect(source).toContain('state.sessionTokens');
    // 値が数値で届いていない間は枠ごと出さない（0や-を出さない。受入基準）
    expect(source).toContain("typeof tokens !== 'number'");
  });

  it('セッション累計のトークン数: Claude Codeのコスト表示（formatSessionCost）と共存する', () => {
    // 既存のコスト表示のロジックを壊していないことを、両方の関数が揃って残っていることで
    // 機械的に確かめる（issue #294のやらないこと「コスト表示を作り変えない」）
    const source = chatScript('Claude Code', { mode: 'command', commandName: 'code-review' });
    expect(source).toContain('function formatSessionCost(cost)');
    expect(source).toContain('function formatSessionTokens(tokens)');
  });

  it(
    'LOOP_STOP_LABELはLoopStopReasonの全メンバーを網羅している' +
      '（画面に生の識別子が出た再発防止。`src/loop/loopController.ts`の`LoopStopReason`を' +
      '真として読み取り、そこに理由を足してchatScript.tsのLOOP_STOP_LABELを足し忘れると' +
      'このテストが落ちる）',
    () => {
      const loopControllerSource = readFileSync(
        path.resolve(__dirname, '../../src/loop/loopController.ts'),
        'utf8',
      );
      const typeStart = loopControllerSource.indexOf('export type LoopStopReason =');
      expect(typeStart).toBeGreaterThan(0);
      const typeEndOffset = loopControllerSource.indexOf(';', typeStart);
      expect(typeEndOffset).toBeGreaterThan(typeStart);
      const typeBody = loopControllerSource.slice(typeStart, typeEndOffset);

      // 値ごとにJSDocコメントが挟まる複数行のstring literal union。コメント本文にも
      // 他の値の名前（例: `stalled`の説明中に出てくる`taskStopped`）が登場するため、
      // 行頭が`| '...'`の形になっている行だけを拾う（コメント行は`|`から始まらない）
      const allStopReasons = [...typeBody.matchAll(/^\s*\|\s*'(\w+)'/gm)].map((m) => m[1]);
      // 範囲・抽出に失敗すると0件になりうる。0件だと後続のSet同士のtoEqualが
      // 空集合同士で素通りしてしまうため、ここで空でないことを先に固定する
      expect(allStopReasons.length).toBeGreaterThan(0);

      const source = chatScript('Codex', { mode: 'quickPick' });
      const labelMatch = source.match(/const LOOP_STOP_LABEL = \{([\s\S]*?)\n {2}\};/);
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(new Set(labelKeys)).toEqual(new Set(allStopReasons));
    },
  );

  it(
    'KIND_LABELとKIND_TITLEが同じ語彙を持つ' +
      '（appserver/transcriptMarkdown.tsのJSDocが「chatScript.tsのKIND_LABELと語彙を' +
      '揃えてある」と書いているが、実際にずれてMarkdown書き出しの見出しが英語の' +
      '識別子になっていた）',
    () => {
      // この2つは片方が型で、もう片方が実装という関係ではない。どちらも手書きの
      // 辞書で、ChatItem.kindはstring型（未知の種類も捨てない方針）のため
      // 突き合わせる相手の型が無い。片方に足してもう片方に足し忘れる事故だけを
      // 捕まえる
      const markdownSource = readFileSync(
        path.resolve(__dirname, '../../src/appserver/transcriptMarkdown.ts'),
        'utf8',
      );
      const titleStart = markdownSource.indexOf('const KIND_TITLE');
      expect(titleStart).toBeGreaterThan(0);
      const titleEnd = markdownSource.indexOf('};', titleStart);
      expect(titleEnd).toBeGreaterThan(titleStart);
      const titleBody = markdownSource.slice(titleStart, titleEnd);
      const titleKeys = [...titleBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(titleKeys.length).toBeGreaterThan(0);

      const source = chatScript('Codex', { mode: 'quickPick' });
      const labelMatch = source.match(/const KIND_LABEL = \{([\s\S]*?)\n {2}\};/);
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(labelKeys.length).toBeGreaterThan(0);

      // agentMessageだけはKIND_TITLE側に無い。見出しが呼び出し側の渡すagentLabel
      // （Codex / Claude Code）で決まるためで、意図的な除外（transcriptMarkdown.tsの
      // JSDocに明記されている）
      expect(new Set(labelKeys)).toEqual(new Set([...titleKeys, 'agentMessage']));
    },
  );

  it(
    'createDiff内のkindLabelはFileDiffKindの全値を網羅している' +
      '（テンプレートリテラルの中にあり型検査が届かない。フォールバック（|| diff.kind）が' +
      '効くため、キーを足し忘れても緑のまま画面に生の識別子が出る。Issue #668）',
    () => {
      const chatStateSource = readFileSync(
        path.resolve(__dirname, '../../src/appserver/chatState.ts'),
        'utf8',
      );
      const typeStart = chatStateSource.indexOf('export type FileDiffKind =');
      expect(typeStart).toBeGreaterThan(0);
      // 1行で書かれたstring literal union。LOOP_STOP_LABELテストの
      // /^\s*\|\s*'(\w+)'/gm（行頭が | の行だけを拾う）をこの型へ掛けると0件になる
      // （実測済み）。宣言行だけを範囲にして、行頭を要求せずに拾う
      const declLineEnd = chatStateSource.indexOf('\n', typeStart);
      expect(declLineEnd).toBeGreaterThan(typeStart);
      const typeBody = chatStateSource.slice(typeStart, declLineEnd);
      const allDiffKinds = [...typeBody.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      // 抽出に失敗すると0件になり、後続のSet同士のtoEqualが空集合同士で素通りする
      expect(allDiffKinds.length).toBeGreaterThan(0);

      const source = chatScript('Codex', { mode: 'quickPick' });
      const labelMatch = source.match(/const kindLabel = \{([^}]*)\}/);
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      // こちらも1行に3キーが並ぶ。他の表と同じ /^\s*(\w+):/gm を掛けると先頭の1件しか
      // 拾えない（実測済み）
      const labelKeys = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
      expect(labelKeys.length).toBeGreaterThan(0);
      expect(new Set(labelKeys)).toEqual(new Set(allDiffKinds));
    },
  );

  describe('ツール出力の既定折りたたみ（issue #679）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    it('構文として成立している', () => {
      expect(() => parses(source)).not.toThrow();
    });

    it('対象8kindがFOLD_KINDSに揃っている', () => {
      const match = source.match(/const FOLD_KINDS = new Set\(\[([\s\S]*?)\]\);/);
      expect(match).not.toBeNull();
      const body = match?.[1] ?? '';
      const kinds = [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      expect(new Set(kinds)).toEqual(
        new Set([
          'commandExecution',
          'reasoning',
          'mcpToolCall',
          'subAgentActivity',
          'collabAgentToolCall',
          'autoApprovalReview',
          'fileRead',
          'skillContext',
        ]),
      );
    });

    it('fold対象は<details>要素として生成される', () => {
      expect(source).toContain("body = document.createElement('details')");
      expect(source).toContain("body.className = 'body-fold'");
      expect(source).toContain("bodySummary = document.createElement('summary')");
    });

    it('20行超で末尾だけ表示する旧ロジック（MAX_VISIBLE_LINES）は無い', () => {
      expect(source).not.toContain('MAX_VISIBLE_LINES');
    });

    it('展開ボタン（expand）は無く、<details>標準の開閉に統一されている', () => {
      expect(source).not.toContain('expand.addEventListener');
      expect(source).not.toContain('node.expand');
    });

    it('summary文言は行数、reasoningは要約文で組み立てる', () => {
      expect(source).toContain('出力を表示');
      expect(source).toContain('summaryLabel = text');
    });

    it('コピーは畳んだ状態でも全文（node.fullText）を対象にする', () => {
      expect(source).toContain('node.fullText');
    });
  });

  describe('本文の行長（issue #713）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    it('生テキストで出す本文に plain クラスを付ける', () => {
      // CSSは本文が '.body' 自身に載っているかを見分けられない。renderBody が印を付ける
      const body = source.slice(source.indexOf('function renderBody'));
      expect(body).toContain("node.body.classList.toggle('plain', !useMarkdown)");
    });
  });

  describe('ツール実行の成否の色分け（issue #715）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    /** `const <name> = { ... }` のキーを取り出す。 */
    const keysOf = (name: string): string[] => {
      const start = source.indexOf(`const ${name} = {`);
      expect(start, `${name} が見つからない`).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf('};', start));
      return [...block.matchAll(/^\s+([A-Za-z]+):/gmu)].map((m) => m[1]!);
    };

    it('見出しへ状態のクラスを付ける', () => {
      const update = source.slice(source.indexOf('function updateNode'));
      expect(update).toContain('STATUS_CLASS[item.status]');
      expect(update).toContain('node.wrap.classList.toggle(name, name === statusClass)');
    });

    it('状態のラベルと色の割り当てが食い違っていない', () => {
      // ラベルを足したのに色を割り当て忘れる、を防ぐ。成否でない5つだけが対象外
      // （cancelled は利用者が止めた結果であり失敗ではない。Issue #940。
      // note はAdvisorが指摘なしで終わった周にも付くため、色を当てると blocker が埋もれる。
      // issue #1009）
      const uncolored = ['completed', 'approved', 'interacted', 'cancelled', 'note'];
      const expected = keysOf('STATUS_LABEL').filter((key) => !uncolored.includes(key));
      expect(keysOf('STATUS_CLASS').sort()).toEqual(expected.sort());
    });

    it('付け外しの対象がクラス名の一覧と一致する', () => {
      // 一覧から漏れたクラスは、状態が変わっても消えずに残る
      const names = new Set([...source.matchAll(/'(status-[a-z]+)'/gu)].map((m) => m[1]!));
      const listed = source.slice(source.indexOf('const STATUS_CLASS_NAMES'));
      for (const name of names) {
        expect(listed.slice(0, listed.indexOf(';'))).toContain(name);
      }
    });
  });

  describe('見出しの種別アイコン（issue #714）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    /** `const <name> = {` から `};` までのキーを取り出す。 */
    const keysOf = (name: string): string[] => {
      const start = source.indexOf(`const ${name} = {`);
      expect(start, `${name} が見つからない`).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf('};', start));
      return [...block.matchAll(/^\s+([A-Za-z]+):/gmu)].map((m) => m[1]!);
    };

    it('見出しの先頭へアイコンを差し込む', () => {
      const create = source.slice(source.indexOf('function createNode'));
      expect(create).toContain('createKindIcon(kindClass)');
      expect(create).toContain("iconWrap.className = 'head-icon'");
      // 操作ボタンを右端へ押し付けるため、ラベル側にもクラスが要る
      expect(create).toContain("label.className = 'head-label'");
    });

    it('SVGはDOM APIで組み、innerHTMLを使わない', () => {
      // エージェントの出力を扱う画面なので、HTML文字列の流し込み経路を増やさない
      expect(source).toContain("document.createElementNS(SVG_NS, 'svg')");
      expect(source).toContain("document.createElementNS(SVG_NS, 'path')");
      expect(source.includes('innerHTML')).toBe(false);
    });

    it('色を見出しから継ぐ（テーマと状態の色分けに追随する）', () => {
      const icon = source.slice(source.indexOf('function createKindIcon'));
      expect(icon.slice(0, icon.indexOf('\n  }'))).toContain("'stroke', 'currentColor'");
    });

    it('種別の4種すべてに図案がある', () => {
      // CLASS_OF が返す値のどれかに図案が無いと、その種別だけアイコンが出ない
      const classOf = source.slice(source.indexOf('const CLASS_OF = {'));
      const values = new Set(
        [...classOf.slice(0, classOf.indexOf('};')).matchAll(/:\s*'([a-z]+)'/gu)].map((m) => m[1]!),
      );
      expect(values.size).toBeGreaterThan(0);
      expect(keysOf('KIND_ICON_PATHS').sort()).toEqual([...values].sort());
    });
  });

  describe('コードブロックの構文強調（issue #717）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    it('トークナイザを埋め込んでいる', () => {
      // 実装は highlight.ts の HIGHLIGHT_SOURCE。差し込み忘れると highlightCode が未定義になる
      expect(source).toContain('function highlightCode(lang, code)');
    });

    it('分類した断片をspanで包んで組み立てる', () => {
      const create = source.slice(source.indexOf('function createCodeBlock'));
      const body = create.slice(0, create.indexOf('\n  }'));
      expect(body).toContain('highlightCode(token.lang, token.code)');
      expect(body).toContain("span.className = 'tok-' + piece.type");
      // 地の文はspanを作らずテキストノードのまま入れる
      expect(body).toContain('document.createTextNode(piece.value)');
    });

    it('コピー・挿入・開くは着色前のコードを渡す', () => {
      const create = source.slice(source.indexOf('function createCodeBlock'));
      const body = create.slice(0, create.indexOf('\n  }'));
      expect(body).toContain('navigator.clipboard.writeText(token.code)');
      expect(body).toContain("type: 'insertCode', code: token.code");
      expect(body).toContain("type: 'openCodeFile', code: token.code");
      // 組み立てたDOMからコードを読み直す形にすると、着色の切れ目が混ざる余地ができる
      expect(body.includes('code.textContent')).toBe(false);
    });
  });

  describe('AskUserQuestionの選択UI（issue #696）', () => {
    const source = chatScript('Claude Code', { mode: 'command', commandName: 'code-review' });

    it('選択肢に加えて自由記述（その他）の入力欄を出す', () => {
      const field = source.slice(source.indexOf('function buildAskUserQuestionField'));
      expect(field).toContain("otherLabel.textContent = 'その他'");
      expect(field).toContain("other.type = 'text'");
      expect(field).toContain("other.className = 'other'");
    });

    it('その他はmultiSelectに合わせてcheckbox/radioを切り替える', () => {
      expect(source).toContain("otherPick.type = question.multiSelect ? 'checkbox' : 'radio'");
    });

    it('その他が空欄（空白のみを含む）なら回答に数えない（未回答として送信が止まる）', () => {
      const field = source.slice(source.indexOf('function buildAskUserQuestionField'));
      expect(field).toContain('const free = other.value.trim();');
      expect(field).toContain("if (free !== '') picked.push(free);");
    });
  });
});

describe('controlPanelScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(controlPanelScript(JSON.stringify(approvalLevelMeta())))).not.toThrow();
  });

  it('承認レベルのメタを注入してもスクリプトが壊れない', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
    expect(() => parses(source)).not.toThrow();
    // 表示名の定義元は src/provider/approvalLevel.ts。ここへ書き写していないことを、
    // 注入された値が実際に含まれることで確かめる
    expect(source).toContain('全確認');
    expect(source).toContain("type: 'updateApprovalLevel'");
  });

  it('承認レベルをラジオから読み書きする（issue #744）', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
    // <select>のvalue代入ではなく、ラジオのcheckedを立てる形になっていること
    expect(source).toContain('input[type="radio"]');
    expect(source).toContain('input.checked = checked');
    // 「カスタム」という選択肢を足す作りは無くなっている（どれも選ばれていない状態で表す）
    expect(source).not.toContain('カスタム（詳細で個別に指定）');
    expect(source).toContain('承認の詳細で個別に指定されています');
    // プロバイダごとに変わる実効値だけはメタから入れる（HTML側に埋めると片方が嘘になる）
    expect(source).toContain('.levelOption-effective');
    expect(source).toContain('meta.effective[provider]');
  });

  it('一覧の空・取得失敗の表示が共通のヘルパーを通る（issue #745）', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));

    // 母数は、セクションごとに散らばっていた旧い書き方（p.className = 'xxxEmpty' など）。
    // 先に、この正規表現が旧い書き方を拾えることを確かめてから0件を主張する
    const legacy = /className = '\w+(Empty|Error)'/;
    expect(legacy.test("p.className = 'mcpEmpty';"), '検査の正規表現が旧い書き方を拾えない').toBe(
      true,
    );
    expect(source).not.toMatch(legacy);

    // 置き換え先が実際に使われていること（0件になっただけ、を弾く）
    expect(source.match(/appendState\(container, 'empty'/g)?.length ?? 0).toBeGreaterThan(0);
    expect(source.match(/appendError\(container,/g)?.length ?? 0).toBeGreaterThan(0);
    expect(source).toContain("appendState(container, 'loading'");

    // DOMはDOM APIで組む（このリポジトリの方針。innerHTML系は使わない）
    expect(source).toContain('createElementNS');
    expect(source).not.toContain('innerHTML');
  });

  it('取得に失敗した一覧から再試行できる（issue #745）', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
    expect(source).toContain("type: 'retrySection'");

    // どのセクションを読み直すかは SECTION_CONTAINERS から逆引きする。
    // 描画関数へsectionIdを配って回る作りだと、渡し忘れた1つだけ再試行できなくなる
    expect(source).toContain('SECTION_OF_CONTAINER');
    const build = source.match(
      /const SECTION_OF_CONTAINER = \{\};[\s\S]*?SECTION_OF_CONTAINER\[containerId\] = sectionId;/,
    );
    expect(build, 'SECTION_OF_CONTAINER が SECTION_CONTAINERS から導かれていない').not.toBeNull();
    expect(build?.[0]).toContain('SECTION_CONTAINERS[sectionId]');
  });

  it('セクションを開いたときにtoggleSectionをホストへ送る（issue #225）', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
    expect(source).toContain("type: 'toggleSection'");
  });

  it('開閉状態をprovider選択と同じvscode.setStateへ保存する（issue #225）', () => {
    const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
    expect(source).toContain('openSections');
    // setStateは呼び出しごとに丸ごと置き換わるため、providerとopenSectionsを
    // 必ず同時に書く1箇所（saveState）にまとまっていることを確かめる
    expect(source.match(/vscode\.setState\(/g)?.length).toBe(1);
  });

  it(
    'ホストからのopenSectionメッセージを受けてセクションを展開する（issue #227、' +
      'toggleSectionとは逆向きのホスト→webview経路）',
    () => {
      const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
      expect(source).toContain("event.data.type === 'openSection'");
      // 新しく取得ロジックを重複させず、既存のtoggleイベント（details.open代入）へ
      // 合流させる実装になっていることを確かめる
      expect(source).toContain('details.open = true');
    },
  );

  it(
    'importDetailKindLabelはImportItemDetailGroupのkindの全メンバーを網羅している' +
      '（画面に生の識別子が出た再発防止。`src/provider/import.ts`の' +
      '`ImportItemDetailGroup.kind`を真として読み取る）',
    () => {
      const importSource = readFileSync(
        path.resolve(__dirname, '../../src/provider/import.ts'),
        'utf8',
      );
      const interfaceStart = importSource.indexOf('export interface ImportItemDetailGroup');
      expect(interfaceStart).toBeGreaterThan(0);
      // 同じファイルには別のunion（ImportItemType。'AGENTS_MD'など大文字の値）もあるため、
      // ImportItemDetailGroup内のkindプロパティの範囲だけへ絞って抽出する
      const kindStart = importSource.indexOf('kind:', interfaceStart);
      expect(kindStart).toBeGreaterThan(interfaceStart);
      const kindEnd = importSource.indexOf(';', kindStart);
      expect(kindEnd).toBeGreaterThan(kindStart);
      const kindBody = importSource.slice(kindStart, kindEnd);
      const allKinds = [...kindBody.matchAll(/'(\w+)'/g)]
        .map((m) => m[1])
        .filter((k): k is string => k !== undefined);
      expect(allKinds.length).toBeGreaterThan(0);
      // 範囲の切り出しに失敗してImportItemType（大文字の値）が混ざっていないことも確かめる
      for (const kind of allKinds) {
        expect(kind).not.toBe(kind.toUpperCase());
      }

      const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
      const labelMatch = source.match(
        /function importDetailKindLabel\(kind\) \{\s*const labels = \{([\s\S]*?)\n {4}\};/,
      );
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(new Set(labelKeys)).toEqual(new Set(allKinds));
    },
  );

  it(
    'formatProvides内のlabelOfと索き用の固定配列がPluginProvidesのプロパティを網羅している' +
      '（画面に生の識別子・undefinedが出た再発防止。labelOfにフォールバックが無いため、' +
      '固定配列に足してlabelOfへ足し忘れると画面にundefinedが出る。' +
      '`src/provider/plugins.ts`の`PluginProvides`を真として読み取る）',
    () => {
      const pluginsSource = readFileSync(
        path.resolve(__dirname, '../../src/provider/plugins.ts'),
        'utf8',
      );
      const interfaceStart = pluginsSource.indexOf('export interface PluginProvides');
      expect(interfaceStart).toBeGreaterThan(0);
      const interfaceEnd = pluginsSource.indexOf('}', interfaceStart);
      expect(interfaceEnd).toBeGreaterThan(interfaceStart);
      const interfaceBody = pluginsSource.slice(interfaceStart, interfaceEnd);
      const allProps = [...interfaceBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(allProps.length).toBeGreaterThan(0);

      const source = controlPanelScript(JSON.stringify(approvalLevelMeta()));
      const labelOfMatch = source.match(/const labelOf = \{([^}]*)\};/);
      expect(labelOfMatch).not.toBeNull();
      const labelOfKeys = [...(labelOfMatch?.[1] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]);

      const arrayMatch = source.match(/for \(const key of \[([^\]]*)\]\)/);
      expect(arrayMatch).not.toBeNull();
      const arrayKeys = [...(arrayMatch?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);

      expect(new Set(labelOfKeys)).toEqual(new Set(allProps));
      expect(new Set(arrayKeys)).toEqual(new Set(allProps));
    },
  );
});

describe('workflowScript のグラフの現在地表示（issue #753）', () => {
  it('スクロール位置から可視範囲の割合を出す', () => {
    const source = workflowScript();
    // 陽性対照: 帯を引き直す関数がある（綴り違いで空振りしていない）
    expect(source).toContain('function updateGraphViewport()');
    expect(source).toContain("window_.style.left = (wrap.scrollLeft / total) * 100 + '%';");
    expect(source).toContain("window_.style.width = (visible / total) * 100 + '%';");
  });

  it('全体表示のときと横スクロールが無いときは隠す', () => {
    const source = workflowScript();
    expect(source).toContain(
      "zoomMode === 'fit' || total <= 0 || visible <= 0 || total - visible < 1",
    );
    expect(source).toContain('bar.hidden = true;');
  });

  it('スクロールは次のフレームまでまとめる', () => {
    const source = workflowScript();
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain("el('graphWrap').addEventListener('scroll', scheduleGraphViewport);");
    // 二重に予約しない
    expect(source).toContain('if (viewportFrame !== 0) return;');
  });
});

describe('workflowScript のカンバンバッジからの絞り込み（issue #752）', () => {
  it('バッジはボタンで、押下状態を aria-pressed で持つ', () => {
    const source = workflowScript();
    // 陽性対照: バッジを作る関数がある（綴り違いで空振りしていない）
    expect(source).toContain('function kanbanBadge(bucket, count)');
    expect(source).toContain("text(\n      'button',");
    expect(source).toContain("button.setAttribute('aria-pressed'");
    expect(source).toContain("button.type = 'button';");
  });

  it('押すとトグルし、0件のバッジは押せない', () => {
    const source = workflowScript();
    expect(source).toContain('kanbanFilter = kanbanFilter === bucket ? undefined : bucket;');
    expect(source).toContain('button.disabled = count === 0;');
  });

  it('該当しないノードは消さずに淡くする', () => {
    const source = workflowScript();
    expect(source).toContain("' dimmed'");
    expect(workflowStyles()).toContain('.wf-node.dimmed');
  });

  it('バケットの分類はWebview側で振り分け直さない', () => {
    const source = workflowScript();
    // 拡張機能側が付けた kanbanBucket をそのまま使う（Issue #104の再発防止）
    expect(source).toContain('task.kanbanBucket !== kanbanFilter');
    expect(source).not.toContain("state === 'failed' || state === 'blocked'");
  });

  it('絞り込み中のバケットが0件になったら解除する', () => {
    const source = workflowScript();
    expect(source).toContain('kanbanFilter = undefined;');
    expect(source).toContain('!(kanban[kanbanFilter] > 0)');
  });
});

describe('workflowScript の全体進捗バー（issue #754）', () => {
  it('区画の集計は拡張機能側の結果をそのまま当てる', () => {
    const source = workflowScript();
    // 陽性対照: 区画を描く関数がある（綴り違いで空振りしていない）
    expect(source).toContain('function renderProgressBar(progress, segments)');
    // Webview側で状態を数え直さない（Issue #104の再発防止と同じ方針）
    expect(source).toContain('msg.progressSegments');
    expect(source).not.toContain('counts.failed + counts.blocked');
  });

  it('件数が0の区画は隠す', () => {
    const source = workflowScript();
    expect(source).toContain('element.hidden = true;');
    expect(source).toContain("element.style.width = '0%';");
  });

  it('区切り線は2つ目以降の区画にだけ付ける', () => {
    const source = workflowScript();
    // 隣接セレクタだと、件数0で隠した区画も兄弟として残り先頭に線が付く
    expect(source).toContain("(isFirst ? '' : ' divided')");
    expect(workflowStyles()).toContain('#progressBar .fill.divided');
    expect(workflowStyles()).not.toContain('#progressBar .fill + .fill');
  });

  it('完了率の数字は従来どおり出す', () => {
    const source = workflowScript();
    expect(source).toContain("el('progressPercent').textContent = progress.percentDone + '%';");
  });

  it('色を読めなくても内訳が分かるよう読み上げ用の文字を持つ', () => {
    const source = workflowScript();
    expect(source).toContain("setAttribute(\n      'aria-label',");
    expect(source).toContain('SEGMENT_LABEL');
  });
});

describe('workflowStyles', () => {
  // Issue #280: 一覧のバッジはグラフのノード枠と同じ配色を使う。どちらか片方だけ
  // 色を足して図と一覧が食い違う事故を機械的に防ぐ
  it('状態ごとのバッジの色を定義している', () => {
    const styles = workflowStyles();
    for (const state of [
      'running',
      'waitingApproval',
      'waitingReply',
      'blocked',
      'done',
      'merging',
      'failed',
    ]) {
      expect(styles).toContain('.state-pill.state-' + state);
    }
    expect(styles).toContain('--wf-state-color');
  });

  it('オーケストレーター欄のスタイルを定義している（design.md §16.23、Issue #326）', () => {
    const styles = workflowStyles();
    expect(styles).toContain('#orchestrator');
    expect(styles).toContain('.orch-summary');
    expect(styles).toContain('.orch-unread');
  });

  it('辺の強調と矢印の色を定義している（Issue #282）', () => {
    const styles = workflowStyles();
    expect(styles).toContain('.wf-edge.related');
    expect(styles).toContain('.wf-edge.faded');
    expect(styles).toContain('.wf-arrow-head');
  });

  it('バッジの色にグラフのノード枠と同じ変数を使う', () => {
    const styles = workflowStyles();
    for (const color of [
      '--vscode-charts-blue',
      '--vscode-charts-yellow',
      '--vscode-charts-green',
      '--vscode-errorForeground',
    ]) {
      expect(styles).toContain(color);
    }
  });
});

describe('workflowScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(workflowScript())).not.toThrow();
  });

  it('文字列リテラルが改行で分断されていない', () => {
    const lines = workflowScript().split('\n');
    const broken = lines.filter((line) => (line.match(/'/g)?.length ?? 0) % 2 === 1);
    expect(broken).toEqual([]);
  });

  it('テンプレートリテラルを閉じる文字が混ざっていない', () => {
    const source = workflowScript();
    expect(source.includes('`')).toBe(false);
    expect(/\$\{/.test(source)).toBe(false);
  });

  it(
    'FAILURE_LABELはTaskFailureReasonの全kindを網羅している' +
      '（Issue #579横断レビュー指摘。`src/orchestrator/runState.ts`の`TaskFailureReason`を' +
      '真として読み取り、そこにkindを足してworkflowScript.tsのFAILURE_LABELを足し忘れると' +
      'このテストが落ちる。ハードコードの配列と付き合わせる形だと、kindを足す側で配列も' +
      'ラベルも両方忘れたときにすり抜ける（コーディネーターレビュー指摘）ため、' +
      '配列自体を持たずrunState.tsから毎回抽出する）',
    () => {
      const runStateSource = readFileSync(
        path.resolve(__dirname, '../../src/orchestrator/runState.ts'),
        'utf8',
      );
      // `TaskFailureReason`の定義範囲だけを切り出す。同じ`| { readonly kind: '...' }`という
      // 形は`AutoResumeOutcome`など他のdiscriminated unionにも登場するため、範囲を切らずに
      // ファイル全体からkindを拾うと母数が混ざる。
      //
      // **ここに母数の件数を書かない。**以前は「ファイル全体で何件、内訳はいくつといくつ」
      // と書いてあったが、実測と合わなくなっていた（`AutoResumeOutcome`の`resumed`は
      // この正規表現の形をしておらず、そもそも拾われない）。書き写した数字は、型に値が
      // 足されたときにも正規表現が変わったときにも腐る。母数を知りたいときは、この
      // 正規表現を実際にファイル全体へ流して数えること。
      const typeStart = runStateSource.indexOf('export type TaskFailureReason =');
      expect(typeStart).toBeGreaterThan(0);
      const typeEndOffset = runStateSource.indexOf('};', typeStart);
      expect(typeEndOffset).toBeGreaterThan(typeStart);
      const typeBody = runStateSource.slice(typeStart, typeEndOffset);

      const allFailureKinds = [...typeBody.matchAll(/\{ readonly kind: '(\w+)'/g)].map((m) => m[1]);

      // 範囲の切り出しに失敗すると0件になりうる。0件だと後続の検査（forループ・空集合同士の
      // Set一致）が何も検査しないまま素通りしてしまうため、件数そのものを先に主張して固定する
      // （issue #964時点で16種）。kindを足すときはこの数字も直すことになり、
      // それは意図した変更として差分に出る。
      expect(allFailureKinds).toHaveLength(16);
      // 範囲を切らずに拾うと`AutoResumeOutcome`のkindが混ざる。正規表現を緩めて範囲チェックが
      // 効かなくなったときに、これらが入っていないことで検出する。`resumed`だけは現状の
      // 正規表現では拾われない形（この行の一覧に残してあるのは、書き方が揃えられたときに
      // 検査が効くようにするため）。
      const autoResumeOutcomeKinds = [
        'nothingToResume',
        'blockedByOtherFailure',
        'blockedByAllowGate',
        'resumed',
      ];
      for (const kind of autoResumeOutcomeKinds) {
        expect(allFailureKinds).not.toContain(kind);
      }

      const source = workflowScript();
      const failureLabelMatch = source.match(/const FAILURE_LABEL = \{([\s\S]*?)\n {2}\};/);
      expect(failureLabelMatch).not.toBeNull();
      const body = failureLabelMatch?.[1] ?? '';
      for (const kind of allFailureKinds) {
        expect(body).toMatch(new RegExp(`\\b${kind}:\\s*'`));
      }
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(new Set(labelKeys)).toEqual(new Set(allFailureKinds));
    },
  );

  it('オーケストレーター欄が1行の指示を送り、会話を開く導線を持つ（design.md §16.23、Issue #326）', () => {
    const source = workflowScript();
    expect(source).toContain("type: 'orchestratorSend'");
    expect(source).toContain("type: 'orchestratorReveal'");
    expect(source).toContain("el('orchSendBtn')");
    expect(source).toContain("el('orchOpenBtn')");
    // 要約の押下でも会話を開く
    expect(source).toContain("el('orchSummary').addEventListener");
  });

  it('オーケストレーター欄は応答の全文をDOMへ入れず、要約だけをtextContentで挿入する', () => {
    const source = workflowScript();
    expect(source).toContain('orch.lastResponseSummary');
    // 応答本文はスナップショットに無い。名前で参照していないことを機械的に固定する
    expect(source).not.toContain('lastResponseText');
    expect(source).not.toContain('innerHTML');
  });

  it('セッションを開けていないrunでは入力欄と会話を開くを無効にする', () => {
    const source = workflowScript();
    expect(source).toContain('orch.available');
    expect(source).toContain('利用できません');
  });

  it('未読の印を出す（design.md §16.23「人が最後に見てから応答が増えていれば」）', () => {
    const source = workflowScript();
    expect(source).toContain('orch.unreadCount');
    expect(source).toContain("el('orchUnread')");
  });

  it('ask_userの回答待ちを描き、選択ボタンで答えを送る（design.md §16.33、Issue #583）', () => {
    const source = workflowScript();
    expect(source).toContain("el('orchAskUser')");
    expect(source).toContain('snapshot.pendingAskUser');
    expect(source).toContain("type: 'answerAskUser'");
    expect(source).toContain('choiceIndex');
    // 質問文は外部（エージェント）由来の文字列なので、この関数もinnerHTMLは使わない
    expect(source).toContain("text('div', 'orch-ask-user-question', pending.question)");
  });

  it(
    'ask_userの答え済み・配送待ちの間はボタンを出さない（二重回答の防止。design.md §16.33、' +
      'レビュー指摘: busy中の回答が失われる穴の修正）',
    () => {
      const source = workflowScript();
      expect(source).toContain('pending.answered');
    },
  );

  it('グラフの描画幅を拡張機能へ伝える（段の折り返し用）', () => {
    const source = workflowScript();
    expect(source).toContain("type: 'viewport'");
    expect(source).toContain('ResizeObserver');
  });

  it('グラフのズーム操作を配線している（拡大・縮小・全体表示）', () => {
    const source = workflowScript();
    expect(source).toContain("el('graphZoomInBtn')");
    expect(source).toContain("el('graphZoomOutBtn')");
    expect(source).toContain("el('graphZoomFitBtn')");
  });

  it('依存の辺を矢印付きの曲線で描く（Issue #282）', () => {
    const source = workflowScript();
    expect(source).toContain('marker-end');
    expect(source).toContain("svgEl('defs')");
    // 直線ではなくpathのベジェで描く（line要素は状態の記号に使うため残る）
    expect(source).toContain("' C '");
    expect(source).toContain('d: edgePath(');
  });

  it('選択中のタスクに繋がる辺だけを強調する（Issue #282）', () => {
    const source = workflowScript();
    expect(source).toContain("' related'");
    expect(source).toContain("' faded'");
  });

  it('タスク一覧の状態に状態ごとのクラスを付ける（Issue #280）', () => {
    const source = workflowScript();
    expect(source).toContain("'state-pill state-' + task.state");
  });

  it('続きを試せる失敗かつセッションが生きているタスクにだけ「続ける」を出す（Issue #284、#891）', () => {
    const source = workflowScript();
    expect(source).toContain("'続ける'");
    expect(source).toContain("type: 'continueTask'");
    // 続きを試せる失敗（回数切れ・停滞・撤退の申告・Advisorの指摘・時間切れ）に限る。
    // それ以外の失敗や、リロード後（セッションが無い）のタスクには出さない。拡張機能側の
    // 同じ集合は runState.ts の isResumableFailure にあり、両者は揃えて直す
    // （design.md §14.79、issue #957）
    expect(source).toContain(
      "const resumableKinds = ['maxReached', 'stalled', 'escalated', 'advised', 'conflicted', 'timedOut']",
    );
    expect(source).toContain('resumableKinds.includes(task.failure.kind)');
    expect(source).toContain('task.hasLiveSession === true');
  });

  it('マージ解決中バッジは承認待ちとLLM作業中を区別する（Issue #413 PR4）', () => {
    const source = workflowScript();
    // 出し分けの本体（mergeResolutionBadgeLabel）が承認待ちフラグを見ていること
    expect(source).toContain('task.mergeResolutionWaitingApproval');
    expect(source).toContain('マージ解決中（承認待ち）');
    expect(source).toContain("'マージ解決中'");
    // mergeResolutionBadgeLabel(task) の呼び出しは3箇所（SVGバッジ・タイトル属性・
    // テーブルのhint）。関数定義を残したまま特定の呼び出し1箇所だけを固定文字列
    // （'マージ解決中'）へ差し戻す退行は、関数名や文言だけをtoContainで見ていると
    // 検出できない（レビュー指摘）。呼び出し文脈を含む断片で個別に固定する
    expect(source).toContain('badge.textContent = mergeResolutionBadgeLabel(task);');
    expect(source).toContain(
      "(task.mergeResolutionActive ? ' ・ ' + mergeResolutionBadgeLabel(task) : '')",
    );
    expect(source).toContain("text('span', 'hint', '（' + mergeResolutionBadgeLabel(task) + '）')");
    // 出現回数そのものも固定する（関数定義1箇所＋呼び出し3箇所＝4）。上の3つの断片が
    // 同じ1箇所を重複して数えていないことの担保
    const occurrenceCount = (source.match(/mergeResolutionBadgeLabel\(task\)/g) ?? []).length;
    expect(occurrenceCount).toBe(4);
  });

  it('動的な値をHTMLへ文字列結合しない（innerHTML/outerHTMLを使わない）', () => {
    // design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして挿入する」。
    // innerHTML系のAPIを使わないことをここで機械的に固定しておく
    // （実際のDOM組み立てはtextContent/createElement系のみで行う）
    const source = workflowScript();
    expect(source.includes('innerHTML')).toBe(false);
    expect(source.includes('outerHTML')).toBe(false);
    expect(source.includes('insertAdjacentHTML')).toBe(false);
  });

  it(
    'STATE_LABELはTASK_STATESの全状態を網羅している' +
      '（画面に生の識別子が出た再発防止。`src/orchestrator/runState.ts`の`TASK_STATES`を' +
      '真として読み取り、そこに状態を足してworkflowScript.tsのSTATE_LABELを足し忘れると' +
      'このテストが落ちる）',
    () => {
      const runStateSource = readFileSync(
        path.resolve(__dirname, '../../src/orchestrator/runState.ts'),
        'utf8',
      );
      // union型ではなく`as const`の配列リテラルなので、kindの正規表現ではなく
      // 配列要素の抽出になる
      const arrayStart = runStateSource.indexOf('export const TASK_STATES = [');
      expect(arrayStart).toBeGreaterThan(0);
      const arrayEnd = runStateSource.indexOf('] as const;', arrayStart);
      expect(arrayEnd).toBeGreaterThan(arrayStart);
      const arrayBody = runStateSource.slice(arrayStart, arrayEnd);
      const allStates = [...arrayBody.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      expect(allStates.length).toBeGreaterThan(0);

      const source = workflowScript();
      const labelMatch = source.match(/const STATE_LABEL = \{([\s\S]*?)\n {2}\};/);
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(new Set(labelKeys)).toEqual(new Set(allStates));
    },
  );

  it(
    'PROGRAM_SKIP_REASON_LABELはProgramRunSkipReasonの全kindを網羅している' +
      '（画面に生の識別子が出た再発防止。`src/orchestrator/programState.ts`の' +
      '`ProgramRunSkipReason`を真として読み取る）',
    () => {
      const programStateSource = readFileSync(
        path.resolve(__dirname, '../../src/orchestrator/programState.ts'),
        'utf8',
      );
      const typeStart = programStateSource.indexOf('export type ProgramRunSkipReason =');
      expect(typeStart).toBeGreaterThan(0);
      // この型は`readonly`を使わず、さらに2つの選択肢が同じ物理行に並ぶ
      // （`{ kind: 'failedDependency'; failedRunId: string } | { kind: 'haltedByUser' };`）。
      // FAILURE_LABELテストと同じ`{ readonly kind: '...'` という正規表現をこの型に掛けると
      // 0件になる（実測済み）ため`readonly`無しの形を使う。また`indexOf(';', typeStart)`は
      // 選択肢内部のプロパティ（`failedRunId: string`の`;`）に先に当たって範囲が
      // 短く切れてしまうため、宣言行の次の改行までを範囲にする
      const declLineEnd = programStateSource.indexOf('\n', typeStart);
      expect(declLineEnd).toBeGreaterThan(typeStart);
      const typeEndOffset = programStateSource.indexOf('\n', declLineEnd + 1);
      expect(typeEndOffset).toBeGreaterThan(declLineEnd);
      const typeBody = programStateSource.slice(typeStart, typeEndOffset);
      const allSkipReasons = [...typeBody.matchAll(/\{ kind: '(\w+)'/g)].map((m) => m[1]);
      expect(allSkipReasons.length).toBeGreaterThan(0);
      // 範囲の切り出しが効いているかの確認。`haltedByUser`は同じファイルの他の場所
      // （stop処理でのskipReason生成やコメント）にも登場するが、範囲を切らずに拾うと
      // 重複や無関係な一致が混ざる
      expect(allSkipReasons.filter((k) => k === 'haltedByUser')).toHaveLength(1);

      const source = workflowScript();
      const labelMatch = source.match(/const PROGRAM_SKIP_REASON_LABEL = \{([\s\S]*?)\n {2}\};/);
      expect(labelMatch).not.toBeNull();
      const body = labelMatch?.[1] ?? '';
      const labelKeys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
      expect(new Set(labelKeys)).toEqual(new Set(allSkipReasons));
    },
  );
});

describe('会話の一番下へジャンプするボタン', () => {
  it('#logのスクロール位置に応じてボタンのhiddenを切り替え、クリックで最下部へ戻す配線が入っている', () => {
    // 実DOMでのscrollHeight/scrollTop計算はvitestのnode環境では動かせない
    // （実webviewが無いため）。配線がソースに残っていることを固定して回帰を検出する
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).toContain('function isLogNearBottom(log)');
    expect(source).toContain('function updateScrollToBottomVisibility()');
    expect(source).toContain('function updateScrollNavigation()');
    expect(source).toContain("el('log').addEventListener('scroll', updateScrollNavigation)");
    expect(source).toContain("el('scrollToBottom').addEventListener('click'");
    expect(source).toContain('log.scrollTop = log.scrollHeight');
  });

  it('state更新のたびにボタンの表示状態を再計算する（apply内でupdateScrollToBottomVisibilityを呼ぶ）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });
    const applyMatch = source.match(/function apply\(state\) \{[\s\S]*?\n {2}\}/u);
    expect(applyMatch).not.toBeNull();
    expect(applyMatch![0]).toContain('updateScrollToBottomVisibility();');
  });
});

describe('自分の発言間を移動する会話ナビゲーション', () => {
  it('自分の発言だけを前後の移動対象にし、スクロール位置と会話更新でボタンを更新する', () => {
    // 実DOMでのoffsetTopはvitestのnode環境では計算できないため、対象抽出と配線を固定する
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).toContain("querySelectorAll('.item.user')");
    expect(source).toContain('function userMessageTarget(direction)');
    expect(source).toContain("direction === 'previous'");
    expect(source).toContain("el('previousUserMessage').addEventListener('click'");
    expect(source).toContain("el('nextUserMessage').addEventListener('click'");
    expect(source).toContain("scrollToUserMessage('previous')");
    expect(source).toContain("scrollToUserMessage('next')");
    expect(source).toContain('updateUserMessageNavigation();');
    expect(source).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(source).toContain("reducedMotion ? 'auto' : 'smooth'");
  });
});

describe('progressScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(progressScript())).not.toThrow();
  });

  it('本文をHTMLとして組み立てない（issue #721）', () => {
    // 指示・応答・パス・コマンドはエージェントの出力。テキストノードとしてのみ入れる
    const source = progressScript();
    expect(source).not.toContain('innerHTML');
    expect(source).toContain('textContent');
  });

  it('隠す領域をすべて開閉できる（issue #721）', () => {
    const source = progressScript();
    for (const id of ['empty', 'summary', 'checklistSection', 'filesSection', 'timelineSection']) {
      expect(source.includes(id), `${id} を扱う処理が無い`).toBe(true);
    }
  });

  it('アイコンをインラインSVGで作る（issue #781）', () => {
    const source = progressScript();
    // codiconのフォントはvsce package --no-dependenciesで配布物から落ちるため使えない。
    // SVGならCSPを広げずに済む（font-src / img-src を足さない）
    expect(source).toContain('createElementNS');
    expect(source).toContain('http://www.w3.org/2000/svg');
    expect(source).not.toContain('codicon');
  });

  it('KPIのタイルをすべて書き換える（issue #781）', () => {
    const source = progressScript();
    for (const id of ['kpiTurns', 'kpiFiles', 'kpiCommands', 'kpiTodo']) {
      expect(source.includes(id), `${id} を扱う処理が無い`).toBe(true);
    }
    // TODOが無いセッションでは0%の棒を出さずに隠す
    expect(source).toContain('progressRow');
    expect(source).toContain('progressPercent');
  });

  it('変更したファイルをディレクトリごとに出す（issue #749）', () => {
    const source = progressScript();
    // 陽性対照: グループを組み立てる関数がある（綴り違いで空振りしていない）
    expect(source).toContain('function fileGroupRow(group, names)');
    expect(source).toContain('renderFiles(view.summary.editedFileGroups);');
    // 打ち切りはグループ数ではなくファイル数で数える
    expect(source).toContain('FILES_SHOWN - shown');
    expect(source).toContain('残り');
    // 平坦な一覧を作る旧経路は残さない
    expect(source).not.toContain('fillPathList');
  });

  it('ファイル一覧の展開を覚えて再描画で失わない（issue #1013）', () => {
    const source = progressScript();
    // 陽性対照: 展開を覚える入れ物がある（綴り違いで空振りしていない）
    expect(source).toContain('let filesExpanded = false;');
    // 展開後は打ち切らず全件出す
    expect(source).toContain(
      'const room = filesExpanded ? group.files.length : FILES_SHOWN - shown;',
    );
    // ボタンはDOMへ直接足さず、フラグを立てて描き直す（次の状態更新でも保たれる）
    expect(source).toContain('filesExpanded = true;');
    expect(source).toContain('renderFiles(groups);');
    expect(source).not.toContain('button.remove();');
  });

  it('ターンの開閉を覚えて再描画で失わない（issue #750）', () => {
    const source = progressScript();
    // 陽性対照: 開閉を覚える入れ物がある（綴り違いで空振りしていない）
    expect(source).toContain('const turnOpen = {};');
    // 人の操作は summary のクリックで拾う。toggle は描画時の代入でも発火するため使わない
    expect(source).toContain("head.addEventListener('click'");
    expect(source).toContain('turnOpen[turn.index] = !article.open;');
    expect(source).not.toContain("addEventListener('toggle'");
    // 覚えた値は既定（末尾 OPEN_TURNS 件）より優先する
    expect(source).toContain('const remembered = turnOpen[turn.index];');
    expect(source).toContain('remembered === undefined');
  });

  it('畳まれたターンがあるときだけ「開く」を出す（issue #750）', () => {
    const source = progressScript();
    expect(source).toContain('renderExpandAll');
    expect(source).toContain('timelineMore');
    // 閉じているターンが0件なら何も出さない（3件以下のセッションで死んだボタンを見せない）
    expect(source).toContain('if (closed === 0) {');
  });

  it('応答中の最新ターンは既定で開く（issue #750）', () => {
    const source = progressScript();
    expect(source).toContain('isLatest && isBusy');
    expect(source).toContain('isBusy = summary.busy === true;');
  });

  it('応答中は上端の稼働バーを出し、終わると隠す（issue #751）', () => {
    const source = progressScript();
    // 陽性対照: そもそもこの要素を触る処理がある（idの綴り違いで空振りしていない）
    expect(source).toContain('busyBar');
    expect(source).toContain("el('busyBar').hidden = !summary.busy;");
    // 進捗が1件も無い（サマリごと隠す）経路でも消す
    expect(source).toContain("el('busyBar').hidden = true;");
  });

  it('古いターンを畳み、ファイル一覧を打ち切る（issue #781）', () => {
    const source = progressScript();
    expect(source).toContain('OPEN_TURNS');
    expect(source).toContain('FILES_SHOWN');
    // 折りたたみは <details> の open で行う
    expect(source).toContain("node('details'");
    expect(source).toContain('残り');
  });
});

describe('progressStyles', () => {
  it('色をVS Codeのテーマ変数から取る（issue #781）', () => {
    const source = progressStyles();
    // 生の色指定はストライプの透過白のみ。他はテーマ変数に追随させる
    const literals = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals).toEqual([]);
  });

  it('サマリーを上に固定し、下の内容が透けないようにする（issue #781）', () => {
    const source = progressStyles();
    expect(source).toContain('position: sticky');
    expect(source).toContain('--vscode-editor-background');
  });

  it('動きを減らす設定に追随する（issue #760）', () => {
    expect(progressStyles()).toContain('prefers-reduced-motion');
  });

  it('稼働バーはtransformだけで動かす（issue #751）', () => {
    const source = progressStyles();
    const rule = source.slice(source.indexOf('@keyframes busySlide'));
    const body = rule.slice(0, rule.indexOf('}\n'));
    // 陽性対照: keyframesの本体を切り出せている（空文字列に対する検査ではない）
    expect(body).toContain('translateX');
    // width / background-position を毎フレーム変えるとレイアウトと再描画が走る
    expect(body).not.toContain('width');
    expect(body).not.toContain('background-position');
  });

  it('稼働バーは画面上端に固定し、完了率バーと位置で分ける（issue #751）', () => {
    const source = progressStyles();
    const rule = source.slice(source.indexOf('#busyBar {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('position: fixed');
    expect(body).toContain('top: 0');
    // 完了率バーはサマリの中に置いたまま（固定しない）
    const fill = source.slice(source.indexOf('#progressFill {'));
    expect(fill.slice(0, fill.indexOf('}'))).not.toContain('position: fixed');
  });
});
