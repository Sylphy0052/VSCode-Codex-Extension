import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCommandMeasure,
  createMeasureLock,
  decideAdoption,
  measureAlternating,
  median,
  medianAbsoluteDeviation,
  readCpuPressureTotal,
  signTestPValue,
  withMeasureLock,
  type MeasureTree,
  type RunOutcome,
} from '../../src/orchestrator/optimizeMeasure';

const base = { runs: 3, perRunTimeoutMs: 1000, totalTimeoutMs: 10_000 };

describe('measureAlternating', () => {
  it('A・B・A・Bの順に測る', async () => {
    const order: string[] = [];
    const result = await measureAlternating({
      ...base,
      measure: (tree) => {
        order.push(tree);
        return Promise.resolve({ ok: true, value: tree === 'A' ? 10 : 8 });
      },
    });
    expect(order).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
    expect(result.pairs).toHaveLength(3);
    expect(result.failed).toBe(false);
  });

  it('失敗した回はペアから外し、過半数でなければ計測は成功', async () => {
    let n = 0;
    const result = await measureAlternating({
      ...base,
      measure: () => {
        n += 1;
        return Promise.resolve<RunOutcome>(
          n === 1 ? { ok: false, reason: 'x' } : { ok: true, value: 1 },
        );
      },
    });
    expect(result.failures).toHaveLength(1);
    expect(result.pairs).toHaveLength(2);
    expect(result.failed).toBe(false);
  });

  it('過半数が失敗したら計測失敗', async () => {
    let n = 0;
    const result = await measureAlternating({
      ...base,
      measure: () => {
        n += 1;
        return Promise.resolve<RunOutcome>(
          n <= 4 ? { ok: false, reason: 'x' } : { ok: true, value: 1 },
        );
      },
    });
    expect(result.failures).toHaveLength(4);
    expect(result.failed).toBe(true);
    expect(result.failedReason).toContain('過半数');
  });

  it('ちょうど半数の失敗は過半数でない。ペアが無ければ失敗', async () => {
    const result = await measureAlternating({
      runs: 2,
      perRunTimeoutMs: 1000,
      totalTimeoutMs: 10_000,
      measure: (tree) =>
        Promise.resolve<RunOutcome>(
          tree === 'A' ? { ok: false, reason: 'x' } : { ok: true, value: 1 },
        ),
    });
    expect(result.failures).toHaveLength(2);
    expect(result.failed).toBe(true);
    expect(result.failedReason).toContain('ペア');
  });

  it('1回の時間の上限を超えたら中断して失敗に数える', async () => {
    const aborted: boolean[] = [];
    const result = await measureAlternating({
      runs: 1,
      perRunTimeoutMs: 20,
      totalTimeoutMs: 10_000,
      measure: (_tree, signal) =>
        new Promise<RunOutcome>(() => {
          signal.addEventListener('abort', () => aborted.push(true));
        }),
    });
    expect(aborted).toEqual([true, true]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.reason).toContain('時間の上限');
    expect(result.failed).toBe(true);
  });

  it('計測全体の上限を超えたら残りは失敗に数える', async () => {
    let t = 0;
    const result = await measureAlternating({
      runs: 3,
      perRunTimeoutMs: 1000,
      totalTimeoutMs: 100,
      now: () => t,
      measure: () => {
        t += 60;
        return Promise.resolve({ ok: true, value: 1 });
      },
    });
    // 2回測った時点（t=120）で上限超過
    expect(result.aValues.length + result.bValues.length).toBe(2);
    expect(result.failures).toHaveLength(4);
    expect(result.failures[0]?.reason).toContain('全体');
    expect(result.failed).toBe(true);
  });

  it('負荷が閾値を超えた回は捨てて測り直す', async () => {
    const loads = [90, 10, 10, 10];
    const calls: MeasureTree[] = [];
    const result = await measureAlternating({
      runs: 1,
      perRunTimeoutMs: 1000,
      totalTimeoutMs: 10_000,
      loadThreshold: 50,
      maxLoadRetries: 2,
      measure: (tree) => {
        calls.push(tree);
        return Promise.resolve({ ok: true, value: 5, load: loads.shift() ?? 0 });
      },
    });
    expect(calls).toEqual(['A', 'A', 'B']);
    expect(result.loadDiscards).toBe(1);
    expect(result.pairs).toEqual([{ a: 5, b: 5 }]);
  });

  it('測り直しの上限に達したら失敗として数える', async () => {
    const result = await measureAlternating({
      runs: 1,
      perRunTimeoutMs: 1000,
      totalTimeoutMs: 10_000,
      loadThreshold: 50,
      maxLoadRetries: 1,
      measure: () => Promise.resolve({ ok: true, value: 5, load: 99 }),
    });
    expect(result.loadDiscards).toBe(3);
    expect(result.failures).toHaveLength(2);
    expect(result.failed).toBe(true);
  });
});

