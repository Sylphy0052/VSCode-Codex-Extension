import type { RunMetrics, RunMetricsKeys, WorkflowRunTally } from '../runMetrics';
import {
  collectRunMetricsKeys,
  writeRunMetrics,
  type RunMetricsKeySources,
} from '../runMetricsStore';
import { MAX_RELOAD_RESUMES } from '../reloadResumePrompt';
import { MAX_TASK_VERIFICATION_ATTEMPTS } from '../runner';
import type { PersistedRun } from '../runStore';
import { DEFAULT_MAX_ITERATIONS } from '../workflow';
import type { WorkflowRunSummary } from '../runSummary';
import type { TaskRunEngine } from '../taskRunState';

/**
 * ワークフロー（YAML）のrunの指標（Issue #2122）。runが終わったときに拡張が計算して記録する。
 * LLMには書かせない。件数はノード数で割って比べる（`runRetrospective.ts`の`metricValue`）。
 */

/**
 * ワークフローの上限値（群分けの鍵）。拡張の定数と設定から決まるものだけを入れ、ジョブごとの
 * YAMLの値（`retries`・`maxParallel`など）は入れない。
 */
export function workflowRunLimits(maxAutoResumeAttempts: number): Record<string, number> {
  return {
    defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
    maxReloadResumes: MAX_RELOAD_RESUMES,
    maxTaskVerificationAttempts: MAX_TASK_VERIFICATION_ATTEMPTS,
    maxAutoResumeAttempts,
  };
}

/** ノードの件数を数える。純粋関数。 */
export function tallyWorkflowRun(run: Pick<PersistedRun, 'tasks'>): WorkflowRunTally {
  const tasks = Object.values(run.tasks);
  let failedNodes = 0;
  let retries = 0;
  let reloadResumes = 0;
  const durations: number[] = [];
  for (const t of tasks) {
    if (t.state === 'failed') {
      failedNodes += 1;
    }
    retries += t.retryCount + (t.manualRetryCount ?? 0);
    reloadResumes += t.reloadResumes ?? 0;
    const elapsed = nodeElapsedMs(t.startedAt, t.finishedAt);
    if (elapsed !== undefined) {
      durations.push(elapsed);
    }
  }
  return {
    nodes: tasks.length,
    failedNodes,
    retries,
    reloadResumes,
    msPerNode:
      durations.length === 0 ? undefined : durations.reduce((a, b) => a + b, 0) / durations.length,
  };
}

function nodeElapsedMs(
  startedAt: string | undefined,
  finishedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

/** 終わったワークフローのrunの指標。終わっていなければ`undefined`。純粋関数。 */
export function computeWorkflowRunMetrics(
  run: PersistedRun,
  keys: RunMetricsKeys,
): RunMetrics | undefined {
  if (run.finishedAt === undefined) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    kind: 'workflow',
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    // task用の件数。ワークフローには子Issueが無いので0にし、task用の指標では比べない
    childIssues: 0,
    sendBacks: 0,
    autoRetries: 0,
    maxReached: 0,
    questions: 0,
    optimizeTrials: 0,
    gatesResolved: { reflex: 0, orchestrator: 0, user: 0 },
    msPerChildIssue: undefined,
    workflow: tallyWorkflowRun(run),
    keys,
  };
}

/** ワークフローのrunを振り返りの入力にする。`engines`はrunのノードのprovider。 */
export function workflowRunSummary(
  run: PersistedRun,
  engines: readonly TaskRunEngine[],
): WorkflowRunSummary {
  return {
    kind: 'workflow',
    runId: run.runId,
    workspaceRoot: run.workspaceRoot,
    engines: [...new Set(engines)],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export interface WorkflowRunMetricsRecorderDeps extends Omit<
  RunMetricsKeySources,
  'limits' | 'kind'
> {
  dir: string;
  /** ワークフローの上限値。ジョブごとのYAMLの値は入れない（群分けの鍵にしないため）。 */
  limits(): Readonly<Record<string, number>>;
  /** runのノードのprovider。分からなければ空（週次使用率は不明として扱われる）。 */
  providers(runId: string): readonly TaskRunEngine[];
  log(message: string): void;
}

/**
 * ワークフローのrunが終わったときに呼ぶ記録器。指標を書き、振り返るべきなら振り返りの入力を返す。
 * 振り返りの単位はrunIdと終わった時点（`finishedAt`）の組（Issue #2129）。再開して終わり直した
 * runは新しい終わりとして振り返り直し、リロードをまたいで同じ終わりを再び通知されたrunは振り返らない。
 * 指標のファイルはrunIdごとに1つで、終わり直したrunは最新の終わりの値で置き換える（評価の母集団で
 * 同じrunを二重に数えない）。失敗してもrunの進行は止めず、ログへ残して`undefined`を返す。
 * 同じrunIdの記録は直列にする。
 */
export function createWorkflowRunMetricsRecorder(
  deps: WorkflowRunMetricsRecorderDeps,
): (run: PersistedRun) => Promise<WorkflowRunSummary | undefined> {
  const chains = new Map<string, Promise<unknown>>();
  return (run) => {
    const task = (chains.get(run.runId) ?? Promise.resolve()).then(async () => {
      try {
        const keys = await collectRunMetricsKeys({
          extensionVersion: deps.extensionVersion,
          claudeHome: deps.claudeHome,
          limits: deps.limits(),
          kind: 'workflow',
        });
        const metrics = computeWorkflowRunMetrics(run, keys);
        if (metrics === undefined) {
          return undefined;
        }
        // 同じ終わり（同じfinishedAt）が既に書かれていれば`skipped`になり、振り返らない
        // （Reloadをまたいだ再通知・別ウィンドウ）。終わり直したrunは置き換えて振り返り直す
        if ((await writeRunMetrics(deps.dir, metrics)) !== 'written') {
          return undefined;
        }
        return workflowRunSummary(run, deps.providers(run.runId));
      } catch (e) {
        deps.log(
          `[run metrics] ワークフローの指標を記録できませんでした（${run.runId}）: ${e instanceof Error ? e.message : String(e)}`,
        );
        return undefined;
      }
    });
    chains.set(run.runId, task);
    return task;
  };
}
