import { describe, expect, it } from 'vitest';
import type { ProgramDefinition } from '../../src/orchestrator/program';
import {
  createInitialProgramState,
  markProgramHaltedByUser,
  markRunFinished,
  markRunSkipped,
  markRunStarted,
  reapplyLiveRunOutcome,
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
        R1: { state: 'pending', runId: undefined, skipReason: undefined },
        R2: { state: 'pending', runId: undefined, skipReason: undefined },
      },
      haltedByUser: false,
    });
  });
});

describe('reconcileProgramStateOnReload（design.md §16.35「中断からの自動再開」の対象に含める）', () => {
  it('running のrunをfailedへ倒す', () => {
    const state: ProgramState = {
      runs: {
        R1: { state: 'running', runId: 'run-1', skipReason: undefined },
        R2: { state: 'pending', runId: undefined, skipReason: undefined },
      },
      haltedByUser: false,
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled.runs.R1).toEqual({ state: 'failed', runId: 'run-1', skipReason: undefined });
    expect(reconciled.runs.R2).toEqual({
      state: 'pending',
      runId: undefined,
      skipReason: undefined,
    });
  });

  it('doneとfailedはそのまま変えない', () => {
    const state: ProgramState = {
      runs: {
        R1: { state: 'done', runId: 'run-1', skipReason: undefined },
        R2: { state: 'failed', runId: 'run-2', skipReason: undefined },
      },
      haltedByUser: false,
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled).toBe(state);
  });

  it('pendingはpendingのまま道連れにしない（失敗の伝播はprogramScheduler.tsのpropagateProgramFailuresが別途担う）', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'pending', runId: undefined, skipReason: undefined } },
      haltedByUser: false,
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled).toBe(state);
  });

  it('変化が無ければ同じ参照を返す', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'done', runId: 'run-1', skipReason: undefined } },
      haltedByUser: false,
    };
    expect(reconcileProgramStateOnReload(state)).toBe(state);
  });

  it('haltedByUserはそのまま素通しする（人が止めたプログラムはリロード後も止まったまま。design.md §16.37.3、Issue #606）', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
      haltedByUser: true,
    };
    const reconciled = reconcileProgramStateOnReload(state);
    expect(reconciled.haltedByUser).toBe(true);
  });
});

describe('markRunStarted（design.md §16.37.2、Issue #605）', () => {
  it('pendingをrunningへ進め、runIdを紐づける', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'pending', runId: undefined, skipReason: undefined } },
      haltedByUser: false,
    };
    const next = markRunStarted(state, 'R1', 'run-1');
    expect(next.runs.R1).toEqual({ state: 'running', runId: 'run-1', skipReason: undefined });
  });

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'pending', runId: undefined, skipReason: undefined } },
      haltedByUser: false,
    };
    expect(markRunStarted(state, 'unknown', 'run-1')).toBe(state);
  });
});

describe('markRunFinished（design.md §16.37.2、Issue #605）', () => {
  it('succeededをdoneへ倒す', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
      haltedByUser: false,
    };
    const next = markRunFinished(state, 'R1', 'succeeded');
    expect(next.runs.R1).toEqual({ state: 'done', runId: 'run-1', skipReason: undefined });
  });

  it.each(['failed', 'blocked', 'aborted'] as const)(
    '%sはfailedへ丸める（run単位の細別は持たず、後続への伝播ではfailedとして扱う）',
    (outcome) => {
      const state: ProgramState = {
        runs: { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
        haltedByUser: false,
      };
      const next = markRunFinished(state, 'R1', outcome);
      expect(next.runs.R1).toEqual({ state: 'failed', runId: 'run-1', skipReason: undefined });
    },
  );

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = { runs: {}, haltedByUser: false };
    expect(markRunFinished(state, 'unknown', 'succeeded')).toBe(state);
  });
});

