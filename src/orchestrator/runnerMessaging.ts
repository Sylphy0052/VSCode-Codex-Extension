import {
  buildStalledWaitingReplyWarning,
  detectAllWaitingStalemate,
  detectTimedOutWaitingReplies,
  DEFAULT_REPLY_TIMEOUT_SEC,
  type RunTaskSnapshot,
  type StoredMessage,
} from './messaging';
import { ORCHESTRATOR_CONNECTION_ID } from './orchestratorSession';
import { notifyOrchestrator } from './runnerOrchestrator';
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
 *
 * **タスク間の直接メッセージングは廃止した（design.md §16.34、Issue #547）。** `send_message`の
 * 宛先はオーケストレーターに固定され（`messaging.ts`の`validateSendMessage`）、タスクから
 * 届く`StoredMessage`の`to`は常に`ORCHESTRATOR_CONNECTION_ID`になる。`onMessageAccepted`は
 * この宛先を見て、`TaskMessagingHub`のキューへ積むだけでなく`notifyOrchestrator`で即座に
 * オーケストレーターのセッションへ届ける（プッシュ）。タスク宛のメッセージ（オーケストレーターが
 * `send_message`で転送する側）は従来どおり、宛先タスクの次の送信（`setPromptTransform`の
 * `takeDeliverableMessages`）で取り出すプルのままにする。
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

  if (message.to === ORCHESTRATOR_CONNECTION_ID) {
    // タスクからオーケストレーターへの送信（design.md §16.34、Issue #547）。オーケストレーターは
    // `setPromptTransform`のようなプル経路を持たないため、ここで即座にプッシュする
    deliverTaskMessageToOrchestrator(self, runId, live, message);
  } else {
    const recipientTask = live.tasks.get(message.to);
    const recipientState = live.runState.tasks.get(message.to);
    if (recipientTask !== undefined && recipientState?.state === 'waitingReply') {
      live.runState = resumeFromWaitingReply(live.runState, message.to);
      recipientTask.waitingReplySinceMs = undefined;
      recipientTask.session.resumeLoop();
      changed = true;
    }
  }

  if (changed) {
    self.notify(runId);
    void self.persist(runId);
  }
}

/**
 * `<task-message from="...">...</task-message>`のように送信元・本文を明示して囲う
 * （design.md §16.21「受信内容の扱い」と同じ流儀）。ただし`wrapTaskMessage`
 * （`messaging.ts`）は使わない。`OrchestratorEvent.body`は`orchestratorSession.ts`の
 * `wrapEvent`が`<workflow-event kind="taskMessage">`でもう一段囲み、その際
 * `escapeAngleBrackets`を全体へ通す。先にここで角括弧を実体参照へ変換した文字列を渡すと、
 * `wrapTaskMessage`自身が生成した`<task-message>`タグまで二重にエスケープされ、
 * オーケストレーターから見て`&lt;task-message ...&gt;`という読みにくい文字列になる
 * （安全性には影響しないが、単なる二度手間で見た目が壊れる）。ここでは無害化前の
 * プレーンテキストを組み立てるだけにし、無害化は`wrapEvent`の1回に一本化する。
 */
function buildTaskMessageEventBody(message: StoredMessage): string {
  const replyNote = message.expectReply ? 'あり（返信を待っています）' : 'なし';
  return [
    `タスク ${message.from} からメッセージが届きました（返信待ち: ${replyNote}）。`,
    '本文:',
    message.body,
  ].join('\n');
}

/**
 * `ask_orchestrator`が送った「問い」用の本文（design.md §16.32、Issue #571）。
 * `buildTaskMessageEventBody`と役割は同じ（無害化は`wrapEvent`の1回に一本化。ここでは
 * 無害化前のプレーンテキストを組み立てるだけ）だが、「問い」であることが伝わる文面にする。
 * `blocking: true`（`expectReply: true`）なら答えるまでそのタスクが進めないことも明記し、
 * 既存の`send_message`（`to`に問うたタスクのidを指定）で答えるよう案内する。
 */
