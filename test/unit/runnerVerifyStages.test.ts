import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from '../../src/log';
import {
  withTemporaryRevert,
  type TemporaryRevertResult,
} from '../../src/orchestrator/runnerRevert';
import {
  MEASUREMENT_OUTPUT_MAX_CHARS,
  REVERTED_PATHS_LIMIT,
  runVerifyStages,
} from '../../src/orchestrator/runnerVerifyStages';
import type {
  ExecuteVerifyCommandsResult,
  ExecutedVerifyCommand,
} from '../../src/orchestrator/runnerVerifyCommands';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';
import type { WorkflowTask } from '../../src/orchestrator/workflow';
import type { VerifyCommandResult } from '../../src/verification/commandRunner';

// 実gitを動かさないため、変更を戻す処理は差し替える
vi.mock('../../src/orchestrator/runnerRevert', () => ({
  withTemporaryRevert: vi.fn(),
}));

// 実行環境のHOMEに依存させないため、ホームディレクトリを固定する
const HOME = '/home/tester';
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => HOME,
}));

const mockedRevert = vi.mocked(withTemporaryRevert);

type Verify = NonNullable<WorkflowTask['verify']>;

function task(verify: Partial<Verify> | undefined): WorkflowTask {
  return {
    id: 't1',
    verify:
      verify === undefined
        ? undefined
        : {
            commands: ['npm test'],
            files: [],
            diff: [],
            semantic: false,
            revertCheck: false,
            baseline: [],
            ...verify,
          },
  } as unknown as WorkflowTask;
}

function result(overrides: Partial<VerifyCommandResult> = {}): VerifyCommandResult {
  return {
    exitCode: 0,
    output: '',
    timedOut: false,
    aborted: false,
    startedAt: new Date(0),
    endedAt: new Date(1),
    ...overrides,
  };
}

function executed(
  command: string,
  overrides: Partial<VerifyCommandResult> = {},
): ExecutedVerifyCommand {
  return { command, result: result(overrides) };
}

function execResult(
  overrides: Partial<ExecuteVerifyCommandsResult> = {},
): ExecuteVerifyCommandsResult {
  return { failures: [], aborted: false, executed: [], ...overrides };
}

type ExecuteFn = Parameters<typeof runVerifyStages>[0]['execute'];
type RevertCall = Parameters<typeof withTemporaryRevert>[0];

function ran(
  value: ExecuteVerifyCommandsResult,
  extra: { revertedPaths?: readonly string[]; restoreError?: string } = {},
): TemporaryRevertResult<ExecuteVerifyCommandsResult> {
  return {
    kind: 'ran',
    value,
    revertedPaths: extra.revertedPaths ?? ['src/a.ts'],
    ...(extra.restoreError === undefined ? {} : { restoreError: extra.restoreError }),
  };
}

