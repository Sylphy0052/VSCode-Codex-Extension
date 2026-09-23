import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import { collectCommandEvidence, readSettledCommand } from '../../src/loop/goalLoop';
import {
  AgentReportedRecorder,
  buildAgentReportedInput,
  type AgentReportedScope,
} from '../../src/verification/agentReported';
import {
  buildVerificationRecord,
  type VerificationRecordInput,
} from '../../src/verification/record';
import type { SourceIdentity } from '../../src/verification/sourceIdentity';
import { VerificationStore } from '../../src/verification/store';

const command = (id: string, detail: string, status: string | undefined, text = ''): ChatItem => ({
  id,
  kind: 'commandExecution',
  text,
  detail,
  status,
  turnId: undefined,
  diffs: [],
});

const scope: AgentReportedScope = {
  provider: 'claude',
  cwd: '/repo',
  link: { sessionId: 'thread-1', iteration: 2 },
};

const settled = (item: ChatItem) => {
  const read = readSettledCommand(item);
  if (read === undefined) {
    throw new Error('終わった項目として読めなかった');
  }
  return read;
};

const identity = (dirtyStateId: string): SourceIdentity => ({
  repoId: 'repo',
  worktreeId: 'wt',
  head: 'abc',
  dirtyStateId,
});

describe('buildAgentReportedInput', () => {
  it('会話の項目から作った記録は agent-reported / untrusted になる', () => {
    const record = buildVerificationRecord(
      buildAgentReportedInput(settled(command('c1', 'npm test', 'exit 0', 'ok')), scope),
    );
    expect(record.acquisition).toBe('agent-reported');
    expect(record.trust).toBe('untrusted');
    expect(record.actor).toBe('worker:claude');
    expect(record.exitCode).toBe(0);
    expect(record.outcome).toBe('pass');
    expect(record.command).toBe('npm test');
    expect(record.link).toEqual({ sessionId: 'thread-1', iteration: 2 });
  });

  it('どの状態・どのCLIの項目からでも trusted にならない', () => {
    const items = [
      command('a', 'npm test', 'exit 0'),
      command('b', 'npm test', 'exit 3'),
      command('c', 'npm test', 'completed'),
      command('d', 'npm test', 'failed'),
    ];
    for (const provider of ['codex', 'claude'] as const) {
      for (const item of items) {
        const record = buildVerificationRecord(
          buildAgentReportedInput(settled(item), { ...scope, provider }),
        );
        expect(record.trust).toBe('untrusted');
      }
    }
  });

  it('exit codeが取れない項目は unknown になり、pass にならない', () => {
    // Claudeの成功したBashは`completed`のままで終了コードが載らない（issue #1375）
    const record = buildVerificationRecord(
      buildAgentReportedInput(settled(command('c1', 'npm test', 'completed', 'ok')), scope),
    );
    expect(record.exitCode).toBeUndefined();
    expect(record.outcome).toBe('unknown');
  });

  it('時刻は取れないまま記録し、保存時刻などで埋めない', () => {
    const input = buildAgentReportedInput(settled(command('c1', 'ls', 'exit 0')), scope);
    expect(input.startedAt).toBeUndefined();
    expect(input.endedAt).toBeUndefined();
    const record = buildVerificationRecord(input);
    expect(record.startedAt).toBeUndefined();
    expect(record.endedAt).toBeUndefined();
    expect(typeof record.recordedAt).toBe('string');
  });
});