describe('統計と採否', () => {
  it('中央値・MAD・符号検定', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
    expect(signTestPValue(5, 5)).toBeCloseTo(1 / 32);
    expect(signTestPValue(0, 0)).toBe(1);
    expect(signTestPValue(3, 4)).toBeCloseTo(5 / 16);
  });

  const pairs = [10, 11, 10, 12, 10, 11, 10].map((a) => ({ a, b: a - 2 }));

  it('最小の差と有意水準を満たせば採る', () => {
    const d = decideAdoption({
      pairs,
      direction: 'minimize',
      minImprovement: { kind: 'absolute', value: 1 },
      significanceLevel: 0.05,
    });
    expect(d.adopted).toBe(true);
    expect(d.medianImprovement).toBe(2);
    expect(d.raisedToSpread).toBe(false);
  });

  it('percentは基準値に対する割合で換算する', () => {
    const d = decideAdoption({
      pairs,
      direction: 'minimize',
      minImprovement: { kind: 'percent', value: 50 },
      significanceLevel: 0.05,
    });
    expect(d.configuredMinDelta).toBe(5);
    expect(d.adopted).toBe(false);
    expect(d.reason).toContain('最小の差');
  });

  it('maximizeでは増えた方を良いとする', () => {
    const d = decideAdoption({
      pairs: pairs.map((p) => ({ a: p.b, b: p.a })),
      direction: 'maximize',
      minImprovement: { kind: 'absolute', value: 1 },
      significanceLevel: 0.05,
    });
    expect(d.adopted).toBe(true);
  });

  it('有意でなければ採らない', () => {
    const d = decideAdoption({
      pairs: [
        { a: 10, b: 8 },
        { a: 10, b: 12 },
        { a: 10, b: 8 },
      ],
      direction: 'minimize',
      minImprovement: { kind: 'absolute', value: 0.5 },
      significanceLevel: 0.05,
    });
    expect(d.adopted).toBe(false);
    expect(d.reason).toContain('有意水準');
  });

  it('最小の差がばらつきより小さければばらつきまで引き上げる', () => {
    const d = decideAdoption({
      pairs: [
        { a: 10, b: 5 },
        { a: 10, b: 9 },
        { a: 10, b: 4 },
        { a: 10, b: 10 },
        { a: 10, b: 3 },
        { a: 10, b: 8 },
        { a: 10, b: 6 },
      ],
      direction: 'minimize',
      minImprovement: { kind: 'absolute', value: 0.1 },
      significanceLevel: 0.5,
    });
    expect(d.spread).toBeGreaterThan(0.1);
    expect(d.raisedToSpread).toBe(true);
    expect(d.effectiveMinDelta).toBe(d.spread);
  });

  it('ペアが無ければ採らない', () => {
    const d = decideAdoption({
      pairs: [],
      direction: 'minimize',
      minImprovement: { kind: 'absolute', value: 1 },
      significanceLevel: 0.05,
    });
    expect(d.adopted).toBe(false);
  });
});

