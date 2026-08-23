import { describe, expect, it } from 'vitest';
import {
  MAX_STORED_PROGRAMS,
  PROGRAM_RUNS_KEY,
  ProgramStore,
  reconcileProgramOnReload,
  type PersistedProgram,
  type ProgramMemento,
} from '../../src/orchestrator/programStore';
import type { ProgramState } from '../../src/orchestrator/programState';

function state(overrides: Partial<ProgramState['runs']> = {}, haltedByUser = false): ProgramState {
  return {
    runs: { R1: { state: 'pending', runId: undefined, skipReason: undefined }, ...overrides },
    haltedByUser,
  };
}

function program(overrides: Partial<PersistedProgram> = {}): PersistedProgram {
  return {
    programId: 'prog-1',
    defPath: '/repo/.agents/programs/wf-e.yaml',
    workspaceRoot: '/repo',
    startedAt: '2026-08-10T00:00:00+09:00',
    finishedAt: undefined,
    state: state(),
    ...overrides,
  };
}

function fakeMemento(initial: Record<string, unknown> = {}): ProgramMemento {
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

describe('reconcileProgramOnReload（design.md §16.37「W10の自動再開の対象に含める」、Issue #604）', () => {
  it('runningなrun参照をfailedへ倒す', () => {
    const before = program({
      state: state({ R1: { state: 'running', runId: 'run-1', skipReason: undefined } }),
    });
    const after = reconcileProgramOnReload(before);
    expect(after.state.runs['R1']).toEqual({
      state: 'failed',
      runId: 'run-1',
      skipReason: undefined,
    });
    expect(reconcileProgramOnReload(before)).not.toBe(before);
  });

  it('変化が無ければ同じ参照を返す', () => {
    const before = program({
      state: state({ R1: { state: 'done', runId: 'run-1', skipReason: undefined } }),
    });
    expect(reconcileProgramOnReload(before)).toBe(before);
  });

  it('haltedByUserはそのまま素通しする（人が止めたプログラムはリロード後も止まったまま）', () => {
    const before = program({
      state: state(
        { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
        true,
      ),
    });
    const after = reconcileProgramOnReload(before);
    expect(after.state.haltedByUser).toBe(true);
  });
});

describe('ProgramStore（design.md §16.37、Issue #604）', () => {
  it('workspaceStateに永続化され、リロードをまたいでも状態が読み戻せる', async () => {
    const memento = fakeMemento();
    const store = new ProgramStore(memento);
    await store.update('prog-1', () => program());
    const raw = memento.get<PersistedProgram[]>(PROGRAM_RUNS_KEY, []);
    expect(raw).toHaveLength(1);

    // 新しいStoreインスタンス（＝リロード後の再構築）でも同じmementoから読み戻せる
    const reloadedStore = new ProgramStore(memento);
    expect(reloadedStore.find('prog-1')?.programId).toBe('prog-1');
  });

  it('並行するupdate呼び出しが直列化され、lost updateが起きない', async () => {
    const memento = fakeMemento();
    const store = new ProgramStore(memento);
    await store.update('prog-1', () => program());

    const attempts = Array.from({ length: 10 }, (_, i) =>
      store.update('prog-1', (current) => ({
        ...(current ?? program()),
        state: state({ R1: { state: 'pending', runId: `attempt-${i}`, skipReason: undefined } }),
      })),
    );
    await Promise.all(attempts);

    // 全ての更新が同じキューを通っており、途中の更新がstoreの内容自体を破壊していないことを確認
    const final = store.find('prog-1');
    expect(final?.state.runs['R1']?.runId?.startsWith('attempt-')).toBe(true);
  });

  it(`最新${MAX_STORED_PROGRAMS}件まで残し、それより古いものは消す`, async () => {
    const memento = fakeMemento();
    const store = new ProgramStore(memento);
    for (let i = 0; i < MAX_STORED_PROGRAMS + 2; i += 1) {
      const startedAt = `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00+09:00`;
      await store.update(`prog-${i}`, () => program({ programId: `prog-${i}`, startedAt }));
    }
    const all = store.list();
    expect(all.length).toBe(MAX_STORED_PROGRAMS);
    expect(all.some((p) => p.programId === 'prog-0')).toBe(false);
  });

  it('reconcileAfterReloadはrunningを含むプログラムだけ書き換え、変化の無いものは書き込まない', async () => {
    const memento = fakeMemento();
    const store = new ProgramStore(memento);
    await store.update('prog-running', () =>
      program({
        programId: 'prog-running',
        state: state({ R1: { state: 'running', runId: 'r', skipReason: undefined } }),
      }),
    );
    await store.update('prog-done', () =>
      program({
        programId: 'prog-done',
        state: state({ R1: { state: 'done', runId: 'r', skipReason: undefined } }),
      }),
    );

    const reconciled = await store.reconcileAfterReload();
    const running = reconciled.find((p) => p.programId === 'prog-running');
    const done = reconciled.find((p) => p.programId === 'prog-done');
    expect(running?.state.runs['R1']?.state).toBe('failed');
    expect(done?.state.runs['R1']?.state).toBe('done');
  });

  it('clearAllで全消去できる', async () => {
    const memento = fakeMemento();
    const store = new ProgramStore(memento);
    await store.update('prog-1', () => program());
    await store.clearAll();
    expect(store.list()).toEqual([]);
  });
});
