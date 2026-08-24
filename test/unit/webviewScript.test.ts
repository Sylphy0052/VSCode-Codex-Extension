import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
import { approvalLevelMeta } from '../../src/provider/approvalLevel';
import { controlPanelScript } from '../../src/view/controlPanelScript';
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

  it('脇道の質問（sideQuestion）の本文もMarkdown描画経路に載る（issue #332×#334、issue #340横断レビュー指摘）', () => {
    // chatScript.tsのuseMarkdown判定はvitestのnode環境では実行できない
    // （実VSCode webviewが無いため。design.md §14.60参照）ため、生成されたソースの
    // 判定条件に'sideQuestion'が含まれることを固定し、回帰（X1のMarkdown描画対象から
    // 脇道の質問が外れる）を検出する。実際に表・ネストしたリスト・引用として描画される
    // ことはdocs/manual-test.mdのU-32で手動確認する
    const source = chatScript('Claude Code', { mode: 'quickPick' });
    expect(source).toContain(
      "(item.kind === 'userMessage' || item.kind === 'agentMessage' || item.kind === 'sideQuestion')",
    );
  });

  it('ワークフローのボタンがメッセージを送る（issue #250）', () => {
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).toContain("el('workflowMenu')");
    expect(source).toContain("type: 'workflowMenu'");
  });

  it('ワークフローのボタンは応答中も無効化しない（issue #250）', () => {
    // 送信中に落とす要素は state.busy を見て disabled を立てている。
    // ワークフローは会話と独立した操作なので、その一覧に入っていないことを確かめる。
    const source = chatScript('Codex', { mode: 'quickPick' });

    expect(source).not.toContain("el('workflowMenu').disabled");
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
      // （design.md §16.40時点で12種）。kindを足すときはこの数字も直すことになり、
      // それは意図した変更として差分に出る。
      expect(allFailureKinds).toHaveLength(12);
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

  it('回数切れかつセッションが生きているタスクにだけ「続ける」を出す（Issue #284）', () => {
    const source = workflowScript();
    expect(source).toContain("'続ける'");
    expect(source).toContain("type: 'continueTask'");
    // 回数切れ以外の失敗や、リロード後（セッションが無い）のタスクには出さない
    expect(source).toContain("task.failure.kind === 'maxReached'");
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
