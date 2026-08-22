import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState } from '../appserver/chatState';
import {
  MAX_MESSAGE_BODY_LENGTH,
  type OrchestratorControlPort,
  type OrchestratorControlResult,
} from './messaging';
import {
  buildOrchestratorConfig,
  composeOrchestratorPrompt,
  MAX_ORCHESTRATOR_EVENTS_PER_RUN,
  ORCHESTRATOR_CONNECTION_ID,
  pickOrchestratorProvider,
  type OrchestratorEvent,
} from './orchestratorSession';
import { sanitizeForLog, stripControlChars } from './sanitize';
import { buildResponseSummary } from './taskSummary';
import type { TaskState } from './runState';
import type {
  FinalMergeDecision,
  LiveOrchestrator,
  LiveRun,
  RetryTaskResult,
  WorkflowRunSnapshot,
} from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';
import { truncateByCodePoint } from './workflow';

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

/* ------------------------------------------------------------------------ *
 * 制御ツール（design.md §16.23「道具」）
 * ------------------------------------------------------------------------ */

/**
 * 制御ツールが呼ぶ `WorkflowRunner` の公開メソッド。
 *
 * `WorkflowRunnerInternals`（内部の可変状態と状態遷移の入口）ではなく、Viewのボタンが
 * 通るのと同じ公開メソッドを受け取る。モデル用の別経路を作らないための制約で、
 * `WorkflowRunner` がそのまま構造的に満たす（キャストしないので、ずれれば `tsc` が止める）。
 */
export interface OrchestratorControlActions {
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined;
  /**
   * `WorkflowRunner.stopTask`のjsdoc（issue #514）参照。戻り値は「送り先を見つけて
   * `stopLoop()`を呼べたか」で、`false`のときは制御ツール側が`no(...)`を返す根拠になる。
   */
  stopTask(runId: string, taskId: string): boolean;
  /**
   * `stopTask`が`false`を返したときに、「そもそも送り先のセッションが無かった」のか
   * 「送り先はあったが、ループは既に終わっていた」のかを見分けるための補助（Issue #514
   * medium指摘）。`WorkflowRunner.hasStoppableSession`のJSDoc参照。
   */
  hasStoppableSession(runId: string, taskId: string): boolean;
  retryTask(runId: string, taskId: string, options?: { allowConfirmed?: boolean }): RetryTaskResult;
  continueTask(runId: string, taskId: string): boolean;
  decideApproval(runId: string, taskId: string, decision: ApprovalDecision): boolean;
  /**
   * 最終マージの判断を確定する（design.md §16.26）。`WorkflowRunner.decideFinalMerge`の
   * JSDoc参照。判断待ちが無ければ`false`。
   */
  decideFinalMerge(runId: string, decision: FinalMergeDecision, reason: string): boolean;
}

/** 差し替えた継続指示のうち、警告欄へ出す先頭部分の長さ。 */
const PROMPT_OVERRIDE_PREVIEW_LENGTH = 200;

const ok = (reason: string): OrchestratorControlResult => ({ accepted: true, reason });
const no = (reason: string): OrchestratorControlResult => ({ accepted: false, reason });

/**
 * runが終わっているなら理由を返す（design.md §16.23「run完了後は後述の制御ツールだけが
 * 無効になり、会話は続けられる」・「run終了後の制御ツールは無効。過去のrunを後から動かす
 * 経路は作らない」）。走っていれば `undefined`。
 *
 * 実運用ではrun終了時にMCPサーバごと閉じる（§16.21）ためツール自体が見えなくなるが、
 * 閉じるまでの隙間と、サーバの寿命に依存しない多層防御としてここでも止める。**`get_run_status`
 * は無効にしない**（走り終えた後に「なぜ失敗したのか」を聞く経路を残すため）。
 */
function runFinishedReason(
  actions: OrchestratorControlActions,
  runId: string,
): string | undefined {
  const outcome = actions.getSnapshot(runId)?.outcome;
  if (outcome === undefined) {
    return 'この実行はすでに破棄されているため、制御ツールは使えません。';
  }
  return outcome === 'running'
    ? undefined
    : `この実行はすでに終了しています（${outcome}）。制御ツールは使えません。会話は続けられます。`;
}

