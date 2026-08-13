import { describe, expect, it } from 'vitest';
import { renderShell, type ChatShellOptions } from '../../src/view/chatView';
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
};

/** `<button id="...">...</button>` の開始タグ部分だけを取り出す。 */
function extractButtonOpenTag(html: string, id: string): string {
  const match = html.match(new RegExp(`<button id="${id}"[^>]*>`, 'u'));
  if (match === null) {
    throw new Error(`button#${id} が見つからない`);
  }
  return match[0];
}

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
