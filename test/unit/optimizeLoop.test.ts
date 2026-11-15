import { describe, expect, it, vi } from 'vitest';
import { judgeAfterReview } from '../../src/orchestrator/optimizeCompare';
import type { OptimizeTrialRecord } from '../../src/orchestrator/optimizeLedger';
import {
  DEFAULT_LOOP_LIMITS,
  applyOptimizeGateResolution,
  applyTrialResult,
  consumeMergeAllowance,
  decidePreMerge,
  decideStop,
  effectiveBudget,
  implementSessionBlockReason,
  initialLoopState,
  parseMatchHeadCommit,
  prepareLoopResume,
  runOptimizeLoop,
  shouldStopForUsage,
  type BaselineResult,
  type OptimizeLoopLimits,
  type OptimizeLoopPorts,
  type OptimizeLoopState,
  type ResumePorts,
} from '../../src/orchestrator/optimizeLoop';
import { OptimizeLoopHost } from '../../src/orchestrator/optimizeLoopHost';
import type { OptimizationSpec } from '../../src/orchestrator/optimizeSpec';
import type { OptimizeTrialResult } from '../../src/orchestrator/optimizeTrial';
import { openOptimizeGateHalting } from '../../src/orchestrator/taskRunGates';
import { stageApprovalHandler } from '../../src/orchestrator/taskStageApproval';
import { FIXTURE_NOW, makeRun, makeTask } from '../helpers/taskRunFixture';

/** 最適化ハーネスのループ制御（Issue #2111）の受入基準。 */

const SPEC: OptimizationSpec = {
  metricSource: 'wallTime',
  metricCommand: 'bench',
  direction: 'minimize',
  minImprovement: { kind: 'absolute', value: 1 },
  significanceLevel: 0.05,
  correctnessCommand: 'test',
  allowedPaths: ['src'],
  budget: { maxTrials: 10, maxMinutes: 60 },
  measurementRuns: 10,
} as OptimizationSpec;

const LIMITS: OptimizeLoopLimits = { maxTrials: 100, maxMinutes: 1000 };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function trialsState(over: Partial<OptimizeLoopState> = {}): OptimizeLoopState {
  return {
    ...initialLoopState(),
    phase: 'trials',
    baseline: { metric: 100, commit: SHA_A },
    ...over,
  };
}

function stopInput(state: OptimizeLoopState, over: Record<string, unknown> = {}) {
  return {
    state,
    spec: SPEC,
    limits: LIMITS,
    usagePct: undefined,
    usageThresholdPct: undefined,
    userStopped: false,
    ...over,
  };
}

function trialResult(
  trial: number,
  metric: number,
  over: Record<string, unknown> = {},
  verdict?: string,
): OptimizeTrialResult {
  return {
    aborted: false,
    adoptionCandidate: true,
    commit: `c${String(trial)}`,
    record: {
      trial,
      metric: { median: metric },
      ...(verdict === undefined ? {} : { refutation: { verdict } }),
    },
    ...over,
  } as unknown as OptimizeTrialResult;
}

const NEVER_DONE = new Promise<never>(() => undefined);

function makePorts(over: Partial<OptimizeLoopPorts> = {}) {
  let clock = 0;
  const saved: OptimizeLoopState[] = [];
  const ports: OptimizeLoopPorts = {
    now: () => new Date((clock += 1000)),
    measureBaseline: vi.fn(async (): Promise<BaselineResult> => ({
      ok: true,
      metric: 100,
      commit: SHA_A,
    })),
    runTrial: vi.fn(async (args) => trialResult(args.trial, 100)),
    promoteBest: vi.fn(async (_c: string, trial: number) => `refs/best/${String(trial)}`),
    readUsagePct: vi.fn(async () => undefined),
    saveState: vi.fn(async (s: OptimizeLoopState) => {
      saved.push(s);
    }),
    isPauseRequested: () => false,
    ...over,
  };
  return { ports, saved };
}

function loopInput(ports: OptimizeLoopPorts, over: Record<string, unknown> = {}) {
  return {
    spec: SPEC,
    limits: LIMITS,
    usageThresholdPct: undefined,
    state: initialLoopState(),
    signal: new AbortController().signal,
    ports,
    ...over,
  };
}

// ---- 1. ループを通さないimplementの拒否 ----

