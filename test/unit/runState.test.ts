import { describe, expect, it } from 'vitest';

import {
  applyLoopStopReason,
  createRunState,
  hasFailedTask,
  isRunHalted,
  markApprovalRejected,
  markMergeBlocked,
  markMergeFailed,
  markMergeSucceeded,
  markRunning,
  markWaitingApproval,
  markWaitingReply,
  recordSubmissionCount,
  resumeFromApproval,
  resumeFromWaitingReply,
  retryMergeState,
  retryTask,
  type RunState,
  type TaskRunState,
} from '../../src/orchestrator/runState';
import type { WorkflowTask } from '../../src/orchestrator/workflow';

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