describe('runVerifyStages', () => {
  let log: Logger & {
    info: Mock<Logger['info']>;
    warn: Mock<Logger['warn']>;
    error: Mock<Logger['error']>;
  };
  let execute: Mock<ExecuteFn>;
  const git = { run: vi.fn() } as unknown as GitCommandRunner;
  const signal = new AbortController().signal;

  beforeEach(() => {
    mockedRevert.mockReset();
    log = {
      info: vi.fn<Logger['info']>(),
      warn: vi.fn<Logger['warn']>(),
      error: vi.fn<Logger['error']>(),
      show: vi.fn<Logger['show']>(),
    };
    execute = vi.fn<ExecuteFn>(() => Promise.resolve(execResult()));
  });

  function run(
    verify: Partial<Verify> | undefined,
    extra: { originCommit?: string; taskRun?: readonly ExecutedVerifyCommand[] } = {},
  ) {
    return runVerifyStages({
      task: task(verify),
      taskId: 't1',
      cwd: '/work',
      originCommit: extra.originCommit ?? 'abc123',
      git,
      taskRun: extra.taskRun ?? [],
      execute,
      signal,
      log,
      logPrefix: '[t1]',
    });
  }

  describe('実行しないとき', () => {
    it('verifyが無ければ何もせず成功を返す', async () => {
      expect(await run(undefined)).toEqual({ failures: [], aborted: false });
      expect(mockedRevert).not.toHaveBeenCalled();
    });

    it('revertCheckもbaselineも無ければ何もしない', async () => {
      expect(await run({ revertCheck: false, baseline: [] })).toEqual({
        failures: [],
        aborted: false,
      });
      expect(mockedRevert).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('分岐元のコミットが空なら警告して見送る', async () => {
      const out = await run({ revertCheck: true, baseline: ['npm test'] }, { originCommit: '' });

      expect(out.failures).toEqual([]);
      expect(out.aborted).toBe(false);
      expect(out.skipped).toContain('分岐元のコミットが分からない');
      expect(log.warn).toHaveBeenCalledWith(`[t1] ${out.skipped}`);
      expect(mockedRevert).not.toHaveBeenCalled();
    });
  });

  describe('revertCheck', () => {
    it('production範囲でverify.commandsをrevertステージで実行する', async () => {
      mockedRevert.mockImplementationOnce(async (input: RevertCall) =>
        ran(await (input.body() as Promise<ExecuteVerifyCommandsResult>), {
          revertedPaths: ['src/a.ts'],
        }),
      );
      execute.mockResolvedValueOnce(execResult({ failures: ['テスト失敗'] }));

      const out = await run({ revertCheck: true, commands: ['npm test', 'npm run lint'] });

      const call = mockedRevert.mock.calls[0]?.[0];
      expect(call?.scope).toBe('production');
      expect(call?.cwd).toBe('/work');
      expect(call?.originCommit).toBe('abc123');
      expect(call?.git).toBe(git);
      expect(call?.signal).toBe(signal);
      expect(execute).toHaveBeenCalledWith(['npm test', 'npm run lint'], 'revert');
      expect(out).toEqual({ failures: [], aborted: false });
    });

    it('commandsが未設定のverifyでは空配列で実行する', async () => {
      mockedRevert.mockImplementationOnce(async (input: RevertCall) =>
        ran(await (input.body() as Promise<ExecuteVerifyCommandsResult>)),
      );
      execute.mockResolvedValueOnce(execResult({ failures: ['x'] }));

      // YAML由来で型の保証が崩れた場合の防御（型上はcommandsは必須）
      await run({ revertCheck: true, commands: undefined as unknown as string[] });

      expect(execute).toHaveBeenCalledWith([], 'revert');
    });

    it('戻しても全部成功したら、テストが変更を検出していない失敗を積む', async () => {
      mockedRevert.mockResolvedValueOnce(
        ran(execResult(), { revertedPaths: ['src/a.ts', 'src/b.ts'] }),
      );

      const out = await run({ revertCheck: true });

      expect(out.aborted).toBe(false);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toContain('テストが変更を検出していません');
      expect(out.failures[0]).toContain('戻したファイル: src/a.ts, src/b.ts');
      expect(out.failures[0]).not.toContain('ほか');
    });

    it('戻したファイルが上限ちょうどなら省略表記を付けない', async () => {
      const paths = Array.from({ length: REVERTED_PATHS_LIMIT }, (_, i) => `f${i}.ts`);
      mockedRevert.mockResolvedValueOnce(ran(execResult(), { revertedPaths: paths }));

      const out = await run({ revertCheck: true });

      expect(out.failures[0]).toContain(`f${REVERTED_PATHS_LIMIT - 1}.ts`);
      expect(out.failures[0]).not.toContain('ほか');
    });

    it('戻したファイルが上限を超えたら上限の件数までに切って残数を示す', async () => {
      const excess = 5;
      const paths = Array.from({ length: REVERTED_PATHS_LIMIT + excess }, (_, i) => `f${i}.ts`);
      mockedRevert.mockResolvedValueOnce(ran(execResult(), { revertedPaths: paths }));

      const out = await run({ revertCheck: true });

      expect(out.failures[0]).toContain(`f${REVERTED_PATHS_LIMIT - 1}.ts`);
      expect(out.failures[0]).not.toContain(`f${REVERTED_PATHS_LIMIT}.ts`);
      expect(out.failures[0]).toContain(`ほか${excess}件`);
    });

    it('戻すと失敗するなら正常（失敗を積まない）', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult({ failures: ['落ちた'] })));

      const out = await run({ revertCheck: true });

      expect(out).toEqual({ failures: [], aborted: false });
      expect(mockedRevert.mock.calls[0]?.[0].scope).toBe('production');
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    it('戻した状態の実行が中断されたらabortedを返し失敗を積まない', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult({ aborted: true })));

      expect(await run({ revertCheck: true })).toEqual({ failures: [], aborted: true });
    });

    it('戻す前に中断されたらabortedを返す', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'aborted' });

      expect(await run({ revertCheck: true, baseline: ['npm test'] })).toEqual({
        failures: [],
        aborted: true,
      });
      expect(mockedRevert).toHaveBeenCalledTimes(1);
    });

    it('テスト以外の変更が無ければログへ残して見送り、成功扱いにする', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'noChanges' });

      const out = await run({ revertCheck: true });

      expect(out).toEqual({ failures: [], aborted: false });
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('verify.revertCheck を見送りました'),
      );
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[t1]'));
    });

    it('戻せずに失敗したら理由つきで検証の失敗として返す（作業ツリーは元のまま）', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'failed', error: 'git diff に失敗しました' });

      const out = await run({ revertCheck: true, baseline: ['npm test'] });

      expect(out).toEqual({
        failures: ['変更を戻した検証を実行できませんでした: git diff に失敗しました'],
        aborted: false,
      });
      expect(log.error).not.toHaveBeenCalled();
      expect(mockedRevert).toHaveBeenCalledTimes(1);
    });

    it('失敗に理由が無ければ「原因不明」と書く', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'failed', error: undefined as unknown as string });

      const out = await run({ revertCheck: true });

      expect(out.failures).toEqual(['変更を戻した検証を実行できませんでした: 原因不明']);
    });

    it('失敗した上に元へ戻せなかったらrestoreErrorを返しエラーログを出す', async () => {
      mockedRevert.mockResolvedValueOnce({
        kind: 'failed',
        error: '戻せない',
        restoreError: '復元に失敗',
      });

      const out = await run({ revertCheck: true, baseline: ['npm test'] });

      expect(out).toEqual({ failures: [], restoreError: '復元に失敗', aborted: false });
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('復元に失敗'));
      expect(mockedRevert).toHaveBeenCalledTimes(1);
    });

    it('実行後に作業ツリーを元へ戻せなかったらrestoreErrorを返し、baselineへ進まない', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult(), { restoreError: '一致しません' }));

      const out = await run({ revertCheck: true, baseline: ['npm test'] });

      expect(out).toEqual({ failures: [], restoreError: '一致しません', aborted: false });
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('一致しません'));
      expect(mockedRevert).toHaveBeenCalledTimes(1);
    });
  });

  describe('baseline', () => {
    it('all範囲でbaselineのコマンドをbaselineステージで実行する', async () => {
      mockedRevert.mockImplementationOnce(async (input: RevertCall) =>
        ran(await (input.body() as Promise<ExecuteVerifyCommandsResult>)),
      );

      const out = await run({
        baseline: ['npm run bench'],
        commands: ['npm test', 'npm run bench'],
      });

      const call = mockedRevert.mock.calls[0]?.[0];
      expect(call?.scope).toBe('all');
      expect(call?.signal).toBe(signal);
      expect(execute).toHaveBeenCalledWith(['npm run bench'], 'baseline');
      expect(out.measurements).toContain('### npm run bench');
    });

    it('revertCheckを指定しなければrevertステージは走らせない', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult()));

      await run({ baseline: ['npm run bench'] });

      expect(mockedRevert).toHaveBeenCalledTimes(1);
      expect(mockedRevert.mock.calls[0]?.[0].scope).toBe('all');
    });

    it('revertCheckの失敗を保ったままbaselineも測る', async () => {
      mockedRevert
        .mockResolvedValueOnce(ran(execResult(), { revertedPaths: ['src/a.ts'] }))
        .mockResolvedValueOnce(ran(execResult({ executed: [executed('npm test')] })));

      const out = await run(
        { revertCheck: true, baseline: ['npm test'] },
        { taskRun: [executed('npm test')] },
      );

      expect(mockedRevert.mock.calls.map((c) => c[0].scope)).toEqual(['production', 'all']);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toContain('テストが変更を検出していません');
      expect(out.measurements).toContain('### npm test');
    });

    it('戻す前に中断されたらabortedを返す', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'aborted' });

      expect(await run({ baseline: ['npm test'] })).toEqual({ failures: [], aborted: true });
    });

    it('実行が中断されたらabortedを返し、測定結果は付けない', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult({ aborted: true })));

      const out = await run({ baseline: ['npm test'] });

      expect(out).toEqual({ failures: [], aborted: true });
      expect(out.measurements).toBeUndefined();
    });

    it('分岐元からの変更が無ければログへ残して見送る', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'noChanges' });

      const out = await run({ baseline: ['npm test'] });

      expect(out).toEqual({ failures: [], aborted: false });
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('verify.baseline を見送りました'),
      );
    });

    it('戻せずに失敗したら検証の失敗として返す', async () => {
      mockedRevert.mockResolvedValueOnce({ kind: 'failed', error: 'snapshot失敗' });

      const out = await run({ baseline: ['npm test'] });

      expect(out).toEqual({
        failures: ['変更を戻した検証を実行できませんでした: snapshot失敗'],
        aborted: false,
      });
    });

    it('revertCheckの失敗とbaselineの失敗を両方積む', async () => {
      mockedRevert
        .mockResolvedValueOnce(ran(execResult()))
        .mockResolvedValueOnce({ kind: 'failed', error: 'baseline失敗' });

      const out = await run({ revertCheck: true, baseline: ['npm test'] });

      expect(out.failures).toHaveLength(2);
      expect(out.failures[1]).toContain('baseline失敗');
    });

    it('実行後に元へ戻せなかったらrestoreErrorを返す', async () => {
      mockedRevert.mockResolvedValueOnce(ran(execResult(), { restoreError: 'baseline復元失敗' }));

      const out = await run({ baseline: ['npm test'] });

      expect(out).toEqual({ failures: [], restoreError: 'baseline復元失敗', aborted: false });
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('baseline復元失敗'));
    });
  });

  describe('測定結果の整形', () => {
    async function measure(
      base: ExecutedVerifyCommand[],
      taskRun: ExecutedVerifyCommand[],
      commands = ['npm test'],
    ): Promise<string | undefined> {
      mockedRevert.mockResolvedValueOnce(ran(execResult({ executed: base })));
      const out = await run({ baseline: commands }, { taskRun });
      return out.measurements;
    }

    it('コマンドごとに分岐元とタスク後のexit codeを並べる', async () => {
      const text = await measure(
        [executed('npm test', { exitCode: 1 })],
        [executed('npm test', { exitCode: 0 })],
      );

      expect(text).toBe(['### npm test', '分岐元: exit 1', 'タスク後: exit 0'].join('\n'));
    });

    it('出力があれば状態の次の行へ前後の空白を除いて付ける', async () => {
      const text = await measure(
        [executed('npm test', { exitCode: 1, output: '\n  3 failed\n' })],
        [executed('npm test', { exitCode: 0, output: 'ok\n' })],
      );

      expect(text).toBe(
        ['### npm test', '分岐元: exit 1', '3 failed', 'タスク後: exit 0', 'ok'].join('\n'),
      );
    });

    it('時間切れはexit codeより優先して表示する', async () => {
      const text = await measure(
        [executed('npm test', { timedOut: true, exitCode: 0 })],
        [executed('npm test', { exitCode: 0 })],
      );

      expect(text).toContain('分岐元: 時間切れ');
      expect(text).not.toContain('分岐元: exit');
    });

    it('exit codeが無いときは実行できなかった理由を表示する', async () => {
      const text = await measure(
        [executed('npm test', { exitCode: undefined, error: 'ENOENT' })],
        [executed('npm test', { exitCode: undefined })],
      );

      expect(text).toContain('分岐元: 実行できず（ENOENT）');
      expect(text).toContain('タスク後: 実行できず（原因不明）');
    });

    it('結果が無い側は「結果なし」と表示する', async () => {
      const text = await measure([], [executed('npm test', { exitCode: 0 })]);

      expect(text).toBe(['### npm test', '分岐元: 結果なし', 'タスク後: exit 0'].join('\n'));
      const noTask = await measure([executed('npm test', { exitCode: 0 })], []);
      expect(noTask).toBe(['### npm test', '分岐元: exit 0', 'タスク後: 結果なし'].join('\n'));
    });

    it('複数コマンドを見出しごとに空行で区切り、末尾の空行は付けない', async () => {
      const text = await measure(
        [executed('a', { exitCode: 0 }), executed('b', { exitCode: 2 })],
        [executed('a', { exitCode: 0 }), executed('b', { exitCode: 0 })],
        ['a', 'b'],
      );

      expect(text).toBe(
        [
          '### a',
          '分岐元: exit 0',
          'タスク後: exit 0',
          '',
          '### b',
          '分岐元: exit 2',
          'タスク後: exit 0',
        ].join('\n'),
      );
    });

    it('出力は末尾の上限の文字数だけに切る', async () => {
      const tail = 't'.repeat(MEASUREMENT_OUTPUT_MAX_CHARS);
      const text = await measure(
        [
          executed('npm test', {
            exitCode: 1,
            output: `${'h'.repeat(3 * MEASUREMENT_OUTPUT_MAX_CHARS)}${tail}`,
          }),
        ],
        [executed('npm test', { exitCode: 0 })],
      );

      expect(text).toBe(['### npm test', '分岐元: exit 1', tail, 'タスク後: exit 0'].join('\n'));
    });

    it('出力に含まれるホームディレクトリをマスクする', async () => {
      const text = await measure(
        [executed('npm test', { exitCode: 1, output: `error at ${HOME}/proj/a.ts` })],
        [executed('npm test', { exitCode: 0 })],
      );

      expect(text).toContain('/proj/a.ts');
      expect(text).not.toContain(HOME);
    });
  });
});
