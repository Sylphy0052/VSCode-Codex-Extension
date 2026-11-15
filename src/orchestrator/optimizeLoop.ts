import type { OptimizeTrialRecord } from './optimizeLedger';
import type { OptimizationSpec } from './optimizeSpec';
import type { OptimizeTrialResult } from './optimizeTrial';
import type { OptimizeGateReason, OrchestratedTask, StageGateChoice } from './taskRunState';

/**
 * 最適化ハーネスのループの制御（Issue #2111）。`optimization`を持つタスクのimplement工程は、
 * ここのループに置き換える。試行1回分は#2107の`runOptimizeTrial`、計測の部品は#2110を使い、
 * ここでは「繰り返す・止める・状態を残す・再開する」だけを決める。
 *
 * 外界（git・プロセス・計測・使用率・状態の保存）はすべて`OptimizeLoopPorts`から触り、
 * 判定は純関数に切り出す。
 */

/** 伸び止まりと見なす、最良が更新されない試行の連続回数。 */
export const PLATEAU_TRIALS = 3;

/** 反証役（#2108）が判定できなかった連続回数がこれに達したら止める。 */
export const MAX_INCONCLUSIVE_REFUTATIONS = 3;

/** 拡張の設定の「上限の上限」の既定。仕様の予算はこれを超えられない。 */
export const DEFAULT_LOOP_LIMITS: OptimizeLoopLimits = { maxTrials: 50, maxMinutes: 24 * 60 };

/** 拡張の設定の上限の上限。 */
export interface OptimizeLoopLimits {
  maxTrials: number;
  maxMinutes: number;
}

/**
 * ループの段階。`baseline`は基準値の計測待ち、`trials`は試行中、`pr`は止まった後にPRを書く
 * セッションへ渡した、`done`は最適化の工程を終えた。
 */
export type OptimizeLoopPhase = 'baseline' | 'trials' | 'pr' | 'done';

export type OptimizeStopReason =
  | 'trialBudget'
  | 'timeBudget'
  | 'plateau'
  | 'target'
  | 'usage'
  | 'refutation'
  | 'userStopped'
  | 'halted';

export const STOP_REASON_LABELS: Record<OptimizeStopReason, string> = {
  trialBudget: '試行回数の予算を使い切った',
  timeBudget: '時間の予算を使い切った',
  plateau: '伸び止まり（組み直した後も最良が更新されない）',
  target: '目標値に届いた',
  usage: '週次使用率が閾値以上',
  refutation: '反証役が続けて判定できない',
  userStopped: '利用者が止めた',
  halted: '試行が共有の状態に触れた、またはプロセスが残った',
};

export interface OptimizeBestCandidate {
  /** 指標の中央値。 */
  metric: number;
  /** 木を固定したcommit。 */
  commit: string;
  /** `refs/optimize/<runId>/best`。 */
  ref: string;
  /** 採った試行の番号。 */
  trial: number;
}

/** merge直前の計測（Issue #2111 仕様8）。PRのHEADのcommitごとに1つだけ持つ。 */
export interface OptimizePreMerge {
  commit: string;
  status: 'measuring' | 'passed' | 'failed';
  detail: string;
  /** 関門で人が`proceed`を選んだ。このcommitに限ってmergeを1回許す。 */
  allowedOnce?: boolean;
}

/** `TaskRun`のタスクへ保存するループの状態。 */
export interface OptimizeLoopState {
  phase: OptimizeLoopPhase;
  /** 台帳に記録した試行の回数（中断を含む）。 */
  trials: number;
  /** ループを回した時間の合計（ミリ秒）。中断・Reloadをまたいで足す。 */
  elapsedMs: number;
  baseline?: { metric: number; commit: string };
  best?: OptimizeBestCandidate;
  /** 最良が更新されなかった試行の連続回数。 */
  plateau: number;
  /** 「別の方式で組み直す」指示を出したか。 */
  rebuilt: boolean;
  /** 反証役が判定できなかった連続回数。 */
  inconclusiveStreak: number;
  /** 始めて台帳に書く前の試行の番号。Reload後に「中断」と記録する。 */
  inFlightTrial?: number;
  stopReason?: OptimizeStopReason;
  /** review後・PR作成後に測った木（`git rev-parse <commit>^{tree}`）。同じ木は測り直さない。 */
  measuredTree?: string;
  preMerge?: OptimizePreMerge;
  /** PRを書くセッションを始める前に、作業ツリーを最良の木へ戻す（ループが止まった直後・関門の`sendBack`）。 */
  rewritePending?: boolean;
}

