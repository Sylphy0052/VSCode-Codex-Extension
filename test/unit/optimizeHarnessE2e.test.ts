import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OptimizeLoopHost,
  optimizeLoopId,
  type OptimizeCliResult,
} from '../../src/orchestrator/optimizeLoopHost';
import type { OptimizeLoopState } from '../../src/orchestrator/optimizeLoop';
import { OptimizeLedgerStore } from '../../src/orchestrator/optimizeLedger';
import { createRefuter } from '../../src/orchestrator/optimizeRefute';
import type { OptimizationSpec } from '../../src/orchestrator/optimizeSpec';
import { runOptimizeTrial } from '../../src/orchestrator/optimizeTrial';
import type {
  RunTrialStageInput,
  TrialStageResult,
} from '../../src/orchestrator/optimizeTrialSession';
import { makeRun, makeTask } from '../helpers/taskRunFixture';

/**
 * 最適化ハーネスの通しのテスト（Issue #2108）。gitと計測のコマンドは本物で、試行のセッション・
 * 反証役のCLI・ghだけを偽物にする。
 */

const FIXTURE = join(__dirname, 'fixtures', 'optimize-repo');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const FIB_MEMO = `'use strict';

let calls = 0;
const memo = new Map();

function fib(n) {
  calls += 1;
  if (n < 2) {
    return n;
  }
  if (memo.has(n)) {
    return memo.get(n);
  }
  const v = fib(n - 1) + fib(n - 2);
  memo.set(n, v);
  return v;
}

module.exports = {
  fib,
  getCalls: () => calls,
  resetCalls: () => {
    calls = 0;
    memo.clear();
  },
};
`;

const FIB_LOOP = `'use strict';

let calls = 0;

function fib(n) {
  calls += 1;
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    [a, b] = [b, a + b];
  }
  return a;
}

module.exports = {
  fib,
  getCalls: () => calls,
  resetCalls: () => {
    calls = 0;
  },
};
`;

const FAKE_BENCH = `'use strict';
require('fs').writeFileSync('m.json', JSON.stringify({ value: 0 }));
`;

const PROC = {
  pid: 1,
  stdout: '',
  exitCode: 0,
  timedOut: false,
  aborted: false,
  groupRemains: false,
};

