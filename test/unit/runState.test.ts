import { describe, expect, it } from 'vitest';

import {
  applyAutoResume,
  applyLoopStopReason,
  createRunState,
  hasFailedTask,
  isRunHalted,
  markApprovalRejected,
  markMergeBlocked,
  markMergeFailed,
  markMergeSucceeded,
  markRunning,
  markTaskApprovalTimedOut,
  markWaitingApproval,
  markWaitingReply,
  recordSubmissionCount,
  resumeFromApproval,
  resumeFromWaitingReply,
  retryMergeState,
  retryTask,
  continueTask,
  type RunState,
  type TaskRunState,
} from '../../src/orchestrator/runState';
import type { WorkflowDefinition, WorkflowTask } from '../../src/orchestrator/workflow';
import { getRunOutcome, nextTasksToStart } from '../../src/orchestrator/scheduler';

/** テストで頻出する最小構成のタスク。dependsOn以外は固定値でよい。 */
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

/** T1 -> T2 -> T3、T4はT2・T3の両方に依存する合流タスク、というよくある形。 */
const chainTasks = (retries = 0): WorkflowTask[] => [
  task('T1', []),
  task('T2', ['T1'], retries),
  task('T3', ['T2']),
  task('T4', ['T2', 'T3']),
];

const stateOf = (run: RunState, id: string): TaskRunState => {
  const s = run.tasks.get(id);
  if (s === undefined) {
    throw new Error(`unknown task: ${id}`);
  }
  return s;
};

/**
 * `applyLoopStopReason(..., 'done')` は`merging`にするだけで、`done`にはしない
 * （design.md §16.17。実際の`done`は`markMergeSucceeded`が担う）。多くのテストは
 * 「マージまで含めて完了した」前提を単に必要としているだけなので、この2ステップを
 * まとめたヘルパーで代用する（マージそのものの結果分岐は専用のdescribeブロックで扱う）。
 */
const finishDone = (run: RunState, tasks: WorkflowTask[], taskId: string): RunState =>
  markMergeSucceeded(applyLoopStopReason(run, tasks, taskId, 'done'), tasks, taskId);

describe('createRunState', () => {
  it('全タスクをpending・送信回数0・再試行回数0・失敗理由なしで初期化する', () => {
    const run = createRunState(chainTasks());
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      const s = stateOf(run, id);
      expect(s.state).toBe('pending');
      expect(s.submissionCount).toBe(0);
      expect(s.retryCount).toBe(0);
      expect(s.failure).toBeUndefined();
    }
    expect(isRunHalted(run)).toBe(false);
    expect(hasFailedTask(run)).toBe(false);
  });
});