describe('implementSessionBlockReason (受入1)', () => {
  const opt = { optimization: SPEC };
  it('最適化タスクはloopがpr/doneになる前のimplementを拒否する', () => {
    expect(implementSessionBlockReason(opt)).toBeDefined();
    expect(implementSessionBlockReason({ ...opt, optimizeLoop: trialsState() })).toBeDefined();
    expect(
      implementSessionBlockReason({
        ...opt,
        optimizeLoop: { ...trialsState(), phase: 'baseline' },
      }),
    ).toBeDefined();
  });
  it('ループが止まった後(pr/done)と、最適化でないタスクは許す', () => {
    expect(
      implementSessionBlockReason({ ...opt, optimizeLoop: { ...trialsState(), phase: 'pr' } }),
    ).toBeUndefined();
    expect(
      implementSessionBlockReason({ ...opt, optimizeLoop: { ...trialsState(), phase: 'done' } }),
    ).toBeUndefined();
    expect(implementSessionBlockReason({})).toBeUndefined();
  });
});

// ---- 2. baselineFailed ----

describe('runOptimizeLoop 基準値 (受入2)', () => {
  it('基準値を測れないと試行を始めずbaselineFailedを返す', async () => {
    const { ports } = makePorts({
      measureBaseline: vi.fn(async (): Promise<BaselineResult> => ({
        ok: false,
        step: 'setup',
        detail: 'npm ci失敗',
      })),
    });
    const out = await runOptimizeLoop(loopInput(ports));
    expect(out.kind).toBe('baselineFailed');
    if (out.kind === 'baselineFailed') {
      expect(out.detail).toContain('準備');
      expect(out.detail).toContain('npm ci失敗');
      expect(out.state.phase).toBe('baseline');
    }
    expect(ports.runTrial).not.toHaveBeenCalled();
  });
});

// ---- 3. 止め方 ----

describe('decideStop 各止め方 (受入3)', () => {
  it('試行回数の予算', () => {
    expect(decideStop(stopInput(trialsState({ trials: 10 })))).toEqual({
      stop: true,
      reason: 'trialBudget',
    });
    expect(decideStop(stopInput(trialsState({ trials: 9 })))).toMatchObject({ stop: false });
  });
  it('時間の予算', () => {
    expect(decideStop(stopInput(trialsState({ elapsedMs: 60 * 60_000 })))).toEqual({
      stop: true,
      reason: 'timeBudget',
    });
  });
  it('上限の上限(limits)が仕様の予算より小さければそちらで止まる', () => {
    expect(effectiveBudget(SPEC, { maxTrials: 3, maxMinutes: 5 })).toEqual({
      maxTrials: 3,
      maxMinutes: 5,
    });
    expect(effectiveBudget(SPEC, DEFAULT_LOOP_LIMITS).maxTrials).toBe(10);
    expect(
      decideStop(
        stopInput(trialsState({ trials: 3 }), { limits: { maxTrials: 3, maxMinutes: 5 } }),
      ),
    ).toEqual({ stop: true, reason: 'trialBudget' });
    expect(
      decideStop(
        stopInput(trialsState({ elapsedMs: 5 * 60_000 }), {
          limits: { maxTrials: 100, maxMinutes: 5 },
        }),
      ),
    ).toEqual({ stop: true, reason: 'timeBudget' });
  });
  it('伸び止まり: 3試行で組み直し1回、組み直し後さらに3で停止', () => {
    const plateau = trialsState({ plateau: 3 });
    expect(decideStop(stopInput(plateau))).toEqual({ stop: false, rebuild: true });
    expect(decideStop(stopInput(trialsState({ plateau: 2 })))).toEqual({
      stop: false,
      rebuild: false,
    });
    expect(decideStop(stopInput(trialsState({ plateau: 3, rebuilt: true })))).toEqual({
      stop: true,
      reason: 'plateau',
    });
    expect(decideStop(stopInput(trialsState({ plateau: 2, rebuilt: true })))).toMatchObject({
      stop: false,
    });
  });
  it('目標値(minimizeは以下、maximizeは以上)', () => {
    const spec = { ...SPEC, target: 50 };
    const best = (metric: number) => ({ metric, commit: 'c', ref: 'r', trial: 1 });
    expect(decideStop(stopInput(trialsState({ best: best(50) }), { spec }))).toEqual({
      stop: true,
      reason: 'target',
    });
    expect(decideStop(stopInput(trialsState({ best: best(51) }), { spec }))).toMatchObject({
      stop: false,
    });
    const max = { ...spec, direction: 'maximize' as const };
    expect(decideStop(stopInput(trialsState({ best: best(50) }), { spec: max }))).toEqual({
      stop: true,
      reason: 'target',
    });
  });
  it('使用率は分かっていて閾値以上のときだけ止まり、undefinedでは止まらない', () => {
    expect(shouldStopForUsage(80, 80)).toBe(true);
    expect(shouldStopForUsage(79, 80)).toBe(false);
    expect(shouldStopForUsage(undefined, 80)).toBe(false);
    expect(shouldStopForUsage(99, undefined)).toBe(false);
    expect(decideStop(stopInput(trialsState(), { usagePct: 90, usageThresholdPct: 80 }))).toEqual({
      stop: true,
      reason: 'usage',
    });
    expect(
      decideStop(stopInput(trialsState(), { usagePct: undefined, usageThresholdPct: 80 })),
    ).toEqual({ stop: false, rebuild: false });
  });
  it('反証役が3回続けて判定できないと止まる。判定できれば数え直す', () => {
    expect(decideStop(stopInput(trialsState({ inconclusiveStreak: 3 })))).toEqual({
      stop: true,
      reason: 'refutation',
    });
    expect(decideStop(stopInput(trialsState({ inconclusiveStreak: 2 })))).toMatchObject({
      stop: false,
    });
    let s = trialsState();
    for (let i = 1; i <= 3; i += 1) {
      s = applyTrialResult(s, trialResult(i, 100, {}, 'inconclusive'), 'minimize', undefined);
    }
    expect(s.inconclusiveStreak).toBe(3);
    s = applyTrialResult(s, trialResult(4, 100, {}, 'confirmed'), 'minimize', undefined);
    expect(s.inconclusiveStreak).toBe(0);
  });
  it('利用者停止(userStopped)', () => {
    expect(decideStop(stopInput(trialsState(), { userStopped: true }))).toEqual({
      stop: true,
      reason: 'userStopped',
    });
  });
});

