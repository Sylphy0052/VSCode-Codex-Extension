import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { HeadlessSlotLock, type HeadlessSlot } from '../loop/headlessSlotLock';
import { runVerifyCommand } from '../verification/commandRunner';
import type { OptimizeDelta, OptimizeDirection, OptimizeMetricSource } from './optimizeSpec';
import { parsePressureSomeTotal } from './resourceSampler';

/**
 * 最適化の計測（Issue #2110）。比べる2つの木を同じ回の中で「A・B・A・B…」と交互にN回ずつ測り、
 * ペアの差で採否を決める。#2107（試行）と#2111（ループ）から関数として呼ぶ。
 *
 * 採否の判定:
 * - 最小の差: 改善の中央値が最小の差以上。最小の差がばらつき（ペアの差のMAD）より小さければ
 *   ばらつきまで引き上げ、引き上げたことを結果に記録する。
 * - 有意水準: ペアの差の符号検定（片側・正確二項検定）。差が0のペアは除く。方法は`SIGN_TEST`に記録。
 */

export const SIGN_TEST = 'ペアの差の符号検定（片側・正確二項検定。差が0のペアは除く）';

export type MeasureTree = 'A' | 'B';

export type RunOutcome =
  | {
      ok: true;
      value: number;
      /** 計測中のCPUのPSI（%）。取れなければ省く。 */
      load?: number;
    }
  | { ok: false; reason: string };

export interface MeasureFailure {
  tree: MeasureTree;
  round: number;
  reason: string;
}

export interface AlternatingResult {
  aValues: number[];
  bValues: number[];
  /** 同じ回でA・Bとも測れたペア。 */
  pairs: { a: number; b: number }[];
  failures: MeasureFailure[];
  /** 負荷が閾値を超えて捨てて測り直した回数。 */
  loadDiscards: number;
  /** 失敗が過半数、または使えるペアが無い。 */
  failed: boolean;
  failedReason?: string;
}

export interface MeasureAlternatingInput {
  /** 1回の計測。`signal`は1回の時間の上限・計測全体の上限で中断される。 */
  measure(tree: MeasureTree, signal: AbortSignal): Promise<RunOutcome>;
  /** 各木を測る回数N。 */
  runs: number;
  /** 1回の計測の時間の上限（ミリ秒）。 */
  perRunTimeoutMs: number;
  /** 計測全体の時間の上限（ミリ秒）。 */
  totalTimeoutMs: number;
  /** この値（%）を超えた回は捨てて測り直す。未指定なら捨てない。 */
  loadThreshold?: number;
  /** 測り直しの合計回数の上限。尽きた後に閾値を超えた回は失敗として数える。 */
  maxLoadRetries?: number;
  now?: () => number;
}

class RunTimeoutError extends Error {}

async function runWithTimeout(
  measure: MeasureAlternatingInput['measure'],
  tree: MeasureTree,
  timeoutMs: number,
): Promise<RunOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RunTimeoutError(`時間の上限 ${timeoutMs}ms を超えました`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([measure(tree, controller.signal), timeout]);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 同じ回の中で`A,B,A,B…`の順に測る。 */
export async function measureAlternating(
  input: MeasureAlternatingInput,
): Promise<AlternatingResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.totalTimeoutMs;
  const maxRetries = input.maxLoadRetries ?? 0;
  const result: AlternatingResult = {
    aValues: [],
    bValues: [],
    pairs: [],
    failures: [],
    loadDiscards: 0,
    failed: false,
  };
  let retriesUsed = 0;

  for (let round = 0; round < input.runs; round += 1) {
    const got: Partial<Record<MeasureTree, number>> = {};
    for (const tree of ['A', 'B'] as const) {
      for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          result.failures.push({ tree, round, reason: '計測全体の時間の上限を超えました' });
          break;
        }
        const outcome = await runWithTimeout(
          input.measure,
          tree,
          Math.min(input.perRunTimeoutMs, remaining),
        );
        if (!outcome.ok) {
          result.failures.push({ tree, round, reason: outcome.reason });
          break;
        }
        const overloaded =
          input.loadThreshold !== undefined &&
          outcome.load !== undefined &&
          outcome.load > input.loadThreshold;
        if (overloaded) {
          result.loadDiscards += 1;
          if (retriesUsed < maxRetries) {
            retriesUsed += 1;
            continue;
          }
          result.failures.push({
            tree,
            round,
            reason: `負荷が閾値 ${input.loadThreshold}% を超え、測り直しの上限に達しました`,
          });
          break;
        }
        got[tree] = outcome.value;
        (tree === 'A' ? result.aValues : result.bValues).push(outcome.value);
        break;
      }
    }
    if (got.A !== undefined && got.B !== undefined) {
      result.pairs.push({ a: got.A, b: got.B });
    }
  }

  const total = input.runs * 2;
  if (result.failures.length * 2 > total) {
    result.failed = true;
    result.failedReason = `${total}回中${result.failures.length}回が失敗し、過半数を超えました`;
  } else if (result.pairs.length === 0) {
    result.failed = true;
    result.failedReason = '同じ回でA・Bとも測れたペアがありません';
  }
  return result;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 中央値からの絶対偏差の中央値。 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** 片側の正確な符号検定: n回中wins回以上Bが良い確率（p=0.5）。 */
