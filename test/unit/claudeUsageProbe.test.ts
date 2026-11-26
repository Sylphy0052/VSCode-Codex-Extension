import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeUsageProbe, type ProbedSlots } from '../../src/claude/usageProbe';
import type { Logger } from '../../src/log';

const log = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const REPORT = 'Current session: 16% used · resets Aug 10, 8:09pm (Asia/Tokyo)\n';

describe('ClaudeUsageProbe', () => {
  let dir: string;
  let counterFile: string;

  /** 起動のたびに回数を記録し、指定の出力を返す偽の`claude`を作る。 */
  const fakeClaude = (output: string): string => {
    const script = path.join(dir, 'claude.sh');
    writeFileSync(script, `#!/bin/sh\necho x >> "${counterFile}"\nprintf '%s' '${output}'\n`);
    chmodSync(script, 0o755);
    return script;
  };
  const launches = (): number => {
    try {
      return readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'usage-probe-'));
    counterFile = path.join(dir, 'count');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('2ウィンドウが同時に読んでも起動は1回だけ', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const a = new ClaudeUsageProbe(() => claude, log, shared);
    const b = new ClaudeUsageProbe(() => claude, log, shared);
    const now = 10_000_000;
    await Promise.all([a.read(now), b.read(now)]);
    expect(launches()).toBe(1);
  });

  it('成功した結果は間隔内なら再取得せず共有する', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const a = new ClaudeUsageProbe(() => claude, log, shared);
    const b = new ClaudeUsageProbe(() => claude, log, shared);
    const now = 10_000_000;
    const first = await a.read(now);
    expect(first?.usedPercent).toBe(16);
    const second = await b.read(now + 60_000);
    expect(second?.usedPercent).toBe(16);
    expect(launches()).toBe(1);
  });

  it('5時間枠と週次を読めたら受け取り先へ渡し、他のウィンドウにも共有する（Issue #2174）', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(
      REPORT + 'Current week (all models): 23% used · resets Oct 16, 7am (Asia/Tokyo)\n',
    );
    const gotA: (ProbedSlots | undefined)[] = [];
    const gotB: (ProbedSlots | undefined)[] = [];
    const a = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotA.push(p),
    );
    const b = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotB.push(p),
    );
    const now = 10_000_000;
    await a.read(now);
    expect(gotA).toHaveLength(1);
    expect(gotA[0]?.readAt).toBe(now);
    expect(gotA[0]?.slots.fiveHour?.pct).toBe(16);
    expect(gotA[0]?.slots.weekly?.pct).toBe(23);
    expect(gotA[0]?.slots.fiveHour?.resetsAt).toEqual(expect.any(Number));
    // 起動せずに共有の結果を使ったウィンドウにも、読んだ時刻のまま渡す
    await b.read(now + 60_000);
    expect(launches()).toBe(1);
    expect(gotB).toEqual(gotA);
  });

  it('強制取得に失敗したら前回の5時間枠と週次を共有に残さない（Issue #2174）', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const gotA: (ProbedSlots | undefined)[] = [];
    const a = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotA.push(p),
    );
    const gotB: (ProbedSlots | undefined)[] = [];
    const b = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotB.push(p),
    );
    const now = 10_000_000;
    await a.read(now);
    expect(gotA).toHaveLength(1);
    // アカウントを切り替えた後の強制取得が、使用率を読めずに終わる
    fakeClaude('nothing useful\n');
    await a.readFresh(() => now + 1000);
    expect(launches()).toBe(2);
    // 取り直しを求めた時点で、持っている値を捨てさせる
    expect(gotA).toHaveLength(2);
    expect(gotA[1]).toBeUndefined();
    // 共有の結果を使うウィンドウには、切り替え前のアカウントの値を渡さず、捨てさせる
    await b.read(now + 2000);
    expect(launches()).toBe(2);
    expect(gotB).toEqual([undefined]);
  });

  it('他のウィンドウの切り替え後に自分の取得も失敗したら、手元の切り替え前の値を捨てる（Issue #2174）', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const a = new ClaudeUsageProbe(() => claude, log, shared);
    const gotB: (ProbedSlots | undefined)[] = [];
    const b = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotB.push(p),
    );
    const now = 10_000_000;
    await a.read(now);
    // Bは共有の結果を使い、切り替え前のアカウントの値を持つ
    await b.read(now + 1000);
    expect(gotB.map((p) => p?.slots.fiveHour?.pct)).toEqual([16]);
    // Aがアカウントを切り替え、強制取得が読めずに終わる
    fakeClaude('nothing useful\n');
    await a.readFresh(() => now + 2000);
    // Bは共有の結果が古くなってから自分で取得し、読めずに終わる
    await b.read(now + 24 * 3_600_000);
    expect(launches()).toBe(3);
    expect(gotB).toHaveLength(2);
    expect(gotB[1]).toBeUndefined();
  });

  it('通常の取得に失敗したときは前回の5時間枠と週次を共有に残す（Issue #2174）', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const a = new ClaudeUsageProbe(() => claude, log, shared);
    const gotB: (ProbedSlots | undefined)[] = [];
    const b = new ClaudeUsageProbe(
      () => claude,
      log,
      shared,
      undefined,
      (p) => gotB.push(p),
    );
    const now = 10_000_000;
    await a.read(now);
    fakeClaude('nothing useful\n');
    // 間隔を空けて取り直し、読めずに終わる
    await a.read(now + 24 * 3_600_000);
    expect(launches()).toBe(2);
    await b.read(now + 24 * 3_600_000 + 1000);
    expect(launches()).toBe(2);
    expect(gotB.map((p) => [p?.readAt, p?.slots.fiveHour?.pct])).toEqual([[now, 16]]);
  });

  it('5時間枠も週次も読めなければ受け取り先を呼ばない（Issue #2174）', async () => {
    const claude = fakeClaude('nothing useful\n');
    const got: (ProbedSlots | undefined)[] = [];
    const probe = new ClaudeUsageProbe(
      () => claude,
      log,
      undefined,
      undefined,
      (p) => got.push(p),
    );
    await probe.read(10_000_000);
    expect(got).toEqual([]);
  });

  it('取得に失敗したら5分を待たず60秒後に取り直す', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude('');
    const probe = new ClaudeUsageProbe(() => claude, log, shared);
    const now = 10_000_000;
    expect(await probe.read(now)).toBeUndefined();
    expect(launches()).toBe(1);
    await probe.read(now + 30_000);
    expect(launches()).toBe(1);
    await probe.read(now + 61_000);
    expect(launches()).toBe(2);
  });

  it('保持したまま落ちた排他ファイルは期限後に奪う', async () => {
    const shared = path.join(dir, 'shared');
    const claude = fakeClaude(REPORT);
    const lock = path.join(shared, 'claude-usage-probe.lock.1');
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(shared, { recursive: true });
    writeFileSync(lock, '1');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const probe = new ClaudeUsageProbe(() => claude, log, shared);
    const usage = await probe.read(Date.now());
    expect(usage?.usedPercent).toBe(16);
  });
});
