import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerifyCommand } from '../../src/verification/commandRunner';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilDead = async (pid: number, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
};

describe.skipIf(process.platform === 'win32')('runVerifyCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'verify-cmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('シェル経由で実行し、exit codeと出力を返す', async () => {
    const result = await runVerifyCommand({ command: 'echo ok && pwd', cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ok');
    expect(result.output).toContain(dir);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('0以外のexit codeをそのまま返す', async () => {
    const result = await runVerifyCommand({ command: 'echo boom 1>&2; exit 3', cwd: dir });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });

  it('出力は上限バイト数の末尾だけを残す', async () => {
    const result = await runVerifyCommand({
      command: 'i=0; while [ $i -lt 2000 ]; do echo "line-$i"; i=$((i+1)); done',
      cwd: dir,
      maxOutputBytes: 100,
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(100);
    expect(result.output).toContain('line-1999');
    expect(result.output).not.toContain('line-0\n');
  });

  it('時間切れでは孫プロセスまで終了させ、exit codeを返さない', async () => {
    const pidFile = join(dir, 'pid');
    const result = await runVerifyCommand({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: dir,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeUndefined();
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntilDead(grandchild)).toBe(true);
  });

  it('SIGTERMを無視する子もSIGKILLで終了させる', async () => {
    const pidFile = join(dir, 'pid');
    const result = await runVerifyCommand({
      command: `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 30'`,
      cwd: dir,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    const child = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntilDead(child)).toBe(true);
  });

  it('中断されたらプロセスを終了させ、abortedを返す', async () => {
    const pidFile = join(dir, 'pid');
    const controller = new AbortController();
    const running = runVerifyCommand({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: dir,
      signal: controller.signal,
      killGraceMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeUndefined();
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntilDead(grandchild)).toBe(true);
  });

  it('正常終了後にバックグラウンドへ残した孫も片付ける', async () => {
    const pidFile = join(dir, 'pid');
    const result = await runVerifyCommand({
      command: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0`,
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    expect(await waitUntilDead(grandchild)).toBe(true);
  });

  it('開始前に中断済みなら起動しない', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runVerifyCommand({
      command: `touch ${join(dir, 'ran')}`,
      cwd: dir,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    await expect(readFile(join(dir, 'ran'))).rejects.toThrow();
  });
});
