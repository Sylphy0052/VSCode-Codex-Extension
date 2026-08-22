import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import type { LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import { buildEscalationRequest } from './approvalMapping';
import { classifyApprovalRequest, type EscalationPolicy, type TaskBoundary } from './escalation';
import {
  checkForgePrerequisites,
  createIntegrationPullRequest,
  buildIntegrationPullRequestBody,
  buildIntegrationPullRequestTitle,
  markPullRequestReady,
  parsePullRequestNumberFromUrl,
  resolveForgeHost,
  runFinalMerge,
  shouldCreateIntegrationPullRequest,
  shouldRunFinalMerge,
  type CliAvailabilityPort,
  type CliCommandRunner,
  type FinalMergeConfig,
  type ForgeFileSystemPort,
  type ForgeHost,
  type ForgeHostConfig,
  type PullRequestLayerConfig,
} from './forge';
import { INTEGRATION_DIR_NAME, IntegrationMergeQueue } from './integration';
import { applyRunCompletionToFile, type RoadmapFileSystemPort } from './roadmap';
import {
  IntegrationQueue as PseudoWorktreeIntegrationQueue,
  removePseudoWorktree,
  type PseudoWorktreeFileSystemPort,
  type Snapshot,
} from './pseudoWorktree';
import { composeNextPrompt, TaskMessagingHub, type HttpMcpTransportHandle } from './messaging';
import {
  applyLoopStopReason,
  createRunState,
  markApprovalRejected,
  markMergeSucceeded,
  markRunning,
  markWaitingApproval,
  recordSessionInfo,
  recordSubmissionCount,
  resumeFromApproval,
  retryTask as retryTaskState,
  continueTask as continueTaskState,
  type RunState,
  type TaskFailureReason,
  type TaskRunState,
  type TaskState,
} from './runState';
import {
  checkEffectivePermissionEscalation,
  checkMessagingPermissionEscalation,
  getSnapshot,
} from './runnerSnapshot';
import type { WorkflowRunnerInternals } from './runnerInternals';
import { cleanupWorktreeIfNeeded, retryMerge, startMerge } from './runnerMerge';
import { restoreRunsForView } from './runnerRestore';
import {
  buildRunTaskSnapshots,
  checkMessagingVisibility,
  checkWaitingReplyStalls,
  onMessageAccepted,
} from './runnerMessaging';
import {
  buildBoundary,
  integratePseudoWorktree,
  reflectPseudoWorktree,
  resolvePseudoState,
  resolveWorkingDirectory,
  validateExplicitCwds,
} from './runnerWorkingDirectory';
import { getRunOutcome, nextTasksToStart, type RunOutcome } from './scheduler';
import { WorkflowRunStore, type PersistedTaskState } from './runStore';
import type { OrchestratorEvent } from './orchestratorSession';
import {
  buildOrchestratorControlPort,
  disposeOrchestrator,
  markOrchestratorRead,
  notifyOrchestratorRunFinished,
  sendUserMessageToOrchestrator,
  setupOrchestratorForStart,
  syncOrchestratorTaskEvents,
} from './runnerOrchestrator';
import { sanitizeForLog, stripControlChars, stripControlCharsPreservingNewlines } from './sanitize';
import {
  buildEffectiveTaskConfig,
  type EffectiveTaskConfig,
  type ExtensionSafetyBaseline,
} from './taskConfig';
import { buildResponseSummary } from './taskSummary';
import type {
  ApprovalHandlerResult,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from './taskSession';
import {
  checkWorktreesGitignored,
  DEFAULT_BRANCH_NAMING,
  isGitWorkingTree,
  resolveHeadCommit,
  WorktreeCreationQueue,
  type BranchNaming,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from './worktree';
import {
  expandTemplate,
  MAX_WORKFLOW_FILE_BYTES,
  parseWorkflowYaml,
  validateWorkflow,
  withCommitRequirement,
  type Provider,
  type TaskResult,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowTask,
} from './workflow';

/**
 * スケジューラ（#53）が「開始せよ」と言ったタスクについて、セッションを作り、指示を送り、
 * 完了を検知して結果を返す（design.md §16.5 / §16.10）。
 *
 * VSCode APIには直接依存しない。`TaskSessionHost`（Codex/Claudeのチャット画面が実装）・
 * `GitCommandRunner` / `WorktreeFileSystemPort`（#55）・`WorkflowRunStore`
 * （`workspaceState` を抽象化した口）を注入で受け取り、`extension.ts` が実体を組み立てる。
 */

/** ワークフロー定義ファイルの読み込み口。サイズ上限のチェックを読み込む側の責務にする（design.md #52コメント）。 */
export interface WorkflowFilePort {
  /** バイト数。存在しない・読めない場合は undefined。 */
  fileSize(path: string): Promise<number | undefined>;
  readTextFile(path: string): Promise<string | undefined>;
}

/**
 * タスク間メッセージング（design.md §16.21）の待ちぼうけ検出（`checkWaitingReplyStalls`）を
 * 定期的に走らせる間隔。既定の`replyTimeoutSec`（300秒）に対して十分細かく、かつ
 * 負荷にならない値にしてある。
 */
export const WAITING_REPLY_POLL_INTERVAL_MS = 5_000;

export const nodeWorkflowFilePort: WorkflowFilePort = {
  async fileSize(path: string): Promise<number | undefined> {
    try {
      const stat = await fsPromises.stat(path);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  },
  async readTextFile(path: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * PR/MR作成（design.md §16.18）に要る依存。`forge.ts` のポートをそのまま束ねる。
 *
 * **`WorkflowRunnerDeps.forge` は省略可能。** 省略された場合、`resolveForgeState` は
 * `{ kind: 'disabled' }` を返し、PR/MRの作成を一切行わずローカルの統合ブランチへの
 * マージだけを進める（design.md §16.18「前提が欠けている場合」と同じ「ワークフロー自体は
 * 止めない」扱いを、依存の未配線そのものにも一貫して適用する）。`extension.ts` 側の配線が
 * 無くても既存のテスト・呼び出しがそのまま動くようにするための設計判断（最終報告に記載）。
 */
export interface WorkflowRunnerForgeDeps {
  cli: CliCommandRunner;
  cliAvailability: CliAvailabilityPort;
  fs: ForgeFileSystemPort;
  /**
   * 設定 `agent.workflows.forge` / `.pullRequest` / `.finalMerge` / `.branchNaming` /
   * `.draftPullRequest`。実行開始時に一度だけ読み直す（`readBaseline` と同じく使い捨ての
   * オブジェクトではなく関数で渡す）。
   *
   * `branchNaming` / `draftPullRequest` はPR/MR作成そのものとは別の関心事（前者はブランチ名の
   * 形、後者はDraft/ready化）だが、設定を`runner.ts`まで運ぶ経路を新設せず、既存の
   * `host`/`pullRequest`/`finalMerge`と同じ「実行開始時に一度読む」経路（`resolveForgeState`・
   * `resolveBranchNamingAndDraft`）へ相乗りさせてある。
   */
  readConfig: () => {
    host: ForgeHostConfig;
    pullRequest: PullRequestLayerConfig;
    finalMerge: FinalMergeConfig;
    branchNaming: BranchNaming;
    draftPullRequest: boolean;
  };
}

/**
 * タスク間メッセージング（design.md §16.21）に要る依存。`messaging.ts`のポートをそのまま束ねる。
 * `WorkflowRunnerDeps.forge`/`.pseudoWorktree`と同じく省略可能（上のJSDoc参照）。
 */
export interface WorkflowRunnerMessagingDeps {
  /** runごとに1つ、MCPサーバを起動する（design.md §16.21「サーバはrunごとに立て」）。 */
  startTransport: (hub: TaskMessagingHub) => Promise<HttpMcpTransportHandle>;
  /**
   * `agent.workflows.replyTimeoutSec` の現在値（秒）。省略時は`DEFAULT_REPLY_TIMEOUT_SEC`
   * （既定300秒）を使う。待ちぼうけ検出の経路2（`detectTimedOutWaitingReplies`）で使う。
   * 呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと
   * （`readBaseline`と同じ流儀。実行中に設定が変わっても次のtickから反映される）。
   */
  readReplyTimeoutSec?: () => number;
}

export interface WorkflowRunnerDeps {
  /** provider別の `TaskSessionHost`。`runner.ts` はプロバイダを見ずにこの口だけを使う。 */
  hosts: Record<Provider, TaskSessionHost>;
  /** 1実行（run）につき1つ使い回すこと（`WorktreeCreationQueue` 自身の制約）。 */
  worktreeQueue: WorktreeCreationQueue;
  git: GitCommandRunner;
  fs: WorktreeFileSystemPort;
  filePort: WorkflowFilePort;
  store: WorkflowRunStore;
  log: Logger;
  /**
   * 拡張機能側の現在の設定（クランプの基準）。タスクを開始する瞬間に読み直すため、
   * 呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと。
   */
  readBaseline: () => ExtensionSafetyBaseline;
  /** PR/MRの作成（design.md §16.18）。省略時は行わない（上のJSDoc参照）。 */
  forge?: WorkflowRunnerForgeDeps;
  /**
   * 疑似worktree（design.md §16.20）。gitの作業ツリーでないワークスペースで
   * `isolation: worktree`（既定）のタスクを走らせるときの隔離手段。**省略可能。**
   * 省略された場合、`decideWorkingDirectory`の`sharedFallback`は従来どおり
   * ワークスペース直下（`repoRoot`）を直接共有する（後方互換。`forge`と同じ設計判断）。
   */
  pseudoWorktree?: { fs: PseudoWorktreeFileSystemPort; exclude: readonly string[] };
  /**
   * ロードマップの更新（design.md §16.19、Issue #173）。runが終わったとき、`done` になった
   * タスクに対応する項目のチェックを書き戻す。**省略可能**で、省略された場合は書き戻さない
   * （`forge` / `pseudoWorktree` と同じ設計判断）。書き戻し先はワークフロー定義の
   * `roadmap`（`validateWorkflow` がワークスペース内の `.md` に限っている）。
   */
  roadmap?: { fs: RoadmapFileSystemPort };
  /**
   * タスク間メッセージング（design.md §16.21）。**省略可能。**
   *
   * 渡された場合、実行開始時にrunごと1つのMCPサーバを起動し（`startTransport`）、
   * タスクの開始時に`TaskSessionInput.mcp`へ接続用URLを渡す。渡された宛先への
   * `send_message`は、宛先タスクの次の送信（`setPromptTransform`）の先頭へ添えられる。
   *
   * **`waitingReply`への実際の遷移も配線済み（Issue #123）。** `TaskMessagingHub`の
   * `onAccepted`フックで`send_message`の受け付けを検知し、`expectReply: true`なら
   * 送信元タスクを`markWaitingReply`で倒したうえで`session.pauseLoop()`を呼ぶ
   * （`LoopController`が実際に`continuePrompt`を止める。`onMessageAccepted`参照）。
   * 宛先タスクが`waitingReply`であれば`resumeFromWaitingReply`で戻し
   * `session.resumeLoop()`を呼ぶ。待ちぼうけの2経路（`detectAllWaitingStalemate`/
   * `detectTimedOutWaitingReplies`）は`checkWaitingReplyStalls`が定期的（`WAITING_REPLY_POLL_INTERVAL_MS`
   * ごと）に確認する。
   *
   * MCP設定を実際にCLIの起動へ渡す配線（`TaskSessionInput.mcp`を読んで`thread/start`/
   * `--mcp-config`へ反映する部分）と、ツールの可視性確認
   * （`TaskSession.checkMessagingToolVisible`）は`src/view/chatView.ts` /
   * `claudeChatView.ts`側で実装済み（Issue #123）。
   */
  messaging?: WorkflowRunnerMessagingDeps;
  /** テスト用の差し替え口。既定は `node:crypto` の `randomUUID`。 */
  randomId?: () => string;
  /** テスト用の差し替え口。既定は `Date.now`。 */
  now?: () => Date;
}

export interface StartWorkflowResult {
  ok: boolean;
  runId?: string;
  errors?: readonly WorkflowIssue[];
  /** `true` のとき、`allowTaskIds` を確認のうえ `allowConfirmed: true` で呼び直すこと（design.md §16.7）。 */
  needsAllowConfirmation?: boolean;
  allowTaskIds?: readonly string[];
}

/** `WorkflowRunner.retryTask` の戻り値。`start()` の `allow` 確認と同じ形にしてある。 */
export interface RetryTaskResult {
  ok: boolean;
  /** `true` のとき、対象タスクに `allow` があるため確認のうえ `allowConfirmed: true` で呼び直すこと。 */
  needsAllowConfirmation?: boolean;
}

/** 一覧表示用の要約。#57のワークフローViewができるまでの間、コマンドのQuickPickに使う。 */
export interface LiveRunSummary {
  runId: string;
  name: string;
  defPath: string;
  outcome: RunOutcome;
}

/**
 * ワークフローViewの警告欄に出す1件（design.md §16.8「警告欄」）。
 *
 * `message` はここで組み立てる時点では拡張機能自身が作った文字列（gitのエラーは
 * `sanitizeForLog` を通した後）だが、Viewはそれでもテキストノードとして挿入する
 * （HTMLエスケープが要らないことをここでは前提にしない）。
 */
export interface WorkflowWarning {
  kind:
    | 'gitFallback'
    | 'gitCommonDir'
    | 'clamp'
    | 'allowOverride'
    | 'maxReached'
    | 'gitignore'
    /**
     * PR/MRの前提（`origin` remote・`gh`/`glab`のPATH・認証）が欠けているため、
     * PR/MRの作成を飛ばした（design.md §16.18「前提が欠けている場合」）。
     */
    | 'forgeSkipped'
    /** PR/MRの作成・push・最終マージのいずれかが失敗した（ワークフロー自体は止めない）。 */
    | 'forgeFailed'
    /**
     * 疑似worktree（design.md §16.20）の統合が衝突した。3-way mergeができないため、
     * 同じファイルへの変更は全て衝突になる（このタスクは`blocked`になる）。
     */
    | 'pseudoWorktreeConflict'
    /**
     * runの終了時、疑似worktreeの統合結果をワークスペースへ反映しようとしたが、
     * 実行中にワークスペース側が変更されていたため反映せず中止した
     * （design.md §16.20「人の編集を上書きしない」）。
     */
    | 'pseudoWorktreeReflectBlocked'
    /**
     * ゴール文から生成したワークフロー（`planner.ts`）が、既定の安全設定を上書きする
     * 指定（`autoApprove: true` / 非空の `allow` / `sandbox` や `approvalMode` の緩和）を
     * 含んでいる（design.md §16.9「分解セッションの制限」）。他のkindは実行時に動的へ
     * 発生するが、これは生成直後のプレビュー（`WorkflowViewManager.previewDefinition`）
     * でも出す必要があるため区別する。
     */
    | 'plannerSecurity'
    /**
     * 上流タスクより緩い `sandbox` / `autoApprove` を持つ下流タスクが、上流の応答
     * （`{{T1.result}}` / `{{T1.summary}}`）をテンプレート変数で参照している
     * （design.md §16.4「タスク間の引き継ぎ」、Issue #67）。`workflow.ts` の
     * `findPermissionEscalationWarnings` が読み込み時（`start()`）に検出する。
     */
    | 'permissionEscalation'
    /**
     * タスク間メッセージング（design.md §16.21）経由で、送信元より緩い実効権限を持つ
     * 宛先へメッセージが配送された（Issue #132）。`permissionEscalation`
     * （`{{T1.result}}`経由、Issue #67・依存関係のあるタスク間に限る）とは経路が違う
     * （メッセージは`dependsOn`を問わず任意の宛先へ送れる）ため、別のkindにして区別する。
     * `checkMessagingPermissionEscalation`が、メッセージが実際に配送される時点
     * （`setPromptTransform`が`takeDeliverableMessages`を呼んだ直後）で検出し
     * `live.warnings`へ積む。`permissionEscalation`と同じく警告のみでエラーにはしない。
     */
    | 'messagingPermissionEscalation'
    /**
     * タスク間メッセージング（design.md §16.21）専用のMCPツールが、タスクのセッションを
     * 開いた後に確認しても見えなかった（`TaskSession.checkMessagingToolVisible`が
     * `false`を返した）。design.md「見えていなければワークフローViewへ警告を出し、
     * 通信なしでそのまま走らせる。runは止めない」に対応する。
     */
    | 'messagingUnavailable'
    /**
     * タスク間メッセージングの待ちぼうけが解けた（design.md §16.21「待ちぼうけを検出する
     * 経路」）。`buildStalledWaitingReplyWarning`が組み立てた文言をそのまま使う。
     */
    | 'messagingStalled'
    /**
     * オーケストレーターセッション（design.md §16.23）を開始できなかった。実行は止めず、
     * ワークフローViewのオーケストレーター欄を「利用できません」にするだけにする
     * （§16.21の`messagingUnavailable`と同じ方針）。
     */
    | 'orchestratorUnavailable'
    /**
     * オーケストレーターが `update_task_prompt` で走行中タスクの継続指示を差し替えた
     * （design.md §16.23「道具」）。人がYAMLに書いた指示が実行中に別のものへ変わるのは
     * Viewを見ている人から最も気付きにくい変化なので、黙って行わず必ず警告欄へ出す。
     */
    | 'orchestratorPromptOverride';
  /** ワークフロー全体に関わる警告（gitignoreなど）は undefined。 */
  taskId: string | undefined;
  message: string;
}

/** `waitingApproval` のとき、Viewがその場に出す要求内容（design.md §16.8「承認」）。 */
export interface TaskPendingApprovalSnapshot {
  requestId: number | string;
  kind: string;
  title: string;
  detail: string;
}

/** タスク1件のView向けスナップショット。応答本文そのものではなく1行要約だけを持つ。 */
export interface TaskSnapshot {
  id: string;
  dependsOn: readonly string[];
  provider: Provider;
  state: TaskState;
  cwd: string | undefined;
  branch: string | undefined;
  submissionCount: number;
  retryCount: number;
  /** タスクが開始された時刻（ISO8601）。経過時間の表示に使う。未開始なら undefined。 */
  startedAt: string | undefined;
  lastResponseSummary: string;
  failure: TaskFailureReason | undefined;
  pendingApproval: TaskPendingApprovalSnapshot | undefined;
  /**
   * このウィンドウでセッションが生きているか。`reveal` / `中断` / `タスク停止` /
   * `承認` はこれが `true` のときだけ意味を持つ（design.md §16.11「リロード後の実行再開」。
   * リロード直後に復元したrunのタスクにはまだセッションが無く、`再実行` だけが有効）。
   */
  hasLiveSession: boolean;
  /**
   * `{{T1.result}}` 等を展開したあとの、実際にこのタスクへ送った最初のプロンプト
   * （design.md §16.4 案1「見せる」、Issue #67）。テンプレート変数がどう膨らんだかを
   * 人が読める形で確認できるようにするためのもので、`LiveTask`（メモリ上のみ）から
   * 都度導出する。応答本文と同じく永続化はしない（design.md §16.11）ため、リロード後は
   * `undefined` に戻る。制御文字は`stripControlChars`で除去済み（セキュリティ監査指摘#5）。
   */
  expandedPrompt: string | undefined;
  /**
   * `continuePrompt`（2回目以降に送る指示）の展開結果（design.md §16.4、セキュリティ
   * 監査指摘#6）。警告（案2）は`prompt`と`continuePrompt`の両方を参照先として走査するが、
   * `expandedPrompt`だけでは`continuePrompt`側の参照内容を確認する手段が無かったため
   * 追加した。`expandedPrompt`と同じ理由で永続化しない。制御文字は除去済み。
   */
  expandedContinuePrompt: string | undefined;
  /**
   * 実際にCLIへ送った直近の本文（`LiveTask.lastSentPrompt`参照、design.md §16.21、
   * Issue #132）。`expandedPrompt` / `expandedContinuePrompt`はテンプレート変数だけの
   * 展開結果（`composeNextPrompt`を経由しない）なので、タスク間メッセージング経由で
   * 注入された内容を確認する手段が無かった。この値はメッセージの合成結果を含む、
   * 実際に送信した文面そのもの。`expandedPrompt`と同じ理由で永続化しないため、
   * リロード後は`undefined`に戻る。
   */
  lastSentPrompt: string | undefined;
  /**
   * 衝突解決セッション（design.md §16.17「コンフリクト」・Issue #104）がこのタスクに
   * ついて走っているか。`live.mergeResolutions`はワークフローの定義に無い（ノード化しない）
   * ため、Viewは対象タスクのノードへ「マージ解決中」として重ねて出す判断にこれを使う。
   * `true`の間、`revealTask`はこのタスク自身のセッションではなく衝突解決セッションを開く。
   */
  mergeResolutionActive: boolean;
  /**
   * このタスクのPR/MRの番号（design.md §16.11・§16.18、Issue #118）。作られていなければ
   * `undefined`（`pullRequestUrl`も`undefined`のとき、Viewはリンクの欄を出さない）。
   * リロード直後（`hasLiveSession: false`）でも、永続化された値（`PersistedTaskState`）が
   * あれば読める。
   */
  pullRequestNumber: number | undefined;
  /** このタスクのPR/MRのURL。 */
  pullRequestUrl: string | undefined;
}

/** ワークフローViewが描画する1実行分のスナップショット（design.md §16.8）。 */
export interface WorkflowRunSnapshot {
  runId: string;
  name: string;
  defPath: string;
  outcome: RunOutcome;
  startedAt: string;
  tasks: readonly TaskSnapshot[];
  warnings: readonly WorkflowWarning[];
  /** 人の割り込み（`manual`/`interrupted`）で実行全体が停止しているか。 */
  haltedByUser: boolean;
  /**
   * ゴール文から生成した直後・未実行の下書きプレビューか（`WorkflowViewManager.
   * previewDefinition`専用。design.md §16.9セキュリティ監査 low「outcome: 'aborted'が
   * 紛らわしい」対応）。`outcome`の4値（running/succeeded/failed/aborted）には
   * 「まだ始まっていない」を表す値が無く、`aborted`（依存先の失敗等でskippedが出た
   * 実行）を便宜的に転用すると「失敗して中断した」と読めてしまう。実行中のrunでは
   * 常に`false`（`WorkflowRunner.getSnapshot`はこのフィールドを設定しないため、
   * オブジェクトスプレッドされない限りundefinedになり、falsyとして扱われる）。
   */
  isDraft?: boolean;
  /**
   * 統合ブランチ名（design.md §16.8「そのほか」・§16.17。Issue #104）。gitリポジトリでない
   * 実行（統合の概念が無い）や、`WorkflowViewManager.previewDefinition`が組み立てる
   * 生成直後の下書きプレビューでは`undefined`。`workflowGraph.ts`の`summarizeIntegration`が
   * これと`tasks`から統合の状況（取り込み済み件数）を導く。
   */
  integrationBranch?: string | undefined;
  /**
   * 統合PR/MRの番号（design.md §16.8「そのほか」・§16.11・§16.18、Issue #118）。
   * `integrationBranch`と同じく、統合の概念が無い実行やプレビューでは`undefined`。
   * `integrationPullRequestUrl`も`undefined`のとき、Viewはリンクの欄を出さない。
   */
  integrationPullRequestNumber?: number | undefined;
  /** 統合PR/MRのURL。 */
  integrationPullRequestUrl?: string | undefined;
  /**
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」）の成否。試みていなければ
   * `undefined`（`finalMerge: pr-only`、統合PR/MRの作成に失敗、runがまだ終わっていない等）。
   */
  finalMergeOutcome?: 'merged' | 'failed' | undefined;
  /**
   * オーケストレーターセッション（design.md §16.23「会話のUI」）の状態。ワークフローView
   * の「オーケストレーター」欄がこれを描く。セッションを開けなかったrun・リロードで復元した
   * runでは`available: false`（欄は「利用できません」になる）。
   */
  orchestrator?: OrchestratorSnapshot | undefined;
}

/**
 * ワークフローViewの「オーケストレーター」欄に出す値（design.md §16.23「会話のUI」）。
 *
 * **応答本文そのものは含めない。** 出すのは1行要約だけで、全文・承認カード・Markdown描画は
 * `会話を開く`で前面に出す既存のチャット画面が担う（オーケストレーター用に作り直さない）。
 */
export interface OrchestratorSnapshot {
  /** セッションが開けているか。`false`なら欄は「利用できません」になる。 */
  available: boolean;
  /** セッションを開いたプロバイダ。`available: false`なら`undefined`。 */
  provider?: Provider | undefined;
  /** ターンが走っている最中か（欄の状態表示「応答中」／「待機」）。 */
  busy: boolean;
  /** 直近の応答の1行要約。まだ応答が無ければ空文字。 */
  lastResponseSummary: string;
  /** 人が最後に会話を開いてから増えた応答の数（未読の印）。 */
  unreadCount: number;
}

/**
 * runごとのPR/MR作成の状態（design.md §16.18）。実行開始時に一度だけ `resolveForgeState`
 * が決め、run中は変えない（ホストやCLIの状態が実行中に変わっても、runの結果を一貫させる）。
 */
export type LiveRunForgeState =
  /** `WorkflowRunnerDeps.forge` が渡されていない、または `agent.workflows.forge` が `none`。 */
  | { kind: 'disabled' }
  /** ホストを判定できない、または前提（remote/CLI/認証）が欠けている。理由は`message`。 */
  | { kind: 'skipped'; message: string }
  | {
      kind: 'active';
      host: ForgeHost;
      pullRequest: PullRequestLayerConfig;
      finalMerge: FinalMergeConfig;
      /**
       * 統合PR/MRのbase（実行開始時のHEADブランチ）。detached HEAD等で解決できなければ
       * `undefined`（この場合、統合PR/MRの作成だけを飛ばす。タスク層のPR/MRは
       * 統合ブランチをbaseにするため影響しない）。
       */
      baseBranch: string | undefined;
    };

/**
 * タスクブランチの命名方式（design.md §16.6）とDraft PR/MR（design.md §16.18）の設定を読む。
 *
 * `deps.forge`（`WorkflowRunnerForgeDeps`）が渡されていなければ（テスト等で`forge`を
 * 省略している既存の呼び出し元）、`branchNaming`は`DEFAULT_BRANCH_NAMING`（`wf`）、
 * `draftPullRequest`は`false`という、これまでの挙動と完全に一致する既定へ倒す
 * （`resolveForgeState`が`deps.forge`未指定時に`disabled`へ倒すのと同じ設計判断。
 * `WorkflowRunnerDeps.forge`のJSDoc参照）。
 *
 * `start()`（新規実行）と`rebuildLiveRun()`（`runnerRestore.ts`、リロード後の復元）の
 * 両方から呼ぶため、`WorkflowRunner`のprivateメソッドにせずモジュール関数にしてある。
 */
export function resolveBranchNamingAndDraft(deps: WorkflowRunnerDeps): {
  branchNaming: BranchNaming;
  draftPullRequest: boolean;
} {
  const config = deps.forge?.readConfig();
  return {
    branchNaming: config?.branchNaming ?? DEFAULT_BRANCH_NAMING,
    draftPullRequest: config?.draftPullRequest ?? false,
  };
}

/**
 * PR/MRの結果（design.md §16.11・§16.18、Issue #118）。タスク層・統合層のどちらにも使う。
 * **番号とURLだけを持ち、本文は持たない**（§16.11「応答本文は保存しない」・§16.21と同じ
 * 方針。`prompt`/`done`はホストへ送るだけで、ここへは持ち帰らない）。`number`は
 * `parsePullRequestNumberFromUrl`がURLから取り出せなかった場合に`undefined`になりうるが、
 * `url`は常に持つ（呼び出し側は`url !== undefined`を確認してから結果を作る）。
 */
export interface PullRequestResult {
  number: number | undefined;
  url: string;
}

/**
 * タスク1件の実行時ブックキーピング。`RunState`（純粋）とは別に、セッション等の実体を持つ。
 *
 * 分割後のファイル（`runnerSnapshot.ts`等）へ型として渡すため`export`する（Issue #147）。
 * `WorkflowRunner`の外へ値として漏らすAPIは増やさない（`WorkflowRunner`のpublicメソッドの
 * 戻り値・引数には現れない）。
 */
export interface LiveTask {
  session: TaskSession;
  cwd: string;
  branch: string;
  /** クランプ済みの `autoApprove`。承認判定の入力に使う。 */
  autoApprove: boolean;
  /**
   * クランプ済み（実効値）の `sandbox` / `approvalMode`（Claudeでは `permissionMode`）。
   * 後続タスクが開始する際、実効値ベースの権限越境チェック（セキュリティ監査指摘#2。
   * `checkEffectivePermissionEscalation`）が上流タスクの「実際に使われた」権限として
   * 参照する。読み込み時のチェック（`findPermissionEscalationWarnings`）はYAMLの値しか
   * 見えず、未指定（拡張機能側の設定に委ねる）だと判定できないため、この実効値が要る。
   */
  effectiveSandbox: string;
  effectiveApprovalMode: string;
  boundary: TaskBoundary;
  /** `isolation: worktree` で実際にworktreeを使ったか。撤去してよいかの判定に使う。 */
  usedWorktree: boolean;
  /** gitでないワークスペースで疑似worktree（design.md §16.20）を使ったか。 */
  usedPseudoWorktree: boolean;
  /** `usedPseudoWorktree`のときだけ埋まる。複製直後のスナップショット（差分計算の基準）。 */
  pseudoSnapshot: Snapshot | undefined;
  /**
   * このタスクのブランチが分岐した時点の統合ブランチのコミット
   * （`resolveTaskBranchOrigin`。design.md §16.17「タスクブランチの分岐元」）。
   * `usedWorktree`が`false`（`shared`・明示`cwd`）のときは空文字。衝突解決時に
   * 「突き合わせる」相手のタスクを`findTaskIdsMergedSince`で特定するために使う。
   */
  originCommit: string;
  lastState: ChatState | undefined;
  /** `done` になったときだけ埋まる。後続タスクのテンプレート変数に使う（応答本文は永続化しない）。 */
  result: TaskResult | undefined;
  wasBusy: boolean;
  submissionCount: number;
  /** タスクが開始された時刻（ISO8601）。Viewの経過時間表示に使う。 */
  startedAt: string;
  /** 直近の応答の1行要約（design.md §16.8）。応答本文そのものは持たない。 */
  lastResponseSummary: string;
  /** `waitingApproval` の間だけ埋まる。Viewの「承認」操作が要求内容を出すために使う。 */
  pendingApproval: TaskPendingApprovalSnapshot | undefined;
  /**
   * テンプレート変数を展開したあとの最初のプロンプト（design.md §16.4 案1、Issue #67）。
   * タスク開始直前、`setPromptTransform` を差し込むのと同じタイミングで一度だけ計算する
   * （§16.4「展開は読み込み時ではなく、タスクの開始直前に行う」）。表示専用で、
   * `runLoop` へ渡す本文（展開前）とは別に持つ。`stripControlChars`済み（監査指摘#5）。
   */
  expandedPrompt: string | undefined;
  /** `continuePrompt`の展開結果。`expandedPrompt`と同時に計算する（セキュリティ監査指摘#6）。 */
  expandedContinuePrompt: string | undefined;
  /**
   * `setPromptTransform`が実際にCLIへ送った直近の本文（design.md §16.4 案1「見せる」の
   * メッセージング版、Issue #132）。
   *
   * `expandedPrompt` / `expandedContinuePrompt`はタスク開始直前に一度だけ計算する
   * テンプレート変数だけの展開結果で、`composeNextPrompt`（タスク間メッセージング、
   * design.md §16.21）を経由しない。そのため、メッセージ経由で注入された内容は
   * これまでViewのどこにも表示されなかった（起票時の指摘4）。この値は
   * `setPromptTransform`が返す値（＝実際にCLIへ送る文面そのもの）をそのまま
   * 表示用に保持したもので、送信のたびに（初回・継続の両方、メッセージの有無を問わず）
   * 更新する。`expandedPrompt`と同じく表示専用でworkspaceStateへは永続化しない
   * （design.md §16.11・§16.21「本文はworkspaceStateへ保存しない」）ため、リロード後は
   * `undefined`に戻る。制御文字は`stripControlCharsPreservingNewlines`で除去済み
   * （Trojan Source対策。表示用は改行を残す）。
   */
  lastSentPrompt: string | undefined;
  /**
   * オーケストレーターが差し替えた継続指示（design.md §16.23 `update_task_prompt`）。
   * 設定されている間、以降の送信では`continuePrompt`の代わりにこの本文を使う。
   *
   * **テンプレート変数は展開しない（リテラルとして送る）。** オーケストレーターの
   * 自由記述から`{{T1.result}}`の展開を起こすと、§16.4が`dependsOn`で縛っている
   * 「上流の結果が下流へ流れる」経路を依存関係を無視して増やすことになるため。
   * `lastSentPrompt`と同じく永続化しない（リロード後はYAMLの値に戻る）。
   */
  continuePromptOverride: string | undefined;
  /**
   * `waitingReply`（design.md §16.21）へ遷移した時刻（ms）。それ以外の状態では
   * `undefined`。`checkWaitingReplyStalls`の経路2（`detectTimedOutWaitingReplies`）の
   * 入力に使う。
   */
  waitingReplySinceMs: number | undefined;
  /**
   * このタスクのPR/MRの結果（design.md §16.11・§16.18、Issue #118）。`attemptMerge`
   * （`mergeTaskWithForge`が返す`flow.pullRequest.created && url !== undefined`の分岐）で
   * 書き込む。作られていなければ`undefined`。
   */
  pullRequest: PullRequestResult | undefined;
}

/**
 * オーケストレーターセッション（design.md §16.23）の実行時の状態。`LiveRun.tasks`
 * （依存グラフのノード＝通常のタスク）とは別に、runごとに1つだけ持つ。
 */
export interface LiveOrchestrator {
  session: TaskSession;
  /** セッションを開いたプロバイダ（`pickOrchestratorProvider`が決める）。 */
  provider: Provider;
  /** ターンが走っている最中か。走行中はイベントを溜め、割り込まない。 */
  busy: boolean;
  /** まだ送っていないイベント通知。ターンが終わったらまとめて送る。 */
  pending: OrchestratorEvent[];
  /** run全体で送ったイベント通知の総数（`MAX_ORCHESTRATOR_EVENTS_PER_RUN`の判定用）。 */
  eventsSent: number;
  /** 直近の応答の1行要約（Viewのオーケストレーター欄。応答本文そのものは持たない）。 */
  lastResponseSummary: string;
  /** 人が最後に会話を開いてから増えた応答の数。Viewの未読の印に使う。 */
  unreadCount: number;
}

/** `LiveTask`と同じ理由（直前のコメント参照）で`export`する（Issue #147）。 */
export interface LiveRun {
  runId: string;
  def: WorkflowDefinition;
  defPath: string;
  repoRoot: string;
  gitRepo: boolean;
  headCommit: string;
  startedAt: string;
  runState: RunState;
  tasks: Map<string, LiveTask>;
  finished: boolean;
  /** design.md §16.8「警告欄」。発生した順に積む（`maxReached` はスナップショット生成時に動的に足す）。 */
  warnings: WorkflowWarning[];
  /**
   * 統合ブランチ・統合worktree（design.md §16.17）。`gitRepo`が`true`のときだけ
   * `start()`（または`rebuildLiveRun`）が作る。`isolation: worktree`のタスクが1件も
   * 無い定義でも、runごとに1本という設計（§16.17「統合ブランチ」）どおり作る。
   */
  integration: { cwd: string; branch: string } | undefined;
  /** PR/MR作成の状態（design.md §16.18）。実行開始時に一度だけ決める。 */
  forge: LiveRunForgeState;
  /**
   * タスクブランチの命名方式（design.md §16.6「ブランチの命名方式」）。実行開始時に
   * 一度だけ決める（`resolveBranchNamingAndDraft`）。`forge`の活性状態（`disabled` /
   * `skipped` / `active`）とは無関係に決まる（PR/MRを作らない実行でもブランチ名の形には効く）。
   */
  branchNaming: BranchNaming;
  /**
   * PR/MRをDraftとして作るか（design.md §16.18「Draftとして作る」）。実行開始時に
   * 一度だけ決める（`resolveBranchNamingAndDraft`）。
   */
  draftPullRequest: boolean;
  /**
   * 疑似worktree（design.md §16.20）。`!gitRepo` かつ
   * `WorkflowRunnerDeps.pseudoWorktree`が渡されているときだけ実行開始時に一度作る
   * （gitの`integration`と対称の役割）。
   */
  pseudo:
    | {
        integrationDir: string;
        queue: PseudoWorktreeIntegrationQueue;
        baseline: Snapshot;
        exclude: readonly string[];
      }
    | undefined;
  /**
   * タスク間メッセージング（design.md §16.21）。`WorkflowRunnerDeps.messaging`が渡され、
   * かつMCPサーバの起動に成功したときだけ実行開始時に一度作る。
   *
   * `waitingReplyPollTimer`は待ちぼうけ検出（`checkWaitingReplyStalls`）を定期的に
   * 走らせるタイマー。`messaging`と同時に作り、run終了時に一緒に止める
   * （`finishRun`参照）。`.unref()`しているためテスト・プロセス終了を妨げない。
   */
  messaging:
    | {
        hub: TaskMessagingHub;
        transport: HttpMcpTransportHandle;
        waitingReplyPollTimer: ReturnType<typeof setInterval>;
      }
    | undefined;
  /**
   * 衝突解決セッション（design.md §16.17「コンフリクト」5.「解決用セッションは依存グラフの
   * ノードにはしない」）。`live.tasks`（グラフのノード＝通常のタスク）とは別に持つ。
   * taskIdをキーにする（1タスクにつき同時に1件のマージしか走らない）。
   */
  mergeResolutions: Map<string, TaskSession>;
  /**
   * オーケストレーターセッション（design.md §16.23）。runごとに1つ。開始に失敗した場合と、
   * リロード後に復元しただけの実行では`undefined`（会話は復元できないため。§16.11）。
   */
  orchestrator: LiveOrchestrator | undefined;
  /**
   * オーケストレーターへイベントを送った時点のタスクの状態（`syncOrchestratorTaskEvents`）。
   * 状態が変わった瞬間だけ通知するための、前回見た値の記録。
   */
  orchestratorSeenStates: Map<string, TaskState>;
  /**
   * 統合PR/MRの結果（design.md §16.11・§16.18、Issue #118）。`finalizeForge`で書き込む。
   * 作られていなければ`undefined`。
   */
  integrationPullRequest: PullRequestResult | undefined;
  /**
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」）の成否。`finalizeForge`で
   * 書き込む。試みていなければ`undefined`。
   */
  finalMergeOutcome: 'merged' | 'failed' | undefined;
}

/**
 * `WorkflowRunner.prepareTaskLaunch`（`startTask()`の分割、Issue #147）の戻り値。
 * `buildLiveTask` / `finishTaskLaunch`が同じ形をそのまま受け取る。
 */
interface TaskLaunchPreparation {
  cwd: string;
  branch: string;
  usedWorktree: boolean;
  usedPseudoWorktree: boolean;
  pseudoSnapshot: Snapshot | undefined;
  originCommit: string;
  effective: EffectiveTaskConfig;
  input: TaskSessionInput;
  boundaryResult: { boundary: TaskBoundary; warning: string | undefined };
}

/** `onChanged` の最小限のpub-sub。VSCodeの `EventEmitter` には依存しない（design.mdの方針どおり）。 */
class SimpleEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  on(listener: (value: T) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) {
        this.listeners.splice(i, 1);
      }
    };
  }
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

export class WorkflowRunner {
  /**
   * 分割後のファイル（`runnerSnapshot.ts`等、Issue #147）からは`self.runs`として読むが、
   * クラスの外（`src/view/`・`extension.ts`）へは出さない。分割時に一度`private`を外して
   * いたのを、`WorkflowRunnerInternals`（`runnerInternals.ts`）へ公開範囲を閉じたうえで
   * 戻したもの（PR #157のレビュー指摘）。外から可変状態へ直接届くと、`persist()`・
   * `notify()`を経ない書き換えで永続化した値とメモリ上の`LiveRun`が食い違う。
   */
  private readonly runs = new Map<string, LiveRun>();
  private readonly changeEmitter = new SimpleEmitter<string>();
  /**
   * `deps.worktreeQueue`から構築する。design.md §16.17「マージはworktreeの作成・撤去と
   * 同じ1本のキューに通して直列化する」ため、別インスタンスを持たせず必ず同じ
   * `WorktreeCreationQueue`をラップする（`integration.ts`の`IntegrationMergeQueue`の
   * 注意書き参照）。コンストラクタ内で組み立てることで、配線を誤って別のキューを
   * 渡す事故を型のうえで起こしえない状態にする。
   *
   * 分割後のファイルからは`self.integrationQueue`として触るが、`runs`と同じ理由
   * （直前のコメント参照）でクラスの外へは出さない。
   */
  private readonly integrationQueue: IntegrationMergeQueue;

  /**
   * 分割後のファイル（`runnerSnapshot.ts`等、Issue #147）へ渡す内部の口
   * （`runnerInternals.ts`のJSDoc参照）。
   *
   * `this as unknown as WorkflowRunnerInternals`のキャストで済ませない理由: キャストは
   * 構造的部分型の検査ごと無効にするため、クラス側と`WorkflowRunnerInternals`がずれても
   * `tsc`が検出しない（`pump`をリネームしても型検査は通り、実行時に
   * `self.pump is not a function`で落ちる）。ここで明示的に組み立てることで、
   * メンバの過不足・シグネチャのずれをコンパイル時に捕まえる。
   *
   * メソッドはアロー関数で包む。`prototype`側の実装を都度引くため、テストが
   * `WorkflowRunner.prototype.cleanupWorktreeIfNeeded`をスパイした場合もここを通る
   * 呼び出しにスパイが効く。
   */
  private readonly internals: WorkflowRunnerInternals;

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.integrationQueue = new IntegrationMergeQueue(deps.worktreeQueue);
    this.internals = {
      deps: this.deps,
      runs: this.runs,
      integrationQueue: this.integrationQueue,
      notify: (runId) => this.notify(runId),
      pump: (runId) => this.pump(runId),
      persist: (runId) => this.persist(runId),
      resolveForgeState: (repoRoot) => this.resolveForgeState(repoRoot),
      cleanupWorktreeIfNeeded: (live, task, taskId, liveTask) =>
        this.cleanupWorktreeIfNeeded(live, task, taskId, liveTask),
    };
  }

  /**
   * 実行状態が変わるたびに呼ばれる（design.md §16.8「更新はタスクの状態が変わったとき」）。
   * 通知の中身は `runId` だけで、実際の値は `getSnapshot` を呼んで取る。Viewはここで
   * 差分を計算し、変わった分だけをwebviewへ送る（design.md「送るのは差分のみ」）。
   *
   * 戻り値は購読解除の関数。VSCodeの `Disposable` は使わない（`runner.ts` はVSCode APIに
   * 依存しない設計方針。design.md §16.10）。
   */
  onChanged(listener: (runId: string) => void): () => void {
    return this.changeEmitter.on(listener);
  }

  /**
   * 分割後のファイル（`runnerMerge.ts`等、Issue #147）から`self.notify(...)`として呼ぶ。
   * 公開範囲は`WorkflowRunnerInternals`に閉じる（`runs`と同じ理由。上のコメント参照）。
   */
  private notify(runId: string): void {
    // タスクの状態が変わっていればオーケストレーターへ通知する（design.md §16.23）。
    // 状態遷移の呼び出し箇所へ個別に差し込むと漏れるため、Viewへの通知と同じ1点に集約する
    syncOrchestratorTaskEvents(this.internals, runId);
    this.changeEmitter.fire(runId);
  }

  /**
   * Viewが描画する現在の状態のスナップショット（design.md §16.8）。
   * 応答本文そのものではなく `LiveTask.lastResponseSummary`（1行要約）だけを渡す。
   *
   * 実体は`runnerSnapshot.ts`（読み取り専用のスナップショット構築、Issue #147）。
   */
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined {
    return getSnapshot(this.internals, runId);
  }

  /** 現在メモリ上で把握している実行（このウィンドウで開始したもの）の一覧。 */
  listLive(): LiveRunSummary[] {
    return [...this.runs.values()].map((live) => ({
      runId: live.runId,
      name: live.def.name,
      defPath: live.defPath,
      outcome: getRunOutcome(live.runState),
    }));
  }

  /**
   * このsessionId（Codexのthread id / Claudeのsession id）がタスク（オーケストレータ）
   * 管理下かどうかを答える（design.md §16.10の7）。`ChatViewManager` /
   * `ClaudeChatViewManager` の `isTaskManagedThread` へそのまま渡す用途。
   *
   * **永続化された`WorkflowRunStore`を見る。メモリ上の `this.runs` だけを見てはいけない。**
   * ウィンドウのリロード直後は `this.runs`（このプロセスのライブな実行状態）が空になる
   * 一方、`restorePanel`（VSCodeのWebviewパネル復元）はまさにその瞬間に呼ばれる。
   * メモリだけを見ると常に`false`を返してしまい、worktreeで走っていたタスクのタブが
   * 汎用復元に拾われてワークスペース直下のcwdでセッションが復活する事故になる
   * （レビュー指摘: critical 1）。`workspaceState`は`reconcileAfterReload`後も
   * `sessionId`を保持したまま残るため、これを見れば復元直後でも正しく判定できる。
   */
  isTaskManagedSessionId(sessionId: string): boolean {
    if (sessionId === '') {
      return false;
    }
    return this.deps.store
      .list()
      .some((run) => Object.values(run.tasks).some((t) => t.sessionId === sessionId));
  }

  /**
   * リロード直後に呼ぶ（design.md §16.11「リロード後の実行再開」）。
   * 実体は`runnerRestore.ts`（Issue #147）。
   */
  async restoreRunsForView(): Promise<void> {
    return restoreRunsForView(this.internals);
  }

  /**
   * `start()`の前半（読み込み・解析・検証）。サイズ上限チェックのコメントは
   * `MAX_WORKFLOW_FILE_BYTES`のJSDoc（巨大なYAMLで拡張機能ホストを固まらせない防御）参照。
   */
  private async parseAndValidateWorkflow(
    defPath: string,
  ): Promise<
    { ok: true; def: WorkflowDefinition } | { ok: false; errors: readonly WorkflowIssue[] }
  > {
    const size = await this.deps.filePort.fileSize(defPath);
    if (size === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }
    if (size > MAX_WORKFLOW_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          issue(
            `定義ファイルが大きすぎます（上限${MAX_WORKFLOW_FILE_BYTES}バイト）: ${size}バイト`,
          ),
        ],
      };
    }
    const text = await this.deps.filePort.readTextFile(defPath);
    if (text === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }

    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [issue(`YAMLの解析に失敗しました: ${message}`)] };
    }

    const validation = validateWorkflow(def);
    for (const w of validation.warnings) {
      this.deps.log.warn(`[workflow] ${w.message}`);
    }
    if (validation.errors.length > 0) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, def };
  }

  /** `start()`のgit判定（design.md §16.6）。gitでない場合は`worktree-strict`の禁止を確認する。 */
  private async resolveStartGitContext(
    repoRoot: string,
    def: WorkflowDefinition,
  ): Promise<
    | { ok: true; gitRepo: boolean; headCommit: string }
    | { ok: false; errors: readonly WorkflowIssue[] }
  > {
    const gitRepo = await isGitWorkingTree(repoRoot, this.deps.git);
    if (gitRepo) {
      const head = await resolveHeadCommit(repoRoot, this.deps.git);
      if (head === undefined) {
        return { ok: false, errors: [issue('HEADコミットを解決できませんでした')] };
      }
      return { ok: true, gitRepo, headCommit: head };
    }
    const strictWithoutCwd = def.tasks.find(
      (t) => t.isolation === 'worktree-strict' && t.cwd === undefined,
    );
    if (strictWithoutCwd !== undefined) {
      return {
        ok: false,
        errors: [
          issue(
            'ワークスペースがgitの作業ツリーではないため、isolation: worktree-strict のタスクを実行できません',
            [strictWithoutCwd.id],
          ),
        ],
      };
    }
    return { ok: true, gitRepo, headCommit: '' };
  }

  /**
   * 統合ブランチ・統合worktree（design.md §16.17）。runごとに1本、実行開始時に一度だけ
   * 作る。`isolation: worktree`のタスクが1件も無い定義でも作る（design.md §16.17
   * 「統合ブランチ」がrun単位の概念として定めているため）。
   */
  private async createIntegrationForStart(
    repoRoot: string,
    runId: string,
    headCommit: string,
    gitRepo: boolean,
  ): Promise<
    | { ok: true; integration: { cwd: string; branch: string } | undefined }
    | { ok: false; errors: readonly WorkflowIssue[] }
  > {
    if (!gitRepo) {
      return { ok: true, integration: undefined };
    }
    const created = await this.integrationQueue.createIntegrationWorktree(
      { repoRoot, runId, headCommit },
      this.deps.git,
      this.deps.fs,
    );
    if (!created.ok) {
      return {
        ok: false,
        errors: [issue(`統合worktreeの作成に失敗しました: ${created.message}`)],
      };
    }
    return { ok: true, integration: { cwd: created.cwd, branch: created.branch } };
  }

  /**
   * 疑似worktree（design.md §16.20）。gitでない実行だけ、統合先を実行開始時に一度作る
   * （`isolation: worktree`のタスクが1件も無い定義でも作る。git版の統合worktreeと同じ
   * 「run単位の概念として定める」扱い）。作成に失敗したら実行を始めない
   * （git版の統合worktree作成失敗と同じ扱い。中途半端な状態で走らせない）。
   */
  private async createPseudoWorktreeForStart(
    repoRoot: string,
    runId: string,
    gitRepo: boolean,
  ): Promise<
    { ok: true; pseudo: LiveRun['pseudo'] } | { ok: false; errors: readonly WorkflowIssue[] }
  > {
    if (gitRepo) {
      return { ok: true, pseudo: undefined };
    }
    const resolved = await resolvePseudoState(this.internals, repoRoot, runId);
    if (!resolved.ok) {
      return {
        ok: false,
        errors: [issue(`疑似worktreeの統合先の作成に失敗しました: ${resolved.message}`)],
      };
    }
    return { ok: true, pseudo: resolved.state };
  }

  /**
   * タスク間メッセージング（design.md §16.21）。省略可能（`WorkflowRunnerDeps.messaging`
   * のJSDoc参照）。MCPサーバの起動に失敗しても実行は止めない。
   */
  private async setupMessagingForStart(
    runId: string,
    live: LiveRun,
    messaging: WorkflowRunnerMessagingDeps,
  ): Promise<void> {
    const hub = new TaskMessagingHub({
      listRunTasks: () => buildRunTaskSnapshots(this.internals, runId),
      onAccepted: (message) => onMessageAccepted(this.internals, runId, message),
      // オーケストレーター専用の接続にだけ見せる制御ツール（design.md §16.23）。
      // Viewのボタンと同じ公開メソッド（`this`）を通す
      orchestratorControl: buildOrchestratorControlPort(this.internals, this, runId),
    });
    try {
      const transport = await messaging.startTransport(hub);
      const waitingReplyPollTimer = setInterval(
        () => checkWaitingReplyStalls(this.internals, runId),
        WAITING_REPLY_POLL_INTERVAL_MS,
      );
      waitingReplyPollTimer.unref?.();
      live.messaging = { hub, transport, waitingReplyPollTimer };
    } catch (e) {
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.warn(
        `[workflow ${runId}] MCPサーバの起動に失敗したため、タスク間メッセージングなしで実行します: ${message}`,
      );
    }
  }

  /**
   * 定義ファイルを読み込み、検証し、通れば実行を開始する。
   *
   * `repoRoot` はワークフロー定義ファイルが属するワークスペースフォルダの絶対パス
   * （design.md §16.6「`currentWorkspaceFolder()` は使わない」の呼び出し側での実践）。
   *
   * `allow` を含むタスクが1件でもあれば、`options.allowConfirmed !== true` の間は
   * 実行を始めず `needsAllowConfirmation` を立てて返す（design.md §16.7「`allow`を含む
   * ワークフローは、実行開始時に...確認を取る」）。呼び出し側（`extension.ts` /
   * ワークフローView）はこれを見てモーダルを出し、確認が取れたら
   * `allowConfirmed: true` で呼び直す。
   */
  async start(
    defPath: string,
    repoRoot: string,
    options?: { allowConfirmed?: boolean },
  ): Promise<StartWorkflowResult> {
    const parsed = await this.parseAndValidateWorkflow(defPath);
    if (!parsed.ok) {
      return parsed;
    }
    const { def } = parsed;

    const allowTaskIds = def.tasks.filter((t) => t.allow.length > 0).map((t) => t.id);
    if (allowTaskIds.length > 0 && options?.allowConfirmed !== true) {
      return { ok: false, needsAllowConfirmation: true, allowTaskIds };
    }

    const gitContext = await this.resolveStartGitContext(repoRoot, def);
    if (!gitContext.ok) {
      return gitContext;
    }
    const { gitRepo, headCommit } = gitContext;

    const cwdErrors = await validateExplicitCwds(this.internals, def, repoRoot);
    if (cwdErrors.length > 0) {
      return { ok: false, errors: cwdErrors };
    }

    const gitignoreCheck = await checkWorktreesGitignored(repoRoot, this.deps.fs);
    const warnings: WorkflowWarning[] = [];
    if (gitignoreCheck.needsEntry && gitignoreCheck.message !== undefined) {
      this.deps.log.warn(`[workflow] ${gitignoreCheck.message}`);
      warnings.push({ kind: 'gitignore', taskId: undefined, message: gitignoreCheck.message });
    }
    // allowによる危険判定の解除はここでは積まない。`getSnapshot`が`live.def.tasks`から
    // 都度導出する（`deriveAllowWarnings`）。ここで1回だけ積むと、ウィンドウのリロードで
    // 復元した実行（`rebuildLiveRun`は`warnings: []`で初期化する）では二度と現れず、
    // design.md §16.7の「常時出す」が復元経路だけ欠けてしまう（レビュー指摘: high）

    // runIdは統合worktreeのパス（`integrationWorktreePath`）を組み立てるのに要るため、
    // 統合worktreeの作成より前に確定させる
    const runId = this.deps.randomId?.() ?? randomUUID();

    const integrationResult = await this.createIntegrationForStart(
      repoRoot,
      runId,
      headCommit,
      gitRepo,
    );
    if (!integrationResult.ok) {
      return integrationResult;
    }
    const { integration } = integrationResult;

    // PR/MR作成の前提チェック（design.md §16.18「実行開始前に次を確かめる」）。gitでない
    // 実行には統合ブランチ自体が無いため対象外
    const forge: LiveRunForgeState = gitRepo
      ? await this.resolveForgeState(repoRoot)
      : { kind: 'disabled' };
    if (forge.kind === 'skipped') {
      this.deps.log.warn(`[workflow ${runId}] ${forge.message}`);
      warnings.push({ kind: 'forgeSkipped', taskId: undefined, message: forge.message });
    }

    const pseudoResult = await this.createPseudoWorktreeForStart(repoRoot, runId, gitRepo);
    if (!pseudoResult.ok) {
      return pseudoResult;
    }
    const { pseudo } = pseudoResult;

    const { branchNaming, draftPullRequest } = resolveBranchNamingAndDraft(this.deps);

    const live: LiveRun = {
      runId,
      def,
      defPath,
      repoRoot,
      gitRepo,
      headCommit,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      runState: createRunState(def.tasks),
      tasks: new Map(),
      finished: false,
      warnings,
      integration,
      forge,
      branchNaming,
      draftPullRequest,
      pseudo,
      messaging: undefined,
      mergeResolutions: new Map(),
      orchestrator: undefined,
      orchestratorSeenStates: new Map(),
      integrationPullRequest: undefined,
      finalMergeOutcome: undefined,
    };
    this.runs.set(runId, live);

    if (this.deps.messaging !== undefined) {
      await this.setupMessagingForStart(runId, live, this.deps.messaging);
    }
    // オーケストレーターセッション（design.md §16.23）。MCPサーバ（上の
    // `setupMessagingForStart`）の後に開くのは、制御ツール用の接続URLをそこから
    // 発行するため。失敗しても実行は止めない。
    //
    // **`await`しない。** CLIの起動を待つあいだタスクの開始が止まってしまい、
    // オーケストレーターが立ち上がるまで実行が始まらない形になる（§16.21の
    // `checkMessagingToolVisible`を投げっぱなしにしているのと同じ理由）。セッションが
    // 用意できるまでのあいだに起きた状態変化は、`syncOrchestratorTaskEvents`が
    // 「前回見た状態」を持たないところから始めるため、用意できた直後にまとめて届く
    void setupOrchestratorForStart(this.internals, runId, live);

    await this.persist(runId);
    this.notify(runId);
    this.pump(runId);
    return { ok: true, runId };
  }

  /**
   * 実行全体を停止する（design.md §16.5）。人の割り込み（`manual`）と同じ扱いで
   * `haltedByUser` を立て、まだ開始していない `pending` を `skipped` にしたうえで、
   * **走行中のタスクのループも止める**（issue #322）。
   *
   * 以前は新しいタスクの開始を止めるだけで、走っているタスクのループはそのまま回り続けて
   * いた。終了条件を満たすか回数を使い切るまで指示が送られ続けるため、「全体の停止」という
   * ボタン名と挙動が食い違っていた。
   *
   * 止め方は `stopTask` と同じ `TaskSession.stopLoop()`（`LoopStopReason: 'taskStopped'` →
   * `failed`（手動停止）で確定）。**進行中のターンには割り込まない**（`interrupt()` は
   * 呼ばない）。中途半端な編集をworktreeへ残さないためで、そのターンが終わってから次の
   * 指示を送らずに止める。worktreeとブランチは従来どおり残り、人が中身を確認できる。
   *
   * 対象はセッションが生きている未確定のタスクだけ。`merging` はループが既に終わっていて
   * 止める対象が無いため含めない（`isActiveTaskState` をそのまま使わないのはこのため）。
   * リロード直後で復元しただけの実行は `live.tasks` が空なので、何も呼ばずに抜ける。
   */
  stop(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    // `manual` / `interrupted` の遷移はtaskIdを使わない（実装上の事実。runState.ts参照）ため
    // 空文字で十分だが、意図を示すため定数として明示しておく
    const NO_SPECIFIC_TASK = '';
    live.runState = applyLoopStopReason(live.runState, live.def.tasks, NO_SPECIFIC_TASK, 'manual');
    // `stopLoop()` は完了検知経路（`onFinished` → `onTaskFinished`）へ合流し、その中で
    // `live.runState` と `live.tasks` が書き換わる。走らせながら絞り込むと取りこぼすため、
    // 対象を先に確定させてから止める
    const targets = [...live.tasks.entries()].filter(([taskId]) => {
      const state = live.runState.tasks.get(taskId)?.state;
      return state === 'running' || state === 'waitingApproval' || state === 'waitingReply';
    });
    for (const [, liveTask] of targets) {
      liveTask.session.stopLoop();
    }
    this.notify(runId);
    void this.persist(runId);
  }

  // ---- ワークフローViewからのタスク単位の操作（design.md §16.8） ----

  /**
   * そのタスクのチャットタブを前面に出す。閉じていれば作り直し、会話を復元する
   * （`TaskSession.reveal()`。#56で実装済みの寿命分離をそのまま使う）。
   *
   * **衝突解決セッション（design.md §16.17「コンフリクト」5.・Issue #104）が走っている間は
   * そちらを優先する。** タスク自身のセッションは`onTaskFinished`が`done`の時点で既に
   * `dispose()`済み（マージへ進むため）で、開き直しても会話の続きは見えない。衝突解決は
   * 別セッション（統合worktreeで開く）で進行中のため、Viewの「マージ解決中」表示から
   * 押したときはそちらのタブへ移動しないと意味が無い。
   *
   * リロード直後で復元しただけの実行（`live.tasks` にまだ実体が無い）に対しては
   * 何もできない。`false` を返すので、Viewは「再実行」だけを案内する。
   */
  revealTask(runId: string, taskId: string): boolean {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return false;
    }
    const mergeResolutionSession = live.mergeResolutions.get(taskId);
    if (mergeResolutionSession !== undefined) {
      mergeResolutionSession.reveal();
      return true;
    }
    const liveTask = live.tasks.get(taskId);
    if (liveTask === undefined) {
      return false;
    }
    liveTask.session.reveal();
    return true;
  }

  /**
   * 進行中のターンだけ止める（design.md §16.8「中断」）。タスクのループは続き、
   * 次の指示（`continuePrompt`）から進む。`TaskSession.interrupt()` を直接呼ぶだけで、
   * `noteUserAction()` は経由しない（それだとループごと止まってしまう。`taskSession.ts` 参照）。
   */
  async interruptTask(runId: string, taskId: string): Promise<void> {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    if (liveTask === undefined) {
      return;
    }
    await liveTask.session.interrupt();
  }

  /**
   * そのタスクのループを止め、`failed`（手動停止）にする（design.md §16.8「タスク停止」）。
   *
   * `TaskSession.stopLoop()` はループを `LoopStopReason: 'taskStopped'` で止め、
   * 通常の完了検知経路（`onFinished` → `onTaskFinished`）へ合流する。そちら側で
   * `applyLoopStopReason` が `manualStop` として確定し、セッションの解放とworktreeの
   * 撤去判定まで一貫して行われるため、ここでは呼び出すだけでよい。
   */
  stopTask(runId: string, taskId: string): void {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    if (liveTask === undefined) {
      return;
    }
    liveTask.session.stopLoop();
  }

  /**
   * `failed` / `skipped` のタスクを、依存が満たされていればもう1度走らせる
   * （design.md §16.8「再実行」）。対象外（依存未達・未確定の状態・未知のid）なら
   * 何もせず `false` を返す。
   *
   * リロード直後で復元した実行（`live.tasks` が空）でも動く。`retryTaskState` が
   * `live.runState`（`workspaceState` から復元済み）だけを見て `pending` へ戻し、
   * `pump()` が `startTask()` を呼んで新しいセッションを作る。
   *
   * 対象タスクに非空の `allow` があれば、`options.allowConfirmed !== true` の間は
   * 再実行を始めず `needsAllowConfirmation` を立てて返す（`start()` と同じ形。
   * レビュー指摘: high）。`start()` の実行前確認は**そのプロセスの最初の起動時**にしか
   * 効かず、ウィンドウのリロード後に復元した実行を「再実行」する経路はそれを経由しない
   * ため、ここでも独立して確認を要求する。
   */
  retryTask(
    runId: string,
    taskId: string,
    options?: { allowConfirmed?: boolean },
  ): RetryTaskResult {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return { ok: false };
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task !== undefined && task.allow.length > 0 && options?.allowConfirmed !== true) {
      return { ok: false, needsAllowConfirmation: true };
    }
    const next = retryTaskState(live.runState, live.def.tasks, taskId);
    if (next === live.runState) {
      return { ok: false };
    }
    live.runState = next;
    // 停止していた実行を人の操作で再開する起点でもあるため、finishedを解除する
    live.finished = false;
    this.notify(runId);
    void this.persist(runId);
    this.pump(runId);
    return { ok: true };
  }

  /**
   * 回数切れ（`maxReached`）で止まったタスクを、同じ会話のまま続きから走らせる
   * （design.md §16.8「続ける」、issue #284）。対象外なら何もせず `false` を返す。
   *
   * 「再実行」（`retryTask`）との違いは、新しいセッション・worktreeを作らないこと。
   * 生きているセッションへ `runLoop` をもう1度かけ、`initialPrompt` を空にして
   * 継続プロンプトから再開する（`LoopController.start` が空の初回指示を継続指示で
   * 代替する）。送信回数の予算は `maxIterations` 分そのまま増える。
   *
   * このウィンドウでセッションが生きていることが前提なので、リロード後の復元した実行では
   * 使えない（`live.tasks` が空。Viewもボタンを出さない）。同じ理由で `allow` の実行前確認は
   * 挟まない。セッションが生きている＝このプロセスの `start()` / `retryTask` が既に確認を
   * 通してからこのタスクを起動している、ということだから。
   */
  continueTask(runId: string, taskId: string): boolean {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      return false;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      return false;
    }
    const next = continueTaskState(live.runState, live.def.tasks, taskId);
    if (next === live.runState) {
      return false;
    }
    live.runState = next;
    // 停止していた実行を人の操作で再開する起点（`retryTask`と同じ）
    live.finished = false;
    // `finishTaskLaunch`と同じ終了条件を組み立てる。専用ブランチを持つタスクは
    // 「コミットしてあること」を自動で足す（design.md §16.17）
    const condition = liveTask.usedWorktree ? withCommitRequirement(task.done) : task.done;
    liveTask.session.runLoop({
      // 初回の指示は送らない。ここは会話の続きであり、`task.prompt`をもう1度送ると
      // 同じ作業を最初からやり直させることになる
      initialPrompt: '',
      continuePrompt: task.continuePrompt,
      maxIterations: task.maxIterations,
      condition,
    });
    this.notify(runId);
    void this.persist(runId);
    return true;
  }

  /**
   * オーケストレーターセッション（design.md §16.23）へ人の発話を送る。ワークフローViewの
   * 入力欄から呼ぶ。セッションが無い（開始に失敗した・復元しただけの実行）場合と空文字は
   * `false` を返し、View側は何も起きなかったことにする。
   */
  sendToOrchestrator(runId: string, text: string): boolean {
    return sendUserMessageToOrchestrator(this.internals, runId, text);
  }

  /**
   * オーケストレーターセッションのチャットタブを前面に出す（design.md §16.23「会話のUI」）。
   * 開いた時点で未読の印を消す。
   */
  revealOrchestrator(runId: string): boolean {
    const orchestrator = this.runs.get(runId)?.orchestrator;
    if (orchestrator === undefined) {
      return false;
    }
    orchestrator.session.reveal();
    markOrchestratorRead(this.internals, runId);
    return true;
  }

  /**
   * 拡張機能の終了時にオーケストレーターセッションを解放する（design.md §16.23
   * 「セッションの生成と寿命」の`dispose`）。runの終了では解放しない（run完了後も
   * 会話を続けられるようにするため）。
   */
  dispose(): void {
    for (const live of this.runs.values()) {
      disposeOrchestrator(live);
    }
  }

  /**
   * `waitingApproval` の要求を、チャット画面のタブを開かずその場で決める
   * （design.md §16.8「承認」）。`handleApproval` が保留した `pendingApproval` の
   * `requestId` を使って `TaskSession.decideApproval` を呼ぶ。対象が無ければ何もしない。
   */
  decideApproval(runId: string, taskId: string, decision: ApprovalDecision): boolean {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    const pending = liveTask?.pendingApproval;
    if (liveTask === undefined || pending === undefined) {
      return false;
    }
    liveTask.session.decideApproval(pending.requestId, decision);
    return true;
  }

  /**
   * 終わった（`done`/`failed`/`blocked`/`skipped`）タスクのworktreeをまとめて撤去する
   * （design.md §16.8「そのほか」の操作。`cleanup: keep` のまま放置されたものを
   * 後から片付ける手段）。`onTaskDone`は対象タスク1件の処理（撤去できた・できなかった・
   * そもそも対象外だった、いずれも含む）が終わるたびに呼ぶ（`cleanupIntegration`の
   * 進捗表示、Issue #298「進捗が分からない」から使う。省略可能）。
   */
  async removeWorktrees(
    runId: string,
    onTaskDone?: (taskId: string) => void,
  ): Promise<{ removed: string[]; failed: string[] }> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return { removed: [], failed: [] };
    }
    const removed: string[] = [];
    const failed: string[] = [];
    for (const task of live.def.tasks) {
      const state = live.runState.tasks.get(task.id);
      // `merging`（マージ未了。統合ブランチへ入るまで消してはいけない）は対象外にする。
      // `blocked`は自動撤去（`shouldRemoveWorktree`）の対象からは外れているが、これは
      // 人が明示的に「終わったタスクのworktreeをまとめて撤去する」操作なので含める
      // （gitの場合。疑似worktreeの`blocked`は下の`removePseudoTaskWorktree`が別途除く）
      if (
        state === undefined ||
        (state.state !== 'done' &&
          state.state !== 'failed' &&
          state.state !== 'blocked' &&
          state.state !== 'skipped')
      ) {
        continue;
      }
      const liveTask = live.tasks.get(task.id);
      if (live.gitRepo) {
        await this.removeGitTaskWorktree(live, runId, task, state, liveTask, removed, failed);
      } else {
        await this.removePseudoTaskWorktree(live, runId, task, state, liveTask, removed, failed);
      }
      onTaskDone?.(task.id);
    }
    this.notify(runId);
    return { removed, failed };
  }

  /**
   * gitワークスペースの1タスク分のworktreeを、すべての試行分撤去する（Issue #298）。
   *
   * `worktreePath`は再試行のたびに`<taskId>` → `<taskId>-retry0` → `<taskId>-retry1`と
   * 別ディレクトリを作る（design.md §16.5「新しいworktreeでやり直す」）。以前は
   * `retrySuffixOf`が返す**現在の**試行1件しか撤去しておらず、過去の試行分（人が中身を
   * 見られるように残してあるもの。§16.17）がすべて残ってしまっていた。撤去対象は
   * 「retryなし（初回）」と`0..合計試行数-1`のすべてにする。既に存在しないパスは
   * `removeWorktree`が`pathExists`で成功扱いにするため、実在を気にせず全件呼んでよい。
   * 1件でも失敗すればそのタスクは`failed`側に入れる。
   */
  private async removeGitTaskWorktree(
    live: LiveRun,
    runId: string,
    task: WorkflowTask,
    state: TaskRunState,
    liveTask: LiveTask | undefined,
    removed: string[],
    failed: string[],
  ): Promise<void> {
    // このウィンドウでworktreeを作ったことが判っている（liveTask.usedWorktree）場合を
    // 優先し、リロード復元でliveTaskが無い場合は定義から推定する（cwdを明示していない
    // worktree系isolationかつgitリポジトリなら作られたはず、という近似）
    const usedWorktree =
      liveTask?.usedWorktree ??
      (task.cwd === undefined &&
        (task.isolation === 'worktree' || task.isolation === 'worktree-strict'));
    if (!usedWorktree) {
      return;
    }
    const totalAttempts = state.retryCount + state.manualRetryCount;
    const retries: Array<number | undefined> = [
      undefined,
      ...Array.from({ length: totalAttempts }, (_, i) => i),
    ];
    const messages: string[] = [];
    for (const retry of retries) {
      const result = await this.deps.worktreeQueue.remove(
        live.repoRoot,
        runId,
        task.id,
        retry,
        this.deps.git,
        this.deps.fs,
      );
      if (!result.ok) {
        messages.push(result.message);
      }
    }
    if (messages.length === 0) {
      removed.push(task.id);
    } else {
      failed.push(task.id);
      this.deps.log.warn(
        `[workflow ${runId}/${task.id}] worktreeの撤去に失敗しました: ${messages.join(' / ')}`,
      );
    }
  }

  /**
   * gitでないワークスペース（疑似worktree、design.md §16.20）の1タスク分の複製を撤去する
   * （Issue #298「疑似worktreeが撤去対象にならない」）。
   *
   * **`blocked`のタスクの複製は残す。** gitならタスクブランチが残るため撤去しても
   * 中身を後から辿れるが、疑似worktreeにはブランチが無く、複製を消すと未統合の差分
   * （3-way mergeができず衝突として弾かれた分。design.md §16.20）を復元する手段が
   * 無くなってしまう。
   */
  private async removePseudoTaskWorktree(
    live: LiveRun,
    runId: string,
    task: WorkflowTask,
    state: TaskRunState,
    liveTask: LiveTask | undefined,
    removed: string[],
    failed: string[],
  ): Promise<void> {
    const pseudoWorktreeDeps = this.deps.pseudoWorktree;
    if (live.pseudo === undefined || pseudoWorktreeDeps === undefined) {
      return;
    }
    if (state.state === 'blocked') {
      return;
    }
    const usedPseudoWorktree =
      liveTask?.usedPseudoWorktree ??
      (task.cwd === undefined &&
        (task.isolation === 'worktree' || task.isolation === 'worktree-strict'));
    if (!usedPseudoWorktree) {
      return;
    }
    const result = await removePseudoWorktree(live.repoRoot, runId, task.id, pseudoWorktreeDeps.fs);
    if (result.ok) {
      removed.push(task.id);
    } else {
      failed.push(task.id);
      this.deps.log.warn(
        `[workflow ${runId}/${task.id}] 疑似worktreeの撤去に失敗しました: ${result.message}`,
      );
    }
  }

  /**
   * 統合worktree（gitの`_integration`worktree、または疑似worktreeの統合先）と、
   * 終わったタスクの残りworktreeをまとめて撤去する
   * （design.md §16.8「そのほか」の操作・§16.17「worktreeの片付け」・§16.20、
   * Issue #118・Issue #298）。
   *
   * **統合worktreeの撤去は、この操作からの明示的な呼び出しでしか行わない。** `blocked`
   * タスクの再マージ（`retryMerge`）は統合worktreeを使い続けるため、runの終了時に
   * 無条件で撤去してはいけない（Issue #118のコメント「統合worktreeの撤去タイミングは
   * 未解決の論点」への回答）。runがまだ`running`の間は、後続タスクが統合worktreeを
   * 必要としうるため撤去せず失敗として返す（安全側。人が明示的に押した操作であっても
   * 走っているタスクの前提を壊してはいけない）。この判定はgit・疑似worktreeのどちらの
   * 統合先にも同じく適用する。
   *
   * gitの統合worktreeの実体は `worktreePath(repoRoot, runId, '_integration')` が指す
   * 場所で、`integrationWorktreePath` と同じディレクトリを指す（design.md §16.17
   * 「`_integration`はタスクidとして予約する」）。そのため `deps.worktreeQueue.remove` を
   * タスクのworktree撤去と同じ入口から呼べる。未コミットの変更が残っていれば
   * （`removeWorktree`自身の`uncommittedChanges`判定）撤去せず警告する（既存の方針を
   * 踏襲。設計上、統合worktreeで衝突が未解決のまま残っている場合もここで弾かれる）。
   * ブランチ自体は消さない（`git worktree remove`はworktreeの参照を外すだけ。
   * design.md §16.17「ブランチは消さない。PR/MRから辿れる必要がある」）。
   *
   * 疑似worktree（gitリポジトリでないワークスペース、design.md §16.20）では
   * `live.pseudo`の統合先（`_integration`、`integrationPath`と同じ場所）を
   * `removePseudoWorktree`で撤去する。gitと違い履歴が無いため「ブランチを残す」概念は
   * 無いが、実体をまとめて消すという意味では同じ操作になる。
   *
   * `onProgress`はタスク1件・統合先1件（対象がある場合）を処理するたびに呼ぶ
   * （Viewの`vscode.window.withProgress`から使う想定。Issue #298「進捗が分からない」。
   * 省略可能で、省略時は従来どおり進捗を報告しない）。
   */
  async cleanupIntegration(
    runId: string,
    onProgress?: (progress: { done: number; total: number; label: string }) => void,
  ): Promise<{
    tasksRemoved: string[];
    tasksFailed: string[];
    integrationRemoved: boolean;
    /** 統合worktree（gitまたは疑似worktree）がこのrunの対象として存在したか。 */
    integrationApplicable: boolean;
    integrationFailedMessage: string | undefined;
  }> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return {
        tasksRemoved: [],
        tasksFailed: [],
        integrationRemoved: false,
        integrationApplicable: false,
        integrationFailedMessage: undefined,
      };
    }

    const integrationTarget = this.resolveIntegrationTarget(live);
    const integrationApplicable = integrationTarget.kind !== 'none';

    // 進捗の合計件数はタスク分＋統合先1件（対象がある場合）
    const targetTaskCount = live.def.tasks.filter((task) => {
      const state = live.runState.tasks.get(task.id);
      return (
        state !== undefined &&
        (state.state === 'done' ||
          state.state === 'failed' ||
          state.state === 'blocked' ||
          state.state === 'skipped')
      );
    }).length;
    const total = targetTaskCount + (integrationApplicable ? 1 : 0);
    let progressDone = 0;
    const reportProgress = (label: string): void => {
      progressDone += 1;
      onProgress?.({ done: progressDone, total, label });
    };

    const taskResult = await this.removeWorktrees(runId, () => reportProgress('タスクのworktree'));

    if (integrationTarget.kind === 'none') {
      return {
        tasksRemoved: taskResult.removed,
        tasksFailed: taskResult.failed,
        integrationRemoved: false,
        integrationApplicable: false,
        integrationFailedMessage: undefined,
      };
    }
    if (getRunOutcome(live.runState) === 'running') {
      const message = 'runが実行中のため統合worktreeは撤去しませんでした';
      this.deps.log.warn(`[workflow ${runId}] ${message}`);
      return {
        tasksRemoved: taskResult.removed,
        tasksFailed: taskResult.failed,
        integrationRemoved: false,
        integrationApplicable: true,
        integrationFailedMessage: message,
      };
    }

    const result =
      integrationTarget.kind === 'git'
        ? await this.deps.worktreeQueue.remove(
            live.repoRoot,
            runId,
            INTEGRATION_DIR_NAME,
            undefined,
            this.deps.git,
            this.deps.fs,
          )
        : await removePseudoWorktree(
            live.repoRoot,
            runId,
            INTEGRATION_DIR_NAME,
            integrationTarget.fs,
          );
    reportProgress('統合worktree');
    this.notify(runId);
    if (result.ok) {
      return {
        tasksRemoved: taskResult.removed,
        tasksFailed: taskResult.failed,
        integrationRemoved: true,
        integrationApplicable: true,
        integrationFailedMessage: undefined,
      };
    }
    this.deps.log.warn(`[workflow ${runId}] 統合worktreeの撤去に失敗しました: ${result.message}`);
    return {
      tasksRemoved: taskResult.removed,
      tasksFailed: taskResult.failed,
      integrationRemoved: false,
      integrationApplicable: true,
      integrationFailedMessage: result.message,
    };
  }

  /**
   * このrunの統合worktreeがgit・疑似worktreeのどちらの形か（あるいは対象が無いか）を
   * 判定する（`cleanupIntegration`専用のヘルパー。Issue #298）。疑似worktreeの
   * `deps.pseudoWorktree`が省略されている場合は、`live.pseudo`があっても対象にしない
   * （`removeWorktrees`の`removePseudoTaskWorktree`と同じ判断）。
   */
  private resolveIntegrationTarget(
    live: LiveRun,
  ): { kind: 'none' } | { kind: 'git' } | { kind: 'pseudo'; fs: PseudoWorktreeFileSystemPort } {
    if (live.integration !== undefined) {
      return { kind: 'git' };
    }
    const pseudoWorktreeDeps = this.deps.pseudoWorktree;
    if (!live.gitRepo && live.pseudo !== undefined && pseudoWorktreeDeps !== undefined) {
      return { kind: 'pseudo', fs: pseudoWorktreeDeps.fs };
    }
    return { kind: 'none' };
  }

  // ---- スケジューリング ----

  /**
   * 状態が変わるたびに呼ぶ（design.md §16.3）。次に開始できるタスクを開始し、終了を判定する。
   * 分割後のファイル（Issue #147）から`self.pump(...)`として呼ぶ（公開範囲は
   * `WorkflowRunnerInternals`に閉じる）。
   */
  private pump(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.finished) {
      return;
    }
    const toStart = nextTasksToStart(live.def, live.runState);
    for (const taskId of toStart) {
      // 開始の意思決定と同時にrunningへ倒す。非同期のstartTaskが終わるまで待つと、
      // 同じタスクが次のpump呼び出しで二重にnextTasksToStartへ拾われてしまう
      live.runState = markRunning(live.runState, taskId);
      void this.startTask(runId, taskId);
    }
    void this.persist(runId);
    this.notify(runId);

    const outcome = getRunOutcome(live.runState);
    if (outcome !== 'running' && !live.finished) {
      live.finished = true;
      this.deps.log.info(`[workflow ${runId}] 実行が終了しました: ${outcome}`);
      // 全タスクがdoneになったときだけ統合→mainのPR/MRを作る（design.md §16.18）
      if (outcome === 'succeeded') {
        void this.finalizeForge(runId);
      }
      // ロードマップの更新（design.md §16.19）もrunの結果を問わず行う。`done`になった
      // タスクの分だけチェックを入れる処理なので、runが途中で失敗していても、終わった分は
      // ロードマップへ反映されているのが人の期待に近い
      if (live.def.roadmap !== undefined) {
        void this.applyRoadmapCompletion(runId);
      }
      // 疑似worktree（design.md §16.20）はrunの結果を問わず反映する（forgeとは異なり
      // `succeeded`限定にしない。`reflectPseudoWorktree`自身のJSDoc参照）
      if (live.pseudo !== undefined) {
        void reflectPseudoWorktree(this.internals, runId);
      }
      // タスク間メッセージング（design.md §16.21）のMCPサーバはrunの結果を問わず閉じる。
      // 以降新しいタスクは開始されない（`live.finished`）ため、これ以上の接続は要らない
      // オーケストレーターへの最後の通知は、MCPサーバを閉じる前に積む（送信そのものは
      // CLIへの本文送信なので順序に依存しないが、「以降ツールは使えない」を伝える文面と
      // 実際の閉鎖の順序を合わせておく）
      notifyOrchestratorRunFinished(this.internals, runId, outcome);
      if (live.messaging !== undefined) {
        void live.messaging.transport.close();
        clearInterval(live.messaging.waitingReplyPollTimer);
      }
    }
  }

  /**
   * `startTask()`の前半。作業ディレクトリの解決・実効設定のクランプ・権限越境チェック・
   * bypassPermissionsの最終防御・`TaskSessionInput`の組み立てとタスク境界の解決までを担う。
   */
  private async prepareTaskLaunch(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    runId: string,
  ): Promise<TaskLaunchPreparation> {
    const taskRunState = live.runState.tasks.get(taskId);
    const retry = retrySuffixOf(taskRunState?.retryCount, taskRunState?.manualRetryCount);
    const { cwd, branch, usedWorktree, usedPseudoWorktree, pseudoSnapshot, originCommit } =
      await resolveWorkingDirectory(this.internals, live, task, retry);

    const baseline = this.deps.readBaseline();
    // クランプはこの1関数だけを通す（design.md §16.16。#52セキュリティ監査指摘）
    const effective = buildEffectiveTaskConfig(task, baseline);
    for (const w of effective.warnings) {
      this.deps.log.warn(`[workflow ${runId}/${taskId}] ${w}`);
      live.warnings.push({ kind: 'clamp', taskId, message: w });
    }

    // 実効値（クランプ後の値）に基づく第二段の権限越境チェック（セキュリティ監査指摘#2）。
    // 読み込み時のチェック（`findPermissionEscalationWarnings`）はYAMLが`sandbox`等を
    // 明示しないと判定できないが、ここでは実際にクランプされた値が分かっているため、
    // 未指定でも判定できる。上流タスクの実効値は`live.tasks`に既に保存されている
    // （依存が満たされて開始した以上、上流タスクは必ず先に完了しliveTaskが残っている）
    checkEffectivePermissionEscalation(this.internals, live, task, taskId, effective);

    // 最終防御（レビュー指摘: critical 3）。bypassPermissionsでは`can_use_tool`が
    // 発行されず、classifyApprovalRequest / autoApprove / escalate / allow が
    // 一度も呼ばれない。workflow.tsのvalidateWorkflowはYAMLリテラルの
    // `approvalMode: bypassPermissions`一致だけを見るため、YAML側が何も指定せず
    // 拡張機能側の設定が既にbypassPermissionsの場合は素通りしてしまう（実測で確認済み）。
    // ここは実効値（クランプ後の値）に対する検査であり、YAMLの記述に関わらず効く。
    //
    // 現在は`buildEffectiveTaskConfig`が実効値をacceptEditsへ読み替えるため（issue #271）
    // 通常この分岐へは入らない。実効値を組み立てる経路がそこ1本であることに依存した
    // 「入らないはず」なので、経路が増えたときのために多層防御として残す
    //
    // `agent.workflows.allowClaudeBypassPermissions`（machineスコープ、既定false）を
    // 有効にした場合だけ、利用者が危険判定を捨てると明示したものとして通す（issue #278）
    if (
      task.provider === 'claude' &&
      effective.config.approvalMode === 'bypassPermissions' &&
      !baseline.allowClaudeBypassPermissions
    ) {
      throw new Error(
        '実効approvalModeがbypassPermissionsのため、このタスクは開始できません' +
          '（危険判定が働かない設定での無人実行はできません）',
      );
    }

    // タスク間メッセージング（design.md §16.21）。runにMCPサーバが立っていれば、
    // このタスク専用の接続用URLを1つ発行する。実際にCLIの起動へ渡す配線
    // （`TaskSessionInput.mcp`を読む側）はsrc/view/の変更が要るため、このIssueの範囲外
    // （`WorkflowRunnerMessagingDeps`のJSDoc参照）。ここでは値を渡すところまで
    const messagingUrl = live.messaging?.transport.registerTask(taskId);
    const input: TaskSessionInput = {
      cwd,
      config: effective.config,
      sandbox: effective.sandbox,
      ...(messagingUrl !== undefined ? { mcp: { url: messagingUrl } } : {}),
    };

    const boundaryResult = await buildBoundary(this.internals, live, cwd);
    if (boundaryResult.warning !== undefined) {
      this.deps.log.warn(`[workflow ${runId}/${taskId}] ${boundaryResult.warning}`);
      live.warnings.push({ kind: 'gitCommonDir', taskId, message: boundaryResult.warning });
    }

    return {
      cwd,
      branch,
      usedWorktree,
      usedPseudoWorktree,
      pseudoSnapshot,
      originCommit,
      effective,
      input,
      boundaryResult,
    };
  }

  private buildLiveTask(session: TaskSession, prepared: TaskLaunchPreparation): LiveTask {
    return {
      session,
      cwd: prepared.cwd,
      branch: prepared.branch,
      autoApprove: prepared.effective.autoApprove,
      effectiveSandbox: prepared.effective.sandbox,
      effectiveApprovalMode: prepared.effective.config.approvalMode,
      boundary: prepared.boundaryResult.boundary,
      usedWorktree: prepared.usedWorktree,
      usedPseudoWorktree: prepared.usedPseudoWorktree,
      pseudoSnapshot: prepared.pseudoSnapshot,
      originCommit: prepared.originCommit,
      lastState: undefined,
      result: undefined,
      wasBusy: false,
      submissionCount: 0,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      lastResponseSummary: '',
      pendingApproval: undefined,
      expandedPrompt: undefined,
      expandedContinuePrompt: undefined,
      lastSentPrompt: undefined,
      continuePromptOverride: undefined,
      waitingReplySinceMs: undefined,
      pullRequest: undefined,
    };
  }

  /**
   * テンプレート展開はタスク開始直前に行う（design.md §16.4）。`runLoop` へ渡す本文は
   * 展開前のまま（作業記録に残すため。§16.12）で、実際の送信直前にpromptTransformで展開する。
   *
   * 区切り用の乱数（`nonce`。セキュリティ監査指摘#3）はタスク開始時に1回だけ生成し、
   * 以後の全ターン（`prompt` / `continuePrompt`）とView表示用の値（`expandedPrompt` /
   * `expandedContinuePrompt`）とで使い回す。依存タスクの結果（`resultsMap`）は
   * タスク開始時点で確定済み（依存は完了済みタスクに限る）で以後変わらないため、
   * `continuePrompt`の展開結果もこの時点で一度計算すれば以後のどのターンにも一致する
   */
  private setupTaskPrompting(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    liveTask: LiveTask,
    effective: EffectiveTaskConfig,
    session: TaskSession,
  ): void {
    const resultsMap = this.buildResultsMap(live, task);
    const templateNonce = this.deps.randomId?.() ?? randomUUID();
    session.setPromptTransform((text) => {
      // 差し替えられた継続指示があればそちらを基準の本文にする（design.md §16.23
      // `update_task_prompt`）。**テンプレート変数は展開しない**（リテラルとして送る）。
      // 差し替えられるのは走行中＝最初の指示を送ったあとなので、ここで区別せず
      // 以降のすべての送信に適用してよい
      const override = liveTask.continuePromptOverride;
      const expanded =
        override === undefined ? expandTemplate(text, resultsMap, templateNonce) : override;
      // 受け取ったメッセージは、次の指示の先頭へ添える（design.md §16.21「配送」）。
      // `takeDeliverableMessages`は呼ぶたびに未配送分を取り出す（配送済みとして消費する）
      // ため、送信のたびにここで取りに行く必要がある
      const hub = live.messaging?.hub;
      const delivered = hub?.takeDeliverableMessages(taskId) ?? [];
      // 配送される時点で、送信元より緩い実効権限へメッセージが届いていないかを確認する
      // （design.md §16.21、Issue #132「1. 権限差の警告」）。静的には検査できない
      // （送信はモデルの判断で実行時に起きる）ため、実際に配送するこの時点でのみ判定できる
      if (delivered.length > 0) {
        checkMessagingPermissionEscalation(
          this.internals,
          live,
          task,
          taskId,
          effective,
          delivered,
        );
      }
      const composed = composeNextPrompt(expanded, delivered);
      // Viewで実際に送った文面を確認できるようにする（design.md §16.21、Issue #132
      // 「4. 人が目視確認できるようにする」）。`expandedPrompt`はcomposeNextPromptを
      // 経由しないため、メッセージ経由で注入された内容を映せなかった。ここは
      // `setPromptTransform`が実際に返す値（CLIへ送る本文そのもの）を表示用に保持する
      // 経路なので、常に実際の送信内容と一致する。永続化はしない（design.md §16.11・
      // §16.21）表示専用の値のため、Trojan Source対策として`stripControlCharsPreservingNewlines`
      // を通す（改行はプロンプトの整形を保つため残す。CLIへ送る`composed`自体は変更しない）
      liveTask.lastSentPrompt = stripControlCharsPreservingNewlines(composed);
      return composed;
    });
    // Viewで「展開後のプロンプトを実際の文面として確認できる」ようにするための表示専用の値
    // （design.md §16.4 案1「見せる」、Issue #67）。実際に送る本文とは別経路で保持する。
    // 双方向制御文字等（Trojan Source）を仕込まれると、人がここを目視で確認するという
    // 対策そのものを欺けるため、承認カードの表示・応答要約と同じ発想で無害化する
    // （セキュリティ監査指摘#5）。ただしここは複数行のプロンプトをそのまま見せる用途なので、
    // 改行まで空白に潰す`stripControlChars`ではなく、改行を残す
    // `stripControlCharsPreservingNewlines`を使う。CLIへ実際に送る本文
    // （`promptTransform`側）は意味を変えたくないため、表示専用のこちらだけに適用する
    liveTask.expandedPrompt = stripControlCharsPreservingNewlines(
      expandTemplate(task.prompt, resultsMap, templateNonce),
    );
    // 継続プロンプト（2回目以降に送る指示）の展開結果もViewで確認できるようにする
    // （design.md §16.4、セキュリティ監査指摘#6）。上記のとおりresultsMapは以後の
    // ターンでも変わらないため、ここで一度計算した値が実際に送られる値と一致し続ける
    liveTask.expandedContinuePrompt = stripControlCharsPreservingNewlines(
      expandTemplate(task.continuePrompt, resultsMap, templateNonce),
    );
  }

  private finishTaskLaunch(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    session: TaskSession,
    usedWorktree: boolean,
    input: TaskSessionInput,
  ): void {
    // `usedWorktree`（タスク専用ブランチを使う）のときだけ「コミットしてあること」を
    // 終了条件へ自動で足す（design.md §16.17「タスク完了時のコミット」1.）。`shared` /
    // 明示`cwd`のタスクは統合ブランチへマージする対象を持たないため足さない
    const condition = usedWorktree ? withCommitRequirement(task.done) : task.done;
    session.runLoop({
      initialPrompt: task.prompt,
      continuePrompt: task.continuePrompt,
      maxIterations: task.maxIterations,
      condition,
    });

    // ツールの可視性の確認（design.md §16.21「タスクの開始時にツールが見えているか
    // 確かめる」）。見えなくても警告のうえ通信なしで走らせる（runは止めない）ため、
    // ここでは`await`せず投げっぱなしにする（`session.open`/`runLoop`をこの確認の
    // 分だけ遅らせない）
    if (input.mcp !== undefined) {
      void checkMessagingVisibility(this.internals, runId, taskId, session);
    }

    this.notify(runId);
  }

  private async startTask(runId: string, taskId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      return;
    }

    try {
      const prepared = await this.prepareTaskLaunch(live, task, taskId, runId);

      const host = this.deps.hosts[task.provider];
      const session = await host.openTaskSession(prepared.input);
      session.open({ preserveFocus: true });

      const liveTask = this.buildLiveTask(session, prepared);
      // 回数切れ（`maxReached`）で残したセッション（issue #284）が同じタスクに残っている
      // ことがある。「続ける」ではなく「再実行」を選んだ場合で、差し替える前に解放しないと
      // CLIのプロセスが宙に浮く
      live.tasks.get(taskId)?.session.dispose();
      live.tasks.set(taskId, liveTask);
      live.runState = recordSessionInfo(live.runState, taskId, session.sessionId, prepared.cwd);

      session.setApprovalHandler((approval, rawParams) =>
        this.handleApproval(runId, taskId, task, approval, rawParams),
      );
      session.onApprovalResolved((outcome) =>
        this.onApprovalResolved(runId, taskId, outcome.decision),
      );
      session.onStateChanged((state) => this.onTaskStateChanged(runId, taskId, state));
      session.onFinished((reason, state) =>
        this.onTaskFinished(runId, taskId, task, reason, state),
      );

      this.setupTaskPrompting(live, task, taskId, liveTask, prepared.effective, session);
      this.finishTaskLaunch(runId, taskId, task, session, prepared.usedWorktree, prepared.input);
    } catch (e) {
      // openTaskSessionの失敗はCLIプロセス起動時のエラーをそのまま含みうる。
      // worktree.ts側のgitエラーは既に無害化済みだが、ここでも共通ヘルパーを通しておく
      // （レビュー指摘: warning。sanitizeForLogは冪等に近く、二重に通しても実害は無い）
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.error(`[workflow ${runId}/${taskId}] タスクを開始できませんでした: ${message}`);
      live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, 'failed');
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
    }
  }

  private buildResultsMap(live: LiveRun, task: WorkflowTask): Map<string, TaskResult> {
    const map = new Map<string, TaskResult>();
    for (const depId of task.dependsOn) {
      const result = live.tasks.get(depId)?.result;
      if (result !== undefined) {
        map.set(depId, result);
      }
    }
    return map;
  }

  // ---- PR/MR作成（design.md §16.18） ----

  /**
   * runごとに一度だけPR/MR作成の可否を決める（design.md §16.18「実行開始前に次を確かめる」）。
   * `WorkflowRunnerDeps.forge` が渡されていない、または `agent.workflows.forge` が
   * `none` なら `disabled`。ホストを判定できない、または前提（`origin` remote・`gh`/`glab`の
   * PATH・認証）が欠けていれば `skipped`（呼び出し側が警告を出し、ローカルのマージだけ
   * 進める。design.md「前提が欠けている場合...ワークフロー自体は止めない」）。
   */
  /** `rebuildLiveRun`（`runnerRestore.ts`、Issue #147）から`self.resolveForgeState(...)`として呼ぶ（公開範囲は`WorkflowRunnerInternals`に閉じる）。 */
  private async resolveForgeState(repoRoot: string): Promise<LiveRunForgeState> {
    const forgeDeps = this.deps.forge;
    if (forgeDeps === undefined) {
      return { kind: 'disabled' };
    }
    const config = forgeDeps.readConfig();
    if (config.host === 'none') {
      return { kind: 'disabled' };
    }

    const remote = await this.deps.git.run(['remote', 'get-url', 'origin'], repoRoot);
    const remoteUrl = remote.code === 0 ? remote.stdout.trim() : undefined;
    const resolved = resolveForgeHost(remoteUrl, config.host);
    if (resolved.kind === 'none') {
      return { kind: 'disabled' };
    }
    if (resolved.kind === 'undetermined') {
      return { kind: 'skipped', message: resolved.message };
    }

    const prereq = await checkForgePrerequisites(
      { cli: forgeDeps.cli, cliAvailability: forgeDeps.cliAvailability, git: this.deps.git },
      repoRoot,
      resolved.host,
    );
    if (!prereq.ready) {
      return { kind: 'skipped', message: prereq.warnings.join(' / ') };
    }

    // 統合PR/MRのbase（design.md §16.18「統合...base: 実行開始時のHEADブランチ」）。
    // detached HEADでは `--abbrev-ref HEAD` が文字列 `HEAD` を返す（実際のブランチ名ではない）
    // ため、その場合は解決できなかったものとして扱う（統合PR/MRの作成だけを飛ばす）
    const branch = await this.deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const branchName = branch.code === 0 ? branch.stdout.trim() : '';
    const baseBranch = branchName !== '' && branchName !== 'HEAD' ? branchName : undefined;

    return {
      kind: 'active',
      host: resolved.host,
      pullRequest: config.pullRequest,
      finalMerge: config.finalMerge,
      baseBranch,
    };
  }

  /**
   * 全タスクが`done`になった直後（design.md §16.18「全体の終了とmainへの反映」）に、
   * 統合ブランチからmainへのPR/MRを作る。`pump()`から`getRunOutcome`が`succeeded`を
   * 返した回だけ呼ばれる。
   */
  /**
   * runが終わったとき、`done`になったタスクに対応するロードマップの項目のチェックを
   * 書き戻す（design.md §16.19「ロードマップの更新」、Issue #173）。
   *
   * 書き換えるのはチェックボックスの記号だけで、人が書いた文には触れない
   * （`applyRunCompletion`が保証する）。対応が取れないタスクidは何もせずログに残す。
   *
   * 書き戻し先は`live.def.roadmap`（ワークスペース相対）。`validateWorkflow`が
   * ワークスペース内の`.md`に限っているが、実行時にも`repoRoot`の外へ出ていないことを
   * 確かめる（検証を通らずに組み立てた定義が渡る経路を残さないための二重防御。
   * `worktree.ts`のブランチ名検証と同じ流儀）。
   */
  private async applyRoadmapCompletion(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    const roadmap = live?.def.roadmap;
    const deps = this.deps.roadmap;
    if (live === undefined || roadmap === undefined || deps === undefined) {
      return;
    }
    const target = path.resolve(live.repoRoot, roadmap);
    const relative = path.relative(live.repoRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      this.deps.log.warn(
        `[workflow ${runId}] ロードマップの書き戻し先がワークスペースの外を指しています: ${roadmap}`,
      );
      return;
    }

    const taskStates = new Map([...live.runState.tasks].map(([id, s]) => [id, s.state] as const));
    const result = await applyRunCompletionToFile({ fs: deps.fs }, target, taskStates);
    if (!result.ok) {
      this.deps.log.warn(`[workflow ${runId}] ${result.message}`);
      return;
    }
    if (result.updatedItemIds.length > 0) {
      this.deps.log.info(
        `[workflow ${runId}] ロードマップのチェックを更新しました: ${result.updatedItemIds.join(', ')}`,
      );
    }
    if (result.unmatchedTaskIds.length > 0) {
      this.deps.log.info(
        `[workflow ${runId}] ロードマップに対応する項目が無いタスク: ${result.unmatchedTaskIds.join(', ')}`,
      );
    }
    // ロードマップのパース・書き戻しで見つかった警告（読み飛ばした行・パース不能な
    // Issue行・重複idによる書き戻し中止等）を人へ届ける（Issue #408。`extension.ts` /
    // `messaging.ts` は変更できないため、既存のログ経路（Output panelへ出る`Logger`）に乗せる）
    for (const warning of result.warnings) {
      this.deps.log.warn(`[workflow ${runId}] ロードマップの警告: ${warning.message}`);
    }
  }

  private async finalizeForge(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined || live.integration === undefined) {
      return;
    }
    const forge = live.forge;
    if (forge.kind !== 'active' || !shouldCreateIntegrationPullRequest(forge.pullRequest)) {
      return;
    }
    const forgeDeps = this.deps.forge;
    if (forgeDeps === undefined) {
      // 型上`forge.kind === 'active'`は`forgeDeps`が存在するときにしか作られない
      // （`resolveForgeState`参照）ため到達しない想定だが、安全側でここでも確認する
      return;
    }
    if (forge.baseBranch === undefined) {
      this.deps.log.warn(
        `[workflow ${runId}] 実行開始時のブランチを特定できないため、統合PR/MRの作成を飛ばします`,
      );
      live.warnings.push({
        kind: 'forgeFailed',
        taskId: undefined,
        message: '実行開始時のブランチを特定できないため、統合PR/MRの作成を飛ばしました',
      });
      this.notify(runId);
      return;
    }

    const doneTaskIds = [...live.runState.tasks.entries()]
      .filter(([, s]) => s.state === 'done')
      .map(([id]) => id);
    const title = buildIntegrationPullRequestTitle({ runId, taskIds: doneTaskIds });
    const body = buildIntegrationPullRequestBody({ runId, taskIds: doneTaskIds });

    const result = await createIntegrationPullRequest(
      { cli: forgeDeps.cli, fs: forgeDeps.fs, git: this.deps.git },
      {
        host: forge.host,
        cwd: live.integration.cwd,
        baseBranch: forge.baseBranch,
        integrationBranch: live.integration.branch,
        title,
        body,
        draft: live.draftPullRequest,
      },
    );

    const created = result.pullRequest.ok;
    if (!created) {
      this.deps.log.warn(
        `[workflow ${runId}] 統合PR/MRの作成に失敗しました: ${result.pullRequest.message}`,
      );
      live.warnings.push({
        kind: 'forgeFailed',
        taskId: undefined,
        message: `統合PR/MRの作成に失敗しました: ${result.pullRequest.message}`,
      });
    } else if (result.pullRequest.url !== undefined) {
      this.deps.log.info(`[workflow ${runId}] 統合PR/MRを作成しました: ${result.pullRequest.url}`);
      // design.md §16.11「統合PR/MRの番号」・Issue #118。番号とURLだけを持ち帰る
      live.integrationPullRequest = {
        number: parsePullRequestNumberFromUrl(result.pullRequest.url),
        url: result.pullRequest.url,
      };
    }

    // design.md §16.18「この場合、finalMerge: autoであってもmainへのマージは行わない」。
    // `shouldRunFinalMerge`が`created`（PR/MRを作れたか）を見て判定するため、ここでは
    // ガードを重ねず素直に結果へ従う
    if (shouldRunFinalMerge(forge.finalMerge, created)) {
      // design.md §16.18「統合層のPR/MRもDraftで作る。ただしこちらは最終マージの直前に
      // readyへ切り替える。Draftのままではマージできないため、タスク層とは順序が違う」。
      // タスク層（`runTaskPullRequestFlow`）はマージ後にreadyへ切り替えるが、統合層は
      // 逆に「readyへ切り替えてからマージする」順序になる
      if (live.draftPullRequest && live.integrationPullRequest !== undefined) {
        const number = live.integrationPullRequest.number;
        if (number === undefined) {
          // design.md §16.18「URLから番号を取り出せなかった場合はready化を飛ばし、警告を
          // 残す。Draftのまま残るほうが、誤った番号のPR/MRをreadyにするより害が小さい」
          this.deps.log.warn(
            `[workflow ${runId}] 統合PR/MRの番号をURLから取り出せなかったため、ready化を飛ばします`,
          );
          live.warnings.push({
            kind: 'forgeFailed',
            taskId: undefined,
            message: '統合PR/MRの番号をURLから取り出せなかったため、ready化を飛ばしました',
          });
        } else {
          const ready = await markPullRequestReady(
            forgeDeps.cli,
            forge.host,
            live.integration.cwd,
            number,
          );
          if (!ready.ok) {
            // ready化の失敗はワークフローを止めない（design.md §16.18「5の失敗はワークフローを
            // 止めない」）。以降の最終マージはそのまま試みる
            this.deps.log.warn(`[workflow ${runId}] 統合PR/MRのready化に失敗しました: ${ready.message}`);
            live.warnings.push({
              kind: 'forgeFailed',
              taskId: undefined,
              message: `統合PR/MRのready化に失敗しました: ${ready.message}`,
            });
          }
        }
      }
      const merge = await runFinalMerge(forgeDeps.cli, forge.host, live.integration.cwd);
      if (!merge.ok) {
        this.deps.log.warn(`[workflow ${runId}] 最終マージに失敗しました: ${merge.message}`);
        live.warnings.push({
          kind: 'forgeFailed',
          taskId: undefined,
          message: `最終マージに失敗しました: ${merge.message}`,
        });
        live.finalMergeOutcome = 'failed';
      } else {
        this.deps.log.info(`[workflow ${runId}] mainへの最終マージが完了しました`);
        live.finalMergeOutcome = 'merged';
      }
    }
    void this.persist(runId);
    this.notify(runId);
  }

  // ---- 承認 ----

  private async handleApproval(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    approval: PendingApproval,
    rawParams: Record<string, unknown>,
  ): Promise<ApprovalHandlerResult> {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      // 不整合（起きない想定）。安全側でaskへ倒す
      return { kind: 'ask' };
    }

    const request = await buildEscalationRequest(
      task.provider,
      approval,
      rawParams,
      liveTask.cwd,
      liveTask.lastState?.items ?? [],
      this.deps.fs,
    );
    const policy: EscalationPolicy = {
      escalate: task.escalate,
      allow: task.allow,
      autoApprove: liveTask.autoApprove,
    };
    const result = classifyApprovalRequest(request, liveTask.boundary, policy);
    this.deps.log.info(
      `[workflow ${runId}/${taskId}] 承認判定(${approval.kind}): ${result.decision} - ${result.reasons.join(' / ')}`,
    );

    if (result.decision === 'auto') {
      return { kind: 'auto', decision: 'accept' };
    }

    // Viewの「承認」操作（`decideApproval`）がその場に要求内容を出すために持っておく
    // （design.md §16.8）。応答が決まったら`onApprovalResolved`側で消す。
    //
    // title/detail（コマンド文字列・cwd・reasonを含む）は`describeApproval`が組み立てた
    // ものでCLI・エージェント由来のため信用しない。`textContent`で挿入する限りXSSには
    // ならないが、双方向制御文字（RTL override等）は表示上の文字列を反転・偽装できる。
    // ワークフローViewの「承認」は会話タブを開かずその場で決める設計（design.md §16.8）で
    // 通常のチャット画面より文脈が少なく、見た目の偽装が誤判断に直結しやすいため
    // `stripControlChars`を通す（レビュー指摘: medium 3）。`detail`は切り詰めない
    // （危険な内容の一部が「…」に隠れて見えなくなるほうが、承認可否の判断としては危険）
    liveTask.pendingApproval = {
      requestId: approval.requestId,
      kind: approval.kind,
      title: sanitizeForLog(approval.title),
      detail: stripControlChars(approval.detail),
    };
    live.runState = markWaitingApproval(live.runState, taskId);
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
    return { kind: 'ask' };
  }

  private onApprovalResolved(runId: string, taskId: string, decision: ApprovalDecision): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const liveTask = live.tasks.get(taskId);
    if (liveTask !== undefined) {
      liveTask.pendingApproval = undefined;
    }
    if (decision === 'accept' || decision === 'acceptForSession') {
      live.runState = resumeFromApproval(live.runState, taskId);
    } else {
      // decline / cancel。危険操作を人が拒否した。`retries` の自動再試行の対象にしない
      // 専用の経路（design.md §16.5「承認拒否をfailedとして通知してはならない」）
      live.runState = markApprovalRejected(live.runState, live.def.tasks, taskId);
    }
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  // ---- 完了検知 ----

  private onTaskStateChanged(runId: string, taskId: string, state: ChatState): void {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      return;
    }
    liveTask.lastState = state;
    // 直近の応答の1行要約（design.md §16.8）。ストリーミング中も更新するため、
    // ターンの区切りを待たず毎回計算し直す（応答本文そのものは保持しない）
    liveTask.lastResponseSummary = buildResponseSummary(state);
    // 送信回数はLoopControllerが内部に持ち、TaskSessionからは見えないため、
    // ターン開始（busyの立ち上がり）の回数で近似する
    const startedTurn = !liveTask.wasBusy && state.busy;
    liveTask.wasBusy = state.busy;
    if (startedTurn) {
      liveTask.submissionCount += 1;
      live.runState = recordSubmissionCount(live.runState, taskId, liveTask.submissionCount);
      void this.persist(runId);
    }
    // 状態変化のたびにViewへ知らせる。永続化（persist）は送信回数の節目だけに絞ったままだが、
    // 表示専用の通知はストリーミング中の要約更新でも毎回出す
    this.notify(runId);
  }

  private onTaskFinished(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    reason: LoopStopReason,
    state: ChatState,
  ): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const liveTask = live.tasks.get(taskId);

    if (reason === 'done' && liveTask !== undefined) {
      liveTask.result = {
        result: state.turnResultText,
        cwd: liveTask.cwd,
        branch: liveTask.branch,
        files: [...state.turnEditedFiles],
        // {{T1.summary}}（design.md §16.4 案4「絞る」、Issue #67）。#57の1行要約をそのまま
        // 使う。応答全部ではなく要点だけを下流へ渡す選択肢を書き手に与えるためのもので、
        // buildResponseSummary自体が既に制御文字の除去と長さの上限（MAX_SUMMARY_LENGTH）を
        // 行っている
        summary: buildResponseSummary(state),
      };
    }

    live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, reason);

    if (reason !== 'manual' && reason !== 'interrupted') {
      // done / maxReached / failed。
      //
      // `maxReached`（回数切れ）だけはセッションを残す（issue #284）。「続ける」
      // （`continueTask`）が同じ会話・同じworktreeのまま送信回数の予算を足して再開する
      // ための唯一の足がかりで、ここで解放すると続きから走らせる手段が無くなる。
      // 残ったセッションは、`startTask`が同じタスクを開き直すとき（「再実行」）と
      // run全体の`dispose`で解放される。worktreeは元から`done`のときしか撤去しない
      // （`shouldRemoveWorktree`）ので、こちらは変更しなくてよい。
      //
      // それ以外（done / failed）は従来どおり解放する（design.md §16.10の4）。
      // 再試行はここで新しいセッション・worktreeを新規に作るため、古いものは残さない
      if (reason !== 'maxReached') {
        liveTask?.session.dispose();
      }

      if (reason === 'done' && liveTask !== undefined) {
        if (liveTask.usedWorktree) {
          // マージまでを拡張機能の責務にする（design.md §16.17）。ループが終わっただけでは
          // `applyLoopStopReason`が`merging`にしてあるだけなので、実際にマージを試みる
          void startMerge(
            this.internals,
            runId,
            taskId,
            task,
            liveTask.cwd,
            liveTask.branch,
            liveTask.originCommit,
          );
        } else if (liveTask.usedPseudoWorktree && live.pseudo !== undefined) {
          // 疑似worktree（design.md §16.20）。gitのマージに相当する統合を試みる
          void integratePseudoWorktree(this.internals, runId, taskId, live.pseudo, liveTask);
        } else {
          // `shared` / 明示`cwd`のタスクは統合ブランチへマージする対象となる専用ブランチを
          // 持たない。マージ済みの成果物が最初から無い（あるいは元々`repoRoot`を直接触って
          // いる）ため、`merging`を経ずそのまま`done`にする（design.md §16.17の対象外の
          // 判断。ambiguousな点は最終報告で明記する）
          live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
        }
      }
      this.cleanupWorktreeIfNeeded(live, task, taskId, liveTask);
    }

    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  // ---- マージ（design.md §16.17） ----

  /**
   * `blocked`のタスクを再マージする（design.md §16.17「Viewから人が解決したうえで
   * 『再マージ』を指示できる」）。Viewからの呼び出しの配線は別Issue（このIssueは
   * `src/view/`を対象外にしている）だが、runner.ts側の入口はここに用意しておく。
   *
   * 実体は`runnerMerge.ts`（マージと衝突解決、Issue #147）。
   */
  retryMerge(runId: string, taskId: string): boolean {
    return retryMerge(this.internals, runId, taskId);
  }

  /**
   * `onTaskFinished`からの呼び出しをメソッドの形で残してある（`runner.test.ts`が
   * `WorkflowRunner.prototype.cleanupWorktreeIfNeeded`をスパイして「interrupted/manualでは
   * 呼ばれないこと」を検証しているため。実体は`runnerMerge.ts`、Issue #147）。
   */
  private cleanupWorktreeIfNeeded(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    liveTask: LiveTask | undefined,
  ): void {
    cleanupWorktreeIfNeeded(this.internals, live, task, taskId, liveTask);
  }

  // ---- 永続化 ----

  /** 分割後のファイル（Issue #147）から`self.persist(...)`として呼ぶ（公開範囲は`WorkflowRunnerInternals`に閉じる）。 */
  private async persist(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const outcome = getRunOutcome(live.runState);
    await this.deps.store.update(runId, (current) => {
      const tasks: Record<string, PersistedTaskState> = {};
      for (const [id, s] of live.runState.tasks) {
        const liveTask = live.tasks.get(id);
        tasks[id] = {
          state: s.state,
          sessionId: s.sessionId,
          cwd: s.cwd,
          // liveTaskはこのウィンドウでまだセッションを開いていないタスク（リロード直後で
          // 復元しただけの実行に多い）では undefined になる。その場合は前回persistした値を
          // 引き継ぐ（`current`）。素通しで`undefined`を書くと、既にdone/failed/skipped
          // 確定済みのタスクのbranchがリロード後の初回persistで失われてしまう
          branch: liveTask?.branch ?? current?.tasks[id]?.branch,
          submissionCount: s.submissionCount,
          retryCount: s.retryCount,
          manualRetryCount: s.manualRetryCount,
          failure: s.failure,
          // design.md §16.11「タスクごとの...PR/MRの番号」・Issue #118。branchと同じ理由で
          // liveTaskが無ければ前回persistした値を引き継ぐ
          pullRequestNumber: liveTask?.pullRequest?.number ?? current?.tasks[id]?.pullRequestNumber,
          pullRequestUrl: liveTask?.pullRequest?.url ?? current?.tasks[id]?.pullRequestUrl,
        };
      }
      return {
        runId,
        defPath: live.defPath,
        workspaceRoot: live.repoRoot,
        startedAt: current?.startedAt ?? live.startedAt,
        finishedAt:
          outcome === 'running' ? undefined : (current?.finishedAt ?? new Date().toISOString()),
        tasks,
        haltedByUser: live.runState.haltedByUser,
        integrationBranch: live.integration?.branch ?? current?.integrationBranch ?? '',
        // design.md §16.11「統合PR/MRの番号」・Issue #118。同じく前回persistした値を引き継ぐ
        integrationPullRequestNumber:
          live.integrationPullRequest?.number ?? current?.integrationPullRequestNumber,
        integrationPullRequestUrl:
          live.integrationPullRequest?.url ?? current?.integrationPullRequestUrl,
        finalMergeOutcome: live.finalMergeOutcome ?? current?.finalMergeOutcome,
      };
    });
  }
}

