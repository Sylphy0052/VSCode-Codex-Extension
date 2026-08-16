import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTION_BYTES,
  buildSelectionPayload,
  computeSelectionLineRange,
  formatSelectionHeader,
  selectionTextExceedsLimit,
} from '../../src/util/editorSelection';

describe('computeSelectionLineRange', () => {
  it('同じ行内の選択は開始行=終了行になる（0始まり→1始まり変換）', () => {
    const range = computeSelectionLineRange(4, 4, 10);
    expect(range).toEqual({ startLine: 5, endLine: 5 });
  });

  it('複数行にまたがる通常の選択（最終行の途中で終わる）はそのまま変換する', () => {
    const range = computeSelectionLineRange(2, 5, 3);
    expect(range).toEqual({ startLine: 3, endLine: 6 });
  });

  it('行末から次の行の先頭までドラッグした選択は、実際に選んでいない次の行を含めない', () => {
    // 3行目の先頭(index 2)〜6行目の先頭(index 5, character 0)まで選択した想定。
    // 実際に選んだのは3〜5行目のみ
    const range = computeSelectionLineRange(2, 5, 0);
    expect(range).toEqual({ startLine: 3, endLine: 5 });
  });

  it('1行だけを行末まで選択し、character 0の次の行を跨がない場合は1行のまま', () => {
    const range = computeSelectionLineRange(2, 2, 0);
    expect(range).toEqual({ startLine: 3, endLine: 3 });
  });
});

describe('formatSelectionHeader', () => {
  it('パス:開始行-終了行の形式で組み立てる', () => {
    const header = formatSelectionHeader('src/foo.ts', { startLine: 5, endLine: 5 });
    expect(header).toBe('src/foo.ts:5-5');
  });

  it('開始行と終了行が異なる場合もそのまま範囲を出す', () => {
    const header = formatSelectionHeader('src/foo.ts', { startLine: 3, endLine: 6 });
    expect(header).toBe('src/foo.ts:3-6');
  });
});

describe('buildSelectionPayload', () => {
  it('見出し行の次の行から選択本文を続ける', () => {
    const payload = buildSelectionPayload(
      'src/foo.ts',
      { startLine: 5, endLine: 5 },
      'const x = 1;',
    );
    expect(payload).toBe('src/foo.ts:5-5\nconst x = 1;');
  });
});

describe('selectionTextExceedsLimit', () => {
  it('上限未満のテキストはfalse', () => {
    expect(selectionTextExceedsLimit('short text')).toBe(false);
  });

  it('上限をちょうど超えるテキストはtrue', () => {
    const text = 'a'.repeat(MAX_SELECTION_BYTES + 1);
    expect(selectionTextExceedsLimit(text)).toBe(true);
  });

  it('上限ちょうどのテキストはfalse（境界値）', () => {
    const text = 'a'.repeat(MAX_SELECTION_BYTES);
    expect(selectionTextExceedsLimit(text)).toBe(false);
  });

  it('マルチバイト文字はUTF-8のバイト数で判定する', () => {
    // 「あ」はUTF-8で3バイト。文字数では上限未満でもバイト数では超える境界を確かめる
    const charCount = Math.floor(MAX_SELECTION_BYTES / 3) + 1;
    const text = 'あ'.repeat(charCount);
    expect(selectionTextExceedsLimit(text)).toBe(true);
  });
});
