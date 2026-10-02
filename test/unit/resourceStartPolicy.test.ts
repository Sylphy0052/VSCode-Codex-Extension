import { describe, expect, it, vi } from 'vitest';
import { LOW_PRIORITY_NICE, lowPrioritySpawn } from '../../src/claude/lowPrioritySpawn';
import type { ClaudeSpawnPort } from '../../src/claude/streamSession';
import type { TaskRunResourceThresholds } from '../../src/config';
import {
  cpuThresholds,
  decideStartPolicy,
  nextCpuLevel,
} from '../../src/orchestrator/resourceMonitor';

const THRESHOLDS: TaskRunResourceThresholds = {
  cpuPressureWarningPercent: 20,
  cpuPressureCriticalPercent: 40,
  cpuUsageWarningPercent: 85,
  cpuUsageCriticalPercent: 95,
  memoryWarningAvailableRatio: 0.15,
  memoryCriticalAvailableRatio: 0.08,
};

describe('decideStartPolicy', () => {
  it('メモリcriticalはCPUに関わらずhold', () => {
    expect(decideStartPolicy('ok', 'critical')).toBe('hold');
    expect(decideStartPolicy('critical', 'critical')).toBe('hold');
  });

  it('CPU criticalは例外の1本だけ', () => {
    expect(decideStartPolicy('critical', 'ok')).toBe('liveness');
    expect(decideStartPolicy('critical', 'warning')).toBe('liveness');
  });

  it('メモリwarningは並列1、CPU warningだけなら制限しない', () => {
    expect(decideStartPolicy('ok', 'warning')).toBe('limit_to_1');
    expect(decideStartPolicy('warning', 'warning')).toBe('limit_to_1');
    expect(decideStartPolicy('warning', 'ok')).toBe('unrestricted');
  });
});

describe('cpuThresholds', () => {
  it('PSIの戻しは25%と10%', () => {
    expect(cpuThresholds('psi', THRESHOLDS)).toEqual({
      warning: 20,
      critical: 40,
      warningRelease: 10,
      criticalRelease: 25,
    });
  });

  it('使用率の戻しは各閾値の10ポイント下', () => {
    expect(cpuThresholds('usage', THRESHOLDS)).toEqual({
      warning: 85,
      critical: 95,
      warningRelease: 75,
      criticalRelease: 85,
    });
  });
});

describe('nextCpuLevel', () => {
  const th = cpuThresholds('psi', THRESHOLDS);

  it('閾値ちょうどで上げる', () => {
    expect(nextCpuLevel('ok', 20, th, 0).level).toBe('warning');
    expect(nextCpuLevel('ok', 40, th, 0).level).toBe('critical');
  });

  it('critical→warningは25%未満が2回続いたとき', () => {
    const first = nextCpuLevel('critical', 24, th, 0);
    expect(first).toEqual({ level: 'critical', releaseStreak: 1 });
    expect(nextCpuLevel('critical', 24, th, first.releaseStreak)).toEqual({
      level: 'warning',
      releaseStreak: 0,
    });
  });

  it('戻しの閾値以上の値が挟まると数え直す', () => {
    const first = nextCpuLevel('critical', 24, th, 0);
    const reset = nextCpuLevel('critical', 30, th, first.releaseStreak);
    expect(reset).toEqual({ level: 'critical', releaseStreak: 0 });
    expect(nextCpuLevel('critical', 24, th, reset.releaseStreak).level).toBe('critical');
  });

  it('warning→okは10%未満が2回続いたとき', () => {
    expect(nextCpuLevel('warning', 15, th, 0)).toEqual({ level: 'warning', releaseStreak: 0 });
    const first = nextCpuLevel('warning', 9, th, 0);
    expect(first.level).toBe('warning');
    expect(nextCpuLevel('warning', 9, th, first.releaseStreak).level).toBe('ok');
  });

  it('値が取れない計測は状態を変えない', () => {
    expect(nextCpuLevel('critical', undefined, th, 1)).toEqual({
      level: 'critical',
      releaseStreak: 1,
    });
  });
});

describe('lowPrioritySpawn', () => {
  const options = {
    cwd: '/w',
    env: { PATH: '/usr/bin' },
  } as unknown as Parameters<ClaudeSpawnPort>[2];

  it('niceがあればnice -n 10で包む', () => {
    const base = vi.fn<ClaudeSpawnPort>(() => ({}) as ReturnType<ClaudeSpawnPort>);
    const spawn = lowPrioritySpawn(() => undefined, base, {
      platform: 'linux',
      findNice: () => '/usr/bin/nice',
      setPriority: vi.fn(),
    });
    spawn('claude', ['-p'], options);
    expect(base).toHaveBeenCalledWith(
      '/usr/bin/nice',
      ['-n', String(LOW_PRIORITY_NICE), 'claude', '-p'],
      options,
    );
  });

  it('niceが無ければ通常の優先度で起動してログに残す', () => {
    const base = vi.fn<ClaudeSpawnPort>(() => ({}) as ReturnType<ClaudeSpawnPort>);
    const log = vi.fn();
    const spawn = lowPrioritySpawn(log, base, {
      platform: 'linux',
      findNice: () => undefined,
      setPriority: vi.fn(),
    });
    spawn('claude', ['-p'], options);
    expect(base).toHaveBeenCalledWith('claude', ['-p'], options);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('Windowsで優先度を下げられなくても起動は続ける', () => {
    const child = { pid: 42 } as ReturnType<ClaudeSpawnPort>;
    const base = vi.fn<ClaudeSpawnPort>(() => child);
    const log = vi.fn();
    const spawn = lowPrioritySpawn(log, base, {
      platform: 'win32',
      findNice: () => undefined,
      setPriority: () => {
        throw new Error('EACCES');
      },
    });
    expect(spawn('claude', ['-p'], options)).toBe(child);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
