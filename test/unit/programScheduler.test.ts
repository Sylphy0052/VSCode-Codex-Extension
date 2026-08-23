import { describe, expect, it } from 'vitest';
import type { ProgramDefinition, ProgramRunRef } from '../../src/orchestrator/program';
import type { ProgramState } from '../../src/orchestrator/programState';
import { isProgramSettled, nextProgramRunsToStart } from '../../src/orchestrator/programScheduler';

const runRef = (overrides: Partial<ProgramRunRef> = {}): ProgramRunRef => ({
  id: 'R1',
  defPath: '.agents/workflows/a.yaml',
  dependsOn: [],
  parseErrors: [],
  ...overrides,
});

const program = (runs: ProgramRunRef[], maxParallel = 3): ProgramDefinition => ({
  version: 1,
  name: 'テスト',
  maxParallel,
  runs,
});

/** T1 -> (T2 || T3) -> T4。scheduler.test.tsのdiamondTasksと同じ形。 */
const diamondRuns = (): ProgramRunRef[] => [
  runRef({ id: 'R1' }),
  runRef({ id: 'R2', dependsOn: ['R1'] }),
  runRef({ id: 'R3', dependsOn: ['R1'] }),
  runRef({ id: 'R4', dependsOn: ['R2', 'R3'] }),
];

describe('nextProgramRunsToStart（design.md §16.37.2、roadmap W12-2、Issue #605）', () => {
  it('依存の無いrunを同時に起動する', () => {
    const def = program(diamondRuns());
    const state: ProgramState = {
      runs: {
        R1: { state: 'pending', runId: undefined },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
        R4: { state: 'pending', runId: undefined },
      },
    };
    // R1のみ依存が無い
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set(['R1']));
  });

  it('前段が完了するまで依存のあるrunは起動しない', () => {
    const def = program(diamondRuns());
    const state: ProgramState = {
      runs: {
        R1: { state: 'running', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
        R4: { state: 'pending', runId: undefined },
      },
    };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set());
  });

  it('前段が完了すると、依存の無い後続runが同時に起動できる', () => {
    const def = program(diamondRuns());
    const state: ProgramState = {
      runs: {
        R1: { state: 'done', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
        R4: { state: 'pending', runId: undefined },
      },
    };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set(['R2', 'R3']));
  });

  it('maxParallelの枠を超えて起動しない', () => {
    const def = program(
      [runRef({ id: 'R1' }), runRef({ id: 'R2' }), runRef({ id: 'R3' })],
      2,
    );
    const state: ProgramState = {
      runs: {
        R1: { state: 'pending', runId: undefined },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
      },
    };
    // def.runsに書かれた順で埋める
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set(['R1', 'R2']));
  });

  it('runningの分だけ枠が減る', () => {
    const def = program(
      [runRef({ id: 'R1' }), runRef({ id: 'R2' }), runRef({ id: 'R3' })],
      2,
    );
    const state: ProgramState = {
      runs: {
        R1: { state: 'running', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
      },
    };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set(['R2']));
  });

  it('依存先がfailedのrunは起動しない（失敗の伝播はIssue #606の担当。ここでは単に開始しないだけ）', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const state: ProgramState = {
      runs: {
        R1: { state: 'failed', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
      },
    };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set());
  });

  it('依存先が失敗しても、それに依存しない独立したrunは引き続き起動対象になる', () => {
    const def = program([
      runRef({ id: 'R1' }),
      runRef({ id: 'R2', dependsOn: ['R1'] }),
      runRef({ id: 'R3' }),
    ]);
    const state: ProgramState = {
      runs: {
        R1: { state: 'failed', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
        R3: { state: 'pending', runId: undefined },
      },
    };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set(['R3']));
  });

  it('runningでもpendingでも無いrun（done/failed）は対象にしない', () => {
    const def = program([runRef({ id: 'R1' })]);
    const state: ProgramState = { runs: { R1: { state: 'done', runId: 'run-1' } } };
    expect(nextProgramRunsToStart(def, state)).toEqual(new Set());
  });
});

describe('isProgramSettled（design.md §16.37.2、roadmap W12-2、Issue #605）', () => {
  it('全runがdone/failedならtrue', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2' })]);
    const state: ProgramState = {
      runs: {
        R1: { state: 'done', runId: 'run-1' },
        R2: { state: 'failed', runId: 'run-2' },
      },
    };
    expect(isProgramSettled(def, state)).toBe(true);
  });

  it('pendingが1件でも残っていればfalse（依存先failedによる恒久停止かどうかは判定しない）', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const state: ProgramState = {
      runs: {
        R1: { state: 'failed', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
      },
    };
    expect(isProgramSettled(def, state)).toBe(false);
  });

  it('runningが残っていればfalse', () => {
    const def = program([runRef({ id: 'R1' })]);
    const state: ProgramState = { runs: { R1: { state: 'running', runId: 'run-1' } } };
    expect(isProgramSettled(def, state)).toBe(false);
  });
});
