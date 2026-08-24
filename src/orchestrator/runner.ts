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
  buildTaskIssueBody,
  buildTaskPullRequestTitle,
  checkForgePrerequisites,
  createIntegrationPullRequest,
  createIssue,
  buildIntegrationPullRequestBody,
  buildIntegrationPullRequestTitle,
  DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES,
  DEFAULT_CI_WAIT_TIMEOUT_SEC,
  DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC,
  markPullRequestReady,
  needsFinalMergeDecision,
  parsePullRequestNumberFromUrl,
  resolveForgeHost,
  runFinalMergeWithCiGate,
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
import { INTEGRATION_DIR_NAME, IntegrationMergeQueue } from './integration';
import { applyRunCompletionToFile, type RoadmapFileSystemPort } from './roadmap';
import type { TeamRole } from './rolePresets';
import { TeamHandoffStore } from './teamHandoff';
import {
  IntegrationQueue as PseudoWorktreeIntegrationQueue,
  removePseudoIntegration,
  removePseudoWorktreeAttempts,
  type PseudoWorktreeFileSystemPort,
  type Snapshot,
} from './pseudoWorktree';
import {
  composeNextPrompt,
  TaskMessagingHub,
  type DispatchErrorLogPort,
  type HandoffPort,
  type HttpMcpTransportHandle,
} from './messaging';
import { nodeHandoffFileSystem } from './nodeHandoffFileSystem';
import {
  applyLoopStopReason,
  clampWorktreeRemovalAttempts,
  createRunState,
  MAX_WORKTREE_REMOVAL_ATTEMPTS,
  markApprovalRejected,
  markMergeSucceeded,
  markRunning,
  markTaskApprovalTimedOut,
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
import { checkEffectivePermissionEscalation, getSnapshot } from './runnerSnapshot';
import type { WorkflowRunnerInternals } from './runnerInternals';
import { scheduleTaskApprovalTimeout } from './runnerApproval';
import { cleanupWorktreeIfNeeded, retryMerge, startMerge } from './runnerMerge';
import { restoreRunsForView } from './runnerRestore';
import {
  buildRunTaskSnapshots,
  checkMessagingVisibility,
  checkWaitingReplyStalls,
  closeMessaging,
  onMessageAccepted,
} from './runnerMessaging';
import { closeReviewCommentPoll, startReviewCommentPoll } from './runnerReviewComments';
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
  answerAskUser as answerAskUserImpl,
  buildOrchestratorControlPort,
  disposeOrchestrator,
  markOrchestratorRead,
  notifyOrchestrator,
  notifyOrchestratorRunFinished,
  notifyOrchestratorRunHalted,
  sendUserMessageToOrchestrator,
  notifyOrchestratorRunResumed,
  setupOrchestratorForStart,
  syncOrchestratorTaskEvents,
} from './runnerOrchestrator';
import { sanitizeForLog, stripControlChars, stripControlCharsPreservingNewlines } from './sanitize';
import { sanitizeInlineText } from './untrustedText';
import { MAX_MESSAGE_BODY_LENGTH } from './messaging';
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

/**
 * `startMessagingTransport`のMCPサーバ起動失敗警告を、1runにつき実際に記録する上限件数
 * （Issue #475/PR #495レビュー指摘: low〜medium）。
 *
 * 本Issue以前は`setupMessagingForStart`がrun開始時に1回しか呼ばれなかったため、この警告も
 * 1回しか出なかった。`ensureMessaging`は`live.messaging`が`undefined`である限りタスク起動の
 * たびに再試行するため、MCPサーバが恒常的に起動できない環境（ポート払底等）では
 * タスク数・retry回数に比例して同じ警告が無制限に増える。`messaging.ts`の
 * `MAX_DISPATCH_ERROR_LOG_COUNT`（Issue #375、PR #488）と同じ規律に揃える。
 */
export const MAX_MESSAGING_STARTUP_WARN_COUNT = 20;

/**
 * 上限到達後の抑制中に、集計ログを何件おきに出すか。`messaging.ts`の
 * `DISPATCH_ERROR_SUPPRESSION_SUMMARY_INTERVAL`と同じ考え方（Issue #475/PR #495
 * レビュー指摘: low〜medium）。
 */
export const MESSAGING_STARTUP_WARN_SUPPRESSION_INTERVAL = 100;

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
   * `.draftPullRequest` / `.createTaskIssue` / `.reviewTaskPullRequest`。実行開始時に
   * 一度だけ読み直す（`readBaseline` と同じく使い捨てのオブジェクトではなく関数で渡す）。
   *
   * `branchNaming` / `draftPullRequest` はPR/MR作成そのものとは別の関心事（前者はブランチ名の
   * 形、後者はDraft/ready化）だが、設定を`runner.ts`まで運ぶ経路を新設せず、既存の
   * `host`/`pullRequest`/`finalMerge`と同じ「実行開始時に一度読む」経路（`resolveForgeState`・
   * `resolveBranchNamingAndDraft`）へ相乗りさせてある。`createTaskIssue` /
   * `reviewTaskPullRequest`（design.md §16.31、roadmap W6、Issue #596）も同じ理由で
   * ここへ相乗りさせ、`resolveForgeState`が読む（`LiveRunForgeState`の`active`variant参照）。
   */
  readConfig: () => {
    host: ForgeHostConfig;
    pullRequest: PullRequestLayerConfig;
    finalMerge: FinalMergeConfig;
    branchNaming: BranchNaming;
    draftPullRequest: boolean;
    createTaskIssue: boolean;
    reviewTaskPullRequest: boolean;
  };
}

/**
 * タスク間メッセージング（design.md §16.21）に要る依存。`messaging.ts`のポートをそのまま束ねる。
 * `WorkflowRunnerDeps.forge`/`.pseudoWorktree`と同じく省略可能（上のJSDoc参照）。
 */
export interface WorkflowRunnerMessagingDeps {
  /**
   * runごとに1つ、MCPサーバを起動する（design.md §16.21「サーバはrunごとに立て」）。
   *
   * `logPort`は`WorkflowRunner`が`this.deps.log`を包んで渡す（Issue #375）。dispatch例外を
   * `MessagingMcpServer`が記録できるようにする最小限の口（`DispatchErrorLogPort`のJSDoc
   * 参照）。
   */
  startTransport: (
    hub: TaskMessagingHub,
    logPort?: DispatchErrorLogPort,
  ) => Promise<HttpMcpTransportHandle>;
  /**
   * `agent.workflows.replyTimeoutSec` の現在値（秒）。省略時は`DEFAULT_REPLY_TIMEOUT_SEC`
   * （既定300秒）を使う。待ちぼうけ検出の経路2（`detectTimedOutWaitingReplies`）で使う。
   * 呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと
   * （`readBaseline`と同じ流儀。実行中に設定が変わっても次のtickから反映される）。
   */
  readReplyTimeoutSec?: () => number;
}

/**
 * 最終マージの判断待ち（design.md §16.26、`finalMerge: orchestrator` / `confirm`）の
 * 既定タイムアウト秒数。**`orchestrator`にだけ効く**（`confirm`は人がいつ確認するか
 * 分からないため、待ち時間の上限を切って自動`hold`にする理由が無い）。
 *
 * 衝突解決セッションの承認待ち（`DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC`、既定3600秒＝1時間）
 * より短くしてある。衝突解決は人・AIが何度もやり取りしうる多ターンのセッションだが、
 * 最終マージの判断は「差分・警告欄・CIの結果を見て`merge`か`hold`かを1回のツール呼び出しで
 * 答える」だけの単発の判断で、長時間の作業を待つ必要が無いため。オーケストレーターが
 * 応答できない状態（セッションが壊れている等）で統合PR/MRを長時間放置するより、
 * 早めに`hold`へ倒して人が気付けるようにする（design.md §16.26）。
 */
export const DEFAULT_FINAL_MERGE_DECISION_TIMEOUT_SEC = 900;