describe('runOptimizeLoop 止まり方 (受入3)', () => {
  it('試行回数の予算まで回して止まり、最良を更新しPR段階へ進める', async () => {
    let metric = 100;
    const { ports } = makePorts({
      runTrial: vi.fn(async (args) => trialResult(args.trial, (metric -= 5))),
    });
    const out = await runOptimizeLoop(
      loopInput(ports, { spec: { ...SPEC, budget: { maxTrials: 3, maxMinutes: 60 } } }),
    );
    expect(out).toMatchObject({ kind: 'stopped', reason: 'trialBudget' });
    expect(ports.runTrial).toHaveBeenCalledTimes(3);
    if (out.kind === 'stopped') {
      expect(out.state).toMatchObject({
        phase: 'pr',
        rewritePending: true,
        trials: 3,
        best: { metric: 85, trial: 3 },
      });
    }
  });
  it('伸び止まり: 3試行で組み直し(rebuild)を1回指示し、さらに3試行で止まる', async () => {
    // 採用候補にならない試行だけが続く（最良が更新されない）
    const { ports } = makePorts({
      runTrial: vi.fn(async (args) =>
        trialResult(args.trial, 100, { adoptionCandidate: false, commit: undefined }),
      ),
    });
    const out = await runOptimizeLoop(loopInput(ports));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'plateau' });
    const calls = vi.mocked(ports.runTrial).mock.calls.map(([a]) => a.rebuild);
    expect(calls).toEqual([false, false, false, true, false, false]);
  });
  it('使用率が閾値以上なら試行前に止まる。undefinedなら止まらず予算まで回る', async () => {
    const high = makePorts({ readUsagePct: vi.fn(async () => 95) });
    const out = await runOptimizeLoop(loopInput(high.ports, { usageThresholdPct: 90 }));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'usage' });
    expect(high.ports.runTrial).not.toHaveBeenCalled();

    const unknown = makePorts({
      runTrial: vi.fn(async (args) => trialResult(args.trial, 100 - args.trial * 10)),
    });
    const out2 = await runOptimizeLoop(
      loopInput(unknown.ports, {
        usageThresholdPct: 90,
        spec: { ...SPEC, budget: { maxTrials: 2, maxMinutes: 60 } },
      }),
    );
    expect(out2).toMatchObject({ kind: 'stopped', reason: 'trialBudget' });
  });
  it('反証役が3回続けて判定できないと止まる', async () => {
    const { ports } = makePorts({
      runTrial: vi.fn(async (args) =>
        trialResult(args.trial, 100 - args.trial, {}, 'inconclusive'),
      ),
    });
    const out = await runOptimizeLoop(loopInput(ports));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'refutation' });
    expect(ports.runTrial).toHaveBeenCalledTimes(3);
  });
  it('目標値に届いたら止まる', async () => {
    const { ports } = makePorts({
      runTrial: vi.fn(async (args) => trialResult(args.trial, 40)),
    });
    const out = await runOptimizeLoop(loopInput(ports, { spec: { ...SPEC, target: 50 } }));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'target' });
    expect(ports.runTrial).toHaveBeenCalledTimes(1);
  });
  it('利用者停止(signal abort)で試行が中断されたら、inFlightTrialを残して止まる', async () => {
    const ac = new AbortController();
    const { ports, saved } = makePorts({
      runTrial: vi.fn(async () => {
        ac.abort();
        return { aborted: true } as unknown as OptimizeTrialResult;
      }),
    });
    const out = await runOptimizeLoop(loopInput(ports, { signal: ac.signal }));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'userStopped' });
    expect(saved.some((s) => s.inFlightTrial === 1)).toBe(true);
  });
  it('開始前にabort済みなら基準値も測らず止まる', async () => {
    const ac = new AbortController();
    ac.abort();
    const { ports } = makePorts();
    const out = await runOptimizeLoop(loopInput(ports, { signal: ac.signal }));
    expect(out).toMatchObject({ kind: 'stopped', reason: 'userStopped' });
    expect(ports.measureBaseline).not.toHaveBeenCalled();
    expect(ports.runTrial).not.toHaveBeenCalled();
  });
  it('一時停止の要求は次の試行の前で止まる', async () => {
    const { ports } = makePorts({ isPauseRequested: () => true });
    const out = await runOptimizeLoop(loopInput(ports));
    expect(out.kind).toBe('paused');
    expect(ports.runTrial).not.toHaveBeenCalled();
  });
});