describe('applyLoopStopReason', () => {
  it('doneはタスクをmergingにする（マージが済むまではdoneにしない。design.md §16.17）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'done');
    expect(stateOf(run, 'T1').state).toBe('merging');
    // mergingは実行全体を停止させない（並列の枠は占めるが、isRunHaltedはfailed確定/人の割り込みだけを見る）
    expect(isRunHalted(run)).toBe(false);
  });

  it('doneはタスクをdoneにする（マージまで含めて完了した場合。ヘルパーfinishDone経由）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    expect(stateOf(run, 'T1').state).toBe('done');
    expect(isRunHalted(run)).toBe(false);
  });

  it('maxReachedはfailedになり、理由を記録する（回数切れ）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');
    const t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'maxReached' });
  });

  it('stalledはfailedになり、理由をmaxReachedと区別して記録する（design.md §16.27、Issue #336）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'stalled');
    const t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'stalled' });
    expect(t2.failure).not.toEqual({ kind: 'loopFailed' });
  });

  it('stalledはretriesを消費しない（failedとは別経路。retryCountが増えない）', () => {
    const tasks = chainTasks(2); // T2のretries: 2
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'stalled');
    const t2 = stateOf(run, 'T2');
    // retriesが残っていても、failedのように自動でpendingへ戻さず即座にfailedで確定する
    // （taskStopped=manualStopと同じ扱い。design.md §16.27）
    expect(t2.state).toBe('failed');
    expect(t2.retryCount).toBe(0);
  });

  it('stalledは依存する後続をskippedにする（failedの波及と同じ）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'stalled'); // T3・T4が依存
    expect(stateOf(run, 'T3').state).toBe('skipped');
    expect(stateOf(run, 'T3').failure).toEqual({ kind: 'dependencyFailed', failedTaskIds: ['T2'] });
  });

  it('failedはretriesの範囲でpendingへ戻し、再試行回数を増やす', () => {
    const tasks = chainTasks(2);
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = recordSubmissionCount(run, 'T2', 5);

    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    let t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('pending');
    expect(t2.retryCount).toBe(1);
    // 新しいスレッド・worktreeでやり直す前提なので、送信回数はリセットする
    expect(t2.submissionCount).toBe(0);
    expect(t2.failure).toBeUndefined();
    expect(hasFailedTask(run)).toBe(false);

    // 2回目の再試行
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('pending');
    expect(t2.retryCount).toBe(2);

    // retries: 2 を使い切ったので3回目の失敗で確定する
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'loopFailed' });
  });

  it('retriesが0のタスクはfailedで即座に確定する', () => {
    const tasks = chainTasks(0);
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    expect(stateOf(run, 'T2').state).toBe('failed');
    expect(stateOf(run, 'T2').retryCount).toBe(0);
  });

  it('waitingReply中のfailedはfailedに確定する（Issue #362。isUnsettledにwaitingReplyを含めないと素通りしてwaitingReplyのまま残る）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = markWaitingReply(run, 'T2');
    expect(stateOf(run, 'T2').state).toBe('waitingReply');

    run = applyLoopStopReason(run, tasks, 'T2', 'failed');
    const t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'loopFailed' });
  });

  it('manual/interruptedは実行全体を止めるが、そのタスク自身の状態は変えない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'manual');
    expect(stateOf(run, 'T1').state).toBe('running');
    expect(isRunHalted(run)).toBe(true);

    run = applyLoopStopReason(run, tasks, 'T1', 'interrupted');
    expect(isRunHalted(run)).toBe(true);
  });

  describe('失敗の波及（skip）', () => {
    it('T2がfailedに確定すると、直接依存するT4がskippedになる', () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = markRunning(run, 'T2');
      run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');

      expect(stateOf(run, 'T2').state).toBe('failed');
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'dependencyFailed',
        failedTaskIds: ['T2'],
      });
      expect(isRunHalted(run)).toBe(true);
      expect(hasFailedTask(run)).toBe(true);
    });

    it('間接的な依存も含めてskippedになる（T1failed → T2, T3ともにskip）', () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = markRunning(run, 'T1');
      run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');

      expect(stateOf(run, 'T1').state).toBe('failed');
      expect(stateOf(run, 'T2').state).toBe('skipped');
      expect(stateOf(run, 'T3').state).toBe('skipped');
      expect(stateOf(run, 'T4').state).toBe('skipped');
    });

    it('すでにrunningのタスクはskipにせず、そのまま残す', () => {
      // T5はT1にもT2にも依存しない独立した枝で、すでにrunning
      const tasks = [...chainTasks(), task('T5', [])];
      let run = createRunState(tasks);
      run = markRunning(run, 'T2');
      run = markRunning(run, 'T5');

      run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');

      expect(stateOf(run, 'T5').state).toBe('running');
    });

    it('複数の親が失敗すると、合流タスクのfailedTaskIdsに両方入る', () => {
      // T2, T3は共にT1に依存し、T4は両方に依存する合流タスク。T2, T3は独立に失敗しうる
      const tasks = [
        task('T1', []),
        task('T2', ['T1']),
        task('T3', ['T1']),
        task('T4', ['T2', 'T3']),
      ];
      let run = createRunState(tasks);
      run = markRunning(run, 'T1');
      run = finishDone(run, tasks, 'T1');
      run = markRunning(run, 'T2');
      run = markRunning(run, 'T3');

      run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'dependencyFailed',
        failedTaskIds: ['T2'],
      });

      // T3はT2の失敗後もrunningのまま走り続け、独自に失敗する（design.md「走らせ切る」）
      expect(stateOf(run, 'T3').state).toBe('running');
      run = applyLoopStopReason(run, tasks, 'T3', 'maxReached');

      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'dependencyFailed',
        failedTaskIds: ['T2', 'T3'],
      });
    });
  });

  describe('実行全体の停止時、まだ開始していないタスクの扱い（バグ修正）', () => {
    it('依存関係上は無関係な独立した枝のpendingも、失敗確定でrunHaltedのskippedになる', () => {
      // T5はT1にもT2にも依存しない独立した枝で、まだ開始していない（pendingのまま）
      const tasks = [...chainTasks(), task('T5', [])];
      let run = createRunState(tasks);
      run = markRunning(run, 'T2');

      run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');

      expect(stateOf(run, 'T5').state).toBe('skipped');
      expect(stateOf(run, 'T5').failure).toEqual({ kind: 'runHalted' });
      // 依存先の失敗が波及したT4はdependencyFailedのまま、原因を区別する
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'dependencyFailed',
        failedTaskIds: ['T2'],
      });
    });

    it('manual/interruptedで停止したときも、まだ開始していないpendingはrunHaltedのskippedになる', () => {
      const tasks = [...chainTasks(), task('T5', [])];
      let run = createRunState(tasks);
      run = markRunning(run, 'T1');

      run = applyLoopStopReason(run, tasks, 'T1', 'manual');

      expect(stateOf(run, 'T2').state).toBe('skipped');
      expect(stateOf(run, 'T2').failure).toEqual({ kind: 'runHalted' });
      expect(stateOf(run, 'T5').state).toBe('skipped');
      expect(stateOf(run, 'T5').failure).toEqual({ kind: 'runHalted' });
    });

    it('runningのタスクは、停止処理によって状態を変えられない', () => {
      const tasks = [...chainTasks(), task('T5', [])];
      let run = createRunState(tasks);
      run = markRunning(run, 'T1');
      run = markRunning(run, 'T5');

      run = applyLoopStopReason(run, tasks, 'T1', 'interrupted');

      expect(stateOf(run, 'T1').state).toBe('running');
      expect(stateOf(run, 'T5').state).toBe('running');
    });

    it('手動再実行でrunHaltedのskippedを、依存がdoneならpendingへ戻せる', () => {
      // T5はT1にもT2にも依存しないので、依存の充足は常に真（対象なし）
      const tasks = [...chainTasks(), task('T5', [])];
      let run = createRunState(tasks);
      run = markRunning(run, 'T2');
      run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');
      expect(stateOf(run, 'T5').state).toBe('skipped');

      const retried = retryTask(run, tasks, 'T5');
      expect(stateOf(retried, 'T5').state).toBe('pending');
      expect(stateOf(retried, 'T5').failure).toBeUndefined();
    });
  });
});

describe('markApprovalRejected', () => {
  it('承認拒否は即failedとして確定し、retriesが残っていても再試行対象にしない', () => {
    const tasks = chainTasks(3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = markWaitingApproval(run, 'T2');

    run = markApprovalRejected(run, tasks, 'T2');

    const t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'approvalRejected' });
    // 拒否はloopFailed/maxReachedと違いretryCountを消費しない（自動再試行の経路を通っていないため）
    expect(t2.retryCount).toBe(0);
    expect(stateOf(run, 'T4').state).toBe('skipped');
  });

  it('waitingApproval以外のタスクには効かない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    const before = run;

    expect(markApprovalRejected(run, tasks, 'T1')).toBe(before); // runningには効かない
    expect(markApprovalRejected(run, tasks, 'unknown')).toBe(before); // 未知のidも無視する
  });
});

describe('markTaskApprovalTimedOut（Issue #579、design.md §16.39）', () => {
  it('waitingApprovalの時間切れは即failedとして確定し、retriesが残っていても再試行対象にしない', () => {
    const tasks = chainTasks(3);
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = markWaitingApproval(run, 'T2');

    run = markTaskApprovalTimedOut(run, tasks, 'T2');

    const t2 = stateOf(run, 'T2');
    expect(t2.state).toBe('failed');
    expect(t2.failure).toEqual({ kind: 'taskApprovalTimedOut' });
    expect(t2.retryCount).toBe(0);
    expect(stateOf(run, 'T4').state).toBe('skipped');
  });

  it('waitingApproval以外のタスク・未知のidには効かない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    const before = run;

    expect(markTaskApprovalTimedOut(run, tasks, 'T1')).toBe(before); // runningには効かない
    expect(markTaskApprovalTimedOut(run, tasks, 'unknown')).toBe(before); // 未知のidも無視する
  });
});

