import { describe, expect, it } from 'vitest';

import {
  applyLoopStopReason,
  createRunState,
  hasFailedTask,
  markMergeBlocked,
  markMergeSucceeded,
  markRunning,
  markWaitingApproval,
  retryTask,
  type RunState,
  type TaskState,
} from '../../src/orchestrator/runState';
import { getRunOutcome, nextTasksToStart } from '../../src/orchestrator/scheduler';
import type { WorkflowDefinition, WorkflowTask } from '../../src/orchestrator/workflow';

/**
 * `waitingReply` への実際の遷移（`messaging.ts`への配線）は#105の範囲で、この時点では
 * `runState.ts` に遷移関数が無い。スケジューリング側の枠計算・終了判定が`waitingReply`を
 * 正しく扱うかだけをテストしたいので、状態を直接差し替えるテスト専用ヘルパーで代用する。
 */
const withState = (run: RunState, taskId: string, state: TaskState): RunState => {
  const current = run.tasks.get(taskId);
  if (current === undefined) {
    return run;
  }
  const tasks = new Map(run.tasks);
  tasks.set(taskId, { ...current, state });
  return { ...run, tasks };
};

const task = (id: string, dependsOn: string[] = [], retries = 0): WorkflowTask => ({
  id,
  prompt: '作業する',
  done: '作業が終わっている',
  dependsOn,
  continuePrompt: '続けてください',
  maxIterations: 20,
  provider: 'codex',
  isolation: 'worktree',
  type: 'chore',
  cwd: undefined,
  model: undefined,
  effort: undefined,
  approvalMode: undefined,
  sandbox: undefined,
  autoApprove: false,
  escalate: [],
  allow: [],
  retries,
  issue: undefined,
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

/**
 * `applyLoopStopReason(..., 'done')` は`merging`にするだけ（design.md §16.17）。
 * スケジューリングのテストは「マージまで含めて完了した」前提を必要とするだけなので、
 * `markMergeSucceeded`まで一気に進めるヘルパーで代用する。
 */
const finishDone = (run: RunState, tasks: WorkflowTask[], taskId: string): RunState =>
  markMergeSucceeded(applyLoopStopReason(run, tasks, taskId, 'done'), tasks, taskId);

describe('nextTasksToStart', () => {
  it('T1完了後、maxParallelに余裕があればT2とT3が同時に返る', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');

    const next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T2', 'T3']));
  });

  it('maxParallel: 1のとき、T2だけが返り、T2完了後にT3が返る', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');

    let next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T2']));

    run = markRunning(run, 'T2');
    // T2がrunning中はT3の枠が無い
    expect(nextTasksToStart(d, run)).toEqual(new Set());

    run = finishDone(run, tasks, 'T2');
    next = nextTasksToStart(d, run);
    expect(next).toEqual(new Set(['T3']));
  });

  it('waitingApprovalも並列の枠を占める', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = markWaitingApproval(run, 'T2');

    // T2がwaitingApprovalのままでも枠を占めているため、T3は開始できない
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('waitingReplyも並列の枠を占める（design.md §16.3。返信待ちもセッションは生きている）', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = withState(run, 'T2', 'waitingReply');

    // T2がwaitingReplyのままでも枠を占めているため、T3は開始できない
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('T2がfailedになったとき、T4がskippedになり以降どのタスクも開始されない', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
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
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');
    run = finishDone(run, tasks, 'T3');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed, T4: skipped

    run = retryTask(run, tasks, 'T2');
    expect(run.tasks.get('T2')?.state).toBe('pending');
    expect(run.tasks.get('T4')?.state).toBe('pending');

    // T2は依存(T1)がdone済みなのですぐ開始できる。T4はT2がまだdoneでないので開始できない
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2']));
  });

  it('manualで停止したあとretryTaskすると、次に開始する集合が返るようになる（バグ修正）', () => {
    // haltedByUserを解除する経路が無いと、retryTaskでpendingに戻しても
    // isRunHaltedがtrueのままでnextTasksToStartが永久に空を返し続ける
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');

    run = applyLoopStopReason(run, tasks, 'T2', 'manual'); // T4(pending)がrunHaltedでskip
    expect(nextTasksToStart(d, run)).toEqual(new Set());

    run = finishDone(run, tasks, 'T2');
    run = finishDone(run, tasks, 'T3');
    run = retryTask(run, tasks, 'T4');

    expect(nextTasksToStart(d, run)).toEqual(new Set(['T4']));
  });

  it('同じ段で複数開始できるとき定義順に埋まり、枠が足りない分は残る', () => {
    // T2, T3, T5は全てT1のみに依存する兄弟タスク。定義順はT2, T3, T5
    const tasks = [task('T1', []), task('T2', ['T1']), task('T3', ['T1']), task('T5', ['T1'])];
    const d = def(tasks, 2);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');

    // maxParallel: 2なので定義順の先頭2件（T2, T3）だけが埋まり、T5は残る
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2', 'T3']));
  });

  it('retries: 2のタスクは2回まで自動再試行され、3回目の失敗でようやく実行が停止する', () => {
    const tasks = [task('T1', []), task('T2', ['T1'], 2), task('T3', ['T2'])];
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');

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

  it('waitingReplyが残っていればrunning（design.md §16.5「まだ終わっていない」）', () => {
    const tasks = [task('T1', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = withState(run, 'T1', 'waitingReply');
    expect(getRunOutcome(run)).toBe('running');
  });

  it('全タスクがdoneならsucceeded', () => {
    const tasks = [task('T1', []), task('T2', ['T1'])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = finishDone(run, tasks, 'T2');
    expect(getRunOutcome(run)).toBe('succeeded');
  });

  it('1件でもfailedがあればfailed', () => {
    const tasks = [task('T1', []), task('T2', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');
    run = markRunning(run, 'T2');
    run = finishDone(run, tasks, 'T2');
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

  it('manual/interruptedによる停止のみ（failedなし）で終わったrunはaborted（バグ修正）', () => {
    // T1は最終的にdoneで終わるが、T2は独立した枝でmanual停止によりrunHaltedのままskippedで終わる。
    // failedが1件も無いのでgetRunOutcomeがsucceededと誤判定していた
    const tasks = [task('T1', []), task('T2', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'manual');
    expect(run.tasks.get('T2')?.state).toBe('skipped');

    run = finishDone(run, tasks, 'T1');
    expect(run.tasks.get('T1')?.state).toBe('done');
    expect(hasFailedTask(run)).toBe(false);
    expect(getRunOutcome(run)).toBe('aborted');
  });

  it('mergingは1件でもあればrunning（マージが済むまで終了しない。design.md §16.17）', () => {
    const tasks = [task('T1', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done'); // T1: merging
    expect(run.tasks.get('T1')?.state).toBe('merging');
    expect(getRunOutcome(run)).toBe('running');
  });

  it('blockedが1件でもあれば、failedが無い限りblocked（design.md §16.17）', () => {
    const tasks = [task('T1', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markMergeBlocked(run, tasks, 'T1');
    expect(getRunOutcome(run)).toBe('blocked');
  });

  it('failedとblockedが両方あれば、failedを優先する（design.md §16.17「原因も次にやることも違う」）', () => {
    const tasks = [task('T1', []), task('T2', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    run = markMergeBlocked(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');
    expect(getRunOutcome(run)).toBe('failed');
  });
});

describe('merging/blockedとスケジューリングの関係（design.md §16.3 / §16.17）', () => {
  it('依存先がmergingの間は後続を開始しない（doneだけが依存の充足）', () => {
    const tasks = diamondTasks();
    const d = def(tasks, 3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done'); // T1: merging（まだdoneでない）

    expect(run.tasks.get('T1')?.state).toBe('merging');
    expect(nextTasksToStart(d, run)).toEqual(new Set());

    run = markMergeSucceeded(run, tasks, 'T1');
    expect(nextTasksToStart(d, run)).toEqual(new Set(['T2', 'T3']));
  });

  it('mergingは並列の枠を占める', () => {
    // T1がmergingのままだと、他に開始できる独立したタスク（T5）があっても枠が無く開始できない
    const tasks = [task('T1', []), task('T5', [])];
    const d = def(tasks, 1);
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done'); // T1: merging。maxParallel:1の枠を占める
    expect(nextTasksToStart(d, run)).toEqual(new Set());
  });

  it('blockedは依存する後続だけをskippedにし、独立した枝は走り続ける', () => {
    const tasks = [...diamondTasks(), task('T5', [])];
    let run = createRunState(tasks);
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');
    run = markRunning(run, 'T5');
    run = applyLoopStopReason(run, tasks, 'T2', 'done'); // T2: merging
    run = markMergeBlocked(run, tasks, 'T2'); // T2: blocked, T4: skipped(mergeBlocked)

    expect(run.tasks.get('T2')?.state).toBe('blocked');
    expect(run.tasks.get('T4')?.state).toBe('skipped');
    // T3・T5はblockedの影響を受けず走り続ける（failedと違い実行全体を止めない）
    expect(run.tasks.get('T3')?.state).toBe('running');
    expect(run.tasks.get('T5')?.state).toBe('running');
    expect(getRunOutcome(run)).toBe('running'); // T3・T5がまだrunningのため
  });
});
