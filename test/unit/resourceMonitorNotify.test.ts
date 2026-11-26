import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRunResourceThresholds } from '../../src/config';
import {
  describeResourceChange,
  formatResourceLines,
  RESOURCE_RELEASE_NOTIFY_DELAY_MS,
  ResourceMonitor,
  type ResourceSnapshot,
} from '../../src/orchestrator/resourceMonitor';

const THRESHOLDS: TaskRunResourceThresholds = {
  cpuPressureWarningPercent: 20,
  cpuPressureCriticalPercent: 40,
  cpuUsageWarningPercent: 80,
  cpuUsageCriticalPercent: 95,
  memoryWarningAvailableRatio: 0.2,
  memoryCriticalAvailableRatio: 0.1,
};

const INTERVAL_MS = 1000;
const OK = 0.5;
const WARNING = 0.15;
const CRITICAL = 0.05;

describe('ResourceMonitor: Orchestratorへ知らせる変化（Issue #1981）', () => {
  let ratio = OK;
  let active = true;
  let notified: string[];
  let monitor: ResourceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    ratio = OK;
    active = true;
    notified = [];
    monitor = new ResourceMonitor({
      sampler: {
        sampleHost: () =>
          Promise.resolve({
            cpu: { method: 'usage', percent: 0 },
            cpuUsagePercent: 0,
            loadPerCore: 0,
            cpuCores: 4,
            memoryAvailableRatio: ratio,
            memoryAvailableBytes: undefined,
            memoryTotalBytes: undefined,
            memoryFromCgroup: false,
          }),
        sampleProcessTrees: () => Promise.resolve(new Map()),
      },
      hasActiveRuns: () => active,
      listStageProcesses: () => [],
      thresholds: () => THRESHOLDS,
      intervalMs: () => INTERVAL_MS,
      onLevelChanged: () => undefined,
      onNotify: (prev, snapshot) => {
        notified.push(`${prev?.memoryLevel ?? 'ok'}->${snapshot.memoryLevel}`);
      },
      log: () => undefined,
    });
  });

  afterEach(() => {
    monitor.dispose();
    vi.useRealTimers();
  });

  async function start(): Promise<void> {
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
  }

  async function sample(next: number): Promise<void> {
    ratio = next;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  }

  it('上がったときはすぐ知らせる', async () => {
    await start();
    await sample(WARNING);
    expect(notified).toEqual(['ok->warning']);
    await sample(CRITICAL);
    expect(notified).toEqual(['ok->warning', 'warning->critical']);
  });

  it('下がったときは、下がった状態が60秒続いてから1回だけ知らせる', async () => {
    await start();
    await sample(WARNING);
    await sample(OK);
    expect(notified).toEqual(['ok->warning']);
    await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_NOTIFY_DELAY_MS - INTERVAL_MS * 2);
    expect(notified).toEqual(['ok->warning']);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(notified).toEqual(['ok->warning', 'warning->ok']);
    await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_NOTIFY_DELAY_MS * 2);
    expect(notified).toEqual(['ok->warning', 'warning->ok']);
  });

  it('60秒以内に上下を繰り返しても、上がった1回分しか届かない', async () => {
    await start();
    for (let i = 0; i < 5; i += 1) {
      await sample(WARNING);
      await sample(OK);
    }
    await sample(WARNING);
    await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_NOTIFY_DELAY_MS * 2);
    expect(notified).toEqual(['ok->warning']);
  });

  it('下がるのを待つ間にさらに上がったら、上がった分だけすぐ知らせる', async () => {
    await start();
    await sample(WARNING);
    await sample(OK);
    await sample(CRITICAL);
    expect(notified).toEqual(['ok->warning', 'warning->critical']);
  });

  it('計測を止めたら、知らせた状態を忘れて待っていた知らせも捨てる', async () => {
    await start();
    await sample(WARNING);
    await sample(OK);
    active = false;
    monitor.refresh();
    await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_NOTIFY_DELAY_MS * 2);
    expect(notified).toEqual(['ok->warning']);
    // 計測を始め直すと、前に知らせたwarningは引き継がない
    active = true;
    ratio = WARNING;
    await start();
    expect(notified).toEqual(['ok->warning', 'ok->warning']);
  });
});

function snapshotOf(overrides: Partial<ResourceSnapshot>): ResourceSnapshot {
  return {
    host: {
      cpu: { method: 'psi', percent: 5 },
      cpuUsagePercent: 10,
      loadPerCore: 0.5,
      cpuCores: 4,
      memoryAvailableRatio: 0.15,
      memoryAvailableBytes: 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      memoryFromCgroup: false,
    },
    stages: [],
    sampledAt: new Date('2026-10-18T00:00:00Z'),
    level: 'warning',
    cpuLevel: 'ok',
    memoryLevel: 'warning',
    cpu: { method: 'psi', percent: 5, warningPercent: 20, criticalPercent: 40 },
    memory: { availableRatio: 0.15, warningRatio: 0.2, criticalRatio: 0.1 },
    startPolicy: 'limit_to_1',
    observedFreedBytesPerStage: undefined,
    ...overrides,
  };
}

describe('describeResourceChange（Issue #1981）', () => {
  it('変化・新規開始の扱い・pauseの効果だけを書き、診断値と締めの定型文を含めない', () => {
    const body = describeResourceChange(undefined, snapshotOf({}), 'run-1');
    expect(body).toContain('CPU ok→ok / メモリ ok→warning');
    expect(body).toContain('新規開始: 並列1');
    expect(body).toContain('run_pause_effective');
    expect(body).not.toContain('診断値');
    expect(body).not.toContain('動いている工程は止めない');
    expect(body).not.toContain('get_run_state');
  });

  it('get_run_stateの見出しには診断値を残す', () => {
    expect(formatResourceLines(snapshotOf({}), 'run-1').join('\n')).toContain('診断値');
  });
});