/**
 * 人が「全体の停止」を押しているなら理由を返す（design.md §16.23、Issue #401）。
 * 立っていなければ `undefined`。
 *
 * **必ず `snapshot.haltedByUser` だけを見る。`isRunHalted`（`runState.ts`）を使っては
 * ならない。** `isRunHalted` は `hasFailedTask` も真にするため、1件失敗しただけの通常運転
 * （`haltedByUser` は立っていない）でもここに混ぜると `retry_task` が丸ごと死ぬ。それは
 * design.md §16.23の目的（失敗の後始末をAIに見させる）を壊す。
 *
 * 停止の直後は、走行中タスクの`stopLoop()`がまだ確定していない（進行中のターンには
 * 割り込まない）ため `outcome` は `running` のまま残り得る。`runFinishedReason` だけでは
 * この窓を塞げないので、これを別の層として並べる。
 *
 * `stop_task` はこの検査を通さない（止める方向は停止意図と矛盾しないため呼び出し側で
 * 除外する）。**この除外が成り立つのは、`stop_task` 自身が `haltedByUser` を立てない
 * 場合に限る**（Issue #514）。`merging` のタスクへの `stop_task` は衝突解決セッションへ
 * `stopLoop()` を送るが、`WorkflowRunner.stop()`（全体停止）からの同じ `stopLoop()` と
 * 見分けが付かないと、`runnerMerge.ts` の `finishMergeResolution` が誤って
 * `haltedByUser` を立ててしまい、この除外の前提（「`stop_task` は止める方向にしか
 * 効かない」）が壊れる。`MergeResolutionEntry.stoppedByStopTask`（`runner.ts`）で
 * 送り元を区別し、`stop_task` 経由では `haltedByUser` を立てないことで、この前提を
 * 保っている。
 */
function runHaltedByUserReason(
  actions: OrchestratorControlActions,
  runId: string,
): string | undefined {
  const snapshot = actions.getSnapshot(runId);
  if (snapshot === undefined) {
    // `getSnapshot`が`undefined`を返す状況（実行が既に破棄されている等）を「停止していない」
    // とみなすとフェイルオープンになる。既存の呼び出し箇所は全て先に`runFinishedReason`を
    // 通しており、そちらが`undefined`をフェイルクローズで拾うため実際にここへ来る場面は無いが、
    // 将来この関数が単独で再利用されたり順序が入れ替わったりしたときの防御として拒否する。
    // 新しい呼び出し箇所を足すときは、先に`runFinishedReason`を通しているかを確認すること。
    // 通していない場合、この分岐へ到達しうる
    return 'この実行の状態を取得できませんでした。この制御ツールは使えません。';
  }
  return snapshot.haltedByUser === true
    ? '人がこの実行全体を停止しました。再開できるのは人だけです。この制御ツールは使えません。'
    : undefined;
}

/**
 * オーケストレーター専用の接続に見せる制御ツールの実体を組み立てる（design.md §16.23）。
 *
 * runを1本に固定した口を返す。オーケストレーターは自分のrun以外を指定できない
 * （`runId` を引数に取るツールを置かない）。
 */
