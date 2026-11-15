import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HeadlessSlotLock } from '../loop/headlessSlotLock';
import { runVerifyCommand } from '../verification/commandRunner';
import {
  clipLlmText,
  summarizeTrials,
  type OptimizeLedgerStore,
  type OptimizeLlmText,
  type OptimizeSecondaryResult,
  type OptimizeTrialRecord,
} from './optimizeLedger';
import {
  createCommandMeasure,
  decideAdoption,
  measureAlternating,
  median,
  withMeasureLock,
  type MeasureTree,
  type RunOutcome,
} from './optimizeMeasure';
import { writeProcessRecord, removeProcessRecord } from './optimizeProcessRecord';
import type { OptimizationSpec } from './optimizeSpec';
import {
  captureTrialState,
  describeViolations,
  inspectTrial,
  listChangedFiles,
  type TrialState,
  type TrialViolation,
} from './optimizeTrialInspect';
import {
  buildChangePrompt,
  buildHypothesisPrompt,
  parseHypothesis,
  type TrialContinuation,
  type TrialPromptInput,
} from './optimizeTrialPrompt';
import {
  runTrialStage,
  type TrialEngineConfig,
  type TrialStageResult,
} from './optimizeTrialSession';
import {
  optimizeRef,
  prepareMeasureWorktree,
  resetCandidateToBest,
  runGit,
  snapshotTree,
  type GitRunner,
  type MeasureTreeRole,
} from './optimizeWorktrees';
import { SELF_IMPROVE_PROTECTED_PATHS_FILE, parseProtectedPaths } from './selfImproveGuard';

/**
 * 最適化の試行1回分（Issue #2107）。仮説の段（読み取り専用）→ 変更の段（候補のworktreeだけに書ける）
 * → プロセスグループの停止の確認 → 検査 → 木の固定 → 計測（#2110）→ 採否 → 台帳の記録、を行う。
 * ループ（#2111）からは`runOptimizeTrial`を呼ぶだけにする。
 *
 * 片付け（`refs/optimize/<runId>/`の削除・worktreeの撤去）は#2111のmerge・closeのときに行う。
 */

/** 1つの段の時間の上限の既定（ミリ秒）。 */
export const DEFAULT_TRIAL_STAGE_TIMEOUT_MS = 20 * 60_000;

/** 正しさの確認・準備の1回の時間の上限の既定（ミリ秒）。 */
export const DEFAULT_TRIAL_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** 1回の計測の時間の上限の既定（ミリ秒）。 */
export const DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS = 5 * 60_000;

/** 計測全体の時間の上限の既定（ミリ秒）。 */
export const DEFAULT_TRIAL_TOTAL_TIMEOUT_MS = 60 * 60_000;

/** 負荷（CPUのPSI、%）がこの値を超えた回は捨てて測り直す。 */
const LOAD_DISCARD_THRESHOLD = 50;

const MAX_LOAD_RETRIES = 5;

const CORRECTNESS_DETAIL_MAX = 1000;

export interface OptimizeTrialTimeouts {
  stageMs?: number;
  commandMs?: number;
  perRunMs?: number;
  totalMs?: number;
}

/** 差し替えられる部品。既定は本物。 */
export interface OptimizeTrialDeps {
  git?: GitRunner;
  runStage?: typeof runTrialStage;
  runVerify?: typeof runVerifyCommand;
  now?: () => Date;
}