// ---- 4. 再開 ----

describe('prepareLoopResume (受入4)', () => {
  function resumePorts(over: Partial<ResumePorts> = {}) {
    const appended: OptimizeTrialRecord[] = [];
    const ports: ResumePorts = {
      now: () => FIXTURE_NOW,
      killRecordedProcesses: vi.fn(async () => ({ killed: 2, discarded: 1 })),
      readBestRef: vi.fn(async () => undefined),
      restoreTrees: vi.fn(async () => undefined),
      readLedger: vi.fn(async () => []),
      appendLedger: vi.fn(async (r: OptimizeTrialRecord) => {
        appended.push(r);
      }),
      ...over,
    };
    return { ports, appended };
  }

  it('残プロセスを止め、inFlightTrialを「中断」と記録し、試行回数を引き継ぐ', async () => {
    const { ports, appended } = resumePorts();
    const state = trialsState({
      trials: 2,
      inFlightTrial: 3,
      best: { metric: 80, commit: 'bestc', ref: 'r', trial: 2 },
    });
    const report = await prepareLoopResume(state, ports);
    expect(ports.killRecordedProcesses).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ killed: 2, discarded: 1, interruptedTrial: 3 });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ trial: 3, decision: { outcome: 'invalid' } });
    expect(appended[0]?.decision.reason).toContain('中断');
    expect(report.state.inFlightTrial).toBeUndefined();
    expect(report.state.trials).toBe(3);
    expect(ports.restoreTrees).toHaveBeenCalledWith('bestc');
  });
  it('台帳にある試行は再記録せず、台帳の多い方の回数を引き継ぐ。bestが無ければ基準の木へ戻す', async () => {
    const ledger = [{ trial: 1 }, { trial: 4 }] as unknown as OptimizeTrialRecord[];
    const { ports, appended } = resumePorts({ readLedger: vi.fn(async () => ledger) });
    const report = await prepareLoopResume(trialsState({ trials: 1, inFlightTrial: 4 }), ports);
    expect(appended).toHaveLength(0);
    expect(report.interruptedTrial).toBeUndefined();
    expect(report.state.trials).toBe(4);
    expect(ports.restoreTrees).toHaveBeenCalledWith(SHA_A);
  });
  it('refとstateのbest commitが食い違えばrefを正としてworktreeを戻す', async () => {
    const ledger = [
      { trial: 2, commit: 'newref', metric: { median: 70 } },
    ] as unknown as OptimizeTrialRecord[];
    const { ports } = resumePorts({
      readBestRef: vi.fn(async () => 'newref'),
      readLedger: vi.fn(async () => ledger),
    });
    const report = await prepareLoopResume(
      trialsState({ trials: 1, best: { metric: 80, commit: 'oldc', ref: 'r', trial: 1 } }),
      ports,
    );
    expect(report.state.best).toMatchObject({ commit: 'newref', metric: 70, trial: 2 });
    expect(ports.restoreTrees).toHaveBeenCalledWith('newref');
  });
});