describe('markWaitingApproval / resumeFromApproval', () => {
  it('runningからwaitingApprovalへ、そこからrunningへ戻せる', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = markWaitingApproval(run, 'T1');
    expect(stateOf(run, 'T1').state).toBe('waitingApproval');

    run = resumeFromApproval(run, 'T1');
    expect(stateOf(run, 'T1').state).toBe('running');
  });

  it('markWaitingApprovalはrunning以外の状態・未知のidを無視する', () => {
    const tasks = chainTasks();
    const run = createRunState(tasks); // T1はpending
    expect(markWaitingApproval(run, 'T1')).toBe(run);
    expect(markWaitingApproval(run, 'unknown')).toBe(run);
  });

  it('resumeFromApprovalはwaitingApproval以外の状態・未知のidを無視する', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1'); // T1はrunning、waitingApprovalではない
    expect(resumeFromApproval(run, 'T1')).toBe(run);
    expect(resumeFromApproval(run, 'unknown')).toBe(run);
  });
});

describe('markWaitingReply / resumeFromWaitingReply（design.md §16.21）', () => {
  it('runningからwaitingReplyへ、そこからrunningへ戻せる', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = markWaitingReply(run, 'T1');
    expect(stateOf(run, 'T1').state).toBe('waitingReply');

    run = resumeFromWaitingReply(run, 'T1');
    expect(stateOf(run, 'T1').state).toBe('running');
  });

  it('markWaitingReplyはrunning以外の状態・未知のidを無視する', () => {
    const tasks = chainTasks();
    const run = createRunState(tasks); // T1はpending
    expect(markWaitingReply(run, 'T1')).toBe(run);
    expect(markWaitingReply(run, 'unknown')).toBe(run);
  });

  it('resumeFromWaitingReplyはwaitingReply以外の状態・未知のidを無視する', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1'); // T1はrunning、waitingReplyではない
    expect(resumeFromWaitingReply(run, 'T1')).toBe(run);
    expect(resumeFromWaitingReply(run, 'unknown')).toBe(run);
  });
});

describe('確定済みタスクへの二重通知を無視する（ガードの対称性）', () => {
  it('doneのタスクにmaxReachedが届いても変わらない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    const before = run;

    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');
    expect(run).toBe(before);
    expect(stateOf(run, 'T1').state).toBe('done');
  });

  it('doneのタスクにfailedが届いても、retriesが残っていてもpendingへ戻らない', () => {
    // 再試行の経路にだけガードが無いと、確定した成功が pending へ巻き戻る
    const tasks = [task('T1', [], 2)];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    const before = run;

    run = applyLoopStopReason(run, tasks, 'T1', 'failed');
    expect(run).toBe(before);
    expect(stateOf(run, 'T1').state).toBe('done');
    expect(stateOf(run, 'T1').retryCount).toBe(0);
  });

  it('failedのタスクにdoneが届いても変わらない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed
    const before = run;

    run = finishDone(run, tasks, 'T2');
    expect(run).toBe(before);
    expect(stateOf(run, 'T2').state).toBe('failed');
  });

  it('skippedのタスクにmaxReachedが届いても変わらない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T4: skipped
    const before = run;

    run = applyLoopStopReason(run, tasks, 'T4', 'maxReached');
    expect(run).toBe(before);
    expect(stateOf(run, 'T4').state).toBe('skipped');
  });

  it('doneのタスクへmarkApprovalRejectedを呼んでも変わらない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    const before = run;

    run = markApprovalRejected(run, tasks, 'T1');
    expect(run).toBe(before);
    expect(stateOf(run, 'T1').state).toBe('done');
  });
});

describe('recordSubmissionCount', () => {
  it('送信回数を上書きする', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = recordSubmissionCount(run, 'T1', 3);
    expect(stateOf(run, 'T1').submissionCount).toBe(3);
  });
});