export function buildOrchestratorControlPort(
  self: WorkflowRunnerInternals,
  actions: OrchestratorControlActions,
  runId: string,
): OrchestratorControlPort {
  return {
    getRunStatus: () => buildRunStatus(actions, runId),
    stopTask: (taskId) => {
      const finished = runFinishedReason(actions, runId);
      if (finished !== undefined) {
        return no(finished);
      }
      const state = self.runs.get(runId)?.runState.tasks.get(taskId)?.state;
      if (state === undefined) {
        return no(`タスクが見つかりません: ${taskId}`);
      }
      // 戻り値（`boolean`）を成功の根拠にする（issue #514）。`live.tasks` /
      // `live.mergeResolutions` のどちらにも実際に止められるループが見つからなければ
      // `false` が返るため、ここで無条件に成功を返さない。届いていないのに「止めました」
      // と答えるとオーケストレーターは以後この経路を再試行しなくなるため、届かなかった
      // ことをそのまま伝える
      const stopped = actions.stopTask(runId, taskId);
      if (!stopped) {
        // `stopTask`の`false`は「送り先のセッションが無かった」（本当に見つからない）と
        // 「送り先はあったが、ループは既に終わっていた」（`merging`のタスクなど、
        // `onTaskFinished`後もエントリが残るケース。issue #514 medium指摘）の両方で
        // 返るため、ここで別の判定（`hasStoppableSession`）を挟んで文言を分ける。
        // どちらの場合も**失敗を返す動作自体は変えない**（安全側。「見つからない」と
        // 誤診してオーケストレーターが的外れな対応をしないよう、実際には届いていた
        // ことを伝える）
        const hadSession = actions.hasStoppableSession(runId, taskId);
        return no(
          hadSession
            ? `${taskId} は既に停止しています（状態: ${state}）。stop_taskは何もしていません。`
            : `${taskId} を止められませんでした（対象のループが見つかりません。状態: ${state}）。`,
        );
      }
      return ok(`${taskId} のループを止めました（状態: ${state}）。`);
    },
    retryTask: (taskId) => {
      const finished = runFinishedReason(actions, runId);
      if (finished !== undefined) {
        return no(finished);
      }
      const halted = runHaltedByUserReason(actions, runId);
      if (halted !== undefined) {
        return no(halted);
      }
      // `allow`（design.md §16.7）を含むタスクの再実行は人の確認が要る。オーケストレーターに
      // `allowConfirmed: true` を名乗らせない（確認の意味が無くなるため）
      const result = actions.retryTask(runId, taskId);
      if (result.needsAllowConfirmation === true) {
        return no(
          `${taskId} は allow を含むため、人がワークフローViewで確認してから再実行します。`,
        );
      }
      return result.ok
        ? ok(`${taskId} を新しいセッションでやり直しています。`)
        : no(`${taskId} は再実行できる状態ではありません。`);
    },
    continueTask: (taskId) => {
      const finished = runFinishedReason(actions, runId);
      if (finished !== undefined) {
        return no(finished);
      }
      const halted = runHaltedByUserReason(actions, runId);
      if (halted !== undefined) {
        return no(halted);
      }
      return actions.continueTask(runId, taskId)
        ? ok(`${taskId} を続きから走らせています。`)
        : no(`${taskId} は続きから走らせられる状態ではありません。`);
    },
    decideApproval: (taskId, decision) => {
      const finished = runFinishedReason(actions, runId);
      if (finished !== undefined) {
        return no(finished);
      }
      const halted = runHaltedByUserReason(actions, runId);
      if (halted !== undefined) {
        return no(halted);
      }
      // 承認をセッション全体へ広げる `acceptForSession` は選ばせない（1件ずつの判断に限る）
      if (decision !== 'accept' && decision !== 'decline') {
        return no(`decision は 'accept' か 'decline' のどちらかです: ${decision}`);
      }
      return actions.decideApproval(runId, taskId, decision)
        ? ok(`${taskId} の承認要求に ${decision} で答えました。`)
        : no(`${taskId} に承認待ちの要求はありません。`);
    },
    updateTaskPrompt: (taskId, continuePrompt) => {
      const finished = runFinishedReason(actions, runId);
      if (finished !== undefined) {
        return no(finished);
      }
      const halted = runHaltedByUserReason(actions, runId);
      if (halted !== undefined) {
        return no(halted);
      }
      return updateTaskPrompt(self, runId, taskId, continuePrompt);
    },
    decideFinalMerge: (decision, reason) => {
      // `runFinishedReason`は使わない。最終マージの判断待ち（design.md §16.26）は
      // 全タスクが`done`になり`outcome`が既に`succeeded`（＝「終了している」）に
      // なった後で始まるため、`runFinishedReason`（`outcome === 'running'`でなければ
      // 拒否）を通すと常に拒否されてしまう。ここでは`finalMergeDecision`の有無だけを
      // 判断待ちの根拠にする。
      //
      // ただし`runHaltedByUserReason`（人が「全体の停止」を押したかどうか）は他の判断系
      // 制御ツール（`retryTask`/`continueTask`/`decideApproval`/`updateTaskPrompt`）と
      // 同じく通す。停止後もこのツールが素通りだと、人が全体を止めた後にオーケストレーターが
      // `decision: 'merge'`を呼んでmainへ実際にマージできてしまう（レビュー指摘。
      // `runFinishedReason`をスキップする理由とは別に、こちらは他ツールと揃えるのが正しい）
      const snapshot = actions.getSnapshot(runId);
      if (snapshot === undefined) {
        return no('この実行はすでに破棄されているため、制御ツールは使えません。');
      }
      const halted = runHaltedByUserReason(actions, runId);
      if (halted !== undefined) {
        return no(halted);
      }
      const pending = snapshot.finalMergeDecision;
      if (pending === undefined) {
        return no('最終マージの判断待ちはありません。');
      }
      if (pending.mode !== 'orchestrator') {
        return no(
          'この実行の agent.workflows.finalMerge は confirm です。マージするかどうかは人が判断します。',
        );
      }
      if (decision !== 'merge' && decision !== 'hold') {
        return no(`decision は 'merge' か 'hold' のどちらかです: ${decision}`);
      }
      if (reason.trim() === '') {
        return no('reason は必須です（判断の理由を書いてください）。');
      }
      // `send_message`（`validateSendMessage`）・`update_task_prompt`と同じ上限を使う
      // （design.md §16.23）。`reason`はLLMが生成する自由記述であり、上限が無いと
      // 警告欄（`pushFinalMergeWarning`）を任意長の文字列で埋められる（レビュー指摘）。
      // `send_message`に揃えて切り詰めではなく拒否にする
      if (reason.length > MAX_MESSAGE_BODY_LENGTH) {
        return no(`reason が長すぎます（上限${MAX_MESSAGE_BODY_LENGTH}文字）: ${reason.length}文字`);
      }
      return actions.decideFinalMerge(runId, decision, reason)
        ? ok(`最終マージの判断を ${decision} として確定しました。`)
        : no('最終マージの判断待ちが見つかりません（既に確定した可能性があります）。');
    },
  };
}

