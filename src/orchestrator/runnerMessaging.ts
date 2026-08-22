import {
  buildStalledWaitingReplyWarning,
  detectAllWaitingStalemate,
  detectTimedOutWaitingReplies,
  DEFAULT_REPLY_TIMEOUT_SEC,
  type RunTaskSnapshot,
  type StoredMessage,
} from './messaging';
import { isActiveTaskState, markWaitingReply, resumeFromWaitingReply, type TaskState } from './runState';
import type { TaskSession } from './taskSession';
import type { LiveRun } from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * タスク間メッセージング（design.md §16.21、Issue #147）を集めたモジュール。
 * `WorkflowRunner`から機能単位で切り出した1本。
 *
 * `self: WorkflowRunnerInternals`を第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に
 * 切り出したままの形を保ち、挙動を変えないため（最終報告に記載）。
 */

/** `TaskMessagingHub`の`list_tasks`が返す一覧を組み立てる（design.md §16.21）。 */
export function buildRunTaskSnapshots(self: WorkflowRunnerInternals, runId: string): RunTaskSnapshot[] {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return [];
  }
  return live.def.tasks.map((t) => ({
    id: t.id,
    state: live.runState.tasks.get(t.id)?.state ?? 'pending',
    summary: live.tasks.get(t.id)?.lastResponseSummary ?? '',
  }));
}

/**
 * `TaskMessagingHub`が`send_message`を受け付けた直後に呼ばれる（`WorkflowRunnerMessagingDeps`
 * のJSDoc、design.md §16.21）。
 *
 * - `expectReply: true`なら送信元タスクを`waitingReply`へ倒し、実際にループを一時停止する
 *   （`session.pauseLoop()`。状態だけを倒さない。#105が避けた「実際には止まっていないのに
 *   止まっていると偽る」問題への対応）
 * - 宛先タスクが`waitingReply`であれば、この配送で再開してよいので`running`へ戻し
 *   （`resumeFromWaitingReply`）、ループを再開する（`session.resumeLoop()`。返信の本文自体は
 *   `setPromptTransform`の`composeNextPrompt`が次の送信へ添える）
 */
export function onMessageAccepted(self: WorkflowRunnerInternals, runId: string, message: StoredMessage): void {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  let changed = false;

  if (message.expectReply) {
    const senderTask = live.tasks.get(message.from);
    const senderState = live.runState.tasks.get(message.from);
    if (senderTask !== undefined && senderState?.state === 'running') {
      live.runState = markWaitingReply(live.runState, message.from);
      senderTask.waitingReplySinceMs = (self.deps.now?.() ?? new Date()).getTime();
      senderTask.session.pauseLoop();
      changed = true;
    }
  }

  const recipientTask = live.tasks.get(message.to);
  const recipientState = live.runState.tasks.get(message.to);
  if (recipientTask !== undefined && recipientState?.state === 'waitingReply') {
    live.runState = resumeFromWaitingReply(live.runState, message.to);
    recipientTask.waitingReplySinceMs = undefined;
    recipientTask.session.resumeLoop();
    changed = true;
  }

  if (changed) {
    self.notify(runId);
    void self.persist(runId);
  }
}

/**
 * 待ちぼうけの2経路（design.md §16.21「待ちぼうけを検出する経路」）を確認し、解けていれば
 * `running`へ戻す。`WorkflowRunnerMessagingDeps.startTransport`と同時に登録したタイマー
 * （`WAITING_REPLY_POLL_INTERVAL_MS`ごと）から呼ばれる。
 */
