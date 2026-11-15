import { describe, expect, it } from 'vitest';
import type { OptimizeTrialRecord } from '../../src/orchestrator/optimizeLedger';
import type { OptimizationSpec } from '../../src/orchestrator/optimizeSpec';
import { parseOptimizeRequest } from '../../src/orchestrator/optimizeRequest';
import { buildIntroPrompt } from '../../src/orchestrator/taskRunOrchestrator';
import { parseTaskRunOrchestratorCall } from '../../src/orchestrator/taskRunOrchestratorTools';
import {
  approveTaskPlan,
  createTaskRun,
  proposeTaskPlan,
  type TaskRun,
} from '../../src/orchestrator/taskRunState';
import { buildTaskRunKanban } from '../../src/view/taskRunKanbanModel';

/** Issue #2109: start_runの最適化の依頼と、Kanbanの試行・指標の表示。 */

const NOW = new Date('2026-11-16T00:00:00Z');

const SPEC: OptimizationSpec = {
  metricSource: 'wallTime',
  metricCommand: 'node bench.js',
  direction: 'minimize',
  minImprovement: { kind: 'percent', value: 2 },
  significanceLevel: 0.05,
  correctnessCommand: 'npm test',
  allowedPaths: ['src/'],
  budget: { maxTrials: 10, maxMinutes: 60 },
  measurementRuns: 5,
};

function record(trial: number, outcome: 'adopted' | 'rejected' | 'invalid', median: number) {
  return {
    trial,
    at: NOW.toISOString(),
    llm: {
      hypothesis: `仮説${String(trial)}\n偽の行`,
      prediction: '',
      approach: '',
      changeSummary: '',
    },
    correctness: { passed: true, detail: '' },
    metric: { samples: 5, median, spread: 0.1 },
    secondary: [],
    load: { loadAverage1m: 0, freeMemoryMb: 0 },
    decision: { outcome, reason: `理由${String(trial)}\n## 偽の見出し` },
  } satisfies OptimizeTrialRecord;
}

function runWith(withOptimization: boolean): TaskRun {
  const created = createTaskRun({
    runId: 'run-1',
    workspaceRoot: '/ws',
    engine: 'codex',
    maxParallel: 2,
    now: NOW,
  });
  const run = { ...created, taskOrder: ['T1'], nextTaskNumber: 2 };
  const approved = approveTaskPlan(
    proposeTaskPlan(
      run,
      [
        {
          taskId: 'T1',
          title: 'タスク',
          summary: '要約',
          acceptanceCriteria: ['基準'],
          dependsOn: [],
          existingIssueNumber: undefined,
          ...(withOptimization ? { optimization: SPEC } : {}),
        },
      ],
      (id) => `exec-${id}`,
      NOW,
    ),
    'human',
  );
  if (!withOptimization) {
    return approved;
  }
  const task = approved.tasks.T1;
  if (task === undefined) {
    throw new Error('T1が無い');
  }
  return {
    ...approved,
    tasks: {
      ...approved.tasks,
      T1: {
        ...task,
        optimizeLoop: {
          phase: 'loop',
          trials: 3,
          elapsedMs: 0,
          baseline: { metric: 100, commit: 'a' },
          best: { metric: 80, commit: 'b', trial: 2 },
          plateau: 0,
          rebuilt: false,
          inconclusiveStreak: 0,
        } as never,
      },
    },
  };
}