describe('retryTask（手動の再実行）', () => {
  it('依存が全てdoneでなければ戻せない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed, T4: skipped

    // T1はdoneでない（実行停止によりskippedになっている）のでT2は戻せない
    expect(stateOf(run, 'T1').state).not.toBe('done');
    const retried = retryTask(run, tasks, 'T2');
    expect(stateOf(retried, 'T2').state).toBe('failed');
  });

  it('依存が全てdoneならpendingへ戻り、依存するskippedもpendingへ戻る', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed, T3・T4: skipped

    expect(stateOf(run, 'T3').state).toBe('skipped');
    expect(stateOf(run, 'T4').state).toBe('skipped');

    const retried = retryTask(run, tasks, 'T2');
    expect(stateOf(retried, 'T2').state).toBe('pending');
    expect(stateOf(retried, 'T2').failure).toBeUndefined();
    expect(stateOf(retried, 'T3').state).toBe('pending');
    expect(stateOf(retried, 'T4').state).toBe('pending');
    expect(hasFailedTask(retried)).toBe(false);
    expect(isRunHalted(retried)).toBe(false);
  });

  it('manualRetryCountを増やす（retryCountは増やさない）', () => {
    // worktreeのディレクトリ名とブランチ名は試行の回数から決まるため、増やさないと
    // 前の試行が残したブランチと衝突して再実行が必ず失敗する（issue #275）
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');

    const once = retryTask(run, tasks, 'T1');
    expect(stateOf(once, 'T1').manualRetryCount).toBe(1);
    // 自動再試行の権利は人の操作で復活させない
    expect(stateOf(once, 'T1').retryCount).toBe(stateOf(run, 'T1').retryCount);

    // 2回目の再実行でも積み上がる
    let second = markRunning(once, 'T1');
    second = applyLoopStopReason(second, tasks, 'T1', 'maxReached');
    expect(stateOf(retryTask(second, tasks, 'T1'), 'T1').manualRetryCount).toBe(2);
  });

  it('done・running・pendingのタスクは対象外で、何も変えない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    const before = run;

    const afterRunning = retryTask(run, tasks, 'T1');
    expect(afterRunning).toBe(before);

    run = finishDone(run, tasks, 'T1');
    const afterDone = retryTask(run, tasks, 'T1');
    expect(stateOf(afterDone, 'T1').state).toBe('done');
  });

  it('成功するとhaltedByUserを解除する（バグ修正: 解除経路が無いと再実行しても永久に開始できない）', () => {
    // design.mdのサンプルと同じT1 -> (T2 || T3) -> T4の形。T2の実行中にmanualで停止し、
    // T4がrunHaltedでskippedになる → T2・T3は走らせ切ってdoneになる → 手動でT4を戻す、という筋
    const tasks = [
      task('T1', []),
      task('T2', ['T1']),
      task('T3', ['T1']),
      task('T4', ['T2', 'T3']),
    ];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = markRunning(run, 'T3');

    run = applyLoopStopReason(run, tasks, 'T2', 'manual'); // haltedByUserが立つ。T4(pending)はrunHaltedでskip
    expect(isRunHalted(run)).toBe(true);
    expect(stateOf(run, 'T4').state).toBe('skipped');
    expect(stateOf(run, 'T4').failure).toEqual({ kind: 'runHalted' });

    // T2・T3自身はmanualで変えられていない（running）ので、そのまま走らせ切ってdoneにできる
    run = finishDone(run, tasks, 'T2');
    run = finishDone(run, tasks, 'T3');

    run = retryTask(run, tasks, 'T4');
    expect(stateOf(run, 'T4').state).toBe('pending');
    expect(isRunHalted(run)).toBe(false);
  });

  it('失敗が残っている限りhaltedByUserを解除してもisRunHaltedはtrueのまま', () => {
    // T1系とT6系の独立した2系統。T1系はmanualで停止しつつ、T6は別途failedで確定させる
    const tasks = [...chainTasks(), task('T6', [])];
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = markRunning(run, 'T6');
    run = applyLoopStopReason(run, tasks, 'T1', 'manual');
    run = applyLoopStopReason(run, tasks, 'T6', 'maxReached'); // T6: failed（hasFailedTaskがtrueになる）
    run = finishDone(run, tasks, 'T1');

    // T2はrunHaltedでskip済み。依存(T1)がdoneなので手動再実行できる
    run = retryTask(run, tasks, 'T2');
    expect(stateOf(run, 'T2').state).toBe('pending');
    // T6がfailedのままなので、実行全体は依然として停止している
    expect(hasFailedTask(run)).toBe(true);
    expect(isRunHalted(run)).toBe(true);
  });
});

describe('markRunning', () => {
  it('pendingのタスクだけをrunningにする。対象外のidは無視する', () => {
    const tasks = chainTasks();
    const run = createRunState(tasks);
    const next = markRunning(run, 'T1');
    expect(stateOf(next, 'T1').state).toBe('running');
    expect(stateOf(next, 'T2').state).toBe('pending');
  });
});

