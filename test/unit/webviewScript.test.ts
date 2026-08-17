import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
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
    const source = chatScript(
      'Codex',
      { mode: 'quickPick' },
      false,
      [],
      false,
      true,
      'enter',
    );
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
});

describe('controlPanelScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(controlPanelScript())).not.toThrow();
  });

  it('セクションを開いたときにtoggleSectionをホストへ送る（issue #225）', () => {
    const source = controlPanelScript();
    expect(source).toContain("type: 'toggleSection'");
  });

  it('開閉状態をprovider選択と同じvscode.setStateへ保存する（issue #225）', () => {
    const source = controlPanelScript();
    expect(source).toContain('openSections');
    // setStateは呼び出しごとに丸ごと置き換わるため、providerとopenSectionsを
    // 必ず同時に書く1箇所（saveState）にまとまっていることを確かめる
    expect(source.match(/vscode\.setState\(/g)?.length).toBe(1);
  });

  it(
    'ホストからのopenSectionメッセージを受けてセクションを展開する（issue #227、' +
      'toggleSectionとは逆向きのホスト→webview経路）',
    () => {
      const source = controlPanelScript();
      expect(source).toContain("event.data.type === 'openSection'");
      // 新しく取得ロジックを重複させず、既存のtoggleイベント（details.open代入）へ
      // 合流させる実装になっていることを確かめる
      expect(source).toContain('details.open = true');
    },
  );
});

describe('workflowStyles', () => {
  // Issue #280: 一覧のバッジはグラフのノード枠と同じ配色を使う。どちらか片方だけ
  // 色を足して図と一覧が食い違う事故を機械的に防ぐ
  it('状態ごとのバッジの色を定義している', () => {
    const styles = workflowStyles();
    for (const state of ['running', 'waitingApproval', 'waitingReply', 'blocked', 'done', 'merging', 'failed']) {
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
    for (const color of ['--vscode-charts-blue', '--vscode-charts-yellow', '--vscode-charts-green', '--vscode-errorForeground']) {
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

  it('動的な値をHTMLへ文字列結合しない（innerHTML/outerHTMLを使わない）', () => {
    // design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして挿入する」。
    // innerHTML系のAPIを使わないことをここで機械的に固定しておく
    // （実際のDOM組み立てはtextContent/createElement系のみで行う）
    const source = workflowScript();
    expect(source.includes('innerHTML')).toBe(false);
    expect(source.includes('outerHTML')).toBe(false);
    expect(source.includes('insertAdjacentHTML')).toBe(false);
  });
});