/** 最終マージの判断（design.md §16.26）。`merge`はmainへ進める、`hold`はPR/MRを残して確定する。 */
export type FinalMergeDecision = 'merge' | 'hold';

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
  /**
   * `agent.workflows.mergeApprovalTimeoutSec`の現在値（秒）。省略時は
   * `DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC`（既定1時間）を使う（Issue #413 PR5）。
   * 衝突解決セッションが承認待ちのままこの秒数を超えたら自動的に停止する
   * （`runnerMerge.ts`の`scheduleApprovalTimeout`）。`messaging.readReplyTimeoutSec`と
   * 同じく、呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと。
   *
   * `messaging`（省略可能な機能）の配下ではなくトップレベルに置く。衝突解決は
   * タスク間メッセージングの有無と無関係に起こるため（`messaging`が無い実行でも
   * このタイムアウトは効かせる必要がある）。
   */
  readMergeApprovalTimeoutSec?: () => number;
  /**
   * `agent.workflows.taskApprovalTimeoutSec`の現在値（秒）。省略時は
   * `DEFAULT_TASK_APPROVAL_TIMEOUT_SEC`（既定1時間）を使う（Issue #579、design.md §16.39）。
   * **`readMergeApprovalTimeoutSec`とは別物。** こちらは通常タスク（`live.tasks`）の
   * `waitingApproval`が対象で、超えたら`markTaskApprovalTimedOut`で`failed`へ倒す
   * （`readMergeApprovalTimeoutSec`は衝突解決セッションが対象で`blocked`へ倒す。
   * design.md §16.39「なぜ別のキーか」参照）。`runnerApproval.ts`の
   * `scheduleTaskApprovalTimeout`が使う。`messaging`（省略可能な機能）とは無関係に
   * 常に効かせるため、`readMergeApprovalTimeoutSec`と同じくトップレベルに置く。
   */
  readTaskApprovalTimeoutSec?: () => number;
  /**
   * `agent.workflows.finalMergeDecisionTimeoutSec`の現在値（秒）。省略時は
   * `DEFAULT_FINAL_MERGE_DECISION_TIMEOUT_SEC`（既定900秒）を使う（design.md §16.26）。
   * `finalMerge: orchestrator`で統合PR/MRを作った後、オーケストレーターが
   * `decide_final_merge`で応答しないままこの秒数を超えたら自動的に`hold`へ倒す
   * （`readMergeApprovalTimeoutSec`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readFinalMergeDecisionTimeoutSec?: () => number;
  /**
   * `agent.workflows.maxAskUserPerRun`の現在値（design.md §16.33、Issue #583）。省略時は
   * `DEFAULT_MAX_ASK_USER_PER_RUN`（`orchestratorSession.ts`）を使う
   * （`readFinalMergeDecisionTimeoutSec`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readMaxAskUserPerRun?: () => number;
  /**
   * `agent.workflows.autoResume`の現在値（design.md §16.35、roadmap W10、Issue #584）。
   * 省略時は`DEFAULT_AUTO_RESUME`（`runnerRestore.ts`、既定`true`）を使う。`false`なら
   * リロード後・WSL再起動後も従来どおり人がViewから再実行するまで再開しない
   * （`readMaxAskUserPerRun`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readAutoResume?: () => boolean;
  /**
   * `agent.workflows.maxAutoResumeAttempts`の現在値（design.md §16.35、roadmap W10、
   * Issue #584）。省略時は`DEFAULT_MAX_AUTO_RESUME_ATTEMPTS`（`runnerRestore.ts`、既定3）を
   * 使う。同じrunがクラッシュと自動再開を繰り返し続けるのを止めるための上限
   * （`readMaxAskUserPerRun`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readMaxAutoResumeAttempts?: () => number;
  /**
   * `agent.workflows.ciWaitTimeoutSec`の現在値（秒）。省略時は`DEFAULT_CI_WAIT_TIMEOUT_SEC`
   * （既定1800秒）を使う（design.md §16.36、Issue #556）。統合PR/MRをマージする前に
   * CIチェックの完了を待つ時間の上限で、超えたら赤（CI失敗）と同じ扱いにする
   * （`readFinalMergeDecisionTimeoutSec`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readCiWaitTimeoutSec?: () => number;
  /**
   * `agent.workflows.ciUpdateBranchMaxRetries`の現在値。省略時は
   * `DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES`（既定2）を使う（design.md §16.36、Issue #556）。
   * マージが「baseの最新でない」ことで拒否されたときの取り込み直しの最大リトライ回数。
   */
  readCiUpdateBranchMaxRetries?: () => number;
  /**
   * `agent.workflows.reviewCommentPollIntervalSec`の現在値（秒）。省略時は
   * `DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC`（既定600秒）を使う（design.md §16.30、
   * roadmap W5、Issue #339）。統合PR/MRのレビューコメントを取得する間隔。0なら取得しない
   * （`readCiWaitTimeoutSec`と同じく、呼び出し側は毎回現在値を返す関数を渡すこと）。
   */
  readReviewCommentPollIntervalSec?: () => number;
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
     * 統合worktreeに他タスクの未解決の衝突が残っていたため、このタスクのマージを
     * 始められなかった（Issue #412）。人が統合worktreeを片付ければViewの「再マージ」で
     * 先へ進めるため、`failed`ではなく`blocked`になる。
     */
    | 'mergeBusy'
    /**
     * 人が衝突解決セッションを止めた（タブへの直接介入 = `manual`/`interrupted`、
     * ワークフローViewの「全体停止」 = `taskStopped`）ため、`merging`を`blocked`へ
     * 確定させた（Issue #443、design.md §16.17「コンフリクト」7.）。`git merge --abort`は
     * 呼んでいない。統合worktreeは衝突した状態のまま（`MERGE_HEAD`・未解決パスが残る）で、
     * `mergeBusy`（他タスクの衝突で始められなかった＝まだ何も解決作業をしていない）とは
     * 「作業が中断された」という点で意味が違うため、`blocked`の`failure`が`undefined`に
     * なる（`markMergeBlocked`）ぶんの区別をこの警告で持たせる。
     *
     * **`taskStopped`はここでは`WorkflowRunner.stop()`（全体停止）経由のものだけを指す**
     * （Issue #514）。`WorkflowRunner.stopTask()`（このタスク単体だけを止める意図。
     * オーケストレーターの`stop_task`とワークフローViewの「タスク停止」ボタンの共通の
     * 入口）が衝突解決セッションへ`stopLoop()`を送ったときは、run全体を止めないぶん
     * `mergeStopTaskStopped`へ分ける。両者は`LoopStopReason`としては同じ`'taskStopped'`
     * だが（`TaskSession.stopLoop()`は理由をこれ以上細かく伝えられない）、
     * `MergeResolutionEntry.stoppedByStopTask`で送り元を区別する
     * （`runnerMerge.ts`の`finishMergeResolution`参照）。
     */
    | 'mergeInterrupted'
    /**
     * 衝突解決セッションが承認待ちのまま`agent.workflows.mergeApprovalTimeoutSec`
     * （既定1時間）を超えたため、自動的に停止して`merging`を`blocked`へ確定させた
     * （Issue #413 PR5）。`mergeInterrupted`と似ているが、止めたのは人ではなく
     * タイムアウトである点が違う。この警告のあいだ、runの`haltedByUser`は変えない
     * （このタスク以外の`pending`は通常どおり開始してよい。`mergeInterrupted`が
     * 対応する`manual`/`interrupted`/`taskStopped`はタブ・View経由の人の操作で、
     * run全体の停止を伴うのと対照的）。`git merge --abort`は呼んでいないため、
     * 統合worktreeは衝突した状態のまま（Viewの「再マージ」で再開できる）。
     */
    | 'mergeApprovalTimeout'
    /**
     * `WorkflowRunner.stopTask()`が衝突解決セッションを止めたため、自動的に停止して
     * `merging`を`blocked`へ確定させた（design.md §16.23、Issue #514）。`stopTask()`は
     * オーケストレーターの`stop_task`とワークフローViewの「タスク停止」ボタンの共通の
     * 入口で、どちらから呼ばれたかはここでは区別しない（`MergeResolutionEntry.
     * stoppedByStopTask`が呼び出し元を区別せず立てるため）。
     * `mergeApprovalTimeout`と同じく、止めたのはこのタスク単体への操作であり、runの
     * `haltedByUser`は変えない（このタスク以外の`pending`は通常どおり開始してよい）。
     * `mergeInterrupted`（`WorkflowRunner.stop()`＝全体停止の経路）との違いは「誰が・
     * どの範囲を止めようとしたか」であり、`git merge --abort`は呼んでいない点は共通
     * （統合worktreeは衝突した状態のまま、Viewの「再マージ」で再開できる）。
     */
    | 'mergeStopTaskStopped'
    /**
     * 疑似worktree（design.md §16.20）の統合が衝突した。3-way mergeができないため、
     * 同じファイルへの変更は全て衝突になる（このタスクは`blocked`になる）。
     */
    | 'pseudoWorktreeConflict'
    /**
     * runの終了時、疑似worktreeの統合結果をワークスペースへ反映できなかった
     * （全部・一部を問わない）。反映まわりで人が見るべき事象はこのkindへ集約する:
     *
     * - 実行中にワークスペース側が変更されていたため反映せず中止した
     *   （design.md §16.20「人の編集を上書きしない」）
     * - マニフェストを復元できず、反映そのものを行わなかった（Issue #380）
     * - 途中で失敗し、一部だけが適用された（`partialApply`）
     * - 除外設定（`exclude`）に一致したエントリをスキップした（Issue #433）。反映自体は
     *   成功しているが、統合済みだった変更がワークスペースへ届いていない点は同じなので、
     *   黙って捨てず人に見せる
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
     * 生成したワークフロー（ゴール文からの生成・ロードマップからの生成のどちらも）の
     * タスク分解が、レビューセッションの4つの観点（並列にできるタスクが直列に
     * なっていないか／合流タスクがあるか／`done` が外から判定できるか／ゴールに対して
     * 過不足がないか）に照らして妥当でない可能性がある（design.md §16.28、roadmap W3、
     * Issue #337）。`planner.ts` の `reviewWorkflowPlan` が生成直後に検出し、
     * `plannerSecurity` と同じく生成直後のプレビュー（`previewDefinition`）でも出す。
     * **自動では直さない**（保存時の警告として出すだけ）。
     */
    | 'plannerReview'
    /**
     * 上流タスクより緩い `sandbox` / `autoApprove` を持つ下流タスクが、上流の応答
     * （`{{T1.result}}` / `{{T1.summary}}`）をテンプレート変数で参照している
     * （design.md §16.4「タスク間の引き継ぎ」、Issue #67）。`workflow.ts` の
     * `findPermissionEscalationWarnings` が読み込み時（`start()`）に検出する。
     */
    | 'permissionEscalation'
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
    | 'orchestratorPromptOverride'
    /**
     * `persist()`（実行状態の永続化、`store.update`）が失敗した（design.md §16.11、
     * Issue #364）。ログ（`deps.log.error`）だけでは拡張機能のログ出力チャンネルを
     * 開かない限り気づけないため、`reflectPseudoWorktree`（`pseudoWorktreeReflectBlocked`）
     * と同様に`live.warnings`へも積み、Viewから気づけるようにする（Issue #379）。
     * `persist()`は実行中に何度も呼ばれるため、同一runIdにつき直近1件へ丸める
     * （`taskId`は持たない警告なので`mergeBusy`・`orchestratorPromptOverride`の
     * 「同一taskIdの直近1件」ではなく「このrunの直近1件」に読み替える）。
     */
    | 'persistFailed'
    /**
     * 最終マージ（design.md §16.18「最終マージ」・§16.26、`finalMerge: orchestrator` /
     * `confirm`）の判断待ち・判断の確定を伝える。人の承認を挟まない（`orchestrator`）以上、
     * この警告が唯一の追跡手段になるため、判断待ちに入ったこと・確定した判断（`merge` /
     * `hold`）とその理由を必ずここへ残す（design.md §16.26の受入基準）。同一runにつき
     * 直近1件へ丸める（`orchestratorPromptOverride`と同じ規律。taskIdを持たない警告なので
     * `persistFailed`と同じく「このrunの直近1件」の意味になる）。
     */
    | 'finalMergeDecision'
    /**
     * ループが停滞したと判定されて自動的に止まった（design.md §16.27、Issue #336）。
     * タスク間メッセージングの待ちぼうけ（`messagingStalled`、design.md §16.21）とは
     * 別の機序（こちらは1タスクの応答そのものが同じ内容を繰り返している）のため、
     * 混同しないよう別のkindにする。状態は`maxReached`と同じく`deriveMaxReachedWarnings`
     * と対になる`deriveStalledWarnings`が`live.runState`から都度導出する（1回だけ積むと
     * ウィンドウのリロードで復元した実行では二度と出せない。`deriveAllowWarnings`と
     * 同じ理由）。
     */
    | 'loopStalled'
    /**
     * リロード・WSL再起動等からの復元直後、`reloadInterrupted`のタスクを`pending`へ戻して
     * 自動的に再開した（design.md §16.35、roadmap W10、Issue #584）。`message`に戻した
     * タスクidを列挙する。`persistFailed`・`finalMergeDecision`と同じく、同一runにつき
     * 直近1件へ丸める（taskIdを持たない警告のため）。
     */
    | 'autoResume'
    /**
     * 自動再開の対象ではあったが、`agent.workflows.maxAutoResumeAttempts`（既定3）に
     * 達していたため見送った（design.md §16.35、roadmap W10、Issue #584）。人がViewから
     * 手動で再実行するまでこのrunは`failed`のまま止まる。`autoResume`と同じく直近1件へ
     * 丸める。
     */
    | 'autoResumeLimitExceeded'
    /**
     * 自動再開の対象（`reloadInterrupted`のタスク）はあったが、他の理由による`failed`が
     * 混ざっている・`allow`確認が要るタスクが混ざっているため、run全体の自動再開を見送った
     * （design.md §16.35、roadmap W10、Issue #584。`applyAutoResume`の`blockedByOtherFailure`
     * / `blockedByAllowGate`）。`autoResumeLimitExceeded`と同じく、上限超過以外にも
     * 「自動では再開されなかった」ケースがあることをViewから区別できるようにするための警告
     * （レビュー指摘。2026-08-23。当初は既存のfailed/skipped表示で足りるとして省略していたが、
     * 受入基準「再開の試行が上限を超えたrunは理由がViewへ出る」とそろえ、見送った理由も
     * 同じ場所で分かるようにした）。直近1件へ丸める。
     */
    | 'autoResumeBlocked'
    /**
     * オーケストレーターが`add_task`で実行中の定義へ新しいタスクを加えた（design.md §16.29、
     * roadmap W4、Issue #338）。人の承認を挟まない以上、この警告が唯一の追跡手段になるため、
     * 追加したタスクのid・prompt・done・dependsOnを全文で残す。ウィンドウのリロード後は
     * 定義ファイル（YAML）から作り直されるため、追加したタスクは消える
     * （`orchestratorPromptOverride`と同じ「実行中の定義だけに効く」扱い）。
     */
    | 'orchestratorTaskAdded'
    /**
     * オーケストレーターが`remove_task`で`pending`のタスクを実行中の定義から取り除いた
     * （design.md §16.29、roadmap W4、Issue #338）。取り除いたタスクidと、依存を
     * 失った（`dependsOn`から取り除かれた）タスクidを全文で残す。
     */
    | 'orchestratorTaskRemoved'
    /**
     * オーケストレーターが`update_task_dependencies`で`pending`のタスクの`dependsOn`を
     * 差し替えた（design.md §16.29、roadmap W4、Issue #338）。変更前後の`dependsOn`を
     * 全文で残す。
     */
    | 'orchestratorDependenciesChanged'
    /**
     * リロードで復元するとき、永続化されたタスク状態と定義（YAML）を突き合わせた結果、
     * 一方にしか無いタスクがあった（design.md §16.29「リロード時の突き合わせ」、
     * レビューblocking指摘、2026-08-23）。
     *
     * - 永続データにだけあるタスク（`add_task`で加えたがYAMLには無い）は状態を落とす
     * - 定義にだけあるタスク（`remove_task`で消したがYAMLには残っている）は`pending`として補う
     *
     * どちらも黙って行うと「オーケストレーターが実行中に加えた・消したタスクは
     * リロードでYAML本来の内容へ戻る」という§16.29の主張が実際に成り立ったのか
     * Viewから確認できないため、突き合わせが実際に何かを変えたときだけ出す。
     */
    | 'reloadTaskDefMismatch'
    /**
     * 統合PR/MRにレビューコメントが付き、オーケストレーターへ通知した（design.md §16.30、
     * roadmap W5、Issue #339）。人の承認を挟まない以上、この警告が唯一の追跡手段になる
     * ため、投稿者・コメント本文を全文で残す（`orchestratorTaskAdded`と同じ流儀）。
     * オーケストレーターがこの通知を受けて`add_task`等で計画を組み替えた場合は、
     * その適用内容自体は`orchestratorTaskAdded`等の既存の警告が別途記録する
     * （この警告は「取り込んだこと」だけを記録し、「どう対応したか」までは持たない）。
     */
    | 'reviewCommentImported'
    /**
     * タスクの開始時のIssue起票（design.md §16.31「タスクの開始時にIssueを起票し、PR本文
     * から参照する」、roadmap W6、Issue #596）に失敗した。CLI・認証が無い環境でも起きうる
     * （`agent.workflows.createTaskIssue`が有効でも、`checkForgePrerequisites`が通った後の
     * 個別の`gh issue create`/`glab api`呼び出しが失敗することがある）。警告のみでrunは
     * 止めない（`forgeFailed`と同じ方針）。
     */
    | 'taskIssueFailed'
    /**
     * PR/MRを作った後、ローカルマージの前に読み取り専用の別セッションでレビューさせた結果
     * （design.md §16.31「PRを作ったあと、ローカルマージの前にレビューを1段挟む」、
     * roadmap W6、Issue #596）。指摘が見つかった場合と、レビューセッション自体の実行に
     * 失敗した場合の両方をこのkindへ集約する。`plannerReview`（design.md §16.28、ワークフロー
     * 分解のレビュー）と同じく**自動では直さない**（保存済みのPR/MRはそのまま、警告として
     * 出すだけ）。マージ自体はこの警告の有無に関わらず進む。
     */
    | 'taskPullRequestReview';
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
  /**
   * チームモードの役割（design.md §16.44、Issue #693）。`undefined` は役割なし。
   * ワークフローViewがタスクidと併記して出す（役割はidの代わりではない。同じ役割を
   * 複数のタスクへ割り当てられるため）。
   */
  role: TeamRole | undefined;
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
   * `mergeResolutionActive`が`true`のとき、その解決セッションがいま承認待ちか
   * （Issue #413 PR4）。`mergeResolutionActive`が`false`のときは常に`false`。
   * Viewはこれで「マージ解決中（承認待ち）」と「マージ解決中」（LLMが作業中）の
   * バッジを出し分ける。
   */
  mergeResolutionWaitingApproval: boolean;
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
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」・§16.26）の結果。試みていなければ
   * `undefined`（`finalMerge: pr-only`、統合PR/MRの作成に失敗、runがまだ終わっていない、
   * 最終マージの判断待ちの間、等）。`held`は`finalMerge: orchestrator`/`confirm`で
   * `hold`（マージしない）と判断が確定したことを表す（`undefined`＝「まだ何も試みていない」
   * とは区別する）。
   */
  finalMergeOutcome?: 'merged' | 'failed' | 'held' | undefined;
  /**
   * 最終マージの判断待ち（design.md §16.26、`finalMerge: orchestrator` / `confirm`）。
   * 統合PR/MRを作った後、マージするかどうかの判断が付くまでの間だけ存在する。
   * ウィンドウのリロードでは復元しない（`LiveRun.finalMergeDecision`のJSDoc参照。
   * `continuePromptOverride`と同じ「実行時のみの状態」）。
   */
  finalMergeDecision?:
    { mode: 'orchestrator' | 'confirm'; pullRequestUrl: string | undefined } | undefined;
  /**
   * オーケストレーターセッション（design.md §16.23「会話のUI」）の状態。ワークフローView
   * の「オーケストレーター」欄がこれを描く。セッションを開けなかったrun・リロードで復元した
   * runでは`available: false`（欄は「利用できません」になる）。
   */
  orchestrator?: OrchestratorSnapshot | undefined;
  /**
   * `ask_user`（design.md §16.33、Issue #583）の回答待ち。存在する間、ワークフローViewは
   * 問いと選択肢を出し、人が選ぶボタンを描く。`live`に無ければ永続化された値
   * （`PersistedRun.pendingAskUser`）へフォールバックする（`LiveRun.pendingAskUser`の
   * JSDoc参照。自動再開（design.md §16.35、roadmap W10、Issue #584）が走ればオーケストレーター
   * セッションを立て直して答える経路も復活する。走らなかった・見送った間は問いの文言だけが
   * 読める状態のまま）。
   * `hasLiveSession`が`false`のときはボタンを無効にする（`workflowScript.ts`）。
   */
  pendingAskUser?:
    | { question: string; choices: readonly string[]; hasLiveSession: boolean; answered: boolean }
    | undefined;
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
      /**
       * タスクの開始時にIssueを起票し、PR本文から参照するか（design.md §16.31、
       * roadmap W6、Issue #596）。`agent.workflows.createTaskIssue`。既定`false`
       * （既存の`per-task`の挙動を変えないため）。`pullRequest !== 'per-task'`のときは
       * PR/MR自体を作らないため、この設定が`true`でも起票しない（呼び出し側が
       * `shouldCreateTaskPullRequest`と合わせて判定する）。
       */
      createTaskIssue: boolean;
      /**
       * PR/MRを作った後、ローカルマージの前に読み取り専用の別セッションでレビューさせるか
       * （design.md §16.31、roadmap W6、Issue #596）。`agent.workflows.
       * reviewTaskPullRequest`。既定`false`。forgeの「人のレビューを待つ」方式ではなく、
       * `reviewWorkflowPlan`（design.md §16.28、roadmap W3）と同じ「別のエージェント
       * セッションを立てて読み取り専用でレビューさせる」方式を採る。結果は警告として
       * 記録するだけで、マージ自体はブロックしない。
       */
      reviewTaskPullRequest: boolean;
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
   * `waitingApproval`へ遷移した時刻（ms）。それ以外の状態では`undefined`（Issue #579、
   * design.md §16.39）。`runnerApproval.ts`の`scheduleTaskApprovalTimeout`／
   * `handleTaskApprovalTimeout`が使う。`MergeResolutionEntry.waitingApprovalSinceMs`
   * （衝突解決セッション用）と同じ名前・同じ役割だが別物（対象が`live.tasks`か
   * `live.mergeResolutions`かの違い）。
   */
  waitingApprovalSinceMs: number | undefined;
  /**
   * `waitingApprovalSinceMs`が変わるたび（承認待ちに入る・抜ける）に`runnerApproval.ts`の
   * `scheduleTaskApprovalTimeout`が張り直す`setTimeout`のハンドル（`MergeResolutionEntry.
   * approvalTimeoutTimer`と同じ形）。承認待ちで**ない**間、またはタイムアウト自体が
   * 消費された後は`undefined`。
   */
  taskApprovalTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * このタスクが承認待ちタイムアウト（`agent.workflows.taskApprovalTimeoutSec`）で
   * 自動停止されたかどうかの印（Issue #579、design.md §16.39）。`TaskSession.stopLoop()`は
   * 理由を`'taskStopped'`としてしか`onFinished`へ伝えられないため、`onTaskFinished`は
   * この印を見て`applyLoopStopReason(..., 'taskStopped')`（＝`manualStop`）ではなく
   * `markTaskApprovalTimedOut`へ分岐する（`MergeResolutionEntry.timedOutByApprovalTimeout`
   * と同じ理由・同じ形）。
   */
  taskApprovalTimedOut: boolean;
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
  /**
   * `ask_user`（design.md §16.33、Issue #583）をこのrunで受け付けた（`accepted: true`を
   * 返した）回数。`agent.workflows.maxAskUserPerRun`との比較に使う。拒否した呼び出しは
   * 数えない（乱発ではなく実際に人を待たせた回数を数えるため）。
   */
  askUserCount: number;
}

/**
 * `live.mergeResolutions`の値（Issue #413 PR4・PR5）。
 *
 * `waitingApprovalSinceMs`は、その解決セッションがいま承認待ちかどうかの印であり、
 * 承認待ちで**ない**間は`undefined`。`runnerMerge.ts`の`startMergeResolution`が
 * `session.onStateChanged`（`state.approvals.length > 0`）を見て更新する。PR4時点では
 * 「承認待ちかどうか」（`!== undefined`）としてしか使っていなかったが、PR5からは
 * `approvalTimeoutTimer`の起点（経過時間の計算）としても使う。
 */
