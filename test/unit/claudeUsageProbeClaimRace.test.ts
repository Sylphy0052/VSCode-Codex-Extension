import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';

/**
 * 世代付きロックの`stat`が全員分そろうまで待たせる。全員が「期限切れ」を見てから奪い合わせるため。
 * そろわなくても止まらないよう、待つのは上限時間までにする。
 */
const barrier = vi.hoisted(() => ({
  expected: 0,
  waiting: [] as Array<() => void>,
  maxWaitMs: 2000,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (barrier.expected > 0 && /claude-usage-probe\.lock\.\d+$/.test(String(args[0]))) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, barrier.maxWaitMs);
          barrier.waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (barrier.waiting.length >= barrier.expected) {
            barrier.expected = 0;
            barrier.waiting.splice(0).forEach((fn) => fn());
          }
        });
      }
      return result;
    },
  };
});

import { ClaudeUsageProbe } from '../../src/claude/usageProbe';

interface Claimable {
  claim(now: number): Promise<boolean>;
  release(): Promise<void>;
}

const warnings: string[] = [];
const log = {
  warn: (message: string) => warnings.push(message),
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const LOCK = 'claude-usage-probe.lock';

describe('ClaudeUsageProbe 期限切れロックの奪取', () => {
  let dir: string;
  let shared: string;

  /** claim()はprivate。取得権の奪い合いだけを直接確かめる。 */
  const newProbe = (sharedDir: string = shared): Claimable =>
    new ClaudeUsageProbe(() => 'claude', log, sharedDir) as unknown as Claimable;
  const lockFiles = (): string[] => readdirSync(shared).filter((n) => n.startsWith(`${LOCK}.`));
  const writeLock = (generation: number, ageMs: number): void => {
    const file = path.join(shared, `${LOCK}.${generation}`);
    writeFileSync(file, '1');
    const time = new Date(Date.now() - ageMs);
    utimesSync(file, time, time);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'usage-probe-race-'));
    shared = path.join(dir, 'shared');
    mkdirSync(shared, { recursive: true });
    barrier.expected = 0;
    barrier.waiting = [];
    warnings.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('期限切れのロックを複数が同時に奪おうとしても、取得権を得るのは1者だけ', async () => {
    for (let round = 0; round < 5; round += 1) {
      for (const name of lockFiles()) {
        rmSync(path.join(shared, name));
      }
      writeLock(3, 10 * 60_000);
      const count = 4;
      barrier.expected = count;
      const results = await Promise.all(
        Array.from({ length: count }, () => newProbe().claim(Date.now())),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(lockFiles()).toEqual([`${LOCK}.4`]);
    }
  });

  it('持ち主が落ちて期限切れのまま残った世代から、次の世代を取れる', async () => {
    const crashed = newProbe();
    expect(await crashed.claim(Date.now())).toBe(true);
    // 解放せずに落ちた。ロックは期限切れになるまで他を止める
    expect(await newProbe().claim(Date.now())).toBe(false);
    writeLock(1, 10 * 60_000);
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(lockFiles()).toEqual([`${LOCK}.2`]);
  });

  it('新しいロックがあれば取得せず、ファイルも変えない', async () => {
    writeLock(5, 1_000);
    expect(await newProbe().claim(Date.now())).toBe(false);
    expect(lockFiles()).toEqual([`${LOCK}.5`]);
  });

  it('取得すると自分より古い世代を片付け、無関係なファイルは残す', async () => {
    writeLock(1, 20 * 60_000);
    writeLock(2, 15 * 60_000);
    writeLock(5, 10 * 60_000);
    writeFileSync(path.join(shared, `${LOCK}.x`), '');
    writeFileSync(path.join(shared, 'claude-usage-probe.json'), '{}');
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(readdirSync(shared).sort()).toEqual([
      'claude-usage-probe.json',
      `${LOCK}.6`,
      `${LOCK}.x`,
    ]);
  });

  it('解放しても世代のファイルは残り、番号は戻らず次がすぐ取れる', async () => {
    const first = newProbe();
    expect(await first.claim(Date.now())).toBe(true);
    await first.release();
    expect(lockFiles()).toEqual([`${LOCK}.1`]);
    expect(statSync(path.join(shared, `${LOCK}.1`)).mtimeMs).toBe(0);
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(lockFiles()).toEqual([`${LOCK}.2`]);
  });

  it('共有先に作れない場合はwarnして自分で取得する', async () => {
    const file = path.join(dir, 'file');
    writeFileSync(file, '');
    expect(await newProbe(path.join(file, 'sub')).claim(Date.now())).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(existsSync(path.join(file, 'sub'))).toBe(false);
  });
});
