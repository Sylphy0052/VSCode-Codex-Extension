import { describe, expect, it } from 'vitest';
import {
  computeDiffContents,
  parseUnifiedDiffHunks,
  planDiffActions,
  reconstructWholeFile,
  reverseApplyHunks,
} from '../../src/util/diffRestore';

describe('parseUnifiedDiffHunks', () => {
  it('1ハンクのunified diffを読む', () => {
    const diff = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2changed\n line3';
    const parsed = parseUnifiedDiffHunks(diff);
    expect(parsed).toEqual({
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: 'context', text: 'line1' },
            { kind: 'remove', text: 'line2' },
            { kind: 'add', text: 'line2changed' },
            { kind: 'context', text: 'line3' },
          ],
        },
      ],
    });
  });

  it('複数ハンクを読む', () => {
    const diff = '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d';
    const parsed = parseUnifiedDiffHunks(diff);
    expect(parsed?.hunks).toHaveLength(2);
  });

  it('ハンク見出しが無い差分（Claude Codeのeditdiff相当）はundefinedを返す', () => {
    const diff = '-old_line\n+new_line';
    expect(parseUnifiedDiffHunks(diff)).toBeUndefined();
  });

  it('宣言された行数と実際の行数が食い違う差分はundefinedを返す', () => {
    // +2行と宣言しているが実際は1行しか無い（コンテキスト不足・壊れた差分を想定）
    const diff = '@@ -1,2 +1,2 @@\n line1\n-line2';
    expect(parseUnifiedDiffHunks(diff)).toBeUndefined();
  });

  it('空文字はundefinedを返す', () => {
    expect(parseUnifiedDiffHunks('')).toBeUndefined();
  });
});

describe('reverseApplyHunks', () => {
  it('現在の内容から変更前の内容を復元する', () => {
    const diff = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2changed\n line3';
    const parsed = parseUnifiedDiffHunks(diff);
    const result = reverseApplyHunks('line1\nline2changed\nline3', parsed!.hunks);
    expect(result).toEqual({ ok: true, before: 'line1\nline2\nline3' });
  });

  it('追加だけのハンクを戻す', () => {
    const diff = '@@ -1,1 +1,2 @@\n line1\n+added';
    const parsed = parseUnifiedDiffHunks(diff);
    const result = reverseApplyHunks('line1\nadded', parsed!.hunks);
    expect(result).toEqual({ ok: true, before: 'line1' });
  });

  it('削除だけのハンクを戻す', () => {
    const diff = '@@ -1,2 +1,1 @@\n line1\n-removed';
    const parsed = parseUnifiedDiffHunks(diff);
    const result = reverseApplyHunks('line1', parsed!.hunks);
    expect(result).toEqual({ ok: true, before: 'line1\nremoved' });
  });

  it('現在の内容が差分の想定と食い違えば失敗を返す', () => {
    const diff = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2changed\n line3';
    const parsed = parseUnifiedDiffHunks(diff);
    const result = reverseApplyHunks('line1\nline2changed-but-different\nline3', parsed!.hunks);
    expect(result.ok).toBe(false);
  });
});

describe('reconstructWholeFile', () => {
  it('全て+行なら中身を復元する（add）', () => {
    const result = reconstructWholeFile('+line1\n+line2', '+');
    expect(result).toEqual({ ok: true, content: 'line1\nline2' });
  });

  it('全て-行なら中身を復元する（delete）', () => {
    const result = reconstructWholeFile('-line1\n-line2', '-');
    expect(result).toEqual({ ok: true, content: 'line1\nline2' });
  });

  it('印の付いていない行が混ざっていれば復元できない', () => {
    const result = reconstructWholeFile('+line1\nline2', '+');
    expect(result.ok).toBe(false);
  });

  it('空文字は空文字として復元する', () => {
    expect(reconstructWholeFile('', '+')).toEqual({ ok: true, content: '' });
  });
});

