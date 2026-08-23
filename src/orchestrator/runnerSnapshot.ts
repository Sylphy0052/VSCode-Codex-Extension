import {
  findPermissionEscalationWarnings,
  permissionEscalationReasons,
  referencedResultFields,
  type PermissionProfile,
  type WorkflowTask,
} from './workflow';
import type { EffectiveTaskConfig } from './taskConfig';
import type { StoredMessage } from './messaging';
import type { PersistedRun } from './runStore';
import { getRunOutcome } from './scheduler';
import type {
  LiveRun,
  OrchestratorSnapshot,
  TaskSnapshot,
  WorkflowRunSnapshot,
  WorkflowWarning,
} from './runner';
import type { WorkflowRunnerInternals } from './runnerInternals';

/**
 * ワークフローViewの読み取り専用のスナップショット構築（design.md §16.8）を集めたモジュール
 * （Issue #147）。`WorkflowRunner`から機能単位で切り出した1本で、応答本文そのものではなく
 * `LiveTask.lastResponseSummary`（1行要約）だけを渡す方針や、`allow`/権限越境の警告を
 * 都度導出する理由（ウィンドウのリロードで復元した実行でも常時出す）は元のコメントのまま
 * 引き継いでいる。
 *
 * ここに集めた関数はいずれも状態を変更しない（`live.warnings`への追記を除く。これは
 * 元の実装でも「実行中に随時積む」既存の形を踏襲している）。`self: WorkflowRunnerInternals`を
 * 第一引数に取るのは、`WorkflowRunner`のメソッドから機械的に切り出したままの形を保ち、
 * 挙動を変えないため（最終報告に記載）。
 */

/**
 * Viewが描画する現在の状態のスナップショット（design.md §16.8）。
 * 応答本文そのものではなく `LiveTask.lastResponseSummary`（1行要約）だけを渡す。
 */
export function getSnapshot(self: WorkflowRunnerInternals, runId: string): WorkflowRunSnapshot | undefined {
  const live = self.runs.get(runId);
  if (live === undefined) {
    return undefined;
  }
  // 統合PR/MRの結果・最終マージの成否は、このプロセスでまだ何も試みていない
  // （`live.integrationPullRequest`/`live.finalMergeOutcome`が`undefined`の）間、
  // 永続化された値（前のウィンドウで作られた等）へフォールバックする
  // （design.md §16.11「リロードしてもPR/MRへのリンクが残る」・Issue #118）。
  // タスクごとの`buildTaskSnapshot`にも同じ永続化データが要るため、ここで1回だけ
  // 引いた`persisted`を渡す（Issue #366: タスクごとに引き直すとタスク数+1回の
  // ストア読み出しになっていた）
  const persisted = self.deps.store.find(runId);
  const tasks = live.def.tasks.map((task) => buildTaskSnapshot(live, task, persisted));
  return {
    runId: live.runId,
    name: live.def.name,
    defPath: live.defPath,
    outcome: getRunOutcome(live.runState),
    startedAt: live.startedAt,
    tasks,
    warnings: [
      ...live.warnings,
      ...deriveMaxReachedWarnings(live),
      ...deriveStalledWarnings(live),
      ...deriveAllowWarnings(live),
      ...derivePermissionEscalationWarnings(live),
    ],
    haltedByUser: live.runState.haltedByUser,
    integrationBranch: live.integration?.branch,
    integrationPullRequestNumber:
      live.integrationPullRequest?.number ?? persisted?.integrationPullRequestNumber,
    integrationPullRequestUrl:
      live.integrationPullRequest?.url ?? persisted?.integrationPullRequestUrl,
    finalMergeOutcome: live.finalMergeOutcome ?? persisted?.finalMergeOutcome,
    // design.md §16.26。ウィンドウのリロードでは復元しない（`LiveRun.finalMergeDecision`の
    // JSDoc参照）ため、`persisted`へのフォールバックは無い（`live`にしか存在しえない）
    finalMergeDecision:
      live.finalMergeDecision === undefined
        ? undefined
        : {
            mode: live.finalMergeDecision.mode,
            pullRequestUrl:
              live.integrationPullRequest?.url ?? persisted?.integrationPullRequestUrl,
          },
    orchestrator: buildOrchestratorSnapshot(live),
    pendingAskUser: buildPendingAskUserSnapshot(live, persisted),
  };
}