// ---- 5. 関門は人だけが決着 ----

describe('最適化の関門 (受入5)', () => {
  it.each(['treeMismatch', 'worsenedAfterReview', 'baselineFailed', 'preMergeFailed'] as const)(
    '%sはawaitingUser(Reflex判定を通らない)で開き、工程を止める',
    (reason) => {
      const run = makeRun([makeTask('T1', 'implement', 'notStarted', { optimization: SPEC })]);
      const next = openOptimizeGateHalting(
        run,
        'T1',
        { gateId: 'g1', reason, detail: '詳細' },
        FIXTURE_NOW,
      );
      const gate = next.tasks.T1?.gates?.[0];
      expect(gate).toMatchObject({
        kind: 'optimization',
        optimizeReason: reason,
        status: 'awaitingUser',
      });
      expect(next.tasks.T1?.stages.implement.status).toBe('halted');
    },
  );
  it('最適化でないタスクには関門を開かない', () => {
    const run = makeRun([makeTask('T1', 'implement', 'notStarted')]);
    const next = openOptimizeGateHalting(
      run,
      'T1',
      { gateId: 'g1', reason: 'treeMismatch', detail: 'x' },
      FIXTURE_NOW,
    );
    expect(next).toBe(run);
  });
  it('judgeAfterReview: HEADが最良より有意に悪化したらflagged、同等ならflagged無し', () => {
    const worse = {
      ok: true,
      correctness: { passed: true, detail: '' },
      measured: {
        failed: false,
        pairs: Array.from({ length: 10 }, (_, i) => ({ a: 100 + i, b: 120 + i })),
      },
    } as unknown as Parameters<typeof judgeAfterReview>[1];
    expect(judgeAfterReview(SPEC, worse).flagged).toBe(true);
    const same = {
      ok: true,
      correctness: { passed: true, detail: '' },
      measured: {
        failed: false,
        pairs: Array.from({ length: 10 }, (_, i) => ({ a: 100 + i, b: 100 + i })),
      },
    } as unknown as Parameters<typeof judgeAfterReview>[1];
    expect(judgeAfterReview(SPEC, same).flagged).toBe(false);
  });
  it('judgeAfterReview: 正しさが落ちる・計測失敗・比較不能はflagged', () => {
    expect(judgeAfterReview(SPEC, { ok: false, detail: 'x' }).flagged).toBe(true);
    expect(
      judgeAfterReview(SPEC, {
        ok: true,
        correctness: { passed: false, detail: 'ng' },
      } as unknown as Parameters<typeof judgeAfterReview>[1]).flagged,
    ).toBe(true);
    expect(
      judgeAfterReview(SPEC, {
        ok: true,
        correctness: { passed: true, detail: '' },
        measured: { failed: true, pairs: [], failedReason: 'r' },
      } as unknown as Parameters<typeof judgeAfterReview>[1]).flagged,
    ).toBe(true);
  });
});

// ---- 6. merge直前 ----