export function initialLoopState(): OptimizeLoopState {
  return {
    phase: 'baseline',
    trials: 0,
    elapsedMs: 0,
    plateau: 0,
    rebuilt: false,
    inconclusiveStreak: 0,
  };
}

/** 仕様の予算を、拡張の設定の上限の上限で切り詰める。 */
export function effectiveBudget(
  spec: Pick<OptimizationSpec, 'budget'>,
  limits: OptimizeLoopLimits,
): OptimizeLoopLimits {
  return {
    maxTrials: Math.max(0, Math.min(spec.budget.maxTrials, limits.maxTrials)),
    maxMinutes: Math.max(0, Math.min(spec.budget.maxMinutes, limits.maxMinutes)),
  };
}

/** 目標値に届いたか。目標が無い・最良が無ければ届いていない。 */
export function reachedTarget(
  spec: Pick<OptimizationSpec, 'direction' | 'target'>,
  best: number | undefined,
): boolean {
  if (spec.target === undefined || best === undefined || !Number.isFinite(best)) {
    return false;
  }
  return spec.direction === 'minimize' ? best <= spec.target : best >= spec.target;
}

/**
 * 週次使用率で止めるか（Issue #2111 仕様4）。分かっていて閾値以上なら止める。分からないときは
 * 止めず、上限だけで止める。既存の`decideUsage`（分からないと止める）とは逆の倒し方にする。
 */
export function shouldStopForUsage(
  usagePct: number | undefined,
  thresholdPct: number | undefined,
): boolean {
  return (
    usagePct !== undefined &&
    thresholdPct !== undefined &&
    Number.isFinite(usagePct) &&
    usagePct >= thresholdPct
  );
}

export interface StopCheckInput {
  state: OptimizeLoopState;
  spec: Pick<OptimizationSpec, 'budget' | 'direction' | 'target'>;
  limits: OptimizeLoopLimits;
  usagePct: number | undefined;
  usageThresholdPct: number | undefined;
  userStopped: boolean;
}

export type StopDecision =
  { stop: true; reason: OptimizeStopReason } | { stop: false; rebuild: boolean };

/** 次の試行の前に、止めるかを決める。止めないとき、組み直しの指示を出すかも返す。 */
export function decideStop(input: StopCheckInput): StopDecision {
  const { state } = input;
  if (input.userStopped) {
    return { stop: true, reason: 'userStopped' };
  }
  if (reachedTarget(input.spec, state.best?.metric)) {
    return { stop: true, reason: 'target' };
  }
  const budget = effectiveBudget(input.spec, input.limits);
  if (state.trials >= budget.maxTrials) {
    return { stop: true, reason: 'trialBudget' };
  }
  if (state.elapsedMs >= budget.maxMinutes * 60_000) {
    return { stop: true, reason: 'timeBudget' };
  }
  if (shouldStopForUsage(input.usagePct, input.usageThresholdPct)) {
    return { stop: true, reason: 'usage' };
  }
  if (state.inconclusiveStreak >= MAX_INCONCLUSIVE_REFUTATIONS) {
    return { stop: true, reason: 'refutation' };
  }
  if (state.plateau >= PLATEAU_TRIALS) {
    return state.rebuilt ? { stop: true, reason: 'plateau' } : { stop: false, rebuild: true };
  }
  return { stop: false, rebuild: false };
}

/** 組み直しの指示を出した後の状態。伸び止まりを数え直す。 */
export function markRebuilt(state: OptimizeLoopState): OptimizeLoopState {
  return { ...state, rebuilt: true, plateau: 0 };
}