/**
 * `get_run_status` が返す要約（design.md §16.23）。
 *
 * **応答本文・プロンプトの全文は含めない。** `TaskSnapshot` には `expandedPrompt` /
 * `lastSentPrompt`（実際に送った文面）が入っているが、ここでは写さない。`LiveTask` が
 * 応答本文を持たないのと同じ理由（§16.11）に加え、他タスクへ渡ったメッセージの中身が
 * オーケストレーター経由で読めてしまうのを避けるため。
 */
function buildRunStatus(actions: OrchestratorControlActions, runId: string): unknown {
  const snapshot = actions.getSnapshot(runId);
  if (snapshot === undefined) {
    return { error: '実行が見つかりません（すでに破棄されています）。' };
  }
  return {
    runId: snapshot.runId,
    name: snapshot.name,
    outcome: snapshot.outcome,
    haltedByUser: snapshot.haltedByUser,
    tasks: snapshot.tasks.map((t) => ({
      id: t.id,
      state: t.state,
      dependsOn: t.dependsOn,
      provider: t.provider,
      retryCount: t.retryCount,
      submissionCount: t.submissionCount,
      lastResponseSummary: t.lastResponseSummary,
      failure: t.failure,
      pendingApproval: t.pendingApproval?.title,
      branch: t.branch,
    })),
    warnings: snapshot.warnings.map((w) => ({
      kind: w.kind,
      taskId: w.taskId,
      message: w.message,
    })),
    integration: {
      branch: snapshot.integrationBranch,
      pullRequestNumber: snapshot.integrationPullRequestNumber,
      pullRequestUrl: snapshot.integrationPullRequestUrl,
      finalMergeOutcome: snapshot.finalMergeOutcome,
      // design.md §16.26。判断待ちの間`decide_final_merge`を呼ぶべきかをオーケストレーター
      // 自身が`get_run_status`から確認できるようにする
      finalMergeDecision: snapshot.finalMergeDecision,
    },
  };
}