describe('decidePreMerge (受入6)', () => {
  const cmd = (sha: string) => `gh pr merge 5 --merge --match-head-commit ${sha}`;

  it('parseMatchHeadCommit', () => {
    expect(parseMatchHeadCommit(`gh pr merge 5 --match-head-commit ${SHA_A}`)).toBe(SHA_A);
    expect(parseMatchHeadCommit(`gh pr merge 5 --match-head-commit=${SHA_A.toUpperCase()}`)).toBe(
      SHA_A,
    );
    expect(parseMatchHeadCommit(`gh pr merge 5 --match-head-commit "${SHA_A}" --merge`)).toBe(
      SHA_A,
    );
    expect(parseMatchHeadCommit('gh pr merge 5 --merge')).toBeUndefined();
    expect(parseMatchHeadCommit('gh pr merge 5 --match-head-commit abc')).toBeUndefined();
  });
  it('計測結果が無い・別commitの結果なら拒否して計測を始めさせる', () => {
    expect(
      decidePreMerge({ state: trialsState(), command: cmd(SHA_A), headOid: SHA_A }),
    ).toMatchObject({ kind: 'reject', startMeasure: true });
    expect(decidePreMerge({ state: undefined, command: cmd(SHA_A), headOid: SHA_A })).toMatchObject(
      {
        kind: 'reject',
        startMeasure: true,
      },
    );
    const old = trialsState({ preMerge: { commit: SHA_B, status: 'passed', detail: '' } });
    expect(decidePreMerge({ state: old, command: cmd(SHA_A), headOid: SHA_A })).toMatchObject({
      kind: 'reject',
      startMeasure: true,
    });
  });
  it('計測中は拒否(新たに計測は始めない)', () => {
    const s = trialsState({ preMerge: { commit: SHA_A, status: 'measuring', detail: '' } });
    expect(decidePreMerge({ state: s, command: cmd(SHA_A), headOid: SHA_A })).toMatchObject({
      kind: 'reject',
      startMeasure: false,
    });
  });
  it('--match-head-commitが無い・不一致なら、passedでも拒否', () => {
    const s = trialsState({ preMerge: { commit: SHA_A, status: 'passed', detail: '' } });
    expect(
      decidePreMerge({ state: s, command: 'gh pr merge 5 --merge', headOid: SHA_A }),
    ).toMatchObject({ kind: 'reject', startMeasure: false });
    expect(decidePreMerge({ state: s, command: cmd(SHA_B), headOid: SHA_A })).toMatchObject({
      kind: 'reject',
    });
  });
  it('failedは拒否、passed+一致は許可', () => {
    const failed = trialsState({ preMerge: { commit: SHA_A, status: 'failed', detail: '悪い' } });
    expect(decidePreMerge({ state: failed, command: cmd(SHA_A), headOid: SHA_A })).toMatchObject({
      kind: 'reject',
      startMeasure: false,
    });
    const passed = trialsState({ preMerge: { commit: SHA_A, status: 'passed', detail: '' } });
    expect(decidePreMerge({ state: passed, command: cmd(SHA_A), headOid: SHA_A })).toEqual({
      kind: 'allow',
      consumeAllowance: false,
    });
  });
  it('引数の値の中・重複した--match-head-commitは数えない。bash -lcの包みは外して見る', () => {
    expect(
      parseMatchHeadCommit(`gh pr merge 5 --subject "x --match-head-commit ${SHA_A}"`),
    ).toBeUndefined();
    expect(
      parseMatchHeadCommit(
        `gh pr merge 5 --match-head-commit ${SHA_A} --match-head-commit ${SHA_B}`,
      ),
    ).toBeUndefined();
    expect(parseMatchHeadCommit(`gh pr merge 5 --match-head-commit "${SHA_A}`)).toBeUndefined();
    expect(
      parseMatchHeadCommit(`/bin/bash -lc 'gh pr merge 5 --merge --match-head-commit ${SHA_A}'`),
    ).toBe(SHA_A);
    expect(parseMatchHeadCommit(`bash -lc gh pr merge 5 --match-head-commit ${SHA_A}`)).toBe(SHA_A);
  });
  it('連結・パイプ・置換を含む命令は、--match-head-commitが合っていてもpassedでも拒否', () => {
    const passed = trialsState({ preMerge: { commit: SHA_A, status: 'passed', detail: '' } });
    for (const command of [
      `${cmd(SHA_A)} || gh pr merge 5 --admin --merge`,
      `${cmd(SHA_A)}; gh pr merge 6`,
      `${cmd(SHA_A)} && echo ok`,
      `${cmd(SHA_A)} | cat`,
      `${cmd(SHA_A)}\ngh pr merge 6`,
      `gh pr merge $(echo 5) --match-head-commit ${SHA_A}`,
      `bash -lc '${cmd(SHA_A)} || gh pr merge 5 --admin'`,
    ]) {
      expect(decidePreMerge({ state: passed, command, headOid: SHA_A })).toMatchObject({
        kind: 'reject',
        startMeasure: false,
      });
    }
  });
});

