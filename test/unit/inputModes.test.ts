import { describe, expect, it } from 'vitest';
import { describeInputMode, routeInputMode } from '../../src/provider/inputModes';

describe('routeInputMode', () => {
  it('先頭が ! ならシェルコマンドとして読み取る', () => {
    expect(routeInputMode('!ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
  });

  it('先頭が # の入力は特別扱いせず通常の発言にする（メモリモードはissue #2007で削除）', () => {
    expect(routeInputMode('#常にpnpmを使う')).toBeUndefined();
    expect(routeInputMode('# 見出し')).toBeUndefined();
  });

  it('前後の空白は無視する', () => {
    expect(routeInputMode('  !ls  ')).toEqual({ kind: 'shell', command: 'ls' });
  });

  it('! の直後が空なら該当なし（空コマンドを実行させない）', () => {
    expect(routeInputMode('!')).toBeUndefined();
    expect(routeInputMode('!   ')).toBeUndefined();
  });

  it('行頭でない ! は対象にしない', () => {
    expect(routeInputMode('これは!コマンドではない')).toBeUndefined();
  });

  it('複数行にまたがる発言は対象にしない', () => {
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
});