export function signTestPValue(wins: number, n: number): number {
  if (n <= 0) {
    return 1;
  }
  let sum = 0;
  let coef = 1; // C(n, 0)
  const coefs: number[] = [1];
  for (let k = 1; k <= n; k += 1) {
    coef = (coef * (n - k + 1)) / k;
    coefs.push(coef);
  }
  for (let k = wins; k <= n; k += 1) {
    sum += coefs[k]!;
  }
  return Math.min(1, sum / 2 ** n);
}

export interface AdoptionInput {
  /** 比べる相手（基準または最良）と候補のペア。 */
  pairs: readonly { a: number; b: number }[];
  direction: OptimizeDirection;
  minImprovement: OptimizeDelta;
  significanceLevel: number;
}

export interface AdoptionDecision {
  adopted: boolean;
  /** 候補の改善（良い方向を正とする）のペアの差の中央値。 */
  medianImprovement: number;
  /** 設定の最小の差（絶対値へ換算後）。 */
  configuredMinDelta: number;
  /** 判定に使った最小の差。ばらつきより小さければばらつきまで引き上げる。 */
  effectiveMinDelta: number;
  raisedToSpread: boolean;
  /** ペアの差のばらつき（MAD）。 */
  spread: number;
  pValue: number;
  method: string;
  reason: string;
}

/** 候補（B）をA（基準または最良）と比べて採るかを決める。 */
export function decideAdoption(input: AdoptionInput): AdoptionDecision {
  const sign = input.direction === 'minimize' ? 1 : -1;
  const improvements = input.pairs.map((p) => sign * (p.a - p.b));
  const medianImprovement = median(improvements);
  const configured =
    input.minImprovement.kind === 'absolute'
      ? input.minImprovement.value
      : (Math.abs(median(input.pairs.map((p) => p.a))) * input.minImprovement.value) / 100;
  const spread = medianAbsoluteDeviation(improvements);
  const raised = Number.isFinite(spread) && configured < spread;
  const effective = raised ? spread : configured;
  const nonTies = improvements.filter((d) => d !== 0);
  const wins = nonTies.filter((d) => d > 0).length;
  const pValue = signTestPValue(wins, nonTies.length);
  const base = {
    medianImprovement,
    configuredMinDelta: configured,
    effectiveMinDelta: effective,
    raisedToSpread: raised,
    spread,
    pValue,
    method: SIGN_TEST,
  };
  if (improvements.length === 0) {
    return { ...base, adopted: false, reason: '比べられるペアがありません' };
  }
  if (!(medianImprovement >= effective)) {
    return {
      ...base,
      adopted: false,
      reason: `改善の中央値 ${medianImprovement} が最小の差 ${effective} に届きません`,
    };
  }
  if (!(pValue <= input.significanceLevel)) {
    return {
      ...base,
      adopted: false,
      reason: `p値 ${pValue} が有意水準 ${input.significanceLevel} を超えています`,
    };
  }
  return { ...base, adopted: true, reason: '最小の差と有意水準を満たしました' };
}

