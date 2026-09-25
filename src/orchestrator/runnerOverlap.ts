import { commitUncommittedChangesIfNeeded } from './integration';
import {
  isActiveTaskState,
  markWaitingOverlap,
  resumeFromWaitingOverlap,
  type TaskState,
} from './runState';
import type { LiveRun, LiveTask } from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';
import {
  DEFAULT_OVERLAP_CHECK_INTERVAL_SEC,
  findOverlapWaits,
  isOverlapHoldingState,
  measureWorktreeFiles,
  type OverlapEntry,
} from './taskOverlap';
import { resolveHeadCommit } from './worktree';

/**
 * 走行中のタスク同士の変更ファイルの交差を実測し、後から走り始めた方を待たせ、先に
 * 走り始めた方のマージ後に再開する（Issue #1469、ロードマップH2）。
 *
 * - 実測はターンの確定時（`onTaskStateChanged`）と一定間隔（`startOverlapPoll`）
 * - 対象はgitのworktreeで走るタスクだけ。疑似worktree（design.md §16.20）は3-way mergeが
 *   できず、両方が変えたファイルは待っても統合時に`pseudoWorktreeConflict`になるため、
 *   待たせる意味が無い。`shared`・明示`cwd`は他のタスクと作業ディレクトリを共有しており、
 *   タスクごとの変更を分けて測れない
 * - `waitingOverlap`は並列枠を占めない（`isActiveTaskState`に含めない）。待っている間は
 *   交差していない別のタスクへ枠を譲る
 */

function isMeasurable(liveTask: LiveTask): boolean {
  return liveTask.usedWorktree && liveTask.originCommit !== '';
}

/**
 * 走行中のタスクの変更ファイルを測り直し、交差していれば後発を待たせる。
 * 同じrunで測定が重なったときは後から来た方を捨てる（次のターン確定・次の周期で測り直す）。
 */
export async function checkTaskOverlap(
  self: WorkflowRunnerInternals,
  runId: string,
): Promise<void> {
  const live = self.runs.get(runId);
  if (live === undefined || live.finished || live.overlapMeasuring) {
    return;
  }
  live.overlapMeasuring = true;
  try {
    // `merging`のタスクはworktreeがマージの途中にあり得るため測り直さず、直前の実測値を使う
    const targets = [...live.tasks.entries()].filter(([taskId, liveTask]) => {
      const state = live.runState.tasks.get(taskId)?.state;
      return isOverlapHoldingState(state) && state !== 'merging' && isMeasurable(liveTask);
    });
    await Promise.all(
      targets.map(async ([, liveTask]) => {
        const files = await measureWorktreeFiles(
          self.deps.git,
          liveTask.cwd,
          liveTask.originCommit,
        );
        if (files !== undefined) {
          liveTask.touchedFiles = files;
        }
      }),
    );
  } finally {
    live.overlapMeasuring = false;
  }
  if (self.isDisposing() || self.runs.get(runId) !== live || live.finished) {
    return;
  }
  applyOverlapWaits(self, runId, live);
}

function applyOverlapWaits(self: WorkflowRunnerInternals, runId: string, live: LiveRun): void {
  if (live.runState.haltedByUser) {
    return;
  }
  const entries: OverlapEntry[] = [];
  for (const [taskId, liveTask] of live.tasks) {
    const state = live.runState.tasks.get(taskId)?.state;
    if (state === undefined || liveTask.touchedFiles === undefined) {
      continue;
    }
    entries.push({ taskId, startSeq: liveTask.startSeq, state, files: liveTask.touchedFiles });
  }
  const waits = findOverlapWaits(entries, self.deps.readOverlapIgnore?.() ?? []);
  let changed = false;
  for (const [taskId, wait] of waits) {
    const liveTask = live.tasks.get(taskId);
    // 再開の取り込み中（`overlapResuming`）は、取り込み前の実測値で待たせ直さない
    if (liveTask === undefined || liveTask.overlapResuming) {
      continue;
    }
    live.runState = markWaitingOverlap(live.runState, taskId);
    liveTask.overlapWait = wait;
    // 進行中のターンには割り込まない。次のターンの送信を止める（`waitingReply`と同じ）
    liveTask.session.pauseLoop();
    self.deps.log.info(
      `[workflow ${runId}] ${taskId}: ${wait.withTaskId}と変更ファイルが交差したため、` +
        `${wait.withTaskId}のマージまで待機します（${wait.files.join(', ')}）`,
    );
    changed = true;
  }
  if (changed) {
    self.notify(runId);
    void self.persist(runId);
    // 待たせた分の枠が空いたので、pendingのタスクを開始できる
    self.pump(runId);
  }
}

/**
 * 相手がマージを終えた（または失敗・中止で統合ブランチへ入らないと確定した）待機中の
 * タスクを、並列枠の空きの範囲で先に走り始めた順に再開する。`pump`が`nextTasksToStart`の
 * 前に呼ぶ（新しいタスクの開始より、既に途中まで進めたタスクの再開を優先する）。
 *
 * ターンの途中で待機にしたタスクは、そのターンが終わるまで再開しない。worktreeへの
 * 取り込み（commit・merge）が走行中のエージェントの書き込みと重ならないようにするため。
 *
 * 人が止めたrun（`haltedByUser`）では再開しない（`stop()`が待機中のセッションにも
 * `stopLoop`を送っている）。他のタスクの`failed`で止まったrunでは、走行中のタスクと同じく
 * 最後まで走らせる。再開しないと`waitingOverlap`が残り、runが終わらない。
 */
