import type { HeadlessSlotLock } from '../loop/headlessSlotLock';
import { runVerifyCommand } from '../verification/commandRunner';
import {
  createCommandMeasure,
  decideAdoption,
  measureAlternating,
  median,
  withMeasureLock,
  type AlternatingResult,
  type MeasureTree,
} from './optimizeMeasure';
import { removeProcessRecord, writeProcessRecord } from './optimizeProcessRecord';
import type { OptimizationSpec } from './optimizeSpec';
import {
  DEFAULT_TRIAL_COMMAND_TIMEOUT_MS,
  DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS,
  DEFAULT_TRIAL_TOTAL_TIMEOUT_MS,
  type OptimizeTrialTimeouts,
} from './optimizeTrial';
import { prepareMeasureWorktree, runGit, type GitRunner } from './optimizeWorktrees';

/**
 * 2つの木を交互に測る（Issue #2111 仕様7・8）。review後の測り直し（A=最良、B=PRのHEAD）と、
 * merge直前の計測（A=最新のmain、B=PRのHEAD）で使う。計測の部品は#2110のもの。
 */

const CORRECTNESS_DETAIL_MAX = 1000;

export interface CompareTreesInput {
  repoDir: string;
  spec: OptimizationSpec;
  aCommit: string;
  bCommit: string;
  aDir: string;
  bDir: string;
  /** #2110のプロセスの記録の置き場。 */
  processRecordDir: string;
  lock?: Pick<HeadlessSlotLock, 'tryAcquire'>;
  timeouts?: OptimizeTrialTimeouts;
  signal?: AbortSignal;
  deps?: { git?: GitRunner; runVerify?: typeof runVerifyCommand };
}

export type CompareTreesResult =
  | { ok: false; detail: string }
  | { ok: true; correctness: { passed: boolean; detail: string }; measured?: AlternatingResult };