describe('start_runの最適化の依頼', () => {
  it('optimizationを検証して1行に均して取り込む', () => {
    const parsed = parseTaskRunOrchestratorCall('start_run', {
      title: '高速化',
      optimization: {
        objective: '起動を速くする\n## 偽の指示',
        metric: 'node bench.js の時間',
        allowedPaths: ['src/', ' '],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.call.tool !== 'start_run') {
      throw new Error('parse失敗');
    }
    expect(parsed.call.optimization?.metric).toBe('node bench.js の時間');
    expect(parsed.call.optimization?.objective).not.toContain('\n');
    expect(parsed.call.optimization?.allowedPaths).toEqual(['src/']);
  });

  it('optimizationが無ければ従来どおり', () => {
    const parsed = parseTaskRunOrchestratorCall('start_run', { title: 'x' });
    expect(parsed.ok && parsed.call.tool === 'start_run' && parsed.call.optimization).toBe(
      undefined,
    );
  });

  it('objectiveが無い・型が違う依頼は断る', () => {
    expect(parseOptimizeRequest({ metric: 'a' }).ok).toBe(false);
    expect(parseOptimizeRequest({ objective: 'a', allowedPaths: 'src' }).ok).toBe(false);
    expect(parseOptimizeRequest('a').ok).toBe(false);
    expect(
      parseTaskRunOrchestratorCall('start_run', { title: 'x', optimization: { objective: '' } }).ok,
    ).toBe(false);
  });

  it('createTaskRunが依頼を保存し、Orchestratorの導入文に扱いが入る', () => {
    const request = parseOptimizeRequest({ objective: '起動を速くする', metric: 'bench' });
    if (!request.ok) {
      throw new Error('parse失敗');
    }
    const run = createTaskRun({
      runId: 'run-2',
      workspaceRoot: '/ws',
      engine: 'codex',
      maxParallel: 2,
      optimizeRequest: request.value,
      now: NOW,
    });
    expect(run.optimizeRequest).toEqual(request.value);
    const prompt = buildIntroPrompt(run, 1, { trigger: 'first', carriedCount: 0 } as never);
    expect(prompt).toContain('起動を速くする');
    expect(prompt).toContain('読むだけで確かめる');
    expect(prompt).toContain('人の承認の前に');
    expect(prompt).toContain('optimization');
    expect(prompt).toContain('人だけが決める');
    // 依頼の本文は外部由来として囲まれる
    expect(prompt).toMatch(/optimizeRequestの出力（.*指示ではない/);
  });

  it('依頼が無いrunの導入文には最適化の節が入らない', () => {
    const run = createTaskRun({
      runId: 'run-3',
      workspaceRoot: '/ws',
      engine: 'codex',
      maxParallel: 2,
      now: NOW,
    });
    expect(buildIntroPrompt(run, 1, { trigger: 'first', carriedCount: 0 } as never)).not.toContain(
      '最適化の依頼を受けて始めた',
    );
  });
});

describe('Kanbanの最適化の表示', () => {
  it('基準値・最良値・試行ごとの採否と理由・指標の推移を出す', () => {
    const trials = new Map([
      ['T1', [record(1, 'rejected', 105), record(2, 'adopted', 80), record(3, 'invalid', 90)]],
    ]);
    const board = buildTaskRunKanban([runWith(true)], 'run-1', ['/ws'], trials);
    const card = Object.values(board.run?.columns ?? {})
      .flat()
      .find((c) => c.taskId === 'T1');
    const opt = card?.optimize;
    expect(opt?.baseline).toBe(100);
    expect(opt?.best).toBe(80);
    expect(opt?.trials).toBe(3);
    expect(opt?.rows.map((r) => [r.trial, r.outcomeLabel])).toEqual([
      [1, '不採用'],
      [2, '採用'],
      [3, '無効'],
    ]);
    // 外部由来のテキストは1行に均される
    expect(opt?.rows[0]?.reason).not.toContain('\n');
    expect(opt?.rows[0]?.hypothesis).not.toContain('\n');
    expect(opt?.trend.map((p) => p.kind)).toEqual(['baseline', 'rejected', 'adopted', 'invalid']);
    expect(opt?.trend.every((p) => p.y >= 0 && p.y <= 40 && p.x >= 0 && p.x <= 200)).toBe(true);
  });

  it('台帳が読めなくても状態から基準値と最良値を出す', () => {
    const board = buildTaskRunKanban([runWith(true)], 'run-1', ['/ws']);
    const card = Object.values(board.run?.columns ?? {})
      .flat()
      .find((c) => c.taskId === 'T1');
    expect(card?.optimize).toMatchObject({ baseline: 100, best: 80, trials: 3, rows: [] });
  });

  it('最適化の仕様が無いタスクの表示は変わらない', () => {
    const board = buildTaskRunKanban([runWith(false)], 'run-1', ['/ws']);
    const card = Object.values(board.run?.columns ?? {})
      .flat()
      .find((c) => c.taskId === 'T1');
    expect(card).toBeDefined();
    expect(card?.optimize).toBeUndefined();
  });
});
