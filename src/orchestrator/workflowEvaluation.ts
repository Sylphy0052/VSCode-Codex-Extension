import type { WorkflowDefinition } from './workflow';

/** 同じ代表ゴールでプロンプト変更前後を比較するための決定的な品質指標（Issue #849）。 */
export interface WorkflowQualityMetrics {
  taskCount: number;
  acceptanceCoveragePercent: number;
  evidenceRatePercent: number;
  verifiableDoneRatePercent: number;
  overFragmentedTaskCount: number;
}

const percent = (matched: number, total: number): number =>
  total === 0 ? 0 : Math.round((matched / total) * 100);

/**
 * LLMの自己採点を使わず、生成された定義だけから比較可能な代理指標を計算する。
 * `overFragmentedTaskCount`は、独立した成果と成果物のどちらも持たないタスク数を数える。
 */
export function evaluateWorkflowQuality(def: WorkflowDefinition): WorkflowQualityMetrics {
  const tasks = def.tasks;
  const evidenceCount = tasks.filter((task) => (task.evidence?.length ?? 0) > 0).length;
  const verifiableCount = tasks.filter((task) => {
    const verify = task.verify;
    return (
      task.done.trim() !== '' &&
      verify !== undefined &&
      (verify.semantic ||
        verify.commands.length > 0 ||
        verify.files.length > 0 ||
        verify.diff.length > 0)
    );
  }).length;
  const outcomeCount = tasks.filter(
    (task) => task.outcome?.trim() !== '' && (task.outputs?.length ?? 0) > 0,
  ).length;
  const overFragmentedTaskCount = tasks.filter(
    (task) => !task.outcome?.trim() && (task.outputs?.length ?? 0) === 0,
  ).length;
  return {
    taskCount: tasks.length,
    acceptanceCoveragePercent:
      (def.acceptance?.length ?? 0) === 0 ? 0 : percent(outcomeCount, tasks.length),
    evidenceRatePercent: percent(evidenceCount, tasks.length),
    verifiableDoneRatePercent: percent(verifiableCount, tasks.length),
    overFragmentedTaskCount,
  };
}

export interface WorkflowQualityComparison {
  before: WorkflowQualityMetrics;
  after: WorkflowQualityMetrics;
  delta: {
    acceptanceCoveragePercent: number;
    evidenceRatePercent: number;
    verifiableDoneRatePercent: number;
    overFragmentedTaskCount: number;
  };
}

/** 変更前後を同じ計算条件で比較する。正の率は改善、過剰分割数は負の値が改善。 */
export function compareWorkflowQuality(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): WorkflowQualityComparison {
  const beforeMetrics = evaluateWorkflowQuality(before);
  const afterMetrics = evaluateWorkflowQuality(after);
  return {
    before: beforeMetrics,
    after: afterMetrics,
    delta: {
      acceptanceCoveragePercent:
        afterMetrics.acceptanceCoveragePercent - beforeMetrics.acceptanceCoveragePercent,
      evidenceRatePercent: afterMetrics.evidenceRatePercent - beforeMetrics.evidenceRatePercent,
      verifiableDoneRatePercent:
        afterMetrics.verifiableDoneRatePercent - beforeMetrics.verifiableDoneRatePercent,
      overFragmentedTaskCount:
        afterMetrics.overFragmentedTaskCount - beforeMetrics.overFragmentedTaskCount,
    },
  };
}
