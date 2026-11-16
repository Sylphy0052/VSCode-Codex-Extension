import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeWorkflowRunMetrics,
  createWorkflowRunMetricsRecorder,
  tallyWorkflowRun,
  workflowRunLimits,
} from '../../src/orchestrator/retrospectiveMetrics/workflowRunMetrics';
import type { RunMetricsKeys } from '../../src/orchestrator/runMetrics';
import { hashWorkflowPrompts } from '../../src/orchestrator/runMetricsStore';
import { readAllRunMetrics } from '../../src/orchestrator/runRetrospective';
import {
  persistedTaskTimes,
  WorkflowRunStore,
  type PersistedRun,
  type PersistedTaskState,
  type WorkflowRunMemento,
} from '../../src/orchestrator/runStore';

const KEYS: RunMetricsKeys = {
  extensionVersion: '1.0.0',
  promptHash: 'p',
  limitsHash: 'l',
  pluginHash: undefined,
  pluginCommits: {},
};

function node(
  state: PersistedTaskState['state'],
  over: Partial<PersistedTaskState> = {},
): PersistedTaskState {
  return {
    state,
    sessionId: undefined,
    cwd: undefined,
    branch: undefined,
    submissionCount: 1,
    retryCount: 0,
    manualRetryCount: 0,
    failure: undefined,
    pullRequestNumber: undefined,
    pullRequestUrl: undefined,
    ...over,
  };
}

function run(over: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'wf-1',
    defPath: '/repo/.agents/workflows/a.yaml',
    workspaceRoot: '/repo',
    startedAt: '2026-11-16T00:00:00.000Z',
    finishedAt: '2026-11-16T01:00:00.000Z',
    tasks: {},
    haltedByUser: false,
    integrationBranch: '',
    integrationPullRequestNumber: undefined,
    integrationPullRequestUrl: undefined,
    finalMergeOutcome: undefined,
    pendingAskUser: undefined,
    ...over,
  };
}

function fakeMemento(): WorkflowRunMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('ワークフローのrunの指標（Issue #2122）', () => {
  it('失敗ノード・再試行・Reload再開・ノードあたりの所要時間を数える', () => {
    const tally = tallyWorkflowRun(
      run({
        tasks: {
          T1: node('done', {
            retryCount: 1,
            manualRetryCount: 1,
            reloadResumes: 1,
            startedAt: '2026-11-16T00:00:00.000Z',
            finishedAt: '2026-11-16T00:10:00.000Z',
          }),
          T2: node('failed', {
            retryCount: 2,
            startedAt: '2026-11-16T00:00:00.000Z',
            finishedAt: '2026-11-16T00:20:00.000Z',
          }),
          // 旧形式（manualRetryCountが無い・時刻が無い）も壊れない
          T3: node('skipped', { manualRetryCount: undefined }),
        },
      }),
    );
    expect(tally).toEqual({
      nodes: 3,
      failedNodes: 1,
      retries: 4,
      reloadResumes: 1,
      msPerNode: 15 * 60_000,
    });
  });

  it('ノード0件・時刻の揃ったノードが無いrunは所要時間を出さない', () => {
    expect(tallyWorkflowRun(run())).toEqual({
      nodes: 0,
      failedNodes: 0,
      retries: 0,
      reloadResumes: 0,
      msPerNode: undefined,
    });
    // 終了が開始より前の壊れた時刻は使わない
    const broken = tallyWorkflowRun(
      run({
        tasks: {
          T1: node('done', {
            startedAt: '2026-11-16T01:00:00.000Z',
            finishedAt: '2026-11-16T00:00:00.000Z',
          }),
        },
      }),
    );
    expect(broken.msPerNode).toBeUndefined();
  });

  it('kind: workflowで、task用の件数は0の指標を作る。終わっていないrunは作らない', () => {
    const m = computeWorkflowRunMetrics(run({ tasks: { T1: node('done') } }), KEYS);
    expect(m).toMatchObject({
      kind: 'workflow',
      runId: 'wf-1',
      childIssues: 0,
      msPerChildIssue: undefined,
      workflow: { nodes: 1 },
      keys: KEYS,
    });
    expect(computeWorkflowRunMetrics(run({ finishedAt: undefined }), KEYS)).toBeUndefined();
  });

  it('上限値にジョブごとのYAMLの値を入れない', () => {
    expect(Object.keys(workflowRunLimits(3)).sort()).toEqual([
      'defaultMaxIterations',
      'maxAutoResumeAttempts',
      'maxReloadResumes',
      'maxTaskVerificationAttempts',
    ]);
  });
});

