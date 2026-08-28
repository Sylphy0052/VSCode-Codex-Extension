import { describe, expect, it } from 'vitest';
import { buildChatPanelOptions } from '../../src/view/chatView';
import { renderShell, type ChatShellOptions } from '../../src/view/chatShared';
import type { ReviewButtonConfig } from '../../src/view/chatScript';

/**
 * `vscode.Webview` の最小フェイク。`renderShell` が使うのは `cspSource` だけなので、
 * それだけを実装する（`test/unit/controlPanelView.test.ts` と同じ最小構成の方針）。
 */
function fakeWebview(): { cspSource: string } {
  return { cspSource: 'https://fake-webview.test' };
}

/** `renderShell` に渡す最小限のオプション。テストごとに必要な項目だけ上書きする。 */
function buildOptions(overrides: Partial<ChatShellOptions> = {}): ChatShellOptions {
  const review: ReviewButtonConfig = { mode: 'quickPick' };
  return {
    agentLabel: 'Codex',
    provider: 'codex',
    approvalModes: ['read-only', 'auto'],
    showSettings: false,
    review,
    ...overrides,
  };
}

/**
 * アイコン化（issue #226）で送信以外のボタンから消えた文言を、
 * `aria-label` として持たせるべき対応表。
 */
const NON_SEND_BUTTON_LABELS: Record<string, string> = {
  attach: '画像',
  stop: '中断',
  loopToggle: 'ループ',
  compact: '圧縮',
  claudeImport: 'インポート',
  recap: '要約',
  planToggle: '計画',
  fastToggle: '高速',
  review: 'レビュー',
  exportTranscript: 'エクスポート',
  workflowMenu: 'ワークフロー',
};

/** `<button id="...">...</button>` の開始タグ部分だけを取り出す。 */
function extractButtonOpenTag(html: string, id: string): string {
  const match = html.match(new RegExp(`<button id="${id}"[^>]*>`, 'u'));
  if (match === null) {
    throw new Error(`button#${id} が見つからない`);
  }
  return match[0];
}

describe('表示密度のクラス（issue #718）', () => {
  it('既定では comfortable のクラスが付く', () => {
    // 設定を書いていない利用者の見た目が変わらないこと
    const html = renderShell(fakeWebview() as never, buildOptions());
    expect(html).toContain('<body class="density-comfortable">');
  });

  it('compact を渡すと compact のクラスが付く', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ density: 'compact' }));
    expect(html).toContain('<body class="density-compact">');
  });
});