/** `runnerWorkingDirectory.ts`（Issue #147）からも使うため`export`する。 */
export function issue(message: string, taskIds: string[] = []): WorkflowIssue {
  return { taskIds, message };
}

/**
 * PR/MRのURLから番号を取り出す（design.md §16.11「タスクごとの...PR/MRの番号」・
 * 「統合PR/MRの番号」、Issue #118）。実装は`forge.ts`へ一本化した（レビュー指摘: 以前は
 * ここに同じ実装がそのまま複製されており、本体コード（`runner.ts` / `runnerMerge.ts`）は
 * どちらも`./runner`からimportしていたため`forge.ts`側が実質デッドコードになっていた）。
 * `import { parsePullRequestNumberFromUrl } from './runner'` という既存の呼び出し方を
 * 壊さないよう、ここでは`forge.ts`の実装をそのまま再exportする。
 */
export { parsePullRequestNumberFromUrl };

/**
 * `TaskRunState` の試行回数から、`worktreePath` / `branchName` が受け取る `retry`
 * サフィックス番号（0開始）へ変換する。
 *
 * `retryCount`（自動再試行）と `manualRetryCount`（ワークフローViewからの手動の再実行）を
 * **合計する**。名前が表すのは「何回目の試行か」であって、どちらの経路でやり直したかでは
 * ないため。合計しないと、手動の再実行が前の試行と同じブランチ名を作ろうとして
 * `branchExists` で必ず失敗する（失敗した試行のworktreeとブランチは人が中身を見られる
 * ように残るため。issue #275で実測）。
 *
 * `retryCount` は `applyLoopStopReason` が**次の試行を始める前に**インクリメントする
 * （design.md §16.5の再試行判定）ため、1回目の失敗直後は `retryCount === 1` になる。
 * これは「1回retryを消費した」という意味であり、そのままworktreeのサフィックスに使うと
 * 1回目の再試行が `-retry1` になってしまう（`worktree.test.ts` が固定している規約は
 * 1回目の再試行が `-retry0`）。1つずらして渡す必要がある
 * （レビュー指摘: high。テスト追加で発覚したオフバイワン）。`manualRetryCount` も
 * `retryTask` が次の試行を始める前に増やすため、同じ数え方に乗る。
 */
export function retrySuffixOf(
  retryCount: number | undefined,
  manualRetryCount?: number | undefined,
): number | undefined {
  const total = (retryCount ?? 0) + (manualRetryCount ?? 0);
  return total > 0 ? total - 1 : undefined;
}