describe('ロック', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opt-lock-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('同時に2本走らない', async () => {
    const lock = createMeasureLock(dir);
    let running = 0;
    let peak = 0;
    const job = (): Promise<void> =>
      withMeasureLock(
        lock,
        async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 30));
          running -= 1;
        },
        { pollMs: 5 },
      );
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(1);
  });

  it('取れなければ待ち上限で例外', async () => {
    const lock = createMeasureLock(dir);
    const slot = await lock.tryAcquire();
    await expect(
      withMeasureLock(createMeasureLock(dir), () => Promise.resolve(1), {
        pollMs: 5,
        waitTimeoutMs: 20,
      }),
    ).rejects.toThrow('ロック');
    await slot?.release();
  });

  it('失敗してもロックを返す', async () => {
    const lock = createMeasureLock(dir);
    await expect(
      withMeasureLock(lock, () => Promise.reject(new Error('boom')), { pollMs: 5 }),
    ).rejects.toThrow('boom');
    await expect(withMeasureLock(lock, () => Promise.resolve(7), { pollMs: 5 })).resolves.toBe(7);
  });
});

describe('createCommandMeasure', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opt-cmd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;

  it('wallTimeは経過時間を値にし、負荷をPSIの差から出す', async () => {
    let t = 0;
    const pressures = [1000, 1000 + 500_000];
    const measure = createCommandMeasure({
      metricSource: 'wallTime',
      command: 'true',
      cwdFor: () => dir,
      now: () => {
        t += 1000;
        return t;
      },
      readPressure: () => Promise.resolve(pressures.shift()),
    });
    const r = await measure('A', signal);
    expect(r).toMatchObject({ ok: true, value: 1000 });
    // 1000msの間に500000us待ち = 50%
    expect((r as { load: number }).load).toBeCloseTo(50);
  });

  it('fileは実行前に消し、JSONのvalueを取る', async () => {
    await writeFile(join(dir, 'm.json'), '{"value": 999}');
    const measure = createCommandMeasure({
      metricSource: 'file',
      command: `echo '{"value": 3}' > m.json`,
      metricFile: 'm.json',
      cwdFor: () => dir,
      readPressure: () => Promise.resolve(undefined),
    });
    expect(await measure('A', signal)).toEqual({ ok: true, value: 3 });
  });

  it('fileが書かれない・コマンド失敗・worktree外は失敗', async () => {
    const mk = (command: string, metricFile = 'm.json') =>
      createCommandMeasure({
        metricSource: 'file',
        command,
        metricFile,
        cwdFor: () => dir,
        readPressure: () => Promise.resolve(undefined),
      });
    expect((await mk('true')('A', signal)).ok).toBe(false);
    expect((await mk('exit 3')('A', signal)).ok).toBe(false);
    expect((await mk('true', '../x.json')('A', signal)).ok).toBe(false);
    expect((await mk(`echo '{"value":"x"}' > m.json`)('A', signal)).ok).toBe(false);
  });

  it('中断されたら失敗', async () => {
    const c = new AbortController();
    const measure = createCommandMeasure({
      metricSource: 'wallTime',
      command: 'sleep 5',
      cwdFor: () => dir,
      readPressure: () => Promise.resolve(undefined),
    });
    const p = measure('A', c.signal);
    setTimeout(() => c.abort(), 50);
    expect((await p).ok).toBe(false);
  });

  it('PSIを読めなければundefined', async () => {
    expect(await readCpuPressureTotal(() => Promise.reject(new Error('x')))).toBeUndefined();
    expect(
      await readCpuPressureTotal(() =>
        Promise.resolve('some avg10=0.00 avg60=0.00 avg300=0.00 total=42\n'),
      ),
    ).toBe(42);
  });
});