describe('マージの結果に応じた遷移（design.md §16.17）', () => {
  /** 指定タスクを`running`経由で`merging`にする。`run`未指定なら新規のRunStateから始める。 */
  const toMerging = (tasks: WorkflowTask[], id: string, run?: RunState): RunState => {
    const base = markRunning(run ?? createRunState(tasks), id);
    return applyLoopStopReason(base, tasks, id, 'done');
  };

  describe('markMergeSucceeded', () => {
    it('mergingのタスクをdoneにする', () => {
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T1');
      expect(stateOf(run, 'T1').state).toBe('merging');

      run = markMergeSucceeded(run, tasks, 'T1');
      expect(stateOf(run, 'T1').state).toBe('done');
      expect(stateOf(run, 'T1').failure).toBeUndefined();
    });

    it('merging以外の状態には効かない', () => {
      const tasks = chainTasks();
      const run = createRunState(tasks); // T1はpending
      expect(markMergeSucceeded(run, tasks, 'T1')).toBe(run);
      expect(markMergeSucceeded(run, tasks, 'unknown')).toBe(run);
    });

    it('再マージが成功すると、mergeBlockedでskippedになっていた依存先をpendingへ戻す', () => {
      // T2がblockedになりT4がmergeBlockedでskipされたあと、T2を再マージして成功させる
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T1');
      run = markMergeSucceeded(run, tasks, 'T1');
      run = markRunning(run, 'T2');
      run = applyLoopStopReason(run, tasks, 'T2', 'done'); // T2: merging
      run = markMergeBlocked(run, tasks, 'T2'); // T2: blocked, T4(直接の依存ではないがT2の子孫): skipped(mergeBlocked)
      expect(stateOf(run, 'T2').state).toBe('blocked');
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });

      run = retryMergeState(run, 'T2');
      expect(stateOf(run, 'T2').state).toBe('merging');
      run = markMergeSucceeded(run, tasks, 'T2');
      expect(stateOf(run, 'T2').state).toBe('done');
      // T3はT2にもT1にも依存しているが、T2経由の子孫（T4）だけがmergeBlockedで戻る対象。
      // T3自身はmergeBlockedでskipされていないため、この時点ではまだpending
      expect(stateOf(run, 'T4').state).toBe('pending');
      expect(stateOf(run, 'T4').failure).toBeUndefined();
    });

    /**
     * Issue #432-1: 停止中（`haltedByUser: true`）に再マージが成功しても、
     * `mergeBlocked`でskippedになっていた依存先を`pending`へ戻してはならない。
     *
     * `nextTasksToStart`は停止中のrunで新規開始を一切しないため、`pending`へ戻すと
     * 誰にも開始されない`pending`が残り、`getRunOutcome`が`running`を返し続けて
     * runが永久に終わらない（`retryTask`/`continueTask`は`pending`を受理しないため
     * 人も救えない）。`skipped`（`runHalted`）のままにしておけば、人が`retryTask`で
     * 拾い直せる（`retryTask`は`skipped`なら理由を問わず受理し`haltedByUser`も解除する）。
     */
    it('停止中に再マージが成功しても、mergeBlockedのskippedをpendingへ戻さずrunHaltedへ倒す', () => {
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T1');
      run = markMergeSucceeded(run, tasks, 'T1');
      run = markRunning(run, 'T2');
      run = applyLoopStopReason(run, tasks, 'T2', 'done'); // T2: merging
      run = markMergeBlocked(run, tasks, 'T2'); // T2: blocked, T4: skipped(mergeBlocked)
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });

      // ユーザーが実行全体を停止する
      run = { ...run, haltedByUser: true };

      // 停止中でも「再マージ」自体は走る（Issue #412のレビュー指摘B。retryMergeStateは
      // haltedByUserを解除しない）
      run = retryMergeState(run, 'T2');
      expect(stateOf(run, 'T2').state).toBe('merging');

      run = markMergeSucceeded(run, tasks, 'T2');
      expect(stateOf(run, 'T2').state).toBe('done');
      expect(run.haltedByUser).toBe(true);
      // pendingへ戻さず、skipped(runHalted)のままにする
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'runHalted' });
    });

    /**
     * Issue #432-1（セキュリティ監査の追加指摘）: `haltedByUser: false` でも、
     * 他のタスクが`failed`で確定していれば（`hasFailedTask`）`nextTasksToStart`の門
     * （`isRunHalted = haltedByUser || hasFailedTask`）は同じく閉じる。
     * `markMergeSucceeded`が`run.haltedByUser`だけを見て`isRunHalted`を見ていないと、
     * 人が停止していない通常運用（独立した枝の1つが失敗して`failed`確定、別の枝が
     * マージ衝突→人が解決→再マージ成功）でも、この再マージ成功時に依存先を`pending`
     * へ戻してしまい、`nextTasksToStart`には拾われないまま`getRunOutcome`が`running`を
     * 返し続ける同じ袋小路が起きる。
     *
     * 停止中と同じく`skipped`（`runHalted`）へ倒せば、`getRunOutcome`は`pending`も
     * `merging`等の活性状態も残らない時点で`anyFailed`を見て`'failed'`を返し、runが
     * 終端に達する。
     */
    it('haltedByUserがfalseでもhasFailedTaskがtrueなら、mergeBlockedのskippedをpendingへ戻さない', () => {
      const tasks = [task('T1', []), task('T2', ['T1']), task('T5', [])];
      let run = createRunState(tasks);
      run = toMerging(tasks, 'T1', run); // T1: merging
      run = markMergeBlocked(run, tasks, 'T1'); // T1: blocked, T2: skipped(mergeBlocked)
      expect(stateOf(run, 'T2').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T1'] });

      // 独立した枝T5が回数切れで確定失敗する（人の停止操作は無い）
      run = markRunning(run, 'T5');
      run = applyLoopStopReason(run, tasks, 'T5', 'maxReached');
      expect(stateOf(run, 'T5').state).toBe('failed');
      expect(run.haltedByUser).toBe(false);
      expect(hasFailedTask(run)).toBe(true);
      expect(isRunHalted(run)).toBe(true);

      // 人がT1の衝突を手元で解決し、再マージを指示する
      run = retryMergeState(run, 'T1');
      expect(stateOf(run, 'T1').state).toBe('merging');
      run = markMergeSucceeded(run, tasks, 'T1');
      expect(stateOf(run, 'T1').state).toBe('done');

      // pendingへ戻さず、skipped(runHalted)のままにする
      expect(stateOf(run, 'T2').state).toBe('skipped');
      expect(stateOf(run, 'T2').failure).toEqual({ kind: 'runHalted' });

      // getRunOutcomeが`running`のまま固着せず、`failed`として終端に達する
      expect(getRunOutcome(run)).toBe('failed');
    });

    /**
     * Issue #527: 複数の親からブロックされた後続が、停止解除後に自動復帰しない。
     *
     * Issue本文の再現手順5ステップをそのまま自動テストにしたもの（Issue自身の受入基準）。
     * T4はT2・T6の2つの親に依存する合流タスク。T2の再マージ成功時点で、`isRunHalted`が
     * 真のため`markMergeSucceeded`はT4の`failure.kind`を`mergeBlocked`から`runHalted`へ
     * 書き換える（Issue #432-1の意図どおり）。その後、停止が別経路（T5への`retryTask`）で
     * 解除されてからT6の再マージが成功しても、現状のフィルタ
     * （`s.failure?.kind !== 'mergeBlocked'`）はT4の`failure.kind`がもう`mergeBlocked`
     * ではない（`runHalted`のまま）ことを理由にT4を素通りし、`pending`へ戻さない。
     *
     * このテストは修正前のコードでは失敗する（RED）。T4が`pending`へ戻らないままの
     * 現状を再現する。
     */
    it('（Issue #527）2つの親からmergeBlockedされた後続が、停止解除後の再マージ成功で自動復帰する', () => {
      const tasks: WorkflowTask[] = [
        task('T1', []),
        task('T2', ['T1']),
        task('T6', ['T1']),
        task('T4', ['T2', 'T6']),
        // haltedByUser解除に使う、T4とは無関係な独立タスク（回数切れで確定失敗させる）
        task('T5', []),
      ];
      const d: WorkflowDefinition = { version: 1, name: 'テスト', maxParallel: 3, tasks };

      // 1. T4がT2・T6の両方のmergeBlockedでskippedになっている状態を作る
      let run = createRunState(tasks);
      run = toMerging(tasks, 'T1', run);
      run = markMergeSucceeded(run, tasks, 'T1');
      run = toMerging(tasks, 'T2', run);
      run = toMerging(tasks, 'T6', run);
      run = markMergeBlocked(run, tasks, 'T2');
      run = markMergeBlocked(run, tasks, 'T6');
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'mergeBlocked',
        blockedTaskIds: ['T2', 'T6'],
      });

      // T5を回数切れで確定失敗させておく（後でretryTaskの対象にする）
      run = markRunning(run, 'T5');
      run = applyLoopStopReason(run, tasks, 'T5', 'maxReached');
      expect(stateOf(run, 'T5').state).toBe('failed');

      // 2. 停止（haltedByUser）中にT2を再マージして成功させる
      run = { ...run, haltedByUser: true };
      run = retryMergeState(run, 'T2');
      run = markMergeSucceeded(run, tasks, 'T2');
      expect(stateOf(run, 'T2').state).toBe('done');
      // isRunHalted中なのでpendingへは戻らず、runHaltedへ倒れる
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'runHalted' });

      // 3. T4自身ではない別のタスク（T5）へretryTaskを呼び、haltedByUserを解除する
      run = retryTask(run, tasks, 'T5');
      expect(run.haltedByUser).toBe(false);
      expect(hasFailedTask(run)).toBe(false);
      expect(isRunHalted(run)).toBe(false);

      // 4. T6のマージを成功させる
      run = retryMergeState(run, 'T6');
      run = markMergeSucceeded(run, tasks, 'T6');
      expect(stateOf(run, 'T6').state).toBe('done');

      // 5. T4は自動でpendingへ戻る（依存する親T2・T6が両方done）べきである
      expect(stateOf(run, 'T4').state).toBe('pending');
      expect(stateOf(run, 'T4').failure).toBeUndefined();

      // 戻したpendingが孤立しない（PR #517の不変条件）：nextTasksToStartに実際に拾われる
      expect(nextTasksToStart(d, run)).toContain('T4');
      expect(getRunOutcome(run)).toBe('running');
    });
  });

  describe('markMergeBlocked', () => {
    it('mergingのタスクをblockedにし、直接依存する後続をskipped(mergeBlocked)にする', () => {
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T2');
      run = markMergeBlocked(run, tasks, 'T2');

      expect(stateOf(run, 'T2').state).toBe('blocked');
      expect(stateOf(run, 'T3').state).toBe('skipped');
      expect(stateOf(run, 'T3').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });
    });

    it('failedと違い、実行全体は止めない（無関係な独立した枝のpendingはそのまま）', () => {
      const tasks = [...chainTasks(), task('T5', [])];
      let run = toMerging(tasks, 'T2');
      run = markMergeBlocked(run, tasks, 'T2');

      expect(isRunHalted(run)).toBe(false);
      expect(hasFailedTask(run)).toBe(false);
      expect(stateOf(run, 'T5').state).toBe('pending'); // markFailedと違いrunHaltedにされない
    });

    it('複数の親がblockedになると、合流タスクのblockedTaskIdsに両方入る', () => {
      const tasks = [
        task('T1', []),
        task('T2', ['T1']),
        task('T3', ['T1']),
        task('T4', ['T2', 'T3']),
      ];
      let run = toMerging(tasks, 'T1');
      run = markMergeSucceeded(run, tasks, 'T1');
      run = toMerging(tasks, 'T2', run);
      run = toMerging(tasks, 'T3', run);
      run = markMergeBlocked(run, tasks, 'T2');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });

      run = markMergeBlocked(run, tasks, 'T3');
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'mergeBlocked',
        blockedTaskIds: ['T2', 'T3'],
      });
    });

    it('merging以外の状態には効かない', () => {
      const tasks = chainTasks();
      const run = createRunState(tasks); // T1はpending
      expect(markMergeBlocked(run, tasks, 'T1')).toBe(run);
    });
  });

  /**
   * Issue #443（案A）: 人が衝突解決セッションを止めたとき（`manual`/`interrupted`/
   * `taskStopped`）、実行層（`runnerMerge.ts`の`finishMergeResolution`）は
   * `applyLoopStopReason(run, tasks, '', haltReason)`の**後**に`markMergeBlocked`を呼ぶ。
   * この2関数の組み合わせが実際にどう状態を変えるかを、純粋ロジック側で確かめる
   * （実行層のテストは`runner.test.ts`側の統合テストが担う）。
   */
  describe('人が止めた衝突解決の後始末（applyLoopStopReasonの後にmarkMergeBlocked、Issue #443）', () => {
    it('mergingのタスクをblockedにし、runは終了状態へ確定する（git merge --abort相当は呼ばない）', () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = finishDone(run, tasks, 'T1'); // T1: done
      run = toMerging(tasks, 'T2', run); // T2: merging

      run = applyLoopStopReason(run, tasks, '', 'manual');
      run = markMergeBlocked(run, tasks, 'T2');

      expect(stateOf(run, 'T2').state).toBe('blocked');
      expect(stateOf(run, 'T2').failure).toBeUndefined();
      expect(run.haltedByUser).toBe(true);
      // `merging`が無くなったので`getRunOutcome`は`running`を返し続けない
      expect(getRunOutcome(run)).not.toBe('running');
      // `blocked`になった以上「再マージ」の対象にできる
      expect(stateOf(retryMergeState(run, 'T2'), 'T2').state).toBe('merging');
    });

    it('順序どおりなら、依存する後続はrunHaltedのままでmergeBlockedに上書きされない', () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = finishDone(run, tasks, 'T1'); // T1: done
      run = toMerging(tasks, 'T2', run); // T2: merging。T3・T4はまだpending

      // 1. 先にapplyLoopStopReasonが`pending`のT3・T4をskipped(runHalted)にする
      run = applyLoopStopReason(run, tasks, '', 'manual');
      expect(stateOf(run, 'T3').state).toBe('skipped');
      expect(stateOf(run, 'T3').failure).toEqual({ kind: 'runHalted' });
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'runHalted' });

      // 2. 後からmarkMergeBlockedを呼んでも、T3・T4は既に`pending`ではないため
      //    `appendCascadeTaskId`はkind不一致（'runHalted' !== 'mergeBlocked'）で何もしない
      run = markMergeBlocked(run, tasks, 'T2');
      expect(stateOf(run, 'T3').state).toBe('skipped');
      expect(stateOf(run, 'T3').failure).toEqual({ kind: 'runHalted' });
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({ kind: 'runHalted' });
    });

    it('逆順（markMergeBlockedを先に呼ぶ）だと、後続はmergeBlockedとして記録されてしまう（順序に意味がある証拠）', () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = finishDone(run, tasks, 'T1');
      run = toMerging(tasks, 'T2', run);

      // 逆順: markMergeBlockedを先に呼ぶと、pendingのT3・T4はmergeBlockedとして
      // skippedになる
      run = markMergeBlocked(run, tasks, 'T2');
      expect(stateOf(run, 'T3').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });

      // 後からapplyLoopStopReasonのskipRemainingPendingを呼んでも、対象は`pending`
      // だけなので、既に`skipped`のT3・T4には触れない（`runHalted`へは倒れない）
      run = applyLoopStopReason(run, tasks, '', 'manual');
      expect(stateOf(run, 'T3').failure).toEqual({ kind: 'mergeBlocked', blockedTaskIds: ['T2'] });
    });
  });

  describe('markMergeFailed', () => {
    it('mergingのタスクをfailedにし、failedと同じく依存する後続をskipped・実行全体を停止する', () => {
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T2');
      run = markMergeFailed(run, tasks, 'T2');

      const t2 = stateOf(run, 'T2');
      expect(t2.state).toBe('failed');
      expect(t2.failure).toEqual({ kind: 'mergeFailed' });
      expect(stateOf(run, 'T4').state).toBe('skipped');
      expect(stateOf(run, 'T4').failure).toEqual({
        kind: 'dependencyFailed',
        failedTaskIds: ['T2'],
      });
      expect(isRunHalted(run)).toBe(true);
      expect(hasFailedTask(run)).toBe(true);
    });

    it('merging以外の状態には効かない', () => {
      const tasks = chainTasks();
      const run = createRunState(tasks); // T1はpending
      expect(markMergeFailed(run, tasks, 'T1')).toBe(run);
    });
  });

  describe('retryMergeState（再マージ）', () => {
    it('blockedのタスクをmergingへ戻す', () => {
      const tasks = chainTasks();
      let run = toMerging(tasks, 'T2');
      run = markMergeBlocked(run, tasks, 'T2');
      expect(stateOf(run, 'T2').state).toBe('blocked');

      run = retryMergeState(run, 'T2');
      expect(stateOf(run, 'T2').state).toBe('merging');
      expect(stateOf(run, 'T2').failure).toBeUndefined();
    });

    it('blocked以外の状態には効かない', () => {
      const tasks = chainTasks();
      const run = createRunState(tasks); // T1はpending
      expect(retryMergeState(run, 'T1')).toBe(run);
      expect(retryMergeState(run, 'unknown')).toBe(run);
    });
  });
});

