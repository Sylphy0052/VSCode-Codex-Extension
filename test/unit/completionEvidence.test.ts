import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_COMMAND_MAX_CHARS,
  EVIDENCE_OUTPUT_TAIL_MAX_CHARS,
  buildCompletionEvidenceView,
  deriveCompletionEvidence,
  loadCompletionEvidence,
  loadTaskCompletionEvidence,
} from '../../src/verification/completionEvidence';
import {
  VERIFICATION_RECORD_SCHEMA_VERSION,
  trustForAcquisition,
  type VerificationAcquisition,
  type VerificationOutcome,
  type VerificationRecord,
} from '../../src/verification/record';
import type { SourceIdentity } from '../../src/verification/sourceIdentity';
import type { VerificationRecordFilter } from '../../src/verification/store';

const SOURCE: SourceIdentity = {
  repoId: 'repo',
  worktreeId: 'wt',
  head: 'abc',
  dirtyStateId: 'clean',
};
/** 完了後にファイルを変えた状態（未コミット変更の識別子だけが変わる） */
const EDITED: SourceIdentity = { ...SOURCE, dirtyStateId: 'dirty-1' };

let seq = 0;
function record(
  acquisition: VerificationAcquisition,
  outcome: VerificationOutcome,
  overrides: Partial<VerificationRecord> = {},
): VerificationRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    schemaVersion: VERIFICATION_RECORD_SCHEMA_VERSION,
    subject: { ...SOURCE, sourceChanged: false },
    command: 'npm test',
    cwd: '/work',
    exitCode: outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : undefined,
    outcome,
    recordedAt: '2026-09-23T00:00:00.000Z',
    actor: acquisition === 'observed' ? 'extension' : 'worker:codex',
    acquisition,
    trust: trustForAcquisition(acquisition),
    outputRef: { tail: 'ok' },
    link: {},
    ...overrides,
  };
}

describe('deriveCompletionEvidence', () => {
  it('ソースが一致するtrustedの記録がすべて成功なら確認済み', () => {
    const result = deriveCompletionEvidence(
      [record('observed', 'pass'), record('observed', 'pass')],
      SOURCE,
    );
    expect(result.category).toBe('verified');
  });

  it('ソースが一致するtrustedの記録に失敗があれば失敗', () => {
    const result = deriveCompletionEvidence(
      [record('observed', 'pass'), record('observed', 'fail')],
      SOURCE,
    );
    expect(result.category).toBe('failed');
  });

  it('trustedの結果不明は成功と数えない', () => {
    expect(deriveCompletionEvidence([record('observed', 'unknown')], SOURCE).category).toBe(
      'failed',
    );
  });

  it('agent-reportedの成功だけでは確認済みにならない', () => {
    const result = deriveCompletionEvidence(
      [record('agent-reported', 'pass'), record('agent-reported', 'pass')],
      SOURCE,
    );
    expect(result.category).toBe('selfReportedOnly');
  });

  it('importedの記録だけなら未確認', () => {
    expect(deriveCompletionEvidence([record('imported', 'pass')], SOURCE).category).toBe(
      'unverified',
    );
  });

  it('記録が無ければ未確認', () => {
    expect(deriveCompletionEvidence([], SOURCE).category).toBe('unverified');
  });

  it('完了後にファイルを変えると、成功した記録があっても未確認になる', () => {
    const records = [record('observed', 'pass')];
    expect(deriveCompletionEvidence(records, SOURCE).category).toBe('verified');
    expect(deriveCompletionEvidence(records, EDITED).category).toBe('unverified');
  });

  it('実行中にソースが変わった記録は一致とみなさない', () => {
    const changed = record('observed', 'pass', {
      subject: { ...SOURCE, sourceChanged: true },
    });
    expect(deriveCompletionEvidence([changed], SOURCE).category).toBe('unverified');
  });

  it('表示時点のソースを取れなければ未確認', () => {
    expect(deriveCompletionEvidence([record('observed', 'pass')], undefined).category).toBe(
      'unverified',
    );
  });

  it('一致しないtrustedがあっても、一致するtrustedだけで判定する', () => {
    const stale = record('observed', 'fail', { subject: { ...EDITED, sourceChanged: false } });
    expect(deriveCompletionEvidence([stale, record('observed', 'pass')], SOURCE).category).toBe(
      'verified',
    );
  });
});

