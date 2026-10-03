import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeUsageProbe } from '../../src/claude/usageProbe';
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
    const lock = path.join(shared, 'claude-usage-probe.lock');
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
