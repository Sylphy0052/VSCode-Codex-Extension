import { describe, expect, it } from 'vitest';
import {
  reconcileRunOnReload,
  WORKFLOW_RUNS_KEY,
  WorkflowRunStore,
  type PersistedRun,
  type PersistedTaskState,
  type WorkflowRunMemento,
} from '../../src/orchestrator/runStore';

function task(state: PersistedTaskState['state']): PersistedTaskState {
  return {
    state,
    sessionId: state === 'pending' ? undefined : 'session-1',
    cwd: state === 'pending' ? undefined : '/repo/task',
    branch: state === 'pending' ? undefined : 'wf/run-1/T1',
    submissionCount: state === 'pending' ? 0 : 1,
    retryCount: 0,
    manualRetryCount: 0,
    failure: undefined,
    pullRequestNumber: undefined,
    pullRequestUrl: undefined,
  };
}

function run(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'run-1',
    defPath: '/repo/.agents/workflows/a.yaml',
    workspaceRoot: '/repo',
    startedAt: '2026-08-10T00:00:00+09:00',
    finishedAt: undefined,
    tasks: { T1: task('running') },
    haltedByUser: false,
    integrationBranch: 'wf/run-1/integration',
    integrationPullRequestNumber: undefined,
    integrationPullRequestUrl: undefined,
    finalMergeOutcome: undefined,
    ...overrides,
  };
}

/** `vscode.Memento` を模した最小のインメモリ実装。 */
function fakeMemento(initial: Record<string, unknown> = {}): WorkflowRunMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
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