describe('createWorkflowRunMetricsRecorder（Issue #2122）', () => {
  let dir: string;
  let claudeHome: string;
  let logs: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-metrics-'));
    claudeHome = path.join(dir, 'claude-home');
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const recorder = () =>
    createWorkflowRunMetricsRecorder({
      dir: path.join(dir, 'run-metrics'),
      extensionVersion: '1.0.0',
      claudeHome,
      limits: () => workflowRunLimits(3),
      providers: () => ['claude', 'codex', 'claude'],
      log: (m) => logs.push(m),
    });

  it('初めて書いたときだけ振り返りの入力を返し、同じrunの指標は1件だけ残る', async () => {
    const r = run({ tasks: { T1: node('done') } });
    const summary = await recorder()(r);
    expect(summary).toEqual({
      kind: 'workflow',
      runId: 'wf-1',
      workspaceRoot: '/repo',
      engines: ['claude', 'codex'],
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    });
    // Reload後に同じ終わりをもう一度通知されても、別の記録器（別のウィンドウ）でも振り返らない
    expect(await recorder()(r)).toBeUndefined();
    // 再実行で終わり直したrunは指標を置き換えるが、振り返らない
    const again = { ...r, finishedAt: '2026-11-16T02:00:00.000Z' };
    expect(await recorder()(again)).toBeUndefined();
    const all = await readAllRunMetrics(path.join(dir, 'run-metrics'), 'workflow');
    expect(all).toHaveLength(1);
    expect(all[0]?.finishedAt).toBe(again.finishedAt);
    // ワークフロー用のプロンプトのハッシュで群分けする
    expect(all[0]?.keys.promptHash).toBe(hashWorkflowPrompts());
    // taskの指標としては読まない
    expect(await readAllRunMetrics(path.join(dir, 'run-metrics'), 'task')).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  it('終わっていないrunは記録しない', async () => {
    expect(await recorder()(run({ finishedAt: undefined }))).toBeUndefined();
    await expect(fs.readdir(path.join(dir, 'run-metrics'))).rejects.toThrow();
  });
});

describe('ノードの開始・終了時刻の永続化（Issue #2122）', () => {
  const now = new Date('2026-11-16T00:30:00.000Z');
  const started = '2026-11-16T00:00:00.000Z';

  it('このウィンドウで動いた試行は、終わった状態になった時刻を終了時刻にする', () => {
    expect(persistedTaskTimes('running', started, undefined, now)).toEqual({ startedAt: started });
    expect(persistedTaskTimes('done', started, { startedAt: started }, now)).toEqual({
      startedAt: started,
      finishedAt: now.toISOString(),
    });
  });

  it('同じ試行の終了時刻は引き継ぎ、再実行で走り直すと消える', () => {
    const prev = { startedAt: started, finishedAt: '2026-11-16T00:10:00.000Z' };
    expect(persistedTaskTimes('failed', started, prev, now)).toEqual(prev);
    const retried = '2026-11-16T00:20:00.000Z';
    expect(persistedTaskTimes('running', retried, prev, now)).toEqual({ startedAt: retried });
    expect(persistedTaskTimes('done', retried, prev, now)).toEqual({
      startedAt: retried,
      finishedAt: now.toISOString(),
    });
  });

  it('リロードで復元しただけのノードには終了時刻を足さない。開始していないノードは何も持たない', () => {
    expect(persistedTaskTimes('failed', undefined, { startedAt: started }, now)).toEqual({
      startedAt: started,
    });
    expect(persistedTaskTimes('skipped', undefined, undefined, now)).toEqual({});
  });
});

describe('WorkflowRunStore.onRunFinished（Issue #2122）', () => {
  it('finishedAtが埋まった更新の後に1回だけ呼ぶ', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const finished: string[] = [];
    store.onRunFinished = (r) => finished.push(r.finishedAt ?? '');
    await store.update('wf-1', () => run({ finishedAt: undefined }));
    await store.update('wf-1', () => run());
    await store.update('wf-1', (cur) => ({ ...run(), finishedAt: cur?.finishedAt }));
    expect(finished).toEqual(['2026-11-16T01:00:00.000Z']);
    // 再実行で走り直して終わり直したら、もう一度呼ぶ（振り返るかは記録器が決める）
    await store.update('wf-1', () => run({ finishedAt: undefined }));
    await store.update('wf-1', () => run({ finishedAt: '2026-11-16T02:00:00.000Z' }));
    expect(finished).toHaveLength(2);
  });

  it('リロード直後のreconcileでは呼ばない', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const finished: string[] = [];
    await store.update('wf-1', () =>
      run({ finishedAt: undefined, tasks: { T1: node('running') } }),
    );
    store.onRunFinished = (r) => finished.push(r.runId);
    const [reconciled] = await store.reconcileAfterReload();
    expect(reconciled?.finishedAt).toBeDefined();
    expect(finished).toEqual([]);
  });
});
