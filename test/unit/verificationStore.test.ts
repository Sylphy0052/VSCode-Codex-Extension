import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationRecordInput } from '../../src/verification/record';
import { VerificationStore } from '../../src/verification/store';

const input = (overrides: Partial<VerificationRecordInput> = {}): VerificationRecordInput => ({
  before: { repoId: 'r', worktreeId: 'w', head: 'h', dirtyStateId: 'clean' },
  after: { repoId: 'r', worktreeId: 'w', head: 'h', dirtyStateId: 'clean' },
  command: 'npm test',
  cwd: '/w',
  exitCode: 0,
  startedAt: new Date('2026-09-23T00:00:00Z'),
  endedAt: new Date('2026-09-23T00:00:10Z'),
  actor: 'extension',
  acquisition: 'observed',
  output: 'passed',
  link: { runId: 'run-1', taskId: 't1', attempt: 1 },
  ...overrides,
});

describe('VerificationStore', () => {
  let baseDir: string;
  let clock: number;
  const now = () => new Date(clock);

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'verif-store-'));
    clock = Date.parse('2026-09-23T00:00:00Z');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('保存した記録を別のインスタンス（再読込後）から読み出せる', async () => {
    const saved = await new VerificationStore(baseDir, { now }).append(input());
    const reloaded = await new VerificationStore(baseDir, { now }).list();
    expect(reloaded).toEqual([saved]);
    expect(Object.isFrozen(reloaded[0])).toBe(true);
  });

  it('紐付けで絞り込める', async () => {
    const store = new VerificationStore(baseDir, { now });
    await store.append(input());
    clock += 1;
    await store.append(input({ link: { sessionId: 's1', iteration: 3 } }));
    expect((await store.list({ runId: 'run-1' })).map((r) => r.link.taskId)).toEqual(['t1']);
    expect((await store.list({ sessionId: 's1' }))[0]?.link.iteration).toBe(3);
  });

  it('件数の上限を超えると古い順に消える', async () => {
    const store = new VerificationStore(baseDir, { now, maxRecords: 3 });
    for (let i = 0; i < 5; i++) {
      clock += 1_000;
      await store.append(input({ command: `cmd-${i}` }));
    }
    expect((await store.list()).map((r) => r.command)).toEqual(['cmd-2', 'cmd-3', 'cmd-4']);
    expect(await readdir(join(baseDir, 'verification-records'))).toHaveLength(3);
  });

  it('期間の上限を過ぎた記録は読出から外れ、次の整理で消える', async () => {
    const store = new VerificationStore(baseDir, { now, maxAgeMs: 60_000 });
    await store.append(input({ command: 'old' }));
    clock += 30_000;
    await store.append(input({ command: 'new' }));
    clock += 40_000;
    expect((await store.list()).map((r) => r.command)).toEqual(['new']);
    await store.prune();
    expect(await readdir(join(baseDir, 'verification-records'))).toHaveLength(1);
  });

  it('保存先のファイルを書き換えて trusted に見せかけた記録は読み飛ばす', async () => {
    const errors: string[] = [];
    const store = new VerificationStore(baseDir, { now, onError: (m) => errors.push(m) });
    const saved = await store.append(
      input({ acquisition: 'agent-reported', actor: 'worker:claude' }),
    );
    expect(saved.trust).toBe('untrusted');
    const [name] = await readdir(join(baseDir, 'verification-records'));
    await writeFile(
      join(baseDir, 'verification-records', name!),
      JSON.stringify({ ...saved, trust: 'trusted' }),
    );
    expect(await store.list()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('保存後に信頼区分を書き換えるAPIを持たない', () => {
    const methods = Object.getOwnPropertyNames(VerificationStore.prototype).filter(
      (n) => n !== 'constructor',
    );
    expect(methods.sort()).toEqual(['append', 'list', 'prune', 'readRecord', 'recordFileNames']);
  });

  it('出力はマスクしてから保存する', async () => {
    const store = new VerificationStore(baseDir, { now });
    await store.append(
      input({ output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' }),
    );
    const [record] = await new VerificationStore(baseDir, { now }).list();
    expect(record?.outputRef.tail).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('保存先がまだ無ければ空を返す', async () => {
    expect(await new VerificationStore(join(baseDir, 'none'), { now }).list()).toEqual([]);
  });
});