function isBetter(
  direction: OptimizationSpec['direction'],
  next: number,
  current: number,
): boolean {
  return direction === 'minimize' ? next < current : next > current;
}

/**
 * 試行1回の結果を状態へ反映する。最良の更新は、試行が採用候補で、木を固定したcommitがあり、
 * `bestRef`（`refs/optimize/<runId>/best`を更新した後のref）が渡されたときだけ行う。
 */
export function applyTrialResult(
  state: OptimizeLoopState,
  result: Pick<OptimizeTrialResult, 'adoptionCandidate' | 'commit' | 'record'>,
  direction: OptimizationSpec['direction'],
  bestRef: string | undefined,
): OptimizeLoopState {
  const metric = result.record.metric.median;
  const improved =
    result.adoptionCandidate &&
    result.commit !== undefined &&
    bestRef !== undefined &&
    Number.isFinite(metric) &&
    (state.best === undefined || isBetter(direction, metric, state.best.metric));
  const verdict = result.record.refutation?.verdict;
  const inconclusiveStreak =
    verdict === undefined
      ? state.inconclusiveStreak
      : verdict === 'inconclusive'
        ? state.inconclusiveStreak + 1
        : 0;
  const next: OptimizeLoopState = {
    ...state,
    trials: Math.max(state.trials, result.record.trial),
    plateau: improved ? 0 : state.plateau + 1,
    inconclusiveStreak,
  };
  delete next.inFlightTrial;
  if (improved) {
    next.best = {
      metric,
      commit: result.commit!,
      ref: bestRef!,
      trial: result.record.trial,
    };
  }
  return next;
}

/** 基準値の計測の結果。失敗は準備・正しさ・指標のどこで落ちたか。 */
export type BaselineResult =
  | { ok: true; metric: number; commit: string }
  | { ok: false; step: 'setup' | 'correctness' | 'metric'; detail: string };

export const BASELINE_STEP_LABELS: Record<'setup' | 'correctness' | 'metric', string> = {
  setup: '準備',
  correctness: '正しさの確認',
  metric: '指標の計測',
};

export interface RunTrialArgs {
  trial: number;
  bestCommit: string;
  baselineMetric: number;
  /** 「別の方式で組み直す」指示を出す。 */
  rebuild: boolean;
  signal: AbortSignal;
}

/** ループが外界へ触る口。テストでは差し替える。 */
export interface OptimizeLoopPorts {
  now(): Date;
  measureBaseline(signal: AbortSignal): Promise<BaselineResult>;
  runTrial(args: RunTrialArgs): Promise<OptimizeTrialResult>;
  /** 採った試行のcommitを`refs/optimize/<runId>/best`と最良のworktreeへ反映し、refを返す。 */
  promoteBest(commit: string, trial: number): Promise<string>;
  /** 週次使用率（%）。分からなければ`undefined`。 */
  readUsagePct(): Promise<number | undefined>;
  saveState(state: OptimizeLoopState): Promise<void>;
  /** 一時停止（`pause_stage`）が求められたか。次の試行の前で止まる。 */
  isPauseRequested(): boolean;
}

export interface OptimizeLoopInput {
  spec: OptimizationSpec;
  limits: OptimizeLoopLimits;
  usageThresholdPct: number | undefined;
  state: OptimizeLoopState;
  /** `stop_stage`・runの停止で中断する。試行と計測のプロセスもこれで止まる。 */
  signal: AbortSignal;
  ports: OptimizeLoopPorts;
}

export type OptimizeLoopOutcome =
  | { kind: 'stopped'; reason: OptimizeStopReason; state: OptimizeLoopState }
  | { kind: 'baselineFailed'; detail: string; state: OptimizeLoopState }
  | { kind: 'paused'; state: OptimizeLoopState };

/**
 * ループを回す。基準値が無ければ先に測り、失敗したら試行を始めずに`baselineFailed`を返す
 * （呼び出し側が最適化の関門を立てる）。止め方のどれかに当たるか、一時停止が求められたら返す。
 */