describe('reconcileRunOnReload（design.md §16.11）', () => {
  it('running / waitingApproval のタスクをfailed（理由: 中断）にする', () => {
    const before = run({ tasks: { T1: task('running'), T2: task('waitingApproval') } });
    const after = reconcileRunOnReload(before);
    expect(after.tasks['T1']?.state).toBe('failed');
    expect(after.tasks['T1']?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(after.tasks['T2']?.state).toBe('failed');
    expect(after.tasks['T2']?.failure).toEqual({ kind: 'reloadInterrupted' });
  });

  it('まだ開始していないpendingはskipped（runHalted）にする', () => {
    const before = run({ tasks: { T3: task('pending') } });
    const after = reconcileRunOnReload(before);
    expect(after.tasks['T3']?.state).toBe('skipped');
    expect(after.tasks['T3']?.failure).toEqual({ kind: 'runHalted' });
  });

  it('done / failed / skipped は既に確定しているため触らない', () => {
    const before = run({
      tasks: { T1: task('done'), T2: task('failed'), T3: task('skipped') },
    });
    const after = reconcileRunOnReload(before);
    expect(after).toBe(before);
  });

  it('変化が無ければ同一オブジェクトを返す（無駄な書き込みを避ける）', () => {
    const before = run({ tasks: { T1: task('done') } });
    expect(reconcileRunOnReload(before)).toBe(before);
  });
});

describe('WorkflowRunStore（design.md §16.11）', () => {
  it('workspaceStateに応答本文を保存しない（PersistedTaskStateに本文フィールドが無いことを型・実測の両面で確かめる）', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    await store.update('run-1', () => run());
    const raw = memento.get<PersistedRun[]>(WORKFLOW_RUNS_KEY, []);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain('turnResultText');
    expect(serialized).not.toContain('result');
  });

  it('並行するupdate呼び出しが直列化され、lost updateが起きない', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    // submissionCount: 0 から始める（task('running')の既定値ではなく、増分だけを見るため）
    await store.update('run-1', () =>
      run({ tasks: { T1: { ...task('running'), submissionCount: 0 } } }),
    );

    // 同じrunへ「読んで1増やして書く」更新を10回並行で投げる。直列化されていなければ
    // 後勝ちで一部の更新が失われ、10より小さい値になる
    const increments = Array.from({ length: 10 }, () =>
      store.update('run-1', (current) => {
        const submissionCount = (current?.tasks['T1']?.submissionCount ?? 0) + 1;
        return {
          ...(current ?? run()),
          tasks: { T1: { ...task('running'), submissionCount } },
        };
      }),
    );
    await Promise.all(increments);

    const final = store.find('run-1');
    expect(final?.tasks['T1']?.submissionCount).toBe(10);
  });

  it('最新10件まで残し、それより古いものは消す', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    for (let i = 0; i < 12; i += 1) {
      const startedAt = `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00+09:00`;
      await store.update(`run-${i}`, () => run({ runId: `run-${i}`, startedAt }));
    }
    const all = store.list();
    expect(all.length).toBe(10);
    // 古いもの（run-0, run-1）は落ちている
    expect(all.some((r) => r.runId === 'run-0')).toBe(false);
    expect(all.some((r) => r.runId === 'run-11')).toBe(true);
  });

  it(
    'PR/MRフィールドが無い旧形式のデータを読んでも壊れない' +
      '（design.md §16.11、Issue #118「既存の永続データを読めなくしないこと」）',
    () => {
      const legacyRun = {
        runId: 'run-legacy',
        defPath: '/repo/.agents/workflows/a.yaml',
        workspaceRoot: '/repo',
        startedAt: '2026-08-10T00:00:00+09:00',
        finishedAt: undefined,
        tasks: {
          T1: {
            state: 'done',
            sessionId: 'session-1',
            cwd: '/repo/task',
            branch: 'wf/run-legacy/T1',
            submissionCount: 1,
            retryCount: 0,
            manualRetryCount: 0,
            failure: undefined,
            // pullRequestNumber / pullRequestUrl を持たない旧形式
          },
        },
        haltedByUser: false,
        integrationBranch: 'wf/run-legacy/integration',
        // integrationPullRequestNumber / integrationPullRequestUrl / finalMergeOutcome を持たない旧形式
      };
      const memento = fakeMemento({ [WORKFLOW_RUNS_KEY]: [legacyRun] });
      const store = new WorkflowRunStore(memento);
      const found = store.find('run-legacy');
      expect(found?.tasks['T1']?.state).toBe('done');
      expect(found?.tasks['T1']?.pullRequestNumber).toBeUndefined();
      expect(found?.tasks['T1']?.pullRequestUrl).toBeUndefined();
      expect(found?.integrationPullRequestNumber).toBeUndefined();
      expect(found?.integrationPullRequestUrl).toBeUndefined();
      expect(found?.finalMergeOutcome).toBeUndefined();
    },
  );

  it('PR/MRの番号・URL・最終マージの成否を保存・復元できる（design.md §16.11、Issue #118）', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    await store.update('run-1', () =>
      run({
        tasks: {
          T1: {
            ...task('done'),
            pullRequestNumber: 42,
            pullRequestUrl: 'https://github.com/acme/repo/pull/42',
          },
        },
        integrationPullRequestNumber: 7,
        integrationPullRequestUrl: 'https://github.com/acme/repo/pull/7',
        finalMergeOutcome: 'merged',
      }),
    );
    const found = store.find('run-1');
    expect(found?.tasks['T1']?.pullRequestNumber).toBe(42);
    expect(found?.tasks['T1']?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
    expect(found?.integrationPullRequestNumber).toBe(7);
    expect(found?.integrationPullRequestUrl).toBe('https://github.com/acme/repo/pull/7');
    expect(found?.finalMergeOutcome).toBe('merged');
  });

  it('clearAllで全消去する', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    await store.update('run-1', () => run());
    await store.clearAll();
    expect(store.list()).toEqual([]);
  });

  it('reconcileAfterReloadは全runの走行中タスクを中断扱いへ書き換える', async () => {
    const memento = fakeMemento();
    const store = new WorkflowRunStore(memento);
    await store.update('run-1', () => run({ tasks: { T1: task('running') } }));
    await store.update('run-2', () => run({ runId: 'run-2', tasks: { T1: task('done') } }));

    const reconciled = await store.reconcileAfterReload();
    const run1 = reconciled.find((r) => r.runId === 'run-1');
    const run2 = reconciled.find((r) => r.runId === 'run-2');
    expect(run1?.tasks['T1']?.state).toBe('failed');
    expect(run2?.tasks['T1']?.state).toBe('done');

    // 永続化にも反映されている
    expect(store.find('run-1')?.tasks['T1']?.state).toBe('failed');
  });
});