describe('最適化ハーネスの通し', () => {
  let root: string;
  let repo: string;
  let storage: string;
  let ghComments: string[];
  let echoComments: boolean;
  let prHead: string;
  let refuterEngines: string[];
  let hypothesisCalls: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'optimize-e2e-'));
    repo = join(root, 'repo');
    storage = join(root, 'storage');
    const origin = join(root, 'origin.git');
    await cp(FIXTURE, repo, { recursive: true });
    git(root, 'init', '-q', '--bare', origin);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    ghComments = [];
    echoComments = false;
    prHead = '';
    refuterEngines = [];
    hypothesisCalls = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const spec: OptimizationSpec = {
    metricSource: 'file',
    metricCommand: 'node bench/bench.js',
    metricFile: 'm.json',
    direction: 'minimize',
    minImprovement: { kind: 'absolute', value: 1 },
    significanceLevel: 0.05,
    correctnessCommand: 'node test/test.js',
    allowedPaths: ['src'],
    budget: { maxTrials: 3, maxMinutes: 60 },
    measurementRuns: 5,
  };

  const runStage = async (input: RunTrialStageInput): Promise<TrialStageResult> => {
    if (input.stage === 'hypothesis') {
      hypothesisCalls += 1;
      return {
        ok: true,
        text: JSON.stringify({
          hypothesis: `仮説${hypothesisCalls}`,
          prediction: '呼び出しが減る',
          approach: '別の形にする',
        }),
        sessionId: 's',
        process: PROC,
      };
    }
    if (hypothesisCalls === 1) {
      await writeFile(join(input.cwd, 'src', 'fib.js'), FIB_MEMO);
    } else if (hypothesisCalls === 2) {
      await writeFile(join(input.cwd, 'bench', 'bench.js'), FAKE_BENCH);
    } else {
      await writeFile(join(input.cwd, 'src', 'fib.js'), FIB_LOOP);
    }
    return { ok: true, text: '変えた', process: PROC };
  };

  const fakeCli = {
    async run(command: string, args: readonly string[], cwd: string): Promise<OptimizeCliResult> {
      if (command === 'git') {
        try {
          const stdout = execFileSync('git', [...args], {
            cwd,
            encoding: 'utf8',
            env: GIT_ENV,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { code: 0, stdout, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
      }
      expect(command).toBe('gh');
      const joined = args.join(' ');
      if (joined === 'pr view 7 --json headRefOid,baseRefName') {
        return { code: 0, stdout: JSON.stringify({ headRefOid: prHead, baseRefName: 'main' }) };
      }
      if (joined === 'pr view 7 --json=comments') {
        const comments = echoComments ? ghComments.map((body) => ({ body })) : [];
        return { code: 0, stdout: JSON.stringify({ comments }) };
      }
      if (args[0] === 'pr' && args[1] === 'comment' && args[2] === '7') {
        const file = (args[3] ?? '').replace('--body-file=', '');
        ghComments.push(await readFile(file, 'utf8'));
        return { code: 0, stdout: '' };
      }
      return { code: 1, stdout: '', stderr: `想定外のgh: ${joined}` };
    },
  };

  const makeHost = (): OptimizeLoopHost =>
    new OptimizeLoopHost({
      storageDir: storage,
      cli: fakeCli,
      trialEngine: async () => ({
        engine: 'claude',
        executable: 'claude',
        model: 'auto',
        claudeSandbox: { weakerNested: false },
      }),
      limits: () => ({ maxTrials: 50, maxMinutes: 1440 }),
      usageThresholdPct: () => undefined,
      weeklyUsagePct: async () => undefined,
      log: () => undefined,
      runTrial: (input) => runOptimizeTrial({ ...input, deps: { runStage } }),
      refuter: () =>
        createRefuter({
          trialEngine: 'claude',
          setting: 'opposite',
          run: async (engine, prompt) => {
            refuterEngines.push(engine);
            const n = /試行 #(\d+)/.exec(prompt)?.[1];
            return n === '3'
              ? {
                  ok: true,
                  text: JSON.stringify({ verdict: 'refuted', reason: '計測用の抜け道がある' }),
                }
              : { ok: true, text: JSON.stringify({ verdict: 'holds', reason: '崩れない' }) };
          },
        }),
    });

  it('試行・反証・台帳・PRの木・台帳の投稿・merge直前の計測まで通る', async () => {
    const host = makeHost();
    const baseTask = makeTask('T1', 'implement', 'running', {
      optimization: spec,
      worktreePath: repo,
    });
    const run = { ...makeRun([baseTask]), workspaceRoot: repo };
    let state: OptimizeLoopState | undefined;

    const outcome = await host.runLoop({
      run,
      task: baseTask,
      worktreePath: repo,
      model: 'auto',
      effort: undefined,
      signal: new AbortController().signal,
      isPauseRequested: () => false,
      saveState: async (s) => {
        state = s;
      },
    });
    expect(outcome.kind).toBe('stopped');
    expect(outcome).toMatchObject({ reason: 'trialBudget' });
    expect(state?.baseline?.metric).toBe(21891);
    expect(state?.best?.trial).toBe(1);
    expect(state?.best?.metric).toBe(39);
    expect(refuterEngines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(refuterEngines)).toEqual(new Set(['codex']));

    const loopId = optimizeLoopId(run.runId, 'T1');
    const rows = await new OptimizeLedgerStore(storage).read(loopId, 'T1');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ trial: 1, decision: { outcome: 'adopted' } });
    expect(rows[0]?.refutation?.verdict).toBe('holds');
    expect(rows[1]).toMatchObject({ trial: 2, decision: { outcome: 'rejected' } });
    expect(rows[1]?.refutation).toBeUndefined();
    expect(rows[1]?.decision.reason).toContain('変更してよいパスの外');
    expect(rows[2]).toMatchObject({ trial: 3, decision: { outcome: 'rejected' } });
    expect(rows[2]?.refutation?.verdict).toBe('refuted');

    // 最良の木をPRのHEADにする
    const best = state!.best!;
    await host.restoreWorkTree(repo, best.commit);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'perf: メモ化する');
    prHead = git(repo, 'rev-parse', 'HEAD');
    const task = {
      ...baseTask,
      optimizeLoop: state!,
      pullRequest: { number: 7, url: 'https://github.com/o/r/pull/7' },
    };
    const run2 = { ...makeRun([task]), workspaceRoot: repo };
    const tree = await host.checkPullRequestTree(run2, task, 7);
    expect(tree.match).toBe(true);

    // 台帳の投稿
    const posted = await host.postLedgerComment(run2, task, task.pullRequest);
    expect(posted.posted).toBe(true);
    expect(ghComments).toHaveLength(1);
    expect(ghComments[0]).toContain('最適化の台帳');
    expect(ghComments[0]).toContain('LLMが書いた');
    for (const n of ['#1', '#2', '#3']) {
      expect(ghComments[0]).toContain(n);
    }
    echoComments = true;
    const again = await host.postLedgerComment(run2, task, task.pullRequest);
    expect(again.posted).toBe(false);
    expect(ghComments).toHaveLength(1);

    // merge直前の計測
    let saved: OptimizeLoopState | undefined;
    const mergeArgs = (t: typeof task) => ({
      run: run2,
      task: t,
      pullRequestNumber: 7,
      command: `gh pr merge 7 --merge --match-head-commit ${prHead}`,
      saveState: async (s: OptimizeLoopState) => {
        saved = s;
      },
      openGate: async () => undefined,
    });
    const first = await host.checkMerge(mergeArgs(task));
    expect(first).toContain('計測中');
    await vi.waitFor(() => expect(saved?.preMerge?.status).toBe('passed'), {
      timeout: 40_000,
      interval: 200,
    });
    const second = await host.checkMerge(mergeArgs({ ...task, optimizeLoop: saved! }));
    expect(second).toBeUndefined();
  }, 90_000);
});
