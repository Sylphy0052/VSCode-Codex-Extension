import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  maxWaitMs: 500,
  /** 設定すると、次の`readdir`1回だけ実際の中身の代わりにこれを返す。古い一覧で止まった者の再現用。 */
  fakeListing: undefined as string[] | undefined,
  /** 設定すると、この回数目（1始まり）の`readdir`を失敗させる。 */
  failListingAt: undefined as number | undefined,
  listingCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      barrier.listingCalls += 1;
      if (barrier.listingCalls === barrier.failListingAt) {
        throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
      }
      const fake = barrier.fakeListing;
      barrier.fakeListing = undefined;
      return fake ?? actual.readdir(...args);
    },
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
    barrier.fakeListing = undefined;
    barrier.failListingAt = undefined;
    barrier.listingCalls = 0;
    warnings.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
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
    // 落ちた者が作ったファイルには触れず、時計だけ期限の先へ進める
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 });
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(lockFiles()).toEqual([`${LOCK}.2`]);
  });

  it('mtimeが期限の幅を超えて未来にあるロックは、時計のずれた書き手の残骸として奪う', async () => {
    writeLock(1, -45_000);
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(lockFiles()).toEqual([`${LOCK}.2`]);
  });

  it('mtimeの未来へのずれが期限の幅に収まるロックは、保持中として取得しない', async () => {
    writeLock(1, -35_000);
    expect(await newProbe().claim(Date.now())).toBe(false);
    expect(lockFiles()).toEqual([`${LOCK}.1`]);
  });

  it('作った後の一覧取得が失敗しても取得へ進み、解放で期限切れにして次へ渡す', async () => {
    // 1回目は最新の世代を見る一覧、2回目が作った後の一覧
    barrier.failListingAt = 2;
    const probe = newProbe();
    expect(await probe.claim(Date.now())).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(lockFiles()).toEqual([`${LOCK}.1`]);
    // 解放するまでは他のウィンドウを止める
    expect(await newProbe().claim(Date.now())).toBe(false);
    await probe.release();
    expect(statSync(path.join(shared, `${LOCK}.1`)).mtimeMs).toBe(0);
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(lockFiles()).toEqual([`${LOCK}.2`]);
  });

  it('期限切れのロックが残る中で2つのウィンドウがread()しても、claudeの起動は1回だけ', async () => {
    const counter = path.join(dir, 'count');
    const claude = path.join(dir, 'claude.sh');
    writeFileSync(
      claude,
      `#!/bin/sh\necho x >> "${counter}"\nprintf '%s' 'Current session: 16% used · resets Aug 10, 8:09pm (Asia/Tokyo)\n'\n`,
    );
    chmodSync(claude, 0o755);
    writeLock(3, 10 * 60_000);
    // 両者が期限切れを見てから次の世代を奪い合う
    barrier.expected = 2;
    const windows = [0, 1].map(() => new ClaudeUsageProbe(() => claude, log, shared));
    const now = Date.now();
    await Promise.all(windows.map((probe) => probe.read(now)));
    // 待ち合わせが成立し、両者が期限切れを見てから奪い合ったこと
    expect(barrier.expected).toBe(0);
    expect(readFileSync(counter, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
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

  it('古い一覧で止まっていた者が掃除済みの小さい番号を作っても、並び立たず退く', async () => {
    writeLock(3, 10 * 60_000);
    writeLock(5, 1_000);
    // 3が最新で期限切れ、と古い一覧で見たウィンドウ。4は掃除で消えた後の空き番号
    barrier.fakeListing = [`${LOCK}.3`];
    expect(await newProbe().claim(Date.now())).toBe(false);
    expect(statSync(path.join(shared, `${LOCK}.4`)).mtimeMs).toBe(0);
    expect(statSync(path.join(shared, `${LOCK}.5`)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    // 5は新しいロックなので、その後も取得できない
    expect(await newProbe().claim(Date.now())).toBe(false);
  });

  it('最新の世代が掃除で消えていれば取得せず、warnもしない', async () => {
    barrier.fakeListing = [`${LOCK}.9`];
    expect(await newProbe().claim(Date.now())).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(lockFiles()).toEqual([]);
  });

  it('先頭ゼロや桁あふれの名前が混ざっていても取得できる', async () => {
    writeLock(1, 10 * 60_000);
    const junk = [`${LOCK}.007`, `${LOCK}.99999999999999999999999`, `${LOCK}.0`];
    for (const name of junk) {
      writeFileSync(path.join(shared, name), '');
    }
    expect(await newProbe().claim(Date.now())).toBe(true);
    expect(readdirSync(shared).sort()).toEqual([...junk, `${LOCK}.2`].sort());
  });
});