describe('renderShellのボタン（issue #226のアイコン化後、アクセシブル名の検査）', () => {
  it.each(Object.entries(NON_SEND_BUTTON_LABELS))(
    'button#%sはaria-labelとtitleを両方持ち、期待するラベル文言と一致する',
    (id, label) => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const tag = extractButtonOpenTag(html, id);

      expect(tag).toContain(`aria-label="${label}"`);
      expect(tag).toMatch(/title="[^"]+"/u);
    },
  );

  it('送信ボタンはアイコン化されず、ラベル文字列「送信」がそのままHTML中に残る', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    const tag = extractButtonOpenTag(html, 'send');

    // 送信ボタンはaria-labelを追加しない（元からテキストノードでアクセシブル名を持つ）
    expect(tag).not.toContain('aria-label=');
    expect(html).toContain('<button id="send" type="button">送信</button>');
  });

  it('showImportがtrueのときclaudeImportボタンはhidden属性を持たない', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ showImport: true }));
    const tag = extractButtonOpenTag(html, 'claudeImport');

    expect(tag).not.toContain('hidden');
  });

  it('showImportが未指定（false相当）のときclaudeImportボタンはhidden属性を持つ', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    const tag = extractButtonOpenTag(html, 'claudeImport');

    expect(tag).toContain('hidden');
  });

  describe('showImportに文言オブジェクトを渡したとき（issue #227、Codex画面）', () => {
    const codexImportCopy = {
      ariaLabel: 'インポート設定を開く',
      title: '設定パネルの「他エージェントからの設定インポート」を開きます',
    };

    it('claudeImportボタンはhidden属性を持たない', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showImport: codexImportCopy }),
      );
      const tag = extractButtonOpenTag(html, 'claudeImport');

      expect(tag).not.toContain('hidden');
    });

    it('渡した文言がそのままaria-label/titleに使われ、Claude Code画面の既定文言（showImport: true）とは異なる', () => {
      const codexHtml = renderShell(
        fakeWebview() as never,
        buildOptions({ showImport: codexImportCopy }),
      );
      const codexTag = extractButtonOpenTag(codexHtml, 'claudeImport');
      expect(codexTag).toContain(`aria-label="${codexImportCopy.ariaLabel}"`);
      expect(codexTag).toContain(`title="${codexImportCopy.title}"`);

      const claudeHtml = renderShell(fakeWebview() as never, buildOptions({ showImport: true }));
      const claudeTag = extractButtonOpenTag(claudeHtml, 'claudeImport');

      expect(codexTag).not.toContain(`aria-label="インポート"`);
      expect(claudeTag).toContain('aria-label="インポート"');
      expect(codexTag).not.toBe(claudeTag);
    });
  });

  it('showImport: trueのとき（Claude Code画面）は従来通りの文言で、挙動が変わっていない', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ showImport: true }));
    const tag = extractButtonOpenTag(html, 'claudeImport');

    expect(tag).toContain('aria-label="インポート"');
    expect(tag).toContain('title="Codex／Geminiの設定をClaude Codeへ取り込む準備をします"');
  });

  it('showRecapがtrueのときrecapボタンはhidden属性を持たない', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ showRecap: true }));
    const tag = extractButtonOpenTag(html, 'recap');

    expect(tag).not.toContain('hidden');
  });

  it('showRecapが未指定（false相当）のときrecapボタンはhidden属性を持つ', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    const tag = extractButtonOpenTag(html, 'recap');

    expect(tag).toContain('hidden');
  });

  it('review.modeが"command"のときreviewボタンはhidden属性を持つ（コマンド一覧待ち、Claude Code画面）', () => {
    const review: ReviewButtonConfig = { mode: 'command', commandName: 'review' };
    const html = renderShell(fakeWebview() as never, buildOptions({ review }));
    const tag = extractButtonOpenTag(html, 'review');

    expect(tag).toContain('hidden');
  });

  it('review.modeが"quickPick"のときreviewボタンはhidden属性を持たない（常時表示、Codex画面）', () => {
    const review: ReviewButtonConfig = { mode: 'quickPick' };
    const html = renderShell(fakeWebview() as never, buildOptions({ review }));
    const tag = extractButtonOpenTag(html, 'review');

    expect(tag).not.toContain('hidden');
  });
});

/** `<div id="...">...</div>` の中身だけを取り出す（対象divに入れ子のdivが無い前提）。 */
function extractRowHtml(html: string, rowId: string): string {
  const match = html.match(new RegExp(`<div id="${rowId}">([\\s\\S]*?)</div>`, 'u'));
  if (match === null || match[1] === undefined) {
    throw new Error(`div#${rowId} が見つからない`);
  }
  return match[1];
}

/**
 * 2段目（アイコン列）に並ぶボタンのid（issue #234の望む構成の並び順どおり。
 * 末尾のワークフローはissue #250で追加）。
 */
const ICON_ROW_BUTTON_IDS = [
  'attach',
  'loopToggle',
  'compact',
  'claudeImport',
  'recap',
  'planToggle',
  'fastToggle',
  'review',
  'exportTranscript',
  'workflowMenu',
  'teamWorkflow',
  'workflowView',
  'sessionKanban',
  'openProgress',
  'handoffToNewSession',
];

