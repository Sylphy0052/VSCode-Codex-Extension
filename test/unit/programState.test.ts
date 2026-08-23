import { describe, expect, it } from 'vitest';
import type { ProgramDefinition } from '../../src/orchestrator/program';
import {
  createInitialProgramState,
  reconcileProgramStateOnReload,
  type ProgramState,
} from '../../src/orchestrator/programState';

const def: ProgramDefinition = {
  version: 1,
  name: 'テスト',
  runs: [
    { id: 'R1', defPath: 'a.yaml', dependsOn: [], parseErrors: [] },
    { id: 'R2', defPath: 'b.yaml', dependsOn: ['R1'], parseErrors: [] },
  ],
};

describe('createInitialProgramState（design.md §16.37、Issue #604）', () => {
  it('全runをpending（未着手）で初期化する', () => {
    const state = createInitialProgramState(def);
    expect(state).toEqual({
      runs: {
        R1: { state: 'pending', runId: undefined },
        R2: { state: 'pending', runId: undefined },
      },
    });
  });
});

describe('reconcileProgramStateOnReload（design.md §16.35「中断からの自動再開」の対象に含める）', () => {
  it('running のrunをfailedへ倒す', () => {
    const state: ProgramState = {
      runs: {
        R1: { state: 'running', runId: 'run-1' },
        R2: { state: 'pending', runId: undefined },
      },
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled.runs.R1).toEqual({ state: 'failed', runId: 'run-1' });
    expect(reconciled.runs.R2).toEqual({ state: 'pending', runId: undefined });
  });

  it('doneとfailedはそのまま変えない', () => {
    const state: ProgramState = {
      runs: {
        R1: { state: 'done', runId: 'run-1' },
        R2: { state: 'failed', runId: 'run-2' },
      },
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled).toBe(state);
  });

  it('pendingはpendingのまま道連れにしない（波のスケジューリングを持たないため）', () => {
    const state: ProgramState = { runs: { R1: { state: 'pending', runId: undefined } } };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled).toBe(state);
  });

  it('変化が無ければ同じ参照を返す', () => {
    const state: ProgramState = { runs: { R1: { state: 'done', runId: 'run-1' } } };
    expect(reconcileProgramStateOnReload(state)).toBe(state);
  });
});
