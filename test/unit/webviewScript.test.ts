import { describe, expect, it } from 'vitest';
import { chatScript } from '../../src/view/chatScript';
import { controlPanelScript } from '../../src/view/controlPanelScript';

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
});

describe('controlPanelScript', () => {
  it('構文として成立している', () => {
    expect(() => parses(controlPanelScript())).not.toThrow();
  });
});