describe('continueTask（回数切れから続ける、issue #284）', () => {
  it('回数切れのfailedをrunningへ戻し、依存するskippedもpendingへ戻す', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = recordSubmissionCount(run, 'T2', 20);
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached'); // T2: failed, T3・T4: skipped

    const continued = continueTask(run, tasks, 'T2');
    expect(stateOf(continued, 'T2').state).toBe('running');
    expect(stateOf(continued, 'T2').failure).toBeUndefined();
    expect(stateOf(continued, 'T3').state).toBe('pending');
    expect(stateOf(continued, 'T4').state).toBe('pending');
    expect(isRunHalted(continued)).toBe(false);
    // worktreeもブランチも作り直さないため試行の回数は増やさず、送信回数も通算のまま残す
    expect(stateOf(continued, 'T2').manualRetryCount).toBe(0);
    expect(stateOf(continued, 'T2').retryCount).toBe(0);
    expect(stateOf(continued, 'T2').submissionCount).toBe(20);
  });

  it('回数切れ以外の失敗は対象外で、何も変えない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'taskStopped'); // manualStop
    expect(stateOf(run, 'T1').failure).toEqual({ kind: 'manualStop' });

    expect(continueTask(run, tasks, 'T1')).toBe(run);
  });

  it('running・done・skippedのタスクは対象外で、何も変えない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    expect(continueTask(run, tasks, 'T1')).toBe(run);

    run = finishDone(run, tasks, 'T1');
    expect(continueTask(run, tasks, 'T1')).toBe(run);

    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');
    expect(stateOf(run, 'T3').state).toBe('skipped');
    expect(continueTask(run, tasks, 'T3')).toBe(run);
  });

  it('依存が全てdoneでなければ戻せない', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T2');
    run = applyLoopStopReason(run, tasks, 'T2', 'maxReached');

    expect(stateOf(run, 'T1').state).not.toBe('done');
    expect(continueTask(run, tasks, 'T2')).toBe(run);
  });

  it('haltedByUserを解除する（人の明示操作を再開の合図として扱う。retryTaskと同じ）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = applyLoopStopReason(run, tasks, 'T1', 'maxReached');
    run = { ...run, haltedByUser: true };

    expect(continueTask(run, tasks, 'T1').haltedByUser).toBe(false);
  });

  it('停滞（stalled）もmaxReachedと同じくrunningへ戻せる（design.md §16.27、Issue #336）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = markRunning(run, 'T1');
    run = finishDone(run, tasks, 'T1');
    run = markRunning(run, 'T2');
    run = recordSubmissionCount(run, 'T2', 5);
    run = applyLoopStopReason(run, tasks, 'T2', 'stalled'); // T2: failed(stalled), T3・T4: skipped

    const continued = continueTask(run, tasks, 'T2');
    expect(stateOf(continued, 'T2').state).toBe('running');
    expect(stateOf(continued, 'T2').failure).toBeUndefined();
    expect(stateOf(continued, 'T3').state).toBe('pending');
    expect(stateOf(continued, 'T2').manualRetryCount).toBe(0);
    expect(stateOf(continued, 'T2').submissionCount).toBe(5);
  });
});