export interface MergeResolutionEntry {
  session: TaskSession;
  waitingApprovalSinceMs: number | undefined;
  /**
   * 承認待ちのアイドルタイムアウト（`agent.workflows.mergeApprovalTimeoutSec`、
   * Issue #413 PR5）用に張った`setTimeout`のハンドル。`waitingApprovalSinceMs`が変わる
   * （承認待ちに入る・抜ける）たびに`runnerMerge.ts`が張り直す。承認待ちで**ない**間、
   * または解決セッションそのものが終わった後は`undefined`。
   *
   * ポーリング（`setInterval`。`runnerMessaging.ts`の`waitingReplyPollTimer`と同じ形）
   * ではなくエントリごとの`setTimeout`にしてあるのは、衝突解決セッションが
   * `live.messaging`（タスク間メッセージング。省略可能）とは無関係に発生するため
   * （design.md §16.21のポーリングタイマーへ相乗りすると、メッセージングを使わない実行で
   * タイムアウトが一切効かなくなる）。
   */
  approvalTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * このセッションが承認待ちタイムアウトで自動停止されたかどうかの印（Issue #413 PR5）。
   *
   * `TaskSession.stopLoop()`は理由を`'taskStopped'`としてしか`onFinished`へ伝えられない
   * ため、`runnerMerge.ts`の`finishMergeResolution`は`reason === 'taskStopped'`だけでは
   * 「人が`WorkflowRunner.stop()`（全体停止）を押した」のか「このセッションだけが承認待ち
   * タイムアウトで自動的に止まった」のかを区別できない。両者は扱いが異なる:
   * 前者は既存の非破壊分岐（Issue #443）どおりrun全体を`haltedByUser`にする。後者は
   * このタスク**だけ**を`blocked`にし、run全体は止めない（他の`pending`タスクは
   * 通常どおり開始してよい）。この印を`finishMergeResolution`が読んで分岐を切り替える。
   */
  timedOutByApprovalTimeout: boolean;
  /**
   * `WorkflowRunner.stopTask()`が、このタスク単体を狙って`stopLoop()`を呼んだ印。
   *
   * `stopTask()`はオーケストレーターの`stop_task`（design.md §16.23、Issue #514）と
   * ワークフローViewの「タスク停止」ボタン（`src/view/workflowScript.ts`。`merging`タスクへの
   * 表示はIssue #514で意図的に追加された）の**共通の入口**で、呼び出し元は区別されない。
   * `timedOutByApprovalTimeout`と同じ理由で必要になる。`TaskSession.stopLoop()`は理由を
   * `'taskStopped'`としてしか`onFinished`へ伝えられないため、`runnerMerge.ts`の
   * `finishMergeResolution`は`reason === 'taskStopped'`だけでは「人が
   * `WorkflowRunner.stop()`（全体停止）を押した」のか「`stopTask()`経由でこのタスク
   * だけを止めた」のかを区別できない。前者はrun全体を`haltedByUser`にする
   * （`applyLoopStopReason`）。後者はこのタスク**だけ**を`blocked`にし、run全体は
   * 止めない（他の`pending`タスクは通常どおり開始してよい）。区別しないと、
   * `stop_task`または「タスク停止」ボタンが`merging`のタスクを止めただけで無関係な
   * 他タスクへの`retry_task`/`continue_task`/`decide_approval`まで「人が全体を停止した」
   * という偽の理由で拒否されてしまう（Issue #514）。
   *
   * `WorkflowRunner.stopTask`が`live.mergeResolutions`側へ`stopLoop()`を送る直前に立てる。
   * `WorkflowRunner.stop()`（全体停止）からの`stopLoop()`はこのフラグを立てない
   * （引き続き`false`のまま送るため、既存の`mergeInterrupted`分岐へ合流する）。
   */
  stoppedByStopTask: boolean;
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
  /**
   * `notifyOrchestratorRunFinished`を送り済みかどうか（design.md §16.5・§16.43、
   * Issue #432-2、Issue #491）。
   *
   * `finished`は`retryMerge`/`retryTask`/`continueTask`が再開の起点として`false`へ戻すため、
   * run全体が再び終了状態へ確定すると終了ブロックの2周目が走りうる。
   *
   * **この旗が絞っているのは終了通知だけである。**同じ関数
   * （`closeMessagingIfFinalMergeSettled`）が呼ぶ`closeMessaging`/`closeReviewCommentPoll`は
   * それ自体が冪等なので旗を見ておらず、2周目でも毎回呼ばれる。
   *
   * **`notifyOrchestratorRunResumed`（§16.43、Issue #491）が再開を伝えるときだけ`false`へ
   * 戻す。**#432-2 は「一度立てたら戻さない」としていたが、それは**再開を伝える経路が
   * 無かった当時に、2度目の「終了しました」だけが唐突に届くのを避ける判断**だった。
   * 再開通知が入って前提が変わったため、§16.43 がその判断を明示的に置き換えている
   * （`runner.test.ts`の「run終了処理の回数」describe参照。受入基準3件を書き換えた）。
   *
   * 逆に、**通知以外の理由でここを戻してはいけない。**戻す条件は「再開を伝えたとき」だけで、
   * 終了ブロックが2周目を走ること自体は戻す理由にならない（それが#432-2の塞いだ形である）。
   */
  finishedNotified: boolean;
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
        /**
         * ワークスペースの直近の既知の状態。`resolvePseudoState`が実行開始時／復元時に
         * 一度取ったスナップショットで初期化されるが、その後は固定ではない。
         * `reflectPseudoWorktree`がワークスペースへの反映に成功する（一部適用を含む）
         * たびに、反映後の実際の状態へ更新する（Issue #511）。反映を拒否した
         * （`workspaceChanged`）場合は更新しない。書き込みが起きていないため、
         * 拒否した人の編集を「自分が書いた状態」として取り込むと、以後その編集を
         * 検知できなくなってしまう。
         */
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
   *
   * 解放は`closeMessaging`（`runnerMessaging.ts`）に一本化してある。run終了時と
   * 拡張機能の終了時（`dispose()`）の両方から呼ばれ、閉じた時点でこのフィールドは
   * `undefined`へ戻る（二重解放を防ぐ印を兼ねる。Issue #374）。
   */
  messaging:
    | {
        hub: TaskMessagingHub;
        transport: HttpMcpTransportHandle;
        waitingReplyPollTimer: ReturnType<typeof setInterval>;
      }
    | undefined;
  /**
   * `messaging.hub`と同じインスタンスを、`messaging`が`closeMessaging`で`undefined`へ
   * 戻った後も持ち続けるための参照（Issue #475）。
   *
   * `ensureMessaging`（`retryTask` / `retryMerge`成功後の`pending`再開が通る
   * `prepareTaskLaunch`の単一チョークポイント）が、run終了後にメッセージングを
   * 立て直すとき、ここに残っている`hub`があればそれを再利用し、無ければ新規に作る。
   * hubを作り直すと`MAX_MESSAGES_PER_RUN`（500件）のカウンタと未配送キューが
   * リセットされ、「run全体で500件」という上限が再開のたびに緩んでしまうため、
   * transport・タイマーだけを`closeMessaging`/`ensureMessaging`で開け閉めし、
   * hub自体は同じrunが`this.runs`に残っている間ずっと生かす。
   *
   * ウィンドウのリロード後に復元した実行（`rebuildLiveRun`）では`undefined`のまま
   * 始まる。復元はこのプロセスでまだhubを作っていないため再利用のしようがなく、
   * `ensureMessaging`が最初の`retryTask`等で新規に作る（`messaging: undefined`と
   * 同じ「無くても実行は止めない」設計）。
   */
  messagingHub: TaskMessagingHub | undefined;
  /**
   * `ensureMessaging`の多重起動を防ぐための進行中Promise（Issue #475）。
   *
   * 再マージ成功で複数の`pending`タスクが一斉に`pump()`される経路（`markMergeSucceeded`が
   * 後続を`pending`へ戻す）では、`prepareTaskLaunch`が同じtickで複数回呼ばれうる。
   * `ensureMessaging`は`await`を挟むため、進行中のセットアップを待たずに後続の呼び出しが
   * 素通りすると、MCPサーバ（`startTransport`）とポーリングタイマーが二重に立ってしまう。
   * ここへ進行中のPromiseを積み、後続の呼び出しはそれを待つだけにする。
   */
  messagingSetupInFlight: Promise<void> | undefined;
  /**
   * `startMessagingTransport`がMCPサーバの起動に失敗して警告を出した回数（Issue #475/
   * PR #495レビュー指摘: low〜medium）。`MAX_MESSAGING_STARTUP_WARN_COUNT`を超えたら
   * 個別の警告ログを止める。`messaging.ts`の`dispatchErrorLogCount`と同じ理由で、
   * runが生きている間ずっと引き継ぐ必要があるため`live`（`messagingHub`と同様、
   * `ensureMessaging`の再構築をまたいで残るフィールド）へ持たせる。
   */
  messagingStartupWarnCount: number;
  /**
   * 統合PR/MRのレビューコメント取得（design.md §16.30、roadmap W5、Issue #339）のポーリング
   * タイマーと、既に通知した（重複通知を避けるための）コメントidの集合。統合PR/MRの作成に
   * 成功し、かつ`agent.workflows.reviewCommentPollIntervalSec`が0でないときだけ`finalizeForge`が
   * 作る。`messaging.waitingReplyPollTimer`と同じく`.unref()`しているためテスト・プロセス
   * 終了を妨げない。最終マージ・判断が確定した時点（`closeMessagingIfFinalMergeSettled`）と
   * `dispose()`の両方で閉じる（`messaging`と同じ「もう見なくてよくなったら閉じる」設計）。
   */
  reviewCommentPoll:
    | {
        timer: ReturnType<typeof setInterval>;
        seenCommentIds: Set<string>;
        host: ForgeHost;
        cwd: string;
        number: number;
      }
    | undefined;
  /**
   * 衝突解決セッション（design.md §16.17「コンフリクト」5.「解決用セッションは依存グラフの
   * ノードにはしない」）。`live.tasks`（グラフのノード＝通常のタスク）とは別に持つ。
   * taskIdをキーにする（1タスクにつき同時に1件のマージしか走らない）。
   *
   * 値は`TaskSession`単体ではなく`MergeResolutionEntry`（Issue #413 PR4）。承認待ちの
   * 可視化（Viewのバッジ出し分け）と、`maxParallel`の枠から承認待ちの解決セッションを
   * 除外する判定（`pump`→`nextTasksToStart`の`excludeFromActiveCount`）の両方に、
   * 「いま承認待ちか」を持ち回る必要があるため。
   */
  mergeResolutions: Map<string, MergeResolutionEntry>;
  /**
   * タスクの開始時に起票したIssueの番号（design.md §16.31「タスクの開始時にIssueを起票し、
   * PR本文から参照する」、roadmap W6、Issue #596）。taskIdをキーにする。`expandedPrompt`等
   * と同じく表示・追跡専用でworkspaceStateへは永続化しない（`live`が生きている間だけ、
   * 同じtaskIdへ二重に起票しないための記録。`retryTask`でも同じ番号を使い回す）。
   * リロード後（`rebuildLiveRun`）は空のMapへ戻るため、リロードを挟んで`retryTask`すると
   * 再度起票しうる（既知の制約。design.mdに記載）。
   */
  createdTaskIssues: Map<string, number>;
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
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」・§16.26）の結果。`finalizeForge`
   * （`auto`）・`decideFinalMerge`（`orchestrator`/`confirm`）で書き込む。試みていなければ
   * `undefined`。`held`は`hold`（マージしない）と判断が確定したことを表す。
   */
  finalMergeOutcome: 'merged' | 'failed' | 'held' | undefined;
  /**
   * 最終マージの判断待ち（design.md §16.26、`finalMerge: orchestrator` / `confirm`）。
   * `beginFinalMergeDecision`が立て、`decideFinalMerge`が判断の確定と同時に消す。
   *
   * **ウィンドウのリロードでは復元しない**（`rebuildLiveRun`は常に`undefined`で始める）。
   * `LiveRun`の他の実行時専用の値（`continuePromptOverride`・`live.warnings`自体も
   * 永続化されない）と同じ扱いで、リロード後に判断待ちだったPR/MRは人がホスト側
   * （GitHub/GitLab）で直接確認する必要がある（design.md §16.26「永続化」）。
   */
  finalMergeDecision: LiveFinalMergeDecision | undefined;
  /**
   * `ask_user`（design.md §16.33、Issue #583）の回答待ち。オーケストレーターが呼んでから、
   * 人がワークフローViewで選ぶまでの間だけ存在する。`beginAskUser`（`runnerOrchestrator.ts`）が
   * 立て、`answerAskUser`が答えの確定と同時に消す。
   *
   * **`finalMergeDecision`とは異なり、値そのもの（question/choices）を永続化する**
   * （`WorkflowRunner.persist`・`PersistedRun.pendingAskUser`）。`finalMergeDecision`が
   * 永続化しないのは、判断対象（統合PR/MR）をホスト側で直接確認できるからだが、`ask_user`の
   * 問いにはそれに相当する外部記録が無い。ロードマップW10（中断からの自動再開、design.md
   * §16.35、Issue #584）が「`ask_user`待ちで落ちた場合は再開時に問いを出し直す」ために
   * 必要な最小限のデータとして、この節（W8）で先に永続化しておいた。**ただし
   * `live.pendingAskUser`自体（実行時の値）は、ウィンドウのリロード直後（`rebuildLiveRun`が
   * 復元した直後）にはまだ復元しない**（`orchestrator`セッション自体が復元できない以上、
   * 答えを届ける先が無いため。`finalMergeDecision`と同じ「実行時のみ」の扱い）。永続化された
   * 値は`WorkflowRunSnapshot.pendingAskUser`が`persisted`側からも読むため、リロード直後の
   * Viewにも「問いが残っている」ことは表示できる。**自動再開（`runnerRestore.ts`の
   * `autoResumeIfEligible` → `setupOrchestratorForStart`）が走ると、新しいオーケストレーター
   * セッションを立てる際に永続化された問いから`live.pendingAskUser`を作り直し、答える経路が
   * 復活する**（`hasLiveSession: true`に戻る。`buildPendingAskUserSnapshot`参照）。自動再開が
   * 見送られた（`haltedByUser`・他の失敗・上限超過等）場合は、従来どおり問いの文言だけが
   * 読める状態のまま残る。
   */
  pendingAskUser: LiveAskUser | undefined;
}