/**
 * `ask_user`の回答待ち（design.md §16.33）の表示用の値。`live`（回答可能）を優先し、
 * 無ければ永続化された値（リロード直後、自動再開（design.md §16.35、roadmap W10、
 * Issue #584）がまだ走っていない・見送った間は答える経路が無く、問いの文言だけは読める。
 * `LiveRun.pendingAskUser`のJSDoc参照）へフォールバックする。
 */
function buildPendingAskUserSnapshot(
  live: LiveRun,
  persisted: PersistedRun | undefined,
): { question: string; choices: readonly string[]; hasLiveSession: boolean; answered: boolean } | undefined {
  if (live.pendingAskUser !== undefined) {
    return {
      question: live.pendingAskUser.question,
      choices: live.pendingAskUser.choices,
      hasLiveSession: true,
      // `true`の間は答え済み・配送待ち（`orchestrator.busy`中に答えたため、ターンが
      // 終わるまで送信を保留している。`LiveAskUser.answeredChoice`のJSDoc参照）。
      // 二重回答を防ぐため、Viewはこの間ボタンを押せなくする
      answered: live.pendingAskUser.answeredChoice !== undefined,
    };
  }
  if (persisted?.pendingAskUser !== undefined) {
    return {
      question: persisted.pendingAskUser.question,
      choices: persisted.pendingAskUser.choices,
      hasLiveSession: false,
      answered: false,
    };
  }
  return undefined;
}

/**
 * オーケストレーター欄（design.md §16.23「会話のUI」）に出す値を組み立てる。
 *
 * セッションが無い（生成に失敗した・リロードで復元したrun）ときは `available: false` を
 * 返す。`undefined`ではなく常にオブジェクトを返すのは、Viewが「欄そのものを出さない」と
 * 「欄を出して『利用できません』と書く」を区別できるようにするため（design.md §16.23
 * 「オーケストレーター欄を『利用できません』にするだけにする」）。
 *
 * **応答本文は写さない**（`LiveOrchestrator`がそもそも持たない。§16.11と同じ理由）。
 */
function buildOrchestratorSnapshot(live: LiveRun): OrchestratorSnapshot {
  const orchestrator = live.orchestrator;
  if (orchestrator === undefined) {
    return { available: false, busy: false, lastResponseSummary: '', unreadCount: 0 };
  }
  return {
    available: true,
    provider: orchestrator.provider,
    busy: orchestrator.busy,
    lastResponseSummary: orchestrator.lastResponseSummary,
    unreadCount: orchestrator.unreadCount,
  };
}

function buildTaskSnapshot(
  live: LiveRun,
  task: WorkflowTask,
  persisted: PersistedRun | undefined,
): TaskSnapshot {
  const state = live.runState.tasks.get(task.id);
  const liveTask = live.tasks.get(task.id);
  // PR/MRの結果も、branch同様このウィンドウでまだセッションを開いていない
  // （リロード復元直後の）タスクでは`liveTask`が無い。branchと違い、PR/MRのリンクは
  // リロード後も出す必要がある（design.md §16.11「リロードしてもPR/MRへのリンクが残る」・
  // Issue #118の受入基準）ため、永続化された値へフォールバックする
  const persistedTask = persisted?.tasks[task.id];
  return {
    id: task.id,
    dependsOn: task.dependsOn,
    provider: task.provider,
    state: state?.state ?? 'pending',
    cwd: state?.cwd,
    // ライブなセッションの値を優先する。リロード復元直後はliveTaskが無いため
    // `state.cwd`（永続化された値）へ落ちる（design.md §16.11）
    branch: liveTask?.branch,
    submissionCount: state?.submissionCount ?? 0,
    retryCount: state?.retryCount ?? 0,
    startedAt: liveTask?.startedAt,
    lastResponseSummary: liveTask?.lastResponseSummary ?? '',
    failure: state?.failure,
    pendingApproval: liveTask?.pendingApproval,
    hasLiveSession: liveTask !== undefined,
    expandedPrompt: liveTask?.expandedPrompt,
    expandedContinuePrompt: liveTask?.expandedContinuePrompt,
    lastSentPrompt: liveTask?.lastSentPrompt,
    mergeResolutionActive: live.mergeResolutions.has(task.id),
    mergeResolutionWaitingApproval:
      live.mergeResolutions.get(task.id)?.waitingApprovalSinceMs !== undefined,
    pullRequestNumber: liveTask?.pullRequest?.number ?? persistedTask?.pullRequestNumber,
    pullRequestUrl: liveTask?.pullRequest?.url ?? persistedTask?.pullRequestUrl,
  };
}