describe('OptimizeLoopHost.checkMerge (受入6)', () => {
  it('計測を待たず、計測を背景で始めて即座に拒否理由を返す', async () => {
    const calls: string[] = [];
    const cli = {
      run: vi.fn(async (command: string, args: readonly string[]) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'gh') {
          return { code: 0, stdout: JSON.stringify({ headRefOid: SHA_A, baseRefName: 'main' }) };
        }
        return NEVER_DONE; // git fetchが解決しない=計測が終わらない
      }),
    };
    const host = new OptimizeLoopHost({
      storageDir: '/nonexistent/storage',
      cli: cli as never,
      git: vi.fn(async () => '') as never,
      trialEngine: vi.fn() as never,
      limits: () => LIMITS,
      usageThresholdPct: () => undefined,
      weeklyUsagePct: async () => undefined,
      log: vi.fn(),
    });
    const task = makeTask('T1', 'mergeCleanup', 'running', {
      optimization: SPEC,
      optimizeLoop: trialsState(),
    });
    const run = makeRun([task]);
    const saveState = vi.fn(async () => undefined);
    const result = await Promise.race([
      host.checkMerge({
        run,
        task,
        pullRequestNumber: 5,
        command: `gh pr merge 5 --merge --match-head-commit ${SHA_A}`,
        saveState,
        openGate: vi.fn(async () => undefined),
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 2000)),
    ]);
    expect(result).toBeDefined();
    expect(result).not.toBe('TIMEOUT');
    expect(result).toContain('計測中');
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        preMerge: expect.objectContaining({ commit: SHA_A, status: 'measuring' }),
      }),
    );
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(true);
  });

  function stuckHost(calls: string[]) {
    const cli = {
      run: vi.fn(async (command: string, args: readonly string[]) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'gh') {
          return { code: 0, stdout: JSON.stringify({ headRefOid: SHA_A, baseRefName: 'main' }) };
        }
        return NEVER_DONE;
      }),
    };
    return new OptimizeLoopHost({
      storageDir: '/nonexistent/storage',
      cli: cli as never,
      git: vi.fn(async () => '') as never,
      trialEngine: vi.fn() as never,
      limits: () => LIMITS,
      usageThresholdPct: () => undefined,
      weeklyUsagePct: async () => undefined,
      log: vi.fn(),
    });
  }

  it('保存された「計測中」をこのホストが走らせていなければ(Reload後)、計測を始め直す。2回目は重ねない', async () => {
    const calls: string[] = [];
    const host = stuckHost(calls);
    const task = makeTask('T1', 'mergeCleanup', 'running', {
      optimization: SPEC,
      optimizeLoop: trialsState({
        preMerge: { commit: SHA_A, status: 'measuring', detail: '計測中' },
      }),
    });
    const args = {
      run: makeRun([task]),
      task,
      pullRequestNumber: 5,
      command: `gh pr merge 5 --merge --match-head-commit ${SHA_A}`,
      saveState: vi.fn(async () => undefined),
      openGate: vi.fn(async () => undefined),
    };
    expect(await host.checkMerge(args)).toContain('計測中');
    expect(calls.filter((c) => c.startsWith('git fetch'))).toHaveLength(1);
    expect(await host.checkMerge(args)).toContain('計測中');
    expect(calls.filter((c) => c.startsWith('git fetch'))).toHaveLength(1);
  });

  it('「計測中」の保存に失敗したら、次のmerge命令で計測を始め直せる', async () => {
    const calls: string[] = [];
    const host = stuckHost(calls);
    const task = makeTask('T1', 'mergeCleanup', 'running', {
      optimization: SPEC,
      optimizeLoop: trialsState(),
    });
    const saveState = vi
      .fn<(s: OptimizeLoopState) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const args = {
      run: makeRun([task]),
      task,
      pullRequestNumber: 5,
      command: `gh pr merge 5 --merge --match-head-commit ${SHA_A}`,
      saveState,
      openGate: vi.fn(async () => undefined),
    };
    await expect(host.checkMerge(args)).rejects.toThrow('disk full');
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(false);
    expect(await host.checkMerge(args)).toContain('計測中');
    expect(calls.some((c) => c.startsWith('git fetch'))).toBe(true);
  });
});