/** `LiveRun.finalMergeDecision`（design.md §16.26）。判断が付くまでの間だけ存在する。 */
export interface LiveFinalMergeDecision {
  /** どちらが判断するか。`orchestrator`だけがタイムアウトを持つ（`timer`参照）。 */
  readonly mode: 'orchestrator' | 'confirm';
  /** 判断待ちに入った時刻（ms epoch）。デバッグ・将来の表示用に持つ（現状はUIへ出さない）。 */
  readonly since: number;
  /**
   * `mode: 'orchestrator'`のときだけ張るタイムアウトタイマー
   * （`agent.workflows.finalMergeDecisionTimeoutSec`秒後に自動`hold`）。`decideFinalMerge`が
   * 判断の確定時に必ず`clearTimeout`する。`mode: 'confirm'`では張らない
   * （人はいつ確認するか分からないため、タイムアウトで自動`hold`にする理由が無い）。
   */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * `LiveRun.pendingAskUser`（design.md §16.33、Issue #583）。`ask_user`の回答待ちの間だけ
 * 存在する。`choices`は呼び出し時の文言をそのまま保持する（テンプレート展開はしない。
 * `update_task_prompt`と同じ「オーケストレーターの自由記述はリテラルのまま扱う」方針）。
 */
export interface LiveAskUser {
  readonly question: string;
  readonly choices: readonly string[];
  /** 回答待ちに入った時刻（ms epoch）。 */
  readonly since: number;
  /**
   * 人が選んだ答え（`answerAskUser`が設定する）。**まだオーケストレーターへは送っていない。**
   * `ask_user`のツール呼び出しはオーケストレーターのターンの最中に届くため、`answerAskUser`が
   * 呼ばれた時点で`orchestrator.busy`がまだ`true`のことがある。走行中のターンへ割り込んで
   * `session.send`すると送信が失われかねない（`sendOnce`は送信失敗を投げ直さない）ため、
   * ここへ保持しておき、ターンが終わってから`deliverAskUserAnswer`（`runnerOrchestrator.ts`）が
   * まとめて送る。`undefined`は「まだ答えていない」、値ありは「答えた・配送待ち」を表す
   */
  answeredChoice?: string;
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

/**
 * `onChanged` の最小限のpub-sub。VSCodeの `EventEmitter` には依存しない（design.mdの方針どおり）。
 * **`fire` は登録された順序どおりに、同期でリスナを呼ぶ。** リスナ本体が非同期処理を`await`する場合、
 * そのリスナより後に登録された別の購読者は、その非同期処理が完了する前の状態を読むことになる
 * （`programRunner.ts`のJSDoc・design.md §16.37.3のレビュー指摘F1、Issue #606参照。#605のF1と
 * 同じ機序が2回現れたため、この契約をここへ明記した）。
 */
export class SimpleEmitter<T> {
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

/**
 * `WorkflowRunner.dispose()`の解放を1件ずつ包む（Issue #374）。
 *
 * 拡張機能の終了時の後始末なので、1つの解放が投げてもそこで打ち切らず残りを続ける。
 * 打ち切るとCLIの子プロセスやlisten中のソケットが取り残される。失敗はログに残すだけで
 * 呼び出し側へは伝えない（`dispose()`の呼び出し元はVSCodeのdeactivateで、投げ返しても
 * できることが無い）。
 */
function disposeQuietly(log: Logger, release: () => void, label?: string): void {
  try {
    release();
  } catch (e) {
    const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
    const where = label === undefined ? '' : `（${label}）`;
    log.warn(`[workflow] 終了時の解放に失敗しました${where}: ${message}`);
  }
}

/**
 * 最終マージの判断待ち・判断確定を伝える警告を積む（design.md §16.26）。
 *
 * `orchestratorPromptOverride`と同じく、同一runにつき直近1件へ丸める（`finalMergeDecision`
 * 警告の呼び出し回数だけ際限なく積まれるのを防ぐ。taskIdを持たない警告なので
 * `persistFailed`と同じ「このrunの直近1件」の意味になる）。「判断待ちに入った」→
 * 「判断が確定した」の2回積まれるが、丸め込みにより最終的に残るのは確定後の1件で、
 * 判断の内容と理由（受入基準）は必ず最後に残る。
 */
function pushFinalMergeWarning(live: LiveRun, message: string): void {
  live.warnings = live.warnings.filter((w) => w.kind !== 'finalMergeDecision');
  live.warnings.push({ kind: 'finalMergeDecision', taskId: undefined, message });
}

/**
 * `TaskMessagingHubDeps.handoff`（`messaging.ts`、design.md §16.44、Issue #693）の実体を
 * 組み立てる。`TeamHandoffStore`（`teamHandoff.ts`）の`write`/`read`/`list`/`remove`は
 * いずれも第1引数に`runId`を取るが、`HandoffPort`は`runId`を持たない薄い形（`messaging.ts`
 * がVSCode非依存・run単体の関心事だけを扱う方針を保つため）なので、ここで`runId`を
 * 束縛したクロージャに変換する。`buildOrchestratorControlPort`（`runnerOrchestrator.ts`）が
 * `WorkflowRunner`の公開メソッドをそのまま橋渡しするのと同じ「実体は既存クラスの
 * メソッドをそのまま呼ぶ」方針で、ここにも新しいロジックは持たせない。
 */
function buildHandoffPort(repoRoot: string, runId: string): HandoffPort {
  const store = new TeamHandoffStore(repoRoot, nodeHandoffFileSystem);
  return {
    write: (taskId, slug, content) => store.write(runId, taskId, slug, content),
    read: (taskId, slug) => store.read(runId, taskId, slug),
    list: () => store.list(runId),
    remove: (taskId, slug) => store.remove(runId, taskId, slug),
  };
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
   * `dispose()`が始まった印（Issue #374のレビュー指摘high）。
   *
   * `TaskSession.dispose()`は実装（`chatManagerBase.ts`の`teardown()`）が
   * `loop.stop('manual')`を先に呼ぶため、走行中のタスクを解放すると`onFinished`が
   * `manual`で**同期的に**発火する。`live.finished`は`pump()`が次のタスクを始めないための
   * 印でしかなく、`onTaskFinished`自体の再入は止められない。素通しすると
   * `applyLoopStopReason('manual')`がrun全体を「人が手動停止した」ことにして
   * （未着手の`pending`は全て`skipped`）永続化してしまい、deactivateしただけの実行が
   * 次の起動で続きから進まなくなる。同じ理由で`runnerMerge.ts`の`finishMergeResolution`
   * （衝突解決セッションの解放が呼び戻す）も黙らせる（`WorkflowRunnerInternals.isDisposing`）。
   * `blockMergeAfterLeaseWait`（`releaseAllLeases()`が起こす順番待ち）にも同じガードを
   * 置いてあるが、こちらは実際には効いていない多層防御（レビュー3周目のmedium）:
   * `dispose()`は`live.finished`を全runぶん立て終えてから`releaseAllLeases()`を1回呼び、
   * 起こされた側の継続はマイクロタスクなので、破棄由来の待機起こしは`decideAfterLeaseWait`が
   * `live.finished`を見て必ず`skip`へ倒す（`blockMergeAfterLeaseWait`のコメント参照）。
   * それでも`blocked`確定が後戻りできない書き換えである以上、判定条件が将来変わったときの
   * 保険として残してある。**`persist()`の入口で止める形は採らない**: キュー待ちのpersistには
   * 効かず、破棄直前に確定した値（PRのURL・マージ成功）まで落とすため（`persist()`のコメント参照）。
   *
   * 一度立てたら下ろさない。`dispose()`の後にこのrunnerを使い続ける経路は無い
   * （VSCodeのdeactivate時にだけ呼ばれる）。再入を印で黙らせる形は、衝突解決セッションの
   * `abandoned`（`runnerMerge.ts`、Issue #412のレビュー指摘D）と同じ考え方。
   */
  private disposing = false;

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
      isDisposing: () => this.disposing,
      notify: (runId) => this.notify(runId),
      pump: (runId) => this.pump(runId),
      persist: (runId) => this.persist(runId),
      resolveForgeState: (repoRoot) => this.resolveForgeState(repoRoot),
      cleanupWorktreeIfNeeded: (live, task, taskId, liveTask) =>
        this.cleanupWorktreeIfNeeded(live, task, taskId, liveTask),
      ensureMessaging: (runId, live) => this.ensureMessaging(runId, live),
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
   * タスク間メッセージング（design.md §16.21）を、生きていなければ立てる（Issue #475）。
   * 省略可能（`WorkflowRunnerDeps.messaging`のJSDoc参照）。MCPサーバの起動に失敗しても
   * 実行は止めない。
   *
   * **冪等**: `live.messaging`が既に生きていれば何もしない。
   *
   * **`prepareTaskLaunch`の`registerTask`直前という単一のチョークポイントから呼ぶ**
   * （`start()`からも呼ぶが、これは最初のタスクが`prepareTaskLaunch`へ届くより前に
   * オーケストレーターセッション（`setupOrchestratorForStart`）が接続用URLを要求するため。
   * `live.messaging`が既に生きていれば以降は何もしないので二重には立たない）。
   * `retryTask` / `continueTask` / `retryMerge`へ個別に呼び出しを足さない。新しい
   * セッションを開く経路は必ず`prepareTaskLaunch`を通るため、呼び出し漏れが構造的に
   * 起きない。`continueTask`（生きているセッションへ`runLoop`を掛け直すだけ）は
   * `prepareTaskLaunch`を経由しないため対象外（design.md「MCP URLは差し替えられない」、
   * Issue #475の調査コメント参照）。
   *
   * **hubは捨てず、`live.messagingHub`にあれば再利用する。** transportとタイマーだけを
   * 立て直す。作り直すと`MAX_MESSAGES_PER_RUN`（500件）のカウンタと未配送キューが
   * リセットされ、「run全体で500件」という上限が再開のたびに緩む。
   *
   * **同時に複数タスクが起動する経路（再マージ成功で複数の`pending`が一斉に`pump()`
   * される）でも二重に立てない。** `live.messagingSetupInFlight`へ進行中のPromiseを積み、
   * 後続の呼び出しはそれを待つだけにする。
   */
  private async ensureMessaging(runId: string, live: LiveRun): Promise<void> {
    // 破棄中・破棄後は新規に立てない（Issue #475/PR #495レビュー指摘: high）。
    // `dispose()`が完了した後に、それより前から`await`で止まっていた`startTask`の
    // 継続（`resolveWorkingDirectory`等の`await`点）がここへ届くことがある。
    // `this.runs`からrunを消す経路が無いため、`live`は`dispose()`後も解決できてしまい、
    // 入口を守らないと生きたままの`live.messagingHub`を再利用しつつ新しいHTTPリスナーと
    // タイマーを立ててしまう。`dispose()`は二度と呼ばれないため、この資源を閉じる経路が
    // 無くなる（Issue #374が塞いだのと同じ形のリーク）。`onTaskFinished`
    // （`this.disposing`のJSDoc参照）と同じ作法に揃える
    //
    // ここで早期returnしてもメッセージング資源が立たないだけで、`prepareTaskLaunch`は
    // 呼び出し元（`startTask`）へそのまま戻り、CLIセッションの起動自体はここでは
    // 止まらない（Issue #502）。その継続を止める番人は`startTask`側の
    // `host.openTaskSession`直前に置いた（`this.disposing`のJSDoc・`startTask`内の
    // コメント参照）。ここはあくまでメッセージング資源だけを守る
    if (this.disposing) {
      return;
    }
    const messaging = this.deps.messaging;
    if (messaging === undefined || live.messaging !== undefined) {
      return;
    }
    if (live.messagingSetupInFlight !== undefined) {
      await live.messagingSetupInFlight;
      return;
    }
    const setup = this.startMessagingTransport(runId, live, messaging);
    live.messagingSetupInFlight = setup;
    try {
      await setup;
    } finally {
      live.messagingSetupInFlight = undefined;
    }
  }

  /** `ensureMessaging`の実処理。hubの再利用・transport/タイマーの起動・失敗時の警告ログを行う。 */
  private async startMessagingTransport(
    runId: string,
    live: LiveRun,
    messaging: WorkflowRunnerMessagingDeps,
  ): Promise<void> {
    const hub =
      live.messagingHub ??
      new TaskMessagingHub({
        listRunTasks: () => buildRunTaskSnapshots(this.internals, runId),
        onAccepted: (message) => onMessageAccepted(this.internals, runId, message),
        // オーケストレーター専用の接続にだけ見せる制御ツール（design.md §16.23）。
        // Viewのボタンと同じ公開メソッド（`this`）を通す
        orchestratorControl: buildOrchestratorControlPort(this.internals, this, runId),
        // ファイル受け渡し（design.md §16.44、Issue #693）。`TeamHandoffStore`の`runId`引数を
        // ここで束縛し、`HandoffPort`（`taskId`/`slug`だけを引数に取る薄い口）にして渡す
        // （`messaging.ts`の`TaskMessagingHubDeps.handoff`のJSDoc参照）。`live.repoRoot`は
        // ワークフロー定義ファイルが属するワークスペースフォルダの絶対パスで、run開始時に
        // 一度だけ解決済みの値（`startRun`のJSDoc参照）をそのまま使う
        handoff: buildHandoffPort(live.repoRoot, runId),
      });
    live.messagingHub = hub;
    try {
      // dispatch例外の記録先（Issue #375）。`log.ts`はVSCode APIへ依存するため、
      // `messaging.ts`（VSCode非依存方針）へは直接渡さず最小限のportで包む
      const logPort: DispatchErrorLogPort = { error: (message) => this.deps.log.error(message) };
      const transport = await messaging.startTransport(hub, logPort);
      // `await`の間に`dispose()`が走り抜ける窓がある（Issue #475/PR #495レビュー指摘:
      // high）。ここで立て終えたtransportを`live.messaging`へ渡す前にもう一度確認し、
      // 破棄済みなら誰にも参照させずその場で閉じる。渡してしまうと、二度と呼ばれない
      // `dispose()`/`closeMessaging`に代わってこのHTTPリスナーとタイマーを閉じる経路が
      // 無くなる
      if (this.disposing) {
        disposeQuietly(
          this.deps.log,
          () => void Promise.resolve(transport.close()).catch(() => undefined),
          `messaging(disposed during startup) ${runId}`,
        );
        return;
      }
      const waitingReplyPollTimer = setInterval(
        () => checkWaitingReplyStalls(this.internals, runId),
        WAITING_REPLY_POLL_INTERVAL_MS,
      );
      waitingReplyPollTimer.unref?.();
      live.messaging = { hub, transport, waitingReplyPollTimer };
    } catch (e) {
      this.warnMessagingStartupFailure(runId, live, e);
    }
  }

  /**
   * MCPサーバの起動失敗警告を、runにつき`MAX_MESSAGING_STARTUP_WARN_COUNT`件までに丸める
   * （Issue #475/PR #495レビュー指摘: low〜medium）。`ensureMessaging`は`live.messaging`が
   * `undefined`である限りタスク起動のたびに再試行するため、MCPサーバが恒常的に起動できない
   * 環境では同じ警告がタスク数・retry回数に比例して無制限に増える。`messaging.ts`の
   * `logDispatchError`（Issue #375、PR #488）と同じ規律（件数上限＋抑制中の集計ログ）に揃える。
   * 再試行そのものは止めない（環境が回復すれば次の`ensureMessaging`呼び出しで普通に繋がる）。
   */
  private warnMessagingStartupFailure(runId: string, live: LiveRun, e: unknown): void {
    live.messagingStartupWarnCount += 1;
    const count = live.messagingStartupWarnCount;
    if (count <= MAX_MESSAGING_STARTUP_WARN_COUNT) {
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.warn(
        `[workflow ${runId}] MCPサーバの起動に失敗したため、タスク間メッセージングなしで実行します: ${message}`,
      );
      if (count === MAX_MESSAGING_STARTUP_WARN_COUNT) {
        this.deps.log.warn(
          `[workflow ${runId}] MCPサーバ起動失敗の警告記録が上限（${MAX_MESSAGING_STARTUP_WARN_COUNT}件）に` +
            '達したため、このrunではこれ以降、個別の記録を抑制します（再試行自体は続けます）',
        );
      }
      return;
    }
    const suppressedCount = count - MAX_MESSAGING_STARTUP_WARN_COUNT;
    if (suppressedCount % MESSAGING_STARTUP_WARN_SUPPRESSION_INTERVAL === 0) {
      this.deps.log.warn(
        `[workflow ${runId}] MCPサーバ起動失敗の警告記録は抑制中です（このrunで抑制開始以降 ` +
          `${suppressedCount}件発生）`,
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
      finishedNotified: false,
      warnings,
      integration,
      forge,
      branchNaming,
      draftPullRequest,
      pseudo,
      messaging: undefined,
      messagingHub: undefined,
      messagingSetupInFlight: undefined,
      messagingStartupWarnCount: 0,
      reviewCommentPoll: undefined,
      mergeResolutions: new Map(),
      createdTaskIssues: new Map(),
      orchestrator: undefined,
      orchestratorSeenStates: new Map(),
      integrationPullRequest: undefined,
      finalMergeOutcome: undefined,
      finalMergeDecision: undefined,
      pendingAskUser: undefined,
    };
    this.runs.set(runId, live);

    await this.ensureMessaging(runId, live);
    // オーケストレーターセッション（design.md §16.23）。MCPサーバ（上の
    // `ensureMessaging`）の後に開くのは、制御ツール用の接続URLをそこから
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
   *
   * **衝突解決セッション（`live.mergeResolutions`、design.md §16.17「コンフリクト」5.）にも
   * 同じく `stopLoop()` を送る。** 統合worktreeで開く衝突解決セッションは `live.tasks` の
   * 管理下に無いため、ここへ含めないとissue #322が問題視した「停止ボタンを押しても指示が
   * 送られ続ける」状態が衝突解決セッションについてだけ残ってしまう（issue #381）。
   * `stopLoop()` は衝突解決セッションでも `LoopStopReason: 'taskStopped'` で
   * `onFinished` を呼び、`runnerMerge.ts` の `onMergeResolutionFinished` へ合流する。
   * そちらは `reason === 'done'` かつgit上も解決済みのときだけ `done` にする。
   * **`'taskStopped'` ではマージを巻き戻さない**（issue #434）。人が統合worktreeで解いている
   * 途中の未コミットの解決結果を `git merge --abort` が破棄してしまい、復旧手段が無いため。
   * タブへの直接介入（`'manual'` / `'interrupted'`）と同じ非破壊の経路へ合流するが、タスクを
   * `merging` のまま残しはしない。**`blocked` へ確定させ、統合worktreeの占有だけを解放する**
   * （issue #443・案A）。`merging` のまま残すと `getRunOutcome` が `running` を返し続け、
   * run が終了確定せず「再マージ」（`blocked` からしか動かない）の対象にもならない行き止まりに
   * なるため。`git merge --abort` は呼ばないため、巻き戻していない事実は `mergeInterrupted`
   * 警告（`live.warnings`）で伝える。
   */
  stop(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    // `manual` / `interrupted` の遷移はtaskIdを使わない（実装上の事実。runState.ts参照）ため
    // 空文字で十分だが、意図を示すため定数として明示しておく
    const NO_SPECIFIC_TASK = '';
    // `applyLoopStopReason`で書き換える前の値を見ておく。`stop()`は複数回呼ばれ得る
    // （Webviewの`stopAll`は`haltedByUser`の現在値を見ずに毎回呼ぶ）ため、既に停止済みの
    // runへ何度呼んでも通知イベントが積み増されないよう、false→trueへ遷移した回だけ通知する
    const wasHaltedByUser = live.runState.haltedByUser;
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
    // 衝突解決セッションは`live.tasks`に無い別枠の管理（`revealTask`と同じ扱い）のため、
    // 上のフィルタには乗らない。生きているものへ全て送る（対象は`merging`のタスクだけの
    // はずで、常に1件ずつしか無いが、複数あっても構わない形にしておく）
    for (const entry of live.mergeResolutions.values()) {
      entry.session.stopLoop();
    }
    // 停止直後は走行中タスクの`stopLoop()`がまだ確定していない（進行中のターンには
    // 割り込まない）ため、オーケストレーターの視点では通常の`taskFailed`しか届かず
    // 「人が止めた」と分からない（issue #401）。制御ツール側の拒否とは別に、ここで
    // 明示のイベントを送る。ただし既に`haltedByUser`だったrunへ`stop()`が重ねて呼ばれても
    // 同じ通知を積み増さない（`MAX_ORCHESTRATOR_EVENTS_PER_RUN`の浪費と同一文言の重複を防ぐ）
    if (!wasHaltedByUser && live.runState.haltedByUser) {
      notifyOrchestratorRunHalted(this.internals, runId);
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
    const mergeResolutionEntry = live.mergeResolutions.get(taskId);
    if (mergeResolutionEntry !== undefined) {
      mergeResolutionEntry.session.reveal();
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
   *
   * **戻り値は「送り先を見つけて`stopLoop()`を呼べたか」（issue #514）。**
   * 見つからなければ`false`を返し、決して成功のふりをしない。理由は次のとおり。
   *
   * 以前は `live.tasks` しか見ておらず、衝突解決セッション（`live.mergeResolutions`。
   * `runnerMerge.ts` の `startMergeResolution`）は対象外だった。しかも戻り値が`void`
   * だったため、`runnerOrchestrator.ts` は届いたかどうかに関係なく無条件で「止めました」
   * という成功応答をオーケストレーターへ返していた（issue #381で`stop()`だけが同じ穴を
   * 塞がれ、`stopTask()`には非対称に手当てが漏れていた）。
   *
   * **一般則: 停止要求が実際にどのセッションへも届かなかった場合は必ず失敗を返す。**
   * `live.mergeResolutions`を1つ足して届くようにするだけでは不十分で、将来また別の
   * 保管場所へセッションが増えたとき同じ欠陥を再生産する。そのため「対象を保持する
   * Mapにエントリがあるか」ではなく、**`TaskSession.stopLoop()`
   * （実体は`LoopController.stop()`）が実際にループを止められたかの`boolean`**を
   * 戻り値の根拠にする。`live.tasks`のエントリは`onTaskFinished`後も削除されない
   * ため、存在チェックだけでは「セッションはまだ残っているが、ループは既に終わって
   * いて何も起きなかった」呼び出しを成功と誤判定してしまう（`merging`のタスクが
   * まさにこの形）。
   *
   * 嘘の成功応答は、人よりAIエージェント（オーケストレーター）に対して有害である。
   * 人はワークフローViewを見て「止まっていない」に気づけるが、オーケストレーターは
   * 制御ツールの応答（`accepted`）しか見ないため、一度成功を騙ると以後その経路を
   * 二度と再試行しない。
   *
   * 送り先は`live.mergeResolutions`を先に見る（`revealTask`と同じ順序）。`merging`の
   * タスクは`live.tasks`のエントリが残ったまま（`onTaskFinished`で`dispose()`済み・
   * ループも停止済み）なので、`live.tasks`を先に見ると常に「見つかった」ことに
   * なってしまい、衝突解決セッション側へ本来届けるべき`stopLoop()`が届かなくなる。
   *
   * **この修正（issue #514）より前は、`merging`のタスク1件だけを狙って止めたはずが、
   * `runnerMerge.ts`の`finishMergeResolution`側の既存分岐（`reason === 'taskStopped'`）
   * により実行全体が停止（`haltedByUser`）していた。** `stop()`（全体停止）が衝突解決
   * セッションへ送る`stopLoop()`と同じ`'taskStopped'`しか`onFinished`へ伝わらず、
   * どちらが送ったのか区別できなかったためである。現在は下の`mergeResolutionEntry.
   * stoppedByStopTask`を`stopLoop()`より先に立てて送り元を印し、
   * `finishMergeResolution`側がそれを見て他のタスクを止めずにこのタスクだけを
   * `blocked`にできるようにしている（`MergeResolutionEntry.stoppedByStopTask`の
   * JSDoc参照）。
   */
  stopTask(runId: string, taskId: string): boolean {
    const found = this.findStoppableSessionEntry(runId, taskId);
    if (found === undefined) {
      return false;
    }
    if (found.kind === 'mergeResolution') {
      // `runnerMerge.ts`の`finishMergeResolution`がrun全体を止めずにこのタスクだけを
      // `blocked`にできるよう、`stopTask()`経由（`stop_task`／Viewの「タスク停止」の
      // どちらでも同じ）であることを先に印しておく（Issue #514。
      // `MergeResolutionEntry.stoppedByStopTask`のJSDoc参照）。`stopLoop()`を呼んだ**後**に
      // 立てると、同期的に発火しうる`onFinished`（`finishMergeResolution`）に間に合わない
      // 場合があるため、必ず先に立てる
      found.entry.stoppedByStopTask = true;
    }
    return found.entry.session.stopLoop();
  }

  /**
   * `stopTask`が実際に対象を見つけられたか（＝止められるループが元々あったか）だけを
   * 返す（Issue #514）。`stopTask`の戻り値（`session.stopLoop()`の結果）は「見つからな
   * かった」と「見つかったが既に終わっていた」を区別できない（`LoopController.stop`は
   * 走っていないループへの呼び出しに`false`を返すため。`loopController.ts`参照）ため、
   * `runnerOrchestrator.ts`の`stop_task`ツールが両者を別の文言で伝えるための補助として
   * 別関数に切り出す。
   *
   * `live.tasks`のエントリは`onTaskFinished`後も消えないため、ここでの`true`は
   * 「そのタスクへ送るセッションが存在する」ことしか意味しない（ループが走っているか
   * どうかは見ない）。
   *
   * `stopTask`と同じ`findStoppableSessionEntry`を呼ぶことで「対象taskIdに紐づく
   * セッションの候補」を単一箇所に集約している。**将来3つ目の保管場所が増えたときは、
   * この関数を直接書き換えず、必ず`findStoppableSessionEntry`側へ追加すること。**
   * ここへ`live.mergeResolutions`/`live.tasks`の探索を書き戻すと、`stopTask`とこの
   * 関数の一致がコンパイルにもテストにも頼らない口約束へ戻ってしまう
   * （レビュー指摘: medium）。
   */
  hasStoppableSession(runId: string, taskId: string): boolean {
    return this.findStoppableSessionEntry(runId, taskId) !== undefined;
  }

  /**
   * `stopTask`と`hasStoppableSession`が共に参照する「対象taskIdに紐づく、止められる
   * 可能性のあるセッションの候補」を単一箇所に集約する（レビュー指摘: medium。issue
   * #514）。2つが別々に`live.mergeResolutions`/`live.tasks`を探索していると、将来
   * 3つ目の保管場所が増えたときに片方の更新を忘れてもコンパイルエラーにもテスト
   * 失敗にもならない非対称が生まれる。ここへ集約すれば、保管場所を1つ追加し忘れた
   * 側が必ず古いままの`findStoppableSessionEntry`を呼び続け、両者が揃って古いか
   * 揃って新しいかのどちらかにしかならない。
   *
   * **探索順は`live.mergeResolutions`を`live.tasks`より先に見る**（`revealTask`と同じ
   * 順序。`stopTask`のJSDoc参照）。`merging`のタスクは`live.tasks`のエントリが
   * `onTaskFinished`後も残ったまま（`dispose()`済み・ループも停止済み）なので、
   * `live.tasks`を先に見ると常に「見つかった」ことになってしまい、衝突解決セッション
   * 側へ本来届けるべき`stopLoop()`が届かなくなる。この順序を変えると
   * `stopTask`は壊れるが、`hasStoppableSession`は（両方に無いか両方にあるかだけを
   * 見るので）気づかない。**探索順のテストは`stopTask`側に置く**理由はこのため。
   */
  private findStoppableSessionEntry(
    runId: string,
    taskId: string,
  ):
    | { kind: 'mergeResolution'; entry: MergeResolutionEntry }
    | { kind: 'task'; entry: LiveTask }
    | undefined {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return undefined;
    }
    const mergeResolutionEntry = live.mergeResolutions.get(taskId);
    if (mergeResolutionEntry !== undefined) {
      return { kind: 'mergeResolution', entry: mergeResolutionEntry };
    }
    const liveTask = live.tasks.get(taskId);
    if (liveTask === undefined) {
      return undefined;
    }
    return { kind: 'task', entry: liveTask };
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
    const wasFinished = live.finished;
    live.finished = false;
    // 終了通知を出した後の再開だけ知らせる（Issue #491）。実行中の再実行では
    // オーケストレーターは終わったと思っていないので、送ると混乱を増やすだけになる
    if (wasFinished) {
      notifyOrchestratorRunResumed(this.internals, runId, '再実行');
    }
    this.notify(runId);
    void this.persist(runId);
    this.pump(runId);
    return { ok: true };
  }

  /**
   * 回数切れ（`maxReached`）・停滞（`stalled`、design.md §16.27、Issue #336）で止まった
   * タスクを、同じ会話のまま続きから走らせる（design.md §16.8「続ける」、issue #284）。
   * 対象外なら何もせず `false` を返す。
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
    const wasFinished = live.finished;
    live.finished = false;
    // Issue #491。`retryTask`と同じ条件。こちらは`prepareTaskLaunch`を通らないため
    // MCPサーバ自体も立て直らない（`ensureMessaging`のJSDoc参照）
    if (wasFinished) {
      notifyOrchestratorRunResumed(this.internals, runId, '続ける');
    }
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
   * `ask_user`（design.md §16.33、Issue #583）への回答。ワークフローViewの選択ボタンから
   * 呼ぶ。実体は`answerAskUser`（`runnerOrchestrator.ts`）。回答待ちが無い・選択肢の範囲外・
   * セッションが無い場合は`false`を返す。
   */
  answerAskUser(runId: string, choiceIndex: number): boolean {
    return answerAskUserImpl(this.internals, runId, choiceIndex);
  }

  /**
   * 拡張機能の終了時に、実行中のrunが抱えている資源をすべて解放する（Issue #374）。
   *
   * 解放するもの:
   *
   * - オーケストレーターセッション（design.md §16.23「セッションの生成と寿命」の
   *   `dispose`）。runの終了では解放しない（run完了後も会話を続けられるようにするため）ので、
   *   ここが唯一の解放点になる
   * - 各タスクの`TaskSession`（CLIの子プロセス）と衝突解決セッション
   *   （`live.mergeResolutions`。どちらもrunが走っている間は生きている）
   * - タスク間メッセージングのMCPサーバとポーリングタイマー（`closeMessaging`）。
   *   run終了時の後始末（`pump()`）と同じ関数を呼ぶ。実行中のrunでは`pump()`の終了分岐を
   *   通らないため、ここで閉じないとlisten中のソケットと`setInterval`が残る
   * - 統合worktreeの占有（`releaseAllLeases()`）
   *
   * **1つの解放が例外を投げても残りを続ける**（`disposeQuietly`）。片付けの途中で
   * 抜けるとCLIのプロセスやソケットが取り残されるため。
   *
   * **冪等**。解放したものは`undefined`にするかMapから消すので、2度目の呼び出しは
   * 何もしない。
   *
   * runの状態（`runState`）は書き換えない。解放が呼び戻す経路（`onTaskFinished`と
   * `runnerMerge.ts`の`finishMergeResolution`）は`disposing`が黙らせるため、メモリ上の
   * `runState`が破棄中に汚れることが無い（`live.finished`・`disposing`はどちらもメモリ上の
   * 印で、永続化される値ではない）。`blockMergeAfterLeaseWait`にも同じガードがあるが、
   * 破棄由来の待機起こしは`live.finished`（このループで先に立てる）を見て`skip`へ倒される
   * ため実際には呼ばれない多層防御（レビュー3周目のmedium、`blockMergeAfterLeaseWait`の
   * コメント参照）。
   *
   * 一方で`persist()`自体は止めない。破棄より前に積まれたpersistはキュー待ちの間に
   * `disposing`が立っても走り、しかもupdaterは`live.runState`を実行時点で読み直すため、
   * 入口で止めても素通りされる（`persist()`のコメント参照）。汚染を止めるのは書き換え側の
   * 責務で、その前提が立てば残りのpersistは「破棄の直前に確定した値」を正しく書き切る。
   */
  dispose(): void {
    // 解放より先に立てる。走行中のセッションの解放が`onFinished`→`onTaskFinished`を
    // 同期的に呼び戻すため、この印が無いとrun全体が手動停止として永続化される
    // （フィールドのJSDoc参照）
    this.disposing = true;
    for (const live of this.runs.values()) {
      // 解放より先に立てる。`session.dispose()`は`onFinished`を同期的に発火しうる
      // （`chatView.ts`。テスト「catchのsession.dispose()」参照）ため、この印が無いと
      // 片付けの最中に`pump()`が次のタスクを開始してしまう。
      //
      // 統合worktreeの占有待ちで止まっているマージを、起こす前に「即戻る」状態にする
      // 役目も兼ねる（Issue #412のレビュー指摘6）。`releaseAllLeases()`で起き上がった
      // 待機者は`attemptMerge`の続きへ進むため、この印が無いと`markMergeFailed`→
      // `persist`/`notify`が破棄済みのEventEmitter・workspaceStateへ書き込む
      live.finished = true;
      disposeQuietly(this.deps.log, () => disposeOrchestrator(live));
      // 実行中のrunのタスクセッション（CLIの子プロセス）。run終了時に個別に解放される
      // 経路（`onTaskFinished`）を通っていない、走行中のものと`maxReached`で残したもの
      // （issue #284）がここへ来る。`dispose()`が`onFinished`経由で`live.tasks`を
      // 書き換えうるので、対象を先に確定させてから解放する（`stop()`と同じ）
      const taskEntries = [...live.tasks.entries()];
      live.tasks.clear();
      for (const [taskId, liveTask] of taskEntries) {
        disposeQuietly(this.deps.log, () => liveTask.session.dispose(), `task ${taskId}`);
      }
      // 衝突解決セッション（design.md §16.17「コンフリクト」5.）は`live.tasks`の管理下に
      // 無い別枠のため、個別に解放する（`stop()`と同じ扱い）
      const mergeResolutionEntries = [...live.mergeResolutions.entries()];
      live.mergeResolutions.clear();
      for (const [taskId, entry] of mergeResolutionEntries) {
        // 承認待ちタイムアウトのタイマー（Issue #413 PR5）。`entry.session.dispose()`が
        // 例外を投げても解放されるよう、セッションの解放より先に・別のtry/catchで行う
        // （`clearTimeout`自体が投げることは無いが、`disposeQuietly`の対象を1つに絞る）
        clearTimeout(entry.approvalTimeoutTimer);
        disposeQuietly(this.deps.log, () => entry.session.dispose(), `merge resolution ${taskId}`);
      }
      disposeQuietly(this.deps.log, () => closeMessaging(live), 'messaging');
      disposeQuietly(this.deps.log, () => closeReviewCommentPoll(live), 'reviewCommentPoll');
      // `closeMessaging`自体は`messagingHub`をクリアしない（`closeMessaging`は`dispose()`
      // だけでなく、run正常終了時の`pump()`からも呼ばれる共通関数のため。そちらでは
      // `retryTask`による再開が`messagingHub`を再利用する前提＝Issue #475の案A「hubを
      // 捨てずに再利用する」がここに依存している。`closeMessaging`側でクリアすると、
      // 通常のrun終了後の再開のたびに新しいhubが作られ、`MAX_MESSAGES_PER_RUN`のカウンタと
      // 未配送キューがリセットされてしまい、この修正が守ろうとしているものを自ら壊す）。
      //
      // `dispose()`はここが唯一の別枠: 拡張機能の終了であり、このrunが再開されることは
      // 二度と無い（`this.runs`からrunを削除する経路が無いため`live`自体は残り続けるが、
      // `this.disposing`により`ensureMessaging`の入口で以後の再構築は止まる）。それでも
      // `messagingHub`を握ったままにしておく理由が無いため、ここで明示的に手放す
      // （**この非対称は意図的**。あとから「揃える」形で`closeMessaging`側にも足さないこと）
      live.messagingHub = undefined;
    }
    // 統合worktreeの占有（Issue #412）の強制解放。通常は`runnerMerge.ts`側の`finally`が
    // 解放するが、解放漏れが1つでもあると以後そのrunのマージが全て待ち続ける。破棄時に
    // まとめて解放して待ち行列を空にする（待っていた側は失効したハンドルで失敗する）
    this.integrationQueue.releaseAllLeases();
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
    const attempts = clampWorktreeRemovalAttempts(totalAttempts);
    if (attempts < totalAttempts) {
      // Issue #490: 上限を超える`retry`番号のworktreeは撤去されずに残る。黙って
      // 諦めず、残った旨を人へ知らせる（何が起きるかは
      // `MAX_WORKTREE_REMOVAL_ATTEMPTS`のJSDoc参照）。疑似worktree側
      // （`removePseudoTaskWorktree`）と同じ扱いにする
      this.deps.log.warn(
        `[workflow ${runId}/${task.id}] 再試行が${totalAttempts}回あり、worktreeの撤去は` +
          `${MAX_WORKTREE_REMOVAL_ATTEMPTS}回分までに留めました。` +
          `これより後の試行のworktreeは残ります（手で消してください）。`,
      );
    }
    const retries: Array<number | undefined> = [
      undefined,
      ...Array.from({ length: attempts }, (_, i) => i),
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
   * gitでないワークスペース（疑似worktree、design.md §16.20）の1タスク分の複製を、
   * すべての試行分撤去する（Issue #298「疑似worktreeが撤去対象にならない」、Issue #396）。
   *
   * **`blocked`のタスクの複製は残す。** gitならタスクブランチが残るため撤去しても
   * 中身を後から辿れるが、疑似worktreeにはブランチが無く、複製を消すと未統合の差分
   * （3-way mergeができず衝突として弾かれた分。design.md §16.20）を復元する手段が
   * 無くなってしまう。
   *
   * `totalAttempts`はgit側の`removeGitTaskWorktree`と同じ`state.retryCount +
   * state.manualRetryCount`（Issue #396）。以前は`removePseudoWorktree`を`retry`無しで
   * 1回呼ぶだけで、再試行のたびに`cloneWorkspace`が作った`-retry<n>`付きの複製が
   * 撤去されずに残っていた。
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
    const totalAttempts = state.retryCount + state.manualRetryCount;
    const attempts = clampWorktreeRemovalAttempts(totalAttempts);
    if (attempts < totalAttempts) {
      // Issue #490: git側（`removeGitTaskWorktree`）と同じ。片方だけ上限を持たせると
      // 対称性が崩れる
      this.deps.log.warn(
        `[workflow ${runId}/${task.id}] 再試行が${totalAttempts}回あり、疑似worktreeの撤去は` +
          `${MAX_WORKTREE_REMOVAL_ATTEMPTS}回分までに留めました。` +
          `これより後の試行の複製は残ります（手で消してください）。`,
      );
    }
    const result = await removePseudoWorktreeAttempts(
      live.repoRoot,
      runId,
      task.id,
      attempts,
      pseudoWorktreeDeps.fs,
    );
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
   * `live.pseudo`の統合先（`_integration`、`integrationPath`と同じ場所）と、その
   * 永続化マニフェスト（`manifest.json`、Issue #380）を`removePseudoIntegration`で
   * まとめて撤去する。`_integration`だけを消してマニフェストを残すと、撤去後の
   * リロードで`resolvePseudoState`が実体の無い`_integration`を指す古いマニフェストを
   * 読み戻し、そのrunで再実行した際にワークスペース側のファイルを誤って再削除する
   * （Issue #438）。gitと違い履歴が無いため「ブランチを残す」概念は無いが、実体を
   * まとめて消すという意味では同じ操作になる。
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
        : await removePseudoIntegration(live.repoRoot, runId, integrationTarget.fs);
    reportProgress('統合worktree');
    this.notify(runId);
    if (result.ok) {
      // `removePseudoIntegration`はrunIdディレクトリの片付けが境界逸脱で失敗しても
      // `_integration`/`manifest.json`の撤去自体は成功していれば`ok:true`を返し、
      // 詳細を`warning`に載せる（Issue #438のレビュー指摘）。gitの撤去経路には
      // 対応する`warning`が無いため、'warning' inで疑似worktree側だけを拾う。
      if ('warning' in result && result.warning !== undefined) {
        this.deps.log.warn(`[workflow ${runId}] ${result.warning}`);
      }
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
   *
   * **Issue #413 PR4: 承認待ちの解決セッションを`maxParallel`の枠から外す。** 承認待ち
   * （`entry.waitingApprovalSinceMs !== undefined`）の`live.mergeResolutions`のtaskId
   * 集合を`nextTasksToStart`の`excludeFromActiveCount`へ渡す。渡すのはここだけで、
   * `getRunOutcome`・`checkWaitingReplyStalls`（`runnerMessaging.ts`）へは渡さない
   * （design.md §16.3の例外の説明・`scheduler.ts`のJSDoc参照）。
   */
  private pump(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.finished) {
      return;
    }
    const excludeFromActiveCount = new Set<string>();
    for (const [taskId, entry] of live.mergeResolutions) {
      if (entry.waitingApprovalSinceMs !== undefined) {
        excludeFromActiveCount.add(taskId);
      }
    }
    const toStart = nextTasksToStart(live.def, live.runState, excludeFromActiveCount);
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
      // 全タスクがdoneになったときだけ統合→mainのPR/MRを作る（design.md §16.18）。
      //
      // ここは`finishedNotified`で絞らない。2周目がここへ到達する（＝`outcome ===
      // 'succeeded'`）には、1周目の時点で`retryMerge`/`retryTask`/`continueTask`の
      // いずれかが起きている必要があるが、その3経路はいずれも1周目の対象タスクが
      // `blocked`（`retryMergeState`）/`failed`または`skipped`（`retryTask`）/
      // `failed(maxReached)`（`continueTask`）であることを前提にしており、これらは
      // どれも`getRunOutcome`を`succeeded`以外へ倒す（`anyFailed`/`anyBlocked`が立つ）。
      // つまり1周目が`succeeded`だった run は、この3経路のどれも呼べる状態にならない
      // （Issue #432-2）。
      //
      // **ただしdesign.md §16.30（roadmap W5、Issue #339）以降、これとは別の経路で
      // 2周目の`succeeded`到達が起こりうる。** 統合PR/MRのレビューコメントのポーリング中
      // （`live.reviewCommentPoll`が生きている間）に限り、オーケストレーターは
      // `add_task`等の計画変更ツールを使える（`runnerOrchestrator.ts`の
      // `planChangeFinishedReason`）。これで加わった/変更した`pending`タスクが`pump()`
      // 経由で走行・完了し、runが再び終了条件を満たすと、2周目としてここへ到達する。
      // `finalizeForge`はこの2回目の呼び出しに対して冪等（`live.integrationPullRequest`
      // が既にあれば統合PR/MRを作り直さず即returnする）ため、Issue #432-2が防いでいた
      // 「統合PR/MRの二重作成」は起きない
      //
      // `finalMerge: orchestrator`（design.md §16.26）は`finalizeForge`の中から
      // `decide_final_merge`（MCPツール）の応答を待ちうる。下のメッセージング終了処理
      // （MCPサーバを閉じる）をこの判断が付くまで遅らせる必要があるため、ここで先に
      // 判定しておく。`confirm`はMCPを使わない（人がViewのボタンを押すだけ）ため対象外。
      // `live.forge.finalMerge`は実行開始時に一度だけ決まる値で、`finalizeForge`が
      // 実際にPR/MRを作れるかどうかとは無関係に判定できる（作れなければ`finalizeForge`が
      // 早期returnし、`live.finalMergeDecision`は`undefined`のまま残るので下の
      // `closeMessagingIfFinalMergeSettled`が即座に閉じる）
      const mayAwaitFinalMergeDecision =
        outcome === 'succeeded' &&
        live.forge.kind === 'active' &&
        live.forge.finalMerge === 'orchestrator';
      if (outcome === 'succeeded') {
        if (mayAwaitFinalMergeDecision) {
          // `.catch`を`.then`より前に挟む（`.catch().then()`の順）ことが要。
          // `finalizeForge`が例外で終わっても（WF-Eのレビュー指摘、横断レビューで実測）
          // `.catch`がここで飲み込んで既に解決済みのPromiseへ変えるため、続く`.then`の
          // `closeMessagingIfFinalMergeSettled`は例外の有無に関わらず必ず呼ばれる。
          // ここを飛ばすと、成功時にPR/MRを作れて判断待ちへ入った場合以外の失敗経路で
          // タスク間メッセージングのMCPサーバが最終マージ確定後も閉じられないまま残る
          // （`closeMessagingIfFinalMergeSettled`の3つの呼び出し口の1つがここ。他の2つは
          // design.md §16.26「MCPサーバの寿命との整合」参照）。兄弟の形は`runnerRestore.ts`
          // の`autoResumeIfEligible`呼び出しと`programRunner.ts`の`attach()`内（どちらも
          // `.catch`でログを出すだけで、フォローアップの呼び出しを持たない点だけがここと違う）
          void this.finalizeForge(runId)
            .catch((e: unknown) => {
              this.deps.log.error(
                `[workflow ${runId}] finalizeForgeに失敗しました（最終マージ判断待ちの経路）: ${sanitizeForLog(
                  e instanceof Error ? e.message : String(e),
                )}`,
              );
            })
            .then(() => this.closeMessagingIfFinalMergeSettled(runId, outcome));
        } else {
          void this.finalizeForge(runId).catch((e: unknown) => {
            this.deps.log.error(
              `[workflow ${runId}] finalizeForgeに失敗しました: ${sanitizeForLog(
                e instanceof Error ? e.message : String(e),
              )}`,
            );
          });
        }
      }
      // ロードマップの更新（design.md §16.19）もrunの結果を問わず行う。`done`になった
      // タスクの分だけチェックを入れる処理なので、runが途中で失敗していても、終わった分は
      // ロードマップへ反映されているのが人の期待に近い。
      //
      // ここも`finishedNotified`で絞らない。`applyRunCompletionToFile`
      // （`roadmap.ts`）は現在のロードマップファイルとの差分（`updatedItemIds`）を
      // 計算し、変更が無ければ書き戻さないため2周目に再実行しても無害（冪等）。
      // むしろ2周目で新たに`done`になったタスクのチェックを反映する必要があるため、
      // 絞らない方が正しい（Issue #432-2）
      if (live.def.roadmap !== undefined) {
        void this.applyRoadmapCompletion(runId);
      }
      // 疑似worktree（design.md §16.20）はrunの結果を問わず反映する（forgeとは異なり
      // `succeeded`限定にしない。`reflectPseudoWorktree`自身のJSDoc参照）。
      //
      // `retryMerge`/`retryTask`/`continueTask`による再開後の2周目以降もここで絞らない
      // （Issue #511。従来はここを`finishedNotified`で絞り、2周目以降は反映自体を
      // 行わないようにしていたが、`reflectPseudoWorktree`が反映成功後に
      // `live.pseudo.baseline`を反映後のワークスペース状態へ更新するようになった
      // （`reflectIntegrationToWorkspace`のJSDoc参照）ため、2周目以降も1周目と同じ
      // 経路で正しく比較・反映できる。絞る理由自体が無くなったため、
      // `pseudoWorktreeReflectSkipped`という「反映していない」事実を伝えるためだけの
      // 暫定警告も廃止した）
      if (live.pseudo !== undefined) {
        void reflectPseudoWorktree(this.internals, runId);
      }
      // タスク間メッセージング（design.md §16.21）のMCPサーバはrunの結果を問わず閉じる。
      // 以降新しいタスクは開始されない（`live.finished`）ため、これ以上の接続は要らない
      // オーケストレーターへの最後の通知は、MCPサーバを閉じる前に積む（送信そのものは
      // CLIへの本文送信なので順序に依存しないが、「以降ツールは使えない」を伝える文面と
      // 実際の閉鎖の順序を合わせておく）。
      //
      // `finalMerge: orchestrator`でPR/MRを作れた場合（`mayAwaitFinalMergeDecision`）は、
      // `decide_final_merge`の応答を待つ必要があるためここでは閉じない。
      // `closeMessagingIfFinalMergeSettled`（`finalizeForge`完了後・`decideFinalMerge`
      // 確定後の両方から呼ばれる）が、判断待ちが無いことを確認してから閉じる
      if (!mayAwaitFinalMergeDecision) {
        this.closeMessagingIfFinalMergeSettled(runId, outcome);
      }
    }
  }

  /**
   * オーケストレーターへの終了通知（`notifyOrchestratorRunFinished`）とMCPサーバの
   * 解放（`closeMessaging`）をまとめて行う（design.md §16.23・§16.26）。
   *
   * **`live.finalMergeDecision`が判断待ちの間は何もしない。** `finalMerge: orchestrator`は
   * `decide_final_merge`ツールでこの判断を受けるため、判断が付く前にMCPサーバを閉じると
   * ツールごと消えてしまう。`pump()`の終了ブロック（PR/MRを作れなかった／判断待ちに
   * ならなかった経路）と、`decideFinalMerge`（判断が確定した経路）の両方から呼ばれる
   * 合流点にしてあるのはこのため。
   */
  private closeMessagingIfFinalMergeSettled(runId: string, outcome: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.finalMergeDecision !== undefined) {
      return;
    }
    // `notifyOrchestratorRunFinished`はrunにつき1度だけ送る（Issue #432-2）。
    // `retryMerge`/`retryTask`/`continueTask`は再開の起点として`live.finished`を
    // `false`へ戻すため、この終了ブロックは再開後にもう一周走りうる。`notifyOrchestrator`
    // （`runnerOrchestrator.ts`）は件数上限しか持たず重複排除しないため、絞らないと
    // 「実行が終了しました」がオーケストレーターへ二重に届く
    if (!live.finishedNotified) {
      notifyOrchestratorRunFinished(this.internals, runId, outcome);
      live.finishedNotified = true;
    }
    // `closeMessaging`自体は`live.messaging === undefined`なら即returnする既に冪等な
    // 実装なので、`finishedNotified`では絞らない（絞ると意味が重複するだけ）
    closeMessaging(live);
    // レビューコメントのポーリング（design.md §16.30）も、最終マージ・判断が確定して
    // これ以上PR/MRの状態を追う必要が無くなった時点で一緒に閉じる
    closeReviewCommentPoll(live);
    // チームモードの受け渡しファイル（design.md §16.44、Issue #693）を片付ける。
    //
    // 消す位置を`closeMessaging`と揃えているのは、受け渡しファイルを読み書きする4ツールが
    // MCPサーバ越しにしか使えず、サーバが閉じた時点でどのセッションからも到達できなく
    // なるため。「到達できなくなったものを残さない」という一点で位置が決まる。
    //
    // **再開（`retryTask`/`continueTask`/`retryMerge`）した2周目は、受け渡しファイルが
    // 空の状態から始まる。** 再開時は`ensureMessaging`がMCPサーバを作り直すのでツール
    // 自体は使えるが、1周目に書いたファイルは残っていない。これはMCPのURLが作り直され、
    // 起動済みセッションの制御ツールが戻らないのと同じ性質の制約（design.md §16.43）で、
    // 引き継ぎたい内容はオーケストレーターが自分の会話へ持っている前提にする。
    //
    // 失敗しても実行の結果には影響しないため、ログだけ残して握る（`disposeQuietly`と
    // 同じ流儀。ここは非同期なので`void`＋`catch`で書く）。
    //
    // `buildHandoffPort`が作る`HandoffPort`はrun内の1ファイルを読み書きする口だけを
    // 公開しており、run丸ごとの撤去（`removeRun`）を持たない——タスクやオーケストレーターに
    // 「他のセッションのファイルもまとめて消す」操作を渡さないための線引きなので、ここでは
    // ポートを経由せず`TeamHandoffStore`を直接組み立てる
    //
    // 失敗は例外（パス検証・シンボリックリンクガード）と`ok: false`（ファイルシステムの
    // 撤去失敗）の2通りある。どちらも同じ文言で残す——片方だけ見ていると「片付けに失敗した」
    // 事実がログに出ない（PR #711 自己レビュー指摘: medium）
    const warnCleanupFailure = (reason: string): void => {
      this.deps.log.warn(
        `[workflow ${runId}] 受け渡しファイルの片付けに失敗しました: ${sanitizeForLog(reason)}`,
      );
    };
    void new TeamHandoffStore(live.repoRoot, nodeHandoffFileSystem)
      .removeRun(runId)
      .then((result) => {
        if (!result.ok) {
          warnCleanupFailure(result.error);
        }
      })
      .catch((e: unknown) => {
        warnCleanupFailure(e instanceof Error ? e.message : String(e));
      });
  }

  /**
   * タスクの開始時にIssueを起票する（design.md §16.31「タスクの開始時にIssueを起票し、PR
   * 本文から参照する」、roadmap W6、Issue #596）。`prepareTaskLaunch`から、bypassPermissions
   * の最終防御を通過した後に呼ぶ（起票は外部ホストへの副作用を伴うため、危険判定が働かない
   * 設定として拒否するタスクではそもそも呼ばない。起動そのものより前に行う必要は無いが、
   * PR/MR本文が参照する番号は起動直後には要らないため、ここで決めておけば
   * `mergeTaskWithForge`（`runnerMerge.ts`）が`live.createdTaskIssues`から読むだけで済む）。
   *
   * **前提が欠けても`startTask`を止めない。** `live.forge.kind === 'active'`である以上
   * `checkForgePrerequisites`（CLI・認証・originリモート）は既に通っているが、個別の
   * `gh issue create`/`glab api`呼び出し自体が失敗することはありうる（レート制限・権限不足
   * 等）。失敗しても警告を積むだけで例外は投げない（design.md §16.31の受入基準）。
   *
   * `task.issue`が既に指定されている（YAML・ロードマップ由来）ときは起票しない
   * （既存のIssueを使い回す）。同じtaskIdへ二重に起票しないよう
   * `live.createdTaskIssues`を先にチェックする（`retryTask`で同じ番号を使い回す）。
   */
  private async maybeCreateTaskIssue(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    runId: string,
    cwd: string,
  ): Promise<void> {
    const forge = live.forge;
    const forgeDeps = this.deps.forge;
    if (
      forge.kind !== 'active' ||
      !forge.createTaskIssue ||
      !shouldCreateTaskPullRequest(forge.pullRequest) ||
      forgeDeps === undefined ||
      task.issue !== undefined ||
      live.createdTaskIssues.has(taskId)
    ) {
      return;
    }
    try {
      const outcome = await createIssue(
        { cli: forgeDeps.cli, fs: forgeDeps.fs },
        {
          host: forge.host,
          cwd,
          title: buildTaskPullRequestTitle(taskId, task.prompt),
          body: buildTaskIssueBody({ prompt: task.prompt, done: task.done, runId, taskId }),
        },
      );
      if (!outcome.ok) {
        this.deps.log.warn(
          `[workflow ${runId}/${taskId}] Issueの起票に失敗しました: ${outcome.message}`,
        );
        live.warnings.push({
          kind: 'taskIssueFailed',
          taskId,
          message: `Issueの起票に失敗しました: ${outcome.message}`,
        });
        return;
      }
      const number =
        outcome.url !== undefined ? parsePullRequestNumberFromUrl(outcome.url) : undefined;
      if (number === undefined) {
        this.deps.log.warn(
          `[workflow ${runId}/${taskId}] Issueは起票できましたが、URLから番号を取り出せませんでした`,
        );
        live.warnings.push({
          kind: 'taskIssueFailed',
          taskId,
          message:
            'Issueは起票できましたが、URLから番号を取り出せなかったため、PR本文からの参照を省略します',
        });
        return;
      }
      live.createdTaskIssues.set(taskId, number);
    } catch (e) {
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.warn(
        `[workflow ${runId}/${taskId}] Issueの起票中にエラーが発生しました: ${message}`,
      );
      live.warnings.push({
        kind: 'taskIssueFailed',
        taskId,
        message: `Issueの起票中にエラーが発生しました: ${message}`,
      });
    }
  }

  /**
   * `startTask()`の前半。作業ディレクトリの解決・実効設定のクランプ・権限越境チェック・
   * bypassPermissionsの最終防御・タスクのIssue起票（design.md §16.31、roadmap W6、
   * Issue #596。`maybeCreateTaskIssue`）・`TaskSessionInput`の組み立てとタスク境界の
   * 解決までを担う。
   */
  private async prepareTaskLaunch(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    runId: string,
  ): Promise<TaskLaunchPreparation> {
    const taskRunState = live.runState.tasks.get(taskId);
    const retry = retrySuffixOf(taskRunState);
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

    // タスクのIssue起票（design.md §16.31、roadmap W6、Issue #596）は、外部ホストへの
    // 副作用（`gh issue create`/`glab api`）を伴う。**bypassPermissionsの最終防御より後で
    // 呼ぶこと。** 先に呼ぶと、「危険判定が働かない設定なので開始できません」と拒否した
    // タスクについてもIssueだけが起票されたまま残ってしまう（レビュー指摘）
    await this.maybeCreateTaskIssue(live, task, taskId, runId, cwd);

    // タスク間メッセージング（design.md §16.21）。`registerTask`の直前で`ensureMessaging`を
    // 呼ぶ（Issue #475の単一チョークポイント）。run終了後の`retryTask` / 再マージ成功で
    // `pending`へ戻った後続タスクなど、`live.messaging`が閉じた状態で新しいセッションを
    // 開こうとする経路はすべてここを通るため、再構築の呼び出し漏れが構造的に起きない。
    // 既に生きていれば`ensureMessaging`は何もしない（冪等）
    await this.ensureMessaging(runId, live);
    // runにMCPサーバが立っていれば、このタスク専用の接続用URLを1つ発行する。実際にCLIの
    // 起動へ渡す配線（`TaskSessionInput.mcp`を読む側）はsrc/view/の変更が要るため、この
    // Issueの範囲外（`WorkflowRunnerMessagingDeps`のJSDoc参照）。ここでは値を渡すところまで
    const messagingUrl = live.messaging?.transport.registerTask(taskId);
    const input: TaskSessionInput = {
      // タブ名にtaskIdを含めるため（Issue #599）。ワークフローが並列に開いたタスクの
      // タブが、これが無いと全部同じ名前になる。権限の決定には使わない
      taskId,
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
      waitingApprovalSinceMs: undefined,
      taskApprovalTimeoutTimer: undefined,
      taskApprovalTimedOut: false,
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

      // dispose()後に宙に浮いていた継続の再開を止める（Issue #502）。`prepareTaskLaunch`の
      // 内部（`resolveWorkingDirectory`等）で`await`している間に`dispose()`が完走すると、
      // ここへ戻ってきた時点で`this.disposing`が`true`になっている。`live.finished`は
      // `retryTask`が`false`へ戻すため条件に使えない（`isDisposing()`のJSDoc・
      // `ensureMessaging`入口のコメント参照）。`openTaskSession`の呼び出し元はコードベース
      // 中ここ1箇所だけ（`git grep -n "openTaskSession("`で確認済み）なので、
      // `prepareTaskLaunch`内のどのawait点で止まっていたかによらず、CLIセッションを開く
      // 直前のこの1箇所で塞げば足りる。ここで止めれば`live.tasks`へは何も積まれないため、
      // `dispose()`の解放対象を外れて閉じられなくなる（本Issueが指摘したリーク）ことも無い
      if (this.disposing) {
        return;
      }

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
   *
   * `rebuildLiveRun`（`runnerRestore.ts`、Issue #147）から`self.resolveForgeState(...)`として
   * 呼ぶ（公開範囲は`WorkflowRunnerInternals`に閉じる）。
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
      createTaskIssue: config.createTaskIssue,
      reviewTaskPullRequest: config.reviewTaskPullRequest,
    };
  }

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
    // 冪等ガード（design.md §16.30、Issue #339 blocking指摘）: `add_task`等の計画変更
    // ツールが、レビューコメントのポーリング中（統合PR/MR作成後）に呼ばれると、新しく
    // 加わった/残った`pending`タスクの完了によって`pump()`の終了ブロックへ再度到達し、
    // `finalizeForge`が2回目として呼ばれうる（`runnerOrchestrator.ts`の
    // `resumeIfFinishedForPlanChange`のJSDoc参照）。統合PR/MRは既に作成済みのため、
    // 二重に作り直さない。`live.integrationPullRequest`は初回の作成成功時にしか
    // セットされない（このメソッドの下の方、作成成功の分岐）ため、これを唯一の
    // 判定材料にする
    if (live.integrationPullRequest !== undefined) {
      this.deps.log.info(
        `[workflow ${runId}] 統合PR/MRは既に作成済みのため、finalizeForgeの再実行を飛ばします（レビューコメントを受けた計画変更で新しいタスクが完了した後の2周目）`,
      );
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
      const number = parsePullRequestNumberFromUrl(result.pullRequest.url);
      live.integrationPullRequest = { number, url: result.pullRequest.url };
      // design.md §16.30（roadmap W5、Issue #339）: 統合PR/MRを作れたら、以後のレビュー
      // コメントを拾うポーリングを始める。番号をURLから取り出せなかった場合は、
      // `fetchReviewComments`が番号を要求するため、取得できないままログだけ残して飛ばす
      // （ready化・最終マージと同じ「番号が不明なら該当機能だけ飛ばす」方針）
      if (number === undefined) {
        this.deps.log.warn(
          `[workflow ${runId}] 統合PR/MRの番号をURLから取り出せなかったため、レビューコメントの取得を飛ばします`,
        );
      } else {
        const intervalSec =
          this.deps.readReviewCommentPollIntervalSec?.() ??
          DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC;
        startReviewCommentPoll(
          this.internals,
          runId,
          forge.host,
          live.integration.cwd,
          number,
          intervalSec,
        );
      }
    }

    // design.md §16.18「この場合、finalMerge: autoであってもmainへのマージは行わない」。
    // `shouldRunFinalMerge`/`needsFinalMergeDecision`が`created`（PR/MRを作れたか）を
    // 見て判定するため、ここではガードを重ねず素直に結果へ従う
    if (shouldRunFinalMerge(forge.finalMerge, created)) {
      // `auto`: 従来どおりPR/MR作成の直後に即マージする（design.md §16.18）
      await this.performFinalMerge(runId);
    } else if (needsFinalMergeDecision(forge.finalMerge, created)) {
      // `orchestrator` / `confirm`（design.md §16.26）: マージするかどうかの判断が
      // 付くまで待つ。判断が`merge`になったら`decideFinalMerge`が`performFinalMerge`を呼ぶ
      this.beginFinalMergeDecision(runId, forge.finalMerge as 'orchestrator' | 'confirm');
    }
    void this.persist(runId);
    this.notify(runId);
  }

  /**
   * 統合PR/MRを実際にmainへマージする（design.md §16.18「最終マージ」・§16.26）。
   *
   * `finalMerge: auto`では統合PR/MR作成の直後に`finalizeForge`から、`orchestrator`/
   * `confirm`では判断が`merge`になった時点で`decideFinalMerge`から呼ばれる。どちらの
   * 経路でも「ready化してからマージする」処理そのものは同じ（design.md §16.18の順序は
   * `finalMerge`の値と無関係に決まる）ため、ここへ集約してある。
   *
   * 呼び出し元が`notify`/`persist`を行うため、ここでは行わない
   * （`finalizeForge`は末尾で1回、`decideFinalMerge`は判断確定の警告と合わせて1回）。
   */
  private async performFinalMerge(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined || live.forge.kind !== 'active' || live.integration === undefined) {
      return;
    }
    const forge = live.forge;
    const forgeDeps = this.deps.forge;
    if (forgeDeps === undefined) {
      // 型上`forge.kind === 'active'`は`forgeDeps`が存在するときにしか作られない
      // （`resolveForgeState`参照）ため到達しない想定だが、安全側でここでも確認する
      return;
    }
    // セキュリティ監査の指摘（2026-08-23）: `finalMerge: auto`の経路（`finalizeForge`）は
    // `decideFinalMerge`（`orchestrator`/`confirm`が通る、`haltedByUser`を見るガードが
    // 既にある）を経由せずここへ直接来るため、W1（Issue #335）のガードが素通りする
    // 兄弟の穴になっていた。この関数は`auto`/`orchestrator`/`confirm`のどちらの経路
    // からも呼ばれる唯一の合流点（このJSDoc冒頭参照）なので、ここで確認すれば全経路を
    // 一様に守れる。以降のCI待ち・取り込み直しループ中の停止は`runFinalMergeWithCiGate`
    // へ渡す`isCancelled`コールバックが見る（design.md §16.36）
    if (live.runState.haltedByUser) {
      this.deps.log.warn(`[workflow ${runId}] 人が停止したため最終マージを中止しました`);
      live.warnings.push({
        kind: 'forgeFailed',
        taskId: undefined,
        message: '人が停止したため最終マージを中止しました',
      });
      live.finalMergeOutcome = 'failed';
      // design.md §16.30「レビューを取り込めるのは最終マージ確定までである」
      // （2度目のレビューblocking指摘）: `finalMergeOutcome`が確定した時点で、レビュー
      // コメントのポーリングもここで直接閉じる。詳細は`performFinalMerge`末尾の
      // 同じ呼び出しのJSDoc参照
      closeReviewCommentPoll(live);
      void this.persist(runId);
      this.notify(runId);
      return;
    }
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
          this.deps.log.warn(
            `[workflow ${runId}] 統合PR/MRのready化に失敗しました: ${ready.message}`,
          );
          live.warnings.push({
            kind: 'forgeFailed',
            taskId: undefined,
            message: `統合PR/MRのready化に失敗しました: ${ready.message}`,
          });
        }
      }
    }
    // design.md §16.18・Issue #404「番号を省略すると、マージ対象はcwdのカレント
    // ブランチに紐づくPR/MRという暗黙の状態依存になる」ため、直前に取り出した統合PR/MRの
    // 番号（`live.integrationPullRequest.number`）を明示的に渡す。番号が不明なとき
    // （URLから取り出せなかった等）は`runFinalMergeWithCiGate`自体がCLIを呼ばず警告を返す。
    // design.md §16.36（Issue #556）: マージ前にCIチェックの完了を待ち、赤・タイムアウトなら
    // マージせず失敗として確定する。「baseの最新でない」ことでの拒否は取り込み直して再試行する
    const merge = await runFinalMergeWithCiGate(
      forgeDeps.cli,
      forge.host,
      live.integration.cwd,
      live.integrationPullRequest?.number,
      {
        ...this.readCiGateConfig(),
        // CI待ちのポーリング・取り込み直しの再試行ループの各周回で、人が「全体の停止」を
        // 押したか（`disposing`＝拡張機能終了中も含む）を確認するコールバック
        // （design.md §16.36、セキュリティ監査の指摘。2026-08-23）
        isCancelled: () => live.runState.haltedByUser || this.disposing,
      },
    );
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
    // design.md §16.30「レビューを取り込めるのは最終マージ確定までである」（2度目の
    // レビューblocking指摘）: `live.finalMergeOutcome`が確定した（`merged`/`failed`）
    // この1点で、レビューコメントのポーリングを直接閉じる。
    //
    // **`closeMessagingIfFinalMergeSettled`（MCPサーバーとポーリングを同じ関数・同じ
    // 呼び出しでまとめて閉じる既存の合流点）に寄せず、ここで別途閉じることにした。**
    // 理由は`finalMerge: auto`の経路（`pump()`）が、`mayAwaitFinalMergeDecision`が
    // 偽のとき`closeMessagingIfFinalMergeSettled`を`finalizeForge`の完了を待たず
    // 同期的に呼んでしまうため（MCPを判断待ちなしで即座に閉じるための意図的な設計）。
    // この時点では`live.reviewCommentPoll`はまだ`undefined`（`startReviewCommentPoll`は
    // その後、統合PR/MR作成成功時に走る）のため、その1回きりの呼び出しでは
    // ポーリングを閉じ損なう。その後`finalMerge: auto`の経路では`closeMessagingIfFinal
    // MergeSettled`が二度と呼ばれないため、ポーリングは開いたまま残り続けていた
    // （実測: 最終マージ確定後もタイマーを600秒×10周期進めると取得CLIが11回目まで
    // 呼ばれ続ける。以前のJSDocはこれを「既存の別バグ」として前提扱いしていたが、
    // 本行で実際に直った）。`closeMessagingIfFinalMergeSettled`側の呼び出し順序を
    // 直す代わりにここで別途閉じることにしたのは、MCPを即座に閉じる`auto`の既存挙動
    // 自体は変えたくない（変えると`finalMerge: auto`でMCPが開いたままになる期間が
    // 新たに生まれ、影響範囲が広がる）ためで、`live.finalMergeOutcome`という
    // 「最終マージの判断が確定した」ことそのものを表す状態と、レビューコメントの
    // ポーリングという「その判断が付くまでは有用」な機能の寿命を直接結びつける方が
    // 素直だと判断した。`orchestrator`/`confirm`の`merge`決定・`hold`決定は、
    // 引き続き`closeMessagingIfFinalMergeSettled`（`decideFinalMerge`末尾）が
    // 両方をまとめて閉じる（`live.finalMergeDecision`を判断確定の同期処理内で先に
    // `undefined`へ戻すため、`auto`のような競合は起きない）。`closeReviewCommentPoll`
    // 自身は`live.reviewCommentPoll === undefined`なら何もしない冪等な実装
    // （`runnerReviewComments.ts`）なので、ここで重ねて呼んでも安全
    closeReviewCommentPoll(live);
    void this.persist(runId);
    this.notify(runId);
  }