/**
 * `allow` による危険判定の解除は定義ファイルから決まる情報であり、状態として
 * 持つ必要が無い（レビュー指摘: high）。以前は`start()`の中で1回だけ`live.warnings`へ
 * 積んでいたため、ウィンドウのリロードで復元した実行（`rebuildLiveRun`は`warnings: []`で
 * 初期化する）では二度と現れなかった。`live.def.tasks`から都度導出すれば、
 * design.md §16.7「どのタスクがどのパターンを解除しているかを常時出す」を
 * 復元経路でも自動的に満たす。
 */
export function deriveAllowWarnings(live: LiveRun): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];
  for (const task of live.def.tasks) {
    if (task.allow.length > 0) {
      warnings.push({
        kind: 'allowOverride',
        taskId: task.id,
        message: `allowで危険操作チェックの一部を解除しています: ${task.allow.join(', ')}`,
      });
    }
  }
  return warnings;
}

/**
 * 上流タスクより緩い権限で `{{T1.result}}` / `{{T1.summary}}` を参照している下流タスクの
 * 警告（design.md §16.4 案2「警告する」、Issue #67）。`deriveAllowWarnings` と同じ理由
 * （直前のコメント参照）で、`live.def.tasks`だけから決まる情報は都度導出する。1回だけ
 * `start()`で積むと、ウィンドウのリロードで復元した実行（`rebuildLiveRun`は`warnings: []`で
 * 初期化する）では二度と現れない。
 */
export function derivePermissionEscalationWarnings(live: LiveRun): WorkflowWarning[] {
  return findPermissionEscalationWarnings(live.def.tasks).map((issue): WorkflowWarning => ({
    kind: 'permissionEscalation',
    // taskIdsは[上流, 下流]の順（`findPermissionEscalationWarnings`参照）。実際に
    // 危険な参照を書いている側（下流）のタスクへ紐付ける
    taskId: issue.taskIds[issue.taskIds.length - 1],
    message: issue.message,
  }));
}

/**
 * 実効値（クランプ後の値）に基づく第二段の権限越境チェック（design.md §16.4 案2、
 * セキュリティ監査指摘#2）。
 *
 * `findPermissionEscalationWarnings`（読み込み時、`workflow.ts`）はYAMLに書かれた
 * リテラルの値しか見えない純粋関数のため、`sandbox` / `approvalMode` がどちらか一方でも
 * 未指定（拡張機能側の設定に委ねる、が典型的な書き方）だと実効値が分からず判定を諦める。
 * ここでは`buildEffectiveTaskConfig`が実際に計算したクランプ後の値（`effective`と、
 * 上流タスクが開始した時点で`LiveTask`へ保存済みの`effectiveSandbox` /
 * `effectiveApprovalMode` / `autoApprove`）を使うため、未指定でも判定できる。
 *
 * `live.warnings`には`clamp`等と同じく実行中に随時積む（design.mdの既存の形）。
 * 再試行で同じタスクが複数回開始しても同じ文言を積み直さないよう、既にあれば足さない。
 */