/** 計測全体を1つずつにするロックの置き場の既定の名前。`HeadlessSlotLock`と同じ方式。 */
export function createMeasureLock(
  dir: string,
  logWarn?: (message: string) => void,
): HeadlessSlotLock {
  return new HeadlessSlotLock(dir, logWarn);
}

export interface WithMeasureLockOptions {
  /** 取れなかったときの待ち間隔（ミリ秒）。 */
  pollMs?: number;
  /** 取れるまで待つ上限（ミリ秒）。超えたら例外。 */
  waitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** ロックを取ってから`fn`を実行し、終わったら（失敗しても）返す。 */
export async function withMeasureLock<T>(
  lock: Pick<HeadlessSlotLock, 'tryAcquire'>,
  fn: () => Promise<T>,
  options: WithMeasureLockOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();
  let slot: HeadlessSlot | undefined;
  while (slot === undefined) {
    slot = await lock.tryAcquire('background');
    if (slot === undefined) {
      if (Date.now() - startedAt >= (options.waitTimeoutMs ?? 30 * 60_000)) {
        throw new Error('計測のロックを取れませんでした（他の計測が続いています）');
      }
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    await slot.release();
  }
}

/** `/proc/pressure/cpu`のsomeのtotal（マイクロ秒）。読めなければ`undefined`。 */
export async function readCpuPressureTotal(
  read: (p: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<number | undefined> {
  try {
    return parsePressureSomeTotal(await read('/proc/pressure/cpu'));
  } catch {
    return undefined;
  }
}

export interface CommandMeasureInput {
  metricSource: OptimizeMetricSource;
  command: string;
  /** `file`のときのみ。worktreeからの相対パス。 */
  metricFile?: string;
  /** 木のworktree。 */
  cwdFor(tree: MeasureTree): string;
  /** 起動したプロセスの記録（任意）。 */
  onSpawn?: (pid: number, tree: MeasureTree) => void;
  readPressure?: () => Promise<number | undefined>;
  now?: () => number;
}

/** 指標のコマンドを実行する`measure`を作る。`wallTime`は経過時間（ms）、`file`はJSONの`value`。 */
export function createCommandMeasure(
  input: CommandMeasureInput,
): MeasureAlternatingInput['measure'] {
  const readPressure = input.readPressure ?? (() => readCpuPressureTotal());
  const now = input.now ?? Date.now;
  return async (tree, signal) => {
    const cwd = input.cwdFor(tree);
    const file =
      input.metricSource === 'file' && input.metricFile !== undefined
        ? path.resolve(cwd, input.metricFile)
        : undefined;
    if (input.metricSource === 'file') {
      if (file === undefined || path.relative(cwd, file).startsWith('..')) {
        return { ok: false, reason: 'metricFileがworktreeの外を指しています' };
      }
      // 前回の値を拾わないよう、実行前に消す
      await rm(file, { force: true });
    }
    const pressureBefore = await readPressure();
    const started = now();
    const result = await runVerifyCommand({
      command: input.command,
      cwd,
      signal,
      ...(input.onSpawn === undefined ? {} : { onSpawn: (pid) => input.onSpawn!(pid, tree) }),
    });
    const elapsed = now() - started;
    const pressureAfter = await readPressure();
    if (result.timedOut || result.aborted) {
      return { ok: false, reason: '時間の上限を超えて止めました' };
    }
    if (result.exitCode !== 0) {
      return { ok: false, reason: result.error ?? `exit code ${String(result.exitCode)}` };
    }
    let value = elapsed;
    if (file !== undefined) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { value?: unknown };
        if (typeof parsed.value !== 'number' || !Number.isFinite(parsed.value)) {
          return { ok: false, reason: '指標のJSONにvalueの数値がありません' };
        }
        value = parsed.value;
      } catch {
        return { ok: false, reason: '指標のJSONを読めませんでした' };
      }
    }
    const load =
      pressureBefore !== undefined && pressureAfter !== undefined && elapsed > 0
        ? ((pressureAfter - pressureBefore) / (elapsed * 1000)) * 100
        : undefined;
    return { ok: true, value, ...(load === undefined ? {} : { load }) };
  };
}
