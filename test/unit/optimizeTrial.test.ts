import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OptimizeLedgerStore } from '../../src/orchestrator/optimizeLedger';
import type { OptimizationSpec } from '../../src/orchestrator/optimizeSpec';
import { runOptimizeTrial, type OptimizeTrialInput } from '../../src/orchestrator/optimizeTrial';
import type {
  RunTrialStageInput,
  TrialProcessResult,
  TrialStageResult,
} from '../../src/orchestrator/optimizeTrialSession';
import { optimizeRef, prepareMeasureWorktrees } from '../../src/orchestrator/optimizeWorktrees';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const RUN_ID = 'run1';
const TASK_ID = 'T2';
const HYPOTHESIS = {
  hypothesis: 'ループが遅い',
  prediction: '2割短くなる',
  approach: 'キャッシュする',
};

const proc = (over: Partial<TrialProcessResult> = {}): TrialProcessResult => ({
  pid: 4242,
  stdout: '',
  exitCode: 0,
  timedOut: false,
  aborted: false,
  groupRemains: false,
  ...over,
});

const METRIC_COMMAND = `node -e "const fs=require('fs');fs.writeFileSync('m.json',JSON.stringify({value:Number(fs.readFileSync('src/value.txt','utf8'))}))"`;

describe('runOptimizeTrial', () => {
  let root: string;
  let repo: string;
  let dirs: { baseline: string; best: string; candidate: string };
  let storage: string;
  let bestCommit: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'optimize-trial-test-'));
    repo = join(root, 'repo');
    storage = join(root, 'storage');
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'bench'), { recursive: true });
    await mkdir(join(repo, '.github'), { recursive: true });
    await writeFile(join(repo, 'src', 'value.txt'), '10');
    await writeFile(join(repo, 'src', 'guarded.txt'), 'g');
    await writeFile(join(repo, 'bench', 'b.txt'), 'b');
    await writeFile(join(repo, '.github', 'self-improve-protected-paths'), 'src/guarded.txt\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    bestCommit = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/heads/task', bestCommit);
    dirs = await prepareMeasureWorktrees({
      repoDir: repo,
      root: join(root, 'wt'),
      commits: { baseline: bestCommit, best: bestCommit, candidate: bestCommit },
      allowedPaths: ['src'],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const spec = (over: Partial<OptimizationSpec> = {}): OptimizationSpec => ({
    metricSource: 'file',
    metricCommand: METRIC_COMMAND,
    metricFile: 'm.json',
    direction: 'minimize',
    minImprovement: { kind: 'absolute', value: 1 },
    significanceLevel: 0.05,
    correctnessCommand: 'true',
    allowedPaths: ['src'],
    budget: { maxTrials: 10, maxMinutes: 60 },
    measurementRuns: 5,
    ...over,
  });

  type Change = (input: RunTrialStageInput) => Promise<void> | void;
  interface Fake {
    calls: RunTrialStageInput[];
    runStage: (input: RunTrialStageInput) => Promise<TrialStageResult>;
  }

  /** 試行のセッションの代わり。仮説の段はJSONを返し、変更の段は`change`で作業ツリーを書き換える。 */
  function fakeSession(opts: {
    onHypothesis?: Change;
    onChange?: Change;
    changeText?: string;
    hypothesisText?: string;
  }): Fake {
    const calls: RunTrialStageInput[] = [];
    return {
      calls,
      runStage: async (input) => {
        calls.push(input);
        if (input.stage === 'hypothesis') {
          await opts.onHypothesis?.(input);
          return {
            ok: true,
            text: opts.hypothesisText ?? JSON.stringify(HYPOTHESIS),
            sessionId: 'sess-1',
            process: proc(),
          };
        }
        await opts.onChange?.(input);
        return { ok: true, text: opts.changeText ?? '値を小さくした', process: proc() };
      },
    };
  }

  const setValue =
    (value: string): Change =>
    async (input) => {
      await writeFile(join(input.cwd, 'src', 'value.txt'), value);
    };

  const run = (
    fake: Fake,
    over: Partial<OptimizeTrialInput> = {},
    specOver: Partial<OptimizationSpec> = {},
  ) =>
    runOptimizeTrial({
      runId: RUN_ID,
      taskId: TASK_ID,
      trial: 1,
      repoDir: repo,
      spec: spec(specOver),
      objective: '速くする',
      dirs,
      bestCommit,
      taskBranchRef: 'refs/heads/task',
      ledger: new OptimizeLedgerStore(storage),
      engine: {
        engine: 'claude',
        executable: 'claude',
        model: 'auto',
        claudeSandbox: { weakerNested: false },
      },
      processRecordDir: join(storage, 'processes'),
      deps: { runStage: fake.runStage },
      ...over,
    });

  it('正しく速くなった試行は採用候補になり、木がrefへ固定され、台帳に1行残る', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(fake);
    expect(result.outcome).toBe('adopted');
    expect(result.adoptionCandidate).toBe(true);
    expect(result.halt).toBe(false);
    expect(result.continuation).toBe('resume');
    expect(result.commit).toBeDefined();
    expect(git(repo, 'rev-parse', optimizeRef(RUN_ID, { trial: 1 }))).toBe(result.commit);
    expect(git(repo, 'show', `${result.commit}:src/value.txt`)).toBe('5');
    const rows = await new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision.outcome).toBe('adopted');
    expect(rows[0]?.commit).toBe(result.commit);
    expect(rows[0]?.metric.median).toBe(5);
  });

  it('2段目へは1段目のセッションIDを渡し、1段目は読み取り専用の段として呼ぶ', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    await run(fake);
    expect(fake.calls.map((c) => c.stage)).toEqual(['hypothesis', 'change']);
    expect(fake.calls[1]?.resumeSessionId).toBe('sess-1');
    expect(fake.calls[0]?.cwd).toBe(dirs.candidate);
  });

  it('台帳の仮説は1段目のもので、2段目の出力で差し替わらない', async () => {
    const fake = fakeSession({
      onChange: setValue('5'),
      changeText: '{"hypothesis":"別の仮説","prediction":"x","approach":"y"}',
    });
    const result = await run(fake);
    expect(result.record.llm.hypothesis).toBe(HYPOTHESIS.hypothesis);
    expect(result.record.llm.approach).toBe(HYPOTHESIS.approach);
    expect(result.record.llm.changeSummary).toContain('別の仮説');
  });

  it('Codexは会話を続けず、新しいセッションに仮説を渡す', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(fake, {
      engine: { engine: 'codex', executable: 'codex', model: 'auto' },
    });
    expect(result.continuation).toBe('fresh');
    expect(fake.calls[1]?.resumeSessionId).toBeUndefined();
    expect(fake.calls[1]?.prompt).toContain('ループが遅い');
  });

  describe('不採用になる試行', () => {
    it('変更してよいパスの外を変えた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          await writeFile(join(input.cwd, 'bench', 'b.txt'), 'changed');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.record.decision.reason).toContain('bench/b.txt');
      expect(result.halt).toBe(false);
      expect(result.violations.map((v) => v.kind)).toContain('outsideAllowedPaths');
    });

    it('候補のHEADを動かした', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          git(input.cwd, 'commit', '-q', '-am', 'sneaky');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.violations.map((v) => v.kind)).toContain('candidateHeadMoved');
    });

    it('refs/optimize/<runId>/の下のrefを動かした', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          git(input.cwd, 'update-ref', `refs/optimize/${RUN_ID}/best`, bestCommit);
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.halt).toBe(true);
      expect(result.violations.map((v) => v.kind)).toContain('refsChanged');
    });

    it('タスクのブランチのrefを動かした', async () => {
      const other = git(repo, 'commit-tree', `${bestCommit}^{tree}`, '-m', 'x');
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          git(input.cwd, 'update-ref', 'refs/heads/task', other);
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.halt).toBe(true);
    });

    it('.gitのhooksを変えた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          await writeFile(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.halt).toBe(true);
      expect(result.violations.map((v) => v.kind)).toContain('gitConfigChanged');
    });

    it('.gitのconfigを変えた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          git(input.cwd, 'config', 'alias.x', 'status');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.violations.map((v) => v.kind)).toContain('gitConfigChanged');
    });

    it('基準のworktreeを変えた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          await writeFile(join(dirs.baseline, 'src', 'value.txt'), '1');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.halt).toBe(true);
      expect(result.violations.map((v) => v.kind)).toContain('measureTreeChanged');
    });

    it('最良のworktreeを変えた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          await writeFile(join(dirs.best, 'src', 'value.txt'), '100');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.violations.map((v) => v.kind)).toContain('measureTreeChanged');
    });

    it('自己改善の保護パスに触れた', async () => {
      const fake = fakeSession({
        onChange: async (input) => {
          await setValue('5')(input);
          await writeFile(join(input.cwd, 'src', 'guarded.txt'), 'x');
        },
      });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.violations.map((v) => v.kind)).toContain('protectedPaths');
    });

    it('正しさが2回とも落ちた', async () => {
      const fake = fakeSession({ onChange: setValue('5') });
      const result = await run(fake, {}, { correctnessCommand: 'exit 1' });
      expect(result.outcome).toBe('rejected');
      expect(result.record.correctness.passed).toBe(false);
      expect(result.record.decision.reason).toContain('2回とも');
    });

    it('正しさが1回落ちても、やり直して通れば計測へ進む', async () => {
      const flag = join(root, 'flag');
      const fake = fakeSession({ onChange: setValue('5') });
      const result = await run(
        fake,
        {},
        { correctnessCommand: `test -f ${flag} || { touch ${flag}; exit 1; }` },
      );
      expect(result.outcome).toBe('adopted');
      expect(result.record.correctness.detail).toContain('2回目');
    });

    it('指標が最小の差に届かない', async () => {
      const fake = fakeSession({ onChange: setValue('9.5') });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
      expect(result.record.decision.reason).toContain('最小の差');
    });

    it('指標が有意水準を満たさない', async () => {
      const fake = fakeSession({ onChange: setValue('5') });
      // 5回すべて改善してもp=1/32なので、0.01では満たさない
      const result = await run(fake, {}, { significanceLevel: 0.01 });
      expect(result.outcome).toBe('rejected');
      expect(result.record.decision.reason).toContain('有意水準');
    });

    it('指標が悪化した試行は不採用になる', async () => {
      const fake = fakeSession({ onChange: setValue('20') });
      const result = await run(fake);
      expect(result.outcome).toBe('rejected');
    });
  });

  it('他のタスクがrefを足したり変えたりしても、試行は不採用にならない', async () => {
    const fake = fakeSession({
      onChange: async (input) => {
        await setValue('5')(input);
        git(input.cwd, 'update-ref', 'refs/heads/other-task', bestCommit);
        git(input.cwd, 'update-ref', 'refs/optimize/other-run/best', bestCommit);
        git(input.cwd, 'update-ref', 'refs/remotes/origin/main', bestCommit);
      },
    });
    const result = await run(fake);
    expect(result.outcome).toBe('adopted');
    expect(result.violations).toEqual([]);
  });

  describe('1段目（仮説）', () => {
    it('プロセスが作業ツリーを変えたら、試行は無効になり2段目は起動しない', async () => {
      const fake = fakeSession({
        onHypothesis: async (input) => {
          await writeFile(join(input.cwd, 'src', 'value.txt'), '1');
        },
        onChange: setValue('5'),
      });
      const result = await run(fake);
      expect(result.outcome).toBe('invalid');
      expect(fake.calls.map((c) => c.stage)).toEqual(['hypothesis']);
      const rows = await new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID);
      expect(rows[0]?.decision.outcome).toBe('invalid');
    });

    it('JSONの仮説を返さなければ無効になる', async () => {
      const fake = fakeSession({ hypothesisText: '直します', onChange: setValue('5') });
      const result = await run(fake);
      expect(result.outcome).toBe('invalid');
      expect(fake.calls).toHaveLength(1);
    });
  });

  it('変更の段のプロセスグループが残ったら無効になり、ループを止める', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(fake, {
      deps: {
        runStage: async (input) => {
          const r = await fake.runStage(input);
          return input.stage === 'change'
            ? { ...r, ok: false, process: proc({ groupRemains: true }) }
            : r;
        },
      },
    });
    expect(result.outcome).toBe('invalid');
    expect(result.halt).toBe(true);
  });

  it('正しさの確認が時間切れになったら、不採用で計測しない', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(
      fake,
      { timeouts: { commandMs: 300 } },
      { correctnessCommand: 'sleep 30' },
    );
    expect(result.outcome).toBe('rejected');
    expect(result.adoptionCandidate).toBe(false);
    expect(result.record.correctness.passed).toBe(false);
    expect(result.record.metric.samples).toBe(0);
  });

  it('計測のコマンドが時間切れになったら、不採用になる', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(
      fake,
      { timeouts: { perRunMs: 300 } },
      { metricCommand: 'sleep 30', metricSource: 'wallTime' },
    );
    expect(result.outcome).toBe('rejected');
    expect(result.adoptionCandidate).toBe(false);
  });

  it('変更の段が時間切れで止まったら、途中の木を計測せず無効になる', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(fake, {
      deps: {
        runStage: async (input) => {
          const r = await fake.runStage(input);
          return input.stage === 'change'
            ? {
                ...r,
                ok: false,
                failure: '時間の上限を超えて止めました',
                process: proc({ timedOut: true }),
              }
            : r;
        },
      },
    });
    expect(result.outcome).toBe('invalid');
    expect(result.adoptionCandidate).toBe(false);
    expect(result.record.metric.samples).toBe(0);
  });

  it('Claudeの起動には基準・最良のworktreeを書き込み禁止として渡す（共有の.gitはrunTrialStageが塞ぐ）', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    await run(fake);
    const deny = fake.calls[1]?.engine.claudeDenyWrite ?? [];
    expect(deny).toContain(dirs.baseline);
    expect(deny).toContain(dirs.best);
    expect(deny).not.toContain(dirs.candidate);
  });

  it('試行中に例外が起きても、台帳に無効の1行を残す（セッション起動後はループを止める）', async () => {
    const fake = fakeSession({ onChange: setValue('5') });
    const result = await run(fake, {
      deps: {
        runStage: async (input) => {
          if (input.stage === 'change') {
            throw new Error('起動に失敗');
          }
          return fake.runStage(input);
        },
      },
    });
    expect(result.outcome).toBe('invalid');
    expect(result.halt).toBe(true);
    const rows = await new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision.reason).toContain('起動に失敗');
  });

  it('準備の前に例外が起きたときは、ループを止めずに無効の1行を残す', async () => {
    const fake = fakeSession({});
    const result = await run(fake, {}, { setupCommand: 'exit 1' });
    expect(result.outcome).toBe('invalid');
    expect(result.halt).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(await new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID)).toHaveLength(1);
  });

  it('中断された試行は台帳に書かない', async () => {
    const controller = new AbortController();
    const fake = fakeSession({
      onChange: async (input) => {
        await setValue('5')(input);
        controller.abort();
      },
    });
    const result = await run(fake, { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(await new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID)).toHaveLength(0);
  });

  it('2回目の試行は、前回の台帳を指示に入れ、最良のcommitから始める', async () => {
    const first = fakeSession({ onChange: setValue('5') });
    const r1 = await run(first);
    expect(r1.outcome).toBe('adopted');
    const second = fakeSession({ onChange: setValue('5') });
    await run(second, { trial: 2, bestCommit: r1.commit ?? bestCommit });
    const prompt = second.calls[0]?.prompt ?? '';
    expect(prompt).toContain(HYPOTHESIS.hypothesis);
    expect(prompt).toContain('台帳の要約');
    expect(await readFile(join(dirs.candidate, 'src', 'value.txt'), 'utf8')).toBe('5');
  });
});