describe('applyAutoResume（design.md §16.35、roadmap W10、Issue #584）', () => {
  const withTaskState = (run: RunState, id: string, patch: Partial<TaskRunState>): RunState => {
    const tasks = new Map(run.tasks);
    tasks.set(id, { ...stateOf(run, id), ...patch });
    return { ...run, tasks };
  };

  it(
    'reloadInterrupted(failed)のタスクをpendingへ戻し、manualRetryCountを1増やす' +
      '（worktree名を変えてbranchExistsとの衝突を避けるため。retryCountは増やさない）',
    () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = withTaskState(run, 'T1', {
        state: 'failed',
        failure: { kind: 'reloadInterrupted' },
        submissionCount: 3,
      });

      const outcome = applyAutoResume(run, tasks);
      expect(outcome.kind).toBe('resumed');
      if (outcome.kind !== 'resumed') {
        throw new Error('unreachable');
      }
      expect(outcome.resumedTaskIds).toEqual(['T1']);
      expect(stateOf(outcome.run, 'T1').state).toBe('pending');
      expect(stateOf(outcome.run, 'T1').failure).toBeUndefined();
      expect(stateOf(outcome.run, 'T1').retryCount).toBe(0);
      expect(stateOf(outcome.run, 'T1').manualRetryCount).toBe(1);
      expect(stateOf(outcome.run, 'T1').submissionCount).toBe(0);
    },
  );

  it(
    '自動再開はretries（自動再試行の予算）を消費しない: retries:1のタスクが' +
      'リロードで中断→自動再開したあと、本物の理由(loopFailed)で失敗しても、' +
      'まだ自動再試行の権利が残っているため`failed`ではなく`pending`へ戻る' +
      '（レビュー指摘。2026-08-23。retryCountを進めていると自動再試行の予算を' +
      'リロードが黙って1回消費してしまい、ここが`failed`のまま確定してしまう）',
    () => {
      const tasksWithRetry = [task('T1', [], 1)];
      let run = createRunState(tasksWithRetry);
      run = withTaskState(run, 'T1', {
        state: 'failed',
        failure: { kind: 'reloadInterrupted' },
      });

      const outcome = applyAutoResume(run, tasksWithRetry);
      expect(outcome.kind).toBe('resumed');
      if (outcome.kind !== 'resumed') {
        throw new Error('unreachable');
      }
      // 自動再開の直後、retries自体はまだ1回も消費していない
      expect(stateOf(outcome.run, 'T1').retryCount).toBe(0);

      // 自動再開後、そのタスクが本物の理由(loopFailed)で失敗した
      const afterFail = applyLoopStopReason(outcome.run, tasksWithRetry, 'T1', 'failed');

      // retries:1の予算をまだ使い切っていないため、自動再試行でpendingへ戻る
      expect(stateOf(afterFail, 'T1').state).toBe('pending');
      expect(stateOf(afterFail, 'T1').retryCount).toBe(1);
    },
  );

  it('reloadInterruptedで実行全体が止まったためskipped(runHalted)になっていた後続もpendingへ戻す', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = withTaskState(run, 'T1', { state: 'done' });
    run = withTaskState(run, 'T2', { state: 'failed', failure: { kind: 'reloadInterrupted' } });
    run = withTaskState(run, 'T3', { state: 'skipped', failure: { kind: 'runHalted' } });
    run = withTaskState(run, 'T4', { state: 'skipped', failure: { kind: 'runHalted' } });

    const outcome = applyAutoResume(run, tasks);
    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') {
      throw new Error('unreachable');
    }
    expect(new Set(outcome.resumedTaskIds)).toEqual(new Set(['T2', 'T3', 'T4']));
    expect(stateOf(outcome.run, 'T3').state).toBe('pending');
    expect(stateOf(outcome.run, 'T4').state).toBe('pending');
  });

  it('dependencyFailed／mergeBlockedによるskippedは戻さない（reload起因のrunHaltedだけを戻す）', () => {
    const tasks = chainTasks();
    let run = createRunState(tasks);
    run = withTaskState(run, 'T2', { state: 'failed', failure: { kind: 'reloadInterrupted' } });
    run = withTaskState(run, 'T3', {
      state: 'skipped',
      failure: { kind: 'dependencyFailed', failedTaskIds: ['X'] },
    });

    const outcome = applyAutoResume(run, tasks);
    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') {
      throw new Error('unreachable');
    }
    expect(outcome.resumedTaskIds).toEqual(['T2']);
    expect(stateOf(outcome.run, 'T3').state).toBe('skipped');
  });

  it(
    'reloadInterrupted以外の理由でfailedのタスクが1件でもあれば自動再開をあきらめる' +
      '（isRunHaltedが引き続き真のままになり、戻したpendingがnextTasksToStartに拾われず' +
      '迷子になるため。markMergeSucceededの不変条件と同じ）',
    () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = withTaskState(run, 'T1', { state: 'failed', failure: { kind: 'loopFailed' } });
      run = withTaskState(run, 'T2', { state: 'failed', failure: { kind: 'reloadInterrupted' } });

      const outcome = applyAutoResume(run, tasks);
      expect(outcome.kind).toBe('blockedByOtherFailure');
      expect(stateOf(run, 'T2').state).toBe('failed');
    },
  );

  it(
    'taskApprovalTimedOutは他の理由と同様に自動再開をあきらめさせる' +
      '（W10のスコープには含めない。design.md §16.39・applyAutoResumeのホワイトリストは無改修）',
    () => {
      const tasks = chainTasks();
      let run = createRunState(tasks);
      run = withTaskState(run, 'T1', { state: 'failed', failure: { kind: 'taskApprovalTimedOut' } });
      run = withTaskState(run, 'T2', { state: 'failed', failure: { kind: 'reloadInterrupted' } });

      const outcome = applyAutoResume(run, tasks);
      expect(outcome.kind).toBe('blockedByOtherFailure');
      expect(stateOf(run, 'T1').state).toBe('failed');
      expect(stateOf(run, 'T2').state).toBe('failed');
    },
  );

  it('reloadInterruptedなタスクが1件も無ければ何もしない', () => {
    const tasks = chainTasks();
    const run = createRunState(tasks);
    const outcome = applyAutoResume(run, tasks);
    expect(outcome.kind).toBe('nothingToResume');
  });

  it(
    'allowを持つタスクがreloadInterruptedで止まっていれば、run全体の自動再開をあきらめる' +
      '（人が居ないため危険操作の実行前確認ができない。start()/retryTaskと同じ規約）',
    () => {
      const tasksWithAllow = [
        { ...task('T1', []), allow: ['npm test'] },
        task('T2', ['T1']),
      ];
      let run = createRunState(tasksWithAllow);
      run = withTaskState(run, 'T1', { state: 'failed', failure: { kind: 'reloadInterrupted' } });

      const outcome = applyAutoResume(run, tasksWithAllow);
      expect(outcome.kind).toBe('blockedByAllowGate');
      if (outcome.kind !== 'blockedByAllowGate') {
        throw new Error('unreachable');
      }
      expect(outcome.taskIds).toEqual(['T1']);
    },
  );
});