function buildTaskQuestionEventBody(message: StoredMessage): string {
  const blockingNote = message.expectReply
    ? 'あり（答えが届くかmaxIterationsを使い切るまで、このタスクは次のターンへ進めません）'
    : 'なし（答えを待たずに進めています）';
  return [
    `タスク ${message.from} から判断を仰ぐ問いが届きました（blocking: ${blockingNote}）。`,
    `send_message（to: "${message.from}"）で答えてください。`,
    '問い:',
    message.body,
  ].join('\n');
}

/**
 * タスクからオーケストレーターへのメッセージ（`to === ORCHESTRATOR_CONNECTION_ID`）を
 * `notifyOrchestrator`でプッシュし、`TaskMessagingHub`のキューからも取り除く
 * （design.md §16.34、Issue #547）。
 *
 * **キューから取り除くことが安全上・機能上どちらでも必要。** オーケストレーターは
 * タスクのように`takeDeliverableMessages`を呼んで自分宛のキューを取りに行くプル経路を
 * 持たない（`setupOrchestratorForStart`のJSDoc「書けないのに実行制御はできる」参照）。
 * ここで取り除かずに`store.queued`へ残したままだと、`checkWaitingReplyStalls`の
 * `detectAllWaitingStalemate`が見る`totalUndeliveredCount`が、オーケストレーター宛ての
 * 1件を配送済みとして扱えないまま恒久的に0より大きくなる。その結果、いずれかのタスクが
 * 一度でもオーケストレーターへメッセージを送ると、以後そのrunでは「走行中の全タスクが
 * waitingReplyのまま誰も動けない」待ちぼうけ検出（design.md §16.21「待ちぼうけを検出する
 * 経路」の経路1）が二度と成立しなくなる。design.md §16.34が名指しした「一番壊れやすい箇所」
 * （`waitingReply`が中継を挟んでも成立すること）は、送信元タスクを`waitingReply`へ倒す
 * 前段（上の`markWaitingReply`）が中継の有無に関わらず動くことに加え、この待ちぼうけ検出が
 * 壊れないことも含む。
 *
 * オーケストレーターのセッションが（開始失敗などで）存在しない場合は`notifyOrchestrator`が
 * 何もしないため、メッセージは黙って失われる。§16.21「MCPツールの可視性確認」・§16.23
 * 「セッションの生成に失敗した場合、runは止めない」と同じ「見えなければ通信なしで走らせる」
 * 方針を踏襲し、run自体は止めない。
 */
function deliverTaskMessageToOrchestrator(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
  message: StoredMessage,
): void {
  // 「問い」（ask_orchestrator、design.md §16.32、Issue #571）は種別を分けて伝える。
  // 配送経路そのもの（notifyOrchestrator→キュー消費）はkindを問わず共通
  const event =
    message.kind === 'question'
      ? { kind: 'taskQuestion' as const, body: buildTaskQuestionEventBody(message) }
      : { kind: 'taskMessage' as const, body: buildTaskMessageEventBody(message) };
  notifyOrchestrator(self, runId, event);
  live.messaging?.hub.takeDeliverableMessages(ORCHESTRATOR_CONNECTION_ID);
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
    // `waitingApproval`（人の承認待ち）は`activeStates`に含めない（Issue #579、
    // design.md §16.39）。`detectAllWaitingStalemate`（経路1）は「走行中の全タスクが
    // `waitingReply`」を条件にするため、承認待ちの解放とは無関係な`waitingApproval`が
    // 1件混じっているだけで、他のタスクの返信待ち解放まで永久に止まってしまっていた
    // （承認待ちには`agent.workflows.taskApprovalTimeoutSec`という別の解放経路がある。
    // `runnerApproval.ts`参照）。除いても`isActiveTaskState`自体（`maxParallel`の空き数
    // 計算・実行全体の終了判定）は変えない——ここはこの関数専用のローカルな`Map`
    // 構築なので、影響は経路1の判定にだけ閉じる
    if (isActiveTaskState(s.state) && s.state !== 'waitingApproval') {
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
