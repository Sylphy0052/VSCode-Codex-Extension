import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
import { controlPanelScript } from '../../src/view/controlPanelScript';
import { workflowScript } from '../../src/view/workflowScript';

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
});

describe('controlPanelScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(controlPanelScript())).not.toThrow();
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