export async function runOptimizeLoop(input: OptimizeLoopInput): Promise<OptimizeLoopOutcome> {
  const { ports, spec } = input;
  let state = input.state;
  let segmentStart = ports.now().getTime();
  const tick = (): void => {
    const now = ports.now().getTime();
    state = { ...state, elapsedMs: state.elapsedMs + Math.max(0, now - segmentStart) };
    segmentStart = now;
  };
  const save = async (): Promise<void> => {
    tick();
    await ports.saveState(state);
  };
  const stop = async (reason: OptimizeStopReason): Promise<OptimizeLoopOutcome> => {
    state = { ...state, phase: 'pr', stopReason: reason, rewritePending: true };
    await save();
    return { kind: 'stopped', reason, state };
  };

  // 基準値が無いまま止められたら、PRを書く段へは進めない（最良も基準も無い）。やり直しで測り直す
  const stopBeforeBaseline = async (): Promise<OptimizeLoopOutcome> => {
    state = { ...state, phase: 'baseline', stopReason: 'userStopped' };
    await save();
    return { kind: 'stopped', reason: 'userStopped', state };
  };

  if (state.baseline === undefined) {
    if (input.signal.aborted) {
      return stopBeforeBaseline();
    }
    const baseline = await ports.measureBaseline(input.signal);
    if (input.signal.aborted) {
      return stopBeforeBaseline();
    }
    if (!baseline.ok) {
      state = { ...state, phase: 'baseline' };
      await save();
      return {
        kind: 'baselineFailed',
        detail: `基準値の${BASELINE_STEP_LABELS[baseline.step]}に失敗した: ${baseline.detail}`,
        state,
      };
    }
    state = {
      ...state,
      phase: 'trials',
      baseline: { metric: baseline.metric, commit: baseline.commit },
    };
    await save();
  } else if (state.phase === 'baseline') {
    state = { ...state, phase: 'trials' };
  }

  for (;;) {
    tick();
    const usagePct = await ports.readUsagePct().catch(() => undefined);
    const decision = decideStop({
      state,
      spec,
      limits: input.limits,
      usagePct,
      usageThresholdPct: input.usageThresholdPct,
      userStopped: input.signal.aborted,
    });
    if (decision.stop) {
      return stop(decision.reason);
    }
    if (ports.isPauseRequested()) {
      await save();
      return { kind: 'paused', state };
    }
    if (decision.rebuild) {
      state = markRebuilt(state);
    }
    const trial = state.trials + 1;
    state = { ...state, inFlightTrial: trial };
    await save();
    const result = await ports.runTrial({
      trial,
      bestCommit: state.best?.commit ?? state.baseline!.commit,
      baselineMetric: state.baseline!.metric,
      rebuild: decision.rebuild,
      signal: input.signal,
    });
    if (result.aborted) {
      // 台帳には書かれていない。inFlightTrialを残し、再開時に「中断」と記録させる
      await save();
      return stop('userStopped');
    }
    const bestRef =
      result.adoptionCandidate && result.commit !== undefined
        ? await ports.promoteBest(result.commit, trial)
        : undefined;
    state = applyTrialResult(state, result, spec.direction, bestRef);
    if (result.halt) {
      return stop('halted');
    }
    await save();
  }
}

/** 台帳へ「中断」と記録する行。 */
export function interruptedRecord(trial: number, at: string): OptimizeTrialRecord {
  return {
    trial,
    at,
    llm: { hypothesis: '（中断）', prediction: '', approach: '', changeSummary: '' },
    correctness: { passed: false, detail: '試行の途中で中断したため実行していません' },
    metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
    secondary: [],
    load: { loadAverage1m: 0, freeMemoryMb: 0 },
    decision: {
      outcome: 'invalid',
      reason: '中断（Reload・停止で試行の途中から再開できないため捨てた）',
    },
  };
}

/** 再開の準備で外界へ触る口。 */
export interface ResumePorts {
  now(): Date;
  /** #2110のプロセスの記録から、開始時刻が一致するものだけをプロセスグループごと止める。 */
  killRecordedProcesses(): Promise<{ killed: number; discarded: number }>;
  /** `refs/optimize/<runId>/best`のcommit。無ければ`undefined`。 */
  readBestRef(): Promise<string | undefined>;
  /** 最良の木（無ければ基準の木）へ候補・最良のworktreeを戻す。 */
  restoreTrees(bestCommit: string): Promise<void>;
  readLedger(): Promise<OptimizeTrialRecord[]>;
  appendLedger(record: OptimizeTrialRecord): Promise<void>;
}

