/**
 * 振り返り（`runRetrospective.ts`）の入力。run種別（task run・ワークフローのrun・通常チャットの会話）に
 * よらない形にし、振り返りをTaskRunから切り離す（Issue #2120）。
 *
 * - 指標は種別ごとに`<globalStorage>/run-metrics`へ`kind`付きで保存する。`kind`の無い既存の記録は
 *   `task`として読む（{@link normalizeRunKind}）
 * - 評価・改善案の比較は、同じ`kind`で、同じ群分けの鍵（{@link metricsGroupKey}）のrunだけで行う
 * - 自己改善のrunかの判定は種別ごとに持つ。taskはrunの名前の頭と子Issueのラベルで判定し、
 *   workflow・chatは自己改善のrunにならない
 * - ワークフロー・通常チャットの指標の計算は`src/orchestrator/retrospectiveMetrics/`へ置く。
 *   このファイル・`runMetrics.ts`・`runMetricsStore.ts`とともに保護パスに入っており、自己改善では変えない
 */

import type { RunMetricsKeys } from './runMetrics';
import { listTasks, type TaskRun, type TaskRunEngine } from './taskRunState';

export const RUN_KINDS = ['task', 'workflow', 'chat'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** 振り返る種別の既定値。task run以外は明示して足す。 */
export const DEFAULT_RETROSPECTIVE_SOURCES: readonly RunKind[] = ['task'];

interface RunSummaryBase {
  runId: string;
  workspaceRoot: string;
  /** そのrunで使ったengine。週次使用率は、どれか1つでも閾値を超えていれば止める。 */
  engines: readonly TaskRunEngine[];
  startedAt: string;
  finishedAt: string | undefined;
}

export interface TaskRunSummary extends RunSummaryBase {
  kind: 'task';
  title: string | undefined;
  /** 子Issue（起票済み・既存のIssueの両方）の番号。自己改善のrunかの判定に使う。 */
  issueNumbers: readonly number[];
}

export interface WorkflowRunSummary extends RunSummaryBase {
  kind: 'workflow';
}

export interface ChatRunSummary extends RunSummaryBase {
  kind: 'chat';
}

export type RunSummary = TaskRunSummary | WorkflowRunSummary | ChatRunSummary;

/** task runを振り返りの入力にする。 */
export function taskRunSummary(run: TaskRun): TaskRunSummary {
  const issueNumbers = new Set<number>();
  for (const t of listTasks(run)) {
    if (t.issueNumber !== undefined) {
      issueNumbers.add(t.issueNumber);
    }
    if (t.existingIssueNumber !== undefined) {
      issueNumbers.add(t.existingIssueNumber);
    }
  }
  return {
    kind: 'task',
    runId: run.runId,
    workspaceRoot: run.workspaceRoot,
    engines: [run.engine],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    title: run.title,
    issueNumbers: [...issueNumbers],
  };
}

export function isRunKind(value: unknown): value is RunKind {
  return typeof value === 'string' && (RUN_KINDS as readonly string[]).includes(value);
}

/** 保存された指標の`kind`。無ければ`task`（#2120より前の記録）、知らない値なら`undefined`。 */
export function normalizeRunKind(value: unknown): RunKind | undefined {
  if (value === undefined) {
    return 'task';
  }
  return isRunKind(value) ? value : undefined;
}

/**
 * 設定`agent.orchestrator.selfImprove.sources`の値を種別の一覧にする。配列でなければ既定値。
 * 知らない値は捨てる（空配列は「どれも振り返らない」として残す）。
 */
export function normalizeRetrospectiveSources(raw: unknown): readonly RunKind[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_RETROSPECTIVE_SOURCES;
  }
  return [...new Set(raw.filter(isRunKind))];
}

/**
 * 評価で比べてよいrunの群を表す鍵。種別を含めるので、種別の違うrunは同じ群にならない。
 * taskは工程プロンプトと上限値のハッシュで分ける。workflowはさらにpluginのハッシュでも分ける
 * （Issue #2122。ジョブごとのYAMLは鍵に入れない）。版とmerge時刻による絞り込みは評価の側で行う。
 */
export function metricsGroupKey(
  kind: RunKind,
  keys: Pick<RunMetricsKeys, 'promptHash' | 'limitsHash' | 'pluginHash'>,
): string {
  if (kind === 'workflow') {
    return JSON.stringify([kind, keys.promptHash, keys.limitsHash, keys.pluginHash ?? null]);
  }
  return JSON.stringify([kind, keys.promptHash, keys.limitsHash]);
}
