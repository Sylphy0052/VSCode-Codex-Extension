import { describe, expect, it } from 'vitest';
import {
  buildVerificationRecord,
  maskOutputTail,
  OUTPUT_TAIL_MAX_CHARS,
  parseVerificationRecord,
  trustForAcquisition,
  type VerificationRecordInput,
} from '../../src/verification/record';
import type { SourceIdentity } from '../../src/verification/sourceIdentity';

const identity: SourceIdentity = {
  repoId: 'r1',
  worktreeId: 'w1',
  head: 'abc',
  dirtyStateId: 'clean',
};

const baseInput = (overrides: Partial<VerificationRecordInput> = {}): VerificationRecordInput => ({
  before: identity,
  after: identity,
  command: 'npm test',
  cwd: '/w/repo',
  exitCode: 0,
  startedAt: new Date('2026-09-23T00:00:00Z'),
  endedAt: new Date('2026-09-23T00:01:00Z'),
  actor: 'extension',
  acquisition: 'observed',
  output: 'ok',
  link: { runId: 'run-1', taskId: 't1', attempt: 2 },
  ...overrides,
});

describe('trustForAcquisition', () => {
  it('observed だけが trusted になる', () => {
    expect(trustForAcquisition('observed')).toBe('trusted');
    expect(trustForAcquisition('agent-reported')).toBe('untrusted');
    expect(trustForAcquisition('imported')).toBe('untrusted');
  });
});

describe('buildVerificationRecord', () => {
  it('項目を揃えて組み立て、信頼区分と結果を取得方法とexit codeから決める', () => {
    const record = buildVerificationRecord(baseInput(), {
      now: new Date('2026-09-23T00:02:00Z'),
      newId: () => 'id-1',
    });
    expect(record).toEqual({
      id: 'id-1',
      schemaVersion: 1,
      subject: { ...identity, sourceChanged: false },
      command: 'npm test',
      cwd: '/w/repo',
      exitCode: 0,
      outcome: 'pass',
      startedAt: '2026-09-23T00:00:00.000Z',
      endedAt: '2026-09-23T00:01:00.000Z',
      recordedAt: '2026-09-23T00:02:00.000Z',
      actor: 'extension',
      acquisition: 'observed',
      trust: 'trusted',
      outputRef: { tail: 'ok' },
      link: { runId: 'run-1', taskId: 't1', attempt: 2 },
    });
  });

  it('agent-reported と imported は untrusted になる', () => {
    expect(
      buildVerificationRecord(baseInput({ acquisition: 'agent-reported', actor: 'worker:codex' }))
        .trust,
    ).toBe('untrusted');
    expect(
      buildVerificationRecord(baseInput({ acquisition: 'imported', actor: 'external' })).trust,
    ).toBe('untrusted');
  });

  it('exit code の有無と値から outcome を決める', () => {
    expect(buildVerificationRecord(baseInput({ exitCode: 1 })).outcome).toBe('fail');
    expect(buildVerificationRecord(baseInput({ exitCode: undefined })).outcome).toBe('unknown');
  });

  it('実行の前後で同一性が変わると sourceChanged が真になる', () => {
    const changed = buildVerificationRecord(
      baseInput({ after: { ...identity, dirtyStateId: 'other' } }),
    );
    expect(changed.subject).toEqual({ ...identity, sourceChanged: true });
    const lost = buildVerificationRecord(baseInput({ after: undefined }));
    expect(lost.subject?.sourceChanged).toBe(true);
    expect(buildVerificationRecord(baseInput({ before: undefined })).subject).toBeUndefined();
  });

  it('読み出せない形の入力は保存前に拒む', () => {
    expect(() => buildVerificationRecord(baseInput({ actor: 'worker:' }))).toThrow(TypeError);
    expect(() => buildVerificationRecord(baseInput({ exitCode: 1.5 }))).toThrow(TypeError);
    expect(() => buildVerificationRecord(baseInput({ link: { attempt: Number.NaN } }))).toThrow(
      TypeError,
    );
  });

  it('返す記録は凍結されていて書き換えられない', () => {
    const record = buildVerificationRecord(baseInput());
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (record as { trust: string }).trust = 'untrusted';
    }).toThrow(TypeError);
    expect(() => {
      (record.link as { runId?: string }).runId = 'x';
    }).toThrow(TypeError);
  });

  it('出力の末尾とコマンドは maskForLog を通してから保存する', () => {
    const record = buildVerificationRecord(
      baseInput({
        command: 'curl https://user:pass@example.com',
        output: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 at /home/alice/x',
      }),
      { homeDir: '/home/alice' },
    );
    expect(record.command).not.toContain('pass@');
    expect(record.outputRef.tail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(record.outputRef.tail).not.toContain('alice');
  });
});

describe('maskOutputTail', () => {
  it('長い出力は上限の文字数の末尾だけを残す', () => {
    const output = `${'x'.repeat(50_000)}\nlast line`;
    const tail = maskOutputTail(output);
    expect(tail.length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX_CHARS);
    expect(tail.endsWith('last line')).toBe(true);
  });

  it('末尾に含まれるトークンはマスクされる', () => {
    const output = `${'y\n'.repeat(20_000)}secret ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`;
    expect(maskOutputTail(output)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('parseVerificationRecord', () => {
  const stored = () =>
    JSON.parse(JSON.stringify(buildVerificationRecord(baseInput()))) as Record<string, unknown>;

  it('保存した形を読み戻せる', () => {
    const value = stored();
    expect(parseVerificationRecord(value)).toEqual(value);
  });

  it('observed 以外で trusted になっている記録は捨てる', () => {
    const tampered = { ...stored(), acquisition: 'agent-reported', trust: 'trusted' };
    expect(parseVerificationRecord(tampered)).toBeUndefined();
  });

  it('知らない版・欠けた項目・exit code と食い違う outcome は捨てる', () => {
    expect(parseVerificationRecord({ ...stored(), schemaVersion: 2 })).toBeUndefined();
    expect(parseVerificationRecord({ ...stored(), command: undefined })).toBeUndefined();
    expect(parseVerificationRecord({ ...stored(), outcome: 'fail' })).toBeUndefined();
    expect(parseVerificationRecord({ ...stored(), actor: 'worker:' })).toBeUndefined();
    expect(parseVerificationRecord(null)).toBeUndefined();
  });
});