describe('readSettledCommand', () => {
  it('実行中・コマンド以外の項目は読まない', () => {
    expect(readSettledCommand(command('c1', 'npm test', 'inProgress'))).toBeUndefined();
    expect(readSettledCommand(command('c1', 'npm test', 'running'))).toBeUndefined();
    expect(readSettledCommand(command('c1', 'npm test', undefined))).toBeUndefined();
    expect(
      readSettledCommand({ ...command('m1', '', 'completed'), kind: 'agentMessage' }),
    ).toBeUndefined();
  });

  it('ループの証拠台帳と同じ項目を同じ終了コードで読む（台帳の中身は変わらない）', () => {
    const items = [
      command('a', 'npm test', 'exit 0', 'passed'),
      command('b', 'npm run lint', 'exit 2', 'error'),
      command('c', 'npm test', 'completed', 'ok'),
      command('d', 'npm test', 'running'),
    ];
    expect(collectCommandEvidence(items, new Set(), 1)).toEqual([
      { kind: 'test', source: 'npm test', status: 'pass', detail: 'exit 0\npassed', iteration: 1 },
      {
        kind: 'lint',
        source: 'npm run lint',
        status: 'fail',
        detail: 'exit 2\nerror',
        iteration: 1,
      },
      {
        kind: 'test',
        source: 'npm test',
        status: 'unknown',
        detail: '終了コード不明（status: completed）\nok',
        iteration: 1,
      },
    ]);
    expect(items.map((i) => readSettledCommand(i)?.exitCode)).toEqual([0, 2, undefined, undefined]);
    expect(items.map((i) => readSettledCommand(i) !== undefined)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('AgentReportedRecorder', () => {
  const setup = () => {
    const appended: VerificationRecordInput[] = [];
    const errors: string[] = [];
    let dirty = 0;
    const recorder = new AgentReportedRecorder(
      {
        append: (input) => {
          appended.push(input);
          return Promise.resolve();
        },
      },
      {
        captureSource: () => Promise.resolve(identity(`d${(dirty += 1)}`)),
        onError: (message) => errors.push(message),
      },
    );
    return { recorder, appended, errors };
  };

  it('begin より前に終わっていた項目は記録しない', async () => {
    const { recorder, appended } = setup();
    const key = {};
    const history = [command('old', 'npm test', 'exit 0')];
    recorder.begin(key, history, '/repo');
    await recorder.record(key, [...history, command('new', 'npm test', 'exit 1')], scope);
    expect(appended.map((input) => input.command)).toEqual(['npm test']);
    expect(appended[0]?.exitCode).toBe(1);
    expect(appended[0]?.acquisition).toBe('agent-reported');
  });

  it('begin していない会話は記録しない', async () => {
    const { recorder, appended } = setup();
    await recorder.record({}, [command('c1', 'npm test', 'exit 0')], scope);
    expect(appended).toEqual([]);
  });

  it('同じ項目を二度記録しない。実行中だった項目は終わったターンで記録する', async () => {
    const { recorder, appended } = setup();
    const key = {};
    recorder.begin(key, [], '/repo');
    await recorder.record(
      key,
      [command('a', 'npm test', 'exit 0'), command('b', 'npm run build', 'inProgress')],
      scope,
    );
    // 次のターンの開始（ワークフローはターンごとに begin を呼ぶ）でも記録済みは増えない
    recorder.begin(
      key,
      [command('a', 'npm test', 'exit 0'), command('b', 'npm run build', 'inProgress')],
      '/repo',
    );
    const items = [command('a', 'npm test', 'exit 0'), command('b', 'npm run build', 'exit 0')];
    await recorder.record(key, items, scope);
    await recorder.record(key, items, scope);
    expect(appended.map((input) => input.command)).toEqual(['npm test', 'npm run build']);
  });

  it('保存を待つ間に同じ項目で呼ばれても二重に記録しない', async () => {
    const { recorder, appended } = setup();
    const key = {};
    recorder.begin(key, [], '/repo');
    const items = [command('a', 'npm test', 'exit 0')];
    await Promise.all([recorder.record(key, items, scope), recorder.record(key, items, scope)]);
    expect(appended).toHaveLength(1);
  });

  it('ターンの開始と終了のソースで挟む', async () => {
    const { recorder, appended } = setup();
    const key = {};
    recorder.begin(key, [], '/repo');
    await recorder.record(key, [command('a', 'npm test', 'exit 0')], scope);
    expect(appended[0]?.before).toEqual(identity('d1'));
    expect(appended[0]?.after).toEqual(identity('d2'));
    // 次のターンは前のターンの終了時点から始まる
    await recorder.record(
      key,
      [command('a', 'npm test', 'exit 0'), command('b', 'npm test', 'exit 0')],
      scope,
    );
    expect(appended[1]?.before).toEqual(identity('d2'));
    expect(appended[1]?.after).toEqual(identity('d3'));
  });

  it('保存に失敗しても例外を投げず onError へ知らせる', async () => {
    const errors: string[] = [];
    const recorder = new AgentReportedRecorder(
      { append: () => Promise.reject(new Error('disk full')) },
      { captureSource: () => Promise.resolve(undefined), onError: (m) => errors.push(m) },
    );
    const key = {};
    recorder.begin(key, [], '/repo');
    await expect(
      recorder.record(key, [command('a', 'npm test', 'exit 0')], scope),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('disk full');
  });
});

describe('AgentReportedRecorder と VerificationStore', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'verif-agent-'));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('保存した記録を読み出しても untrusted のままで、終了コード不明は unknown になる', async () => {
    const store = new VerificationStore(baseDir);
    const recorder = new AgentReportedRecorder(store, {
      captureSource: () => Promise.resolve(undefined),
    });
    const key = {};
    recorder.begin(key, [], '/repo');
    await recorder.record(
      key,
      [command('a', 'npm test', 'exit 0', 'ok'), command('b', 'npm test', 'completed', 'ok')],
      { ...scope, link: { runId: 'run-1', taskId: 'task-1' } },
    );
    const records = await store.list({ runId: 'run-1' });
    // 同じミリ秒に保存した記録の並びは決まらないため、結果で並べ替えて比べる
    const rows = records.map((r) => [r.trust, r.acquisition, r.outcome]);
    expect(rows.sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
      ['untrusted', 'agent-reported', 'pass'],
      ['untrusted', 'agent-reported', 'unknown'],
    ]);
    expect(records.every((r) => r.startedAt === undefined && r.subject === undefined)).toBe(true);
  });
});