export function checkWaitingReplyStalls(self: WorkflowRunnerInternals, runId: string): void {
  const live = self.runs.get(runId);
  if (live === undefined || live.messaging === undefined || live.finished) {
    return;
  }

  const activeStates = new Map<string, TaskState>();
  const waitingSinceMsByTaskId = new Map<string, number>();
  for (const [taskId, s] of live.runState.tasks) {
    if (isActiveTaskState(s.state)) {
      activeStates.set(taskId, s.state);
    }
    if (s.state === 'waitingReply') {
      const sinceMs = live.tasks.get(taskId)?.waitingReplySinceMs;
      if (sinceMs !== undefined) {
        waitingSinceMsByTaskId.set(taskId, sinceMs);
      }
    }
  }

  const nowMs = (self.deps.now?.() ?? new Date()).getTime();
  const replyTimeoutSec = self.deps.messaging?.readReplyTimeoutSec?.() ?? DEFAULT_REPLY_TIMEOUT_SEC;

  const stalemateIds = detectAllWaitingStalemate(
    activeStates,
    live.messaging.hub.totalUndeliveredCount(),
  );
  const timedOutIds = detectTimedOutWaitingReplies(waitingSinceMsByTaskId, nowMs, replyTimeoutSec);

  releaseStalledWaitingReplies(self, runId, live, stalemateIds, 'allWaiting');
  releaseStalledWaitingReplies(self, runId, live, timedOutIds, 'timeout');
}

/** `checkWaitingReplyStalls`が検出したtaskIdを実際に`running`へ戻し、警告を積む。 */
function releaseStalledWaitingReplies(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
  taskIds: readonly string[],
  reason: 'allWaiting' | 'timeout',
): void {
  const released: string[] = [];
  for (const taskId of taskIds) {
    const task = live.tasks.get(taskId);
    const state = live.runState.tasks.get(taskId);
    if (task === undefined || state?.state !== 'waitingReply') {
      continue;
    }
    live.runState = resumeFromWaitingReply(live.runState, taskId);
    task.waitingReplySinceMs = undefined;
    task.session.resumeLoop();
    released.push(taskId);
  }
  if (released.length === 0) {
    return;
  }
  live.warnings.push({
    kind: 'messagingStalled',
    taskId: undefined,
    message: buildStalledWaitingReplyWarning(released, reason),
  });
  self.notify(runId);
  void self.persist(runId);
}

/**
 * MCPツールの可視性確認（design.md §16.21「ツールの可視性の確認」）。見えなければ
 * ワークフローViewへ警告を出し、通信なしでそのまま走らせる（runは止めない）。
 * `startTask`が`await`せず投げっぱなしで呼ぶ（タスクの開始自体をこの確認で遅らせない）。
 */
export async function checkMessagingVisibility(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  session: TaskSession,
): Promise<void> {
  let visible: boolean;
  try {
    visible = await session.checkMessagingToolVisible();
  } catch {
    // 確認自体が失敗した場合も「見えない」側へ倒す（安全側の判断。最終報告に記載）
    visible = false;
  }
  if (visible) {
    return;
  }
  const live = self.runs.get(runId);
  if (live === undefined) {
    return;
  }
  live.warnings.push({
    kind: 'messagingUnavailable',
    taskId,
    message: `タスク間メッセージングのツールがこのタスクから見えませんでした（通信なしで実行します）: ${taskId}`,
  });
  self.notify(runId);
  void self.persist(runId);
}

/**
 * タスク間メッセージング（design.md §16.21）のMCPサーバとポーリングタイマーを閉じる。
 *
 * run終了時（`pump()`）と拡張機能の終了時（`WorkflowRunner.dispose()`）の両方から呼ぶ
 * 共通の後始末（Issue #374）。同じ解放処理を2箇所へ複製すると、片方だけ直される事故が
 * 起きるため1本へ寄せてある。
 *
 * **冪等**。先に`live.messaging`を`undefined`へ戻してから閉じるので、run終了直後に
 * `dispose()`が来ても2度目は何もしない。`transport.close()`が投げても
 * `clearInterval`は必ず行う（1つの失敗でタイマーが残らないようにする）。
 */
export function closeMessaging(live: LiveRun): void {
  const messaging = live.messaging;
  if (messaging === undefined) {
    return;
  }
  live.messaging = undefined;
  try {
    // `close()`が拒否しても未処理のPromise拒否にしない（deactivate中はサーバが既に
    // 落ちていることがある）。同期で投げる実装もありうるのでtry/catchで囲む
    void Promise.resolve(messaging.transport.close()).catch(() => undefined);
  } catch {
    // 閉じられなくてもタイマーの解放は続ける
  } finally {
    clearInterval(messaging.waitingReplyPollTimer);
  }
}
