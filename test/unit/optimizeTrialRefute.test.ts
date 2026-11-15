import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OptimizeLedgerStore } from '../../src/orchestrator/optimizeLedger';
import type { RefuteEvidence, RefuteOutcome, Refuter } from '../../src/orchestrator/optimizeRefute';
import type { OptimizationSpec } from '../../src/orchestrator/optimizeSpec';
import { runOptimizeTrial } from '../../src/orchestrator/optimizeTrial';
import type {
  RunTrialStageInput,
  TrialStageResult,
} from '../../src/orchestrator/optimizeTrialSession';
import { prepareMeasureWorktrees } from '../../src/orchestrator/optimizeWorktrees';

/**
 * 採用候補の反証（Issue #2108）。試行のセッションは決まった変更を返す偽物、計測は本物の
 * コマンドで回し、反証役だけを差し替える。
 */

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

describe('runOptimizeTrialの反証', () => {
  let root: string;
  let repo: string;
  let storage: string;
  let counters: { metric: string; correctness: string };
  let dirs: { baseline: string; best: string; candidate: string };
  let bestCommit: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'optimize-refute-test-'));
    repo = join(root, 'repo');
    storage = join(root, 'storage');
    counters = { metric: join(root, 'metric-count'), correctness: join(root, 'correctness-count') };
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'value.txt'), '10');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    bestCommit = git(repo, 'rev-parse', 'HEAD');
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

  const spec = (): OptimizationSpec => ({
    metricSource: 'file',
    metricCommand: `node -e "const fs=require('fs');fs.appendFileSync('${counters.metric}','x');fs.writeFileSync('m.json',JSON.stringify({value:Number(fs.readFileSync('src/value.txt','utf8'))}))"`,
    metricFile: 'm.json',
    direction: 'minimize',
    minImprovement: { kind: 'absolute', value: 1 },
    significanceLevel: 0.05,
    correctnessCommand: `node -e "require('fs').appendFileSync('${counters.correctness}','x')"`,
    allowedPaths: ['src'],
    budget: { maxTrials: 10, maxMinutes: 60 },
    measurementRuns: 5,
  });

  const count = async (file: string): Promise<number> =>
    (await readFile(file, 'utf8').catch(() => '')).length;

  /** 試行のセッションの偽物。仮説はJSON、変更の段は値を5へ書き換える。 */
  function fakeSession(): {
    calls: RunTrialStageInput[];
    runStage: (input: RunTrialStageInput) => Promise<TrialStageResult>;
  } {
    const calls: RunTrialStageInput[] = [];
    const proc = {
      pid: 1,
      stdout: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      groupRemains: false,
    };
    return {
      calls,
      runStage: async (input) => {
        calls.push(input);
        if (input.stage === 'hypothesis') {
          return { ok: true, text: JSON.stringify(HYPOTHESIS), sessionId: 's', process: proc };
        }
        await writeFile(join(input.cwd, 'src', 'value.txt'), '5');
        return { ok: true, text: '値を小さくした', process: proc };
      },
    };
  }

  /** 決まった順に判定を返す反証役。受け取った材料と選択肢を残す。 */
  function fakeRefuter(outcomes: RefuteOutcome[]): {
    calls: { evidence: RefuteEvidence; allowRemeasure: boolean }[];
    refute: Refuter;
  } {
    const calls: { evidence: RefuteEvidence; allowRemeasure: boolean }[] = [];
    return {
      calls,
      refute: async (evidence, options) => {
        calls.push({ evidence, allowRemeasure: options.allowRemeasure });
        const next = outcomes.shift();
        if (next === undefined) {
          throw new Error('想定より多く呼ばれた');
        }
        return next;
      },
    };
  }

  const run = (session: ReturnType<typeof fakeSession>, refute: Refuter | undefined) =>
    runOptimizeTrial({
      runId: RUN_ID,
      taskId: TASK_ID,
      trial: 1,
      repoDir: repo,
      spec: spec(),
      objective: '速くする',
      dirs,
      bestCommit,
      baselineMetric: 10,
      ledger: new OptimizeLedgerStore(storage),
      engine: {
        engine: 'claude',
        executable: 'claude',
        model: 'auto',
        claudeSandbox: { weakerNested: false },
      },
      processRecordDir: join(storage, 'processes'),
      deps: { runStage: session.runStage },
      ...(refute === undefined ? {} : { refute }),
    });

  const ledger = () => new OptimizeLedgerStore(storage).read(RUN_ID, TASK_ID);

  it('採用候補で反証役を1回起動し、仮説・差分・計測値・正しさの結果だけを渡す', async () => {
    const session = fakeSession();
    const r = fakeRefuter([{ verdict: 'holds', reason: '崩れない', engine: 'codex' }]);
    const result = await run(session, r.refute);
    expect(result.outcome).toBe('adopted');
    expect(result.adoptionCandidate).toBe(true);
    expect(r.calls).toHaveLength(1);
    const { evidence, allowRemeasure } = r.calls[0]!;
    expect(allowRemeasure).toBe(true);
    // 会話（セッションID）やツール・作業ディレクトリは渡らない
    expect(Object.keys(evidence).sort()).toEqual(
      [
        'baseline',
        'best',
        'candidate',
        'correctness',
        'diff',
        'direction',
        'llm',
        'minImprovement',
        'pValue',
        'secondary',
        'significanceLevel',
        'significant',
        'trial',
      ].sort(),
    );
    expect(JSON.stringify(evidence)).not.toContain('"s"');
    expect(evidence.llm.hypothesis).toBe('ループが遅い');
    expect(evidence.diff).toContain('-10');
    expect(evidence.diff).toContain('+5');
    expect(evidence.best.median).toBe(10);
    expect(evidence.candidate.median).toBe(5);
    expect(evidence.baseline).toBe(10);
    expect(evidence.correctness.passed).toBe(true);
    const rows = await ledger();
    expect(rows[0]?.refutation).toEqual({ verdict: 'holds', detail: '崩れない', engine: 'codex' });
  });

  it('反証できた候補は不採用になり、理由が台帳に残る', async () => {
    const r = fakeRefuter([
      { verdict: 'refuted', reason: '計測中だけ速い分岐がある', engine: 'codex' },
    ]);
    const result = await run(fakeSession(), r.refute);
    expect(result.outcome).toBe('rejected');
    expect(result.adoptionCandidate).toBe(false);
    const rows = await ledger();
    expect(rows[0]?.decision).toEqual({
      outcome: 'rejected',
      reason: '反証役が反証した: 計測中だけ速い分岐がある',
    });
    expect(rows[0]?.refutation?.verdict).toBe('refuted');
    expect(rows[0]?.refutation?.detail).toBe('計測中だけ速い分岐がある');
  });

  it('測り直しは計測の回数を2倍にして交互計測をやり直すだけで、試行のセッションも正しさの確認も繰り返さない', async () => {
    const session = fakeSession();
    const r = fakeRefuter([
      { verdict: 'remeasure', reason: 'ばらつきが大きい', engine: 'codex' },
      { verdict: 'holds', reason: '測り直しても崩れない', engine: 'codex' },
    ]);
    const result = await run(session, r.refute);
    expect(result.outcome).toBe('adopted');
    expect(session.calls.map((c) => c.stage)).toEqual(['hypothesis', 'change']);
    expect(await count(counters.correctness)).toBe(1);
    // 1回目は各木5回ずつ（10回）、測り直しは各木10回ずつ（20回）
    expect(await count(counters.metric)).toBe(30);
    expect(r.calls.map((c) => c.allowRemeasure)).toEqual([true, false]);
    expect(r.calls[1]?.evidence.candidate.samples).toBe(10);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metric.samples).toBe(10);
    expect(rows[0]?.refutation).toMatchObject({
      verdict: 'holds',
      remeasured: { fromRuns: 5, toRuns: 10 },
    });
  });

  it('判定できないときは採用しない（時間切れ・不正な出力）', async () => {
    const r = fakeRefuter([
      {
        verdict: 'inconclusive',
        reason: '反証役の判定を得られなかった（時間切れ）',
        engine: 'codex',
      },
    ]);
    const result = await run(fakeSession(), r.refute);
    expect(result.outcome).toBe('rejected');
    expect(result.adoptionCandidate).toBe(false);
    expect(result.record.refutation?.verdict).toBe('inconclusive');
    expect(result.record.decision.reason).toContain('判定できなかった');
  });

  it('測り直しの後も測り直しを求めたら、判定できないとして採用しない', async () => {
    const r = fakeRefuter([
      { verdict: 'remeasure', reason: 'a', engine: 'codex' },
      { verdict: 'remeasure', reason: 'b', engine: 'codex' },
    ]);
    const result = await run(fakeSession(), r.refute);
    expect(result.outcome).toBe('rejected');
    expect(result.record.refutation?.verdict).toBe('inconclusive');
  });

  it('切り替えたエンジンは台帳に残る', async () => {
    const r = fakeRefuter([
      {
        verdict: 'holds',
        reason: 'ok',
        engine: 'claude',
        fallback: 'CodexのCLIを起動できなかった',
      },
    ]);
    await run(fakeSession(), r.refute);
    const rows = await ledger();
    expect(rows[0]?.refutation?.fallback).toBe('CodexのCLIを起動できなかった');
    expect(rows[0]?.refutation?.engine).toBe('claude');
  });

  it('採用候補でない試行では反証役を起動しない', async () => {
    const session = fakeSession();
    session.runStage = async (input) => {
      session.calls.push(input);
      return input.stage === 'hypothesis'
        ? {
            ok: true,
            text: JSON.stringify(HYPOTHESIS),
            sessionId: 's',
            process: {
              pid: 1,
              stdout: '',
              exitCode: 0,
              timedOut: false,
              aborted: false,
              groupRemains: false,
            },
          }
        : {
            ok: true,
            text: '何もしない',
            process: {
              pid: 1,
              stdout: '',
              exitCode: 0,
              timedOut: false,
              aborted: false,
              groupRemains: false,
            },
          };
    };
    const r = fakeRefuter([]);
    const result = await run(session, r.refute);
    expect(result.outcome).toBe('rejected');
    expect(r.calls).toHaveLength(0);
  });
});
