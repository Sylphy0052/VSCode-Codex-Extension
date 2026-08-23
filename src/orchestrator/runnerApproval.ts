import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * `agent.workflows.taskApprovalTimeoutSec`の既定値（Issue #579、design.md §16.39）。
 * 既定1時間。`runnerMerge.ts`の`DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC`（衝突解決セッション用、
 * 同じく既定1時間）と値は揃えたが、キーは別物（design.md §16.39「なぜ別のキーか」参照）。
 * LLMが作業中（承認待ちで**ない**）の時間はこの計測に含まれない
 * （`waitingApprovalSinceMs`が`undefined`の間はタイマーを張らない）。
 */
export const DEFAULT_TASK_APPROVAL_TIMEOUT_SEC = 3600;

/**
 * 通常タスクの`waitingApprovalSinceMs`が変わるたび（承認待ちに入る／抜ける）に呼ぶ。
 * `runnerMerge.ts`の`scheduleApprovalTimeout`（衝突解決セッション用）と同じ形: 既存の
 * タイマーを必ず先に消してから、承認待ちに入った場合だけ新しいタイマーを張り直す
 * （`agent.workflows.taskApprovalTimeoutSec`秒後に`handleTaskApprovalTimeout`を呼ぶ）。
 *
 * ポーリング（`checkWaitingReplyStalls`の`WAITING_REPLY_POLL_INTERVAL_MS`）ではなく
 * エントリごとの`setTimeout`にしてあるのは、`scheduleApprovalTimeout`と同じ理由:
 * `live.messaging`（タスク間メッセージング、省略可能）とは無関係に常に効かせるため
 * （メッセージングを使わない実行でタイムアウトが一切効かなくなるのを避ける）。
 */
export function scheduleTaskApprovalTimeout(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  previous: ReturnType<typeof setTimeout> | undefined,
  waitingApprovalSinceMs: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (previous !== undefined) {
    clearTimeout(previous);
  }
  if (waitingApprovalSinceMs === undefined) {
    return undefined;
  }
  const timeoutSec = self.deps.readTaskApprovalTimeoutSec?.() ?? DEFAULT_TASK_APPROVAL_TIMEOUT_SEC;
  const timer = setTimeout(
    () => handleTaskApprovalTimeout(self, runId, taskId, waitingApprovalSinceMs),
    timeoutSec * 1000,
  );
  // `scheduleApprovalTimeout`（`runnerMerge.ts`）と同じく、テスト・プロセス終了を
  // 妨げないようにする
  timer.unref?.();
  return timer;
}

/**
 * 通常タスクの承認待ちタイムアウトの本体（Issue #579、design.md §16.39）。
 * `agent.workflows.taskApprovalTimeoutSec`を超えたら`liveTask.session.stopLoop()`を呼び、
 * 通常の完了検知経路（`onFinished`→`runner.ts`の`onTaskFinished`）へ合流させる。
 *
 * `TaskSession.stopLoop()`は理由を`'taskStopped'`としてしか`onFinished`へ伝えられない
 * ため（`runnerMerge.ts`の`handleMergeApprovalTimeout`と同じ制約）、`stopLoop()`を呼ぶ
 * 直前に`liveTask.taskApprovalTimedOut`を立てておき、`onTaskFinished`側がその印を見て
 * `applyLoopStopReason(..., 'taskStopped')`（＝`manualStop`）ではなく
 * `markTaskApprovalTimedOut`へ分岐する。
 *
 * `waitingApprovalSinceMs`は張った時点の値をそのまま比較する（`scheduleApprovalTimeout`の
 * JSDoc「多層防御」と同じ理由）。加えて、対象タスクが実際にまだ`waitingApproval`である
 * ことも確認する（`stopTask`/`stop`など承認以外の経路でこの状態を抜けていた場合の多層
 * 防御。`live.tasks`のエントリは`onTaskFinished`後も消えないため、`live.mergeResolutions`
 * のような「エントリが無ければ戻る」だけでは守れない）。
 */
function handleTaskApprovalTimeout(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  scheduledForWaitingApprovalSinceMs: number,
): void {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  const liveTask = live.tasks.get(taskId);
  if (
    liveTask === undefined ||
    liveTask.waitingApprovalSinceMs !== scheduledForWaitingApprovalSinceMs
  ) {
    // 既に承認待ちを抜けた、または新しい承認待ちへ張り替わった後（多層防御。上のJSDoc参照）
    return;
  }
  if (live.runState.tasks.get(taskId)?.state !== 'waitingApproval') {
    // 承認以外の経路（`stopTask`・`stop`等）で既にこの状態を抜けている
    return;
  }
  self.deps.log.warn(
    `[workflow ${runId}/${taskId}] 承認待ちがタイムアウト（${
      self.deps.readTaskApprovalTimeoutSec?.() ?? DEFAULT_TASK_APPROVAL_TIMEOUT_SEC
    }秒）を超えたため、タスクを停止します`,
  );
  liveTask.taskApprovalTimedOut = true;
  liveTask.session.stopLoop();
}
