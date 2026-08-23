import { describe, expect, it } from 'vitest';
import type { ProgramDefinition, ProgramRunRef } from '../../src/orchestrator/program';
import type { ProgramRunEntry, ProgramState } from '../../src/orchestrator/programState';
import {
  isProgramSettled,
  nextProgramRunsToStart,
  propagateProgramFailures,
} from '../../src/orchestrator/programScheduler';

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

/** `skipReason`込みの完全な`ProgramRunEntry`を短く書くためのヘルパ。 */
const entry = (
  state: ProgramRunEntry['state'],
  runId?: string,
  skipReason?: ProgramRunEntry['skipReason'],
): ProgramRunEntry => ({ state, runId, skipReason });

const state = (
  runs: Record<string, ProgramRunEntry>,
  haltedByUser = false,
): ProgramState => ({ runs, haltedByUser });

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
    const s = state({
      R1: entry('pending'),
      R2: entry('pending'),
      R3: entry('pending'),
      R4: entry('pending'),
    });
    // R1のみ依存が無い
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set(['R1']));
  });

  it('前段が完了するまで依存のあるrunは起動しない', () => {
    const def = program(diamondRuns());
    const s = state({
      R1: entry('running', 'run-1'),
      R2: entry('pending'),
      R3: entry('pending'),
      R4: entry('pending'),
    });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set());
  });

  it('前段が完了すると、依存の無い後続runが同時に起動できる', () => {
    const def = program(diamondRuns());
    const s = state({
      R1: entry('done', 'run-1'),
      R2: entry('pending'),
      R3: entry('pending'),
      R4: entry('pending'),
    });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set(['R2', 'R3']));
  });

  it('maxParallelの枠を超えて起動しない', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2' }), runRef({ id: 'R3' })], 2);
    const s = state({ R1: entry('pending'), R2: entry('pending'), R3: entry('pending') });
    // def.runsに書かれた順で埋める
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set(['R1', 'R2']));
  });

  it('runningの分だけ枠が減る', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2' }), runRef({ id: 'R3' })], 2);
    const s = state({
      R1: entry('running', 'run-1'),
      R2: entry('pending'),
      R3: entry('pending'),
    });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set(['R2']));
  });

  it('依存先がfailedのrunは起動しない（この関数単体ではskippedへは倒さない。実際の起動経路ではpropagateProgramFailuresを先に通す）', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const s = state({ R1: entry('failed', 'run-1'), R2: entry('pending') });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set());
  });

  it('依存先がskippedのrunも起動しない（skippedもdoneではないため）', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const s = state({
      R1: entry('skipped', undefined, { kind: 'haltedByUser' }),
      R2: entry('pending'),
    });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set());
  });

  it('依存先が失敗しても、それに依存しない独立したrunは引き続き起動対象になる', () => {
    const def = program([
      runRef({ id: 'R1' }),
      runRef({ id: 'R2', dependsOn: ['R1'] }),
      runRef({ id: 'R3' }),
    ]);
    const s = state({
      R1: entry('failed', 'run-1'),
      R2: entry('pending'),
      R3: entry('pending'),
    });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set(['R3']));
  });

  it('runningでもpendingでも無いrun（done/failed）は対象にしない', () => {
    const def = program([runRef({ id: 'R1' })]);
    const s = state({ R1: entry('done', 'run-1') });
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set());
  });

  it('haltedByUserが立っていれば、起動可能なrunがあっても一切起動しない（design.md §16.37.3、roadmap W12-3、Issue #606）', () => {
    const def = program(diamondRuns());
    const s = state(
      { R1: entry('pending'), R2: entry('pending'), R3: entry('pending'), R4: entry('pending') },
      true,
    );
    expect(nextProgramRunsToStart(def, s)).toEqual(new Set());
  });
});

describe('propagateProgramFailures（design.md §16.37.3、roadmap W12-3、Issue #606）', () => {
  it('前段がfailedなら、依存する後段のpendingをskippedにし、理由（どの前段の失敗によるか）を残す', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const s = state({ R1: entry('failed', 'run-1'), R2: entry('pending') });
    const next = propagateProgramFailures(def, s);
    expect(next.runs.R2).toEqual({
      state: 'skipped',
      runId: undefined,
      skipReason: { kind: 'failedDependency', failedRunId: 'R1' },
    });
    // failedだったR1自身は変えない
    expect(next.runs.R1).toEqual(s.runs.R1);
  });

  it('連鎖する依存（R1→R2→R3）でも、不動点まで繰り返して全て伝播させる', () => {
    const def = program([
      runRef({ id: 'R1' }),
      runRef({ id: 'R2', dependsOn: ['R1'] }),
      runRef({ id: 'R3', dependsOn: ['R2'] }),
    ]);
    const s = state({ R1: entry('failed', 'run-1'), R2: entry('pending'), R3: entry('pending') });
    const next = propagateProgramFailures(def, s);
    expect(next.runs.R2?.state).toBe('skipped');
    expect(next.runs.R2?.skipReason).toEqual({ kind: 'failedDependency', failedRunId: 'R1' });
    expect(next.runs.R3?.state).toBe('skipped');
    // R3の直接の依存はR2（それ自身がskipped）であり、R1ではない
    expect(next.runs.R3?.skipReason).toEqual({ kind: 'failedDependency', failedRunId: 'R2' });
  });

  it('依存先が失敗していない独立したrun・runningのrunは変えない', () => {
    const def = program([
      runRef({ id: 'R1' }),
      runRef({ id: 'R2', dependsOn: ['R1'] }),
      runRef({ id: 'R3' }),
    ]);
    const s = state({
      R1: entry('failed', 'run-1'),
      R2: entry('pending'),
      R3: entry('running', 'run-3'),
    });
    const next = propagateProgramFailures(def, s);
    expect(next.runs.R3).toEqual(s.runs.R3);
  });

  it('伝播対象が無ければ同じ参照を返す', () => {
    const def = program(diamondRuns());
    const s = state({
      R1: entry('running', 'run-1'),
      R2: entry('pending'),
      R3: entry('pending'),
      R4: entry('pending'),
    });
    expect(propagateProgramFailures(def, s)).toBe(s);
  });
});

describe('isProgramSettled（design.md §16.37.2・§16.37.3、roadmap W12-2・W12-3、Issue #605・#606）', () => {
  it('全runがdone/failed/skippedならtrue', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2' }), runRef({ id: 'R3' })]);
    const s = state({
      R1: entry('done', 'run-1'),
      R2: entry('failed', 'run-2'),
      R3: entry('skipped', undefined, { kind: 'haltedByUser' }),
    });
    expect(isProgramSettled(def, s)).toBe(true);
  });

  it('pendingが1件でも残っていればfalse（この関数自体はdependsOnを遡らない。伝播はpropagateProgramFailuresが別途行う）', () => {
    const def = program([runRef({ id: 'R1' }), runRef({ id: 'R2', dependsOn: ['R1'] })]);
    const s = state({ R1: entry('failed', 'run-1'), R2: entry('pending') });
    expect(isProgramSettled(def, s)).toBe(false);
  });

  it('runningが残っていればfalse', () => {
    const def = program([runRef({ id: 'R1' })]);
    const s = state({ R1: entry('running', 'run-1') });
    expect(isProgramSettled(def, s)).toBe(false);
  });
});
