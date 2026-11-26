import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  killRecordedProcesses,
  parseStartTime,
  removeProcessRecord,
  writeProcessRecord,
  type ProcessRecordPorts,
} from '../../src/orchestrator/optimizeProcessRecord';
import { runVerifyCommand } from '../../src/verification/commandRunner';

// pid=1 comm="a) b" state=S の後ろに19個のフィールド、その次（22番目）がstarttime
const stat = (start: string): string =>
  `123 (a) b) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${start} 0 0`;

describe('optimizeProcessRecord', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opt-proc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('statの22番目を取る（プロセス名に括弧があっても）', () => {
    expect(parseStartTime(stat('777'))).toBe('777');
    expect(parseStartTime('garbage')).toBeUndefined();
    expect(parseStartTime('1 (x) S 1 2')).toBeUndefined();
  });

  function ports(starts: Record<number, string | undefined>) {
    const killed: [number, string | number][] = [];
    const p: ProcessRecordPorts = {
      readStat: (pid) => {
        const s = starts[pid];
        return Promise.resolve(s === undefined ? undefined : stat(s));
      },
      kill: (pid, sig) => {
        killed.push([pid, sig]);
      },
    };
    return { p, killed };
  }

  it('開始時刻が一致すればグループごと止め、記録を消す', async () => {
    const { p, killed } = ports({ 500: '42' });
    await writeProcessRecord(dir, { pid: 500, label: 'trial' }, p);
    const report = await killRecordedProcesses(dir, p);
    expect(killed).toEqual([[-500, 'SIGKILL']]);
    expect(report.killed).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('開始時刻が違う・既に居ないPIDは止めず記録だけ消す', async () => {
    const w = ports({ 500: '42', 501: '1' });
    await writeProcessRecord(dir, { pid: 500, label: 'a' }, w.p);
    await writeProcessRecord(dir, { pid: 501, label: 'b' }, w.p);
    const { p, killed } = ports({ 500: '43' }); // 500は使い回し、501は消滅
    const report = await killRecordedProcesses(dir, p);
    expect(killed).toEqual([]);
    expect(report.discarded).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it('開始時刻を記録できなかった記録は止めない。壊れた記録は消す', async () => {
    const w = ports({});
    await writeProcessRecord(dir, { pid: 600, label: 'x' }, w.p);
    await writeFile(join(dir, 'process-700.json'), '{broken');
    await writeFile(join(dir, 'process-1.json'), JSON.stringify({ pid: 1, pgid: 1 }));
    const { p, killed } = ports({ 600: '5', 1: '5' });
    const report = await killRecordedProcesses(dir, p);
    expect(killed).toEqual([]);
    expect(report.unreadable).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it('記録の置き場が無くても何もしない。removeは冪等', async () => {
    expect((await killRecordedProcesses(join(dir, 'none'))).killed).toEqual([]);
    await removeProcessRecord(dir, 9);
  });

  it('実プロセス: 記録したグループを孫ごと止め、開始時刻が違えば止めない', async () => {
    if (!existsSync('/proc/self/stat')) {
      return;
    }
    const orphan = spawn('sleep 60 & wait', { shell: true, detached: true, stdio: 'ignore' });
    const pid = orphan.pid!;
    await writeProcessRecord(dir, { pid, label: 'orphan' });
    // 開始時刻を書き換えた記録は止めない
    const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    await writeProcessRecord(dir, { pid: other.pid!, label: 'other' });
    await writeFile(
      join(dir, `process-${other.pid}.json`),
      JSON.stringify({ pid: other.pid, pgid: other.pid, startTime: '1', label: 'other' }),
    );
    const report = await killRecordedProcesses(dir);
    expect(report.killed.map((r) => r.pid)).toEqual([pid]);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
    process.kill(-other.pid!, 'SIGKILL');
  });

  it('runVerifyCommandのonSpawnでPIDを受け取れる', async () => {
    let seen: number | undefined;
    const r = await runVerifyCommand({ command: 'true', cwd: dir, onSpawn: (pid) => (seen = pid) });
    expect(r.exitCode).toBe(0);
    expect(seen).toBeGreaterThan(1);
    // onSpawnが例外でもコマンドは走る
    const r2 = await runVerifyCommand({
      command: 'true',
      cwd: dir,
      onSpawn: () => {
        throw new Error('x');
      },
    });
    expect(r2.exitCode).toBe(0);
  });
});