describe('buildCompletionEvidenceView', () => {
  it('コマンドと出力末尾を1行化し、長さを制限する', () => {
    const view = buildCompletionEvidenceView(
      [
        record('observed', 'fail', {
          command: `echo a\necho b ${'x'.repeat(1000)}`,
          outputRef: { tail: `${'y'.repeat(5000)}\nEND` },
        }),
      ],
      SOURCE,
    );
    const entry = view.entries[0];
    expect(entry).toBeDefined();
    expect(entry?.command).not.toMatch(/[\r\n]/);
    // 切り詰めた印の「…」1文字を含む
    expect(entry?.command.length).toBeLessThanOrEqual(EVIDENCE_COMMAND_MAX_CHARS + 1);
    expect(entry?.outputTail).not.toMatch(/[\r\n]/);
    expect(entry?.outputTail.length).toBeLessThanOrEqual(EVIDENCE_OUTPUT_TAIL_MAX_CHARS);
    // 末尾が残る
    expect(entry?.outputTail).toContain('END');
    expect(entry?.exitCode).toBe(1);
    expect(entry?.sourceMatch).toBe('match');
  });

  it('新しい順に並べ、時刻は終了・開始・保存の順で選ぶ', () => {
    const view = buildCompletionEvidenceView(
      [
        record('agent-reported', 'pass', { command: 'old' }),
        record('observed', 'pass', {
          command: 'new',
          startedAt: '2026-09-23T01:00:00.000Z',
          endedAt: '2026-09-23T01:00:05.000Z',
        }),
      ],
      SOURCE,
    );
    expect(view.entries.map((e) => e.command)).toEqual(['new', 'old']);
    expect(view.entries.map((e) => e.timeKind)).toEqual(['ended', 'recorded']);
  });
});

describe('loadCompletionEvidence', () => {
  it('表示時点のソースで導き直す（完了後の変更で未確認へ戻る）', async () => {
    const records = [record('observed', 'pass', { link: { sessionId: 's1' } })];
    const store = { list: (_filter: VerificationRecordFilter) => Promise.resolve(records) };
    const before = await loadCompletionEvidence(store, { sessionId: 's1' }, '/work', {
      capture: () => Promise.resolve(SOURCE),
    });
    const after = await loadCompletionEvidence(store, { sessionId: 's1' }, '/work', {
      capture: () => Promise.resolve(EDITED),
    });
    expect(before.category).toBe('verified');
    expect(after.category).toBe('unverified');
    expect(after.entries[0]?.sourceMatch).toBe('mismatch');
  });

  it('sinceより前に保存された記録を除く', async () => {
    const records = [
      record('observed', 'fail', { recordedAt: '2026-09-22T00:00:00.000Z' }),
      record('observed', 'pass', { recordedAt: '2026-09-23T00:00:00.000Z' }),
    ];
    const view = await loadCompletionEvidence(
      { list: () => Promise.resolve(records) },
      {},
      '/work',
      { since: '2026-09-22T12:00:00.000Z', capture: () => Promise.resolve(SOURCE) },
    );
    expect(view.category).toBe('verified');
    expect(view.entries).toHaveLength(1);
  });
});

describe('loadTaskCompletionEvidence', () => {
  it('タスクごとに記録を分けて導く', async () => {
    const records = [
      record('observed', 'pass', { link: { runId: 'run', taskId: 't1' } }),
      record('agent-reported', 'pass', { link: { runId: 'run', taskId: 't2' } }),
    ];
    const result = await loadTaskCompletionEvidence(
      { list: () => Promise.resolve(records) },
      'run',
      [
        { id: 't1', cwd: '/work' },
        { id: 't2', cwd: '/work' },
        { id: 't3', cwd: undefined },
      ],
      { capture: () => Promise.resolve(SOURCE) },
    );
    expect(result['t1']?.category).toBe('verified');
    expect(result['t2']?.category).toBe('selfReportedOnly');
    expect(result['t3']?.category).toBe('unverified');
  });
});