export function releaseOverlapWaits(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
  excludeFromActiveCount: ReadonlySet<string>,
): void {
  if (live.runState.haltedByUser) {
    return;
  }
  let activeCount = 0;
  for (const [taskId, s] of live.runState.tasks) {
    if (isActiveTaskState(s.state) && !excludeFromActiveCount.has(taskId)) {
      activeCount += 1;
    }
  }
  let capacity = live.def.maxParallel - activeCount;
  const releasable = [...live.tasks.entries()]
    .filter(([taskId, liveTask]) => {
      const wait = liveTask.overlapWait;
      return (
        live.runState.tasks.get(taskId)?.state === 'waitingOverlap' &&
        wait !== undefined &&
        !isOverlapHoldingState(live.runState.tasks.get(wait.withTaskId)?.state) &&
        !liveTask.wasBusy
      );
    })
    .sort(([, a], [, b]) => a.startSeq - b.startSeq);
  for (const [taskId, liveTask] of releasable) {
    if (capacity <= 0) {
      break;
    }
    capacity -= 1;
    const withTaskId = liveTask.overlapWait?.withTaskId ?? '';
    const leaderState = live.runState.tasks.get(withTaskId)?.state;
    // 取り込みの完了を待たずに`running`へ倒して枠を確保する（`markRunning`と同じ理由）
    live.runState = resumeFromWaitingOverlap(live.runState, taskId);
    liveTask.overlapWait = undefined;
    liveTask.overlapResuming = true;
    void resumeAfterOverlap(self, runId, live, taskId, liveTask, withTaskId, leaderState);
  }
}

async function resumeAfterOverlap(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
  taskId: string,
  liveTask: LiveTask,
  withTaskId: string,
  leaderState: TaskState | undefined,
): Promise<void> {
  try {
    if (leaderState === 'done' && isMeasurable(liveTask) && live.integration !== undefined) {
      await mergeIntegrationIntoTask(self, runId, live, taskId, liveTask, withTaskId);
    }
  } finally {
    liveTask.overlapResuming = false;
    const current = self.runs.get(runId);
    if (
      !self.isDisposing() &&
      current === live &&
      live.tasks.get(taskId) === liveTask &&
      live.runState.tasks.get(taskId)?.state === 'running' &&
      !live.runState.haltedByUser
    ) {
      self.deps.log.info(`[workflow ${runId}] ${taskId}: 交差の待機を解いて再開します`);
      liveTask.session.resumeLoop();
    }
    if (current === live) {
      self.notify(runId);
      void self.persist(runId);
      self.pump(runId);
    }
  }
}

/**
 * 相手のマージ後の統合ブランチを、待たせていたタスクのブランチへ取り込む。取り込めれば
 * 分岐元（`originCommit`）を取り込んだコミットへ進める（以後の実測と、最終マージ時の
 * 衝突解決で突き合わせる相手の特定がこのコミットを基準にする）。
 *
 * 衝突したら取り込みを取り消して元のまま再開する。衝突の解決は最終マージ時の既存の
 * 衝突解決（design.md §16.17）へ回す。
 */
async function mergeIntegrationIntoTask(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
  taskId: string,
  liveTask: LiveTask,
  withTaskId: string,
): Promise<void> {
  const integration = live.integration;
  if (integration === undefined) {
    return;
  }
  const git = self.deps.git;
  const warn = (detail: string): void => {
    live.warnings.push({
      kind: 'overlapSyncFailed',
      taskId,
      message: `${withTaskId}のマージ後の統合ブランチを取り込めませんでした（${detail}）。取り込まずに再開します`,
    });
    self.deps.log.warn(`[workflow ${runId}] ${taskId}: 統合ブランチの取り込みに失敗: ${detail}`);
  };
  try {
    const committed = await commitUncommittedChangesIfNeeded(liveTask.cwd, taskId, git);
    if (!committed.ok) {
      warn(committed.message);
      return;
    }
    const head = await resolveHeadCommit(integration.cwd, git);
    if (head === undefined) {
      warn('統合ブランチのHEADを解決できません');
      return;
    }
    const merged = await git.run(['merge', '--no-ff', '--no-edit', head], liveTask.cwd);
    if (merged.code !== 0) {
      await git.run(['merge', '--abort'], liveTask.cwd);
      warn(`git merge が終了コード ${merged.code} で失敗`);
      return;
    }
    liveTask.originCommit = head;
    self.deps.log.info(
      `[workflow ${runId}] ${taskId}: ${withTaskId}のマージ後の統合ブランチ（${head.slice(0, 12)}）を取り込みました`,
    );
  } catch (e) {
    warn(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 一定間隔の実測を始める。ターンの確定を待たずに、長いターンの途中で交差したタスクも
 * 次の周期で拾う。0以下なら周期では測らない（ターンの確定時だけになる）。
 */
export function startOverlapPoll(self: WorkflowRunnerInternals, runId: string, live: LiveRun): void {
  if (live.overlapPollTimer !== undefined || live.finished) {
    return;
  }
  const intervalSec =
    self.deps.readOverlapCheckIntervalSec?.() ?? DEFAULT_OVERLAP_CHECK_INTERVAL_SEC;
  if (!(intervalSec > 0)) {
    return;
  }
  const timer = setInterval(() => {
    if (live.finished || self.runs.get(runId) !== live) {
      clearInterval(timer);
      live.overlapPollTimer = undefined;
      return;
    }
    void checkTaskOverlap(self, runId);
  }, intervalSec * 1000);
  timer.unref?.();
  live.overlapPollTimer = timer;
}

/**
 * 一定間隔の実測を止める。runの終了と`dispose()`が呼ぶ。`retryTask`等でrunを再開したときは
 * `pump`の`startOverlapPoll`が張り直す。
 */
export function stopOverlapPoll(live: LiveRun): void {
  if (live.overlapPollTimer === undefined) {
    return;
  }
  clearInterval(live.overlapPollTimer);
  live.overlapPollTimer = undefined;
}