export interface OptimizeTrialInput {
  runId: string;
  taskId: string;
  /** 試行の番号（1から）。台帳の行数+1。 */
  trial: number;
  /** 本体のリポジトリ（`git worktree`を実行する場所）。 */
  repoDir: string;
  spec: OptimizationSpec;
  /** 最適化の目的（人が承認したもの）。 */
  objective: string;
  /** 基準・最良・候補のworktree（#2110の`prepareMeasureWorktrees`の戻り値）。 */
  dirs: Readonly<Record<MeasureTreeRole, string>>;
  /** 試行前の最良の木のcommit。 */
  bestCommit: string;
  /** 基準値（指標の中央値）。 */
  baselineMetric?: number;
  /** タスクのブランチのref（`refs/heads/<branch>`）。 */
  taskBranchRef?: string;
  ledger: Pick<OptimizeLedgerStore, 'append' | 'read'>;
  engine: TrialEngineConfig;
  /** プロセスの記録（#2110）の置き場。worktreeの外。 */
  processRecordDir: string;
  /** 計測を1つずつにするロック。無ければ取らない。 */
  lock?: Pick<HeadlessSlotLock, 'tryAcquire'>;
  timeouts?: OptimizeTrialTimeouts;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  deps?: OptimizeTrialDeps;
}

export interface OptimizeTrialResult {
  /** 中断された。台帳には書いていない。 */
  aborted: boolean;
  outcome: OptimizeTrialRecord['decision']['outcome'];
  record: OptimizeTrialRecord;
  /** 試行後の木を固定したcommit。固定できなければ無い。 */
  commit?: string;
  /** 採用候補か。`outcome`が`adopted`のときだけ真。最良のrefの更新は#2111が行う。 */
  adoptionCandidate: boolean;
  /** 共有の状態（ref・`.git`・基準や最良のworktree）に触れた、または試行のプロセスが残った。ループは止める。 */
  halt: boolean;
  violations: TrialViolation[];
  /** 変更の段が、仮説の段の会話を続けたか、新しいセッションに仮説を渡したか。 */
  continuation?: TrialContinuation;
}

const EMPTY_LLM: OptimizeLlmText = {
  hypothesis: '（仮説を得られなかった）',
  prediction: '',
  approach: '',
  changeSummary: '',
};