export interface ResumeReport {
  state: OptimizeLoopState;
  killed: number;
  discarded: number;
  /** 「中断」と記録した試行の番号。 */
  interruptedTrial?: number;
}

/**
 * Reload・中断からの再開の準備（Issue #2111 仕様5）。残ったプロセスを止め、最良の木を
 * `refs/optimize/<runId>/best`から戻し、途中だった試行を台帳に「中断」と記録して捨てる。
 * 試行の回数は状態と台帳の多い方を引き継ぐ。
 */
export async function prepareLoopResume(
  state: OptimizeLoopState,
  ports: ResumePorts,
): Promise<ResumeReport> {
  const processes = await ports.killRecordedProcesses();
  const next: OptimizeLoopState = { ...state };
  const ledger = await ports.readLedger();
  let interruptedTrial: number | undefined;
  if (state.inFlightTrial !== undefined) {
    const trial = state.inFlightTrial;
    if (!ledger.some((r) => r.trial === trial)) {
      await ports.appendLedger(interruptedRecord(trial, ports.now().toISOString()));
      interruptedTrial = trial;
    }
    delete next.inFlightTrial;
    next.trials = Math.max(next.trials, trial);
  }
  next.trials = Math.max(next.trials, ...ledger.map((r) => r.trial));
  const refCommit = await ports.readBestRef();
  if (next.best !== undefined && refCommit !== undefined && refCommit !== next.best.commit) {
    // 状態の保存より先にrefを更新して落ちた。refを正とする（指標は台帳から引く）
    const adopted = ledger.find((r) => r.commit === refCommit);
    next.best = {
      ...next.best,
      commit: refCommit,
      ...(adopted === undefined ? {} : { metric: adopted.metric.median, trial: adopted.trial }),
    };
  }
  const restoreTo = next.best?.commit ?? next.baseline?.commit;
  if (restoreTo !== undefined) {
    await ports.restoreTrees(restoreTo);
  }
  return {
    state: next,
    killed: processes.killed,
    discarded: processes.discarded,
    ...(interruptedTrial === undefined ? {} : { interruptedTrial }),
  };
}

/** 最適化のタスクで、implementのセッションを始めてよいか（Issue #2111 仕様1）。 */
export function implementSessionBlockReason(
  task: Pick<OrchestratedTask, 'optimization' | 'optimizeLoop'>,
): string | undefined {
  if (task.optimization === undefined) {
    return undefined;
  }
  const phase = task.optimizeLoop?.phase;
  if (phase === 'pr' || phase === 'done') {
    return undefined;
  }
  return '最適化のタスクのimplementは、最適化のループを通してだけ始める（ループが止まる前にPRを書くセッションを始めない）';
}

// ---- merge直前の計測（Issue #2111 仕様8） ----

export const PRE_MERGE_MEASURING_MESSAGE =
  'mergeしない: 計測中。終わったらもう一度merge命令を出す（--match-head-commit <計測したcommit> を付ける）';

/** `gh pr merge`の命令から`--match-head-commit`の値を取る。無ければ`undefined`。 */
export function parseMatchHeadCommit(command: string): string | undefined {
  const match = /(?:^|\s)--match-head-commit(?:=|\s+)["']?([0-9a-fA-F]{7,64})["']?(?=\s|$)/.exec(
    command,
  );
  return match?.[1]?.toLowerCase();
}

export type PreMergeDecision =
  | { kind: 'allow'; consumeAllowance: boolean }
  | { kind: 'reject'; reason: string; startMeasure: boolean };

/**
 * merge命令を許すか。PRのHEADのcommitの計測結果がまだ無ければ拒否し、背景で計測を始めさせる
 * （承認の応答を計測の間ずっと待たせない）。許すのは、命令に測ったcommitの
 * `--match-head-commit`が付いていて、計測が通った（または関門で人が1回だけ許した）ときだけ。
 */