describe('チャット下部の3段固定（issue #234）', () => {
  describe('段ごとの要素の割り当て', () => {
    it('1段目（composerInputRow）はinput・send・stopだけを持ち、アイコン列のボタンは含まない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const row1 = extractRowHtml(html, 'composerInputRow');

      expect(row1).toContain('id="input"');
      expect(row1).toContain('id="send"');
      expect(row1).toContain('id="stop"');
      for (const id of ICON_ROW_BUTTON_IDS) {
        expect(row1).not.toContain(`id="${id}"`);
      }
    });

    it('2段目（composerIconRow）は16個の操作を持ち、入力欄・送信・中断は含まない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const row2 = extractRowHtml(html, 'composerIconRow');

      for (const id of ICON_ROW_BUTTON_IDS) {
        expect(row2).toContain(`id="${id}"`);
      }
      expect(row2).not.toContain('id="input"');
      expect(row2).not.toContain('id="send"');
      expect(row2).not.toContain('id="stop"');
    });

    it('3段目は既存の#settingsがそのまま担い、モデル・Effort・承認のドロップダウンを持つ', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));
      const settingsMatch = html.match(/<div id="settings"[^>]*>([\s\S]*?)\n<script/u);
      expect(settingsMatch).not.toBeNull();
      const settingsHtml = settingsMatch![1];

      expect(settingsHtml).toContain('id="model"');
      expect(settingsHtml).toContain('id="reasoningEffort"');
      expect(settingsHtml).toContain('id="approvalMode"');
    });

    it('showSettingsがfalseのとき3段目の入れ物（#settingsBox）がhidden属性を持つ（描画はされ続ける）', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: false }));

      expect(html).toMatch(/<details id="settingsBox" hidden>/u);
    });

    it('showSettingsがtrueのとき3段目の入れ物（#settingsBox）はhidden属性を持たない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).toMatch(/<details id="settingsBox">/u);
    });

    it('3段目はdetailsで折りたためる。open属性を持たないので初期表示は閉じている（issue #266）', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).toMatch(/<details id="settingsBox">\n\s*<summary/u);
      expect(html).not.toMatch(/<details id="settingsBox"[^>]*\sopen/u);
    });

    it('折りたたみの見出しには現在値を出す枠（#settingsSummary）がある', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).toContain('id="settingsSummary"');
    });
  });

  describe('送信と中断（1段目での入れ替え）', () => {
    it('sendとstopは同じ段（composerInputRow）に同居する', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const row1 = extractRowHtml(html, 'composerInputRow');

      expect(row1).toContain('id="send"');
      expect(row1).toContain('id="stop"');
    });

    it('stopは既定でhidden属性を持ち、sendは持たない（応答中にJS側で入れ替える前提）', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const row1 = extractRowHtml(html, 'composerInputRow');
      const sendTag = extractButtonOpenTag(row1, 'send');
      const stopTag = extractButtonOpenTag(row1, 'stop');

      expect(sendTag).not.toContain('hidden');
      expect(stopTag).toContain('hidden');
    });
  });

  it('2段目に移ったボタンもissue #226のaria-label/titleを保持している', () => {
    const html = renderShell(
      fakeWebview() as never,
      buildOptions({ showImport: true, showRecap: true }),
    );
    const row2 = extractRowHtml(html, 'composerIconRow');

    for (const [id, label] of Object.entries(NON_SEND_BUTTON_LABELS)) {
      if (id === 'stop') {
        continue; // stopは1段目側。既存describeで検査済み
      }
      const tag = extractButtonOpenTag(row2, id);
      expect(tag).toContain(`aria-label="${label}"`);
      expect(tag).toMatch(/title="[^"]+"/u);
    }
  });

  it('#commandsはcomposerの先頭に残り、composerInputRowより前に出力される（候補の表示位置がずれないことの確認。position: absolute; bottom: 100%はcomposerを基準にするため、composerの直下という位置関係を保つ必要がある）', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    const composerMatch = html.match(/<div id="composer">([\s\S]*?)\n {2}<div id="loop"/u);
    expect(composerMatch).not.toBeNull();
    const composerHtml = composerMatch?.[1];
    expect(composerHtml).toBeDefined();
    if (composerHtml === undefined) {
      throw new Error('composerHtml が見つからない');
    }

    const commandsIndex = composerHtml.indexOf('<div id="commands"');
    const inputRowIndex = composerHtml.indexOf('<div id="composerInputRow">');

    expect(commandsIndex).toBeGreaterThanOrEqual(0);
    expect(inputRowIndex).toBeGreaterThan(commandsIndex);
  });

  describe('表示条件つきの要素の出し分け（3段目、Claude Code専用の項目を含む）', () => {
    it('sandboxModesを渡すとsandboxセレクタが出る', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showSettings: true, sandboxModes: ['workspace-write'] }),
      );

      expect(html).toContain('id="sandbox"');
    });

    it('sandboxModesを渡さないとsandboxセレクタは出ない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).not.toContain('id="sandbox"');
    });

    it('showAgentSelectorがtrueのときagentセレクタが出る（Claude Code専用）', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showSettings: true, showAgentSelector: true }),
      );

      expect(html).toContain('id="agent"');
    });

    it('showAgentSelectorが未指定のときagentセレクタは出ない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).not.toContain('id="agent"');
    });

    it('showAutocompactがtrueのとき自動圧縮の入力欄とボタンが#settingsの末尾に出る（Claude Code専用）', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showSettings: true, showAutocompact: true }),
      );

      expect(html).toContain('id="autocompactInput"');
      expect(html).toContain('id="autocompactApply"');
    });

    it('showAutocompactが未指定のとき自動圧縮の導線は出ない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).not.toContain('id="autocompactInput"');
    });

    it('showDebugがtrueのときデバッグログの導線が#settingsの末尾に出る（Claude Code専用）', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showSettings: true, showDebug: true }),
      );

      expect(html).toContain('id="openDebugLog"');
      expect(html).toContain('id="sendDebugCommand"');
    });

    it('showDebugが未指定のときデバッグログの導線は出ない', () => {
      const html = renderShell(fakeWebview() as never, buildOptions({ showSettings: true }));

      expect(html).not.toContain('id="openDebugLog"');
    });

    it('fastToggleは初期描画では既定でhidden（応答中の高速切替可否はJS側のstateで制御するため）', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const row2 = extractRowHtml(html, 'composerIconRow');
      const tag = extractButtonOpenTag(row2, 'fastToggle');

      expect(tag).toContain('hidden');
    });
  });
});