describe('computeDiffContents', () => {
  it('add: 現在の内容が差分どおりなら before は空文字', () => {
    const result = computeDiffContents({ kind: 'add', diff: '+line1\n+line2' }, 'line1\nline2');
    expect(result).toEqual({ ok: true, before: '', after: 'line1\nline2' });
  });

  it('add: ファイルが既に無ければ失敗を返す', () => {
    const result = computeDiffContents({ kind: 'add', diff: '+line1' }, undefined);
    expect(result.ok).toBe(false);
  });

  it('add: 現在の内容が差分と食い違えば失敗を返す', () => {
    const result = computeDiffContents({ kind: 'add', diff: '+line1' }, 'different');
    expect(result.ok).toBe(false);
  });

  it('delete: ファイルが無いことを確かめてから元の内容を返す', () => {
    const result = computeDiffContents({ kind: 'delete', diff: '-line1' }, undefined);
    expect(result).toEqual({ ok: true, before: 'line1', after: '' });
  });

  it('delete: ファイルが既に存在していれば失敗を返す', () => {
    const result = computeDiffContents({ kind: 'delete', diff: '-line1' }, 'line1');
    expect(result.ok).toBe(false);
  });

  it('update: ハンクを逆適用してbefore/afterの両方を返す', () => {
    const diff = '@@ -1,1 +1,1 @@\n-old\n+new';
    const result = computeDiffContents({ kind: 'update', diff }, 'new');
    expect(result).toEqual({ ok: true, before: 'old', after: 'new' });
  });

  it('update: ハンク見出しが無い差分は復元できない', () => {
    const result = computeDiffContents({ kind: 'update', diff: '-old\n+new' }, 'new');
    expect(result.ok).toBe(false);
  });

  it('未知の種類は復元できない', () => {
    const result = computeDiffContents({ kind: 'rename', diff: 'irrelevant' }, 'irrelevant');
    expect(result.ok).toBe(false);
  });
});

describe('planDiffActions', () => {
  it('add: 復元できる差分なら3操作とも出す', () => {
    const plan = planDiffActions({ kind: 'add', diff: '+line1' });
    expect(plan).toEqual({ openEditor: true, openDiff: true, revert: true, jumpToLine: 1 });
  });

  it('add: 復元できない差分は開くだけに絞る', () => {
    const plan = planDiffActions({ kind: 'add', diff: 'line1' });
    expect(plan).toEqual({ openEditor: true, openDiff: false, revert: false, jumpToLine: 1 });
  });

  it('delete: 復元できる差分は「開く」以外の2操作を出す（ファイルが無いため開けない）', () => {
    const plan = planDiffActions({ kind: 'delete', diff: '-line1' });
    expect(plan).toEqual({
      openEditor: false,
      openDiff: true,
      revert: true,
      jumpToLine: undefined,
    });
  });

  it('update: ハンクを解析できれば3操作とも出す', () => {
    const plan = planDiffActions({ kind: 'update', diff: '@@ -1,1 +2,1 @@\n-old\n+new' });
    expect(plan).toEqual({ openEditor: true, openDiff: true, revert: true, jumpToLine: 2 });
  });

  it('update: ハンクを解析できなければ開くだけに絞る', () => {
    const plan = planDiffActions({ kind: 'update', diff: '-old\n+new' });
    expect(plan).toEqual({
      openEditor: true,
      openDiff: false,
      revert: false,
      jumpToLine: undefined,
    });
  });

  it('update+移動: 開く・差分は出すが、戻すは出さない', () => {
    const plan = planDiffActions({
      kind: 'update',
      diff: '@@ -1,1 +1,1 @@\n-old\n+new',
      movePath: 'new/path.ts',
    });
    expect(plan).toEqual({ openEditor: true, openDiff: true, revert: false, jumpToLine: 1 });
  });

  it('未知の種類はエディタで開くだけに絞る', () => {
    const plan = planDiffActions({ kind: 'rename', diff: 'irrelevant' });
    expect(plan).toEqual({
      openEditor: true,
      openDiff: false,
      revert: false,
      jumpToLine: undefined,
    });
  });
});