describe('stageApprovalHandler のmerge検査の対象 (受入6)', () => {
  it('gh pr merge(--admin付き)・REST・GraphQLのmergeは検査にかけ、拒否を返す', async () => {
    const guard = vi.fn(async () => '計測中');
    const handler = stageApprovalHandler('mergeCleanup', true, undefined, guard);
    for (const command of [
      `gh pr merge 5 --admin --merge`,
      `gh api -X PUT repos/o/r/pulls/5/merge`,
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
      `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    ]) {
      expect(
        await handler({ kind: 'commandExecution' } as never, { input: { command } }),
      ).toMatchObject({ kind: 'auto', decision: 'decline', message: '計測中' });
    }
    expect(guard).toHaveBeenCalledTimes(4);
    expect(
      await handler({ kind: 'commandExecution' } as never, { input: { command: 'gh pr view 5' } }),
    ).toEqual({ kind: 'auto', decision: 'accept' });
    expect(guard).toHaveBeenCalledTimes(4);
  });
});

// ---- 7. proceed ----

describe('merge許可の1回消費 (受入7)', () => {
  it('preMergeFailedをproceedで決着するとallowedOnce。1回だけ許し、消費後は再び拒否', () => {
    const failed = trialsState({ preMerge: { commit: SHA_A, status: 'failed', detail: '悪い' } });
    const resolved = applyOptimizeGateResolution(failed, 'preMergeFailed', 'proceed');
    expect(resolved.action).toBe('allowMergeOnce');
    expect(resolved.state.preMerge?.allowedOnce).toBe(true);
    const command = `gh pr merge 5 --merge --match-head-commit ${SHA_A}`;
    expect(decidePreMerge({ state: resolved.state, command, headOid: SHA_A })).toEqual({
      kind: 'allow',
      consumeAllowance: true,
    });
    const consumed = consumeMergeAllowance(resolved.state);
    expect(consumed.preMerge?.allowedOnce).toBeUndefined();
    expect(decidePreMerge({ state: consumed, command, headOid: SHA_A })).toMatchObject({
      kind: 'reject',
    });
  });
  it('allowedOnceでも--match-head-commitが無ければ許さない', () => {
    const s = trialsState({
      preMerge: { commit: SHA_A, status: 'failed', detail: '', allowedOnce: true },
    });
    expect(
      decidePreMerge({ state: s, command: 'gh pr merge 5 --merge', headOid: SHA_A }),
    ).toMatchObject({ kind: 'reject' });
  });
  it('treeMismatch/worsenedAfterReviewのsendBackは最良の木へ戻して書き直す', () => {
    const r = applyOptimizeGateResolution(trialsState(), 'treeMismatch', 'sendBack');
    expect(r).toMatchObject({
      action: 'restoreBestAndRewrite',
      state: { phase: 'pr', rewritePending: true },
    });
    expect(
      applyOptimizeGateResolution(trialsState(), 'worsenedAfterReview', 'proceed').action,
    ).toBe('continue');
  });
});

// ---- 8. 後片付け ----

describe('OptimizeLoopHost.cleanup (受入8)', () => {
  it('refs/optimize/<run>-<task>/配下のref削除とworktree削除を呼ぶ', async () => {
    const loopId = 'run-1-T1';
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'for-each-ref') {
        return `refs/optimize/${loopId}/best\nrefs/optimize/${loopId}/baseline\nrefs/optimize/other/best\n`;
      }
      return '';
    });
    const host = new OptimizeLoopHost({
      storageDir: '/nonexistent/storage',
      cli: { run: vi.fn() } as never,
      git: git as never,
      trialEngine: vi.fn() as never,
      limits: () => LIMITS,
      usageThresholdPct: () => undefined,
      weeklyUsagePct: async () => undefined,
      log: vi.fn(),
    });
    await host.cleanup('run-1', 'T1', '/repo');
    const calls = git.mock.calls.map(([cwd, args]) => ({ cwd, args: [...args] }));
    expect(calls[0]?.args).toEqual([
      'for-each-ref',
      '--format=%(refname)',
      `refs/optimize/${loopId}/`,
    ]);
    const deleted = calls.filter((c) => c.args[0] === 'update-ref').map((c) => c.args);
    expect(deleted).toEqual([
      ['update-ref', '-d', `refs/optimize/${loopId}/best`],
      ['update-ref', '-d', `refs/optimize/${loopId}/baseline`],
    ]);
    const removed = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removed).toHaveLength(3);
    for (const role of ['baseline', 'best', 'candidate']) {
      expect(removed.some((c) => c.args.at(-1)?.endsWith(`/${role}`))).toBe(true);
    }
    expect(removed.every((c) => c.cwd === '/repo' && c.args.includes('--force'))).toBe(true);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'prune')).toBe(true);
  });
});
