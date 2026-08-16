import type { ChatState } from '../appserver/chatState';
import {
  buildOrchestratorConfig,
  composeOrchestratorPrompt,
  MAX_ORCHESTRATOR_EVENTS_PER_RUN,
  ORCHESTRATOR_CONNECTION_ID,
  pickOrchestratorProvider,
  type OrchestratorEvent,
} from './orchestratorSession';
import { sanitizeForLog } from './sanitize';
import { buildResponseSummary } from './taskSummary';
import type { TaskState } from './runState';
import type { LiveOrchestrator, LiveRun } from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * オーケストレーターセッション（design.md §16.23）の配線を集めたモジュール。
 * `runnerMessaging.ts` と同じく `self: WorkflowRunnerInternals` を第一引数に取る。
 *
 * 純粋ロジック（権限のクランプ・送信本文の合流）は `orchestratorSession.ts` にあり、
 * ここが持つのはセッションの生成・寿命・イベントの発火だけ。
 */

/** run開始時にオーケストレーターへ渡す、役割と道具の説明。 */
function buildIntroBody(live: LiveRun): string {
  const tasks = live.def.tasks
    .map((t) => {
      const deps = t.dependsOn.length > 0 ? `（依存: ${t.dependsOn.join(', ')}）` : '';
      return `- ${t.id}${deps}`;
    })
    .join('\n');
  return [
    `ワークフロー「${live.def.name}」の実行を開始しました。あなたはこの実行のオーケストレーターです。`,
    '人からの質問に答え、進行の要点を報告し、頼まれたら方針の変更を実行してください。',
    '',
    'できること（MCPツール）:',
    '- list_tasks / get_run_status: 進行状況を読む',
    '- send_message: 走行中のタスクへメッセージを送る',
    '- stop_task / retry_task / continue_task / decide_approval: タスクを止める・やり直す・続ける・承認する',
    '- update_task_prompt: 走行中のタスクの継続指示を差し替える（方針転換）',
    '',
    'あなた自身はファイルを書き換えられません（読み取り専用）。実際の作業は各タスクが行います。',
    '',
    `タスク（${live.def.tasks.length}件、並列上限 ${live.def.maxParallel}）:`,
    tasks,
  ].join('\n');
}

/**
 * オーケストレーターセッションを1つ開く（design.md §16.23「セッションの生成と寿命」）。
 *
 * 失敗しても実行は止めない。ワークフローViewの警告欄へ出して、オーケストレーター欄を
 * 「利用できません」にするだけにする（§16.21のMCPツールが見えないときと同じ方針）。
 */
export async function setupOrchestratorForStart(
  self: WorkflowRunnerInternals,
  runId: string,
  live: LiveRun,
): Promise<void> {
  const provider = pickOrchestratorProvider(live.def);
  const effective = buildOrchestratorConfig(provider, self.deps.readBaseline());
  // 制御ツール用の接続。タスクidとして妥当でない識別子を使うため、タスク側からは名乗れない
  const url = live.messaging?.transport.registerTask(ORCHESTRATOR_CONNECTION_ID);

  try {
    const host = self.deps.hosts[provider];
    const session = await host.openTaskSession({
      role: 'orchestrator',
      // worktreeは作らない。書かせないため（§16.23「権限」）
      cwd: live.repoRoot,
      config: effective.config,
      sandbox: effective.sandbox,
      ...(url !== undefined ? { mcp: { url } } : {}),
    });
    session.open({ preserveFocus: true });

    const orchestrator: LiveOrchestrator = {
      session,
      provider,
      busy: false,
      pending: [],
      eventsSent: 0,
      lastResponseSummary: '',
      unreadCount: 0,
    };
    live.orchestrator = orchestrator;
    session.onStateChanged((state) => onOrchestratorStateChanged(self, runId, state));

    notifyOrchestrator(self, runId, { kind: 'runStarted', body: buildIntroBody(live) });
    self.notify(runId);
  } catch (e) {
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    self.deps.log.warn(
      `[workflow ${runId}] オーケストレーターセッションを開始できませんでした: ${message}`,
    );
    live.warnings.push({
      kind: 'orchestratorUnavailable',
      taskId: undefined,
      message: `オーケストレーターセッションを開始できませんでした（実行は続きます）: ${message}`,
    });
    self.notify(runId);
  }
}

/**
 * オーケストレーターのターンの状況を追う。直近の応答の1行要約はワークフローViewの
 * オーケストレーター欄に出す（応答本文そのものは持たない。§16.11）。
 *
 * ターンが終わった時点で、その間に溜まったイベントをまとめて送る（走行中のターンへは
 * 割り込まない。§16.23「何が駆動するか」）。
 */
function onOrchestratorStateChanged(
  self: WorkflowRunnerInternals,
  runId: string,
  state: ChatState,
): void {
  const orchestrator = self.runs.get(runId)?.orchestrator;
  if (orchestrator === undefined) {
    return;
  }
  const summary = buildResponseSummary(state);
  if (summary !== '' && summary !== orchestrator.lastResponseSummary) {
    orchestrator.lastResponseSummary = summary;
    orchestrator.unreadCount += 1;
  }
  const finishedTurn = orchestrator.busy && !state.busy;
  orchestrator.busy = state.busy;
  if (finishedTurn) {
    flushOrchestrator(self, runId);
  }
  self.notify(runId);
}

/**
 * イベントを1件届ける（design.md §16.23「何が駆動するか」の表）。
 *
 * ターンが走っている間は溜めておき、そのターンが終わってからまとめて送る。run全体で
 * 送れる総数には上限（`MAX_ORCHESTRATOR_EVENTS_PER_RUN`）を置く。
 */
