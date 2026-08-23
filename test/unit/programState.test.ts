import { describe, expect, it } from 'vitest';
import type { ProgramDefinition } from '../../src/orchestrator/program';
import {
  createInitialProgramState,
  markRunFinished,
  markRunStarted,
  reconcileProgramStateOnReload,
  type ProgramState,
} from '../../src/orchestrator/programState';

const def: ProgramDefinition = {
  version: 1,
  name: 'テスト',
  maxParallel: 3,
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

  it('pendingはpendingのまま道連れにしない（失敗の伝播はIssue #606の担当のため）', () => {
    const state: ProgramState = { runs: { R1: { state: 'pending', runId: undefined } } };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled).toBe(state);
  });

  it('変化が無ければ同じ参照を返す', () => {
    const state: ProgramState = { runs: { R1: { state: 'done', runId: 'run-1' } } };
    expect(reconcileProgramStateOnReload(state)).toBe(state);
  });
});

describe('markRunStarted（design.md §16.37.2、Issue #605）', () => {
  it('pendingをrunningへ進め、runIdを紐づける', () => {
    const state: ProgramState = { runs: { R1: { state: 'pending', runId: undefined } } };
    const next = markRunStarted(state, 'R1', 'run-1');
    expect(next.runs.R1).toEqual({ state: 'running', runId: 'run-1' });
  });

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = { runs: { R1: { state: 'pending', runId: undefined } } };
    expect(markRunStarted(state, 'unknown', 'run-1')).toBe(state);
  });
});

describe('markRunFinished（design.md §16.37.2、Issue #605）', () => {
  it('succeededをdoneへ倒す', () => {
    const state: ProgramState = { runs: { R1: { state: 'running', runId: 'run-1' } } };
    const next = markRunFinished(state, 'R1', 'succeeded');
    expect(next.runs.R1).toEqual({ state: 'done', runId: 'run-1' });
  });

  it.each(['failed', 'blocked', 'aborted'] as const)(
    '%sはfailedへ丸める（run単位の細別はIssue #606の担当）',
    (outcome) => {
      const state: ProgramState = { runs: { R1: { state: 'running', runId: 'run-1' } } };
      const next = markRunFinished(state, 'R1', outcome);
      expect(next.runs.R1).toEqual({ state: 'failed', runId: 'run-1' });
    },
  );

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = { runs: {} };
    expect(markRunFinished(state, 'unknown', 'succeeded')).toBe(state);
  });
});