export function checkEffectivePermissionEscalation(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  task: WorkflowTask,
  taskId: string,
  effective: EffectiveTaskConfig,
): void {
  const downstream: PermissionProfile = {
    provider: task.provider,
    sandbox: effective.sandbox,
    approvalMode: effective.config.approvalMode,
    autoApprove: effective.autoApprove,
  };

  for (const ref of referencedResultFields(task)) {
    const upstreamTask = live.def.tasks.find((t) => t.id === ref.id);
    const upstreamLive = live.tasks.get(ref.id);
    // 依存が満たされて初めてこのタスクは開始するため通常は必ず見つかるが、
    // 見つからない場合（内部矛盾）は判定できないので黙って諦める
    if (upstreamTask === undefined || upstreamLive === undefined) {
      continue;
    }
    const upstream: PermissionProfile = {
      provider: upstreamTask.provider,
      sandbox: upstreamLive.effectiveSandbox,
      approvalMode: upstreamLive.effectiveApprovalMode,
      autoApprove: upstreamLive.autoApprove,
    };

    const reasons = permissionEscalationReasons(upstream, downstream);
    if (reasons.length === 0) {
      continue;
    }

    const message =
      `${taskId} は上流タスク ${ref.id} より緩い実効権限（拡張機能の設定でクランプ済みの値）で ` +
      `{{${ref.id}.${ref.field}}} を参照しています（${reasons.join(', ')}）。${ref.id} の応答に ` +
      `仕込まれた指示文が ${taskId} の権限で実行されうるため、参照する内容を確認してください`;
    const alreadyWarned = live.warnings.some(
      (w) => w.kind === 'permissionEscalation' && w.taskId === taskId && w.message === message,
    );
    if (alreadyWarned) {
      continue;
    }
    self.deps.log.warn(`[workflow ${live.runId}/${taskId}] ${message}`);
    live.warnings.push({ kind: 'permissionEscalation', taskId, message });
  }
}

/**
 * タスク間メッセージング（design.md §16.21）専用の権限差の警告（Issue #132「1. 権限差の
 * 警告」）。`checkEffectivePermissionEscalation`（`{{T1.result}}`経由、Issue #67）と
 * 判定ロジック自体（`permissionEscalationReasons`）は共有するが、経路が異なるため
 * 別メソッド・別`WorkflowWarning.kind`にする:
 *
 * - `{{T1.result}}`は`dependsOn`に挙げた依存先しか参照できず、読み込み時
 *   （`findPermissionEscalationWarnings`）と実行時の二段で検出できる
 * - メッセージは`dependsOn`を問わず同じrunの任意の宛先へ送れるうえ、`send_message`の
 *   呼び出しはモデルの判断で実行時に起きるため**静的には検査できない**。実行時、
 *   実際に配送された時点でしか検出できない
 *
 * 呼び出し元（`setPromptTransform`）は、メッセージが実際に宛先の次の指示へ組み込まれる
 * 直前（`takeDeliverableMessages`で取り出した直後）でこれを呼ぶ。宛先（recipient）が
 * このタスク自身、送信元（sender）が`message.from`。送信元の実効権限は、送信元タスクが
 * 開始した時点で`LiveTask`へ保存済みの`effectiveSandbox` / `effectiveApprovalMode` /
 * `autoApprove`（`checkEffectivePermissionEscalation`と同じ値）を使う。`send_message`は
 * 呼び出し元のセッションが生きていないと成立しない（MCPツールの呼び出しのため）ので、
 * 送信元の`LiveTask`は通常必ず見つかるが、内部矛盾で見つからない場合は判定を諦める。
 *
 * **【現在この関数は実質的に死んでいる】W9（roadmap、Issue #547）以降、`send_message`の
 * 宛先はオーケストレーターに固定され、タスク同士が直接メッセージを送り合うことはできなく
 * なった（design.md §16.34）。実タスクへ配送されるメッセージの`from`は常に
 * `ORCHESTRATOR_CONNECTION_ID`（値`-orchestrator-`）になるが、この値は`live.def.tasks`
 * （実タスクの定義一覧）には存在しない。下のループの`senderTask === undefined`判定が
 * 毎回成立し、`continue`して警告を一度も積まずに終わる——関数もこのファイルの実装も、
 * 意図的に変えていない（変える必要が無い）。実装だけを読むと「権限差を検出する防御が
 * ここで働いている」ように見えるが、実際には常に素通りする。**この検出を復活させるか、
 * 死んだコードとして削除するかは Issue #562 で決める**（まだどちらとも決まっていない。
 * 復活させる場合は、配送されたメッセージの元の送信元を`StoredMessage`とは別に追跡する
 * 仕組みが要る——現状の`StoredMessage`には由来の追跡情報（元はどのタスクが書いたか）が
 * 無いため、この構造のままでは復活させられない）。詳細と経緯はdesign.md §16.34
 * 「影響範囲」を参照。
 */