  /**
   * 最終マージの判断待ちに入る（design.md §16.26、`finalMerge: orchestrator` / `confirm`）。
   *
   * `mode: 'orchestrator'`のときだけ、判断を促す通知をオーケストレーターへ送り、
   * タイムアウトタイマーを張る（応答が無ければ`decideFinalMerge`で自動的に`hold`にする）。
   * `mode: 'confirm'`は通知もタイマーも張らない。ワークフローViewの確認ボタン
   * （`confirmFinalMerge`/`holdFinalMerge`。`workflowView.ts`）から`decideFinalMerge`が
   * 直接呼ばれるのを待つだけになる。
   */
  private beginFinalMergeDecision(runId: string, mode: 'orchestrator' | 'confirm'): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const url = live.integrationPullRequest?.url;
    live.finalMergeDecision = { mode, since: (this.deps.now?.() ?? new Date()).getTime() };
    const waiterLabel = mode === 'orchestrator' ? 'オーケストレーターの判断' : '人の承認';
    pushFinalMergeWarning(
      live,
      `統合PR/MR${url !== undefined ? `（${url}）` : ''}を作成しました。mainへの最終マージは${waiterLabel}を待っています。`,
    );

    if (mode === 'orchestrator') {
      const timeoutSec = this.readFinalMergeDecisionTimeoutSec();
      notifyOrchestrator(this.internals, runId, {
        kind: 'finalMergeDecision',
        body: [
          `統合PR/MR${url !== undefined ? `（${url}）` : ''}を作成しました。`,
          'mainへ最終マージするかどうかを判断してください。',
          'get_run_statusで差分・警告欄・統合の状況を確認したうえで、decide_final_mergeツールを',
          "decision: 'merge'（mainへマージする） または decision: 'hold'（マージせずPR/MRを残す）、",
          'reason（判断の理由。必須）を添えて呼んでください。',
          `${timeoutSec}秒以内に応答が無い場合は、判断を待って無限に止まらないよう自動的にholdとして扱います。`,
        ].join('\n'),
      });
      const timer = setTimeout(() => {
        this.decideFinalMerge(
          runId,
          'hold',
          `オーケストレーターの応答が${timeoutSec}秒以内に無かったため、自動的にholdとしました。`,
        );
      }, timeoutSec * 1000);
      // `scheduleApprovalTimeout`（`runnerMerge.ts`）と同じく、テスト・プロセス終了を
      // 妨げないようにする
      timer.unref?.();
      live.finalMergeDecision.timer = timer;
    }
  }

