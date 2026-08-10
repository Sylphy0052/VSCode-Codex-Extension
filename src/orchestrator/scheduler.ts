import { isRunHalted, type RunState } from './runState';
import type { WorkflowDefinition } from './workflow';

/**
 * 依存を満たしたタスクを `maxParallel` の範囲で選ぶスケジューリングと、
 * 実行全体の終了判定（design.md §16.3）。
 *
 * VSCode APIには一切依存しない純粋なロジックのみを置く。並列の制御はここでしか
 * 起きないという形にしておくと、テストで全パターンを踏める（design.md §16.3）。
 */

/**
 * 次に開始するタスクidの集合を決める。
 *
 * - `dependsOn` の全てが `done` であること
 * - 自身が `pending` であること
 * - `running` と `waitingApproval` の合計が `maxParallel` 未満であること
 *   （`waitingApproval` も人待ちのセッションが生きているため枠を占める）
 * - 実行全体が停止している（`failed` の確定、または人の割り込み）ときは何も返さない
 * - 同じ段で複数開始できるとき、`def.tasks` に書かれた順で埋める（再現性のため）
 */
export function nextTasksToStart(def: WorkflowDefinition, run: RunState): ReadonlySet<string> {
  const result = new Set<string>();
  if (isRunHalted(run)) {
    return result;
  }

  let activeCount = 0;
  for (const s of run.tasks.values()) {
    if (s.state === 'running' || s.state === 'waitingApproval') {
      activeCount += 1;
    }
  }
  let capacity = def.maxParallel - activeCount;

  for (const task of def.tasks) {
    if (capacity <= 0) {
      break;
    }
    const state = run.tasks.get(task.id);
    if (state === undefined || state.state !== 'pending') {
      continue;
    }
    const depsAllDone = task.dependsOn.every((dep) => run.tasks.get(dep)?.state === 'done');
    if (!depsAllDone) {
      continue;
    }
    result.add(task.id);
    capacity -= 1;
  }
  return result;
}

export type RunOutcome = 'running' | 'succeeded' | 'failed';

/**
 * 実行全体の終了判定（design.md §16.5）。
 * `pending` / `running` / `waitingApproval` が1件でも残っていれば `running`。
 * 全て確定していれば、`failed` が1件でもあれば `failed`、なければ `succeeded`。
 */
export function getRunOutcome(run: RunState): RunOutcome {
  let anyFailed = false;
  for (const s of run.tasks.values()) {
    if (s.state === 'pending' || s.state === 'running' || s.state === 'waitingApproval') {
      return 'running';
    }
    if (s.state === 'failed') {
      anyFailed = true;
    }
  }
  return anyFailed ? 'failed' : 'succeeded';
}
