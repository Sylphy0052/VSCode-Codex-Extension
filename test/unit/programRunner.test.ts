import { describe, expect, it, vi } from 'vitest';
import { ProgramRunner, type ProgramWorkflowPort } from '../../src/orchestrator/programRunner';
import { ProgramStore, type ProgramMemento, type PersistedProgram } from '../../src/orchestrator/programStore';
import type { WorkflowFilePort } from '../../src/orchestrator/runner';
import type { RunOutcome } from '../../src/orchestrator/scheduler';
import type { Logger } from '../../src/log';

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

function fakeFilePort(files: Record<string, string>): WorkflowFilePort {
  return {
    async fileSize(p: string): Promise<number | undefined> {
      const content = files[p];
      return content === undefined ? undefined : Buffer.byteLength(content, 'utf8');
    },
    async readTextFile(p: string): Promise<string | undefined> {
      return files[p];
    },
  };
}

const quietLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  show: () => {},
};

/**
 * `WorkflowRunner`のフェイク。`start`は呼ばれた順に`runId`を払い出し、outcomeは
 * テストから`finishRun`で明示的に変えるまで`running`のまま。
 */
function fakeWorkflow(): ProgramWorkflowPort & {
  startCalls: { defPath: string; repoRoot: string }[];
  finishRun: (runId: string, outcome: RunOutcome) => void;
  failNextStart: (message: string) => void;
} {
  const outcomes = new Map<string, RunOutcome>();
  const startCalls: { defPath: string; repoRoot: string }[] = [];
  let nextId = 0;
  let listeners: ((runId: string) => void)[] = [];
  let pendingFailure: string | undefined;
  return {
    startCalls,
    async start(defPath, repoRoot) {
      startCalls.push({ defPath, repoRoot });
      if (pendingFailure !== undefined) {
        const message = pendingFailure;
        pendingFailure = undefined;
        return { ok: false, errors: [{ taskIds: [], message }] };
      }
      nextId += 1;
      const runId = `run-${nextId}`;
      outcomes.set(runId, 'running');
      return { ok: true, runId };
    },
    listLive() {
      return [...outcomes.entries()].map(([runId, outcome]) => ({
        runId,
        name: '',
        defPath: '',
        outcome,
      }));
    },
    onChanged(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    finishRun(runId, outcome) {
      outcomes.set(runId, outcome);
      for (const l of listeners) {
        l(runId);
      }
    },
    failNextStart(message) {
      pendingFailure = message;
    },
  };
}

const programYaml = (extra = '') => `
version: 1
name: テストプログラム
${extra}
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
    dependsOn: [R1]
`;

describe('ProgramRunner.startProgram / pumpProgram（design.md §16.37.2、roadmap W12-2、Issue #605）', () => {
  it('依存の無いrunを起動し、依存のあるrunは前段の完了まで起動しない', async () => {
    const store = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({ '/repo/program.yaml': programYaml() });
    const workflow = fakeWorkflow();
    const runner = new ProgramRunner({ programStore: store, filePort, workflow, log: quietLog });
    runner.attach();

    const result = await runner.startProgram('/repo/program.yaml', '/repo');
    expect(result.ok).toBe(true);
    const programId = result.programId as string;

    expect(workflow.startCalls).toEqual([
      { defPath: '/repo/.agents/workflows/a.yaml', repoRoot: '/repo' },
    ]);
    let persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R1?.state).toBe('running');
    expect(persisted.state.runs.R2?.state).toBe('pending');

    // R1が完了すると、依存していたR2が自動的に起動する
    workflow.finishRun('run-1', 'succeeded');
    // finishRunは同期的にlistenerを呼ぶが、内部のprogramStore更新・pumpProgramは
    // fire-and-forget（`onChanged`の実シグネチャがPromiseを返さないため）のため、
    // 反映されるまでポーリングする
    await vi.waitFor(() => {
      expect(workflow.startCalls).toHaveLength(2);
    });
    expect(workflow.startCalls).toEqual([
      { defPath: '/repo/.agents/workflows/a.yaml', repoRoot: '/repo' },
      { defPath: '/repo/.agents/workflows/b.yaml', repoRoot: '/repo' },
    ]);
    persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R1?.state).toBe('done');
    expect(persisted.state.runs.R2?.state).toBe('running');
    expect(persisted.finishedAt).toBeUndefined();

    workflow.finishRun('run-2', 'succeeded');
    await vi.waitFor(() => {
      const p = store.find(programId) as PersistedProgram;
      expect(p.state.runs.R2?.state).toBe('done');
    });
    persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R2?.state).toBe('done');
    expect(persisted.finishedAt).toBeDefined();

    runner.dispose();
  });

  it('依存の無いrunが同時に走る（並列プログラム）', async () => {
    const store = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({
      '/repo/program.yaml': `
version: 1
name: 並列
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
`,
    });
    const workflow = fakeWorkflow();
    const runner = new ProgramRunner({ programStore: store, filePort, workflow, log: quietLog });

    const result = await runner.startProgram('/repo/program.yaml', '/repo');
    const programId = result.programId as string;
    const persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R1?.state).toBe('running');
    expect(persisted.state.runs.R2?.state).toBe('running');
    expect(workflow.startCalls).toHaveLength(2);
  });

  it('maxParallelの枠を超えて同時に起動しない', async () => {
    const store = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({
      '/repo/program.yaml': `
version: 1
name: 上限あり
maxParallel: 1
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
`,
    });
    const workflow = fakeWorkflow();
    const runner = new ProgramRunner({ programStore: store, filePort, workflow, log: quietLog });
    runner.attach();

    const result = await runner.startProgram('/repo/program.yaml', '/repo');
    const programId = result.programId as string;
    let persisted = store.find(programId) as PersistedProgram;
    expect(workflow.startCalls).toHaveLength(1);
    expect(persisted.state.runs.R1?.state).toBe('running');
    expect(persisted.state.runs.R2?.state).toBe('pending');

    workflow.finishRun('run-1', 'succeeded');
    await vi.waitFor(() => {
      expect(workflow.startCalls).toHaveLength(2);
    });
    persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R2?.state).toBe('running');
  });

  it('リロード後（新しいProgramRunnerインスタンス）でも、続きの波から進む', async () => {
    const memento = fakeMemento();
    const filePort = fakeFilePort({
      '/repo/program.yaml': `
version: 1
name: リロード確認
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
`,
    });

    const store1 = new ProgramStore(memento);
    const workflow1 = fakeWorkflow();
    const runner1 = new ProgramRunner({ programStore: store1, filePort, workflow: workflow1, log: quietLog });
    runner1.attach();
    const result = await runner1.startProgram('/repo/program.yaml', '/repo');
    const programId = result.programId as string;
    // R1は完了、R2はまだ走っている状態で「リロード」を模す
    workflow1.finishRun('run-1', 'succeeded');
    await vi.waitFor(() => {
      const p = store1.find(programId) as PersistedProgram;
      expect(p.state.runs.R1?.state).toBe('done');
    });
    runner1.dispose();

    // リロード直後の中断扱い（W12-1、`programStore.reconcileAfterReload`）を適用してから
    // 新しいProgramRunnerで続きを進める（`extension.ts`の実際の呼び出し順を模す）
    const store2 = new ProgramStore(memento);
    await store2.reconcileAfterReload();
    const reconciled = store2.find(programId) as PersistedProgram;
    expect(reconciled.state.runs.R1?.state).toBe('done'); // 完了済みはそのまま
    expect(reconciled.state.runs.R2?.state).toBe('failed'); // runningだったR2は中断扱いへ倒れる

    const workflow2 = fakeWorkflow();
    const runner2 = new ProgramRunner({ programStore: store2, filePort, workflow: workflow2, log: quietLog });
    await runner2.pumpProgram(programId);
    // R2は既にfailedのため再起動されない。R1もdoneのため対象外
    expect(workflow2.startCalls).toHaveLength(0);
    const finalState = store2.find(programId) as PersistedProgram;
    expect(finalState.state.runs.R1?.state).toBe('done');
    expect(finalState.state.runs.R2?.state).toBe('failed');
  });

  it('リロード後、依存の無い独立したpending runは続きの波として起動される', async () => {
    const memento = fakeMemento();
    const filePort = fakeFilePort({
      '/repo/program.yaml': `
version: 1
name: 独立runの再開
maxParallel: 1
runs:
  - id: R1
    defPath: .agents/workflows/a.yaml
  - id: R2
    defPath: .agents/workflows/b.yaml
`,
    });

    const store1 = new ProgramStore(memento);
    const workflow1 = fakeWorkflow();
    const runner1 = new ProgramRunner({ programStore: store1, filePort, workflow: workflow1, log: quietLog });
    const result = await runner1.startProgram('/repo/program.yaml', '/repo');
    const programId = result.programId as string;
    // maxParallel: 1のため、R1がrunningのままR2はpending。ここで「リロード」を模す
    runner1.dispose();

    const store2 = new ProgramStore(memento);
    await store2.reconcileAfterReload();
    const reconciled = store2.find(programId) as PersistedProgram;
    expect(reconciled.state.runs.R1?.state).toBe('failed'); // runningだったR1は中断扱い
    expect(reconciled.state.runs.R2?.state).toBe('pending'); // 道連れにしない（W12-1）

    const workflow2 = fakeWorkflow();
    const runner2 = new ProgramRunner({ programStore: store2, filePort, workflow: workflow2, log: quietLog });
    await runner2.pumpProgram(programId);
    // R2はR1に依存していない独立したrunなので、続きの波として起動される
    expect(workflow2.startCalls).toHaveLength(1);
    const finalState = store2.find(programId) as PersistedProgram;
    expect(finalState.state.runs.R2?.state).toBe('running');
  });

  it('runの起動自体が失敗した場合はfailedとして記録する', async () => {
    const store = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({ '/repo/program.yaml': programYaml() });
    const workflow = fakeWorkflow();
    workflow.failNextStart('定義ファイルを読み込めません');
    const runner = new ProgramRunner({ programStore: store, filePort, workflow, log: quietLog });

    const result = await runner.startProgram('/repo/program.yaml', '/repo');
    const programId = result.programId as string;
    const persisted = store.find(programId) as PersistedProgram;
    expect(persisted.state.runs.R1?.state).toBe('failed');
  });

  it('プログラム定義自体が不正なら開始しない', async () => {
    const store = new ProgramStore(fakeMemento());
    const filePort = fakeFilePort({ '/repo/program.yaml': 'version: 2\nname: 不正\nruns: []\n' });
    const workflow = fakeWorkflow();
    const runner = new ProgramRunner({ programStore: store, filePort, workflow, log: quietLog });

    const result = await runner.startProgram('/repo/program.yaml', '/repo');
    expect(result.ok).toBe(false);
    expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    expect(store.list()).toHaveLength(0);
    expect(workflow.startCalls).toHaveLength(0);
  });
});
