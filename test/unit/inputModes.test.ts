import { describe, expect, it } from 'vitest';
import {
  appendMemoryLine,
  describeInputMode,
  resolveProjectMemoryFile,
  resolveUserMemoryFile,
  routeInputMode,
} from '../../src/provider/inputModes';

describe('routeInputMode', () => {
  it('先頭が ! ならシェルコマンドとして読み取る', () => {
    expect(routeInputMode('!ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
  });

  it('先頭が # ならメモリ追記として読み取る', () => {
    expect(routeInputMode('#常にpnpmを使う')).toEqual({ kind: 'memory', content: '常にpnpmを使う' });
  });

  it('前後の空白は無視する', () => {
    expect(routeInputMode('  !ls  ')).toEqual({ kind: 'shell', command: 'ls' });
  });

  it('! の直後が空なら該当なし（空コマンドを実行させない）', () => {
    expect(routeInputMode('!')).toBeUndefined();
    expect(routeInputMode('!   ')).toBeUndefined();
  });

  it('# の直後が空なら該当なし（空の追記をさせない）', () => {
    expect(routeInputMode('#')).toBeUndefined();
    expect(routeInputMode('#   ')).toBeUndefined();
  });

  it('行頭でない ! / # は対象にしない', () => {
    expect(routeInputMode('これは!コマンドではない')).toBeUndefined();
    expect(routeInputMode('タグは#付けない')).toBeUndefined();
  });

  it('複数行にまたがる発言は対象にしない（Markdown見出しの引用等を誤って乗っ取らない）', () => {
    expect(routeInputMode('# 見出し\n本文が続く')).toBeUndefined();
    expect(routeInputMode('!ls\n次の行')).toBeUndefined();
  });

  it('通常の発言は対象にしない', () => {
    expect(routeInputMode('こんにちは')).toBeUndefined();
    expect(routeInputMode('')).toBeUndefined();
  });
});

describe('describeInputMode', () => {
  it('シェルコマンドの案内文を組み立てる', () => {
    expect(describeInputMode({ kind: 'shell', command: 'ls -la' })).toBe(
      'シェルコマンドとしてターミナルへ入力します: ls -la',
    );
  });

  it('メモリ追記の案内文を組み立てる', () => {
    expect(describeInputMode({ kind: 'memory', content: '常にpnpmを使う' })).toBe(
      'メモリへ追記します: 常にpnpmを使う',
    );
  });
});

describe('resolveProjectMemoryFile', () => {
  it('どちらも無ければ <cwd>/CLAUDE.md を使う', () => {
    expect(resolveProjectMemoryFile('/repo', false, false)).toBe('/repo/CLAUDE.md');
  });

  it('<cwd>/CLAUDE.md が既にあればそれを使う', () => {
    expect(resolveProjectMemoryFile('/repo', true, false)).toBe('/repo/CLAUDE.md');
  });

  it('<cwd>/.claude/CLAUDE.md だけがあればそれを使う', () => {
    expect(resolveProjectMemoryFile('/repo', false, true)).toBe('/repo/.claude/CLAUDE.md');
  });

  it('両方あれば <cwd>/CLAUDE.md を優先する', () => {
    expect(resolveProjectMemoryFile('/repo', true, true)).toBe('/repo/CLAUDE.md');
  });
});

describe('resolveUserMemoryFile', () => {
  it('claudeHome直下のCLAUDE.mdを指す', () => {
    expect(resolveUserMemoryFile('/home/user/.claude')).toBe('/home/user/.claude/CLAUDE.md');
  });
});

describe('appendMemoryLine', () => {
  it('ファイルが無いとき（undefined）は新規の箇条書き1行になる', () => {
    expect(appendMemoryLine(undefined, '常にpnpmを使う')).toBe('- 常にpnpmを使う\n');
  });

  it('空文字も無いときと同じ扱いにする', () => {
    expect(appendMemoryLine('', '常にpnpmを使う')).toBe('- 常にpnpmを使う\n');
  });

  it('末尾に改行が無ければ補ってから足す', () => {
    expect(appendMemoryLine('既存の内容', '追記分')).toBe('既存の内容\n- 追記分\n');
  });

  it('末尾が改行済みならそのまま足す', () => {
    expect(appendMemoryLine('既存の内容\n', '追記分')).toBe('既存の内容\n- 追記分\n');
  });

  it('既存の内容を変更しない（immutable）', () => {
    const existing = '既存の内容\n';
    appendMemoryLine(existing, '追記分');
    expect(existing).toBe('既存の内容\n');
  });
});