/**
 * ボタンidが「…」メニュー（`#composerOverflowMenu`）の中にあるか、表
 * （`#composerIconRow`直下）にあるかを、文字列上の出現位置で判定する。
 * `renderComposerButton`は表向け・メニュー向けで同じidの`<button>`を1個しか出力
 * しないため（`composerButtons`の設定で必ずどちらか一方に決まる）、
 * `<div id="composerOverflowMenu"`の開始タグより後に現れるかどうかで判別できる。
 */
function isInOverflowMenu(html: string, id: string): boolean {
  const menuOpenIndex = html.indexOf('<div id="composerOverflowMenu"');
  const buttonIndex = html.indexOf(`<button id="${id}"`);
  if (menuOpenIndex === -1 || buttonIndex === -1) {
    throw new Error(`composerOverflowMenu または button#${id} が見つからない`);
  }
  return buttonIndex > menuOpenIndex;
}

describe('入力欄アイコン列の「…」メニュー折りたたみ（issue #296）', () => {
  it('composerButtons省略時は既定の4つ（attach/loopToggle/compact/claudeImport）が表、残り11個が「…」メニューに入る', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ showImport: true }));

    for (const id of ['attach', 'loopToggle', 'compact', 'claudeImport']) {
      expect(isInOverflowMenu(html, id), `${id} は表にあるはず`).toBe(false);
    }
    for (const id of [
      'recap',
      'planToggle',
      'fastToggle',
      'review',
      'exportTranscript',
      'workflowMenu',
      'teamWorkflow',
      'workflowView',
      'sessionKanban',
      'openProgress',
      'handoffToNewSession',
    ]) {
      expect(isInOverflowMenu(html, id), `${id} は「…」メニューにあるはず`).toBe(true);
    }
  });

  it('composerButtonsを指定すると、そこに挙げたIDだけが表に出て、残りは「…」メニューに入る（表に出なくなったボタンがどこからも到達できなくならないことの確認）', () => {
    const html = renderShell(
      fakeWebview() as never,
      buildOptions({ composerButtons: ['review', 'workflowMenu'] }),
    );

    for (const id of ['review', 'workflowMenu']) {
      expect(isInOverflowMenu(html, id), `${id} は表にあるはず`).toBe(false);
    }
    for (const id of [
      'attach',
      'loopToggle',
      'compact',
      'claudeImport',
      'recap',
      'planToggle',
      'fastToggle',
      'exportTranscript',
      'teamWorkflow',
      'workflowView',
      'sessionKanban',
      'openProgress',
      'handoffToNewSession',
    ]) {
      expect(isInOverflowMenu(html, id), `${id} は「…」メニューにあるはず`).toBe(true);
    }
  });

  it('composerButtonsに16個すべてを指定しても、ターン要約の切替を置くため「…」メニューは残る', () => {
    const html = renderShell(
      fakeWebview() as never,
      buildOptions({
        composerButtons: [
          'attach',
          'loopToggle',
          'compact',
          'claudeImport',
          'recap',
          'planToggle',
          'fastToggle',
          'review',
          'exportTranscript',
          'workflowMenu',
          'teamWorkflow',
          'workflowView',
          'sessionKanban',
          'forgeHub',
          'openProgress',
          'handoffToNewSession',
        ],
      }),
    );

    const overflowTag = html.match(/<div id="composerOverflow"[^>]*>/u)?.[0];
    expect(overflowTag).toBeDefined();
    expect(overflowTag).not.toContain('hidden');
    expect(isInOverflowMenu(html, 'turnSummaryToggle')).toBe(true);
  });

  it('ターン要約の切替は現在の設定に応じて有効化または無効化を示す', () => {
    const disabled = renderShell(fakeWebview() as never, buildOptions());
    const enabled = renderShell(fakeWebview() as never, buildOptions({ turnSummaryEnabled: true }));

    expect(extractButtonOpenTag(disabled, 'turnSummaryToggle')).toContain('aria-pressed="false"');
    expect(disabled).toContain('ターン要約を有効にする');
    expect(extractButtonOpenTag(enabled, 'turnSummaryToggle')).toContain('aria-pressed="true"');
    expect(enabled).toContain('ターン要約を無効にする');
  });

  it('ループエンジニアリングの切替は「…」メニューにあり、現在の設定を示す（issue #891）', () => {
    const disabled = renderShell(fakeWebview() as never, buildOptions());
    const enabled = renderShell(
      fakeWebview() as never,
      buildOptions({ loopEngineeringEnabled: true }),
    );

    expect(isInOverflowMenu(disabled, 'loopEngineeringToggle')).toBe(true);
    expect(extractButtonOpenTag(disabled, 'loopEngineeringToggle')).toContain(
      'aria-pressed="false"',
    );
    expect(disabled).toContain('ループエンジニアリングを有効にする');
    expect(extractButtonOpenTag(enabled, 'loopEngineeringToggle')).toContain('aria-pressed="true"');
    expect(enabled).toContain('ループエンジニアリングを無効にする');
  });

  it('ループパネルに時間上限の入力を持つ（issue #891）', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    // 上限は LOOP_DURATION_LIMIT_MINUTES（24時間）と揃える
    expect(html).toContain('id="loopMaxDuration"');
    expect(html).toContain('max="1440"');
  });

  it('composerButtonsが空配列だと16個すべてが「…」メニューに入り、#composerOverflowはhiddenを持たない', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ composerButtons: [] }));

    const overflowTag = html.match(/<div id="composerOverflow"[^>]*>/u)?.[0];
    expect(overflowTag).toBeDefined();
    expect(overflowTag).not.toContain('hidden');
    for (const id of ICON_ROW_BUTTON_IDS) {
      expect(isInOverflowMenu(html, id), `${id} は「…」メニューにあるはず`).toBe(true);
    }
  });

  describe('条件付きで出入りするボタンは、表にあっても「…」メニューにあっても同じ条件でhiddenになる（今回いちばん壊れやすい箇所）', () => {
    it('claudeImport: showImportがtrueなら、表でも「…」メニューでもhidden属性を持たない', () => {
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ showImport: true, composerButtons: ['claudeImport'] }),
      );
      const inMenu = renderShell(
        fakeWebview() as never,
        buildOptions({ showImport: true, composerButtons: [] }),
      );

      expect(isInOverflowMenu(inToolbar, 'claudeImport')).toBe(false);
      expect(isInOverflowMenu(inMenu, 'claudeImport')).toBe(true);
      expect(extractButtonOpenTag(inToolbar, 'claudeImport')).not.toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'claudeImport')).not.toContain('hidden');
    });

    it('claudeImport: showImportが未指定なら、表でも「…」メニューでもhidden属性を持つ', () => {
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ composerButtons: ['claudeImport'] }),
      );
      const inMenu = renderShell(fakeWebview() as never, buildOptions({ composerButtons: [] }));

      expect(extractButtonOpenTag(inToolbar, 'claudeImport')).toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'claudeImport')).toContain('hidden');
    });

    it('recap: showRecapがtrueなら、表でも「…」メニューでもhidden属性を持たない', () => {
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ showRecap: true, composerButtons: ['recap'] }),
      );
      const inMenu = renderShell(
        fakeWebview() as never,
        buildOptions({ showRecap: true, composerButtons: [] }),
      );

      expect(isInOverflowMenu(inToolbar, 'recap')).toBe(false);
      expect(isInOverflowMenu(inMenu, 'recap')).toBe(true);
      expect(extractButtonOpenTag(inToolbar, 'recap')).not.toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'recap')).not.toContain('hidden');
    });

    it('recap: showRecapが未指定なら、表でも「…」メニューでもhidden属性を持つ', () => {
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ composerButtons: ['recap'] }),
      );
      const inMenu = renderShell(fakeWebview() as never, buildOptions({ composerButtons: [] }));

      expect(extractButtonOpenTag(inToolbar, 'recap')).toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'recap')).toContain('hidden');
    });

    it('fastToggle: 表にあっても「…」メニューにあっても、初期描画では既定でhidden属性を持つ（応答中の出し分けはJS側のstateで制御するため）', () => {
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ composerButtons: ['fastToggle'] }),
      );
      const inMenu = renderShell(fakeWebview() as never, buildOptions({ composerButtons: [] }));

      expect(isInOverflowMenu(inToolbar, 'fastToggle')).toBe(false);
      expect(isInOverflowMenu(inMenu, 'fastToggle')).toBe(true);
      expect(extractButtonOpenTag(inToolbar, 'fastToggle')).toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'fastToggle')).toContain('hidden');
    });

    it('review: mode: "command"なら、表でも「…」メニューでもhidden属性を持つ（コマンド一覧待ち）', () => {
      const review: ReviewButtonConfig = { mode: 'command', commandName: 'review' };
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ review, composerButtons: ['review'] }),
      );
      const inMenu = renderShell(
        fakeWebview() as never,
        buildOptions({ review, composerButtons: [] }),
      );

      expect(extractButtonOpenTag(inToolbar, 'review')).toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'review')).toContain('hidden');
    });

    it('review: mode: "quickPick"なら、表でも「…」メニューでもhidden属性を持たない（常時表示）', () => {
      const review: ReviewButtonConfig = { mode: 'quickPick' };
      const inToolbar = renderShell(
        fakeWebview() as never,
        buildOptions({ review, composerButtons: ['review'] }),
      );
      const inMenu = renderShell(
        fakeWebview() as never,
        buildOptions({ review, composerButtons: [] }),
      );

      expect(isInOverflowMenu(inToolbar, 'review')).toBe(false);
      expect(isInOverflowMenu(inMenu, 'review')).toBe(true);
      expect(extractButtonOpenTag(inToolbar, 'review')).not.toContain('hidden');
      expect(extractButtonOpenTag(inMenu, 'review')).not.toContain('hidden');
    });
  });

  describe('アクセシビリティ（Tab/矢印キーで辿れる・Escapeで閉じる、issue #296）', () => {
    it('「…」トグルボタンはaria-haspopupとaria-expanded="false"（閉じている）を持つ', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const tag = extractButtonOpenTag(html, 'composerOverflowToggle');

      expect(tag).toContain('aria-haspopup="true"');
      expect(tag).toContain('aria-expanded="false"');
    });

    it('メニュー本体（#composerOverflowMenu）はrole="menu"を持ち、初期描画ではhidden', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());
      const match = html.match(/<div id="composerOverflowMenu"[^>]*>/u);

      expect(match).not.toBeNull();
      expect(match?.[0]).toContain('role="menu"');
      expect(match?.[0]).toContain('hidden');
    });

    it('メニュー項目はrole="menuitem"を持つbutton要素で、aria-label/titleを表のボタンから引き継ぐ', () => {
      const html = renderShell(
        fakeWebview() as never,
        buildOptions({ showImport: true, showRecap: true }),
      );

      for (const [id, label] of Object.entries(NON_SEND_BUTTON_LABELS)) {
        if (
          id === 'stop' ||
          id === 'attach' ||
          id === 'loopToggle' ||
          id === 'compact' ||
          id === 'claudeImport'
        ) {
          continue; // 表側の既定4つ（+stop）はここでは検査済み（別テスト）
        }
        const tag = extractButtonOpenTag(html, id);
        expect(tag, `${id} はメニュー項目のはず`).toContain('role="menuitem"');
        expect(tag).toContain(`aria-label="${label}"`);
        expect(tag).toMatch(/title="[^"]+"/u);
      }
    });

    it('planToggle/fastToggleは「…」メニューに移ってもaria-pressedを保つ（トグル状態が分かるように）', () => {
      const html = renderShell(fakeWebview() as never, buildOptions());

      expect(extractButtonOpenTag(html, 'planToggle')).toContain('aria-pressed="false"');
      expect(extractButtonOpenTag(html, 'fastToggle')).toContain('aria-pressed="false"');
    });
  });
});

