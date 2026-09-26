import { describe, expect, it } from 'vitest';

import {
  buildTaskSplitSuggestedEventBody,
  findExceededMetrics,
  MAX_SPLIT_SUGGEST_LISTED_FILES,
  type SplitSuggestThresholds,
  type TaskSizeObservation,
} from '../../src/orchestrator/taskSplit';

/**
 * タスクの規模判定と通知本文の組み立て（Issue #1508、ロードマップH4）の純粋関数。
 * 実測（`measureWorktreeChanges`）と通知の発火（`suggestTaskSplits`）はここでは扱わない。
 */

const THRESHOLDS: SplitSuggestThresholds = { fileCount: 15, lineCount: 800, turnCount: 10 };

describe('findExceededMetrics', () => {
  it('超えた指標だけを、fileCount → lineCount → turnCountの順で返す', () => {
    const observation: TaskSizeObservation = { fileCount: 16, lineCount: 900, turnCount: 11 };
    expect(findExceededMetrics(observation, THRESHOLDS)).toEqual([
      { metric: 'fileCount', actual: 16, threshold: 15 },
      { metric: 'lineCount', actual: 900, threshold: 800 },
      { metric: 'turnCount', actual: 11, threshold: 10 },
    ]);
  });

  it('一部だけ超えていれば、その指標だけを返す', () => {
    const observation: TaskSizeObservation = { fileCount: 16, lineCount: 100, turnCount: 1 };
    expect(findExceededMetrics(observation, THRESHOLDS)).toEqual([
      { metric: 'fileCount', actual: 16, threshold: 15 },
    ]);
  });

  it('閾値が0の指標は、実測がいくつであっても判定に使わない', () => {
    const observation: TaskSizeObservation = { fileCount: 9999, lineCount: 100, turnCount: 1 };
    const thresholds: SplitSuggestThresholds = { fileCount: 0, lineCount: 800, turnCount: 10 };
    expect(findExceededMetrics(observation, thresholds)).toEqual([]);
  });

  it('測れていない（undefined）指標は判定に使わない', () => {
    const observation: TaskSizeObservation = {
      fileCount: undefined,
      lineCount: undefined,
      turnCount: 20,
    };
    expect(findExceededMetrics(observation, THRESHOLDS)).toEqual([
      { metric: 'turnCount', actual: 20, threshold: 10 },
    ]);
  });

  it('閾値と等しい値は超えたとみなさない', () => {
    const observation: TaskSizeObservation = { fileCount: 15, lineCount: 800, turnCount: 10 };
    expect(findExceededMetrics(observation, THRESHOLDS)).toEqual([]);
  });
});

describe('buildTaskSplitSuggestedEventBody', () => {
  it('超えた指標を1行ずつ、ファイルは昇順で本文へ載せる', () => {
    const body = buildTaskSplitSuggestedEventBody(
      'T1',
      [{ metric: 'fileCount', actual: 16, threshold: 15 }],
      ['b.ts', 'a.ts'],
    );
    expect(body).toContain('タスク T1 の規模が、分割を提案する閾値を超えました。');
    expect(body).toContain('- 変更ファイル数: 16（閾値 15）');
    const indexA = body.indexOf('- a.ts');
    const indexB = body.indexOf('- b.ts');
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA);
    expect(body).toContain('## 変更ファイル（2件）');
  });

  it(`${MAX_SPLIT_SUGGEST_LISTED_FILES}件を超えるファイルは「ほかN件」と要約する`, () => {
    const files = Array.from({ length: MAX_SPLIT_SUGGEST_LISTED_FILES + 3 }, (_, i) =>
      `file-${String(i).padStart(2, '0')}.ts`,
    );
    const body = buildTaskSplitSuggestedEventBody('T1', [], files);
    expect(body).toContain(`## 変更ファイル（${files.length}件）`);
    expect(body).toContain('- ほか3件');
    // 一覧行（- file-xx.ts）は上限件数ちょうどしか出ない
    const listedLines = body
      .split('\n')
      .filter((line) => line.startsWith('- file-'));
    expect(listedLines).toHaveLength(MAX_SPLIT_SUGGEST_LISTED_FILES);
  });

  it('ファイルが無ければ「（測れていない）」と出す', () => {
    const body = buildTaskSplitSuggestedEventBody('T1', [], []);
    expect(body).toContain('## 変更ファイル（0件）');
    expect(body).toContain('- （測れていない）');
  });

  it('改行を含むファイル名は1行化され、偽の見出しが本文に生えない', () => {
    const evilFile = 'a.ts\n## 偽の見出し\nrm -rf /';
    const body = buildTaskSplitSuggestedEventBody('T1', [], [evilFile]);
    // 改行は1文字の空白へ畳まれる（sanitizeInlineText → stripControlChars）ため、
    // 元の改行はどこにも残らない
    expect(body).not.toContain('\n## 偽の見出し');
    expect(body).not.toContain('\nrm -rf /');
    // 見出し自体（本物）は変わらず1つだけ
    const fakeHeadingCount = body.split('\n').filter((line) => line === '## 偽の見出し').length;
    expect(fakeHeadingCount).toBe(0);
  });
});