describe('reapplyLiveRunOutcome（design.md §16.37.2「リロードとW10の自動再開の整合」、Issue #605のレビュー指摘F1）', () => {
  it('outcomeがrunningなら、failedへ倒れていてもrunningへ戻す（W10による再開の反映）', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'failed', runId: 'run-1', skipReason: undefined } },
      haltedByUser: false,
    };
    const next = reapplyLiveRunOutcome(state, 'R1', 'run-1', 'running');
    expect(next.runs.R1).toEqual({ state: 'running', runId: 'run-1', skipReason: undefined });
  });

  it('既にrunningかつ同じrunIdなら同じ参照を返す', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
      haltedByUser: false,
    };
    expect(reapplyLiveRunOutcome(state, 'R1', 'run-1', 'running')).toBe(state);
  });

  it('outcomeがsucceededならdoneへ確定させる', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'failed', runId: 'run-1', skipReason: undefined } },
      haltedByUser: false,
    };
    const next = reapplyLiveRunOutcome(state, 'R1', 'run-1', 'succeeded');
    expect(next.runs.R1).toEqual({ state: 'done', runId: 'run-1', skipReason: undefined });
  });

  it.each(['failed', 'blocked', 'aborted'] as const)(
    'outcomeが%sならfailedのまま確定させる',
    (outcome) => {
      const state: ProgramState = {
        runs: { R1: { state: 'failed', runId: 'run-1', skipReason: undefined } },
        haltedByUser: false,
      };
      const next = reapplyLiveRunOutcome(state, 'R1', 'run-1', outcome);
      expect(next.runs.R1).toEqual({ state: 'failed', runId: 'run-1', skipReason: undefined });
    },
  );

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = { runs: {}, haltedByUser: false };
    expect(reapplyLiveRunOutcome(state, 'unknown', 'run-1', 'running')).toBe(state);
  });
});

describe('markRunSkipped（design.md §16.37.3、roadmap W12-3、Issue #606）', () => {
  it('pendingをskippedへ倒し、理由を残す', () => {
    const state: ProgramState = {
      runs: { R2: { state: 'pending', runId: undefined, skipReason: undefined } },
      haltedByUser: false,
    };
    const next = markRunSkipped(state, 'R2', { kind: 'failedDependency', failedRunId: 'R1' });
    expect(next.runs.R2).toEqual({
      state: 'skipped',
      runId: undefined,
      skipReason: { kind: 'failedDependency', failedRunId: 'R1' },
    });
  });

  it('pending以外（running/done/failed）は踏みつぶさない', () => {
    for (const s of ['running', 'done', 'failed'] as const) {
      const state: ProgramState = {
        runs: { R1: { state: s, runId: 'run-1', skipReason: undefined } },
        haltedByUser: false,
      };
      expect(markRunSkipped(state, 'R1', { kind: 'haltedByUser' })).toBe(state);
    }
  });

  it('未定義のrunidを渡しても何もしない', () => {
    const state: ProgramState = { runs: {}, haltedByUser: false };
    expect(markRunSkipped(state, 'unknown', { kind: 'haltedByUser' })).toBe(state);
  });
});

describe('markProgramHaltedByUser（design.md §16.37.3、roadmap W12-3、Issue #606）', () => {
  it('haltedByUserを立て、まだ開始していないpendingを全てskipped（理由haltedByUser）にする', () => {
    const state: ProgramState = {
      runs: {
        R1: { state: 'running', runId: 'run-1', skipReason: undefined },
        R2: { state: 'pending', runId: undefined, skipReason: undefined },
        R3: { state: 'done', runId: 'run-3', skipReason: undefined },
      },
      haltedByUser: false,
    };
    const next = markProgramHaltedByUser(state);
    expect(next.haltedByUser).toBe(true);
    // running中のrunはここでは変えない（その子run自身の停止は別経路。programRunner.tsのhaltProgram参照）
    expect(next.runs.R1).toEqual({ state: 'running', runId: 'run-1', skipReason: undefined });
    expect(next.runs.R2).toEqual({
      state: 'skipped',
      runId: undefined,
      skipReason: { kind: 'haltedByUser' },
    });
    expect(next.runs.R3).toEqual({ state: 'done', runId: 'run-3', skipReason: undefined });
  });

  it('既にhaltedByUserなら同じ参照を返す（stop()の重ね呼びに対する冪等性）', () => {
    const state: ProgramState = {
      runs: { R1: { state: 'running', runId: 'run-1', skipReason: undefined } },
      haltedByUser: true,
    };
    expect(markProgramHaltedByUser(state)).toBe(state);
  });
});
