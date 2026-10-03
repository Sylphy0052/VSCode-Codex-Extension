import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/log';

/**
 * 期限切れロックの`stat`が全員分そろうまで待たせる。全員が「期限切れ」を見てから奪い合わせるため。
 * さらに2者目以降の`unlink`は、先の者が新しいロックを作り終えるまで待たせる。
 * 「消して作り直す」が非原子的だと、後の者が先の者の新しいロックを消す順序になる。
 */
const barrier = vi.hoisted(() => ({
  expected: 0,
  waiting: [] as Array<() => void>,
  unlinks: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (barrier.unlinks > 0 && String(args[0]).endsWith('claude-usage-probe.lock')) {
        for (let i = 0; i < 100; i += 1) {
          try {
            await actual.stat(args[0]);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
      barrier.unlinks += 1;
      return actual.unlink(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      if (barrier.expected > 0 && String(args[0]).endsWith('claude-usage-probe.lock')) {
        await new Promise<void>((resolve) => {
          barrier.waiting.push(resolve);
          if (barrier.waiting.length >= barrier.expected) {
            const release = barrier.waiting.splice(0);
            barrier.expected = 0;
            release.forEach((fn) => fn());
          }
        });
      }
      return result;
    },
  };
});

import { ClaudeUsageProbe } from '../../src/claude/usageProbe';

const log = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

interface Claimable {
  claim(now: number): Promise<boolean>;
}

describe('ClaudeUsageProbe 期限切れロックの奪取', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'usage-probe-race-'));
  });
  afterEach(() => {
    barrier.expected = 0;
    barrier.waiting = [];
    barrier.unlinks = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('期限切れのロックを複数が同時に奪おうとしても、取得権を得るのは1者だけ', async () => {
    for (let round = 0; round < 5; round += 1) {
      const shared = path.join(dir, `shared-${round}`);
      mkdirSync(shared, { recursive: true });
      const lock = path.join(shared, 'claude-usage-probe.lock');
      writeFileSync(lock, '1');
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(lock, old, old);
      const count = 4;
      barrier.expected = count;
      barrier.unlinks = 0;
      const probes = Array.from(
        { length: count },
        () => new ClaudeUsageProbe(() => 'claude', log, shared),
      );
      // claim()はprivate。取得権の奪い合いだけを直接確かめる
      const results = await Promise.all(
        probes.map((probe) => (probe as unknown as Claimable).claim(Date.now())),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      // 奪取印は直近のものを残す（遅れて同じ世代を見た者を弾くため）
      expect(readdirSync(shared).filter((n) => n.includes('.takeover-'))).toHaveLength(1);
    }
  });
});