/**
 * 走行中のタスクの継続指示を差し替える（design.md §16.23 `update_task_prompt`）。
 *
 * 上限超過は`send_message`と同じく**受付自体を拒否する**（モデルが短くして送り直せる）。
 * 差し替えは必ずワークフローViewの警告欄へ出す。人がYAMLに書いた指示が実行中に別のものへ
 * 変わるのは、Viewを見ている人から見て最も気付きにくい変化であるため。
 */
function updateTaskPrompt(
  self: WorkflowRunnerInternals,
  runId: string,
  taskId: string,
  continuePrompt: string,
): OrchestratorControlResult {
  const live = self.runs.get(runId);
  const liveTask = live?.tasks.get(taskId);
  if (live === undefined || liveTask === undefined) {
    return no(`タスクのセッションがありません（開始前・終了後は差し替えられません）: ${taskId}`);
  }
  if (continuePrompt.trim() === '') {
    return no('継続指示が空です。');
  }
  if (continuePrompt.length > MAX_MESSAGE_BODY_LENGTH) {
    return no(
      `継続指示が長すぎます（上限${MAX_MESSAGE_BODY_LENGTH}文字）: ${continuePrompt.length}文字`,
    );
  }

  liveTask.continuePromptOverride = continuePrompt;
  const preview = truncateByCodePoint(
    stripControlChars(continuePrompt),
    PROMPT_OVERRIDE_PREVIEW_LENGTH,
  );
  // 同一taskIdの差し替えは`update_task_prompt`の呼び出し回数だけ際限なく積まれてしまうため
  // （Issue #366）、直近1件へ丸める。差し替えが起きた事実自体は最新の1件として残るので
  // 「警告が出た事実が失われる」ことはない（自己レビュー参照）
  live.warnings = live.warnings.filter(
    (w) => !(w.kind === 'orchestratorPromptOverride' && w.taskId === taskId),
  );
  live.warnings.push({
    kind: 'orchestratorPromptOverride',
    taskId,
    message:
      `${taskId} の継続指示をオーケストレーターが差し替えました（以降のターンはこの本文を送ります。` +
      `テンプレート変数は展開しません。ウィンドウのリロード後は定義ファイルの値に戻ります）: ` +
      `${preview.text}${preview.truncated ? '…' : ''}`,
  });
  self.notify(runId);
  return ok(`${taskId} の継続指示を差し替えました。`);
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

/**
 * 人が実行全体を停止したことを知らせる（design.md §16.23、Issue #401）。
 *
 * `stop()`は走行中タスクへ`stopLoop()`を送るだけで、確定（`failed`への遷移）は進行中の
 * ターンが終わるまで待つ。その間オーケストレーターに届くのは通常の`taskFailed`だけなので、
 * 「タスクが次々失敗している」ようにしか見えず、`retry_task`を呼ぶのがむしろ自然な反応に
 * なってしまう（本Issueの調査で判明した構造的な誘発）。ここで明示のイベントを1本送り、
 * 「人が止めた」と分かるようにする。制御ツール側の拒否理由と合わせた多層防御。
 */
export function notifyOrchestratorRunHalted(self: WorkflowRunnerInternals, runId: string): void {
  notifyOrchestrator(self, runId, {
    kind: 'runHaltedByUser',
    body: [
      '人がこの実行全体を停止しました。',
      '再開できるのは人だけです。retry_task / continue_task / decide_approval / update_task_prompt は使えません（stop_task は引き続き使えます）。',
      '会話は続けられます。',
    ].join('\n'),
  });
}

/** run終了時にオーケストレーターのセッションを解放する（`WorkflowRunner.dispose`から呼ぶ）。 */
export function disposeOrchestrator(live: LiveRun): void {
  live.orchestrator?.session.dispose();
  live.orchestrator = undefined;
}
