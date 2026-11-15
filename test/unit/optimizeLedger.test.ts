import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LLM_TEXT_MAX_LENGTH,
  OptimizeLedgerStore,
  ledgerFilePath,
  recentTrials,
  summarizeTrials,
  type OptimizeTrialRecord,
} from '../../src/orchestrator/optimizeLedger';
import { describeOptimization, parseOptimizationSpec } from '../../src/orchestrator/optimizeSpec';

/** Issue #2106: 台帳の型と置き場所、仕様の検証・表示。 */

function trial(
  n: number,
  median: number,
  outcome: 'adopted' | 'rejected',
  extra = {},
): OptimizeTrialRecord {
  return {
    trial: n,
    at: '2026-11-16T00:00:00.000Z',
    llm: { hypothesis: '仮説', prediction: '予測', approach: '方式', changeSummary: '変更' },
    correctness: { passed: true, detail: 'ok' },
    metric: { samples: 7, median, spread: 0.1, significant: true },
    secondary: [],
    load: { loadAverage1m: 0.5, freeMemoryMb: 1000 },
    decision: { outcome, reason: '理由' },
    ...extra,
  };
}

describe('台帳', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimize-ledger-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('globalStorageのoptimize/<runId>/<taskId>.jsonlへ1試行1行で追記し、読み戻せる', async () => {
    const store = new OptimizeLedgerStore(dir);
    await store.append('run-1', 'T1', trial(1, 10, 'adopted', { commit: 'abc' }));
    await store.append('run-1', 'T1', trial(2, 12, 'rejected'));

    const text = await fs.readFile(path.join(dir, 'optimize', 'run-1', 'T1.jsonl'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    const records = await store.read('run-1', 'T1');
    expect(records.map((r) => r.trial)).toEqual([1, 2]);
    expect(await store.read('run-1', 'T9')).toEqual([]);
  });

  it('LLMが書いた欄は1欄ごとに切り詰め、改行を含んでも1行に収まる', async () => {
    const store = new OptimizeLedgerStore(dir);
    const long = 'あ'.repeat(LLM_TEXT_MAX_LENGTH + 500);
    const record = trial(1, 1, 'adopted');
    await store.append('r', 'T1', {
      ...record,
      llm: { ...record.llm, hypothesis: `${long}\nx`, approach: 'a\nb' },
    });

    const text = await fs.readFile(ledgerFilePath(dir, 'r', 'T1'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    const [read] = await store.read('r', 'T1');
    expect(Array.from(read?.llm.hypothesis ?? '').length).toBe(LLM_TEXT_MAX_LENGTH + 1);
    expect(read?.llm.approach).toBe('a\nb');
  });

  it('壊れた行は飛ばす。不正なIDはパスを作らず例外にする', async () => {
    const store = new OptimizeLedgerStore(dir);
    await store.append('r', 'T1', trial(1, 1, 'adopted'));
    await fs.appendFile(ledgerFilePath(dir, 'r', 'T1'), '{broken\n');
    expect(await store.read('r', 'T1')).toHaveLength(1);
    expect(() => ledgerFilePath(dir, '../x', 'T1')).toThrow();
    expect(() => ledgerFilePath(dir, 'r', '../T1')).toThrow();
  });

  it('TaskRunへ持たせる要約は試行数・基準値・最良値・最良のcommitだけ', () => {
    const records = [
      trial(1, 10, 'adopted', { commit: 'a1' }),
      trial(2, 8, 'adopted', { commit: 'b2' }),
      trial(3, 5, 'rejected'),
    ];
    expect(summarizeTrials(records, 'minimize', 12)).toEqual({
      trials: 3,
      baseline: 12,
      best: 8,
      bestCommit: 'b2',
    });
    expect(summarizeTrials(records, 'maximize', undefined)).toEqual({
      trials: 3,
      best: 10,
      bestCommit: 'a1',
    });
    expect(summarizeTrials([], 'minimize', undefined)).toEqual({ trials: 0 });
    expect(recentTrials(records, 2).map((r) => r.trial)).toEqual([2, 3]);
  });
});

describe('最適化の仕様', () => {
  const base = {
    metricCommand: 'node bench.js',
    direction: 'minimize',
    minImprovement: { kind: 'absolute', value: 5 },
    significanceLevel: 0.05,
    correctnessCommand: 'npm test',
    allowedPaths: ['src/a', './src/b/'],
    budget: { maxTrials: 10, maxMinutes: 60 },
    measurementRuns: 5,
  };

  it('metricSourceの既定はwallTime。全項目をコマンドの全文で表示する', () => {
    const parsed = parseOptimizationSpec(
      { ...base, setupCommand: 'npm ci && npm run build', target: 3 },
      'o',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.metricSource).toBe('wallTime');
    expect(parsed.value.allowedPaths).toEqual(['src/a', 'src/b']);
    const lines = Object.fromEntries(
      describeOptimization(parsed.value).map((l) => [l.label, l.value]),
    );
    expect(lines['準備のコマンド']).toBe('npm ci && npm run build');
    expect(lines['指標のコマンド']).toBe('node bench.js');
    expect(lines['正しさの確認コマンド']).toBe('npm test');
    expect(lines['変更してよいパス']).toBe('src/a / src/b');
    expect(lines['目標値']).toBe('3');
  });

  it('副指標はfileのときだけ。重複・valueの名前・範囲外は拒否する', () => {
    const file = { ...base, metricSource: 'file', metricFile: 'out.json' };
    const secondary = {
      name: 'mem',
      direction: 'minimize',
      tolerance: { kind: 'percent', value: 5 },
    };
    expect(parseOptimizationSpec({ ...file, secondaryMetrics: [secondary] }, 'o').ok).toBe(true);
    expect(parseOptimizationSpec({ ...base, secondaryMetrics: [secondary] }, 'o').ok).toBe(false);
    expect(
      parseOptimizationSpec({ ...file, secondaryMetrics: [secondary, secondary] }, 'o').ok,
    ).toBe(false);
    expect(
      parseOptimizationSpec({ ...file, secondaryMetrics: [{ ...secondary, name: 'value' }] }, 'o')
        .ok,
    ).toBe(false);
    expect(parseOptimizationSpec({ ...base, significanceLevel: 0.9 }, 'o').ok).toBe(false);
    expect(
      parseOptimizationSpec({ ...base, budget: { maxTrials: 0, maxMinutes: 1 } }, 'o').ok,
    ).toBe(false);
    expect(parseOptimizationSpec({ ...base, allowedPaths: ['/etc'] }, 'o').ok).toBe(false);
    expect(parseOptimizationSpec('x', 'o').ok).toBe(false);
  });
});
