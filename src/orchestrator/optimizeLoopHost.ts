import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { HeadlessSlotLock } from '../loop/headlessSlotLock';
import { runVerifyCommand } from '../verification/commandRunner';
import { compareTrees, judgeAfterReview, judgePreMerge } from './optimizeCompare';
import {
  OPTIMIZE_LEDGER_DIR_NAME,
  OptimizeLedgerStore,
  summarizeTrials,
  type OptimizeSummary,
} from './optimizeLedger';
import {
  consumeMergeAllowance,
  decidePreMerge,
  initialLoopState,
  prepareLoopResume,
  runOptimizeLoop,
  sameTree,
  type BaselineResult,
  type OptimizeLoopLimits,
  type OptimizeLoopOutcome,
  type OptimizeLoopState,
} from './optimizeLoop';
import {
  measureAlternating,
  median,
  withMeasureLock,
  createCommandMeasure,
} from './optimizeMeasure';
import {
  defaultProcessRecordPorts,
  killRecordedProcesses,
  removeProcessRecord,
  writeProcessRecord,
  type ProcessRecordPorts,
} from './optimizeProcessRecord';
import type { OptimizationSpec } from './optimizeSpec';
import {
  DEFAULT_TRIAL_COMMAND_TIMEOUT_MS,
  DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS,
  DEFAULT_TRIAL_TOTAL_TIMEOUT_MS,
  runOptimizeTrial,
} from './optimizeTrial';
import { summarizeLedgerForPrompt } from './optimizeTrialPrompt';
import type { TrialEngineConfig } from './optimizeTrialSession';
import {
  MEASURE_TREE_ROLES,
  optimizeRef,
  prepareMeasureWorktree,
  prepareMeasureWorktrees,
  runGit,
  type GitRunner,
  type MeasureTreeRole,
} from './optimizeWorktrees';
import type { OptimizeGateReason, OrchestratedTask, TaskRun, TaskRunEngine } from './taskRunState';
import { formatUntrusted } from './untrustedText';

/**
 * 最適化のループ（Issue #2111）を実際のgit・プロセス・CLIへつなぐ。判定は`optimizeLoop.ts`、
 * 2つの木の比較は`optimizeCompare.ts`。工程の状態の更新と関門は呼び出し側（`TaskStageRunner`）が行う。
 *
 * 1つのrunに最適化のタスクが複数あってもrefとworktreeがぶつからないよう、refと台帳のIDには
 * `<runId>-<taskId>`を使う（`refs/optimize/<runId>-<taskId>/best`）。
 */

export interface OptimizeCliResult {
  code: number;
  stdout: string;
  stderr?: string;
}

export interface OptimizeLoopHostDeps {
  /** 拡張のglobalStorage。台帳・計測用のworktree・プロセスの記録はこの下に置く。 */
  storageDir: string;
  cli: { run(command: string, args: readonly string[], cwd: string): Promise<OptimizeCliResult> };
  git?: GitRunner;
  /** 試行のセッションの設定。Claudeならsandboxを確かめた結果を入れる。 */
  trialEngine(
    engine: TaskRunEngine,
    settings: { model: string; effort: string | undefined },
  ): Promise<TrialEngineConfig>;
  limits(): OptimizeLoopLimits;
  usageThresholdPct(): number | undefined;
  weeklyUsagePct(engine: TaskRunEngine): Promise<number | undefined>;
  lock?: Pick<HeadlessSlotLock, 'tryAcquire'>;
  processPorts?: ProcessRecordPorts;
  runVerify?: typeof runVerifyCommand;
  runTrial?: typeof runOptimizeTrial;
  now?: () => Date;
  log(message: string): void;
}

export interface RunLoopArgs {
  run: TaskRun;
  task: OrchestratedTask;
  /** タスクのworktree（基準の木はこのHEAD）。 */
  worktreePath: string;
  model: string;
  effort: string | undefined;
  signal: AbortSignal;
  isPauseRequested(): boolean;
  saveState(state: OptimizeLoopState, summary: OptimizeSummary): Promise<void>;
}