describe('renderShellの入力欄プレースホルダ（送信キー設定 agent.chat.sendOn、issue #288）', () => {
  it('sendOn未指定（既定ctrlEnter）では従来どおり「Ctrl+Enterで送信」と案内する', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());

    expect(html).toContain('Codexへの指示を入力（Ctrl+Enterで送信、画像はCtrl+Vで貼り付け）');
  });

  it('sendOn: "ctrlEnter"を明示しても同じ案内文になる', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ sendOn: 'ctrlEnter' }));

    expect(html).toContain('Ctrl+Enterで送信');
  });

  it('sendOn: "enter"では「Enterで送信、Shift+Enterで改行」に切り替わる', () => {
    const html = renderShell(fakeWebview() as never, buildOptions({ sendOn: 'enter' }));

    expect(html).toContain(
      'Codexへの指示を入力（Enterで送信、Shift+Enterで改行、画像はCtrl+Vで貼り付け）',
    );
    expect(html).not.toContain('Ctrl+Enterで送信');
  });
});

describe('buildChatPanelOptions（Ctrl+Fの検索窓、issue #287、design.md §14.48）', () => {
  it('enableFindWidgetをtrueにし、既存のenableScripts/retainContextWhenHiddenを保つ', () => {
    expect(buildChatPanelOptions()).toEqual({
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
    });
  });
});

describe('会話の一番下へジャンプするボタン', () => {
  it('#logと同じ#logWrapのナビゲーション内に、初期状態でhidden属性を持って描画される', () => {
    const html = renderShell(fakeWebview() as never, buildOptions());
    const wrapMatch = html.match(/<div id="logWrap">([\s\S]*?)<\/div>\n\s*<div id="approvals">/u);
    expect(wrapMatch).not.toBeNull();
    const wrapHtml = wrapMatch![1];

    expect(wrapHtml).toContain('<div id="log"></div>');
    expect(wrapHtml).toContain('<div id="conversationNavigation">');
    for (const { id, label } of [
      { id: 'previousUserMessage', label: '前の自分の発言へ移動' },
      { id: 'nextUserMessage', label: '次の自分の発言へ移動' },
      { id: 'scrollToBottom', label: '会話の一番下へ移動' },
    ]) {
      const tag = extractButtonOpenTag(html, id);
      expect(tag).toContain('hidden');
      expect(tag).toContain(`aria-label="${label}"`);
    }
  });
});