export function notifyOrchestrator(
  self: WorkflowRunnerInternals,
  runId: string,
  event: OrchestratorEvent,
): void {
  const orchestrator = self.runs.get(runId)?.orchestrator;
  if (orchestrator === undefined) {
    return;
  }
  if (orchestrator.eventsSent >= MAX_ORCHESTRATOR_EVENTS_PER_RUN) {
    return;
  }
  orchestrator.eventsSent += 1;
  orchestrator.pending.push(event);
  if (!orchestrator.busy) {
    flushOrchestrator(self, runId);
  }
}

/** 溜まったイベントを送る。人の発話は伴わない（自発的な報告）。 */
function flushOrchestrator(self: WorkflowRunnerInternals, runId: string): void {
  const orchestrator = self.runs.get(runId)?.orchestrator;
  if (orchestrator === undefined || orchestrator.pending.length === 0) {
    return;
  }
  const text = composeOrchestratorPrompt(orchestrator.pending, '');
  orchestrator.pending = [];
  if (text === '') {
    return;
  }
  orchestrator.busy = true;
  orchestrator.session.send(text);
}

/**
 * 人の発話を送る（ワークフローViewの入力欄。design.md §16.23「会話のUI」）。
 *
 * 溜まっているイベントがあれば発話の前に添える。**発話そのものは常に全量が残る**
 * （`composeOrchestratorPrompt` の不変条件）。
 */
export function sendUserMessageToOrchestrator(
  self: WorkflowRunnerInternals,
  runId: string,
  text: string,
): boolean {
  const orchestrator = self.runs.get(runId)?.orchestrator;
  if (orchestrator === undefined || text.trim() === '') {
    return false;
  }
  const composed = composeOrchestratorPrompt(orchestrator.pending, text);
  orchestrator.pending = [];
  orchestrator.busy = true;
  orchestrator.session.send(composed);
  self.notify(runId);
  return true;
}

/** 人が会話を読んだ（タブを開いた）ことにして未読の印を消す。 */
export function markOrchestratorRead(self: WorkflowRunnerInternals, runId: string): void {
  const orchestrator = self.runs.get(runId)?.orchestrator;
  if (orchestrator === undefined) {
    return;
  }
  orchestrator.unreadCount = 0;
  self.notify(runId);
}

/**
 * タスクの状態の変化をイベント通知へ変える（design.md §16.23「何が駆動するか」の表）。
 *
 * 状態遷移の呼び出し箇所（`runState.ts`の各関数を呼ぶ場所）へ1つずつ差し込むのではなく、
 * **`notify`（Viewへの通知）から前回見た状態との差分を見る**形にしてある。遷移の入口は
 * runner・runnerMerge・runnerMessaging・runnerRestoreに散っており、差し込み漏れが起きると
 * 「オーケストレーターにだけ届かない状態」が生まれるため。差分なので、`notify`が
 * ストリーミング中に何度呼ばれても通知は状態が変わったときだけになる。
 */
export function syncOrchestratorTaskEvents(self: WorkflowRunnerInternals, runId: string): void {
  const live = self.runs.get(runId);
  if (live?.orchestrator === undefined) {
    return;
  }
  for (const task of live.def.tasks) {
    const state = live.runState.tasks.get(task.id)?.state;
    if (state === undefined) {
      continue;
    }
    const seen = live.orchestratorSeenStates.get(task.id);
    if (seen === state) {
      continue;
    }
    live.orchestratorSeenStates.set(task.id, state);
    const event = buildTaskEvent(live, task.id, state);
    if (event !== undefined) {
      notifyOrchestrator(self, runId, event);
    }
  }
}

/** 通知するのは重要な遷移だけ（走行中の逐一の変化は流さない）。 */
function buildTaskEvent(
  live: LiveRun,
  taskId: string,
  state: TaskState,
): OrchestratorEvent | undefined {
  const summary = live.tasks.get(taskId)?.lastResponseSummary ?? '';
  const withSummary = (head: string): string =>
    summary === '' ? head : `${head}\n直近の応答: ${summary}`;
  switch (state) {
    case 'done':
      return { kind: 'taskDone', body: withSummary(`タスク ${taskId} が完了しました。`) };
    case 'failed':
      return { kind: 'taskFailed', body: withSummary(`タスク ${taskId} が失敗しました。`) };
    case 'waitingApproval': {
      const approval = live.tasks.get(taskId)?.pendingApproval;
      const detail = approval === undefined ? '' : `\n要求: ${approval.title}`;
      return {
        kind: 'taskWaitingApproval',
        body: `タスク ${taskId} が承認待ちです。${detail}`,
      };
    }
    case 'blocked':
      return {
        kind: 'taskBlocked',
        body: `タスク ${taskId} が統合ブランチへマージできず blocked になりました（衝突）。`,
      };
    default:
      return undefined;
  }
}

/**
 * runが終わったことを知らせる（design.md §16.23）。**MCPサーバはrunの終了と同時に閉じる**
 * （§16.21）ため、以降ツールは呼べないことを本文に明記する。会話自体は続けられる。
 */
export function notifyOrchestratorRunFinished(
  self: WorkflowRunnerInternals,
  runId: string,
  outcome: string,
): void {
  notifyOrchestrator(self, runId, {
    kind: 'runFinished',
    body: [
      `ワークフローの実行が終了しました（結果: ${outcome}）。`,
      'この時点でMCPサーバは閉じるため、list_tasks や制御ツールはもう使えません。',
      '会話は続けられます。結果について質問されたら、これまでの通知の内容から答えてください。',
    ].join('\n'),
  });
}

/** run終了時にオーケストレーターのセッションを解放する（`WorkflowRunner.dispose`から呼ぶ）。 */
export function disposeOrchestrator(live: LiveRun): void {
  live.orchestrator?.session.dispose();
  live.orchestrator = undefined;
}