export function checkMessagingPermissionEscalation(
  self: WorkflowRunnerInternals,
  live: LiveRun,
  recipientTask: WorkflowTask,
  recipientTaskId: string,
  effective: EffectiveTaskConfig,
  messages: readonly StoredMessage[],
): void {
  const downstream: PermissionProfile = {
    provider: recipientTask.provider,
    sandbox: effective.sandbox,
    approvalMode: effective.config.approvalMode,
    autoApprove: effective.autoApprove,
  };

  for (const m of messages) {
    const senderTask = live.def.tasks.find((t) => t.id === m.from);
    const senderLive = live.tasks.get(m.from);
    if (senderTask === undefined || senderLive === undefined) {
      continue;
    }
    const upstream: PermissionProfile = {
      provider: senderTask.provider,
      sandbox: senderLive.effectiveSandbox,
      approvalMode: senderLive.effectiveApprovalMode,
      autoApprove: senderLive.autoApprove,
    };

    const reasons = permissionEscalationReasons(upstream, downstream);
    if (reasons.length === 0) {
      continue;
    }

    const message =
      `${recipientTaskId} は送信元タスク ${m.from} より緩い実効権限でメッセージを受け取り` +
      `ました（${reasons.join(', ')}）。${m.from} が送った本文に仕込まれた指示文が ` +
      `${recipientTaskId} の権限で実行されうるため、内容を確認してください`;
    const alreadyWarned = live.warnings.some(
      (w) =>
        w.kind === 'messagingPermissionEscalation' &&
        w.taskId === recipientTaskId &&
        w.message === message,
    );
    if (alreadyWarned) {
      continue;
    }
    self.deps.log.warn(`[workflow ${live.runId}/${recipientTaskId}] ${message}`);
    live.warnings.push({ kind: 'messagingPermissionEscalation', taskId: recipientTaskId, message });
  }
}

/** 回数切れは状態としてすでに`failed`が持っているため、都度作らず表示のたびに導出する。 */
export function deriveMaxReachedWarnings(live: LiveRun): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];
  for (const [taskId, state] of live.runState.tasks) {
    if (state.state === 'failed' && state.failure?.kind === 'maxReached') {
      // セッションが残っていれば「続ける」で続きから走らせられる（issue #284）。
      // リロード後は会話が失われていて「再実行」しかできないため、案内も出し分ける
      const hint = live.tasks.has(taskId)
        ? '。「続ける」で同じ会話のまま送信回数を足して再開できます'
        : '';
      warnings.push({
        kind: 'maxReached',
        taskId,
        message: `送信回数の上限に達しました（終了条件が満たされないまま停止）: ${taskId}${hint}`,
      });
    }
  }
  return warnings;
}

/**
 * 停滞（design.md §16.27、Issue #336）も`maxReached`と同じく状態としてすでに`failed`が
 * 持っているため、都度導出する（`deriveMaxReachedWarnings`と同じ理由）。
 */
export function deriveStalledWarnings(live: LiveRun): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];
  for (const [taskId, state] of live.runState.tasks) {
    if (state.state === 'failed' && state.failure?.kind === 'stalled') {
      // セッションが残っていれば「続ける」で続きから走らせられる（`continueTask`が
      // `maxReached`と同じ扱いに拡張してある）。リロード後は会話が失われているため
      // 「再実行」しかできない
      const hint = live.tasks.has(taskId)
        ? '。「続ける」で同じ会話のまま指示を変えて再開できます'
        : '';
      warnings.push({
        kind: 'loopStalled',
        taskId,
        message: `同じ応答が繰り返され、進捗が無いまま停止しました: ${taskId}${hint}`,
      });
    }
  }
  return warnings;
}
