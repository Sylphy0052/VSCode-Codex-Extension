import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeRunMetrics,
  recordMaxReached,
  type RunMetricsKeys,
} from '../../src/orchestrator/runMetrics';
import { collectRunMetricsKeys, writeRunMetrics } from '../../src/orchestrator/runMetricsStore';
import { MAX_GATES_PER_TASK, openStageGate } from '../../src/orchestrator/taskRunGates';
import { reconcileTaskRunOnReload } from '../../src/orchestrator/taskRunReload';
import {
  finishTaskRun,
  finishTaskRunIfDone,
  reopenTaskRun,
  type StageGate,
  type TaskRun,
} from '../../src/orchestrator/taskRunState';
import { TaskRunStore } from '../../src/orchestrator/taskRunStore';
import type { MementoLike } from '../../src/util/memento';
import { FIXTURE_NOW, haltedTask, makeRun, makeTask } from '../helpers/taskRunFixture';

/** Issue #2081: runごとの指標の計算と、終了の全経路からの1回だけの記録。 */

const KEYS: RunMetricsKeys = {
  extensionVersion: '1.0.0',
  promptHash: 'p',
  limitsHash: 'l',
  pluginHash: undefined,
  pluginCommits: {},
};

function createMemento(): MementoLike {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
  } as MementoLike;
}

function resolvedGate(id: string, by: 'reflex' | 'orchestrator' | 'user'): StageGate {
  return {
    gateId: id,
    kind: 'reviewFindings',
    stage: 'review',
    status: 'resolved',
    detail: '',
    reflexSummary: undefined,
    resolution: { choice: 'proceed', by, at: FIXTURE_NOW.toISOString() },
    openedAt: FIXTURE_NOW.toISOString(),
  };
}

function doneRun(): TaskRun {
  const task = makeTask('T1', 'mergeCleanup', 'done');
  return makeRun([task]);
}

const LATER = new Date('2026-09-30T01:00:00Z');

describe('computeRunMetrics', () => {
  it('終わっていないrunは計算しない', () => {
    expect(computeRunMetrics(makeRun([haltedTask('T1')]), KEYS)).toBeUndefined();
  });

  it('件数と子Issueあたりの所要時間を数える', () => {
    const t1 = haltedTask('T1', {
      reviewRounds: 2,
      gates: [resolvedGate('g1', 'reflex'), resolvedGate('g2', 'user')],
    });
    const t2 = haltedTask('T2', { gates: [resolvedGate('g3', 'orchestrator')] });
    const run = recordMaxReached({ ...makeRun([t1, t2]), finishedAt: LATER.toISOString() }, 'T1');
    const metrics = computeRunMetrics(run, KEYS);
    expect(metrics).toMatchObject({
      childIssues: 2,
      sendBacks: 2,
      maxReached: 1,
      gatesResolved: { reflex: 1, orchestrator: 1, user: 1 },
      msPerChildIssue: 1800000,
    });
  });

  it('関門が30件を超えて刈られても決着者の件数が正しい', () => {
    const gates: StageGate[] = [];
    for (let i = 0; i < MAX_GATES_PER_TASK; i += 1) {
      gates.push(resolvedGate(`g${String(i)}`, i < 20 ? 'reflex' : 'user'));
    }
    let run = makeRun([haltedTask('T1', { gates })]);
    // 31件目を開くと、決着済みの1件が刈られる
    for (let i = 0; i < 5; i += 1) {
      run = openStageGate(
        run,
        'T1',
        { gateId: `n${String(i)}`, kind: 'stageFailed', detail: '' },
        FIXTURE_NOW,
      );
      const task = run.tasks.T1;
      if (task === undefined) {
        throw new Error('タスクが無い');
      }
      // 開いた関門を決着させて次を開けるようにする
      run = {
        ...run,
        tasks: {
          ...run.tasks,
          T1: {
            ...task,
            gates: (task.gates ?? []).map((g) =>
              g.status === 'resolved'
                ? g
                : {
                    ...g,
                    status: 'resolved',
                    resolution: { choice: 'retry', by: 'user', at: 'x' },
                  },
            ),
          },
        },
      };
    }
    expect(run.tasks.T1?.gates?.length).toBe(MAX_GATES_PER_TASK);
    const metrics = computeRunMetrics({ ...run, finishedAt: LATER.toISOString() }, KEYS);
    expect(metrics?.gatesResolved).toEqual({ reflex: 20, orchestrator: 0, user: 15 });
  });
});