/** A・Bの木を用意し、Bの正しさを確かめてから、A・Bを交互に測る。 */
export async function compareTrees(input: CompareTreesInput): Promise<CompareTreesResult> {
  const git = input.deps?.git ?? runGit;
  const runVerify = input.deps?.runVerify ?? runVerifyCommand;
  const { spec } = input;
  const timeouts = input.timeouts ?? {};
  const commandMs = timeouts.commandMs ?? DEFAULT_TRIAL_COMMAND_TIMEOUT_MS;
  const signalPart = input.signal === undefined ? {} : { signal: input.signal };
  const spawned = new Set<number>();
  const writes: Promise<void>[] = [];
  const track = (pid: number, label: string): void => {
    spawned.add(pid);
    writes.push(writeProcessRecord(input.processRecordDir, { pid, label }).catch(() => undefined));
  };
  const runSetup = async (dir: string): Promise<void> => {
    if (spec.setupCommand === undefined) {
      return;
    }
    const result = await runVerify({
      command: spec.setupCommand,
      cwd: dir,
      timeoutMs: commandMs,
      ...signalPart,
      onSpawn: (pid) => track(pid, 'optimize-compare:setup'),
    });
    if (result.exitCode !== 0) {
      throw new Error(`準備のコマンドが失敗しました: ${result.error ?? result.output.slice(-300)}`);
    }
  };
  const run = async (): Promise<CompareTreesResult> => {
    try {
      for (const [dir, commit] of [
        [input.aDir, input.aCommit],
        [input.bDir, input.bCommit],
      ] as const) {
        await prepareMeasureWorktree({
          repoDir: input.repoDir,
          worktreeDir: dir,
          commit,
          allowedPaths: spec.allowedPaths,
          runSetup,
          git,
        });
      }
    } catch (e) {
      return {
        ok: false,
        detail: `木の準備に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const verified = await runVerify({
      command: spec.correctnessCommand,
      cwd: input.bDir,
      timeoutMs: commandMs,
      ...signalPart,
      onSpawn: (pid) => track(pid, 'optimize-compare:correctness'),
    });
    const correctness = {
      passed: verified.exitCode === 0,
      detail:
        verified.exitCode === 0
          ? '通りました'
          : (verified.error ?? verified.output.slice(-CORRECTNESS_DETAIL_MAX)),
    };
    if (!correctness.passed) {
      return { ok: true, correctness };
    }
    const measured = await measureAlternating({
      measure: createCommandMeasure({
        metricSource: spec.metricSource,
        command: spec.metricCommand,
        ...(spec.metricFile === undefined ? {} : { metricFile: spec.metricFile }),
        cwdFor: (tree: MeasureTree) => (tree === 'A' ? input.aDir : input.bDir),
        onSpawn: (pid, tree) => track(pid, `optimize-compare:metric:${tree}`),
      }),
      runs: spec.measurementRuns,
      perRunTimeoutMs: timeouts.perRunMs ?? DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS,
      totalTimeoutMs: timeouts.totalMs ?? DEFAULT_TRIAL_TOTAL_TIMEOUT_MS,
    });
    return { ok: true, correctness, measured };
  };
  try {
    return input.lock === undefined ? await run() : await withMeasureLock(input.lock, run);
  } catch (e) {
    return {
      ok: false,
      detail: `計測に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await Promise.allSettled(writes);
    for (const pid of spawned) {
      await removeProcessRecord(input.processRecordDir, pid).catch(() => undefined);
    }
  }
}

export interface CompareJudgement {
  /** review後: 悪化した。merge直前: 通った。 */
  flagged: boolean;
  detail: string;
}

function failureDetail(result: CompareTreesResult): string | undefined {
  if (!result.ok) {
    return result.detail;
  }
  if (!result.correctness.passed) {
    return `正しさの確認に落ちました: ${result.correctness.detail}`;
  }
  if (result.measured === undefined || result.measured.failed) {
    return `計測に失敗しました: ${result.measured?.failedReason ?? '結果がありません'}`;
  }
  return undefined;
}

/**
 * review後の測り直し（A=最良、B=PRのHEAD）。正しさが落ちた・計測に失敗した・最良がHEADより
 * 最小の差と有意水準を満たして良かった（HEADが有意に悪化した）なら`flagged`。
 */
export function judgeAfterReview(
  spec: Pick<OptimizationSpec, 'direction' | 'minImprovement' | 'significanceLevel'>,
  result: CompareTreesResult,
): CompareJudgement {
  const failure = failureDetail(result);
  if (failure !== undefined) {
    return { flagged: true, detail: failure };
  }
  const pairs = result.ok && result.measured !== undefined ? result.measured.pairs : [];
  // 最良（A）を候補として、HEAD（B）と比べる
  const reversed = decideAdoption({
    pairs: pairs.map((p) => ({ a: p.b, b: p.a })),
    direction: spec.direction,
    minImprovement: spec.minImprovement,
    significanceLevel: spec.significanceLevel,
  });
  return reversed.adopted
    ? {
        flagged: true,
        detail: `review後の木が最良より有意に悪化しました（最良の改善の中央値 ${reversed.medianImprovement}、p値 ${reversed.pValue}）`,
      }
    : {
        flagged: false,
        detail: `最良と比べて有意な悪化はありません（HEADの中央値 ${median(pairs.map((p) => p.b))}）`,
      };
}

/**
 * merge直前の計測（A=最新のmain、B=PRのHEAD）。正しさが通り、mainより最小の差と有意水準を
 * 満たして良かったときだけ`flagged`（通った）。
 */
export function judgePreMerge(
  spec: Pick<OptimizationSpec, 'direction' | 'minImprovement' | 'significanceLevel'>,
  result: CompareTreesResult,
): CompareJudgement {
  const failure = failureDetail(result);
  if (failure !== undefined) {
    return { flagged: false, detail: failure };
  }
  const pairs = result.ok && result.measured !== undefined ? result.measured.pairs : [];
  const decision = decideAdoption({
    pairs,
    direction: spec.direction,
    minImprovement: spec.minImprovement,
    significanceLevel: spec.significanceLevel,
  });
  return { flagged: decision.adopted, detail: decision.reason };
}
