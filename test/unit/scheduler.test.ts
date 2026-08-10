import { describe, expect, it } from 'vitest';

import {
  applyLoopStopReason,
  createRunState,
  markRunning,
  markWaitingApproval,
  retryTask,
} from '../../src/orchestrator/runState';
import { getRunOutcome, nextTasksToStart } from '../../src/orchestrator/scheduler';
import type { WorkflowDefinition, WorkflowTask } from '../../src/orchestrator/workflow';

const task = (id: string, dependsOn: string[] = [], retries = 0): WorkflowTask => ({
  id,
  prompt: '作業する',
  done: '作業が終わっている',
  dependsOn,
  continuePrompt: '続けてください',
  maxIterations: 20,
  provider: 'codex',
  isolation: 'worktree',
  cwd: undefined,
  model: undefined,
  effort: undefined,
  approvalMode: undefined,
  sandbox: undefined,
  autoApprove: false,
  escalate: [],
  allow: [],
  retries,
  cleanup: 'keep',
  parseErrors: [],
  parseWarnings: [],
});

/** T1 -> (T2 || T3) -> T4。design.mdのサンプルと同じ形。 */
const diamondTasks = (): WorkflowTask[] => [
  task('T1', []),
  task('T2', ['T1']),
  task('T3', ['T1']),
  task('T4', ['T2', 'T3']),
];

const def = (tasks: WorkflowTask[], maxParallel: number): WorkflowDefinition => ({
  version: 1,
  name: 'テスト',
  maxParallel,
  tasks,
});

describe('nextTasksToStart', () => {
  it('T1完了後、maxParallelに余裕があればT2とT3が同時に返る', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');

    const next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T2', 'T3']));
  });

  it('maxParallel: 1のとき、T2だけが返り、T2完了後にT3が返る', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');

    let next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T2']));

    run = markRunning(run, 'T2');
    // T2がrunning中はT3の枠が無い
    expect(nextTasksToStart(d, run)).toEqual(new Set());

    run = applyLoopStopReason(run, tasks, 'T2', 'done');
    next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T3']));
  });

  it('waitingApprovalも並列の枠を占める', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markRunning(run, 'T2');
    run = markWaitingApproval(run, 'T2');

    // T2がwaitingApprovalのままでも枠を占めているため、T3は開始できない
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('T2がfailedになったとき、T4がskippedになり以降どのタスクも開始されない', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');

    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');

    expect(run.tasks.get('T4')?.state).toBe('skipped');
    // T3はすでにrunningなので、T2の失敗後も止められず走り続ける
    expect(run.tasks.get('T3')?.state).toBe('running');
    // 独立した枝も含め、新たにはどのタスクも開始されない
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('maxReachedもfailedと同じく実行全体を停止させる', () => {
    const tasks = [task('T1', []), task('T2', [])];
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');

    // T2はT1と無関係の独立した枝だが、実行全体が停止しているため開始されない
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('間接的な依存を持つタスクも、祖先の失敗でskipされ開始されない', () => {
    const tasks = [task('T1', []), task('T2', ['T1']), task('T3', ['T2'])];
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');

    expect(run.tasks.get('T2')?.state).toBe('skipped');
    expect(run.tasks.get('T3')?.state).toBe('skipped');
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('再実行でT2をpendingに戻すと、T4のskippedもpendingに戻り、次に開始される', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');
    run = applyLoopStopReason(run, tasks, 'T3', 'done');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed, T4: skipped

    run = retryTask(run, tasks, 'T2');
    expect(run.tasks.get('T2')?.state).toBe('pending');
    expect(run.tasks.get('T4')?.state).toBe('pending');

    // T2は依存(T1)がdone済みなのですぐ開始できる。T4はT2がまだdoneでないので開始できない
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2']));
  });

  it('同じ段で複数開始できるとき定義順に埋まり、枠が足りない分は残る', () => {
    // T2, T3, T5は全てT1のみに依存する兄弟タスク。定義順はT2, T3, T5
    const tasks = [task('T1', []), task('T2', ['T1']), task('T3', ['T1']), task('T5', ['T1'])];
    const d = def(tasks, 2);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');

    // maxParallel: 2なので定義順の先頭2件（T2, T3）だけが埋まり、T5は残る
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2', 'T3']));
  });

  it('retries: 2のタスクは2回まで自動再試行され、3回目の失敗でようやく実行が停止する', () => {
    const tasks = [task('T1', []), task('T2', ['T1'], 2), task('T3', ['T2'])];
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');

    // 1回目の失敗: 自動再試行でpendingへ戻り、まだ実行は止まらない
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    expect(run.tasks.get('T2')?.state).toBe('pending');
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2']));

    // 2回目の失敗: まだretriesの範囲内
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    expect(run.tasks.get('T2')?.state).toBe('pending');

    // 3回目の失敗でついに確定し、以降は何も開始されない
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    expect(run.tasks.get('T2')?.state).toBe('failed');
    expect(run.tasks.get('T3')?.state).toBe('skipped');
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });
});

describe('getRunOutcome', () => {
  it('pending/running/waitingApprovalが残っていればrunning', () => {
    const tasks = diamondTasks();
    const run = createRunState(tasks);
    expect(getRunOutcome(run)).toBe('running');
  });

  it('全タスクがdoneならsucceeded', () => {
    const tasks = [task('T1', []), task('T2', ['T1'])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'done');
    expect(getRunOutcome(run)).toBe('succeeded');
  });

  it('1件でもfailedがあればfailed', () => {
    const tasks = [task('T1', []), task('T2', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'done');
    expect(getRunOutcome(run)).toBe('failed');
  });

  it('独立した枝が未開始のまま残っていても、実行停止でskippedになり終了判定が出る（バグ修正）', () => {
    // T1とT5は独立。T1が失敗してもT5は元のままだとpendingに残り、終了判定が永久にrunningのままだった
    const tasks = [task('T1', []), task('T2', ['T1']), task('T5', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'failed');

    expect(run.tasks.get('T5')?.state).toBe('skipped');
    expect(nextTasksToStart(def(tasks, 3), run)).toEqual(new Set());
    expect(getRunOutcome(run)).toBe('failed');
  });
});