export interface MergeCheckArgs {
  run: TaskRun;
  task: OrchestratedTask;
  pullRequestNumber: number;
  command: string;
  saveState(state: OptimizeLoopState): Promise<void>;
  openGate(reason: OptimizeGateReason, detail: string): Promise<void>;
}

/** refと台帳に使うID。runの中の最適化のタスクごとに分ける。 */
export function optimizeLoopId(runId: string, taskId: string): string {
  return `${runId}-${taskId}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class OptimizeLoopHost {
  private readonly git: GitRunner;
  private readonly runVerify: typeof runVerifyCommand;
  private readonly ledger: OptimizeLedgerStore;
  /** merge直前の計測中のタスク（`<runId>/<taskId>`）。同じタスクで2本走らせない。 */
  private readonly measuring = new Set<string>();

  constructor(private readonly deps: OptimizeLoopHostDeps) {
    this.git = deps.git ?? runGit;
    this.runVerify = deps.runVerify ?? runVerifyCommand;
    this.ledger = new OptimizeLedgerStore(deps.storageDir);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** 計測用のworktreeとプロセスの記録の置き場。どちらもworktreeの外（globalStorage）。 */
  paths(runId: string, taskId: string): { worktreeRoot: string; processRecordDir: string } {
    const base = path.join(
      this.deps.storageDir,
      OPTIMIZE_LEDGER_DIR_NAME,
      optimizeLoopId(runId, taskId),
    );
    return { worktreeRoot: path.join(base, 'trees'), processRecordDir: path.join(base, 'proc') };
  }

  private setupRunner(spec: OptimizationSpec, signal: AbortSignal | undefined) {
    return async (dir: string): Promise<void> => {
      if (spec.setupCommand === undefined) {
        return;
      }
      const result = await this.runVerify({
        command: spec.setupCommand,
        cwd: dir,
        timeoutMs: DEFAULT_TRIAL_COMMAND_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `準備のコマンドが失敗しました: ${result.error ?? result.output.slice(-300)}`,
        );
      }
    };
  }

  /** ループを回す（初回・再開とも）。 */
  async runLoop(args: RunLoopArgs): Promise<OptimizeLoopOutcome> {
    const { run, task } = args;
    const spec = task.optimization;
    if (spec === undefined) {
      throw new Error('最適化の仕様が無いタスクではループを回さない');
    }
    const loopId = optimizeLoopId(run.runId, task.taskId);
    const { worktreeRoot, processRecordDir } = this.paths(run.runId, task.taskId);
    const head = (await this.git(args.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const runSetup = this.setupRunner(spec, args.signal);
    let dirs: Record<MeasureTreeRole, string> | undefined;
    const prepareAll = async (
      baseline: string,
      best: string,
    ): Promise<Record<MeasureTreeRole, string>> => {
      dirs = await prepareMeasureWorktrees({
        repoDir: run.workspaceRoot,
        root: worktreeRoot,
        commits: { baseline, best, candidate: best },
        allowedPaths: spec.allowedPaths,
        runSetup,
        git: this.git,
      });
      return dirs;
    };

    let state = task.optimizeLoop ?? initialLoopState();
    const started =
      state.trials > 0 || state.inFlightTrial !== undefined || state.baseline !== undefined;
    if (started) {
      const report = await prepareLoopResume(state, {
        now: () => this.now(),
        killRecordedProcesses: async () => {
          const r = await killRecordedProcesses(
            processRecordDir,
            this.deps.processPorts ?? defaultProcessRecordPorts(),
          );
          return { killed: r.killed.length, discarded: r.discarded.length };
        },
        readBestRef: async () => {
          try {
            return (
              await this.git(run.workspaceRoot, [
                'rev-parse',
                '--verify',
                '--quiet',
                optimizeRef(loopId, 'best'),
              ])
            ).trim();
          } catch {
            return undefined;
          }
        },
        restoreTrees: async (bestCommit) => {
          await prepareAll(state.baseline?.commit ?? head, bestCommit);
        },
        readLedger: () => this.ledger.read(loopId, task.taskId),
        appendLedger: (record) => this.ledger.append(loopId, task.taskId, record),
      });
      state = report.state;
      this.deps.log(
        `[optimize] ${task.taskId}: 再開。止めたプロセス ${report.killed}件、試行 ${state.trials}回から続ける` +
          (report.interruptedTrial === undefined
            ? ''
            : `（試行 #${report.interruptedTrial} は中断と記録）`),
      );
    }

    const engine = await this.deps.trialEngine(run.engine, {
      model: args.model,
      effort: args.effort,
    });
    const summary = async (s: OptimizeLoopState): Promise<OptimizeSummary> =>
      summarizeTrials(
        await this.ledger.read(loopId, task.taskId),
        spec.direction,
        s.baseline?.metric,
      );

    return runOptimizeLoop({
      spec,
      limits: this.deps.limits(),
      usageThresholdPct: this.deps.usageThresholdPct(),
      state,
      signal: args.signal,
      ports: {
        now: () => this.now(),
        measureBaseline: (signal) =>
          this.measureBaseline({ run, spec, head, processRecordDir, loopId, prepareAll, signal }),
        runTrial: async (trialArgs) => {
          const trees =
            dirs ?? (await prepareAll(state.baseline?.commit ?? head, trialArgs.bestCommit));
          return (this.deps.runTrial ?? runOptimizeTrial)({
            runId: loopId,
            taskId: task.taskId,
            trial: trialArgs.trial,
            repoDir: run.workspaceRoot,
            spec,
            objective: [task.title, task.summary].filter((t) => t.trim() !== '').join('\n'),
            dirs: trees,
            bestCommit: trialArgs.bestCommit,
            baselineMetric: trialArgs.baselineMetric,
            ledger: this.ledger,
            engine: { ...engine, claudeDenyWrite: [trees.baseline, trees.best] },
            processRecordDir,
            ...(this.deps.lock === undefined ? {} : { lock: this.deps.lock }),
            signal: trialArgs.signal,
            rebuild: trialArgs.rebuild,
          });
        },
        promoteBest: async (commit) => {
          const ref = optimizeRef(loopId, 'best');
          await this.git(run.workspaceRoot, ['update-ref', ref, commit]);
          if (dirs !== undefined) {
            await prepareMeasureWorktree({
              repoDir: run.workspaceRoot,
              worktreeDir: dirs.best,
              commit,
              allowedPaths: spec.allowedPaths,
              runSetup,
              git: this.git,
            });
          }
          return ref;
        },
        readUsagePct: () => this.deps.weeklyUsagePct(run.engine),
        saveState: async (s) => {
          state = s;
          await args.saveState(s, await summary(s));
        },
        isPauseRequested: args.isPauseRequested,
      },
    });
  }

  private async measureBaseline(input: {
    run: TaskRun;
    spec: OptimizationSpec;
    head: string;
    processRecordDir: string;
    loopId: string;
    prepareAll(baseline: string, best: string): Promise<Record<MeasureTreeRole, string>>;
    signal: AbortSignal;
  }): Promise<BaselineResult> {
    const { spec } = input;
    let dirs: Record<MeasureTreeRole, string>;
    try {
      dirs = await input.prepareAll(input.head, input.head);
    } catch (e) {
      return { ok: false, step: 'setup', detail: errorMessage(e) };
    }
    const spawned = new Set<number>();
    const track = (pid: number, label: string): void => {
      spawned.add(pid);
      void writeProcessRecord(input.processRecordDir, { pid, label }).catch(() => undefined);
    };
    const measure = async (): Promise<BaselineResult> => {
      const verified = await this.runVerify({
        command: spec.correctnessCommand,
        cwd: dirs.baseline,
        timeoutMs: DEFAULT_TRIAL_COMMAND_TIMEOUT_MS,
        signal: input.signal,
        onSpawn: (pid) => track(pid, 'optimize-baseline:correctness'),
      });
      if (verified.exitCode !== 0) {
        return {
          ok: false,
          step: 'correctness',
          detail: verified.error ?? verified.output.slice(-1000),
        };
      }
      const measured = await measureAlternating({
        measure: createCommandMeasure({
          metricSource: spec.metricSource,
          command: spec.metricCommand,
          ...(spec.metricFile === undefined ? {} : { metricFile: spec.metricFile }),
          cwdFor: () => dirs.baseline,
          onSpawn: (pid) => track(pid, 'optimize-baseline:metric'),
        }),
        runs: Math.ceil(spec.measurementRuns / 2),
        perRunTimeoutMs: DEFAULT_TRIAL_PER_RUN_TIMEOUT_MS,
        totalTimeoutMs: DEFAULT_TRIAL_TOTAL_TIMEOUT_MS,
      });
      const values = [...measured.aValues, ...measured.bValues];
      if (measured.failed || values.length === 0) {
        return {
          ok: false,
          step: 'metric',
          detail: measured.failedReason ?? '値を得られませんでした',
        };
      }
      return { ok: true, metric: median(values), commit: input.head };
    };
    try {
      const result =
        this.deps.lock === undefined
          ? await measure()
          : await withMeasureLock(this.deps.lock, measure);
      if (result.ok) {
        await this.git(input.run.workspaceRoot, [
          'update-ref',
          optimizeRef(input.loopId, 'baseline'),
          input.head,
        ]);
        await this.git(input.run.workspaceRoot, [
          'update-ref',
          optimizeRef(input.loopId, 'best'),
          input.head,
        ]);
      }
      return result;
    } catch (e) {
      return { ok: false, step: 'metric', detail: errorMessage(e) };
    } finally {
      for (const pid of spawned) {
        await removeProcessRecord(input.processRecordDir, pid).catch(() => undefined);
      }
    }
  }

  /** 作業ツリー（とindex）を`commit`の木にする。HEADとブランチは動かさない。 */
  async restoreWorkTree(worktreePath: string, commit: string): Promise<void> {
    await this.git(worktreePath, [
      'restore',
      `--source=${commit}`,
      '--staged',
      '--worktree',
      '--',
      '.',
    ]);
  }

  /** PRを書くセッションへ渡す台帳の要約。LLMが書いた欄を含むので外部由来として囲む。 */
  async ledgerSummaryForPrompt(run: TaskRun, task: OrchestratedTask): Promise<string> {
    const records = await this.ledger.read(optimizeLoopId(run.runId, task.taskId), task.taskId);
    const loop = task.optimizeLoop;
    return [
      '## 最適化の結果（拡張機能から）',
      '作業ツリーは最適化のループが選んだ最良の候補の木にしてある。この木をそのままcommit・pushし、PRを作る。コードは変えない。',
      loop?.baseline === undefined ? '' : `基準値: ${loop.baseline.metric}`,
      loop?.best === undefined
        ? '最良: 基準より良い候補は無かった'
        : `最良: ${loop.best.metric}（試行 #${loop.best.trial}）`,
      '',
      formatUntrusted(summarizeLedgerForPrompt(records), {
        id: 'optimize-ledger',
        field: 'text',
        maxLength: 8_000,
        preserveNewlines: true,
        notice: '最適化の台帳の要約（試行のセッションが書いた仮説・方式を含む）',
      }),
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n');
  }

  private async headOid(
    root: string,
    pullRequestNumber: number,
  ): Promise<{ head: string; base: string }> {
    const view = await this.deps.cli.run(
      'gh',
      ['pr', 'view', String(pullRequestNumber), '--json', 'headRefOid,baseRefName'],
      root,
    );
    if (view.code !== 0) {
      throw new Error(`PR #${pullRequestNumber}のHEADを取得できませんでした`);
    }
    const parsed = JSON.parse(view.stdout) as { headRefOid?: unknown; baseRefName?: unknown };
    if (typeof parsed.headRefOid !== 'string' || !/^[0-9a-f]{40,64}$/i.test(parsed.headRefOid)) {
      throw new Error(`PR #${pullRequestNumber}のHEADを解釈できませんでした`);
    }
    const base =
      typeof parsed.baseRefName === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(parsed.baseRefName)
        ? parsed.baseRefName
        : 'main';
    return { head: parsed.headRefOid.toLowerCase(), base };
  }

  /** PRのHEADの木が最良の候補の木と一致するか（Issue #2111 仕様6）。 */
  async checkPullRequestTree(
    run: TaskRun,
    task: OrchestratedTask,
    pullRequestNumber: number,
  ): Promise<{ match: boolean; detail: string }> {
    const best = task.optimizeLoop?.best?.commit ?? task.optimizeLoop?.baseline?.commit;
    if (best === undefined) {
      return { match: false, detail: '最良の候補の記録が無い' };
    }
    const cwd = task.worktreePath ?? run.workspaceRoot;
    const { head } = await this.headOid(run.workspaceRoot, pullRequestNumber);
    const match = await sameTree(
      async (c) => this.git(cwd, ['rev-parse', `${c}^{tree}`]),
      head,
      best,
    );
    return {
      match,
      detail: match
        ? 'PRのHEADの木は最良の候補と一致した'
        : `PRのHEAD（${head}）の木が最良の候補（${best}）の木と一致しない`,
    };
  }

  /**
   * review後の測り直し（Issue #2111 仕様7）。HEADの木が前に測った木・最良の木と同じなら測らない。
   * 測ったら、測った木を状態に残す。
   */
  async remeasureAfterReview(
    run: TaskRun,
    task: OrchestratedTask,
  ): Promise<{ worsened: boolean; detail: string; measuredTree?: string }> {
    const spec = task.optimization;
    const best = task.optimizeLoop?.best?.commit ?? task.optimizeLoop?.baseline?.commit;
    const cwd = task.worktreePath;
    if (spec === undefined || best === undefined || cwd === undefined) {
      return { worsened: false, detail: '測り直す対象が無い' };
    }
    const head = (await this.git(cwd, ['rev-parse', 'HEAD'])).trim();
    const tree = (await this.git(cwd, ['rev-parse', 'HEAD^{tree}'])).trim();
    const bestTree = (await this.git(cwd, ['rev-parse', `${best}^{tree}`])).trim();
    if (tree === bestTree || tree === task.optimizeLoop?.measuredTree) {
      return { worsened: false, detail: 'コードは最良の木から変わっていない', measuredTree: tree };
    }
    const { worktreeRoot, processRecordDir } = this.paths(run.runId, task.taskId);
    const result = await compareTrees({
      repoDir: run.workspaceRoot,
      spec,
      aCommit: best,
      bCommit: head,
      aDir: path.join(worktreeRoot, 'best'),
      bDir: path.join(worktreeRoot, 'candidate'),
      processRecordDir,
      ...(this.deps.lock === undefined ? {} : { lock: this.deps.lock }),
      deps: { git: this.git, runVerify: this.runVerify },
    });
    const judged = judgeAfterReview(spec, result);
    return { worsened: judged.flagged, detail: judged.detail, measuredTree: tree };
  }

  /**
   * merge命令の検査（Issue #2111 仕様8）。拒否の理由か、許すなら`undefined`。計測が要るときは
   * 背景で始めてすぐ拒否する（承認の応答を待たせない）。
   */
  async checkMerge(args: MergeCheckArgs): Promise<string | undefined> {
    const { run, task } = args;
    const spec = task.optimization;
    if (spec === undefined) {
      return undefined;
    }
    const { head, base } = await this.headOid(run.workspaceRoot, args.pullRequestNumber);
    const state = task.optimizeLoop ?? initialLoopState();
    const decision = decidePreMerge({ state, command: args.command, headOid: head });
    if (decision.kind === 'allow') {
      if (decision.consumeAllowance) {
        await args.saveState(consumeMergeAllowance(state));
      }
      return undefined;
    }
    const key = `${run.runId}/${task.taskId}`;
    // 保存された「計測中」をこのホストが走らせていなければ、Reloadや保存の失敗で計測が途切れている。
    // 始め直さないと、同じHEADのmerge命令を「計測中」で拒否し続ける
    const orphaned =
      state.preMerge?.status === 'measuring' &&
      state.preMerge.commit.toLowerCase() === head &&
      !this.measuring.has(key);
    if ((decision.startMeasure || orphaned) && !this.measuring.has(key)) {
      this.measuring.add(key);
      const measuring: OptimizeLoopState = {
        ...state,
        preMerge: { commit: head, status: 'measuring', detail: '計測中' },
      };
      try {
        await args.saveState(measuring);
      } catch (e) {
        this.measuring.delete(key);
        throw e;
      }
      void this.measurePreMerge({ run, task, spec, head, base, state: measuring, args })
        .catch((e: unknown) =>
          this.deps.log(`[optimize] merge直前の計測に失敗: ${errorMessage(e)}`),
        )
        .finally(() => this.measuring.delete(key));
    }
    return decision.reason;
  }

  private async measurePreMerge(input: {
    run: TaskRun;
    task: OrchestratedTask;
    spec: OptimizationSpec;
    head: string;
    base: string;
    state: OptimizeLoopState;
    args: MergeCheckArgs;
  }): Promise<void> {
    const { run, task, spec, head } = input;
    const { worktreeRoot, processRecordDir } = this.paths(run.runId, task.taskId);
    let judged: { flagged: boolean; detail: string };
    try {
      const fetched = await this.deps.cli.run(
        'git',
        ['fetch', 'origin', input.base],
        run.workspaceRoot,
      );
      if (fetched.code !== 0) {
        throw new Error(`origin/${input.base}を取得できませんでした`);
      }
      const main = (
        await this.git(run.workspaceRoot, ['rev-parse', `origin/${input.base}`])
      ).trim();
      const result = await compareTrees({
        repoDir: run.workspaceRoot,
        spec,
        aCommit: main,
        bCommit: head,
        aDir: path.join(worktreeRoot, 'baseline'),
        bDir: path.join(worktreeRoot, 'candidate'),
        processRecordDir,
        ...(this.deps.lock === undefined ? {} : { lock: this.deps.lock }),
        deps: { git: this.git, runVerify: this.runVerify },
      });
      judged = judgePreMerge(spec, result);
    } catch (e) {
      judged = { flagged: false, detail: `計測に失敗しました: ${errorMessage(e)}` };
    }
    await input.args.saveState({
      ...input.state,
      preMerge: {
        commit: head,
        status: judged.flagged ? 'passed' : 'failed',
        detail: judged.detail,
      },
    });
    if (!judged.flagged) {
      await input.args.openGate(
        'preMergeFailed',
        `merge直前の計測（${head}とmainの交互計測）で、mainより良いと言えなかった: ${judged.detail}`,
      );
    }
  }

  /**
   * merge・closeのときの後片付け（Issue #2111 仕様9）。`refs/optimize/<runId>-<taskId>/`と
   * 計測用のworktreeを消す。失敗は記録だけして続ける。
   */
  async cleanup(runId: string, taskId: string, repoDir: string): Promise<void> {
    const loopId = optimizeLoopId(runId, taskId);
    const { worktreeRoot } = this.paths(runId, taskId);
    try {
      const refs = (
        await this.git(repoDir, ['for-each-ref', '--format=%(refname)', `refs/optimize/${loopId}/`])
      )
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith(`refs/optimize/${loopId}/`));
      for (const ref of refs) {
        await this.git(repoDir, ['update-ref', '-d', ref]);
      }
    } catch (e) {
      this.deps.log(`[optimize] refを消せませんでした: ${errorMessage(e)}`);
    }
    for (const role of MEASURE_TREE_ROLES) {
      await this.git(repoDir, [
        'worktree',
        'remove',
        '--force',
        path.join(worktreeRoot, role),
      ]).catch(() => undefined);
    }
    await this.git(repoDir, ['worktree', 'prune']).catch(() => undefined);
    await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
