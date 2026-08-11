import { describe, expect, it } from 'vitest';
import { classifyClaudeInput } from '../../src/claude/inputModes';

describe('classifyClaudeInput', () => {
  it('`!` 始まりはシェルコマンドとして分類する（残り全体がコマンド）', () => {
    expect(classifyClaudeInput('!ls -la')).toEqual({ kind: 'shellCommand', command: 'ls -la' });
  });

  it('bashコマンドはtrimしない（残り全体をそのまま渡す）', () => {
    expect(classifyClaudeInput('!  ls  ')).toEqual({ kind: 'shellCommand', command: '  ls  ' });
  });

  it('`#` 始まりはメモリ追記として分類する（前後の空白をtrimする）', () => {
    expect(classifyClaudeInput('#  次はこれを試す  ')).toEqual({
      kind: 'memoryNote',
      note: '次はこれを試す',
    });
  });

  it('`\\!` はエスケープ。先頭のバックスラッシュ1つだけを取り除いた通常のメッセージにする', () => {
    expect(classifyClaudeInput('\\!echo hi')).toEqual({ kind: 'message', text: '!echo hi' });
  });

  it('`\\#` はエスケープ。先頭のバックスラッシュ1つだけを取り除いた通常のメッセージにする', () => {
    expect(classifyClaudeInput('\\# 見出し')).toEqual({ kind: 'message', text: '# 見出し' });
  });

  it('`!` の後ろが空白のみなら empty（CLIへ送らず、会話にも項目を足さない）', () => {
    expect(classifyClaudeInput('!')).toEqual({ kind: 'empty' });
    expect(classifyClaudeInput('!   ')).toEqual({ kind: 'empty' });
    expect(classifyClaudeInput('!\t\n ')).toEqual({ kind: 'empty' });
  });

  it('`#` の後ろが空白のみなら empty', () => {
    expect(classifyClaudeInput('#')).toEqual({ kind: 'empty' });
    expect(classifyClaudeInput('#\n')).toEqual({ kind: 'empty' });
  });

  it('先頭に空白があると `!` / `#` の判定は働かず、通常のメッセージになる', () => {
    expect(classifyClaudeInput(' !ls')).toEqual({ kind: 'message', text: ' !ls' });
    expect(classifyClaudeInput(' #メモ')).toEqual({ kind: 'message', text: ' #メモ' });
  });

  it('複数行の入力は全体を1つのコマンド/ノートとして扱う', () => {
    expect(classifyClaudeInput('!echo a\necho b')).toEqual({
      kind: 'shellCommand',
      command: 'echo a\necho b',
    });
    expect(classifyClaudeInput('#見出し\n詳細1\n詳細2')).toEqual({
      kind: 'memoryNote',
      note: '見出し\n詳細1\n詳細2',
    });
  });

  it('`!` / `#` 以外で始まる入力は通常のメッセージとしてそのまま返す', () => {
    expect(classifyClaudeInput('こんにちは')).toEqual({ kind: 'message', text: 'こんにちは' });
    expect(classifyClaudeInput('')).toEqual({ kind: 'message', text: '' });
  });
});
