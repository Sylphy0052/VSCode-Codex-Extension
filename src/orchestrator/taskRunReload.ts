import { cancelOpenQuestions } from './taskRunQuestions';
import {
  completeMergedTask,
  currentStage,
  finishTaskRunIfDone,
  haltStage,
  listTasks,
  resetStageForRetry,
  setTaskRunHaltedByUser,
  type OrchestratedTask,
  type TaskAttention,
  type TaskRun,
} from './taskRunState';
import type { IssueState, PullRequestState } from './taskStageObservation';

/**
 * オーケストレータモード（Issue #1505）の再読み込み後の復元。工程セッションとOrchestratorは
 * 再読み込みで終わっているため、実行中だった工程を止め、再読み込みの間に外で変わった状態
 * （PRのmerge・close、worktreeの削除、Issueのclose）を反映する。外部の状態の取得は
 * Controllerが先に済ませ、ここは純粋関数で遷移だけを決める。
 */

/** 再読み込みで工程セッションが終わった工程へ残す理由。 */
export const RELOAD_HALT_REASON =
  '拡張機能の再読み込みで工程セッションが終わりました。「やり直す」で始め直せます';

/**
 * タスクごとに観測した外部の状態。記録が無い・取得に失敗したものは`undefined`。`undefined`と
 * `'unknown'`（forgeに問い合わせられなかった）では状態を変えない。
 */
export interface TaskExternalFacts {
  pullRequestState: PullRequestState | undefined;
  worktreeExists: boolean | undefined;
  issueState: IssueState | undefined;
}

type HaltAttention = Extract<TaskAttention, 'needsAction' | 'failed'>;

/**
 * 終わっていないrunを再読み込み後の状態にする。承認済みの計画は人が「再開」するまで止めておく。
 * タスクごとの規則:
 * - PRがmerge済み: 止め方に関係なく（人が止めたタスクも）残りの工程を完了にする
 * - 人が止めていたタスク: そのまま残す
 * - PRがmergeされずに閉じられた、記録したworktreeが無い、既存のIssueが閉じられた: 工程を止めて理由を残す
 * - 実行中だった工程: 再読み込みで止まった理由を残して止める
 */
export function reconcileTaskRunOnReload(
  run: TaskRun,
  facts: ReadonlyMap<string, TaskExternalFacts>,
  now: Date,
): TaskRun {
  if (run.finishedAt !== undefined) {
    return run;
  }
  let next = run.planStatus === 'approved' ? setTaskRunHaltedByUser(run, true) : run;
  for (const task of listTasks(run)) {
    const stage = currentStage(task);
    if (stage === undefined) {
      continue;
    }
    const status = task.stages[stage].status;
    const fact = facts.get(task.taskId);
    const merged = fact?.pullRequestState === 'merged';
    // 前回の再読み込みで止めた工程は人が止めたものとして扱わない
    const userStopped =
      status === 'halted' && task.attention === 'stopped' && task.failure !== RELOAD_HALT_REASON;
    const problem =
      merged || userStopped || fact === undefined ? undefined : findExternalProblem(task, fact);
    if (status === 'running' || merged || problem !== undefined) {
      next = cancelOpenQuestions(next, task.taskId, task.currentAttemptId ?? '', now);
    }
    if (merged) {
      next = completeMergedTask(next, task.taskId, now);
    } else if (problem !== undefined) {
      // 既に止まっている工程は理由を差し替える（haltStageは止まった工程を変えないため戻してから止める）
      next = haltStage(
        resetStageForRetry(next, task.taskId, now),
        task.taskId,
        problem.attention,
        problem.failure,
        now,
      );
    } else if (status === 'running') {
      next = haltStage(next, task.taskId, 'stopped', RELOAD_HALT_REASON, now);
    }
  }
  return finishTaskRunIfDone(next, now);
}

/** merge済みでない前提で、外部の状態が工程を続けられないものか。 */
function findExternalProblem(
  task: OrchestratedTask,
  fact: TaskExternalFacts,
): { attention: HaltAttention; failure: string } | undefined {
  if (task.pullRequest !== undefined && fact.pullRequestState === 'closed') {
    return {
      attention: 'needsAction',
      failure: `PR #${String(task.pullRequest.number)}がmergeされずに閉じられました`,
    };
  }
  if (task.worktreePath !== undefined && fact.worktreeExists === false) {
    return {
      attention: 'failed',
      failure: `worktree ${task.worktreePath} が見つかりません`,
    };
  }
  // PRを作った後のIssueのcloseはmergeに伴う正常な流れなので、PRの前だけを見る
  if (
    task.issueNumber !== undefined &&
    task.pullRequest === undefined &&
    fact.issueState === 'closed'
  ) {
    return {
      attention: 'needsAction',
      failure: `Issue #${String(task.issueNumber)}が閉じられています`,
    };
  }
  return undefined;
}