  private readFinalMergeDecisionTimeoutSec(): number {
    return (
      this.deps.readFinalMergeDecisionTimeoutSec?.() ?? DEFAULT_FINAL_MERGE_DECISION_TIMEOUT_SEC
    );
  }

  /** `runFinalMergeWithCiGate`（`forge.ts`）へ渡す待ち時間・リトライ回数（design.md §16.36）。 */
  private readCiGateConfig(): { waitTimeoutMs: number; maxUpdateBranchRetries: number } {
    const waitTimeoutSec = this.deps.readCiWaitTimeoutSec?.() ?? DEFAULT_CI_WAIT_TIMEOUT_SEC;
    const maxUpdateBranchRetries =
      this.deps.readCiUpdateBranchMaxRetries?.() ?? DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES;
    return { waitTimeoutMs: waitTimeoutSec * 1000, maxUpdateBranchRetries };
  }

  /**
   * 最終マージの判断を確定する（design.md §16.26）。3つの経路から呼ばれる:
   * オーケストレーターの`decide_final_merge`ツール（`buildOrchestratorControlPort`）・
   * ワークフローViewの確認ボタン（`workflowView.ts`）・応答が無いままのタイムアウト
   * （`beginFinalMergeDecision`が張るタイマー）。
   *
   * `decision: 'merge'`は実際のマージを`performFinalMerge`で進める（非同期。呼び出し元は
   * 完了を待たない。`finalizeForge`が`auto`の結果を待たずに`notify`するのと同じ扱い）。
   * `'hold'`はPR/MRを残したまま`finalMergeOutcome`を`held`に確定する。**どちらも判断の
   * 内容と理由を必ず警告欄へ残す**（design.md §16.26の受入基準。人の承認を挟まない
   * `orchestrator`ではこの記録が唯一の追跡手段になる）。
   *
   * `live.finalMergeDecision`が無い（判断待ちでない・runが無い）場合は`false`を返す。
   * 二重に呼ばれても（タイムアウトと同時に人が確認した等）2回目は`false`になるだけで、
   * 二重マージ・二重の警告は起きない。
   *
   * **`live.runState.haltedByUser`（人が「全体の停止」を押した）が立っている間は
   * `decision: 'merge'`を拒否する。** ここは3経路（オーケストレーターの
   * `decide_final_merge`ツール・ワークフローViewの確認ボタン・タイムアウト）すべてが
   * 合流する根本であり、ここで守れば3経路とも一貫して守れる（`buildOrchestratorControlPort`
   * 側にも同種のガードを重ねてあるが、それだけでは`confirm`モードのボタン経路
   * （`workflowView.ts`から直接この関数を呼ぶ）を守れない。レビュー指摘）。
   * `'hold'`は拒否しない——`hold`はPR/MRを残すだけの安全な方向で、かつタイムアウトの
   * 自動`hold`呼び出しをここで止めると判断待ちが永久に解消されず、design.md §16.26の
   * 「processを無期限に止めない」という前提が壊れる。
   */
  public decideFinalMerge(runId: string, decision: FinalMergeDecision, reason: string): boolean {
    const live = this.runs.get(runId);
    const pending = live?.finalMergeDecision;
    if (live === undefined || pending === undefined) {
      return false;
    }
    if (decision === 'merge' && live.runState.haltedByUser) {
      return false;
    }
    clearTimeout(pending.timer);
    live.finalMergeDecision = undefined;
    const decisionLabel =
      decision === 'merge' ? 'merge（mainへマージする）' : 'hold（マージせずPR/MRを残す）';
    // `reason`はオーケストレーター（LLM）が生成する自由記述であり、外部由来相当
    // として扱う（design.md §16.24）。表示用の`sanitizeInlineText`で制御文字を落とし、
    // 呼び出し元（MCPツール層）の上限チェックを経ずにここへ届く経路
    // （ワークフローViewの確認ボタン・タイムアウトの`hold`）にも長さの上限を掛ける
    const safeReason = sanitizeInlineText(reason, MAX_MESSAGE_BODY_LENGTH);
    pushFinalMergeWarning(
      live,
      `最終マージの判断が確定しました: ${decisionLabel}。理由: ${safeReason === '' ? '（理由が示されませんでした）' : safeReason}`,
    );
    if (decision === 'merge') {
      void this.performFinalMerge(runId);
    } else {
      live.finalMergeOutcome = 'held';
      void this.persist(runId);
    }
    // 判断が確定したので、MCPサーバを閉じられるなら閉じる（`live.finalMergeDecision`は
    // 上で既に`undefined`へ戻してあるので、判断待ちの再チェックは通る）。
    // `performFinalMerge`は`forgeDeps.cli`（gitホストCLI）しか使わず、MCPには依存しない
    // ため、その完了を待たずに閉じてよい
    this.closeMessagingIfFinalMergeSettled(runId, getRunOutcome(live.runState));
    this.notify(runId);
    return true;
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

    // AskUserQuestion（issue #685）は「実際にユーザーが選んだ回答」を代行できない。
    // ワークフロー実行系（サブエージェント内で使えない制約はCLI側にもあるが、防御的に
    // ここでも）は自動承認の対象から外し、常に人の判断（'ask'）へ倒す。
    // 実際に選択肢を送れるのはwebviewの`answerAskUserQuestion`だけで、承認カード側の
    // 「承認」操作は`decide()`（`streamSession.ts`）が種別を見て常に拒否へ倒す安全策と
    // 二重に効く
    if (approval.kind === 'askUserQuestion') {
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
    // 承認待ちタイムアウト（Issue #579、design.md §16.39）。`runnerMerge.ts`の
    // `startMergeResolution`が`onStateChanged`で承認待ちへ入るたびにタイマーを張るのと
    // 同じ形で、`waitingApprovalSinceMs`を起点にタイマーを張る（抜けるときは
    // `onApprovalResolved`が同じ関数で張り直す）
    liveTask.waitingApprovalSinceMs = (this.deps.now?.() ?? new Date()).getTime();
    liveTask.taskApprovalTimeoutTimer = scheduleTaskApprovalTimeout(
      this.internals,
      runId,
      taskId,
      liveTask.taskApprovalTimeoutTimer,
      liveTask.waitingApprovalSinceMs,
    );
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
      // 承認待ちを抜けるので、張ってあったタイムアウトタイマーを消す（Issue #579、
      // design.md §16.39）。`waitingApprovalSinceMs`を`undefined`にして渡すと
      // `scheduleTaskApprovalTimeout`は新しいタイマーを張らずに`clearTimeout`だけ行う
      liveTask.waitingApprovalSinceMs = undefined;
      liveTask.taskApprovalTimeoutTimer = scheduleTaskApprovalTimeout(
        this.internals,
        runId,
        taskId,
        liveTask.taskApprovalTimeoutTimer,
        undefined,
      );
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
    if (this.disposing) {
      // 拡張機能の終了時の解放が呼び戻した終了（`reason`は`manual`）。ここから先は
      // `runState`の書き換え・`persist`・マージの開始まで一式が走るため、印を見て黙る
      // （`disposing`のJSDoc参照）。片付けの続きは`dispose()`が受け持つ
      return;
    }
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

    if (reason === 'taskStopped' && liveTask?.taskApprovalTimedOut === true) {
      // 承認待ちタイムアウト（Issue #579、design.md §16.39）。`stopLoop()`は理由を
      // `'taskStopped'`としてしか伝えられないため、`runnerApproval.ts`の
      // `handleTaskApprovalTimeout`が`stopLoop()`の直前に立てた印を見て、通常の
      // `'taskStopped'`（`manualStop`）とは別の`markTaskApprovalTimedOut`へ倒す
      // （`runnerMerge.ts`の`timedOutByApprovalTimeout`分岐と同じ手口）
      liveTask.taskApprovalTimedOut = false;
      liveTask.waitingApprovalSinceMs = undefined;
      live.runState = markTaskApprovalTimedOut(live.runState, live.def.tasks, taskId);
    } else {
      live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, reason);
    }

    if (reason !== 'manual' && reason !== 'interrupted') {
      // done / maxReached / stalled / failed。
      //
      // `maxReached`（回数切れ）・`stalled`（停滞、design.md §16.27、Issue #336）は
      // セッションを残す（issue #284、#336）。「続ける」（`continueTask`）が同じ会話・
      // 同じworktreeのまま再開するための唯一の足がかりで、ここで解放すると続きから
      // 走らせる手段が無くなる。停滞はCLIやセッションが壊れたわけではなく「同じ内容を
      // 繰り返しているだけ」なので、`maxReached`と同じ理由でセッションを残す価値がある。
      // 残ったセッションは、`startTask`が同じタスクを開き直すとき（「再実行」）と
      // run全体の`dispose`で解放される。worktreeは元から`done`のときしか撤去しない
      // （`shouldRemoveWorktree`）ので、こちらは変更しなくてよい。
      //
      // それ以外（done / failed）は従来どおり解放する（design.md §16.10の4）。
      // 再試行はここで新しいセッション・worktreeを新規に作るため、古いものは残さない
      if (reason !== 'maxReached' && reason !== 'stalled') {
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
    // ここに`disposing`の全面停止ガードは置かない（Issue #374のレビュー2周目）。
    //
    // 止めても足りない: `store.update`は`SerialQueue`越しで、updaterが走るのはキューが
    // 捌く時点、しかもupdaterは`live.runState`を実行時点で読み直す（issue #381）。破棄より
    // 前に積まれたpersistは入口のガードを素通りするため、汚染を防ぐには`runState`を書き換える
    // 側（`onTaskFinished`・`finishMergeResolution`・`blockMergeAfterLeaseWait`）で止めるしかない。
    //
    // 止めると害がある: `liveTask.pullRequest`・`markMergeSucceeded`・`finalMergeOutcome`は
    // `live`にしか無く、ここを通してしか永続化されない。PR作成直後や`git merge`成功直後に
    // deactivateが挟まると、確定済みの値（PRのURL・番号、マージ済み）を落としてしまい、
    // 次の起動でPRの情報が失われたり、マージ済みのタスクが`merging`のまま復元されて
    // `resumeMergeAfterReload`がやり直したりする
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    try {
      await this.deps.store.update(runId, (current) => {
        // `outcome`はupdaterの中、`live.runState`を実際に読む直前で計算する（issue #381）。
        // `store.update`は`WorkflowRunStore`内の`SerialQueue`を経由するため、この関数
        // （updater）が実際に呼ばれるのは呼び出し時点ではなくキューが捌く時点になりうる。
        // 呼び出し時点で`outcome`を計算して閉じ込めると、キューで順番待ちしている間に
        // 別の`persist()`呼び出しが`live.runState`を書き換え、`tasks`（このupdater内で
        // 都度読む最新の`live.runState`）と`outcome`（呼び出し時点のまま固定された古い値）
        // が別時点の値になる（`finishedAt`に`undefined`が付く、または早すぎる
        // `finishedAt`が`current?.finishedAt ?? ...`で上書き不能なまま固定される）
        const outcome = getRunOutcome(live.runState);
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
            pullRequestNumber:
              liveTask?.pullRequest?.number ?? current?.tasks[id]?.pullRequestNumber,
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
          // `ask_user`の回答待ち（design.md §16.33）。`finalMergeDecision`と異なり、
          // 問いの文言そのものを永続化する（`LiveRun.pendingAskUser`のJSDoc参照）。
          // `live.pendingAskUser`が無い（回答待ちでない、または答えが確定した）場合は
          // `current`も引き継がない——finalMergeOutcome等と違って「確定した値」ではなく
          // 「いま宙に浮いている問い」なので、消えたらそのまま消す
          pendingAskUser:
            live.pendingAskUser === undefined
              ? undefined
              : {
                  question: live.pendingAskUser.question,
                  choices: [...live.pendingAskUser.choices],
                  askedAt: new Date(live.pendingAskUser.since).toISOString(),
                },
          // 自動再開の実施回数（design.md §16.35、Issue #584）。`LiveRun`側に対応する
          // 状態を持たないため、`current`（前回persistした値）をそのまま引き継ぐしかない
          // （`runnerRestore.ts`側が`store.update`で直接インクリメントする）。`exactOptional
          // PropertyTypes`のため、値が無ければキー自体を書かない（`undefined`を明示代入
          // しない）
          ...(current?.autoResumeAttempts === undefined
            ? {}
            : { autoResumeAttempts: current.autoResumeAttempts }),
        };
      });
    } catch (e) {
      // `store.update`は`WorkflowRunStore`内の`SerialQueue`を経由する。`SerialQueue.enqueue`は
      // `this.tail`を必ずresolved側へ戻すため、`memento.update`（`vscode.Memento.update`）が
      // 失敗しても止まるのはその呼び出し自身が返すPromiseだけで、後続のenqueueは影響を
      // 受けない。ただしその失敗したPromiseを呼び出し元（`void this.persist(runId)`。
      // runner.ts内に多数）でcatchしていないと未ハンドルrejectになるため、ここで受け止める
      // （Issue #364。実行状態の永続化に失敗しただけで、実行中のrun自体は継続できるため
      // 状態遷移は変えない）
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.error(`[workflow ${runId}] 実行状態の永続化に失敗しました: ${message}`);
      // ログだけでは拡張機能のログ出力チャンネルを開かない限り気づけないため、
      // `live.warnings`へも積んでViewへ通知する（Issue #379）。`persist()`は実行中に
      // 何度も呼ばれ、ディスク容量不足等の失敗は同じ理由で繰り返し起きうる。
      // `orchestratorPromptOverride`（Issue #366）・`mergeBusy`（Issue #439）が
      // 採った「直近1件へ丸める」規律に揃える（`reflectPseudoWorktree`は反映1回に
      // つき1回しか警告を積まない設計で、`persist`のように高頻度で繰り返し失敗する
      // ケースを想定していないため揃えない）。警告が出た事実自体は最新の1件として
      // 残るので、丸めても「警告が出た事実が失われる」ことはない。
      live.warnings = live.warnings.filter((w) => w.kind !== 'persistFailed');
      live.warnings.push({
        kind: 'persistFailed',
        taskId: undefined,
        message: `実行状態の永続化に失敗しました: ${message}`,
      });
      this.notify(runId);
    }
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
 *
 * 引数は `retryCount` / `manualRetryCount` を個別に受け取らず、`TaskRunState`（の該当
 * 2フィールド）をまとめて受け取る。以前は呼び出し側が2引数を別々に渡す形にしていたため、
 * `runnerMerge.ts`側の撤去経路が`manualRetryCount`の受け渡しを忘れ、手動再実行後の
 * 撤去対象パスが実際に使ったworktreeと食い違う不具合があった（issue #407）。1つの
 * オブジェクトで渡す形にすることで、フィールドの渡し忘れ自体を型で防ぐ。
 */
export function retrySuffixOf(
  state: Pick<TaskRunState, 'retryCount' | 'manualRetryCount'> | undefined,
): number | undefined {
  const total = (state?.retryCount ?? 0) + (state?.manualRetryCount ?? 0);
  return total > 0 ? total - 1 : undefined;
}