export function decidePreMerge(input: {
  state: OptimizeLoopState | undefined;
  command: string;
  headOid: string;
}): PreMergeDecision {
  const head = input.headOid.toLowerCase();
  const pm = input.state?.preMerge;
  if (pm === undefined || pm.commit.toLowerCase() !== head) {
    return { kind: 'reject', reason: PRE_MERGE_MEASURING_MESSAGE, startMeasure: true };
  }
  if (pm.status === 'measuring') {
    return { kind: 'reject', reason: PRE_MERGE_MEASURING_MESSAGE, startMeasure: false };
  }
  if (parseMatchHeadCommit(input.command) !== head) {
    return {
      kind: 'reject',
      reason: `mergeしない: 命令に --match-head-commit ${head} を付ける（計測したcommit以外をmergeさせないため）`,
      startMeasure: false,
    };
  }
  if (pm.status === 'passed') {
    return { kind: 'allow', consumeAllowance: false };
  }
  if (pm.allowedOnce === true) {
    return { kind: 'allow', consumeAllowance: true };
  }
  return {
    kind: 'reject',
    reason: `mergeしない: merge直前の計測でmainより良くなかった（${pm.detail}）。最適化の関門で人が決めるのを待つ`,
    startMeasure: false,
  };
}

/** 1回許したmergeを使った後の状態。 */
export function consumeMergeAllowance(state: OptimizeLoopState): OptimizeLoopState {
  if (state.preMerge === undefined) {
    return state;
  }
  const preMerge: OptimizePreMerge = { ...state.preMerge };
  delete preMerge.allowedOnce;
  return { ...state, preMerge };
}

// ---- 関門の決着（Issue #2111 仕様2・6・7・8） ----

export type OptimizeGateAction =
  /** 基準値を測り直す（implementを始め直す）。 */
  | 'remeasureBaseline'
  /** そのまま進める。 */
  | 'continue'
  /** 作業ツリーを最良の木へ戻し、PRを書くセッションに反映させ直す。 */
  | 'restoreBestAndRewrite'
  /** そのcommitに限ってmergeを1回許す。 */
  | 'allowMergeOnce'
  /** mergeせずに完了にする（関門の決着側で済む）。 */
  | 'close';

/** 最適化の関門の決着から、ループがすることと次の状態を決める。 */
export function applyOptimizeGateResolution(
  state: OptimizeLoopState,
  reason: OptimizeGateReason,
  choice: StageGateChoice,
): { state: OptimizeLoopState; action: OptimizeGateAction } {
  if (choice === 'close') {
    return { state: { ...state, phase: 'done' }, action: 'close' };
  }
  switch (reason) {
    case 'baselineFailed': {
      const next: OptimizeLoopState = { ...state, phase: 'baseline' };
      delete next.baseline;
      return { state: next, action: 'remeasureBaseline' };
    }
    case 'treeMismatch':
      return choice === 'sendBack'
        ? {
            state: { ...state, phase: 'pr', rewritePending: true },
            action: 'restoreBestAndRewrite',
          }
        : { state, action: 'continue' };
    case 'worsenedAfterReview':
      return choice === 'sendBack'
        ? {
            state: { ...state, phase: 'pr', rewritePending: true },
            action: 'restoreBestAndRewrite',
          }
        : { state, action: 'continue' };
    case 'preMergeFailed':
      return state.preMerge === undefined
        ? { state, action: 'continue' }
        : {
            state: { ...state, preMerge: { ...state.preMerge, allowedOnce: true } },
            action: 'allowMergeOnce',
          };
  }
}

// ---- 木の比較・計測の判定（Issue #2111 仕様6・7・8） ----

/** PRのHEADの木が最良の候補の木と一致するか。 */
export async function sameTree(
  revParseTree: (commit: string) => Promise<string>,
  a: string,
  b: string,
): Promise<boolean> {
  const [ta, tb] = await Promise.all([revParseTree(a), revParseTree(b)]);
  return ta.trim() !== '' && ta.trim() === tb.trim();
}
