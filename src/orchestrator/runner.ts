import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';

import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import type { LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import { buildEscalationRequest } from './approvalMapping';
import {
  classifyApprovalRequest,
  isPathWithinRoot,
  type EscalationPolicy,
  type TaskBoundary,
} from './escalation';
import {
  checkForgePrerequisites,
  createIntegrationPullRequest,
  createPullRequest,
  buildIntegrationPullRequestBody,
  buildIntegrationPullRequestTitle,
  buildTaskPullRequestBody,
  buildTaskPullRequestTitle,
  pushBranch,
  resolveForgeHost,
  runFinalMerge,
  runTaskPullRequestFlow,
  shouldCreateIntegrationPullRequest,
  shouldCreateTaskPullRequest,
  shouldRunFinalMerge,
  type CliAvailabilityPort,
  type CliCommandRunner,
  type FinalMergeConfig,
  type ForgeFileSystemPort,
  type ForgeHost,
  type ForgeHostConfig,
  type PullRequestLayerConfig,
} from './forge';
import {
  buildMergeResolutionPrompt,
  commitUncommittedChangesIfNeeded,
  findTaskIdsMergedSince,
  integrationBranchName,
  integrationWorktreePath,
  isMergeResolutionComplete,
  INTEGRATION_DIR_NAME,
  IntegrationMergeQueue,
  MERGE_RESOLUTION_CONDITION,
  MERGE_RESOLUTION_MAX_ITERATIONS,
  reconcileMergingTaskOnReload,
  resolveTaskBranchOrigin,
  type MergeResolutionTaskInfo,
  type MergeTaskResult,
} from './integration';
import {
  cloneWorkspace,
  diffSnapshots,
  ensureIntegrationDir,
  reflectIntegrationToWorkspace,
  takeSnapshot,
  IntegrationQueue as PseudoWorktreeIntegrationQueue,
  type PseudoWorktreeFileSystemPort,
  type Snapshot,
} from './pseudoWorktree';
import {
  buildStalledWaitingReplyWarning,
  composeNextPrompt,
  detectAllWaitingStalemate,
  detectTimedOutWaitingReplies,
  DEFAULT_REPLY_TIMEOUT_SEC,
  TaskMessagingHub,
  type HttpMcpTransportHandle,
  type RunTaskSnapshot,
  type StoredMessage,
} from './messaging';
import {
  applyLoopStopReason,
  createRunState,
  markApprovalRejected,
  markMergeBlocked,
  markMergeFailed,
  markMergeSucceeded,
  markRunning,
  markWaitingApproval,
  markWaitingReply,
  recordSessionInfo,
  recordSubmissionCount,
  resumeFromApproval,
  resumeFromWaitingReply,
  retryMergeState,
  retryTask as retryTaskState,
  type RunState,
  type TaskFailureReason,
  type TaskRunState,
  type TaskState,
} from './runState';
import { getRunOutcome, nextTasksToStart, type RunOutcome } from './scheduler';
import { WorkflowRunStore, type PersistedRun, type PersistedTaskState } from './runStore';
import { sanitizeForLog, stripControlChars } from './sanitize';
import { buildEffectiveTaskConfig, type ExtensionSafetyBaseline } from './taskConfig';
import { buildResponseSummary } from './taskSummary';
import type {
  ApprovalHandlerResult,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from './taskSession';
import {
  buildTaskBoundary,
  checkWorktreesGitignored,
  decideWorkingDirectory,
  isGitWorkingTree,
  resolveHeadCommit,
  shouldRemoveWorktree,
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from './worktree';
import {
  expandTemplate,
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
 * 巨大なYAMLで拡張機能ホスト（シングルスレッド）を固まらせないための上限。
 * `workflow.ts` の `MAX_PROMPT_LENGTH`（20000文字）× `MAX_TASK_COUNT`（50）を
 * 大きく超える値を目安にした余裕のある上限で、通常のワークフロー定義には十分すぎる。
 */
export const MAX_WORKFLOW_FILE_BYTES = 1 * 1024 * 1024;

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
   * 設定 `agent.workflows.forge` / `.pullRequest` / `.finalMerge`。実行開始時に一度だけ
   * 読み直す（`readBaseline` と同じく使い捨てのオブジェクトではなく関数で渡す）。
   */
  readConfig: () => {
    host: ForgeHostConfig;
    pullRequest: PullRequestLayerConfig;
    finalMerge: FinalMergeConfig;
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
    | 'messagingStalled';
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

/** タスク1件の実行時ブックキーピング。`RunState`（純粋）とは別に、セッション等の実体を持つ。 */
interface LiveTask {
  session: TaskSession;
  cwd: string;
  branch: string;
  /** クランプ済みの `autoApprove`。承認判定の入力に使う。 */
  autoApprove: boolean;
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

interface LiveRun {
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
   * 疑似worktree（design.md §16.20）。`!gitRepo` かつ
   * `WorkflowRunnerDeps.pseudoWorktree`が渡されているときだけ実行開始時に一度作る
   * （gitの`integration`と対称の役割）。
   */
  pseudo:
    | { integrationDir: string; queue: PseudoWorktreeIntegrationQueue; baseline: Snapshot; exclude: readonly string[] }
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
    | { hub: TaskMessagingHub; transport: HttpMcpTransportHandle; waitingReplyPollTimer: ReturnType<typeof setInterval> }
    | undefined;
  /**
   * 衝突解決セッション（design.md §16.17「コンフリクト」5.「解決用セッションは依存グラフの
   * ノードにはしない」）。`live.tasks`（グラフのノード＝通常のタスク）とは別に持つ。
   * taskIdをキーにする（1タスクにつき同時に1件のマージしか走らない）。
   */
  mergeResolutions: Map<string, TaskSession>;
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
  private readonly runs = new Map<string, LiveRun>();
  private readonly changeEmitter = new SimpleEmitter<string>();
  /**
   * `deps.worktreeQueue`から構築する。design.md §16.17「マージはworktreeの作成・撤去と
   * 同じ1本のキューに通して直列化する」ため、別インスタンスを持たせず必ず同じ
   * `WorktreeCreationQueue`をラップする（`integration.ts`の`IntegrationMergeQueue`の
   * 注意書き参照）。コンストラクタ内で組み立てることで、配線を誤って別のキューを
   * 渡す事故を型のうえで起こしえない状態にする。
   */
  private readonly integrationQueue: IntegrationMergeQueue;

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.integrationQueue = new IntegrationMergeQueue(deps.worktreeQueue);
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

  private notify(runId: string): void {
    this.changeEmitter.fire(runId);
  }

  /**
   * Viewが描画する現在の状態のスナップショット（design.md §16.8）。
   * 応答本文そのものではなく `LiveTask.lastResponseSummary`（1行要約）だけを渡す。
   */
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return undefined;
    }
    const tasks = live.def.tasks.map((task) => this.buildTaskSnapshot(live, task));
    // 統合PR/MRの結果・最終マージの成否は、このプロセスでまだ何も試みていない
    // （`live.integrationPullRequest`/`live.finalMergeOutcome`が`undefined`の）間、
    // 永続化された値（前のウィンドウで作られた等）へフォールバックする
    // （design.md §16.11「リロードしてもPR/MRへのリンクが残る」・Issue #118）
    const persisted = this.deps.store.find(runId);
    return {
      runId: live.runId,
      name: live.def.name,
      defPath: live.defPath,
      outcome: getRunOutcome(live.runState),
      startedAt: live.startedAt,
      tasks,
      warnings: [
        ...live.warnings,
        ...this.deriveMaxReachedWarnings(live),
        ...this.deriveAllowWarnings(live),
      ],
      haltedByUser: live.runState.haltedByUser,
      integrationBranch: live.integration?.branch,
      integrationPullRequestNumber:
        live.integrationPullRequest?.number ?? persisted?.integrationPullRequestNumber,
      integrationPullRequestUrl:
        live.integrationPullRequest?.url ?? persisted?.integrationPullRequestUrl,
      finalMergeOutcome: live.finalMergeOutcome ?? persisted?.finalMergeOutcome,
    };
  }

  private buildTaskSnapshot(live: LiveRun, task: WorkflowTask): TaskSnapshot {
    const state = live.runState.tasks.get(task.id);
    const liveTask = live.tasks.get(task.id);
    // PR/MRの結果も、branch同様このウィンドウでまだセッションを開いていない
    // （リロード復元直後の）タスクでは`liveTask`が無い。branchと違い、PR/MRのリンクは
    // リロード後も出す必要がある（design.md §16.11「リロードしてもPR/MRへのリンクが残る」・
    // Issue #118の受入基準）ため、永続化された値へフォールバックする
    const persistedTask = this.deps.store.find(live.runId)?.tasks[task.id];
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
      mergeResolutionActive: live.mergeResolutions.has(task.id),
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
  private deriveAllowWarnings(live: LiveRun): WorkflowWarning[] {
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

  /** 回数切れは状態としてすでに`failed`が持っているため、都度作らず表示のたびに導出する。 */
  private deriveMaxReachedWarnings(live: LiveRun): WorkflowWarning[] {
    const warnings: WorkflowWarning[] = [];
    for (const [taskId, state] of live.runState.tasks) {
      if (state.state === 'failed' && state.failure?.kind === 'maxReached') {
        warnings.push({
          kind: 'maxReached',
          taskId,
          message: `送信回数の上限に達しました（終了条件が満たされないまま停止）: ${taskId}`,
        });
      }
    }
    return warnings;
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
   *
   * `workspaceState` に残っているrun（`reconcileAfterReload` で走行中タスクを
   * 中断扱いへ倒し済み）をメモリ上へ復元し、ワークフローViewが表示・「再実行」
   * できるようにする。#56では中断扱いに倒すところまでしか実装していなかった。
   *
   * 定義ファイルが読めない・検証を通らないrunは復元をあきらめる（ログにだけ残す）。
   * そのrunはこのウィンドウのライブな状態には現れないが、`workspaceState`自体からは
   * 消さない（ファイルを直して次回リロードすれば復元できる余地を残す）。
   */
  async restoreRunsForView(): Promise<void> {
    const persisted = await this.deps.store.reconcileAfterReload();
    for (const p of persisted) {
      if (this.runs.has(p.runId)) {
        continue;
      }
      const rebuilt = await this.rebuildLiveRun(p);
      if (rebuilt === undefined) {
        continue;
      }
      this.runs.set(p.runId, rebuilt);
      // `rebuildLiveRun`が統合ブランチの実際の状態から判定し直してもなお`merging`のまま
      // 残ったタスクは、マージが実行途中で切れていたと分かっているもの。ライブなセッションは
      // 無い（リロードで失われた）ため、永続化された`branch`/`cwd`だけを頼りにマージを
      // やり直す（design.md §16.11「`merging`からやり直す」）
      for (const [taskId, s] of rebuilt.runState.tasks) {
        if (s.state === 'merging') {
          this.resumeMergeAfterReload(p.runId, taskId);
        }
      }
    }
  }

  /**
   * リロード直後、まだ`merging`のまま残ったタスクのマージをやり直す
   * （design.md §16.11。`restoreRunsForView`から呼ぶ）。ライブなセッション
   * （`LiveTask`）は無いため、永続化された`branch`/`cwd`を直接使う。どちらか欠けている
   * （古い永続化形式・作成前に中断した等）場合は再開できないため、安全側で`blocked`にする。
   */
  private resumeMergeAfterReload(runId: string, taskId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.integration === undefined) {
      return;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    const persistedTask = this.deps.store.find(runId)?.tasks[taskId];
    const branch = persistedTask?.branch;
    const cwd = persistedTask?.cwd;
    if (task === undefined || branch === undefined || branch === '' || cwd === undefined) {
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] マージを再開するための情報が不足しているため blocked にします`,
      );
      live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
      void this.persist(runId);
      this.notify(runId);
      return;
    }
    void this.startMerge(runId, taskId, task, cwd, branch, '');
  }

  private async rebuildLiveRun(p: PersistedRun): Promise<LiveRun | undefined> {
    // start()と同じ上限チェックをここでも通す（レビュー指摘: medium 2）。
    // `MAX_WORKFLOW_FILE_BYTES`のコメントどおり「巨大なYAMLで拡張機能ホスト
    // （シングルスレッド）を固まらせない」ための防御であり、復元経路だけ素通りさせない
    const size = await this.deps.filePort.fileSize(p.defPath);
    if (size === undefined || size > MAX_WORKFLOW_FILE_BYTES) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    const text = await this.deps.filePort.readTextFile(p.defPath);
    if (text === undefined) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(text);
    } catch {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルの解析に失敗したため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    if (validateWorkflow(def).errors.length > 0) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルが検証を通らないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }

    const gitRepo = await isGitWorkingTree(p.workspaceRoot, this.deps.git);
    // 元のHEADは永続化していない（design.md §16.11は応答本文以外も最小限しか保存しない
    // 方針）ため、復元した時点のHEADを分岐元にする。再実行は元々「新しいスレッド・
    // worktreeでやり直す」設計（design.md §16.5）なので、この差異は再実行の意味を壊さない
    const headCommit = gitRepo
      ? ((await resolveHeadCommit(p.workspaceRoot, this.deps.git)) ?? '')
      : '';

    // 統合ブランチ・統合worktree（design.md §16.17）。gitRepoでない実行には統合の概念が
    // 無い。永続化された`integrationBranch`（古い形式や空文字なら決定的に導ける値）を使う
    const integrationBranch =
      p.integrationBranch !== '' ? p.integrationBranch : integrationBranchName(p.runId);
    const integration = gitRepo
      ? { cwd: integrationWorktreePath(p.workspaceRoot, p.runId), branch: integrationBranch }
      : undefined;

    const tasks = new Map<string, TaskRunState>();
    for (const [id, t] of Object.entries(p.tasks)) {
      let state = t.state;
      let failure = t.failure;
      if (state === 'merging') {
        // design.md §16.11「`merging`だったタスクは、状態の記録ではなく統合ブランチの
        // 実際の状態から判定し直す」。gitRepoでない（統合worktreeが無い）実行で`merging`
        // が残っているのは想定外の状態のため、安全側で`blocked`にする
        if (integration === undefined) {
          state = 'blocked';
        } else {
          const outcome = await reconcileMergingTaskOnReload(
            integration.cwd,
            p.runId,
            id,
            this.deps.git,
          );
          if (outcome === 'done') {
            state = 'done';
          } else if (outcome === 'blocked') {
            state = 'blocked';
          } else if (t.cwd === undefined || t.branch === undefined || t.branch === '') {
            // マージをやり直すための情報（タスクのworktreeのcwd・ブランチ名）が無い。
            // `restoreRunsForView`側の再開処理も同じ条件で`blocked`に倒すため、ここで
            // 先に確定させて二重の判定を避ける
            state = 'blocked';
          }
          // それ以外（outcome === 'merging' かつ再開に必要な情報がある）は`merging`のまま
          // 残す。`restoreRunsForView`がこのあとマージをやり直す
        }
        if (state !== 'merging') {
          failure = undefined;
        }
      }
      tasks.set(id, {
        state,
        submissionCount: t.submissionCount,
        retryCount: t.retryCount,
        failure,
        sessionId: t.sessionId,
        cwd: t.cwd,
      });
    }
    const runState: RunState = { tasks, haltedByUser: p.haltedByUser };
    const forge: LiveRunForgeState = gitRepo
      ? await this.resolveForgeState(p.workspaceRoot)
      : { kind: 'disabled' };

    // 疑似worktree（design.md §16.20）。リロード後の再構築はベストエフォートにする
    // （`rebuildLiveRun`自体が「定義ファイルを読めない等は復元をあきらめる」以外は
    // 失敗時も可能な限り表示を続ける方針のため。統合先の再作成に失敗した場合は
    // `pseudo: undefined`のまま続け、ログにだけ残す）。
    // なお、疑似worktreeの`baseline`はrun開始時点ではなく**復元した時点**の
    // ワークスペースで取り直す（`headCommit`と同じ「復元時点を基準にする」簡略化。
    // 再実行は新しい複製でやり直す設計のため、この差異は再実行の意味を壊さない）
    let pseudo: LiveRun['pseudo'];
    if (!gitRepo) {
      const resolved = await this.resolvePseudoState(p.workspaceRoot, p.runId);
      if (resolved.ok) {
        pseudo = resolved.state;
      } else {
        this.deps.log.warn(
          `[workflow ${p.runId}] 疑似worktreeの統合先を復元できませんでした: ${resolved.message}`,
        );
      }
    }

    return {
      runId: p.runId,
      def,
      defPath: p.defPath,
      repoRoot: p.workspaceRoot,
      gitRepo,
      headCommit,
      startedAt: p.startedAt,
      runState,
      // このプロセスでまだセッションを開いていない。`hasLiveSession: false`として
      // Viewへ出る（design.md §16.11。再実行すればstartTask()が新しく作る）
      tasks: new Map(),
      finished: getRunOutcome(runState) !== 'running',
      warnings: [],
      integration,
      forge,
      pseudo,
      // タスク間メッセージング（design.md §16.21）はこのウィンドウで新たに始める実行にだけ
      // 立てる（リロード直後の復元では作らない。再実行すればstartTask()相当の経路で
      // 改めてタスクが動き出すが、メッセージングはrunそのものに紐づく短命なサーバのため、
      // 復元だけでは作り直さない。`WorkflowRunnerDeps.messaging`が省略可能なのと同じ
      // 「無くても実行は止めない」設計に揃える）
      messaging: undefined,
      mergeResolutions: new Map(),
      // 統合PR/MRの結果・最終マージの成否はこのプロセスでまだ何も試みていない
      // （design.md §16.11。Viewは`getSnapshot`が読む永続化された値へフォールバックする）
      integrationPullRequest: undefined,
      finalMergeOutcome: undefined,
    };
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

    const allowTaskIds = def.tasks.filter((t) => t.allow.length > 0).map((t) => t.id);
    if (allowTaskIds.length > 0 && options?.allowConfirmed !== true) {
      return { ok: false, needsAllowConfirmation: true, allowTaskIds };
    }

    const gitRepo = await isGitWorkingTree(repoRoot, this.deps.git);
    let headCommit = '';
    if (gitRepo) {
      const head = await resolveHeadCommit(repoRoot, this.deps.git);
      if (head === undefined) {
        return { ok: false, errors: [issue('HEADコミットを解決できませんでした')] };
      }
      headCommit = head;
    } else {
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
    }

    const cwdErrors = await this.validateExplicitCwds(def, repoRoot);
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

    // 統合ブランチ・統合worktree（design.md §16.17）。runごとに1本、実行開始時に一度だけ
    // 作る。`isolation: worktree`のタスクが1件も無い定義でも作る（design.md §16.17
    // 「統合ブランチ」がrun単位の概念として定めているため）
    let integration: { cwd: string; branch: string } | undefined;
    if (gitRepo) {
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
      integration = { cwd: created.cwd, branch: created.branch };
    }

    // PR/MR作成の前提チェック（design.md §16.18「実行開始前に次を確かめる」）。gitでない
    // 実行には統合ブランチ自体が無いため対象外
    const forge: LiveRunForgeState = gitRepo
      ? await this.resolveForgeState(repoRoot)
      : { kind: 'disabled' };
    if (forge.kind === 'skipped') {
      this.deps.log.warn(`[workflow ${runId}] ${forge.message}`);
      warnings.push({ kind: 'forgeSkipped', taskId: undefined, message: forge.message });
    }

    // 疑似worktree（design.md §16.20）。gitでない実行だけ、統合先を実行開始時に一度作る
    // （`isolation: worktree`のタスクが1件も無い定義でも作る。git版の統合worktreeと同じ
    // 「run単位の概念として定める」扱い）。作成に失敗したら実行を始めない
    // （git版の統合worktree作成失敗と同じ扱い。中途半端な状態で走らせない）
    let pseudo: LiveRun['pseudo'];
    if (!gitRepo) {
      const resolved = await this.resolvePseudoState(repoRoot, runId);
      if (!resolved.ok) {
        return {
          ok: false,
          errors: [issue(`疑似worktreeの統合先の作成に失敗しました: ${resolved.message}`)],
        };
      }
      pseudo = resolved.state;
    }

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
      pseudo,
      messaging: undefined,
      mergeResolutions: new Map(),
      integrationPullRequest: undefined,
      finalMergeOutcome: undefined,
    };
    this.runs.set(runId, live);

    // タスク間メッセージング（design.md §16.21）。省略可能（`WorkflowRunnerDeps.messaging`
    // のJSDoc参照）。MCPサーバの起動に失敗しても実行は止めない
    if (this.deps.messaging !== undefined) {
      const hub = new TaskMessagingHub({
        listRunTasks: () => this.buildRunTaskSnapshots(runId),
        onAccepted: (message) => this.onMessageAccepted(runId, message),
      });
      try {
        const transport = await this.deps.messaging.startTransport(hub);
        const waitingReplyPollTimer = setInterval(
          () => this.checkWaitingReplyStalls(runId),
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

    await this.persist(runId);
    this.notify(runId);
    this.pump(runId);
    return { ok: true, runId };
  }

  /** `TaskMessagingHub`の`list_tasks`が返す一覧を組み立てる（design.md §16.21）。 */
  private buildRunTaskSnapshots(runId: string): RunTaskSnapshot[] {
    const live = this.runs.get(runId);
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
  private onMessageAccepted(runId: string, message: StoredMessage): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    let changed = false;

    if (message.expectReply) {
      const senderTask = live.tasks.get(message.from);
      const senderState = live.runState.tasks.get(message.from);
      if (senderTask !== undefined && senderState?.state === 'running') {
        live.runState = markWaitingReply(live.runState, message.from);
        senderTask.waitingReplySinceMs = (this.deps.now?.() ?? new Date()).getTime();
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
      this.notify(runId);
      void this.persist(runId);
    }
  }

  /**
   * 待ちぼうけの2経路（design.md §16.21「待ちぼうけを検出する経路」）を確認し、解けていれば
   * `running`へ戻す。`WorkflowRunnerMessagingDeps.startTransport`と同時に登録したタイマー
   * （`WAITING_REPLY_POLL_INTERVAL_MS`ごと）から呼ばれる。
   */
  private checkWaitingReplyStalls(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.messaging === undefined || live.finished) {
      return;
    }

    const activeStates = new Map<string, TaskState>();
    const waitingSinceMsByTaskId = new Map<string, number>();
    for (const [taskId, s] of live.runState.tasks) {
      if (
        s.state === 'running' ||
        s.state === 'waitingApproval' ||
        s.state === 'waitingReply' ||
        s.state === 'merging'
      ) {
        activeStates.set(taskId, s.state);
      }
      if (s.state === 'waitingReply') {
        const sinceMs = live.tasks.get(taskId)?.waitingReplySinceMs;
        if (sinceMs !== undefined) {
          waitingSinceMsByTaskId.set(taskId, sinceMs);
        }
      }
    }

    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const replyTimeoutSec =
      this.deps.messaging?.readReplyTimeoutSec?.() ?? DEFAULT_REPLY_TIMEOUT_SEC;

    const stalemateIds = detectAllWaitingStalemate(
      activeStates,
      live.messaging.hub.totalUndeliveredCount(),
    );
    const timedOutIds = detectTimedOutWaitingReplies(waitingSinceMsByTaskId, nowMs, replyTimeoutSec);

    this.releaseStalledWaitingReplies(runId, live, stalemateIds, 'allWaiting');
    this.releaseStalledWaitingReplies(runId, live, timedOutIds, 'timeout');
  }

  /** `checkWaitingReplyStalls`が検出したtaskIdを実際に`running`へ戻し、警告を積む。 */
  private releaseStalledWaitingReplies(
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
    this.notify(runId);
    void this.persist(runId);
  }

  /**
   * MCPツールの可視性確認（design.md §16.21「ツールの可視性の確認」）。見えなければ
   * ワークフローViewへ警告を出し、通信なしでそのまま走らせる（runは止めない）。
   * `startTask`が`await`せず投げっぱなしで呼ぶ（タスクの開始自体をこの確認で遅らせない）。
   */
  private async checkMessagingVisibility(
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
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    live.warnings.push({
      kind: 'messagingUnavailable',
      taskId,
      message: `タスク間メッセージングのツールがこのタスクから見えませんでした（通信なしで実行します）: ${taskId}`,
    });
    this.notify(runId);
    void this.persist(runId);
  }

  /**
   * 実行全体を停止する。人の割り込み（`manual`）と同じ扱いで、新しいタスクの開始だけを
   * 止める。既に `running` のタスクはそのまま走らせ切る（design.md §16.5）。
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
   * 終わった（`done`/`failed`/`skipped`）タスクのworktreeをまとめて撤去する
   * （design.md §16.8「そのほか」の操作。`cleanup: keep` のまま放置されたものを
   * 後から片付ける手段）。
   */
  async removeWorktrees(runId: string): Promise<{ removed: string[]; failed: string[] }> {
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
      // このウィンドウでworktreeを作ったことが判っている（liveTask.usedWorktree）場合を
      // 優先し、リロード復元でliveTaskが無い場合は定義から推定する（cwdを明示していない
      // worktree系isolationかつgitリポジトリなら作られたはず、という近似）
      const usedWorktree =
        liveTask?.usedWorktree ??
        (task.cwd === undefined &&
          (task.isolation === 'worktree' || task.isolation === 'worktree-strict') &&
          live.gitRepo);
      if (!usedWorktree) {
        continue;
      }
      const retry = retrySuffixOf(state.retryCount);
      const result = await this.deps.worktreeQueue.remove(
        live.repoRoot,
        runId,
        task.id,
        retry,
        this.deps.git,
      );
      if (result.ok) {
        removed.push(task.id);
      } else {
        failed.push(task.id);
        this.deps.log.warn(
          `[workflow ${runId}/${task.id}] worktreeの撤去に失敗しました: ${result.message}`,
        );
      }
    }
    this.notify(runId);
    return { removed, failed };
  }

  /**
   * 統合ブランチのworktreeと、終わったタスクの残りworktreeをまとめて撤去する
   * （design.md §16.8「そのほか」の操作・§16.17「worktreeの片付け」、Issue #118）。
   *
   * **統合worktreeの撤去は、この操作からの明示的な呼び出しでしか行わない。** `blocked`
   * タスクの再マージ（`retryMerge`）は統合worktreeを使い続けるため、runの終了時に
   * 無条件で撤去してはいけない（Issue #118のコメント「統合worktreeの撤去タイミングは
   * 未解決の論点」への回答）。runがまだ`running`の間は、後続タスクが統合worktreeを
   * 必要としうるため撤去せず失敗として返す（安全側。人が明示的に押した操作であっても
   * 走っているタスクの前提を壊してはいけない）。
   *
   * 統合worktreeの実体は `worktreePath(repoRoot, runId, '_integration')` が指す場所で、
   * `integrationWorktreePath` と同じディレクトリを指す（design.md §16.17「`_integration`は
   * タスクidとして予約する」）。そのため `deps.worktreeQueue.remove` をタスクのworktree撤去と
   * 同じ入口から呼べる。未コミットの変更が残っていれば（`removeWorktree`自身の
   * `uncommittedChanges`判定）撤去せず警告する（既存の方針を踏襲。設計上、統合worktreeで
   * 衝突が未解決のまま残っている場合もここで弾かれる）。
   *
   * ブランチ自体は消さない（`git worktree remove`はworktreeの参照を外すだけ。
   * design.md §16.17「ブランチは消さない。PR/MRから辿れる必要がある」）。
   */
  async cleanupIntegration(runId: string): Promise<{
    tasksRemoved: string[];
    tasksFailed: string[];
    integrationRemoved: boolean;
    integrationFailedMessage: string | undefined;
  }> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return {
        tasksRemoved: [],
        tasksFailed: [],
        integrationRemoved: false,
        integrationFailedMessage: undefined,
      };
    }
    const taskResult = await this.removeWorktrees(runId);

    if (live.integration === undefined) {
      return {
        tasksRemoved: taskResult.removed,
        tasksFailed: taskResult.failed,
        integrationRemoved: false,
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
        integrationFailedMessage: message,
      };
    }

    const result = await this.deps.worktreeQueue.remove(
      live.repoRoot,
      runId,
      INTEGRATION_DIR_NAME,
      undefined,
      this.deps.git,
    );
    this.notify(runId);
    if (result.ok) {
      return {
        tasksRemoved: taskResult.removed,
        tasksFailed: taskResult.failed,
        integrationRemoved: true,
        integrationFailedMessage: undefined,
      };
    }
    this.deps.log.warn(`[workflow ${runId}] 統合worktreeの撤去に失敗しました: ${result.message}`);
    return {
      tasksRemoved: taskResult.removed,
      tasksFailed: taskResult.failed,
      integrationRemoved: false,
      integrationFailedMessage: result.message,
    };
  }

  // ---- スケジューリング ----

  /** 状態が変わるたびに呼ぶ（design.md §16.3）。次に開始できるタスクを開始し、終了を判定する。 */
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
      // 疑似worktree（design.md §16.20）はrunの結果を問わず反映する（forgeとは異なり
      // `succeeded`限定にしない。`reflectPseudoWorktree`自身のJSDoc参照）
      if (live.pseudo !== undefined) {
        void this.reflectPseudoWorktree(runId);
      }
      // タスク間メッセージング（design.md §16.21）のMCPサーバはrunの結果を問わず閉じる。
      // 以降新しいタスクは開始されない（`live.finished`）ため、これ以上の接続は要らない
      if (live.messaging !== undefined) {
        void live.messaging.transport.close();
        clearInterval(live.messaging.waitingReplyPollTimer);
      }
    }
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
      const retry = retrySuffixOf(live.runState.tasks.get(taskId)?.retryCount);
      const { cwd, branch, usedWorktree, usedPseudoWorktree, pseudoSnapshot, originCommit } =
        await this.resolveWorkingDirectory(live, task, retry);

      const baseline = this.deps.readBaseline();
      // クランプはこの1関数だけを通す（design.md §16.16。#52セキュリティ監査指摘）
      const effective = buildEffectiveTaskConfig(task, baseline);
      for (const w of effective.warnings) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${w}`);
        live.warnings.push({ kind: 'clamp', taskId, message: w });
      }

      // 最終防御（レビュー指摘: critical 3）。bypassPermissionsでは`can_use_tool`が
      // 発行されず、classifyApprovalRequest / autoApprove / escalate / allow が
      // 一度も呼ばれない。workflow.tsのvalidateWorkflowはYAMLリテラルの
      // `approvalMode: bypassPermissions`一致だけを見るため、YAML側が何も指定せず
      // 拡張機能側の設定が既にbypassPermissionsの場合は素通りしてしまう（実測で確認済み）。
      // ここは実効値（クランプ後の値）に対する検査であり、YAMLの記述に関わらず効く
      if (task.provider === 'claude' && effective.config.approvalMode === 'bypassPermissions') {
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

      const boundaryResult = await this.buildBoundary(live, cwd);
      if (boundaryResult.warning !== undefined) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${boundaryResult.warning}`);
        live.warnings.push({ kind: 'gitCommonDir', taskId, message: boundaryResult.warning });
      }

      const host = this.deps.hosts[task.provider];
      const session = await host.openTaskSession(input);
      session.open({ preserveFocus: true });

      const liveTask: LiveTask = {
        session,
        cwd,
        branch,
        autoApprove: effective.autoApprove,
        boundary: boundaryResult.boundary,
        usedWorktree,
        usedPseudoWorktree,
        pseudoSnapshot,
        originCommit,
        lastState: undefined,
        result: undefined,
        wasBusy: false,
        submissionCount: 0,
        startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        lastResponseSummary: '',
        pendingApproval: undefined,
        waitingReplySinceMs: undefined,
        pullRequest: undefined,
      };
      live.tasks.set(taskId, liveTask);
      live.runState = recordSessionInfo(live.runState, taskId, session.sessionId, cwd);

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

      // テンプレート展開はタスク開始直前に行う（design.md §16.4）。`runLoop` へ渡す本文は
      // 展開前のまま（作業記録に残すため。§16.12）で、実際の送信直前にpromptTransformで展開する
      const resultsMap = this.buildResultsMap(live, task);
      session.setPromptTransform((text) => {
        const expanded = expandTemplate(text, resultsMap);
        // 受け取ったメッセージは、次の指示の先頭へ添える（design.md §16.21「配送」）。
        // `takeDeliverableMessages`は呼ぶたびに未配送分を取り出す（配送済みとして消費する）
        // ため、送信のたびにここで取りに行く必要がある
        const hub = live.messaging?.hub;
        if (hub === undefined) {
          return expanded;
        }
        return composeNextPrompt(expanded, hub.takeDeliverableMessages(taskId));
      });

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
        void this.checkMessagingVisibility(runId, taskId, session);
      }

      this.notify(runId);
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

  /**
   * `cwd` を実パス解決し、`repoRoot` の実パス配下にあるか確かめる。
   *
   * cwdを無検証で通すと、`sandbox: workspace-write` の「workspace」の基準そのものを
   * YAMLから付け替えられる（例: cwdに `~/.ssh` を指定すれば、そこが書き込み可能な領域に
   * なる）。design.md §16.16 が塞ぐと決めている経路。`workflow.ts` の検証は実パス解決を
   * 伴わないためこの判定ができず、実行層の責務になる。
   */
  private async resolveExplicitCwd(
    cwd: string,
    repoRoot: string,
  ): Promise<{ ok: true; resolved: string } | { ok: false; message: string }> {
    const resolvedCwd = await this.deps.fs.realpath(cwd);
    if (resolvedCwd === undefined) {
      return { ok: false, message: `cwdを解決できませんでした: ${cwd}` };
    }
    // 境界側も実パスに直してから比べる。シンボリックリンク越しに外へ出るのを防ぐ
    const resolvedRoot = (await this.deps.fs.realpath(repoRoot)) ?? repoRoot;
    if (!isPathWithinRoot(resolvedCwd, resolvedRoot)) {
      return {
        ok: false,
        message: `cwdがワークスペースの外を指しています（design.md §16.16）: ${cwd}`,
      };
    }
    return { ok: true, resolved: resolvedCwd };
  }

  /**
   * 全タスクの明示`cwd`を実行開始前に一括で検証する（design.md §16.2「1件でも該当すれば
   * 実行を始めない」）。タスクごと（`startTask`内）の事後検証だけだと、正当なcwdの
   * タスクが先に開始・副作用を残した後で別タスクの違反が判明しうる
   * （レビュー指摘: warning）。
   */
  private async validateExplicitCwds(
    def: WorkflowDefinition,
    repoRoot: string,
  ): Promise<WorkflowIssue[]> {
    const errors: WorkflowIssue[] = [];
    for (const task of def.tasks) {
      if (task.cwd === undefined) {
        continue;
      }
      const resolved = await this.resolveExplicitCwd(task.cwd, repoRoot);
      if (!resolved.ok) {
        errors.push(issue(resolved.message, [task.id]));
      }
    }
    return errors;
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

  private async resolveWorkingDirectory(
    live: LiveRun,
    task: WorkflowTask,
    retry: number | undefined,
  ): Promise<{
    cwd: string;
    branch: string;
    usedWorktree: boolean;
    usedPseudoWorktree: boolean;
    pseudoSnapshot: Snapshot | undefined;
    originCommit: string;
  }> {
    const decision = decideWorkingDirectory(task, live.gitRepo);
    if (decision.kind === 'explicitCwd') {
      // decision.kind==='explicitCwd'はtask.cwdが設定されている場合にしか出ない
      // （decideWorkingDirectoryの実装参照）。ここで無いのは呼び出し元の不整合
      if (task.cwd === undefined) {
        throw new Error('内部矛盾: explicitCwdの判定なのにcwdが無いタスクです');
      }
      // 実行開始時（start()）の一括検証を必ず通っている前提だが、念のためここでも確かめる
      // （多層防御。呼び出し順序の変更などで一括検証が経由されなくても危険側に倒れない）
      const resolved = await this.resolveExplicitCwd(task.cwd, live.repoRoot);
      if (!resolved.ok) {
        throw new Error(resolved.message);
      }
      return {
        cwd: resolved.resolved,
        branch: '',
        usedWorktree: false,
        usedPseudoWorktree: false,
        pseudoSnapshot: undefined,
        originCommit: '',
      };
    }
    if (decision.kind === 'shared') {
      return {
        cwd: live.repoRoot,
        branch: '',
        usedWorktree: false,
        usedPseudoWorktree: false,
        pseudoSnapshot: undefined,
        originCommit: '',
      };
    }
    if (decision.kind === 'sharedFallback') {
      this.deps.log.warn(`[workflow ${live.runId}/${task.id}] ${decision.warning}`);
      live.warnings.push({ kind: 'gitFallback', taskId: task.id, message: decision.warning });
      // 疑似worktree（design.md §16.20、Issue #105）。`WorkflowRunnerDeps.pseudoWorktree`が
      // 渡されていない場合は、従来どおりワークスペース直下を共有する（後方互換）
      if (live.pseudo !== undefined && this.deps.pseudoWorktree !== undefined) {
        const cloned = await cloneWorkspace(
          live.repoRoot,
          live.runId,
          task.id,
          live.pseudo.exclude,
          this.deps.pseudoWorktree.fs,
        );
        if (!cloned.ok) {
          throw new Error(`疑似worktreeの作成に失敗しました: ${cloned.message}`);
        }
        return {
          cwd: cloned.cwd,
          branch: '',
          usedWorktree: false,
          usedPseudoWorktree: true,
          pseudoSnapshot: cloned.snapshot,
          originCommit: '',
        };
      }
      return {
        cwd: live.repoRoot,
        branch: '',
        usedWorktree: false,
        usedPseudoWorktree: false,
        pseudoSnapshot: undefined,
        originCommit: '',
      };
    }
    if (decision.kind === 'error') {
      throw new Error(decision.message);
    }

    // タスクブランチの分岐元は「そのタスクを開始する時点の統合ブランチのHEAD」
    // （design.md §16.17「タスクブランチの分岐元」。現行の「実行開始時のHEAD」から変更）。
    // 統合worktreeが無い（gitRepoでない）ケースは`decideWorkingDirectory`が`shared`/
    // `sharedFallback`/`error`のいずれかへ倒すため、ここへは来ない
    if (live.integration === undefined) {
      throw new Error('内部矛盾: 統合worktreeが無い状態でworktree隔離のタスクを開始しようとしました');
    }
    const originCommit = await resolveTaskBranchOrigin(live.repoRoot, live.runId, this.deps.git);
    if (originCommit === undefined) {
      throw new Error('統合ブランチのHEADコミットを解決できませんでした');
    }

    const result = await this.deps.worktreeQueue.create(
      {
        repoRoot: live.repoRoot,
        runId: live.runId,
        taskId: task.id,
        headCommit: originCommit,
        retry,
      },
      this.deps.git,
      this.deps.fs,
    );
    if (!result.ok) {
      throw new Error(`worktreeの作成に失敗しました: ${result.message}`);
    }
    return {
      cwd: result.cwd,
      branch: result.branch,
      usedWorktree: true,
      usedPseudoWorktree: false,
      pseudoSnapshot: undefined,
      originCommit,
    };
  }

  // ---- 疑似worktree（design.md §16.20、Issue #105） ----

  /**
   * gitでないワークスペースでの統合先（`<runId>/_integration`）を用意する
   * （`integration.ts`のgit版と対称の役割）。`WorkflowRunnerDeps.pseudoWorktree`が
   * 渡されていなければ何もせず`state: undefined`を返す（後方互換。上のJSDoc参照）。
   */
  private async resolvePseudoState(
    repoRoot: string,
    runId: string,
  ): Promise<{ ok: true; state: LiveRun['pseudo'] } | { ok: false; message: string }> {
    const deps = this.deps.pseudoWorktree;
    if (deps === undefined) {
      return { ok: true, state: undefined };
    }
    const ensured = await ensureIntegrationDir(repoRoot, runId, deps.fs);
    if (!ensured.ok) {
      return { ok: false, message: ensured.message };
    }
    const baseline = await takeSnapshot(repoRoot, deps.exclude, deps.fs);
    return {
      ok: true,
      state: {
        integrationDir: ensured.dir,
        queue: new PseudoWorktreeIntegrationQueue(),
        baseline,
        exclude: deps.exclude,
      },
    };
  }

  /**
   * タスク1件分の疑似worktreeを統合先へ適用する（design.md §16.20。gitの`attemptMerge`と
   * 対称の役割）。3-way mergeはできないため、同じパスへの変更が複数タスクにまたがれば
   * 内容を見ずに衝突として扱う（design.md「内容の突き合わせは行わず...」）。
   *
   * **衝突解決セッションは開かない。** design.md §16.17の衝突解決セッションは統合worktree
   * （gitの仕組み）を前提にしており、疑似worktree向けに作り直すのはこのIssueの範囲外
   * （Issue #105の配線対象は「decideWorkingDirectoryのgit外フォールバックから繋ぐ」
   * 「runの終了時にワークスペースへ反映する」の2点。最終報告に安全側の判断として記載）。
   * 衝突したタスクは`blocked`にし、独立した枝は走り続ける（`markMergeBlocked`と同じ扱い）。
   */
  private async integratePseudoWorktree(
    runId: string,
    taskId: string,
    pseudo: NonNullable<LiveRun['pseudo']>,
    liveTask: LiveTask,
  ): Promise<void> {
    const live = this.runs.get(runId);
    const deps = this.deps.pseudoWorktree;
    if (live === undefined || deps === undefined) {
      return;
    }
    const currentSnapshot = await takeSnapshot(liveTask.cwd, pseudo.exclude, deps.fs);
    const diff = diffSnapshots(liveTask.pseudoSnapshot ?? new Map(), currentSnapshot);
    const plan = await pseudo.queue.integrate(taskId, liveTask.cwd, pseudo.integrationDir, diff, deps.fs);

    if (plan.conflicts.length > 0) {
      const paths = plan.conflicts.map((c) => c.path).join(', ');
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] 疑似worktreeの統合が衝突しました（3-way mergeができないため）: ${paths}`,
      );
      live.warnings.push({
        kind: 'pseudoWorktreeConflict',
        taskId,
        message: `疑似worktreeの統合が衝突しました: ${paths}`,
      });
      live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    } else {
      live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
    }
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  /**
   * runの終了時、疑似worktreeの統合先の内容をワークスペースへ反映する
   * （design.md §16.20「runが終わったら、統合先の内容をワークスペースへ反映する」）。
   * `pump()`が`outcome !== 'running'`を検出した回だけ、成功/失敗を問わず呼ぶ
   * （gitの`finalizeForge`が`succeeded`限定なのとは異なる。§16.20はrunの結果を条件に
   * していないため、それまでに統合できた分は反映する）。
   *
   * 反映前にワークスペース側の変更を検知したら、反映せず警告を残す
   * （design.md「人の編集を上書きしない」。`reflectIntegrationToWorkspace`自身が判定する）。
   */
  private async reflectPseudoWorktree(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    const deps = this.deps.pseudoWorktree;
    if (live === undefined || live.pseudo === undefined || deps === undefined) {
      return;
    }
    const result = await reflectIntegrationToWorkspace(
      live.repoRoot,
      live.pseudo.integrationDir,
      live.pseudo.baseline,
      live.pseudo.queue.getManifest(),
      live.pseudo.exclude,
      deps.fs,
    );
    if (!result.ok) {
      this.deps.log.warn(`[workflow ${runId}] ${result.message}`);
      live.warnings.push({
        kind: 'pseudoWorktreeReflectBlocked',
        taskId: undefined,
        message: `${result.message}（変更されたパス: ${result.changedPaths.join(', ')}）`,
      });
    } else {
      this.deps.log.info(
        `[workflow ${runId}] 疑似worktreeの統合結果をワークスペースへ反映しました（${result.appliedPaths.length}件）`,
      );
    }
    this.notify(runId);
  }

  private async buildBoundary(
    live: LiveRun,
    cwd: string,
  ): Promise<{ boundary: TaskBoundary; warning: string | undefined }> {
    const result = await buildTaskBoundary([cwd], live.repoRoot, this.deps.git, this.deps.fs);
    return { boundary: result.boundary, warning: result.gitCommonDirWarning };
  }

  // ---- PR/MR作成（design.md §16.18） ----

  /**
   * runごとに一度だけPR/MR作成の可否を決める（design.md §16.18「実行開始前に次を確かめる」）。
   * `WorkflowRunnerDeps.forge` が渡されていない、または `agent.workflows.forge` が
   * `none` なら `disabled`。ホストを判定できない、または前提（`origin` remote・`gh`/`glab`の
   * PATH・認証）が欠けていれば `skipped`（呼び出し側が警告を出し、ローカルのマージだけ
   * 進める。design.md「前提が欠けている場合...ワークフロー自体は止めない」）。
   */
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
   * タスクのマージを試みる。PR/MRの作成が有効（`forge.kind === 'active'` かつ
   * `shouldCreateTaskPullRequest`）なら、design.mdが定める順序
   * （`runTaskPullRequestFlow`。push→push→create→merge+push）で行う。無効なら
   * 従来どおりローカルの統合worktreeへのマージだけを行う。
   *
   * PR/MRの作成（`pushTaskBranch`/`pushIntegrationBranch`/`createPullRequest`）が
   * 失敗しても、統合ブランチへのローカルのマージ（`mergeAndPushIntegration`）は必ず行う
   * （`runTaskPullRequestFlow`自身の保証。design.md §16.18「前提が欠けている場合」と同じ
   * 「ワークフロー自体は止めない」方針）。
   */
  private async mergeTaskWithForge(
    live: LiveRun,
    runId: string,
    taskId: string,
    task: WorkflowTask,
    integration: { cwd: string; branch: string },
    taskCwd: string,
    taskBranch: string,
  ): Promise<{ merge: MergeTaskResult; pullRequest: PullRequestResult | undefined }> {
    const forgeDeps = this.deps.forge;
    const forge = live.forge;
    if (forgeDeps === undefined || forge.kind !== 'active' || !shouldCreateTaskPullRequest(forge.pullRequest)) {
      const merge = await this.integrationQueue.mergeTask(
        integration.cwd,
        runId,
        taskId,
        taskBranch,
        this.deps.git,
      );
      return { merge, pullRequest: undefined };
    }

    const flow = await runTaskPullRequestFlow({
      pushTaskBranch: () => pushBranch(this.deps.git, taskCwd, taskBranch),
      pushIntegrationBranch: () => pushBranch(this.deps.git, integration.cwd, integration.branch),
      createPullRequest: () =>
        createPullRequest(
          { cli: forgeDeps.cli, fs: forgeDeps.fs },
          {
            host: forge.host,
            cwd: taskCwd,
            base: integration.branch,
            head: taskBranch,
            title: buildTaskPullRequestTitle(taskId, task.prompt),
            body: buildTaskPullRequestBody({
              prompt: task.prompt,
              done: task.done,
              runId,
              dependsOn: task.dependsOn,
              // `workflow.ts`のWorkflowTaskはまだ`issue`フィールドを持たない
              // （§16.19の2段目・ロードマップ→YAML変換がこのIssueの範囲外のため）。
              // 実装されるまでは`Closes #<N>`を出せない（最終報告に記載）
              issue: undefined,
            }),
          },
        ),
      mergeAndPushIntegration: async () => {
        const merged = await this.integrationQueue.mergeTask(
          integration.cwd,
          runId,
          taskId,
          taskBranch,
          this.deps.git,
        );
        if (merged.kind === 'success') {
          const push = await pushBranch(this.deps.git, integration.cwd, integration.branch);
          if (!push.ok) {
            this.deps.log.warn(
              `[workflow ${runId}/${taskId}] 統合ブランチのpushに失敗しました: ${push.message}`,
            );
            live.warnings.push({
              kind: 'forgeFailed',
              taskId,
              message: `統合ブランチのpushに失敗しました: ${push.message}`,
            });
          }
        }
        return merged;
      },
    });

    if (!flow.pullRequest.created) {
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] PR/MRの作成に失敗しました（${flow.pullRequest.stage}）: ${flow.pullRequest.message}`,
      );
      live.warnings.push({
        kind: 'forgeFailed',
        taskId,
        message: `PR/MRの作成に失敗しました（${flow.pullRequest.stage}）: ${flow.pullRequest.message}`,
      });
    } else if (flow.pullRequest.url !== undefined) {
      this.deps.log.info(`[workflow ${runId}/${taskId}] PR/MRを作成しました: ${flow.pullRequest.url}`);
    }

    // design.md §16.11「タスクごとの...PR/MRの番号」・Issue #118。番号とURLだけを持ち帰る
    // （本文は持ち帰らない）。作成できていても`url`が無い（CLIの出力形式が想定外）場合は
    // 表示に使えないため記録しない（`else if`と同じ条件）
    const pullRequest: PullRequestResult | undefined =
      flow.pullRequest.created && flow.pullRequest.url !== undefined
        ? { number: parsePullRequestNumberFromUrl(flow.pullRequest.url), url: flow.pullRequest.url }
        : undefined;

    return { merge: flow.mergeOutcome, pullRequest };
  }

  /**
   * 全タスクが`done`になった直後（design.md §16.18「全体の終了とmainへの反映」）に、
   * 統合ブランチからmainへのPR/MRを作る。`pump()`から`getRunOutcome`が`succeeded`を
   * 返した回だけ呼ばれる。
   */
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
      },
    );

    const created = result.pullRequest.ok;
    if (!created) {
      this.deps.log.warn(`[workflow ${runId}] 統合PR/MRの作成に失敗しました: ${result.pullRequest.message}`);
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
      };
    }

    live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, reason);

    if (reason !== 'manual' && reason !== 'interrupted') {
      // done / maxReached / failed。セッションを解放する（design.md §16.10の4）。
      // 再試行はここで新しいセッション・worktreeを新規に作るため、古いものは残さない
      liveTask?.session.dispose();

      if (reason === 'done' && liveTask !== undefined) {
        if (liveTask.usedWorktree) {
          // マージまでを拡張機能の責務にする（design.md §16.17）。ループが終わっただけでは
          // `applyLoopStopReason`が`merging`にしてあるだけなので、実際にマージを試みる
          void this.startMerge(runId, taskId, task, liveTask.cwd, liveTask.branch, liveTask.originCommit);
        } else if (liveTask.usedPseudoWorktree && live.pseudo !== undefined) {
          // 疑似worktree（design.md §16.20）。gitのマージに相当する統合を試みる
          void this.integratePseudoWorktree(runId, taskId, live.pseudo, liveTask);
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
   * タスクが`merging`になった直後に呼ぶ。未コミットの変更を回収してからマージを試みる。
   * `onTaskFinished`（通常経路）と`resumeMergeAfterReload`（リロード後の再開）の両方から
   * 呼ばれるため、`LiveTask`ではなくcwd/branch/originCommitを直接受け取る。
   */
  private async startMerge(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    taskCwd: string,
    taskBranch: string,
    originCommit: string,
  ): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    if (live.integration === undefined) {
      // 内部矛盾（usedWorktreeなタスクが走っている以上、start()が統合worktreeを
      // 作っているはず）。安全側でfailedにする
      this.deps.log.error(`[workflow ${runId}/${taskId}] 統合worktreeが無いためマージできません`);
      live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }

    // design.md §16.17「タスク完了時のコミット」2.〜4.
    const commitResult = await commitUncommittedChangesIfNeeded(taskCwd, taskId, this.deps.git);
    if (!commitResult.ok) {
      this.deps.log.error(
        `[workflow ${runId}/${taskId}] 未コミットの変更の回収に失敗しました: ${commitResult.message}`,
      );
      live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }

    await this.attemptMerge(runId, taskId, task, live.integration, taskCwd, taskBranch, originCommit);
  }

  /**
   * 統合worktreeへ実際にマージを試みる。成功なら`done`、衝突なら衝突解決セッションを
   * 起動、その他の失敗なら`failed`にする（design.md §16.17「マージ」）。
   *
   * PR/MRの作成（design.md §16.18）が有効なら、マージ自体も`mergeTaskWithForge`が
   * design.mdの定める順序で行う。
   */
  private async attemptMerge(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    integration: { cwd: string; branch: string },
    taskCwd: string,
    taskBranch: string,
    originCommit: string,
  ): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const { merge, pullRequest } = await this.mergeTaskWithForge(
      live,
      runId,
      taskId,
      task,
      integration,
      taskCwd,
      taskBranch,
    );

    // design.md §16.11「タスクごとの...PR/MRの番号」・Issue #118。PR/MRの作成はマージより
    // 前の手順（design.md §16.18「作る順序」）なので、マージが失敗・衝突した場合でも
    // 既に作られたPR/MRのリンクは書き込む。`live.tasks.get(taskId)`はリロード直後に
    // マージを再開した経路（`resumeMergeAfterReload`）では未定義になりうる
    // （このウィンドウでセッションを開いていないため）。その場合はこの1回分の結果を
    // 保持できないが、実行そのものは止めない（安全側）
    const liveTaskForPr = live.tasks.get(taskId);
    if (liveTaskForPr !== undefined && pullRequest !== undefined) {
      liveTaskForPr.pullRequest = pullRequest;
    }

    if (merge.kind === 'success') {
      live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
      this.cleanupWorktreeIfNeeded(live, task, taskId, live.tasks.get(taskId));
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }
    if (merge.kind === 'failure') {
      this.deps.log.error(`[workflow ${runId}/${taskId}] マージに失敗しました: ${merge.message}`);
      live.runState = markMergeFailed(live.runState, live.def.tasks, taskId);
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }

    // 衝突。design.md §16.17「コンフリクト」1.「衝突した状態のままにしておく」
    void this.persist(runId);
    await this.startMergeResolution(runId, taskId, task, integration, merge, originCommit);
  }

  /**
   * 衝突解決セッションを開く（design.md §16.17「コンフリクト」3.）。衝突した状態の
   * 統合worktreeを`cwd`にし、未解決パスの一覧と、突き合わせる相手のタスクの`prompt`/`done`
   * をプロンプトに渡す。解決用セッションは依存グラフのノードにはしない（design.md
   * 「コンフリクト」5.）ため、`live.tasks`ではなく`live.mergeResolutions`で管理する。
   */
  private async startMergeResolution(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    integration: { cwd: string; branch: string },
    conflict: Extract<MergeTaskResult, { kind: 'conflict' }>,
    originCommit: string,
  ): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }

    const baseline = this.deps.readBaseline();
    const effective = buildEffectiveTaskConfig(task, baseline);
    // startTask()と同じ最終防御（レビュー指摘: critical 3参照）。衝突解決セッションも
    // 通常のタスクと同じループ制御・承認判定に従う（design.md §16.17「コンフリクト」5.）
    if (task.provider === 'claude' && effective.config.approvalMode === 'bypassPermissions') {
      this.deps.log.error(
        `[workflow ${runId}/${taskId}] 実効approvalModeがbypassPermissionsのため衝突解決セッションを開始できません`,
      );
      await this.abortAndBlock(runId, taskId, integration);
      return;
    }

    const otherIds =
      originCommit !== ''
        ? await findTaskIdsMergedSince(integration.cwd, runId, originCommit, this.deps.git)
        : [];
    const others: MergeResolutionTaskInfo[] = otherIds
      .filter((id) => id !== taskId)
      .map((id) => live.def.tasks.find((t) => t.id === id))
      .filter((t): t is WorkflowTask => t !== undefined)
      .map((t) => ({ id: t.id, prompt: t.prompt, done: t.done }));

    const host = this.deps.hosts[task.provider];
    let session: TaskSession;
    try {
      session = await host.openTaskSession({
        cwd: integration.cwd,
        config: effective.config,
        sandbox: effective.sandbox,
      });
    } catch (e) {
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.error(
        `[workflow ${runId}/${taskId}] 衝突解決セッションを開始できませんでした: ${message}`,
      );
      await this.abortAndBlock(runId, taskId, integration);
      return;
    }
    session.open({ preserveFocus: true });
    live.mergeResolutions.set(taskId, session);

    const prompt = buildMergeResolutionPrompt(
      { id: taskId, prompt: task.prompt, done: task.done },
      others,
      conflict.unresolvedPaths,
    );

    // 衝突解決セッションの承認は、通常のタスクの`escalation.ts`（境界・allow/escalate）
    // ではなく、標準の承認カード（`setApprovalHandler`を設定しない既定挙動）へ委ねる。
    // タスク境界（`TaskBoundary`）は本来そのタスクのworktree用に作られたもので、統合
    // worktree（別ディレクトリ）向けに作り直すと境界判定の意味が変わってしまう。安全側
    // （常に人の承認を要求する）に倒すための単純化であり、最終報告に明記する
    session.onFinished((reason) => {
      void this.onMergeResolutionFinished(runId, taskId, task, integration, reason);
    });

    session.runLoop({
      initialPrompt: prompt,
      continuePrompt: `続けてください。終了条件: ${MERGE_RESOLUTION_CONDITION}`,
      maxIterations: MERGE_RESOLUTION_MAX_ITERATIONS,
      condition: MERGE_RESOLUTION_CONDITION,
    });
    this.notify(runId);
  }

  /** 衝突解決セッションの結果を受けて、`done`（解決済み）か`blocked`（未解決）かを確定する。 */
  private async onMergeResolutionFinished(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    integration: { cwd: string; branch: string },
    reason: LoopStopReason,
  ): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const session = live.mergeResolutions.get(taskId);
    live.mergeResolutions.delete(taskId);
    session?.dispose();

    if (reason === 'manual' || reason === 'interrupted') {
      // 人がタブへ直接介入した。通常のタスクと同じく、このタスク自身の状態は変えず
      // 実行全体だけを止める設計を踏襲する（design.md §16.5）
      live.runState = applyLoopStopReason(live.runState, live.def.tasks, '', reason);
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }

    // design.md §16.17「コンフリクト」4.「宣言だけを信じず`git status`でも確かめる」
    const resolved =
      reason === 'done' && (await isMergeResolutionComplete(integration.cwd, this.deps.git));
    if (resolved) {
      live.runState = markMergeSucceeded(live.runState, live.def.tasks, taskId);
      this.cleanupWorktreeIfNeeded(live, task, taskId, live.tasks.get(taskId));
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
      return;
    }

    if (reason === 'done') {
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] 衝突解決セッションはdoneを宣言しましたが、git上は未解決のままでした`,
      );
    }
    await this.abortAndBlock(runId, taskId, integration);
  }

  /** マージを巻き戻して`blocked`に確定させる共通処理（design.md §16.17「コンフリクト」7.）。 */
  private async abortAndBlock(
    runId: string,
    taskId: string,
    integration: { cwd: string; branch: string },
  ): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const abort = await this.integrationQueue.abortMerge(integration.cwd, this.deps.git);
    if (!abort.ok) {
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] マージの巻き戻しに失敗しました: ${abort.message}`,
      );
    }
    live.runState = markMergeBlocked(live.runState, live.def.tasks, taskId);
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  /**
   * `blocked`のタスクを再マージする（design.md §16.17「Viewから人が解決したうえで
   * 『再マージ』を指示できる」）。Viewからの呼び出しの配線は別Issue（このIssueは
   * `src/view/`を対象外にしている）だが、runner.ts側の入口はここに用意しておく。
   *
   * タスクのworktree・ブランチはこのウィンドウのライブなセッション（`live.tasks`）が
   * あればそれを、無ければ永続化された値（リロード後、まだ再実行していない場合）を使う。
   */
  retryMerge(runId: string, taskId: string): boolean {
    const live = this.runs.get(runId);
    if (live === undefined || live.integration === undefined) {
      return false;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      return false;
    }
    const liveTask = live.tasks.get(taskId);
    const persistedTask = this.deps.store.find(runId)?.tasks[taskId];
    const branch = liveTask?.branch ?? persistedTask?.branch;
    const cwd = liveTask?.cwd ?? persistedTask?.cwd;
    if (branch === undefined || branch === '' || cwd === undefined) {
      return false;
    }
    const next = retryMergeState(live.runState, taskId);
    if (next === live.runState) {
      return false;
    }
    live.runState = next;
    // `pump()`は`live.finished`が立っていると即座に戻ってしまう（design.md §16.5の終了判定を
    // 一度確定させたら動かさない設計）。`blocked`はrunの終了判定（`getRunOutcome`）を`running`
    // 以外へ倒すため、`retryTask`（手動の再実行）が同じ理由で`finished`を解除しているのと
    // 同様、ここでも再開の起点として明示的に解除する
    live.finished = false;
    void this.persist(runId);
    this.notify(runId);
    void this.startMerge(runId, taskId, task, cwd, branch, liveTask?.originCommit ?? '');
    return true;
  }

  private cleanupWorktreeIfNeeded(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    liveTask: LiveTask | undefined,
  ): void {
    if (liveTask === undefined || !liveTask.usedWorktree) {
      return;
    }
    const finalState = live.runState.tasks.get(taskId)?.state;
    if (finalState === undefined || !shouldRemoveWorktree(task.cleanup, finalState)) {
      return;
    }
    const retry = retrySuffixOf(live.runState.tasks.get(taskId)?.retryCount);
    void this.deps.worktreeQueue
      .remove(live.repoRoot, live.runId, taskId, retry, this.deps.git)
      .then((result) => {
        if (!result.ok) {
          this.deps.log.warn(
            `[workflow ${live.runId}/${taskId}] worktreeの撤去に失敗しました: ${result.message}`,
          );
        }
      });
  }

  // ---- 永続化 ----

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
        integrationPullRequestUrl: live.integrationPullRequest?.url ?? current?.integrationPullRequestUrl,
        finalMergeOutcome: live.finalMergeOutcome ?? current?.finalMergeOutcome,
      };
    });
  }
}

function issue(message: string, taskIds: string[] = []): WorkflowIssue {
  return { taskIds, message };
}

/**
 * PR/MRのURLから番号を取り出す（design.md §16.11「タスクごとの...PR/MRの番号」・
 * 「統合PR/MRの番号」、Issue #118）。`forge.ts`の`CreatePullRequestOutcome`はURLしか
 * 返さない（`gh pr create`の標準出力・`glab api`が返す`web_url`）ため、ここで拾う。
 * GitHubは`.../pull/<n>`、GitLabは`.../-/merge_requests/<n>`の形式で、いずれも末尾が
 * 10進数になる。取り出せなければ`undefined`（番号なし・URLだけは引き続き表示に使える）。
 */
function parsePullRequestNumberFromUrl(url: string): number | undefined {
  const match = /\/(\d+)\/?$/u.exec(url);
  if (match === null) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * `TaskRunState.retryCount`（0開始。「これまでの自動再試行回数」）から、
 * `worktreePath` / `branchName` が受け取る `retry` サフィックス番号（0開始）へ変換する。
 *
 * `retryCount` は `applyLoopStopReason` が**次の試行を始める前に**インクリメントする
 * （design.md §16.5の再試行判定）ため、1回目の失敗直後は `retryCount === 1` になる。
 * これは「1回retryを消費した」という意味であり、そのままworktreeのサフィックスに使うと
 * 1回目の再試行が `-retry1` になってしまう（`worktree.test.ts` が固定している規約は
 * 1回目の再試行が `-retry0`）。1つずらして渡す必要がある
 * （レビュー指摘: high。テスト追加で発覚したオフバイワン）。
 */
function retrySuffixOf(retryCount: number | undefined): number | undefined {
  return retryCount !== undefined && retryCount > 0 ? retryCount - 1 : undefined;
}