function stddev(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

async function readProtectedPatterns(
  dir: string,
  commit: string,
  git: GitRunner,
): Promise<string[]> {
  try {
    return parseProtectedPaths(
      await git(dir, ['show', `${commit}:${SELF_IMPROVE_PROTECTED_PATHS_FILE}`]),
    );
  } catch {
    return [];
  }
}

function loadSnapshot(): { loadAverage1m: number; freeMemoryMb: number } {
  return {
    loadAverage1m: os.loadavg()[0] ?? 0,
    freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
  };
}

/** 1試行を行い、台帳に1行足す。 */
export async function runOptimizeTrial(input: OptimizeTrialInput): Promise<OptimizeTrialResult> {
  const progress = { sessionStarted: false };
  try {
    return await runOptimizeTrialBody(input, progress);
  } catch (e) {
    // 例外でも台帳に1行残し、同じ試行番号の再試行が続かないようにする。
    // セッションを起動した後なら共有の状態を確かめられていないので、ループは止める
    const aborted = input.signal?.aborted === true;
    const record: OptimizeTrialRecord = {
      trial: input.trial,
      at: (input.deps?.now ?? (() => new Date()))().toISOString(),
      llm: EMPTY_LLM,
      correctness: { passed: false, detail: '試行が例外で終わったため実行していません' },
      metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
      secondary: [],
      load: loadSnapshot(),
      decision: {
        outcome: 'invalid',
        reason: `試行中に例外が起きました: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
    if (!aborted) {
      await input.ledger.append(input.runId, input.taskId, record);
    }
    return {
      aborted,
      outcome: 'invalid',
      record,
      adoptionCandidate: false,
      halt: progress.sessionStarted,
      violations: [],
    };
  }
}

async function runOptimizeTrialBody(
  input: OptimizeTrialInput,
  progress: { sessionStarted: boolean },
): Promise<OptimizeTrialResult> {
  const git = input.deps?.git ?? runGit;
  const runStage = input.deps?.runStage ?? runTrialStage;
  const runVerify = input.deps?.runVerify ?? runVerifyCommand;
  const now = input.deps?.now ?? (() => new Date());
  const { spec } = input;
  const timeouts = input.timeouts ?? {};
  const commandMs = timeouts.commandMs ?? DEFAULT_TRIAL_COMMAND_TIMEOUT_MS;
  const candidateDir = input.dirs.candidate;

  const finish = async (
    partial: Omit<OptimizeTrialRecord, 'trial' | 'at' | 'load'> & {
      load?: OptimizeTrialRecord['load'];
    },
    extra: Pick<OptimizeTrialResult, 'halt' | 'violations'> & { continuation?: TrialContinuation },
  ): Promise<OptimizeTrialResult> => {
    const record: OptimizeTrialRecord = {
      ...partial,
      trial: input.trial,
      at: now().toISOString(),
      load: partial.load ?? loadSnapshot(),
    };
    // 中断された試行は、評価していない仮説を失敗として残さないよう台帳へ書かない
    const aborted = input.signal?.aborted === true;
    if (!aborted) {
      await input.ledger.append(input.runId, input.taskId, record);
    }
    return {
      aborted,
      outcome: record.decision.outcome,
      record,
      ...(record.commit === undefined ? {} : { commit: record.commit }),
      adoptionCandidate: record.decision.outcome === 'adopted',
      halt: extra.halt,
      violations: extra.violations,
      ...(extra.continuation === undefined ? {} : { continuation: extra.continuation }),
    };
  };
  const invalid = (
    llm: OptimizeLlmText,
    reason: string,
    extra: Parameters<typeof finish>[1],
  ): Promise<OptimizeTrialResult> =>
    finish(
      {
        llm,
        correctness: { passed: false, detail: '試行が無効のため実行していません' },
        metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
        secondary: [],
        decision: { outcome: 'invalid', reason },
      },
      extra,
    );

  // 候補を試行前の最良の木へ戻す（準備のコマンドを含む）
  const runSetup = async (dir: string): Promise<void> => {
    if (spec.setupCommand === undefined) {
      return;
    }
    const result = await runVerify({
      command: spec.setupCommand,
      cwd: dir,
      timeoutMs: commandMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.exitCode !== 0) {
      throw new Error(`準備のコマンドが失敗しました: ${result.error ?? result.output.slice(-300)}`);
    }
  };
  await resetCandidateToBest({
    repoDir: input.repoDir,
    candidateDir,
    bestCommit: input.bestCommit,
    allowedPaths: spec.allowedPaths,
    runSetup,
    git,
  });

  const ledgerBefore = await input.ledger.read(input.runId, input.taskId);
  const summary = summarizeTrials(ledgerBefore, spec.direction, input.baselineMetric);
  const promptInput: TrialPromptInput = {
    objective: input.objective,
    spec,
    trial: input.trial,
    ledger: ledgerBefore,
    ...(input.baselineMetric === undefined ? {} : { baselineMetric: input.baselineMetric }),
    ...(summary.best === undefined ? {} : { bestMetric: summary.best }),
  };

  const stateInput = {
    candidateDir,
    baselineDir: input.dirs.baseline,
    bestDir: input.dirs.best,
    runId: input.runId,
    ...(input.taskBranchRef === undefined ? {} : { taskBranchRef: input.taskBranchRef }),
    git,
  };
  const before = await captureTrialState(stateInput);
  const protectedPatterns = await readProtectedPatterns(candidateDir, input.bestCommit, git);
  const stageBase = {
    cwd: candidateDir,
    engine: input.engine,
    timeoutMs: timeouts.stageMs ?? DEFAULT_TRIAL_STAGE_TIMEOUT_MS,
    recordDir: input.processRecordDir,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  const inspect = async (
    stage: TrialStageResult,
    allowedPaths: readonly string[],
  ): Promise<{ state: TrialState; violations: TrialViolation[] }> => {
    const state = await captureTrialState(stateInput);
    const violations = inspectTrial({
      before,
      after: state,
      changedFiles: await listChangedFiles(candidateDir, before.candidateHead, git),
      allowedPaths,
      protectedPatterns,
      bestCommit: input.bestCommit,
    });
    if (stage.process.groupRemains) {
      violations.push({
        kind: 'refsChanged',
        detail: '試行のプロセスグループが止まりませんでした',
        shared: true,
      });
    }
    return { state, violations };
  };
  const halts = (violations: readonly TrialViolation[]): boolean =>
    violations.some((v) => v.shared);

  // 1段目: 仮説。読み取り専用で起動し、終わったら作業ツリーが試行前と同じかを確かめる
  progress.sessionStarted = true;
  const stage1 = await runStage({
    ...stageBase,
    stage: 'hypothesis',
    prompt: buildHypothesisPrompt(promptInput),
  });
  const check1 = await inspect(stage1, []);
  const treeChanged1 =
    check1.state.candidateTree !== before.candidateTree
      ? [
          {
            kind: 'outsideAllowedPaths' as const,
            detail: '仮説の段が候補の作業ツリーを変えました',
            shared: false,
          },
        ]
      : [];
  const violations1 = [...check1.violations, ...treeChanged1];
  if (violations1.length > 0) {
    return invalid(
      EMPTY_LLM,
      `仮説の段の後の検査に通りません: ${describeViolations(violations1)}`,
      {
        halt: halts(violations1),
        violations: violations1,
      },
    );
  }
  if (!stage1.ok) {
    return invalid(EMPTY_LLM, `仮説の段が失敗しました: ${stage1.failure ?? '不明'}`, {
      halt: false,
      violations: [],
    });
  }
  const hypothesis = parseHypothesis(stage1.text);
  if (hypothesis === undefined) {
    return invalid(EMPTY_LLM, '仮説の段の返答を読めませんでした（JSONの仮説・予測・方式が要る）', {
      halt: false,
      violations: [],
    });
  }
  // 仮説はここで固定する。以降は変更の段の出力で差し替えない
  const fixed: OptimizeLlmText = clipLlmText({ ...hypothesis, changeSummary: '' });

  // 2段目: 変更。続けられるなら仮説の段の会話を続ける
  const continuation: TrialContinuation =
    input.engine.engine === 'claude' && stage1.sessionId !== undefined ? 'resume' : 'fresh';
  const stage2 = await runStage({
    ...stageBase,
    stage: 'change',
    prompt: buildChangePrompt(promptInput, fixed, continuation),
    ...(continuation === 'resume' && stage1.sessionId !== undefined
      ? { resumeSessionId: stage1.sessionId }
      : {}),
  });
  const llm: OptimizeLlmText = clipLlmText({ ...fixed, changeSummary: stage2.text });

  // プロセスグループは`runStage`が止めて確かめた。ここから検査に進む
  const check2 = await inspect(stage2, spec.allowedPaths);
  if (stage2.process.groupRemains) {
    return invalid(
      llm,
      `変更の段のプロセスが残っています: ${describeViolations(check2.violations)}`,
      {
        halt: true,
        violations: check2.violations,
        continuation,
      },
    );
  }

  // 試行後の木を固定する（検査に落ちた試行も、何をしたかを後から読めるよう固定する）
  let commit: string | undefined;
  try {
    commit = await snapshotTree({
      workDir: candidateDir,
      ref: optimizeRef(input.runId, { trial: input.trial }),
      message: `optimize trial ${input.trial}`,
      parent: input.bestCommit,
      git,
    });
  } catch {
    commit = undefined;
  }
  const withCommit = commit === undefined ? {} : { commit };

  if (check2.violations.length > 0) {
    return finish(
      {
        llm,
        correctness: { passed: false, detail: '検査に通らないため実行していません' },
        metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
        secondary: [],
        decision: { outcome: 'rejected', reason: describeViolations(check2.violations) },
        ...withCommit,
      },
      { halt: halts(check2.violations), violations: check2.violations, continuation },
    );
  }
  if (!stage2.ok && !stage2.process.timedOut) {
    return finish(
      {
        llm,
        correctness: { passed: false, detail: '変更の段が失敗したため実行していません' },
        metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
        secondary: [],
        decision: {
          outcome: 'invalid',
          reason: `変更の段が失敗しました: ${stage2.failure ?? '不明'}`,
        },
        ...withCommit,
      },
      { halt: false, violations: [], continuation },
    );
  }
  if (commit === undefined) {
    return finish(
      {
        llm,
        correctness: { passed: false, detail: '木を固定できなかったため実行していません' },
        metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
        secondary: [],
        decision: { outcome: 'invalid', reason: '試行後の木をrefに固定できませんでした' },
      },
      { halt: false, violations: [], continuation },
    );
  }

  const measured = await measureCandidate({ input, commit, runVerify, git, runSetup, commandMs });
  return finish({ llm, ...measured, commit }, { halt: false, violations: [], continuation });
}

type MeasuredPart = Pick<
  OptimizeTrialRecord,
  'correctness' | 'metric' | 'secondary' | 'decision' | 'load'
>;

interface MeasureCandidateInput {
  input: OptimizeTrialInput;
  commit: string;
  runVerify: typeof runVerifyCommand;
  git: GitRunner;
  runSetup: (dir: string) => Promise<void>;
  commandMs: number;
}

/** 候補の準備 → 正しさの確認（落ちたら1回だけやり直す）→ 指標と副指標を最良の木と交互に測る → 採否。 */
async function measureCandidate(args: MeasureCandidateInput): Promise<MeasuredPart> {
  const { input, commit, runVerify } = args;
  const { spec } = input;
  const fail = (
    reason: string,
    correctness?: { passed: boolean; detail: string },
  ): MeasuredPart => ({
    correctness: correctness ?? { passed: false, detail: reason },
    metric: { samples: 0, median: Number.NaN, spread: Number.NaN },
    secondary: [],
    load: loadSnapshot(),
    decision: { outcome: 'rejected', reason },
  });

  const run = async (): Promise<MeasuredPart> => {
    try {
      await prepareMeasureWorktree({
        repoDir: input.repoDir,
        worktreeDir: input.dirs.candidate,
        commit,
        allowedPaths: spec.allowedPaths,
        runSetup: args.runSetup,
        git: args.git,
      });
    } catch (e) {
      return fail(`候補の準備に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }

    const spawned = new Set<number>();
    const writes: Promise<void>[] = [];
    const track = (pid: number, label: string): void => {
      spawned.add(pid);
      writes.push(
        writeProcessRecord(input.processRecordDir, { pid, label }).catch(() => undefined),
      );
    };
    try {
      let correctness = { passed: false, detail: '' };
      for (
        let attempt = 1;
        attempt <= 2 && !correctness.passed && input.signal?.aborted !== true;
        attempt += 1
      ) {
        const result = await runVerify({
          command: spec.correctnessCommand,
          cwd: input.dirs.candidate,
          timeoutMs: args.commandMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          onSpawn: (pid) => track(pid, 'optimize-trial:correctness'),
        });
        correctness = {
          passed: result.exitCode === 0,
          detail:
            result.exitCode === 0
              ? `${attempt}回目で通りました`
              : `${attempt}回目: ${result.error ?? result.output.slice(-CORRECTNESS_DETAIL_MAX)}`,
        };
      }
      if (!correctness.passed) {
        return fail('正しさの確認が2回とも失敗しました', correctness);
      }
      return await measureMetric(args, correctness, track);
    } finally {
      // 書き込みが終わる前に消すと、消した後に記録が残る
      await Promise.allSettled(writes);
      for (const pid of spawned) {
        await removeProcessRecord(input.processRecordDir, pid).catch(() => undefined);
      }
    }
  };

  return input.lock === undefined ? run() : withMeasureLock(input.lock, run);
}

async function readSecondaryValues(
  file: string,
  names: readonly string[],
): Promise<Record<string, number>> {
  const values: Record<string, number> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    for (const name of names) {
      const value = parsed[name];
      if (typeof value === 'number' && Number.isFinite(value)) {
        values[name] = value;
      }
    }
  } catch {
    // 読めなければ値なし
  }
  return values;
}

async function measureMetric(
  args: MeasureCandidateInput,
  correctness: { passed: boolean; detail: string },
  track: (pid: number, label: string) => void,
): Promise<MeasuredPart> {
  const { input } = args;
  const { spec } = input;
  const timeouts = input.timeouts ?? {};
  const secondaries = spec.secondaryMetrics ?? [];
  const secondaryValues: Record<string, Record<MeasureTree, number[]>> = {};
  for (const s of secondaries) {
    secondaryValues[s.name] = { A: [], B: [] };
  }
  const cwdFor = (tree: MeasureTree): string =>
    tree === 'A' ? input.dirs.best : input.dirs.candidate;
  const base = createCommandMeasure({
    metricSource: spec.metricSource,
    command: spec.metricCommand,
    ...(spec.metricFile === undefined ? {} : { metricFile: spec.metricFile }),
    cwdFor,
    onSpawn: (pid, tree) => track(pid, `optimize-trial:metric:${tree}`),
  });
  const measure = async (tree: MeasureTree, signal: AbortSignal): Promise<RunOutcome> => {
    const outcome = await base(tree, signal);
    // 負荷で捨てて測り直す回の値は、主指標と同じく使わない
    const discarded =
      outcome.ok && outcome.load !== undefined && outcome.load > LOAD_DISCARD_THRESHOLD;
    if (outcome.ok && !discarded && secondaries.length > 0 && spec.metricFile !== undefined) {
      const got = await readSecondaryValues(
        path.resolve(cwdFor(tree), spec.metricFile),
        secondaries.map((s) => s.name),
      );
      for (const [name, value] of Object.entries(got)) {
        secondaryValues[name]?.[tree].push(value);
      }
    }
    return outcome;
  };
  const result = await measureAlternating({
    measure,
    runs: spec.measurementRuns,
    perRunTimeoutMs: timeouts.perRunMs ?? DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS,
    totalTimeoutMs: timeouts.totalMs ?? DEFAULT_TRIAL_TOTAL_TIMEOUT_MS,
    loadThreshold: LOAD_DISCARD_THRESHOLD,
    maxLoadRetries: MAX_LOAD_RETRIES,
  });
  const load = loadSnapshot();
  const metricBase = {
    samples: result.bValues.length,
    median: median(result.bValues),
    spread: stddev(result.bValues),
  };
  if (result.failed) {
    return {
      correctness,
      metric: metricBase,
      secondary: [],
      load,
      decision: {
        outcome: 'rejected',
        reason: `計測に失敗しました: ${result.failedReason ?? '不明'}`,
      },
    };
  }
  const decision = decideAdoption({
    pairs: result.pairs,
    direction: spec.direction,
    minImprovement: spec.minImprovement,
    significanceLevel: spec.significanceLevel,
  });
  const secondary: OptimizeSecondaryResult[] = secondaries.map((s) => {
    const values = secondaryValues[s.name] ?? { A: [], B: [] };
    const reference = median(values.A);
    const candidate = median(values.B);
    const tolerance =
      s.tolerance.kind === 'absolute'
        ? s.tolerance.value
        : (Math.abs(reference) * s.tolerance.value) / 100;
    const worse = s.direction === 'minimize' ? candidate - reference : reference - candidate;
    return {
      name: s.name,
      samples: values.B.length,
      median: candidate,
      spread: stddev(values.B),
      withinTolerance: Number.isFinite(worse) && worse <= tolerance,
    };
  });
  const outOfTolerance = secondary.filter((s) => !s.withinTolerance).map((s) => s.name);
  const metric = {
    ...metricBase,
    significant: decision.pValue <= spec.significanceLevel,
  };
  if (!decision.adopted) {
    return {
      correctness,
      metric,
      secondary,
      load,
      decision: { outcome: 'rejected', reason: decision.reason },
    };
  }
  if (outOfTolerance.length > 0) {
    return {
      correctness,
      metric,
      secondary,
      load,
      decision: {
        outcome: 'rejected',
        reason: `副指標が許容幅を超えて悪化しました: ${outOfTolerance.join(', ')}`,
      },
    };
  }
  return {
    correctness,
    metric,
    secondary,
    load,
    decision: { outcome: 'adopted', reason: decision.reason },
  };
}