describe('終了の経路ごとの記録（store）', () => {
  function setup(): { store: TaskRunStore; finished: TaskRun[] } {
    const store = new TaskRunStore(createMemento());
    const finished: TaskRun[] = [];
    store.onRunFinished = (run) => finished.push(run);
    return { store, finished };
  }

  it('finishTaskRunIfDone（controller・stage runner）で終わると1回だけ通知する', async () => {
    const { store, finished } = setup();
    await store.update('run-1', () => makeRun([makeTask('T1', 'mergeCleanup', 'done')]));
    await store.update('run-1', (r) => finishTaskRunIfDone(r as TaskRun, LATER));
    await store.update('run-1', (r) => finishTaskRunIfDone(r as TaskRun, LATER));
    expect(finished).toHaveLength(1);
  });

  it('再読み込み（reconcile）で終わると1回だけ通知する', async () => {
    const { store, finished } = setup();
    await store.update('run-1', () => doneRun());
    await store.update('run-1', (r) => reconcileTaskRunOnReload(r as TaskRun, new Map(), LATER));
    await store.update('run-1', (r) => reconcileTaskRunOnReload(r as TaskRun, new Map(), LATER));
    expect(finished).toHaveLength(1);
  });

  it('人が終える（finishTaskRun）と1回だけ通知する', async () => {
    const { store, finished } = setup();
    await store.update('run-1', () => makeRun([haltedTask('T1')]));
    await store.update('run-1', (r) => finishTaskRun(r as TaskRun, LATER));
    await store.update('run-1', (r) => finishTaskRun(r as TaskRun, LATER));
    expect(finished).toHaveLength(1);
  });

  it('再開して終わり直しても、記録は同じrunIdの1ファイルのまま', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-metrics-'));
    try {
      const first = finishTaskRun(doneRun(), LATER);
      const m1 = computeRunMetrics(first, KEYS);
      if (m1 === undefined) {
        throw new Error('指標が無い');
      }
      expect(await writeRunMetrics(dir, m1)).toBe('written');
      expect(await writeRunMetrics(dir, m1)).toBe('skipped');
      const reopened = reopenTaskRun(first, new Date('2026-09-30T02:00:00Z'));
      const second = finishTaskRun(reopened, new Date('2026-09-30T03:00:00Z'));
      const m2 = computeRunMetrics(second, KEYS);
      if (m2 === undefined) {
        throw new Error('指標が無い');
      }
      expect(await writeRunMetrics(dir, m2)).toBe('written');
      expect(await fs.readdir(dir)).toEqual(['run-1.json']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('collectRunMetricsKeys', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-home-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('プロンプト・上限値・plugin側のハッシュと同期元のcommit SHAを入れる', async () => {
    await fs.mkdir(path.join(home, 'rules'), { recursive: true });
    await fs.writeFile(path.join(home, 'CLAUDE.md'), 'a');
    await fs.writeFile(path.join(home, 'rules', 'x.md'), 'b');
    await fs.mkdir(path.join(home, 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'p@m': [{ gitCommitSha: 'abcdef1234567' }] } }),
    );
    const src = { extensionVersion: '1.2.3', limits: { a: 1 }, claudeHome: home };
    const keys = await collectRunMetricsKeys(src);
    expect(keys.extensionVersion).toBe('1.2.3');
    expect(keys.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.limitsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.pluginHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.pluginCommits).toEqual({ 'p@m': 'abcdef1234567' });
    expect((await collectRunMetricsKeys({ ...src, limits: { a: 2 } })).limitsHash).not.toBe(
      keys.limitsHash,
    );
    await fs.writeFile(path.join(home, 'rules', 'x.md'), 'changed');
    expect((await collectRunMetricsKeys(src)).pluginHash).not.toBe(keys.pluginHash);
  });
});
