import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { buildWebGptMcpConfig, WEB_GPT_MCP_SERVER } from '../webGpt/discussion';
import { prepareWebGptDiscussion, reportDiscussionError } from './webGptDiscussionCommand';
import { isApprovalDecision } from '../appserver/approvals';
import type { OutputOffloadPort } from '../appserver/outputOffload';
import {
  isOpenableSearchUrl,
  lastNonEmptyAgentMessageText,
  type ChatItem,
  type ChatState,
  type ChatUsage,
} from '../appserver/chatState';
import { buildTranscriptMarkdown } from '../appserver/transcriptMarkdown';
import { isAskUserQuestionSelections } from '../claude/askUserQuestion';
import type { AskUserQuestionItem, AskUserQuestionSelections } from '../claude/askUserQuestion';
import { debugLogCandidates } from '../claude/cliLocator';
import { describeForkFromTurnError } from '../claude/forkFromTurn';
import { SecondOpinionRegistry } from '../secondOpinion/run';
import {
  approveSecondOpinionHandoff,
  continueSecondOpinion,
  draftSecondOpinionHandoff,
  updateSecondOpinionMaterial,
  endSecondOpinionConsult,
  startSecondOpinion,
  stopSecondOpinion,
  type SecondOpinionPanelPort,
} from './secondOpinionCommand';
import { AdvisorSessionStore } from '../secondOpinion/advisorSession';
import type { HandoffDraft } from '../secondOpinion/handoff';
import { secondOpinionParentPortFor } from './secondOpinionParent';
import {
  capSideQuestionHistory,
  describeSideQuestionError,
  describeSyntheticSideQuestionResponse,
  finishedSideQuestionDisplay,
  pendingSideQuestionDisplay,
  progressSideQuestionDisplay,
} from '../claude/sideQuestion';
import type { SideQuestionHistoryEntry } from '../claude/control';
import type { ClaudeSessionStore } from '../claude/sessionStore';
import { ClaudeStreamSession, type ClaudeSpawnPort } from '../claude/streamSession';
import { createTranscriptBuilder } from '../claude/transcript';
import { effortsFor } from '../codex/modelCatalog';
import {
  currentWorkspaceFolder,
  readChatComposerButtonsConfig,
  readChatRenderMarkdownConfig,
  readChatDensityConfig,
  readChatSkinConfig,
  readChatSendOnConfig,
  readChatTurnSummaryConfig,
  readChatEndSummaryConfig,
  readChatProsConsConfig,
  readSkillSelectConfig,
  setChatTurnSummaryEnabled,
  setChatEndSummaryEnabled,
  setChatProsConsEnabled,
  readChatLimitAutoResumeEnabled,
  setChatLimitAutoResumeEnabled,
  readReflexEnabled,
  setReflexEnabled,
  readAutoHandoffEnabled,
  readAutoHandoffAutoApprove,
  readAutoReplyConfig,
  readAutoReplyReflexConfig,
  readAutoHandoffThresholdPercent,
  readAutoHandoffSoftThresholdPercent,
  readAutoHandoffOnProfileChange,
  readAutoHandoffOnAssistantSuggestion,
  readAutoHandoffOnMilestone,
  readAutoHandoffClassifierTimeoutMs,
  readAutoHandoffRouterEnabled,
  readSessionAutoNameEnabled,
  readAutoHandoffCloseOldTab,
  readChatLoopEngineeringConfig,
  readGoalDraftConfig,
  setChatLoopEngineeringEnabled,
  readLoopAdvisorConfig,
  setLoopAdvisorEnabled,
  readLoopDoneCheckConfig,
  readClaudeConfig,
  readConfig,
  readWorkflowsConfig,
  workspaceFolderPaths,
} from '../config';
import { LoopController, normalizeLoopPlan } from '../loop/loopController';
import type { LoopPlan, LoopStatus, LoopStopReason } from '../loop/loopController';
import { lastAgentMessage } from '../loop/loopEngineering';
import { createLoopDoneCheckConfig, describeLoopDoneCheck } from '../loop/loopDoneCheck';
import type { LoopDoneCheckConfig } from '../loop/loopDoneCheck';
import { pushTurnSignature, detectStalledLoop } from '../loop/stallDetector';
import { AutoReplyAgent, autoReplyAgentCloseReasonFor } from '../chat/autoReplyAgent';
import {
  buildAutoReplyAskUserQuestionPrompt,
  describeAutoReplyStopReason,
  extractAutoReplyMessage,
  firstUserMessageText,
  hasReachedAutoReplyMaxTurns,
  isAutoReplyStop,
  parseAutoReplyAskUserQuestionResponse,
  shouldTriggerAutoReply,
  type AutoReplyStopReason,
} from '../chat/autoReply';
import {
  checkAutoReplyCompletion,
  checkAutoReplyDanger,
  describeAskUserQuestionSelections,
  judgeAutoReplyAskUserQuestion,
} from '../chat/autoReplyReflex';
import type { ReflexJudgeDeps } from '../reflex/reflexJudge';
import {
  buildClaudeSkillPrompt,
  describeSkillSelect,
  selectSkill,
  shouldSelectSkill,
  toSkillCandidates,
} from '../reflex/skillSelect';
import { SkillSelectGate } from './skillSelectGate';
import type { Logger } from '../log';
import type { SummaryRolloutDeps } from '../secondOpinion/summaryRollout';
import type { FileSystemPort, MemoryFileSystemPort, SymlinkResolution } from '../session/ports';
import { nodeMemoryFileSystem } from '../session/nodeFileSystem';
import { ClaudeUsageProbe } from '../claude/usageProbe';
import { CommandCatalog } from '../provider/commandCatalog';
import {
  CLAUDE_PSEUDO_COMMANDS,
  routePseudoCommand,
  trimmedArgsOrUndefined,
  withPseudoCommands,
  type PseudoCommandCall,
} from '../provider/pseudoCommands';
import type { SlashCommand } from '../provider/slashCommands';
import { AttachmentBox, type Attachment } from '../provider/attachments';
import { MESSAGING_MCP_SERVER_NAME } from '../orchestrator/messaging';
import type {
  SessionMessagingHost,
  SessionMessagingRegistration,
} from '../orchestrator/sessionMessagingHost';
import type {
  ApprovalHandler,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../orchestrator/taskSession';
import {
  addAttachment,
  confirmClaudeImport,
  confirmCompact,
  confirmDebugCommand,
  confirmMemoryAppend,
  confirmRewindFiles,
  confirmRunShellCommand,
  confirmStopBackgroundTask,
  confirmUsageCreditsRequest,
  createOutputOffloadPort,
  handleOpenDiffEditor,
  handleOpenDiffFile,
  handleRevertDiff,
  insertCodeIntoEditor,
  noteDropRejected,
  openChatFileLink,
  openCodeInNewFile,
  postFileMentions,
  postImageData,
  renderShell,
  reportTurnResult,
  runExportTranscript,
  runOpenItemOutput,
  STATE_POST_INTERVAL_MS,
  stoppedByUsageLimit,
} from './chatShared';
import type { FileMentionCatalog } from '../provider/fileMentions';
import { decoratePanelTitle, deriveSessionActivityState } from './sessionActivity';
import { buildSessionPanelTitle } from './sessionTitle';
import {
  appendMemoryLine,
  buildProjectMemoryCandidates,
  describeMemoryAppendResult,
  MEMORY_LAST_SELECTED_PATH_KEY,
  orderMemoryCandidates,
  resolveUserMemoryFile,
  routeInputMode,
  symlinkResolutionEquals,
  type InputModeCall,
  type MemoryCandidate,
  type MemoryModeMemento,
} from '../provider/inputModes';
import { readPersistedThreadId } from './panelState';
import { buildItemsDelta, stripHostOnlyItems, stripHostOnlyState } from './stateDelta';
import { abortAsRejection, BaseChatViewManager, type BaseChatPanel } from './chatManagerBase';
import {
  advanceCompactionCount,
  chooseHandoffPrompt,
  containsHandoffPrompt,
  detectHandoffMilestone,
  countCompactions,
  decideAutoHandoff,
  deriveHandoffBaseName,
  extractHandoffPrompt,
  endsWithUserQuestion,
  HANDOFF_PROMPT_DETECTED_REASON,
  buildHandoffSessionName,
  passesSafeBoundaryGate,
  safeBoundaryProbeKey,
  recentUserMessages,
  recentAssistantMessages,
  resolveGitBranch,
  resolveWithRetry,
  decideOldTabAfterHandoff,
  oldTabKeptMessage,
  waitForDestinationResponse,
  writeHandoffPointer,
  type DestinationResponseOutcome,
  type HandoffTrigger,
} from './handoff';
import {
  HandoffTrace,
  describeAssessment,
  describeDecision,
  describeGate,
  describeProfile,
} from './handoffTrace';
import {
  chooseHandoffModelSettings,
  pickHandoffCostPreset,
  probeSafeBoundary,
} from './handoffModelChoice';
import type { TaskAssessment } from './handoffRouter';
import {
  SerialRerun,
  type SessionAutoNameHost,
  shouldAutoName,
  summarizeSessionName,
} from './sessionAutoName';
import { appendManualSendInstructions } from './prosCons';
import type { ReviewDeliveryResult } from './localReview';
import { createGoalLoopOptions } from './goalEvaluatorFactory';
import {
  advisorDisplay,
  advisorSkippedDisplay,
  createLoopAdvisorConfig,
} from './loopAdvisorFactory';
import { buildGoalDraftReply, planGoalDraft } from './goalDraftFactory';
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES } from '../claude/types';
import { SessionModelSettingsStore, type SessionModelSettings } from '../sessionModelSettings';
import {
  APPROVAL_LEVEL_CYCLE,
  claudePermissionModeForLevel,
  isApprovalLevel,
} from '../provider/approvalLevel';
import type { ClaudeConfig } from '../claude/types';
import { pinKeyFor, type PinnedSessionStore } from '../util/pinnedSessions';
import type {
  ClaudeEditableKey,
  ClaudeSettingsSnapshot,
  SettingsProvider,
} from './settingsProvider';
import type { ChatActivity } from './chatShared';

interface ClaudePanel extends BaseChatPanel {
  // `panel` / `loop` / `disposed` / `title` / `taskManaged` / `postTimer` /
  // `approvalResolvedListeners` / `notifiedApprovalRequestIds` は`BaseChatPanel`
  // （chatManagerBase.ts）が定義済み（issue #420、#410のフォローアップ）。ここでは
  // 基底の`ChatSessionLike`より狭い`ClaudeStreamSession`へ絞るため`session`だけ再宣言する
  session: ClaudeStreamSession;
  cwd: string;
  /** 送信前の添付画像。送るまでここに溜める。 */
  attachments: AttachmentBox;
  /**
   * タスク単位の設定。`ClaudeStreamSession` は起動時の引数で固定されるため、
   * Codexと違い送信のたびに読み直す必要は無いが、Plan modeを抜けるときの
   * 戻し先（`permissionMode`）だけはグローバル設定ではなくこちらを見る。
   */
  taskConfig: ClaudeConfig | undefined;
  /** このセッションだけに適用するモデルとeffort（issue #844）。 */
  modelSettings: SessionModelSettings;
  /**
   * セカンドオピニオン（Issue #894）の重複起動判定に使うキー。タブごとに一意
   * （`chatView.ts`の`ChatPanel.secondOpinionKey`と同じ理由）。
   */
  secondOpinionKey: string;
  /**
   * ターン結果の確定検知に使う直前の`ChatState.turnCompletionSeq`（issue #939）。
   *
   * `busy`の立ち下がりは「threadが暇になったか」しか表さない。Codexは
   * `thread/status/changed`（idle）を`turn/completed`より先に送るため、その時点では
   * `turnResultText`がまだ空である。成果の通知・待機列の送信・ターン完了の通知は、
   * `busy`ではなくこの値の変化を境目にする。
   */
  lastTurnCompletionSeq: number;
  /** ループ停止検知に使う直前の値。 */
  wasLoopRunning: boolean;
  /** `setApprovalHandler` で差し込まれた自動判定。未設定なら従来通り必ず承認カードを出す。 */
  approvalHandler: ApprovalHandler | undefined;
  /**
   * `setPromptTransform` で差し込まれた本文変換。実際の送信直前に適用する
   * （design.md §16.4のテンプレート展開）。未設定ならそのまま送る。
   */
  promptTransform: ((text: string) => string) | undefined;
  /** `TaskSession.onStateChanged` のリスナー。 */
  stateListeners: Array<(state: ChatState) => void>;
  /** `TaskSession.onFinished` のリスナー。 */
  finishedListeners: Array<(reason: LoopStopReason, state: ChatState) => void>;
  /** 直近に`flushState`が送信した時刻（`STATE_POST_INTERVAL_MS`の間引き判定に使う）。 */
  lastPostAt?: number | undefined;
  /** 直近に送った会話項目。`buildItemsDelta`が次回との差分を取るための基準。 */
  sentItems?: readonly ChatItem[] | undefined;
  /**
   * このタブで送った脇道の質問の履歴（issue #334、design.md §14.62）。
   *
   * `side_question` の `history` にそのまま渡す。本流の会話（`entry.session`の
   * transcript）とは別物で、このタブを閉じれば消える（拡張機能側にも永続化しない）。
   */
  sideQuestionHistory: SideQuestionHistoryEntry[];
  limitAutoResumeTimer: ReturnType<typeof setTimeout> | undefined;
  limitAutoResumeAt: number | undefined;
  limitAutoResumeAwaitingResult: boolean;
  /**
   * 人が中断・ループ停止で自動再開を打ち切ったか（Issue #1202。`chatView.ts`と同じ扱い）。
   *
   * Claude Codeの`interrupt`は`usage`を残したまま`busy:false`を通知するため、タイマーを
   * 消すだけでは同じ操作の中で`onSessionChange`から予約が作り直される。解除は明示的な
   * 操作だけ（手動送信・ループ開始・自動続行設定のOFF→ON）。
   */
  limitAutoResumeSuppressed: boolean;
  /**
   * 自動引き継ぎ（Issue #1079）を既に始めたか。
   *
   * 閾値契機と`compact_boundary`契機のどちらが先に成立しても、1セッションにつき1回しか
   * 引き継がない（Issue #1079の確認点2）。引き継ぎ処理そのものが非同期で長いため、
   * 開始した時点で立てる。
   */
  autoHandoffStarted: boolean;
  /**
   * 直前に見た圧縮項目（`kind: 'contextCompaction'`）の件数。増えたら自動圧縮が
   * 走ったと判る。専用のイベントを`ChatState`へ足さずに済ませるため、項目を数える。
   *
   * 最初の同期を受け取るまでは `undefined`。復元や履歴からの再開では、最初の同期で
   * 過去の圧縮がまとめて届くため、`0` を基準に比較すると圧縮が走ったと誤判定する
   * （Issue #1101）。
   */
  lastCompactionCount: number | undefined;
  /**
   * 前回、安全な区切りの分類器（Issue #1090）を走らせたときの材料の鍵。
   *
   * 同じ材料で繰り返し起動しないための目印（`safeBoundaryProbeKey`）。
   */
  lastSafeBoundaryKey: string | undefined;
  /** 安全な区切りの分類器が走っている最中か。ターンが立て続けに終わっても二重に呼ばない。 */
  safeBoundaryProbing: boolean;
  /**
   * 自動引き継ぎの判定過程の記録先（Issue #1097）。
   *
   * パネルごとに持つのは、同じ理由の連続を抑えるのに直前の行を覚える必要があるため。
   * 複数のタブで共有すると、タブを跨いだだけで抑制が外れたり効きすぎたりする。
   */
  trace: HandoffTrace;
  /** 自動返信モード（Issue #1353）の「返信役」。開いていなければ`undefined`。 */
  autoReplyAgent: AutoReplyAgent | undefined;
  /** 自動返信の往復回数。上限判定（`agent.chat.autoReply.maxTurns`）に使う。 */
  autoReplyTurnCount: number;
  /** 自動返信の応答履歴（停滞検出`detectStalledLoop`用）。 */
  autoReplyHistory: string[];
  /**
   * 自動返信のReflex判定（Issue #1435）の打ち切り。OFFにしたときとタブを閉じたときに
   * abortし、結果を捨てる判定のCLIを走らせ続けない。OFFにしたら作り直す。
   */
  autoReplyReflexAbort: AbortController;
  /**
   * 自動返信中に自動回答を試みているAskUserQuestionの要求idの集合（Issue #1353）。
   *
   * 返信役への問い合わせは非同期で、その間に同じ要求へ二重に問い合わせないための
   * ガード。回答できた・できなかったのいずれでも要求はここから外れる
   * （回答できれば`state.approvals`からも消える。できなければ人の回答を待つカードが残る）。
   */
  autoReplyAskUserQuestionInFlight: Set<string>;
}

/**
 * 画面下の設定行へ送る形（`ClaudeChatViewManager.buildSettingsPayload()`の戻り値、
 * issue #420レビュー指摘）。
 *
 * 以前は`Record<string, unknown>`を返しており、webview側（`chatScript.ts`）が読む
 * キー名の打ち間違いを型検査で拾えなかった。描画はCodex画面と同じスクリプトを使うが、
 * `ClaudeSettingsSnapshot`とはキー名が異なる（`effort`→`reasoningEffort`、
 * `permissionMode`→`approvalMode`）ため`SettingsSnapshot`とも一致しない、
 * Claude Code専用の形として定義する。
 */
interface ChatSettingsPayload {
  models: ClaudeSettingsSnapshot['models'];
  efforts: ClaudeSettingsSnapshot['efforts'];
  agents: ClaudeSettingsSnapshot['agents'];
  model: string;
  reasoningEffort: string;
  approvalMode: string;
  approvalLevel: string;
  agent: string;
  defaults: {
    /** `ClaudeDefaults`と同じく、settings.jsonに指定が無ければ`undefined`。 */
    model: string | undefined;
    reasoningEffort: string | undefined;
    approvalMode: string | undefined;
    /** Claude CodeにはCodexの`sandbox`に対応する設定が無いため常に`undefined`。 */
    sandbox: undefined;
    /**
     * エージェントの既定値はsettings.jsonから読んでいない（表示のみの用途に対して
     * 追跡コストが見合わないため）。「既定 (CLI側に指定なし)」とだけ出す
     */
    agent: undefined;
  };
  profile: string;
}

const VIEW_TYPE = 'claude.chat';
const LABEL = 'Claude Code';
const LIMIT_AUTO_RESUME_INSTRUCTION = '前回の作業を続けて。現在の状態を確認してから再開して。';
const LIMIT_AUTO_RESUME_GRACE_MS = 30_000;
const LIMIT_AUTO_RESUME_RETRY_MS = 60_000;
const LIMIT_AUTO_RESUME_FALLBACK_MS = 30 * 60_000;

/**
 * Claude Codeチャットパネルの生成オプション（design.md §14.48、issue #287）。
 * `enableFindWidget: true` でCtrl+Fの検索窓を有効にする。オブジェクトの組み立てを
 * 関数として切り出すことで、`createWebviewPanel`（vscode本体のAPI）を実際に呼ばずとも
 * 内容をテストできるようにしている。
 */
export function buildClaudeChatPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true };
}

/** 行頭 `!` のシェルコマンド（issue #5）を入力するターミナルの名前。既存があれば使い回す。 */
const SHELL_COMMAND_TERMINAL_NAME = 'Agent Sessions: シェルコマンド入力';

/**
 * 行頭 `!` のシェルコマンド（issue #5）を統合ターミナルへ入力する。
 *
 * `controlPanelView.ts` の `openLoginTerminal` と同じ流儀で、**入力するだけで自動実行はしない**
 * （`sendText` の第2引数を `false` にする）。ユーザーが自分でEnterを押して初めて実行される。
 */
function openShellCommandTerminal(cwd: string, command: string): void {
  const existing = vscode.window.terminals.find((t) => t.name === SHELL_COMMAND_TERMINAL_NAME);
  const terminal =
    existing ?? vscode.window.createTerminal({ name: SHELL_COMMAND_TERMINAL_NAME, cwd });
  terminal.show();
  terminal.sendText(command, false);
}

/**
 * `TaskSessionInput` をClaude Codeの起動設定へ写す。`sandbox` はClaudeに概念が無いため使わない。
 * `agent` はタスクオーケストレーション（design.md §16）が扱う語彙に無いため常に空文字にする
 * （タスクは既定のエージェントで走る）。
 *
 * `input.mcp` が渡されていれば、タスク間メッセージング（design.md §16.21）専用のMCP
 * サーバを `--mcp-config` で渡す（実測。CLI 2.1.227で`{"mcpServers":{"<name>":{"type":
 * "http","url":...}}}`形式のJSON文字列を受け付け、`mcp_status`で`scope: "dynamic"`
 * として現れることを確認済み）。ここで組み立てる`additionalArgs`は拡張機能が完全に
 * 制御する値であり、`codex.additionalArgs`/`claude.additionalArgs`のような
 * ユーザー設定・YAMLの経路とは無関係（§16.16の信頼境界を壊さない。`TaskSessionConfig`
 * 自体に`additionalArgs`が無いことがそれを裏付ける）。
 */
function toClaudeConfig(input: TaskSessionInput): ClaudeConfig {
  return {
    model: input.config.model,
    effort: input.config.effort,
    permissionMode: input.config.approvalMode,
    agent: '',
    additionalArgs:
      input.mcp !== undefined
        ? [
            '--mcp-config',
            JSON.stringify({
              mcpServers: { [MESSAGING_MCP_SERVER_NAME]: { type: 'http', url: input.mcp.url } },
            }),
          ]
        : [],
  };
}

/**
 * Claude Code画面。`claude` を stream-json で常駐させ、会話と承認を画面内で完結させる。
 *
 * 描画はCodex画面と同じHTML（`renderShell`）を使う。プロバイダごとの差は
 * このクラスとイベント正規化（streamJson.ts）に閉じている。`TaskSessionHost` を実装し、
 * オーケストレータ（`runner.ts`。次の依頼）がプロバイダを見ずにタスクを扱えるようにする
 * （design.md §16.10）。
 */
export class ClaudeChatViewManager
  extends BaseChatViewManager<ClaudePanel>
  implements TaskSessionHost
{
  private approvalWarned = false;

  private readonly catalog: CommandCatalog;
  private readonly usageProbe: ClaudeUsageProbe;
  private commands: SlashCommand[] | undefined;
  /** セカンドオピニオン（Issue #894）の実行中管理。親セッションごとに1本へ絞る。 */
  private readonly secondOpinionRegistry = new SecondOpinionRegistry();
  /**
   * 相談を続けられるAdvisorセッションの置き場（Issue #929）。
   *
   * 実行中かどうかを見る `secondOpinionRegistry` とは寿命が違う。1ターンが終わっても
   * 相談相手のセッションは開いたままにしておき、会話（パネル）が閉じるまで持つ。
   */
  private readonly advisorStore = new AdvisorSessionStore();
  /**
   * 承認待ちの下書き（Issue #929 Handoff）。会話ごとに最新の1件だけを持つ。
   *
   * webviewへは中身を渡さない。承認して送る経路が読むのはこの値であり、画面から返って
   * きた文字列ではない——往復させると、表示のために整形した文が送信の対象になりうる。
   */
  private readonly handoffDrafts = new Map<string, HandoffDraft | undefined>();
  /**
   * セカンドオピニオンの依頼先となるCodex側のホスト（`ChatViewManager`）。
   *
   * Claude Code画面から押しても**Codexのセッション**を開く（Issue #894 の決定3。
   * この機能の値打ちはモデルの多様性ではなくコンテキストの分離にあるため、
   * プロバイダの選択は導入しない）。Claude側の管理クラスはCodexのホストを持たないので、
   * `extension.ts` が組み立て時に注入する。
   */
  private secondOpinionHost: TaskSessionHost | undefined;
  private summaryRollout: SummaryRolloutDeps | undefined;

  constructor(
    private readonly claudePath: () => string,
    private readonly fs: FileSystemPort,
    /** `@` のファイル候補。Codex画面と同じカタログを使い回す。 */
    private readonly mentions: FileMentionCatalog,
    private readonly claudeHome: string,
    private readonly store: ClaudeSessionStore,
    private readonly settings: SettingsProvider,
    private readonly log: Logger,
    private readonly onActivity: (activity: ChatActivity) => void = () => undefined,
    /** 制限の状態が更新されたときに知らせる。ステータスバーの表示に使う。 */
    private readonly onUsage: (usage: ChatUsage) => void = () => undefined,
    /**
     * このsessionIdがタスク（オーケストレータ）管理下かどうか。既定は常に`false`
     * （従来通り全セッションを汎用復元の対象にする）。`true`を返すセッションは
     * `restorePanel` の対象から外す（design.md §16.10の7）。
     */
    private readonly isTaskManagedThread: (sessionId: string) => boolean = () => false,
    /**
     * メモリ追記（issue #6/#144）専用の読み取り口。ENOENT以外の例外は投げる・
     * シンボリックリンクの実体パスを解決する、の2つを共有の `FileSystemPort` から
     * 切り出したもの（`src/session/ports.ts` を参照）。既定はNode実装。
     */
    private readonly memoryFs: MemoryFileSystemPort = nodeMemoryFileSystem,
    /**
     * 直前に選んだメモリ追記先を覚えておく口（issue #144）。`vscode.Memento` と構造的に
     * 一致するため `context.workspaceState` をそのまま渡せる（`extension.ts` 参照）。
     * 既定は何も覚えない no-op（テスト等でワークスペースを想定しない呼び出しでも壊れない）。
     */
    private readonly memoryMemento: MemoryModeMemento = {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    },
    /**
     * `claude` プロセスの起こし方（統合テストの差し替え口。Issue #186）。セッションを
     * 作るたびに読み直すので、`activate()` が終わった後からでも差し替えられる。
     * `undefined` を返す間は `ClaudeStreamSession` の既定（実際に起動する）が使われる。
     */
    private readonly resolveSpawn: () => ClaudeSpawnPort | undefined = () => undefined,
    /** モデルとeffortのセッション別保存先（issue #844）。 */
    private readonly sessionSettings?: SessionModelSettingsStore,
    /**
     * 引き継ぎのポインタファイル（Issue #1079）を書く場所。`ExtensionContext.
     * globalStorageUri.fsPath` を渡す。リポジトリ内には置かない（push事故と
     * working treeの汚れを避けるため）。未指定なら引き継ぎ自体を断る。
     */
    private readonly globalStorageDir?: string,
    /** お気に入り（Issue #1366）の永続化先。未指定なら何も永続化しないno-op。 */
    pinnedSessions?: PinnedSessionStore,
    /** タブ名の自動付け直し（Issue #1426）。渡さなければ自動で付け直さない。 */
    private readonly autoName?: SessionAutoNameHost,
  ) {
    super(pinnedSessions, 'claude');
    this.catalog = new CommandCatalog(fs);
    this.usageProbe = new ClaudeUsageProbe(claudePath, log);
  }

  private initialModelSettings(
    taskConfig?: ClaudeConfig,
    sessionId?: string,
  ): SessionModelSettings {
    const stored =
      sessionId === undefined ? undefined : this.sessionSettings?.get('claude', sessionId);
    if (stored !== undefined) {
      return stored;
    }
    const config = taskConfig ?? readClaudeConfig().claude;
    return { model: config.model, effort: config.effort };
  }

  /**
   * 通常の会話へ見せるメッセージング用MCPサーバ（Issue #1305）。`extension.ts`が立てて渡す。
   * 渡されなければ従来どおりMCPサーバ無しで開く。
   */
  private sessionMessaging: SessionMessagingHost | undefined;
  /**
   * 会話1つに割り当てたメッセージング用MCPの登録。`configFor`が起動引数を組むときに読み、
   * タブを閉じたときに`onTeardown`が失効させる。
   */
  private readonly sessionMessagingRegistrations = new WeakMap<
    ClaudePanel,
    SessionMessagingRegistration
  >();

  /** 通常の会話へ見せるメッセージング用MCPサーバを配線する（Issue #1305）。 */
  setSessionMessaging(host: SessionMessagingHost | undefined): void {
    this.sessionMessaging = host;
  }

  /**
   * この会話にメッセージング用MCPのURLを割り当て、宛先を束縛する（Issue #1305）。
   * **`session.start`より前に呼ぶ**——`configFor`が起動引数を組むときに読むため。
   *
   * タスク経路（`entry.taskConfig`がある）は`runner.ts`が立てたrun用のサーバを既に
   * `additionalArgs`へ持っているため何もしない。Claude Codeのセッションidは起動前に
   * 決まる（`target.kind`が`new`でも`resume`でも呼び出し側が値を持っている）ので、
   * Codexと違って発行と束縛を同時に済ませられる。分岐（`fork`）はCLIが新しいidを振り、
   * 拡張機能側がそれを知る手段が無いため、呼び出し元がここを通らない。
   */
  private registerSessionMessaging(entry: ClaudePanel, sessionId: string): void {
    if (entry.taskConfig !== undefined) {
      return;
    }
    const registration = this.sessionMessaging?.register('claude');
    if (registration === undefined) {
      return;
    }
    // 同じ会話に二度割り当てられた場合、古いURLはもう誰も使わない。失効させておかないと
    // サーバ側の表に残り続ける
    this.sessionMessagingRegistrations.get(entry)?.dispose();
    registration.bind(sessionId);
    this.sessionMessagingRegistrations.set(entry, registration);
  }

  /**
   * 完了宣言の検証（issue #1447）の設定を組み立てる。設定で無効なら`undefined`を返す。
   * 判定の結果は`entry`の会話へ1行残す。
   */
  private buildLoopDoneCheck(entry: ClaudePanel): LoopDoneCheckConfig | undefined {
    return createLoopDoneCheckConfig(
      readLoopDoneCheckConfig(),
      {
        provider: 'claude',
        executable: this.claudePath(),
        logWarn: (message) => this.log.warn(message),
      },
      (result, iteration) =>
        entry.session.noteLocalEvent(
          `loopDoneCheck:${Date.now()}:${iteration}`,
          describeLoopDoneCheck(result),
        ),
    );
  }

  /**
   * ワークフローのタスクが始めるループ（`TaskSession.runLoop`）へ完了宣言の検証を足す
   * （issue #1450。`chatView.ts`側と同じ）
   */
  private withLoopDoneCheck(entry: ClaudePanel, plan: LoopPlan): LoopPlan {
    if (plan.condition === '' || plan.doneCheck !== undefined) {
      return plan;
    }
    const doneCheck = this.buildLoopDoneCheck(entry);
    return doneCheck === undefined ? plan : { ...plan, doneCheck };
  }

  /** Global設定のうちモデルとeffortだけを、このセッションの値で上書きする。 */
  private configFor(entry: ClaudePanel): ClaudeConfig {
    const config = entry.taskConfig ?? readClaudeConfig().claude;
    // 他のセッションと話すためのMCPサーバ（Issue #1305）。タスク経路の`toClaudeConfig`と
    // 同じく`--mcp-config`で渡す。ここで足す値は拡張機能が完全に制御するもので、
    // 利用者設定由来の`config.additionalArgs`とは混ざらない（後ろへ足すだけ）
    const messagingUrl = this.sessionMessagingRegistrations.get(entry)?.url;
    return {
      ...config,
      model: entry.modelSettings.model,
      effort: entry.modelSettings.effort,
      additionalArgs:
        messagingUrl === undefined
          ? config.additionalArgs
          : [
              ...config.additionalArgs,
              '--mcp-config',
              JSON.stringify({
                mcpServers: { [MESSAGING_MCP_SERVER_NAME]: { type: 'http', url: messagingUrl } },
              }),
            ],
    };
  }

  private async persistModelSettings(entry: ClaudePanel, sessionId?: string): Promise<void> {
    const id = sessionId ?? entry.session.threadId;
    if (id === undefined || this.sessionSettings === undefined) {
      return;
    }
    try {
      await this.sessionSettings.set('claude', id, entry.modelSettings);
    } catch (e) {
      this.log.warn(
        `セッションのモデル設定を保存できませんでした: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * 消費率を読み直す。
   *
   * `rate_limit_event` は割合を持たないため、`/usage` を別プロセスで叩いて補う。
   * 間隔を空けるのはProbe側の責務。
   */
  private async refreshUsage(): Promise<void> {
    const usage = await this.usageProbe.read();
    if (usage !== undefined) {
      this.onUsage(usage);
    }
  }

  /**
   * 一文からゴールの下書きを組み立てる準備ターン（issue #958）。**ここではループを始めず**、
   * 下書きを画面へ返すだけにする。確認を省く設定のときだけ`start`を立てる。
   *
   * **どの経路を通っても`loop/goalDraft`を必ず1回返す**（issue #961）。webview側は要求を
   * 出した時点で開始ボタンを無効化し、この応答でだけ戻す。設定の読み出し・`git`・`gh`の
   * 実行など、下書きの生成そのものより外側で例外が出ると応答が返らず、画面が
   * 「組み立てています…」のまま操作不能で残る。下位層がどれだけ握っていても、要求と応答の
   * 境界には別に最後の受けが要る。
   *
   * `id`は要求ごとの通し番号。そのまま返して、古い応答を画面側で捨てられるようにする。
   */
  private async planGoalDraftFor(
    entry: ClaudePanel,
    rawId: unknown,
    rawText: unknown,
  ): Promise<void> {
    const reply = await buildGoalDraftReply(rawId, rawText, {
      readSettings: readGoalDraftConfig,
      plan: (text) => planGoalDraft(entry.cwd, text, 'claude', this.log),
      logWarn: (message) => this.log.warn(message),
    });
    void entry.panel?.webview.postMessage(reply);
  }

  /**
   * 入力欄の候補を送る。
   *
   * CLIが `initialize` の応答で使えるコマンドを全部返すため、そちらを優先する
   * （組込・ユーザー定義・プラグイン由来が揃っており、実在しないものは入らない）。
   * まだ届いていない、または取れなかった場合だけファイルを走査した一覧で代替する。
   */
  private async postCommands(entry: ClaudePanel): Promise<void> {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const fromCli = entry.session.commands;
    const commands =
      fromCli.length > 0
        ? fromCli
        : (this.commands ??= await this.catalog.forClaude(this.claudeHome, workspaceFolderPaths()));
    // `/btw`（脇道の質問、issue #334）はCLIの一覧に無いため、拡張機能側で先頭へ足す
    void entry.panel.webview.postMessage({
      type: 'commands',
      commands: withPseudoCommands(CLAUDE_PSEUDO_COMMANDS, commands),
    });
  }

  /**
   * 画面下の設定行に出す現在値と選択肢を組み立てる（戻り値の形は`ChatSettingsPayload`参照）。
   *
   * 描画はCodex画面と同じスクリプトなので、Codex側のスナップショットと同じ形に整えて返す。
   * モデルの一覧は `initialize` の応答から取ったもの（取れなければエイリアス）。
   * `refreshSettings`・`flushState`の両方から呼ぶ（issue #420: 揃える前は`refreshSettings`
   * だけがこれを組み立てて送っており、`flushState`経由の更新には設定が乗らなかった）。
   */
  private buildSettingsPayload(entry: ClaudePanel): ChatSettingsPayload {
    const snapshot = this.settings.claudeSnapshot();
    return {
      models: snapshot.models,
      efforts: effortsFor(snapshot.models, entry.modelSettings.model, CLAUDE_EFFORTS),
      agents: snapshot.agents,
      model: entry.modelSettings.model,
      reasoningEffort: entry.modelSettings.effort,
      approvalMode: snapshot.permissionMode,
      approvalLevel: snapshot.approvalLevel,
      agent: snapshot.agent,
      defaults: {
        model: snapshot.defaults.model,
        reasoningEffort: snapshot.defaults.effort,
        approvalMode: snapshot.defaults.permissionMode,
        sandbox: undefined,
        // エージェントの既定値はsettings.jsonから読んでいない（表示のみの用途に対して
        // 追跡コストが見合わないため）。「既定 (CLI側に指定なし)」とだけ出す
        agent: undefined,
      },
      profile: '',
    };
  }

  refreshModelCatalog(): void {
    for (const entry of this.allPanels()) {
      this.refreshSettings(entry);
    }
  }

  /**
   * 画面下の設定行へ現在値と選択肢を送る。設定パネルでの変更など、人の操作へ即座に
   * 反映したい場面でだけ呼ぶ（`postState`の間引きを待たせない）。
   *
   * 会話項目は全量を送るが、`items`キーは付けない（`flushState`と違い、この経路は
   * 差し分ではなく全量なので不要）。そのため webview 側（`chatScript.ts`の
   * `window.addEventListener('message', ...)`）は`!data.items`の枝へ入り、
   * `apply(data.state)`だけを呼んで`mergedItems`（差し分の積み先）には触れない。
   * つまりここで送った内容はwebview側の差し分の基準には反映されない。
   *
   * **`entry.sentItems`をここで更新してはならない**（issue #420レビュー指摘、HIGH）。
   * 一度`entry.sentItems = state.items`と書いたところ、webview側は上記の理由で
   * 追随していないのに、ホスト側の基準だけが進んでしまい、次の`flushState`が
   * 送る差分を`mergeItems`（`chatScript.ts`側）が`total`の不一致で`undefined`と
   * 判定 → `stateFull`要求 → 全量再送、という往復を毎回生んだ（`ready`直後に
   * `entry.sentItems = undefined`へリセットした効果も、続けて呼ばれる
   * `refreshSettings`が誤って埋め戻すことで無効化されていた）。`entry.sentItems`は
   * 従来通り`flushState`だけが更新する。
   */
  private refreshSettings(entry: ClaudePanel): void {
    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const state = entry.session.getState();
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...stripHostOnlyState(state),
        // 描画に使わない項目を落としてから送る（issue #320）。Editツール由来の
        // `editReplace` を持つのはClaude Codeの会話項目だけなので、この経路が本命
        items: stripHostOnlyItems(state.items),
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        limitAutoResumeStatus: this.limitAutoResumeStatus(entry),
        // 差分の見出し行の操作（issue #291）をWebview側でも出し分けるための一覧。
        // 権威ある判定はホスト側（handleOpenDiffFile等）が行うため、ここは
        // ボタン表示のヒントに過ぎない
        workspaceRoots: workspaceFolderPaths(),
        settings: this.buildSettingsPayload(entry),
      },
    });
  }

  /**
   * 画面へ現在の状態だけを送る（設定は含めない）。ストリーミング中の細かい更新は
   * こちらを使い、設定込みの完全な状態は `refreshSettings` が担う
   * （既存の挙動をそのまま踏襲。webview側は届かないキーを前回の値のまま保つ）。
   *
   * 呼び出し元の`onSessionChange`はNDJSONイベント1件ごとに同期的に発火する
   * （`ClaudeStreamSession.receive`）。以前は間引きが無く、`state.items`全量を
   * イベントの頻度のまま構造化クローンで直列化していた（issue #356）。
   * `chatView.ts`の`postState`/`flushState`と同じ流儀で、最初の1件はすぐ送り、
   * 以降は`STATE_POST_INTERVAL_MS`ごとにまとめる。まとめた分は必ず最後に1回
   * 送る（送り漏らして古い画面が残らないようにする）。
   */
  private postState(entry: ClaudePanel): void {
    // タブが閉じていても間引きの経路自体は回す。進捗画面（issue #721）はチャットのタブとは
    // 別のタブで、タスク管理下のセッションはタブを閉じても動き続ける（design.md §16.10）。
    // webviewへの送信は`flushState`側でタブの有無を見て止める
    if (entry.disposed || entry.postTimer !== undefined) {
      return;
    }
    const since = Date.now() - (entry.lastPostAt ?? 0);
    if (since >= STATE_POST_INTERVAL_MS) {
      this.flushState(entry);
      return;
    }
    entry.postTimer = setTimeout(() => {
      entry.postTimer = undefined;
      this.flushState(entry);
    }, STATE_POST_INTERVAL_MS - since);
  }

  /**
   * 会話項目は差し分だけを`items`へ載せ、`state.items`は空で送る（issue #356、
   * `chatView.ts`の`flushState`と同じ流儀。`stripHostOnlyItems`相当の除去は
   * `buildItemsDelta`が内部で行う）。webview側は`chatScript.ts`の`mergeItems`
   * （実装は`stateDelta.ts`の`MERGE_ITEMS_SOURCE`）で積み直す。
   *
   * `settings`も`chatView.ts`の`flushState`と同じく毎回載せる（issue #420）。以前は
   * ここで設定を送らず、`onLoopStatus`が間引きを迂回する`refreshSettings`を別途呼ぶ
   * ことで設定の反映を担っていた。`onLoopStatus`をCodexと同じ`postState`（間引き済みの
   * このメソッド）呼び出しへ揃えたため、設定もここに乗せないとループ実行中の設定反映が
   * 抜け落ちる。
   */
  /**
   * ツール出力の退避先（issue #1325）。会話ごとに作り、`session.dispose()` で破棄される。
   */
  private createOutputOffload(): OutputOffloadPort | undefined {
    return createOutputOffloadPort(this.globalStorageDir, (message) => this.log.warn(message));
  }

  private flushState(entry: ClaudePanel): void {
    if (entry.disposed) {
      return;
    }
    entry.lastPostAt = Date.now();
    const state = entry.session.getState();
    // 進捗画面（issue #721）へはタブの有無によらず配る
    this.fireStateChanged(entry, state);
    if (entry.panel === undefined) {
      // タブが閉じている間は差し分を送らない。`entry.sentItems`もここでは進めない
      // （進めると、タブを開き直したときに送られていない項目が画面から抜ける）
      return;
    }
    const items = buildItemsDelta(entry.sentItems, state.items);
    entry.sentItems = state.items;
    void entry.panel.webview.postMessage({
      type: 'state',
      state: {
        ...stripHostOnlyState(state),
        items: [],
        loop: entry.loop.getStatus(),
        attachments: entry.attachments.snapshot(),
        limitAutoResumeStatus: this.limitAutoResumeStatus(entry),
        workspaceRoots: workspaceFolderPaths(),
        settings: this.buildSettingsPayload(entry),
      },
      items,
    });
  }

  /**
   * 統合テスト専用: webview（レンダラー側のJS）から届いたふりをしたメッセージを流し込む
   * （Issue #188、`ChatViewManager.simulateWebviewMessage`（`chatView.ts`）と同じ考え方）。
   *
   * 実VSCode上の統合テストでは、拡張機能ホスト側のコードから実際のwebview（別プロセスの
   * レンダラーで動くiframe）へJSを注入してボタンのクリックやEnterキーを再現する手段が無い。
   * `attachPanel` が `panel.webview.onDidReceiveMessage` に登録しているのと同じ
   * `handleMessage` を直接呼ぶ入口をここへ用意する。本番のwebviewが送るメッセージは
   * 形が同じであれば区別なく処理されるため、実際に通る経路（承認の決定・発言の送信・
   * 設定変更・巻き戻し・行頭 `!`/`#` の処理など）はここを通しても変わらない。呼び出し口は
   * `ChatTestApi.simulateClaudeWebviewMessage`（`extension.ts`）で、
   * `AGENT_SESSIONS_INTEGRATION_TEST=1` のときだけ公開される。
   *
   * `handleMessage` 自体は同期関数だが、内部で確認ダイアログなどの非同期処理を
   * fire-and-forget（`void this.compact(entry)` 等）で呼んでいる分岐がある。それらの
   * 完了を待つ必要があるテストは、呼び出し側で `waitFor`（`helpers/waitFor.ts`）を使うこと
   * （`chatCodexApprovals.test.ts` 等、既存のwebview経由テストと同じ流儀）。
   */
  async simulateWebviewMessage(sessionId: string, message: unknown): Promise<void> {
    const entry = this.panels.get(sessionId);
    if (entry === undefined) {
      throw new Error(`webviewへメッセージを送れませんでした（画面が見つからない）: ${sessionId}`);
    }
    this.handleMessage(entry, message);
  }

  /**
   * 新しい会話を開く。idは起動前に決まるため、開いた時点で履歴と紐づく。
   *
   * 呼び出し元がその後すぐ発言を送りたい場合（`handoffToNewSession`）のために、
   * 発行した`sessionId`を返す。開けなかった場合は`undefined`。
   */
  async openNew(
    cwd?: string,
    taskConfig?: ClaudeConfig,
    modelSettings?: SessionModelSettings,
    preserveFocus = false,
    targetViewColumn?: vscode.ViewColumn,
  ): Promise<string | undefined> {
    const folder = currentWorkspaceFolder();
    const targetCwd = cwd ?? folder?.uri.fsPath;
    if (targetCwd === undefined) {
      void vscode.window.showErrorMessage(
        'Claude Codeを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return undefined;
    }

    const sessionId = randomSessionId();
    // `modelSettings` を渡す経路は引き継ぎ（Issue #1082）。CLIはmodel / effortを起動時の
    // argvで受け取るため、起動後に `entry.modelSettings` を書き換えても初回プロンプトには
    // 効かない。`buildEntry` へ渡して `configFor` が起動前に読む形にする
    const entry = this.buildEntry(targetCwd, LABEL, false, taskConfig, undefined, modelSettings);
    this.showPanel(entry, preserveFocus, targetViewColumn);
    this.panels.set(sessionId, entry);
    // 起動引数を組む`configFor`より前に割り当てる（Issue #1305）
    this.registerSessionMessaging(entry, sessionId);
    entry.session.start({
      cwd: targetCwd,
      target: { kind: 'new' },
      sessionId,
      config: this.configFor(entry),
    });
    await this.persistModelSettings(entry, sessionId);
    return sessionId;
  }

  /** 指定cwdで会話を開き、開始指示を1件だけ送る。外部UIの明示操作から使う。 */
  async openNewWithPrompt(cwd: string, prompt: string): Promise<string | undefined> {
    const sessionId = await this.openNew(cwd);
    if (sessionId === undefined) return undefined;
    const entry = this.panels.get(sessionId);
    if (entry === undefined) return undefined;
    this.dispatch(entry, prompt);
    return sessionId;
  }

  /**
   * 現在アクティブなセッションを新セッションへ引き継ぐ（issue #694、方式の変更は
   * Issue #1079）。
   *
   * 会話そのものは渡さない。`handoff.ts` が旧セッションのtranscriptの在処と読み方だけを
   * 書いたポインタファイルを1枚作り、新セッションへはそのパスを送る。組み立てにモデルは
   * 使わない。
   *
   * 人がその場で押した操作なので、引き継げなかったときは必ず理由を出す。黙って返すと
   * 「ボタンが効かない」ようにしか見えず、実機で起きても切り分けられない（Issue #1166）。
   *
   * ここで`this.active`を読むのはコマンドパレット経由の入口だから。会話下のボタンからは
   * `handoffToNewSessionIn`へ押下元のentryを渡す（Issue #1297）。
   */
  async handoffToNewSession(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      const message =
        '引き継ぐ会話が選ばれていません。引き継ぎたい会話のタブを開いてから実行してください';
      this.log.info(message);
      void vscode.window.showInformationMessage(message);
      return;
    }
    await this.handoffToNewSessionIn(entry);
  }

  private readonly handoffPreparing = new Set<ClaudePanel>();

  /**
   * 引き継ぎ元をentryで固定する。webviewのpostMessageと、タブのフォーカス切替が起こす
   * `onDidChangeViewState`は配送順が保証されない。ボタンを押した直後に別タブへ移ると
   * viewStateが先に処理され、`this.active`が別の会話に変わってしまう（Issue #1297）。
   */
  private async handoffToNewSessionIn(entry: ClaudePanel): Promise<void> {
    if (this.handoffPreparing.has(entry) || this.rejectIfInputLocked(entry)) return;
    this.handoffPreparing.add(entry);
    try {
      const sessionId = [...this.panels.entries()].find(([, v]) => v === entry)?.[0];
      if (sessionId === undefined) {
        const message =
          '引き継ぎ元のセッションIDを特定できなかったため引き継げませんでした（タブは開いたままです）';
        this.log.warn(message);
        void vscode.window.showErrorMessage(message);
        return;
      }
      await this.startHandoff(entry, sessionId, { kind: 'manual' }, true);
    } finally {
      this.handoffPreparing.delete(entry);
    }
  }

  private readonly webGptPreparing = new Set<ClaudePanel>();

  /** 三点メニューからはentryを固定し、入力中に別タブへ移っても送り先を変えない。 */
  async discussWithWebGpt(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      reportDiscussionError(new Error('議論するClaude Codeの会話を開いてください'));
      return;
    }
    await this.discussWithWebGptIn(entry);
  }

  private async discussWithWebGptIn(entry: ClaudePanel): Promise<void> {
    if (this.webGptPreparing.has(entry) || this.rejectIfInputLocked(entry)) return;
    this.webGptPreparing.add(entry);
    const assertReady = () => {
      const state = entry.session.getState();
      if (
        entry.panel === undefined ||
        ![...this.panels.values()].includes(entry) ||
        state.restore
      ) {
        throw new Error('起動元のClaude Code会話を開いてから開始してください');
      }
      if (state.busy || state.queued.length > 0) {
        throw new Error('Claude Codeの応答と送信待ちの完了後に、もう一度開始してください');
      }
    };
    try {
      assertReady();
      const request = await prepareWebGptDiscussion(true);
      if (request === undefined) return;
      assertReady();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'このClaude Code会話へWebGPT操作を接続しています',
        },
        () =>
          entry.session.ensureMcpServer(WEB_GPT_MCP_SERVER, buildWebGptMcpConfig(request.endpoint)),
      );
      assertReady();
      this.cancelLimitAutoResume(entry);
      this.noteUserAction(entry);
      this.dispatch(entry, request.prompt);
    } catch (error) {
      reportDiscussionError(error);
    } finally {
      this.webGptPreparing.delete(entry);
    }
  }

  /**
   * 引き継ぎの本体。手動操作（`handoffToNewSession`）と自動発火（`maybeAutoHandoff`）で
   * 共通に使う。
   *
   * 旧セッションは**ここでは止めない**。新セッションの初回応答が成功したことを確かめて
   * から確認ダイアログを出す（`confirmStopAfterFirstResponse`）。先に止めると、引き継ぎに
   * 失敗したときに作業を失う。
   *
   * @param notifyFailure 失敗をダイアログで知らせるか。自動発火では出さない
   *   （ユーザーが操作していないため、突然のエラー表示は驚かせるだけ。ログには残す）
   * @param preassessed 区切り判定で既に取ってある見立て（Issue #1090）。分類器の再起動を避ける
   */
  private async startHandoff(
    entry: ClaudePanel,
    sessionId: string,
    trigger: HandoffTrigger,
    notifyFailure: boolean,
    preassessed?: TaskAssessment,
  ): Promise<boolean> {
    if (this.globalStorageDir === undefined) {
      this.log.warn('引き継ぎのポインタファイルの置き場所が渡されていないため引き継げません');
      return false;
    }
    const transcriptPath = await resolveWithRetry(() =>
      this.store.resolveTranscriptPath(sessionId),
    );
    if (transcriptPath === undefined) {
      const message = '引き継ぎ元セッションのtranscriptが見つかりませんでした';
      this.log.warn(message);
      if (notifyFailure) {
        void vscode.window.showErrorMessage(message);
      }
      return false;
    }

    const state = entry.session.getState();
    const lastAssistantMessage = recentAssistantMessages(state, 1)[0];
    const gitBranch = await resolveGitBranch(entry.cwd);
    // 自動承認は自動発火（`kind !== 'manual'`）でトグルONのときだけ（Issue #1350）。
    // 手動の引き継ぎボタンでは、トグルONでも必ず確認する
    const autoApprove = trigger.kind !== 'manual' && state.autoHandoffAutoApprove;
    const choice = await chooseHandoffModelSettings(
      entry.modelSettings,
      {
        turnFailed: state.turnFailed,
        recentUserMessages: recentUserMessages(state),
        recentAssistantMessages: recentAssistantMessages(state),
        cwd: entry.cwd,
        gitBranch,
        turnEditedFiles: state.turnEditedFiles,
      },
      {
        provider: 'claude',
        executable: this.claudePath(),
        models: this.settings.claudeSnapshot().models,
        fallbackEfforts: CLAUDE_EFFORTS,
        logWarn: (message) => this.log.warn(message),
      },
      preassessed,
      // 確認はこのウィンドウのモーダルと、セッション統括ページの両方で受ける（Issue #1280）。
      // 自動承認のときは保留カード自体を出さないため、ここで作らない（Issue #1350）
      autoApprove ? undefined : this.beginPendingHandoff(entry, trigger),
      autoApprove,
    );
    if (choice === undefined) {
      // 確認で閉じられた。人が「今は引き継がない」と決めたのだから、エラーにも警告にもしない
      this.log.info('引き継ぎは確認ダイアログで中止されました');
      return false;
    }
    if (autoApprove) {
      entry.session.noteLocalEvent(
        `autoHandoffAutoApprove:${Date.now()}`,
        `自動承認で引き継ぎます（${choice.settings.model || '既定'} / ${choice.settings.effort || '既定'}）`,
      );
      this.log.info(
        `自動引き継ぎの自動承認により確認ダイアログを省略しました: ${choice.settings.model || '既定'} / ${choice.settings.effort || '既定'}`,
      );
    }
    this.log.info(
      `引き継ぎ先のmodel/effort: ${choice.settings.model || '既定'} / ${choice.settings.effort || '既定'}（${choice.reasons.join(' / ')}）`,
    );
    let pointerPath: string;
    try {
      pointerPath = await writeHandoffPointer(this.globalStorageDir, {
        provider: 'claude',
        sessionId,
        transcriptPath,
        cwd: entry.cwd,
        gitBranch,
        model: entry.modelSettings.model,
        trigger,
        turnFailed: state.turnFailed,
        busy: state.busy,
        // 回答待ちのまま引き継ぐのは残量の閾値・自動圧縮の契機だけ（Issue #1191）。その
        // ときに申し送りの質問を承諾済みと読まれないよう、状態として渡す
        awaitingUserAnswer:
          lastAssistantMessage !== undefined && endsWithUserQuestion(lastAssistantMessage),
        recentUserMessages: recentUserMessages(state),
        // 引き継ぎ元の最終応答をそのまま申し送りにする（Issue #1097）。要約しない
        ...(lastAssistantMessage === undefined ? {} : { nextSteps: lastAssistantMessage }),
        turnEditedFiles: state.turnEditedFiles,
        routerReasons: choice.reasons,
        createdAt: new Date(),
      });
    } catch (e) {
      this.reportError(e);
      return false;
    }

    // 画面に出ていないタブからの自動引き継ぎでは、新セッションを背面に開く（Issue #1101）。
    // 裏で回っているループの引き継ぎは止めたくないが、ユーザーが別のタブで作業している
    // 最中に前面を奪うのも避けたい。発火は止めず、前面化だけをやめる。
    // 手動（ボタン操作）はユーザーがその場で求めた操作なので必ず前面へ出す。見立ての
    // 取得で待っている間にタブを離れることがあり、`visible` だけで決めると背面に開く
    const preserveFocus = trigger.kind !== 'manual' && entry.panel?.visible !== true;
    // 引き継ぎ元パネルと同じ列へ開く。`panel.viewColumn`は非表示のとき
    // `undefined`になるため、`lastKnownViewColumn`（最後に見えていた列）へ落ちる
    const targetViewColumn = entry.panel?.viewColumn ?? entry.lastKnownViewColumn;
    const newSessionId = await this.openNew(
      entry.cwd,
      entry.taskConfig,
      choice.settings,
      preserveFocus,
      targetViewColumn,
    );
    if (newSessionId === undefined) {
      this.log.warn(
        '引き継ぎ先セッションを開けなかったため引き継げませんでした（旧タブはそのまま残ります）',
      );
      return false;
    }
    const newEntry = this.panels.get(newSessionId);
    if (newEntry === undefined) {
      this.log.warn(
        `引き継ぎ先セッション(${newSessionId})がパネル一覧に見つからず引き継げませんでした（旧タブはそのまま残ります）`,
      );
      return false;
    }
    // 自動引き継ぎのON/OFFは引き継ぎ先へ持ち越す。持ち越さないと、自動で引き継いだ
    // 先が毎回OFFになり、次の逼迫を人が見張る羽目になる（Issue #1079の目的と逆）
    newEntry.session.setAutoHandoff(state.autoHandoff);
    // 自動承認のON/OFFも同じ理由で持ち越す（Issue #1350）
    newEntry.session.setAutoHandoffAutoApprove(state.autoHandoffAutoApprove);
    // 自動返信のON/OFFも持ち越す（Issue #1362）。持ち越したら引き継ぎ元では止める。
    // 旧タブを残したとき、新旧2つのセッションが同じ作業を自動で進めるのを防ぐ。
    // `state`は確認ダイアログの前に取った値のため、待っている間のトグル操作を拾えるよう
    // ここで読み直す
    const autoReply = entry.session.getState().autoReply;
    newEntry.session.setAutoReply(autoReply);
    if (autoReply) {
      this.stopAutoReply(entry, 'handedOff');
    }
    // 引き継ぎ先へ名前を付ける（Issue #1145）。付けないと引き継ぎ先の表示名が初回
    // プロンプトの「前セッションの続き。…」になり、履歴もタブも見分けがつかなくなる。
    // `renameActive`と同じく保存を先にし、CLIへは副送信にする。名前を付けられなくても
    // 引き継ぎ自体は成立するので、失敗は記録に留める。
    //
    // タブ名の本体はhandoffプロンプトのIssue・MR番号と `作業:` 行から毎回作り直し、
    // 世代の印を進める（Issue #1410）。取れなければ引き継ぎ元の名前を継ぐ
    const previousName = deriveHandoffBaseName(state, entry.pinnedName);
    const handoffPrompt =
      lastAssistantMessage === undefined ? undefined : extractHandoffPrompt(lastAssistantMessage);
    const handoffName = buildHandoffSessionName({
      ...(previousName === undefined ? {} : { previousName }),
      isPinned: entry.pinnedName !== undefined && entry.pinnedName.trim() !== '',
      ...(handoffPrompt === undefined ? {} : { handoffPrompt }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
    });
    try {
      await this.store.rename(newSessionId, handoffName);
      newEntry.session.setName(handoffName);
    } catch (e) {
      this.log.warn(
        `引き継ぎ先の名前を設定できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // 送信より前に初回ターンの監視を張る（Issue #1162）。`dispatch` は今のところ同期だが、
    // 非同期になった途端にCodex側と同じ取りこぼしが起きるため、順序で先に潰しておく。
    // 送信が失敗したときに監視だけが残らないよう、その場で打ち切るのもCodex側と同じ
    const giveUp = new AbortController();
    const firstResponse = waitForDestinationResponse(newEntry, undefined, giveUp.signal);
    try {
      // 引き継ぎ元がhandoffプロンプトを出していれば、その本文だけを渡す（Issue #1354）
      this.dispatch(newEntry, chooseHandoffPrompt(pointerPath, lastAssistantMessage));
    } catch (e) {
      giveUp.abort();
      throw e;
    }
    void this.confirmStopAfterFirstResponse(entry, firstResponse);
    return true;
  }

  /**
   * 新セッションの初回応答が成功するのを待ってから、旧セッションを止める。
   *
   * 既定（`agent.autoHandoff.closeOldTab`）では確認せずに `interrupt()` とタブの後片付け
   * （`teardown`）を行う（Issue #1090。引き継ぎのたびにタブが増えるのを避ける。transcriptは
   * 残るので履歴から開き直せる）。失敗・打ち切りのときは設定にかかわらず旧セッションを
   * そのまま残す（引き継ぎ先が使い物にならないまま元を失うのを防ぐ）。
   */
  private async confirmStopAfterFirstResponse(
    oldEntry: ClaudePanel,
    firstResponse: Promise<DestinationResponseOutcome>,
  ): Promise<void> {
    const decision = decideOldTabAfterHandoff({
      outcome: await firstResponse,
      oldDisposed: oldEntry.disposed,
      oldBusy: oldEntry.session.getState().busy,
      closeOldTab: readAutoHandoffCloseOldTab(),
    });
    if (decision.action === 'keep') {
      this.log.info(oldTabKeptMessage(decision.reason));
      this.markHandoffKept(oldEntry, decision.reason);
      return;
    }
    if (decision.action === 'close') {
      this.log.info('引き継ぎ元のセッションを停止してタブを閉じます（履歴は残ります）');
      oldEntry.session.interrupt();
      this.teardown(oldEntry);
      return;
    }
    const stop = '旧セッションを停止';
    const choice = await vscode.window.showInformationMessage(
      '新しいセッションへの引き継ぎが終わりました。引き継ぎ元のセッションを停止しますか？',
      { modal: true, detail: '停止すると、この会話のタブは閉じます。transcriptは残ります。' },
      stop,
    );
    if (choice !== stop || oldEntry.disposed) {
      const reason = oldEntry.disposed ? 'disposed' : 'userDismissed';
      this.log.info(oldTabKeptMessage(reason));
      this.markHandoffKept(oldEntry, reason);
      return;
    }
    oldEntry.session.interrupt();
    this.teardown(oldEntry);
  }

  /**
   * 自動引き継ぎ（Issue #1079）の発火判定。`onSessionChange` から毎回呼ぶ。
   *
   * 契機は2つ（残量が閾値以下 / 自動圧縮が走った）だが、優先順位は付けない。先に成立した
   * 方で1回だけ引き継ぎ、`autoHandoffStarted` で二重発火を止める（Issue #1079の確認点2）。
   * 実際、`compact_boundary` が届く時点で使用量は圧縮後の値へ落ちるため、両者が同時に
   * 成立し続けることはない。
   *
   * ターン実行中は発火させない。安全な区切り（`busy` が落ちている）まで待つ。
   */
  private maybeAutoHandoff(entry: ClaudePanel, state: ChatState): void {
    const { compacted, lastCompactionCount } = advanceCompactionCount(
      entry.lastCompactionCount,
      countCompactions(state),
    );
    entry.lastCompactionCount = lastCompactionCount;

    if (entry.disposed || entry.panel === undefined) {
      return;
    }
    const trigger = decideAutoHandoff({
      enabled: state.autoHandoff,
      busy: state.busy,
      alreadyStarted: entry.autoHandoffStarted,
      // バックグラウンド実行中は残量の閾値・自動圧縮の契機でも始めない（Issue #1315）
      backgroundRunning: state.backgroundTerminals.length > 0,
      remainingPercent: state.context?.remainingPercent,
      compacted,
      thresholdPercent: readAutoHandoffThresholdPercent(),
    });
    if (trigger !== undefined) {
      this.beginAutoHandoff(entry, trigger);
      return;
    }
    void this.maybeAutoHandoffAtSafeBoundary(entry, state);
  }

  /** タブ名の自動付け直し（Issue #1426）の実行役。1セッション1本に限るためパネルごとに持つ。 */
  private readonly autoNamers = new WeakMap<ClaudePanel, SerialRerun>();

  /**
   * タブ名の自動付け直し（Issue #1426）の発火判定。ターン完了時に呼ぶ。
   *
   * 手で名前を変えたセッションと、オーケストレータが名前を指定したタスクは対象外。
   */
  private maybeAutoName(entry: ClaudePanel, state: ChatState): void {
    const sessionId = entry.session.threadId;
    if (
      this.autoName === undefined ||
      sessionId === undefined ||
      (entry.pinnedName !== undefined && entry.pinnedName.trim() !== '') ||
      !readSessionAutoNameEnabled() ||
      this.autoName.marks.has(pinKeyFor({ provider: 'claude', id: sessionId })) ||
      !shouldAutoName(state.items)
    ) {
      return;
    }
    let runner = this.autoNamers.get(entry);
    if (runner === undefined) {
      runner = new SerialRerun(
        () => this.runAutoName(entry),
        (e) =>
          this.log.warn(
            `タブ名の自動付け直しで例外が出ました: ${e instanceof Error ? e.message : String(e)}`,
          ),
      );
      this.autoNamers.set(entry, runner);
    }
    runner.request();
  }

  /** 要約して名前を付け直す。材料は実行の時点の会話から読む（走らせ直しで最新を拾うため）。 */
  private async runAutoName(entry: ClaudePanel): Promise<void> {
    const sessionId = entry.session.threadId;
    if (entry.disposed || sessionId === undefined) {
      return;
    }
    const state = entry.session.getState();
    const currentName = state.name ?? this.store.getName(sessionId);
    const name = await summarizeSessionName(
      {
        provider: 'claude',
        executable: this.claudePath(),
        logWarn: (message) => this.log.warn(message),
        run: this.autoName?.run,
      },
      { items: state.items, currentName, gitBranch: await resolveGitBranch(entry.cwd) },
    );
    // 待っている間にタブが閉じられた・会話が切り替わった・手で名前を変えられたときは捨てる
    if (
      name === undefined ||
      entry.disposed ||
      entry.session.threadId !== sessionId ||
      this.autoName?.marks.has(pinKeyFor({ provider: 'claude', id: sessionId })) ||
      name === (entry.session.getState().name ?? this.store.getName(sessionId))
    ) {
      return;
    }
    try {
      await this.store.rename(sessionId, name);
      // 保存を待つ間に手で名前を変えられたら、タブ名は手で付けた方を残す（ストアも後から
      // 書いた手の名前が勝つ）。会話が切り替わったら、今の会話のタブ名は変えない
      if (
        entry.disposed ||
        entry.session.threadId !== sessionId ||
        this.autoName?.marks.has(pinKeyFor({ provider: 'claude', id: sessionId }))
      ) {
        return;
      }
      entry.session.setName(name);
      this.log.info(`タブ名を自動で付け直しました: ${name}`);
    } catch (e) {
      this.log.warn(
        `タブ名の自動付け直しを保存できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 自動返信モード（Issue #1353）のターン終了時の発火判定。判定の中身は`chatView.ts`の
   * 同名メソッドと同じ（`shouldTriggerAutoReply`、`chat/autoReply.ts`へ集約）。
   *
   * ゲーティングは`shouldTriggerAutoReply`に任せる。既存ループが走っている間は自動返信
   * しない排他もそこに含む。送る材料は`lastAgentMessage`（直前ターンの最後のエージェント
   * 発言）で、ターンが失敗していれば材料を待たずOFFにする（Issueの停止条件
   * 「ターンが失敗した」）。
   */
  private maybeAutoReply(entry: ClaudePanel, state: ChatState, turnFinished: boolean): void {
    if (entry.disposed || !state.autoReply) {
      return;
    }
    if (turnFinished && state.turnFailed) {
      this.stopAutoReply(entry, 'turnFailed');
      return;
    }
    const shouldTrigger = shouldTriggerAutoReply({
      autoReplyEnabled: state.autoReply,
      loopRunning: entry.loop.getStatus().running && !entry.loop.isPaused,
      turnFinished,
      busy: state.busy,
      approvalsPending: state.approvals.length,
      queuedPending: state.queued.length,
      turnFailed: state.turnFailed,
    });
    if (!shouldTrigger) {
      return;
    }
    const message = lastAgentMessage(state.items);
    if (message === undefined || message.text.trim() === '') {
      return;
    }
    void this.runAutoReplyTurn(entry, message.text).catch((e: unknown) => {
      this.reportError(e);
    });
  }

  /**
   * 自動返信モードをOFFにする。返信役があれば閉じ、往復回数・応答履歴をリセットする。
   * 理由は会話へ1行残す（`noteLocalEvent`）。既にOFFなら何もしない（複数箇所から
   * 呼んでも安全にするため）。`detail`（Reflex判定の確率など）は理由に括弧で添える。
   */
  private stopAutoReply(entry: ClaudePanel, reason: AutoReplyStopReason, detail?: string): void {
    if (entry.disposed) {
      return;
    }
    const wasOn = entry.session.getState().autoReply;
    entry.session.setAutoReply(false);
    entry.autoReplyTurnCount = 0;
    entry.autoReplyHistory = [];
    // もう一度ONにしたときは、残っているカードを改めて返信役へ聞けるようにする
    entry.autoReplyAskUserQuestionInFlight.clear();
    entry.autoReplyReflexAbort.abort();
    entry.autoReplyReflexAbort = new AbortController();
    const agent = entry.autoReplyAgent;
    entry.autoReplyAgent = undefined;
    agent?.close(autoReplyAgentCloseReasonFor(reason));
    if (wasOn) {
      entry.session.noteLocalEvent(
        `autoReplyStop:${Date.now()}`,
        describeAutoReplyStopReason(reason, detail),
      );
    }
  }

  /**
   * 自動返信の1往復を実行する。返信役（`AutoReplyAgent`）が無ければ（またはこの往復のために
   * 前回閉じられていれば）ここで開く。以降は同じ返信役へ送り、周をまたいで文脈を保つ。
   *
   * 応答が停止の目印・上限到達・停滞・失敗のいずれかならモードをOFFにする。それ以外は
   * `sendFromLoop`で次のuserメッセージとして送り、会話へ「自動返信」の印を1行残す。
   */
  private async runAutoReplyTurn(entry: ClaudePanel, lastAgentMessageText: string): Promise<void> {
    if (entry.disposed) {
      return;
    }
    const config = readAutoReplyConfig();
    if (!(await this.passesAutoReplyCompletionCheck(entry, lastAgentMessageText))) {
      return;
    }
    if (entry.autoReplyAgent === undefined || entry.autoReplyAgent.isClosed()) {
      const cwd = entry.cwd ?? currentWorkspaceFolder()?.uri.fsPath;
      if (cwd === undefined) {
        this.log.warn('自動返信: ワークスペースの場所が分からないため返信役を開けません');
        this.stopAutoReply(entry, 'advisorFailed');
        return;
      }
      entry.autoReplyAgent = new AutoReplyAgent({
        host: this,
        cwd,
        model: config.model,
        timeoutMs: config.timeoutSeconds * 1000,
        originalRequest: firstUserMessageText(entry.session.getState().items) ?? '',
        log: this.log,
      });
    }
    const agent = entry.autoReplyAgent;
    if (agent.isBusy()) {
      return;
    }
    const result = await agent.reply(lastAgentMessageText);
    if (entry.disposed) {
      agent.close('tabClosed');
      return;
    }
    if (!entry.session.getState().autoReply) {
      // 待っている間にOFFにされた（人の操作等）。ここでは何もしない
      return;
    }
    if (!result.ok) {
      this.stopAutoReply(entry, 'advisorFailed');
      return;
    }
    if (isAutoReplyStop(result.response)) {
      this.stopAutoReply(entry, 'stopMarker');
      return;
    }
    entry.autoReplyTurnCount += 1;
    if (hasReachedAutoReplyMaxTurns(entry.autoReplyTurnCount, config.maxTurns)) {
      this.stopAutoReply(entry, 'maxTurns');
      return;
    }
    const message = extractAutoReplyMessage(result.response);
    const stallThreshold = readWorkflowsConfig().stallRepeatCount;
    entry.autoReplyHistory = pushTurnSignature(entry.autoReplyHistory, message, stallThreshold);
    if (detectStalledLoop(entry.autoReplyHistory, stallThreshold)) {
      this.stopAutoReply(entry, 'stalled');
      return;
    }
    if (!(await this.passesAutoReplyDangerGate(entry, message, lastAgentMessageText))) {
      return;
    }
    entry.session.noteLocalEvent(`autoReply:${Date.now()}`, `自動返信: ${message}`);
    try {
      this.sendFromLoop(entry, message);
    } catch {
      // 失敗は`sendFromLoop`内で既に報告済み。自動返信はここで止める
      this.stopAutoReply(entry, 'turnFailed');
    }
  }

  /** 自動返信のReflex判定（Issue #1435）は、会話しているClaude Codeの軽量モデルで走らせる。 */
  private autoReplyReflexDeps(entry: ClaudePanel): ReflexJudgeDeps {
    return {
      provider: 'claude',
      executable: this.claudePath(),
      logWarn: (message) => this.log.warn(message),
      signal: entry.autoReplyReflexAbort.signal,
    };
  }

  /**
   * 返信役を呼ぶ前の完了の検証（Issue #1435）。返信役へ進んでよければtrue。
   *
   * 「完了した」「人の判断が要る」と判定されたら、返信役を呼ばずに自動返信を止める。
   * 判定が失敗したときは、判定が無かったときと同じく返信役に任せる。
   */
  private async passesAutoReplyCompletionCheck(
    entry: ClaudePanel,
    lastAgentMessageText: string,
  ): Promise<boolean> {
    const reflex = readAutoReplyReflexConfig();
    if (!reflex.enabled) {
      return true;
    }
    const verdict = await checkAutoReplyCompletion(
      this.autoReplyReflexDeps(entry),
      lastAgentMessageText,
      reflex.completionThreshold,
    );
    if (entry.disposed || !entry.session.getState().autoReply) {
      return false;
    }
    if (verdict.kind === 'stop') {
      this.stopAutoReply(
        entry,
        verdict.reason === 'completed' ? 'reflexCompleted' : 'reflexNeedsHuman',
        verdict.summary,
      );
      return false;
    }
    entry.session.noteLocalEvent(
      `autoReplyReflex:${Date.now()}:completion`,
      verdict.kind === 'continue'
        ? `Reflex判定（完了の検証）: ${verdict.summary}`
        : 'Reflex判定（完了の検証）: 判定できなかったため返信役に任せます',
    );
    return true;
  }

  /**
   * 自動で送る発言・AskUserQuestionへの回答の危険度ゲート（Issue #1435）。送ってよければtrue。
   *
   * 危険と判定されたとき、判定が失敗したときは、送らずに自動返信を止める（安全側）。
   */
  private async passesAutoReplyDangerGate(
    entry: ClaudePanel,
    outgoing: string,
    context: string,
  ): Promise<boolean> {
    const reflex = readAutoReplyReflexConfig();
    if (!reflex.enabled) {
      return true;
    }
    const verdict = await checkAutoReplyDanger(
      this.autoReplyReflexDeps(entry),
      outgoing,
      context,
      reflex.dangerThreshold,
    );
    if (entry.disposed || !entry.session.getState().autoReply) {
      return false;
    }
    if (verdict.kind === 'danger') {
      this.stopAutoReply(entry, 'reflexDanger', verdict.summary);
      return false;
    }
    if (verdict.kind === 'unavailable') {
      this.stopAutoReply(entry, 'reflexDangerUnavailable');
      return false;
    }
    entry.session.noteLocalEvent(
      `autoReplyReflex:${Date.now()}:danger`,
      `Reflex判定（危険度ゲート）: ${verdict.summary}`,
    );
    return true;
  }

  /**
   * AskUserQuestionの承認カードへ、返信役に選ばせた答えを自動で返す（Issue #1353）。
   *
   * `onSessionChange`から`notifyNewApprovals`の直後に毎回呼ぶ。新しく現れた
   * `kind: 'askUserQuestion'`の要求だけを対象にし、`autoReplyAskUserQuestionInFlight`で
   * 同じ要求への二重の問い合わせを防ぐ。検証に通らない・失敗・タイムアウトのときは
   * カードをそのまま残し、人の回答を待つ（コマンド実行などの承認は対象外、Issueの
   * 確認点「対象はAskUserQuestionだけ」）。
   */
  private maybeAutoAnswerAskUserQuestion(entry: ClaudePanel, state: ChatState): void {
    if (entry.disposed || !state.autoReply) {
      return;
    }
    for (const approval of state.approvals) {
      if (approval.kind !== 'askUserQuestion' || approval.questions === undefined) {
        continue;
      }
      const key = String(approval.requestId);
      if (entry.autoReplyAskUserQuestionInFlight.has(key)) {
        continue;
      }
      // 終わっても集合から外さない。検証に通らずカードを残した要求を、状態が変わるたびに
      // 返信役へ問い直すと、人が答えるまで利用枠を消費し続けるため、1つの要求には1回だけ聞く
      entry.autoReplyAskUserQuestionInFlight.add(key);
      void this.runAutoReplyAskUserQuestionTurn(
        entry,
        approval.requestId,
        approval.questions,
      ).catch((e: unknown) => {
        this.reportError(e);
      });
    }
  }

  private async runAutoReplyAskUserQuestionTurn(
    entry: ClaudePanel,
    requestId: number | string,
    questions: AskUserQuestionItem[],
  ): Promise<void> {
    const context = lastAgentMessage(entry.session.getState().items)?.text ?? '';
    const reflex = readAutoReplyReflexConfig();
    if (reflex.enabled) {
      // 選択肢を判定で選べるなら返信役を通さない（Issue #1435）。確信度が足りない質問が
      // あれば人へ回し、判定できない（失敗・複数選択）ときだけ返信役に任せる
      const verdict = await judgeAutoReplyAskUserQuestion(
        this.autoReplyReflexDeps(entry),
        questions,
        context,
        reflex.answerThreshold,
      );
      if (entry.disposed || !entry.session.getState().autoReply) {
        return;
      }
      if (verdict.kind === 'human') {
        entry.session.noteLocalEvent(
          `autoReplyReflex:${Date.now()}:ask`,
          `Reflex判定（質問への回答）: 確信度が足りないため人の回答を待ちます（${verdict.summary}）`,
        );
        return;
      }
      if (verdict.kind === 'answer') {
        await this.answerAskUserQuestionAutomatically(
          entry,
          requestId,
          questions,
          verdict.selections,
          context,
          `Reflex判定: ${verdict.summary}`,
        );
        return;
      }
    }
    if (entry.autoReplyAgent === undefined || entry.autoReplyAgent.isClosed()) {
      const cwd = entry.cwd ?? currentWorkspaceFolder()?.uri.fsPath;
      if (cwd === undefined) {
        return;
      }
      const config = readAutoReplyConfig();
      entry.autoReplyAgent = new AutoReplyAgent({
        host: this,
        cwd,
        model: config.model,
        timeoutMs: config.timeoutSeconds * 1000,
        originalRequest: firstUserMessageText(entry.session.getState().items) ?? '',
        log: this.log,
      });
    }
    const agent = entry.autoReplyAgent;
    if (agent.isBusy()) {
      // 通常ターンの往復と重ならない想定だが、重なった場合はカードを残して次回に譲る
      return;
    }
    const result = await agent.reply(buildAutoReplyAskUserQuestionPrompt(questions));
    if (entry.disposed || !entry.session.getState().autoReply || !result.ok) {
      return;
    }
    const selections = parseAutoReplyAskUserQuestionResponse(result.response, questions);
    if (selections === undefined) {
      // 検証に通らない返事はカードを残す。会話には理由を残さない
      // （AskUserQuestion自体が承認カードとして残るため、二重に通知しない）
      return;
    }
    await this.answerAskUserQuestionAutomatically(
      entry,
      requestId,
      questions,
      selections,
      context,
      '返信役',
    );
  }

  /**
   * AskUserQuestionへ自動で回答する。送る前に危険度ゲート（Issue #1435）を通し、通らなければ
   * カードを残したまま自動返信を止める。`source`は誰が選んだかで、会話へ残す1行に添える。
   */
  private async answerAskUserQuestionAutomatically(
    entry: ClaudePanel,
    requestId: number | string,
    questions: AskUserQuestionItem[],
    selections: AskUserQuestionSelections,
    context: string,
    source: string,
  ): Promise<void> {
    const outgoing = describeAskUserQuestionSelections(questions, selections);
    if (!(await this.passesAutoReplyDangerGate(entry, outgoing, context))) {
      return;
    }
    entry.session.answerAskUserQuestion(requestId, selections);
    entry.session.noteLocalEvent(
      `autoReplyAskUserQuestion:${Date.now()}`,
      `自動返信: AskUserQuestionに自動回答しました（${source}）`,
    );
    // 自動回答も往復の1回に数える。数えないと、AskUserQuestionだけを出し続ける出力に
    // 回数上限（agent.chat.autoReply.maxTurns）が効かない
    entry.autoReplyTurnCount += 1;
    if (hasReachedAutoReplyMaxTurns(entry.autoReplyTurnCount, readAutoReplyConfig().maxTurns)) {
      this.stopAutoReply(entry, 'maxTurns');
    }
  }

  /**
   * ループへの割り込み（`LoopController.noteUserAction`）と自動返信の終了（Issue #1353の
   * 停止条件「人が入力欄から発言した、または中断ボタンを押した」）をまとめて行う。
   *
   * 自動返信のON/OFFトグル自体（`'autoReply'`メッセージ）と`'loop/start'`は、
   * 意図が異なる（切り替えた直後に自分で自分を止めてしまう／理由を`loopStarted`で
   * 正確に残したい）ため、このwrapperを経由せず`entry.loop.noteUserAction()`を直接呼ぶ。
   */
  private noteUserAction(entry: ClaudePanel): void {
    entry.loop.noteUserAction();
    this.stopAutoReply(entry, 'userAction');
  }

  /**
   * 安全な区切りでの自動引き継ぎ（Issue #1090）。判定の中身はCodex側の同名メソッドと同じ。
   *
   * 前段（`passesSafeBoundaryGate`）を通ったら、まずhandoffプロンプトの出力を決定論的に
   * 検知する（Issue #1150）。見つかれば分類器を起動せずに `assistantSuggested` で発火する
   * ため、`agent.autoHandoff.router` が無効でも動く。
   *
   * 見つからなければ分類器を起動し、`switch_safe` と、解決したmodel/effortの変化から契機を
   * 決める。同じ材料での再起動は `lastSafeBoundaryKey` で止める。
   */
  private async maybeAutoHandoffAtSafeBoundary(
    entry: ClaudePanel,
    state: ChatState,
  ): Promise<void> {
    if (!state.autoHandoff || entry.autoHandoffStarted || entry.safeBoundaryProbing) {
      return;
    }
    const softThresholdPercent = readAutoHandoffSoftThresholdPercent();
    const onProfileChange = readAutoHandoffOnProfileChange();
    const onAssistantSuggestion = readAutoHandoffOnAssistantSuggestion();
    const onMilestone = readAutoHandoffOnMilestone();
    const remainingPercent = state.context?.remainingPercent;
    const withinSoft = remainingPercent !== undefined && remainingPercent <= softThresholdPercent;
    if (!withinSoft && !onProfileChange && !onAssistantSuggestion && !onMilestone) {
      // 区切り待ちの契機が全部OFF。分類器を起動しても使い道が無い
      entry.trace.info('区切り待ちの契機が全部OFFのため分類器を起動しない');
      return;
    }
    const loopStatus = entry.loop.getStatus();
    const assistantMessages = recentAssistantMessages(state);
    const gate = {
      busy: state.busy,
      turnFailed: state.turnFailed,
      pendingApprovals: state.approvals.length,
      pendingPrompts: state.prompts.length,
      // ユーザーへ質問して終わったターンは区切りではない（Issue #1191）。見るのは最終応答
      // だけで、その前の応答の質問は既に答えられている
      awaitingUserAnswer: endsWithUserQuestion(assistantMessages.at(-1) ?? ''),
      queued: state.queued.length,
      // `running` は `pause()` 中も true のまま。返信待ちで止まっているループを「実行中」と
      // 数えると、`/loop` 運用では区切り系の契機が全部塞がる（Issue #1097）
      loopRunning: loopStatus.running && !entry.loop.isPaused,
      taskManaged: entry.taskManaged,
      // バックグラウンドのプロセスが走っている間は区切りではない（Issue #1307）。完了時に
      // 引き継ぎ元が再び動くため、ここで引き継ぐと両方のセッションが同じ作業を進める
      backgroundRunning: state.backgroundTerminals.length > 0,
    };
    if (!passesSafeBoundaryGate(gate)) {
      entry.trace.info(`gate blocked (${describeGate(gate)})`);
      return;
    }
    // handoffプロンプトそのものが出力されていれば、分類器を待たずに発火する（Issue #1150）。
    // 書式は `handoff` skillで固定されているため決定論的に拾える。分類器が無効・時間切れ・
    // JSON不正のときに `assistantSuggested` が丸ごと素通りしていたのをここで塞ぐ
    if (onAssistantSuggestion && assistantMessages.some(containsHandoffPrompt)) {
      entry.trace.info('handoffプロンプトを検知したため分類器を経由せず判定する');
      const detected = decideAutoHandoff({
        enabled: state.autoHandoff,
        busy: state.busy,
        alreadyStarted: entry.autoHandoffStarted,
        // 直前の`passesSafeBoundaryGate`で偽と確かめた値だが、呼び出しの形を揃えておく
        // （Issue #1315）。ここだけ渡さないと、後で前段の条件が変わったときに漏れる
        backgroundRunning: state.backgroundTerminals.length > 0,
        remainingPercent,
        compacted: false,
        thresholdPercent: readAutoHandoffThresholdPercent(),
        softThresholdPercent,
        // 分類器を呼んでいないので `switchSafe` は無い。`safeBoundary` を渡さないことで
        // `softThreshold` / `profileChanged` の分岐には落ちず `assistantSuggested` になる
        boundaryGatePassed: true,
        handoffSuggested: true,
        handoffSuggestReason: HANDOFF_PROMPT_DETECTED_REASON,
      });
      if (detected !== undefined) {
        entry.trace.info(describeDecision(detected));
        this.beginAutoHandoff(entry, detected);
        return;
      }
      entry.trace.info('handoffプロンプトを検知したが契機が成立しなかった');
    }
    // 作業の節目（Issue起票・PR/MR作成・マージ）のコマンドが成功して終わったターンは、
    // 分類器を待たずに発火する（Issue #1351）。履歴から開いた直後は過去のターンを拾わない
    // よう、このパネルでターンが1回以上終わっていることを求める
    const milestone =
      onMilestone && state.turnCompletionSeq > 0 ? detectHandoffMilestone(state.items) : undefined;
    if (milestone !== undefined) {
      entry.trace.info(`作業の節目を検知したため分類器を経由せず判定する（${milestone.command}）`);
      const detected = decideAutoHandoff({
        enabled: state.autoHandoff,
        busy: state.busy,
        alreadyStarted: entry.autoHandoffStarted,
        backgroundRunning: state.backgroundTerminals.length > 0,
        remainingPercent,
        compacted: false,
        thresholdPercent: readAutoHandoffThresholdPercent(),
        boundaryGatePassed: true,
        milestone,
      });
      if (detected !== undefined) {
        entry.trace.info(describeDecision(detected));
        this.beginAutoHandoff(entry, detected);
        return;
      }
      entry.trace.info('作業の節目を検知したが契機が成立しなかった');
    }
    if (!readAutoHandoffRouterEnabled()) {
      // 分類器が無いと `switchSafe` も分類器経由の `handoffSuggested` も得られない。残りの
      // 区切り待ちの契機は全部この判定に依存しているため、ここで止める（残量の閾値契機は
      // 別経路で発火する）
      entry.trace.info('分類器が無効（agent.autoHandoff.router=false）のため発火しない');
      return;
    }
    const messages = recentUserMessages(state);
    if (messages.length === 0) {
      // 材料が無い（開いた直後・復元直後）。分類させても中身の無い見立てが返るだけ
      entry.trace.info('材料が無いため分類器を起動しない（ユーザー指示の記録なし）');
      return;
    }
    const key = safeBoundaryProbeKey(messages, assistantMessages);
    if (key === entry.lastSafeBoundaryKey) {
      entry.trace.info('前回と同じ材料のため分類器を起動しない');
      return;
    }
    entry.lastSafeBoundaryKey = key;

    const gitBranch = await resolveGitBranch(entry.cwd);
    entry.safeBoundaryProbing = true;
    entry.trace.info('分類器を起動する');
    const startedAt = Date.now();
    let probe;
    try {
      probe = await probeSafeBoundary(
        entry.modelSettings,
        {
          turnFailed: state.turnFailed,
          recentUserMessages: messages,
          recentAssistantMessages: assistantMessages,
          cwd: entry.cwd,
          gitBranch,
          turnEditedFiles: state.turnEditedFiles,
        },
        {
          provider: 'claude',
          executable: this.claudePath(),
          models: this.settings.claudeSnapshot().models,
          fallbackEfforts: CLAUDE_EFFORTS,
          timeoutMs: readAutoHandoffClassifierTimeoutMs(),
          logWarn: (message) => entry.trace.warn(message),
        },
      );
    } finally {
      entry.safeBoundaryProbing = false;
    }
    entry.trace.info(`分類器の応答まで${Date.now() - startedAt}ms`);
    if (probe === undefined) {
      // 失敗の理由（時間切れ / 起動失敗 / JSON不正）は `classifyHandoff` がwarnで出す
      entry.trace.info('分類できなかったため発火しない（理由は直前のwarnを見る）');
      return;
    }
    entry.trace.info(describeAssessment(probe.assessment));
    entry.trace.info(describeProfile(probe));
    // 分類器を待っている間に状況が変わっていることがある（新しい指示・引き継ぎ済み）
    const latest = entry.session.getState();
    if (entry.disposed || entry.autoHandoffStarted || latest.busy || !latest.autoHandoff) {
      entry.trace.info('分類器を待つ間に状況が変わったため発火しない');
      return;
    }
    const trigger = decideAutoHandoff({
      enabled: latest.autoHandoff,
      busy: latest.busy,
      alreadyStarted: entry.autoHandoffStarted,
      // 分類器を待つ間にバックグラウンド実行が始まっていれば止める（Issue #1315）
      backgroundRunning: latest.backgroundTerminals.length > 0,
      remainingPercent,
      compacted: false,
      thresholdPercent: readAutoHandoffThresholdPercent(),
      softThresholdPercent,
      // `assistantSuggested` だけは `switchSafe` を要求しない（Issue #1097）
      boundaryGatePassed: true,
      safeBoundary: probe.switchSafe,
      handoffSuggested: onAssistantSuggestion && probe.handoffSuggested,
      handoffSuggestReason: probe.handoffSuggestReason,
      // 前段の決定論の検知（末尾行だけを見る）が取りこぼした回答待ちをここで止める
      // （Issue #1191）
      awaitingUserAnswer: probe.awaitingUserAnswer,
      profileChanged: onProfileChange && probe.profileChanged,
      profile: probe.profile,
      switchReason: probe.switchReason,
    });
    entry.trace.info(describeDecision(trigger));
    if (trigger === undefined) {
      return;
    }
    this.beginAutoHandoff(entry, trigger, probe.assessment);
  }

  /** 自動引き継ぎを1回だけ開始する。契機の決め方によらず共通の後始末をここに集める。 */
  private beginAutoHandoff(
    entry: ClaudePanel,
    trigger: HandoffTrigger,
    preassessed?: TaskAssessment,
  ): void {
    const sessionId = [...this.panels.entries()].find(([, v]) => v === entry)?.[0];
    if (sessionId === undefined) {
      return;
    }
    // 失敗しても戻さない。戻すとターンが終わるたびに引き継ぎを試し続けることになる
    // （`resolveWithRetry` が既に短時間のリトライを持っている）。失敗はログに残るので、
    // 引き継ぎたい場合はトグルを入れ直すか手動の引き継ぎを使う
    entry.autoHandoffStarted = true;
    entry.session.noteLocalEvent(
      `autoHandoff:${Date.now()}`,
      '自動引き継ぎを開始しました。新しいセッションへ引き継ぎます',
    );
    void this.startHandoff(entry, sessionId, trigger, false, preassessed).catch((e: unknown) =>
      this.log.warn(
        `自動引き継ぎが例外で止まりました: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /**
   * タスク用のセッションを開く（`TaskSessionHost`）。
   *
   * タスクは無人で走るため、`openNew` の「安全でない組み合わせの確認ダイアログ」は
   * 経由しない（応答する人がおらず、出しても永久に止まるだけ）。タスク単位の設定を
   * 安全側へ収める判定（クランプ）はrunner.ts側の責務。パネルはここでは作らない
   * （`TaskSession.open()` の役目。design.md §16.10の2）。
   */
  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    const taskConfig = toClaudeConfig(input);
    const sessionId = randomSessionId();
    // オーケストレーターセッション（design.md §16.23）・衝突解決セッション
    // （Issue #413 PR4）はタスクと同じ経路で開くが、タブ名だけ分けて人が見分けられるように
    // する（組み立ては`sessionTitle.ts`。Issue #533）
    const title = buildSessionPanelTitle(input, LABEL);
    const entry = this.buildEntry(input.cwd, title, true, taskConfig, title);
    // パネルを作る（`TaskSession.open`）前に決める。HTMLの組み立てで入力欄の有無が決まる
    entry.inputLock = input.inputLock === true;
    this.panels.set(sessionId, entry);
    entry.session.start({
      cwd: input.cwd,
      target: { kind: 'new' },
      sessionId,
      config: this.configFor(entry),
    });
    await this.persistModelSettings(entry, sessionId);
    return this.buildTaskSession(entry, sessionId, input.mcp !== undefined);
  }

  /** 既存のセッションを開く。過去のやり取りはtranscriptから復元する。 */
  async openThread(sessionId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(sessionId);
    if (existing !== undefined) {
      this.showPanel(existing, false);
      return;
    }

    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.buildEntry(
      folder,
      `${LABEL}: ${title}`,
      false,
      undefined,
      undefined,
      this.initialModelSettings(undefined, sessionId),
    );
    this.showPanel(entry, false);
    this.panels.set(sessionId, entry);
    // 起動引数を組む`configFor`より前に割り当てる（Issue #1305）
    this.registerSessionMessaging(entry, sessionId);
    const transcript = await this.readTranscript(sessionId);
    entry.session.start({
      cwd: folder,
      target: { kind: 'resume', sessionId },
      sessionId: undefined,
      config: this.configFor(entry),
      initialItems: transcript.items,
      initialTodos: transcript.todos,
      initialTodoHistory: transcript.todoHistory,
      // 人が付けた名前があれば開いた時点からタブ名に反映する（issue #199）
      initialName: this.store.getName(sessionId),
    });
  }

  /**
   * セッション全体を分岐して開く（issue #218、design.md §14.40）。
   *
   * `-r <id> --fork-session` はCLIが分岐先の新しいセッションidを自分で振る。Codexのように
   * idを起動前にこちらで決めて渡す手段が無い（`argvBuilder.ts`の`targetArgs`参照）ため、
   * `ClaudeStreamSession.start()`へは`sessionId: undefined`を渡す。これにより
   * `state.threadId`はこのタブが生きている間ずっと確定しないままになる
   * （`streamSession.ts`の`start()`が`options.target.kind === 'resume'`のときだけ
   * `target.sessionId`を採用し、それ以外は`options.sessionId`＝`undefined`をそのまま
   * 使うため）。`threadId`が`undefined`のままだと、`dispatch()`の作業記録
   * （`onActivity`呼び出し）は`sessionId !== undefined`のガードで送らず、
   * `chatScript.ts`の`apply()`も`state.threadId`が真値でなければ`vscode.setState`を
   * 呼ばない。つまり復元（`restorePanel`）にも作業記録（design.md §16.12）にも乗らない、
   * という仕様どおりの挙動が、特別な分岐を足さなくても自然に成り立つ。
   *
   * `this.panels`のキーだけは実セッションidと衝突しないよう`fork:`を接頭辞にした合成キー
   * にする（実CLIのセッションidは常にUUID形式でこの接頭辞を含まない）。このキーは
   * ローカルの管理にしか使わず、CLIへは渡らない。
   *
   * 黙って「復元されないタブ」を作らないため（issue #218の受入基準）、開いた直後に
   * その旨を会話へ1行残す。事前の確認ダイアログにはしなかった。分岐そのものは元の
   * セッションを傷つけない可逆な操作で、`openDebugLog`（issue #205、design.md §14.39）
   * と同じく「壊れる・戻せない操作ではない」ため、都度の確認より会話に残る記録のほうが
   * 低摩擦かつ後から見返せると判断した。
   */
  async openFork(sessionId: string, title: string, cwd: string | undefined): Promise<void> {
    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.buildEntry(
      folder,
      `${LABEL}: ${title}`,
      false,
      undefined,
      undefined,
      this.initialModelSettings(undefined, sessionId),
    );
    this.showPanel(entry, false);
    this.panels.set(`fork:${randomUUID()}`, entry);
    entry.session.start({
      cwd: folder,
      target: { kind: 'fork', sessionId },
      sessionId: undefined,
      config: this.configFor(entry),
    });
    entry.session.noteLocalEvent(
      `forkNotice:${randomUUID()}`,
      'このタブは元のセッションを分岐したものです。新しいセッションidはCLIが振るため拡張機能からは追跡できず、このタブはウィンドウ再読み込み後の復元と作業記録（日報・週報）の対象外になります。',
    );
  }

  /**
   * 会話の途中のターンから分岐する（issue #333、design.md §14.61）。Codex画面の
   * 「ここから分岐」（`chatView.ts`の`forkFrom`）に相当する、Claude Code版の入口。
   *
   * 対象は`chatScript.ts`の`turnForkTarget`（`SHOW_TURN_FORK`）が渡す、押した発言自身の
   * uuid。`entry.session.threadId`が未確定（`system/init`をまだ受け取っていない、または
   * CLIが異常終了した後）の間は分岐先を特定できないため実行しない。ボタンが押せているのに
   * 無言で何も起きないと壊れているように見える（issue #340横断レビュー指摘）ため、
   * その旨を通知する。
   *
   * `resendText`を渡すと「送った指示を書き直して送り直す」（issue #1073）になる。
   * 戻り先の決め方も開くタブも分岐と同じで、違いは戻し切ったあとに入力欄へ本文を挿すか
   * （分岐）、書き直した本文をそのまま送るか（書き直し）だけ。
   */
  private async forkFromTurn(
    entry: ClaudePanel,
    targetUuid: string,
    resendText?: string,
    restoreFiles = false,
  ): Promise<void> {
    if (restoreFiles && entry.session.getState().busy) {
      void vscode.window.showErrorMessage('実行中の会話を停止してからファイルを戻してください');
      return;
    }
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      void vscode.window.showErrorMessage(
        'セッションidが確定していないため分岐できません。応答が始まってからやり直してください。',
      );
      return;
    }
    const userMessageUuids = entry.session
      .getState()
      .items.filter((item) => item.kind === 'userMessage')
      .map((item) => item.id);

    await this.openForkFromTurn(
      threadId,
      resendText === undefined ? '分岐' : '修正',
      entry.cwd,
      userMessageUuids,
      targetUuid,
      resendText,
      restoreFiles ? async () => this.rewindFiles(entry, targetUuid, true) : undefined,
    );
  }

  /**
   * 指定したターンの手前までを引き継いだ新しいセッションを、新しいタブで開く
   * （issue #333、design.md §14.61）。
   *
   * `openFork`（セッション全体の分岐）と同じ経路でまずforkし、開いた新しいセッションへ
   * `rewind_conversation`を逐次送って対象の発言の手前まで戻す（`ClaudeStreamSession.
   * rewindConversationToTurn`参照）。元のセッション（`sessionId`が指す会話）へは
   * 一切送らない。ファイルは巻き戻らない（design.md §14.61）。
   *
   * 戻し切れると応答の`prefillText`（対象の発言本文）を入力欄へ挿す。既存の
   * `insertComposerText`（issue #292、エディタの選択範囲を挿す機構）をそのまま流用する
   * （新しいタブの入力欄は空のため、追記と設定は同じ結果になる）。
   *
   * 逐次rewindが途中で失敗した場合（issue #494のレビュー指摘）は
   * `ForkFromTurnResult.succeededCount`で2通りに分ける。
   * - 0件（1件も戻せていない）: fork側のCLIは何も削除していないため、開いたばかりの
   *   新しいタブを黙って閉じる（`teardown`）。元のタブは無傷なので操作をやり直せる
   * - 1件以上（途中まで戻ってから失敗）: fork側のCLIは既に一部のユーザー発言を削除済みで、
   *   タブの会話状態は中途半端。タブは閉じずに残し、`noteLocalEvent`でタブ自身に
   *   不整合な状態であることを明示し、そのまま入力を続けないよう促す
   */
  async openForkFromTurn(
    sessionId: string,
    title: string,
    cwd: string | undefined,
    userMessageUuids: readonly string[],
    targetUuid: string,
    resendText?: string,
    beforeResend?: () => Promise<boolean>,
  ): Promise<void> {
    const folder = cwd ?? currentWorkspaceFolder()?.uri.fsPath;
    if (folder === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      return;
    }

    const entry = this.buildEntry(
      folder,
      `${LABEL}: ${title}`,
      false,
      undefined,
      undefined,
      this.initialModelSettings(undefined, sessionId),
    );
    this.showPanel(entry, false);
    this.panels.set(`fork:${randomUUID()}`, entry);
    entry.session.start({
      cwd: folder,
      target: { kind: 'fork', sessionId },
      sessionId: undefined,
      config: this.configFor(entry),
    });
    entry.session.noteLocalEvent(
      `forkNotice:${randomUUID()}`,
      'このタブは元のセッションを分岐したものです。新しいセッションidはCLIが振るため拡張機能からは追跡できず、このタブはウィンドウ再読み込み後の復元と作業記録（日報・週報）の対象外になります。',
    );

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          resendText === undefined
            ? 'この指示から分岐しています…'
            : 'この指示を書き直して送り直しています…',
      },
      () => entry.session.rewindConversationToTurn(userMessageUuids, targetUuid),
    );

    if (!result.ok) {
      const reason = describeForkFromTurnError(result.error);
      if (result.succeededCount === 0) {
        // 1件も戻せていない＝fork側のCLIは何も削除していない。新しいタブを黙って
        // 閉じれば無害（元のタブは無傷）
        this.teardown(entry);
        void vscode.window.showErrorMessage(`この指示から分岐できませんでした: ${reason}`);
        return;
      }
      // 途中まで戻ってから失敗＝fork側のCLIは既に一部のユーザー発言を削除済み。
      // タブは閉じず、不整合な状態であることを画面上に明示する
      const warning =
        'この指示への分岐が途中で失敗しました。会話は一部だけ巻き戻った不整合な状態です。' +
        `このタブへ入力を続けず、閉じてやり直してください（${reason}）`;
      entry.session.noteLocalEvent(`forkFromTurnFailed:${randomUUID()}`, warning);
      void vscode.window.showErrorMessage(warning);
      return;
    }
    // 書き直し（issue #1073）は、戻し切った会話へ書き直した本文をそのまま送る。
    // 分岐のときだけ、CLIが返した元の本文（prefillText）を入力欄へ挿して人に委ねる
    if (resendText !== undefined) {
      if (beforeResend && !(await beforeResend())) return;
      this.dispatch(entry, resendText);
      return;
    }
    if (result.prefillText !== undefined && result.prefillText !== '') {
      void entry.panel?.webview.postMessage({
        type: 'insertComposerText',
        text: result.prefillText,
      });
    }
  }

  /**
   * 擬似コマンドを実行する。CLIへは何も送らない（`chatView.ts`の`runPseudoCommand`と
   * 同じ考え方）。Claude Code画面は`CLAUDE_PSEUDO_COMMANDS`（`/btw`と`/clear`）しか
   * 候補に出さないため、ここへ来る要求はそのどちらかになる。
   */
  private async runPseudoCommand(entry: ClaudePanel, call: PseudoCommandCall): Promise<void> {
    if (call.action === 'clearConversation') {
      if (call.args !== '') {
        this.log.warn(`/${call.name} は引数を受け取らないため無視します: ${call.args}`);
      }
      // クリアアイコン（`claude.clearChat`）と同じ実処理。確認・タスク管理下の拒否も共通
      await this.clearEntry(entry);
      return;
    }
    if (call.action !== 'sideQuestion') {
      // CLAUDE_PSEUDO_COMMANDSに無い動作がここへ来ることは無いが、将来増えたときに
      // 黙って何も起きない状態を作らないよう、判る形で残す
      this.log.warn(`Claude Code画面が扱わない擬似コマンドです: ${call.name}`);
      return;
    }
    const question = trimmedArgsOrUndefined(call.args);
    if (question === undefined) {
      void vscode.window.showErrorMessage(
        '脇道の質問を入力してください（例: /btw 今のタイムゾーンは？）',
      );
      return;
    }
    await this.startSideQuestion(entry, question);
  }

  /** `extension.ts` から、セカンドオピニオンの依頼先（Codex側のホスト）を注入する。 */
  setSecondOpinionHost(host: TaskSessionHost): void {
    this.secondOpinionHost = host;
  }

  /**
   * 要約セッション（Codex側）のrolloutを消すための口を`extension.ts`から注入する（Issue #942）。
   *
   * この画面はCodexのホーム（`CODEX_HOME`）を持たないため、自前では組み立てられない。
   */
  setSummaryRollout(deps: SummaryRolloutDeps): void {
    this.summaryRollout = deps;
  }

  /**
   * セカンドオピニオン（Issue #894）を起動する。
   *
   * 脇道の質問（`startSideQuestion`）と違い、この会話は一切渡さない。独立したCodex
   * セッションが起動時点の成果物と依頼文だけを見て評価し、その結果をこの会話へ表示する
   * （この会話へ発言として送り返すことはしない）。
   */
  private async startSecondOpinionFor(entry: ClaudePanel): Promise<void> {
    const host = this.secondOpinionHost;
    if (host === undefined) {
      void vscode.window.showErrorMessage('セカンドオピニオンの依頼先（Codex）を利用できません');
      return;
    }
    await startSecondOpinion(
      this.secondOpinionPortFor(entry),
      host,
      this.secondOpinionRegistry,
      this.log,
      undefined,
      undefined,
      this.advisorStore,
    );
  }

  /**
   * パネルが閉じたら相談相手も閉じる（Issue #929）。
   *
   * 会話が消えた後もセッションが生き残ると、誰にも見えないままCodexのプロセスと
   * ロールアウトだけが増える。
   */
  protected override onTeardown(entry: ClaudePanel): void {
    // タブを閉じたら、この会話に割り当てたメッセージング用MCPのURLを失効させる（Issue #1305）
    this.sessionMessagingRegistrations.get(entry)?.dispose();
    this.sessionMessagingRegistrations.delete(entry);
    this.cancelLimitAutoResume(entry);
    endSecondOpinionConsult(entry.secondOpinionKey, this.advisorStore, 'parentDisposed');
    this.handoffDrafts.delete(entry.secondOpinionKey);
    // 自動返信（Issue #1353）の返信役も同じ理由で残さない（元のタブを閉じたとき）
    entry.autoReplyAgent?.close('tabClosed');
    entry.autoReplyAgent = undefined;
    entry.autoReplyReflexAbort.abort();
  }

  /** 拡張機能の終了時に、残っている相談相手をすべて閉じる（Issue #929）。 */
  protected override onDispose(): void {
    this.advisorStore.closeAll('shutdown');
    this.handoffDrafts.clear();
  }

  /**
   * セカンドオピニオンの差し込み口を1つ作る。
   *
   * 起動（`startSecondOpinion`）と追加の相談（`continueSecondOpinion`）で同じものを使う。
   */
  private secondOpinionPortFor(entry: ClaudePanel): SecondOpinionPanelPort {
    return {
      // 親のターンが走っている間は、セッションを開く直前で待たせる（Issue #949）
      ...secondOpinionParentPortFor(entry),
      parentSessionId: entry.secondOpinionKey,
      cwd: entry.cwd,
      lastAssistantResponse: () => lastNonEmptyAgentMessageText(entry.session.getState().items),
      // 要約（Issue #903）の入力。画面が持っている項目から組み立てるだけで、
      // 親セッションへは何も送らない
      conversationTranscript: () =>
        buildTranscriptMarkdown(entry.session.getState().items, 'Claude Code'),
      note: (id, display) => entry.session.noteSecondOpinion(id, display),
      setRunning: (running) => {
        void entry.panel?.webview.postMessage({ type: 'secondOpinionRunning', running });
      },
      isParentDisposed: () => entry.disposed,
      setAdvisorItem: (itemId, options) => {
        void entry.panel?.webview.postMessage({
          type: 'secondOpinionAdvisor',
          itemId,
          // 材料を更新できる相談かどうか（Issue #975）。ボタンを出すかの判定に使う
          canUpdateMaterial: options?.canUpdateMaterial === true,
        });
      },
      // セカンドオピニオンの結果が作業中のAIへ渡る唯一の口（Issue #929）。人が承認した指示
      // （`approveSecondOpinionHandoff` が `markApproved()` を通したとき）と、回答の自動送信
      // （`autoSendResult`。Issue #1003）の両方がここを通る
      sendApprovedInstruction: async (text) => {
        const outcome = entry.session.sendOrQueue(text, []);
        // 人が送った指示と同じ扱いで作業記録へ残す（Codex画面の `reportActivity` と揃える）。
        // 承認を経た本人の指示であり、記録から落とすと日報に穴が空く
        const sessionId = entry.session.threadId;
        if (sessionId !== undefined) {
          this.onActivity({ sessionId, cwd: entry.cwd, kind: 'prompt', text });
        }
        return Promise.resolve(outcome);
      },
      setHandoffDraft: (draft) => {
        // 承認の対象は画面ではなく拡張機能側が持つ（Issue #929）。webviewへ渡すのは
        // ボタンを出すかどうかの真偽値だけで、指示文そのものは往復させない
        this.handoffDrafts.set(entry.secondOpinionKey, draft);
        void entry.panel?.webview.postMessage({
          type: 'secondOpinionHandoff',
          hasDraft: draft !== undefined,
        });
      },
      summaryRollout: this.summaryRollout,
    };
  }

  /**
   * 脇道の質問を送る（issue #334、design.md §14.62、Codexの `/btw` 相当）。
   *
   * Codex側（`chatView.ts`の`startSideQuestion`）は`thread/fork`で新しいタブを開き、
   * そこへ普通の会話として質問と応答を差し込む。Claude Codeの`side_question`は
   * 新しいセッションを作らない1往復の制御要求のため、同じタブの中に
   * `kind:'sideQuestion'`の1項目として残す（`ClaudeStreamSession.noteSideQuestion`）。
   * これは実際のCLIとのやり取り（transcript）には一切乗らない、拡張機能側だけの表示
   * （design.md §14.62で実測済み）。
   *
   * このタブで過去に送った脇道の質問（`entry.sideQuestionHistory`）を`history`として
   * 添え、`/btw`を連続で送ったときに前のやり取りを踏まえられるようにする
   * （本流の会話そのものは踏まえない。`control.ts`の`buildSideQuestionRequest`参照）。
   * `sideQuestionHistory`は無制限に伸びないよう`capSideQuestionHistory`で直近
   * `MAX_SIDE_QUESTION_HISTORY`件へ収める（`sideQuestion.ts`参照）。
   */
  private async startSideQuestion(entry: ClaudePanel, question: string): Promise<void> {
    const id = `sideQuestion:${randomUUID()}`;
    entry.session.noteSideQuestion(id, pendingSideQuestionDisplay(question));

    const result = await entry.session.askSideQuestion(
      question,
      entry.sideQuestionHistory,
      (progress) => {
        const display = progressSideQuestionDisplay(question, progress);
        if (display !== undefined) {
          entry.session.noteSideQuestion(id, display);
        }
      },
    );

    entry.session.noteSideQuestion(id, finishedSideQuestionDisplay(question, result));
    if (result.ok && result.response !== undefined) {
      const historyEntry: SideQuestionHistoryEntry = {
        question,
        response: result.response,
        fallbackNotice:
          result.refusalFallback === undefined
            ? undefined
            : `${result.refusalFallback.originalModel} が拒否したため ${result.refusalFallback.fallbackModel} が応答`,
      };
      entry.sideQuestionHistory = capSideQuestionHistory([
        ...entry.sideQuestionHistory,
        historyEntry,
      ]);
    }
  }

  /**
   * 統括ページから投げられた脇道の質問（Issue #1261）。
   *
   * タブ側の`/btw`（`startSideQuestion`）との違いは、`noteSideQuestion`を呼ばないこと。
   * 呼ぶと`kind:'sideQuestion'`の項目が会話へ積まれ、統括ページから投げた質問と回答が
   * タブに残ってしまう（受入基準「本流の会話に残さない」）。CLIとのやり取り
   * （transcript）にはもともと乗らない（design.md §14.62の実測）。
   *
   * 同じタブの過去の脇道の質問（`sideQuestionHistory`）は共有する。`/btw`と統括ページの
   * どちらから聞いても、前のやり取りを踏まえた続きを聞けるようにする。
   */
  protected override async runSideQuestion(
    entry: ClaudePanel,
    question: string,
    signal: AbortSignal,
  ): Promise<string> {
    // CLIが応答を返さないまま黙ると`askSideQuestion`は解決しない（解けるのはプロセスの
    // 破棄時だけ。`streamSession.ts`）。統括ページから投げた質問はタブを持たず、人が
    // タブを閉じて打ち切る逃げ道が無いため、待つ側をここで区切る。CLIへ送った要求
    // そのものは取り消せないので、後から応答が来ても捨てられるだけになる
    const result = await Promise.race([
      entry.session.askSideQuestion(question, entry.sideQuestionHistory),
      abortAsRejection(signal),
    ]);
    if (!result.ok || result.response === undefined) {
      throw new Error(describeSideQuestionError(result.error));
    }
    // 封筒は成功でも、モデルが文章で答えていないことがある（`synthetic`のJSDoc）。
    // CLIが生成した英語のプレースホルダをそのまま回答として出さない
    if (result.synthetic === true) {
      throw new Error(describeSyntheticSideQuestionResponse(result.response));
    }
    entry.sideQuestionHistory = capSideQuestionHistory([
      ...entry.sideQuestionHistory,
      {
        question,
        response: result.response,
        fallbackNotice:
          result.refusalFallback === undefined
            ? undefined
            : `${result.refusalFallback.originalModel} が拒否したため ${result.refusalFallback.fallbackModel} が応答`,
      },
    ]);
    return result.refusalFallback === undefined
      ? result.response
      : `${result.response}\n\n（${result.refusalFallback.originalModel} が拒否したため ${result.refusalFallback.fallbackModel} が応答しました）`;
  }

  /**
   * skillsを読み直す（issue #202、design.md TP-90）。設定パネルの「読み直す」ボタンから
   * `claude.reloadSkills` コマンド経由で呼ばれる（`newSession`と同じ、設定パネルの
   * webview→VS Codeコマンド→この画面の管理クラス、という橋渡し。設定パネルは
   * 単発プロセスの`ClaudeSkillsProbe`しか持たず、既に開いている会話のプロセスへは
   * 直接触れないため）。
   *
   * 開いている会話それぞれの生きているプロセスへ`reload_skills`を送り、結果を会話に
   * 1行残す。`entry.session.reloadSkills()`はプロセスが無ければ`undefined`を返すため、
   * タブを閉じている（プロセスが無い）会話には何も残さない（`undefined`を「対象外」と
   * 見なす。`checkMcpStatus`と対称の判断）。
   */
  async reloadSkillsForOpenSessions(): Promise<void> {
    for (const entry of this.panels.values()) {
      const result = await entry.session.reloadSkills();
      if (result === undefined) {
        continue;
      }
      entry.session.noteLocalEvent(
        `reloadSkills:${randomUUID()}`,
        result.ok
          ? `設定 ・ skillsを読み直しました（${result.skills.length}件）`
          : `設定 ・ skillsを読み直せませんでした: ${result.reason}`,
      );
    }
  }

  /**
   * `--resume` は過去のやり取りを流さないため、transcriptを読んで初期表示にする。
   * TODO一覧も同じtranscriptから最後の内容を拾い、専用表示の初期値に使う。
   */
  private async readTranscript(sessionId: string): Promise<{
    items: ChatState['items'];
    todos: ChatState['todos'];
    todoHistory: ChatState['todoHistory'];
  }> {
    const empty = { items: [], todos: [], todoHistory: [] };
    const filePath = await this.store.resolveTranscriptPath(sessionId);
    if (filePath === undefined) {
      return empty;
    }
    const builder = createTranscriptBuilder();
    // 全文・行配列を経由せず1行ずつ流し込む。`forEachLine` を持たないポート（テストの
    // フェイク等）では `readTextFile` へ退避する（issue #1325）
    if (this.fs.forEachLine !== undefined) {
      const ok = await this.fs.forEachLine(filePath, (line) => builder.push(line));
      return ok ? builder.result() : empty;
    }
    const content = await this.fs.readTextFile(filePath);
    if (content === undefined) {
      return empty;
    }
    for (const line of content.split('\n')) {
      builder.push(line);
    }
    return builder.result();
  }

  /**
   * リロード後にVSCodeが復元したパネルを引き取る。
   * webview側が `setState` で保持していたセッションidを使い、会話を読み直す。
   */
  async restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const sessionId = readPersistedThreadId(state);
    if (sessionId === undefined || this.panels.has(sessionId)) {
      // どのセッションか判らないパネル、および二重に復元されたパネルは操作できない
      panel.dispose();
      return;
    }
    if (this.isTaskManagedThread(sessionId)) {
      // タスク管理下のセッション。汎用復元はここで手を引く（design.md §16.10の7）
      panel.dispose();
      return;
    }

    // 復元されたパネルはcwdを保持していない。transcriptの素性から取り戻す
    const cwd = (await this.store.resolveCwd(sessionId)) ?? currentWorkspaceFolder()?.uri.fsPath;
    if (cwd === undefined) {
      void vscode.window.showErrorMessage('作業ディレクトリを特定できませんでした');
      panel.dispose();
      return;
    }

    const entry = this.buildEntry(
      cwd,
      LABEL,
      false,
      undefined,
      undefined,
      this.initialModelSettings(undefined, sessionId),
    );
    this.attachPanel(entry, panel);
    this.panels.set(sessionId, entry);
    // 起動引数を組む`configFor`より前に割り当てる（Issue #1305）
    this.registerSessionMessaging(entry, sessionId);
    const transcript = await this.readTranscript(sessionId);
    entry.session.start({
      cwd,
      target: { kind: 'resume', sessionId },
      sessionId: undefined,
      config: this.configFor(entry),
      initialItems: transcript.items,
      initialTodos: transcript.todos,
      initialTodoHistory: transcript.todoHistory,
      // 人が付けた名前があれば開いた時点からタブ名に反映する（issue #199）
      initialName: this.store.getName(sessionId),
    });
  }

  /**
   * 名前を変更する（issue #199、design.md §14.35）。Codex画面の `renameActive`
   * （`chatView.ts`）と同じ「アクティブなタブが対象」というUXに揃える。
   *
   * 表示用の名前は拡張機能側（`ClaudeSessionStore`）を正として持つ設計のため
   * （`control.ts` の `buildRenameSessionRequest` のJSDoc参照）、保存が先、CLIへの
   * 送信は`ClaudeStreamSession.setName`内でのベストエフォートな副送信という順序にする。
   * 保存に失敗した場合は画面へも反映しない（保存できていないのに変わったように見せない）。
   */
  async renameActive(): Promise<void> {
    const entry = this.active;
    const sessionId = entry?.session.threadId;
    if (entry === undefined || sessionId === undefined) {
      void vscode.window.showInformationMessage('名前を変更するClaude Code画面を開いてください');
      return;
    }

    const current = entry.session.getState().name ?? this.store.getName(sessionId) ?? '';
    const name = await vscode.window.showInputBox({
      prompt: 'このセッションの名前',
      value: current,
      validateInput: (v) => (v.trim() === '' ? '名前を入力してください' : undefined),
    });
    if (name === undefined || name.trim() === '' || name === current) {
      return;
    }

    try {
      // 手で付けた名前を自動の付け直し（Issue #1426）で上書きしない。要約を待っている
      // 付け直しが保存の直前に印を見るため、保存より先に付ける
      await this.autoName?.marks.add(pinKeyFor({ provider: 'claude', id: sessionId }));
      await this.store.rename(sessionId, name.trim());
      entry.session.setName(name.trim());
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * いまの会話を捨てて、同じ作業フォルダで新しい会話を始める（CLIの `/clear` 相当）。
   * Codex画面の `clearActive`（`chatView.ts`）と同じUX・同じ手順に揃える。
   *
   * 会話はtranscriptに残り履歴から開き直せるため、確認は進行中のターンがあるときだけ出す。
   * タブは作り直す（`teardown` がタブごと閉じ、`openNew` が同じ列へ開く）。既存のタブを
   * 使い回すと、webviewへ配線済みのハンドラが古いセッションを掴んだまま残るため。
   */
  async clearActive(): Promise<void> {
    const entry = this.active;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('クリアするClaude Code画面を開いてください');
      return;
    }
    await this.clearEntry(entry);
  }

  /**
   * 指定した画面をクリアする（`clearActive` の実処理）。
   *
   * 入力欄の `/clear`（issue #1264）は打った画面そのものを対象にしたいため、`this.active`
   * ではなく送信元の `entry` を受け取れるようにここへ切り出してある（Codex画面の
   * `clearEntry`（`chatView.ts`）と同じ）。
   */
  private async clearEntry(entry: ClaudePanel): Promise<void> {
    // タスク（オーケストレータ）管理下のタブは、走らせている側が寿命を持つ
    if (entry.taskManaged) {
      void vscode.window.showWarningMessage('タスクが動かしている画面はクリアできません');
      return;
    }
    if (entry.session.getState().busy) {
      const choice = await vscode.window.showWarningMessage(
        '応答の途中です。クリアすると進行中のターンは中断されます。',
        { modal: true },
        'クリアする',
      );
      if (choice !== 'クリアする') {
        return;
      }
    }

    const cwd = entry.cwd;
    this.teardown(entry);
    await this.openNew(cwd);
  }

  /** セッションとループだけを組み立てる。パネルはまだ作らない。 */
  private buildEntry(
    cwd: string,
    title: string,
    taskManaged: boolean,
    taskConfig: ClaudeConfig | undefined,
    pinnedName?: string,
    modelSettings: SessionModelSettings = this.initialModelSettings(taskConfig),
  ): ClaudePanel {
    const session = new ClaudeStreamSession(
      this.claudePath,
      this.log,
      (state) => this.onSessionChange(entry, state),
      () => this.warnApprovalsUnavailable(),
      // 起動直後と、セッション中に増減したときに届く
      () => void this.postCommands(entry),
      // entry.approvalHandlerはsetApprovalHandlerで後から差し込まれることがあるため、
      // 構築時に固定せず呼び出しのたびに読み直す（クロージャで参照するだけ）
      (approval, rawParams) =>
        entry.approvalHandler !== undefined
          ? entry.approvalHandler(approval, rawParams)
          : Promise.resolve({ kind: 'ask' as const }),
      // 統合テスト（Issue #186）が差し替えている間だけフェイクのプロセスになる。
      this.resolveSpawn(),
      // 自動引き継ぎの初期値（Issue #1091）。ClaudeStreamSessionはvscodeに依存しないため、
      // 設定の読み出しはここ（view層）で行う（下の`LoopController`と同じ）
      readAutoHandoffEnabled(),
      // 自動引き継ぎの自動承認の初期値（Issue #1350）。仕組みは上と同じ二段構え
      readAutoHandoffAutoApprove(),
      // 自動返信モードの初期値（Issue #1353）。同じ理由で値だけを渡す
      readAutoReplyConfig().enabled,
      this.createOutputOffload(),
    );

    const loop = new LoopController(
      (text) => this.sendFromLoop(entry, text),
      (status) => this.onLoopStatus(entry, status),
      // 停滞判定のしきい値（design.md §16.27、Issue #336）。LoopControllerはvscodeに
      // 依存しないため、設定の読み出しはここ（view層）で行う
      readWorkflowsConfig().stallRepeatCount,
    );

    const entry: ClaudePanel = {
      panel: undefined,
      lastKnownViewColumn: undefined,
      session,
      loop,
      cwd,
      attachments: new AttachmentBox(),
      disposed: false,
      title,
      pinnedName,
      taskManaged,
      inputLock: false,
      lockedActionListeners: [],
      taskConfig,
      modelSettings,
      secondOpinionKey: randomUUID(),
      lastTurnCompletionSeq: 0,
      wasLoopRunning: false,
      approvalHandler: undefined,
      promptTransform: undefined,
      stateListeners: [],
      finishedListeners: [],
      approvalResolvedListeners: [],
      notifiedApprovalRequestIds: new Set(),
      sideQuestionHistory: [],
      limitAutoResumeTimer: undefined,
      limitAutoResumeAt: undefined,
      limitAutoResumeAwaitingResult: false,
      limitAutoResumeSuppressed: false,
      autoHandoffStarted: false,
      lastCompactionCount: undefined,
      lastSafeBoundaryKey: undefined,
      trace: new HandoffTrace(this.log),
      safeBoundaryProbing: false,
      autoReplyAgent: undefined,
      autoReplyTurnCount: 0,
      autoReplyHistory: [],
      autoReplyReflexAbort: new AbortController(),
      autoReplyAskUserQuestionInFlight: new Set(),
    };
    return entry;
  }

  /** `BaseChatViewManager.showPanel`（基底クラス）が新規作成時に呼ぶ、Claude Code用のパネル生成。 */
  protected override createWebviewPanel(
    entry: ClaudePanel,
    preserveFocus: boolean,
    targetViewColumn: vscode.ViewColumn | undefined,
  ): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      VIEW_TYPE,
      entry.title,
      { viewColumn: targetViewColumn ?? vscode.ViewColumn.Active, preserveFocus },
      buildClaudeChatPanelOptions(),
    );
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が呼ぶ、Claude Code用のwebview HTML組み立て。 */
  protected override renderPanelHtml(entry: ClaudePanel, panel: vscode.WebviewPanel): string {
    // 入力欄アイコン列の表に出すボタン（設定 agent.chat.composerButtons、issue #296）。
    // chatView.ts（Codex）と同じ配線。検証・既定への丸めはreadChatComposerButtonsConfig
    // 側（normalizeComposerButtons）が行うため、ここは警告が有ればログへ出すだけ
    const composerButtonsConfig = readChatComposerButtonsConfig();
    if (composerButtonsConfig.warning !== undefined) {
      this.log.warn(composerButtonsConfig.warning);
    }
    return renderShell(panel.webview, {
      inputLock: entry.inputLock,
      agentLabel: LABEL,
      provider: 'claude',
      approvalModes: CLAUDE_PERMISSION_MODES,
      approvalCycle: APPROVAL_LEVEL_CYCLE,
      showSettings: true,
      showAgentSelector: true,
      composerButtons: composerButtonsConfig.buttons,
      turnSummaryEnabled: readChatTurnSummaryConfig().enabled,
      prosConsEnabled: readChatProsConsConfig().enabled,
      endSummaryEnabled: readChatEndSummaryConfig().enabled,
      loopEngineeringEnabled: readChatLoopEngineeringConfig().enabled,
      loopAdvisorEnabled: readLoopAdvisorConfig().enabled,
      limitAutoResumeEnabled: readChatLimitAutoResumeEnabled(),
      reflexEnabled: readReflexEnabled(),
      // effort・エージェントだけ扱いが違う。黙って効かないより、効くタイミングを書くほうがまし
      settingsNote:
        'モデルと承認は今の会話にすぐ効きます。Effortは送りますが、CLIが結果を返さないため反映は確かめられません。エージェントは起動引数でのみ決まるため、変更は次のセッションから効きます。「既定」へ戻す操作も次のセッションから効きます。',
      // /review は実在しない（実測で /code-review を確認済み）。一覧に無ければボタンを隠す
      review: { mode: 'command', commandName: 'code-review' },
      // ファイルの巻き戻し（design.md「Claude Codeの巻き戻し」）。Codexは分岐で代替する
      showRewind: true,
      // 会話の途中のターンから分岐（issue #333、design.md §14.61）。Codex画面の
      // 「ここから分岐」と同じボタンを、対象を発言自身のidへ切り替えて出す
      showTurnFork: true,
      // 行頭の !/# の案内（issue #5/#6、design.md §14.29）。CodexのTUIに無い挙動
      showInputModeHints: true,
      // 他エージェントからの設定インポート（issue #200）。Codexは別のコントロールパネル
      // UI（issue #36）を持つため、二重導線を避けてClaude Code画面にだけ出す
      showImport: true,
      // 会話の1行要約（issue #203）。`/recap` はTUI由来のローカルコマンドで、Codexに
      // この概念は無いため、二重導線を避けてClaude Code画面にだけ出す
      showRecap: true,
      // 自動圧縮の窓サイズ（issue #201）。`/autocompact` もTUI由来のローカルコマンドで、
      // Codexに対応する設定は無いため、二重導線を避けてClaude Code画面にだけ出す
      showAutocompact: true,
      // CLI側のデバッグログを開く／`/debug`で診断する導線（issue #205）。どちらも
      // Codexに対応する概念が無いため、二重導線を避けてClaude Code画面にだけ出す
      showDebug: true,
      // 応答本文のMarkdown描画（issue #290、設定 agent.chat.renderMarkdown）
      renderMarkdown: readChatRenderMarkdownConfig(),
      // 送信キー（issue #288、設定 agent.chat.sendOn）。chatView.ts（Codex）と同じ配線
      sendOn: readChatSendOnConfig(),
      // 表示密度（issue #718、設定 agent.chat.density）。chatView.ts（Codex）と同じ配線
      density: readChatDensityConfig(),
      // 外装（issue #1249、設定 agent.chat.skin）。density と同じく body のクラスにだけ効く
      skin: readChatSkinConfig(),
    });
  }

  /** `BaseChatViewManager.attachPanel`（基底クラス）が配線する、webviewからのメッセージの実処理。 */
  protected override dispatchMessage(entry: ClaudePanel, message: unknown): void {
    this.handleMessage(entry, message);
  }

  /**
   * `TaskSessionHost` が返す口の実体。
   *
   * `mcpRequested` は `openTaskSession` の `input.mcp !== undefined` をそのまま渡す。
   * `false` なら `checkMessagingToolVisible` は確認そのものを行わず常に `true` を返す
   * （`TaskSession.checkMessagingToolVisible` のJSDoc参照）。
   */
  private buildTaskSession(
    entry: ClaudePanel,
    sessionId: string,
    mcpRequested = false,
  ): TaskSession {
    return {
      sessionId,
      runLoop: (plan: LoopPlan) => {
        // ループと自動返信（Issue #1353）は排他。ループを始めるときは自動返信を切る
        this.stopAutoReply(entry, 'loopStarted');
        entry.loop.start(this.withLoopDoneCheck(entry, plan), entry.session.getState().items);
      },
      send: (text: string) => this.sendOnce(entry, text),
      setPromptTransform: (transform) => {
        entry.promptTransform = transform;
      },
      onFinished: (listener) => entry.finishedListeners.push(listener),
      onStateChanged: (listener) => entry.stateListeners.push(listener),
      setApprovalHandler: (handler) => {
        entry.approvalHandler = handler;
      },
      onApprovalResolved: (listener) => entry.approvalResolvedListeners.push(listener),
      interrupt: () => {
        entry.session.interrupt();
        return Promise.resolve();
      },
      pauseLoop: () => entry.loop.pause(),
      resumeLoop: () => entry.loop.resume(),
      checkMessagingToolVisible: async () => {
        if (!mcpRequested) {
          return true;
        }
        // design.md §16.21「ツールの可視性の確認」。`mcp_status`の一覧に、拡張機能が
        // 渡した名前のサーバが`connected`として現れているかを見る（`streamSession.ts`の
        // `checkMcpStatus`のJSDoc参照）
        const servers = await entry.session.checkMcpStatus();
        const server = servers?.find((s) => s.name === MESSAGING_MCP_SERVER_NAME);
        return server?.state === 'connected';
      },
      stopLoop: () => entry.loop.stop('taskStopped'),
      decideApproval: (requestId, decision) => this.resolveApproval(entry, requestId, decision),
      // 無人実行の自動圧縮（Issue #1273）。`chatView.ts`（Codex）と同じ扱いで、画面の
      // 圧縮ボタン（`this.compact`）が通す確認と`loop.noteUserAction()`は通さない。
      // Claude側の`compact()`は同期（`/compact`の発言を書くだけ）なのでPromiseへ包む
      compact: () => {
        entry.session.compact();
        return Promise.resolve();
      },
      note: (id, text) => entry.session.noteLocalEvent(id, text),
      reveal: () => this.showPanel(entry, false),
      open: (options) => this.showPanel(entry, options.preserveFocus),
      onLockedAction: (listener) => entry.lockedActionListeners.push(listener),
      dispose: () => this.teardown(entry),
    };
  }

  private onSessionChange(entry: ClaudePanel, state: ChatState): void {
    if (entry.disposed) {
      return;
    }
    // ターンの結果が確定した瞬間に、待たせていた指示を1件送る（issue #939、
    // `chatView.ts`の`onSessionChange`と同じ扱い）。Claude Codeは`result`の1イベントで
    // `busy: false`と`turnResultText`を同時に決めるためCodexのような順序の食い違いは
    // 起きないが、境目の意味を両画面で揃える
    const turnFinished = entry.lastTurnCompletionSeq !== state.turnCompletionSeq;
    entry.lastTurnCompletionSeq = state.turnCompletionSeq;
    if (turnFinished && state.queued.length > 0) {
      entry.session.sendNextQueued();
    }
    if (turnFinished) {
      reportTurnResult(this.onActivity, entry.session.threadId, entry.cwd, state);
      // ループを止めうる`loop.observe`より前に記録する（最後のターンも残すため。issue #1379）
      this.recordLoopCommands(entry, state);
      this.notifyTurnComplete(entry, state);
      this.maybeAutoName(entry, state);
      // 会話しているのと別のCLIを指定されることがあるため、実行ファイルは要約先に合わせて読む
      this.maybeEndSummary(
        entry,
        state,
        'claude',
        (provider) => (provider === 'claude' ? this.claudePath() : readConfig().executablePath),
        this.log,
        (id, display) => entry.session.noteEndSummary(id, display),
      );
    }
    const next = deriveTitle(state, entry.pinnedName);
    if (next !== undefined && entry.title !== next) {
      entry.title = next;
    }
    // 名前が変わっていなくても、実行中／承認待ちの状態は変わりうるので毎回適用する
    // （issue #286、design.md §14.55。`chatView.ts`の`onSessionChange`と同じ扱い）
    if (entry.panel !== undefined) {
      entry.panel.title = decoratePanelTitle(
        entry.title,
        // 引き継ぎ確認待ち（Issue #1280）は`ChatState`に現れないため別に渡す
        deriveSessionActivityState(state, entry.pendingHandoff?.active === true),
      );
    }
    this.notifyNewApprovals(entry, state);
    // AskUserQuestionの自動回答（Issue #1353）はCodexには無いClaude Code固有の経路。
    // 承認カードが増えるたびに判定する（ターン完了を待たない。ツール実行中に問い合わせが
    // 来ることがあるため）
    this.maybeAutoAnswerAskUserQuestion(entry, state);
    if (state.usage !== undefined) {
      this.onUsage(state.usage);
    }
    if (turnFinished) {
      void this.refreshUsage();
    }
    this.scheduleLimitAutoResume(entry, state, turnFinished);
    this.maybeAutoHandoff(entry, state);
    // 自動返信（Issue #1353）もターン完了契機。ループへ渡す前に判定する
    // （`loop/start`とautoReplyは排他のため、どちらが先でも実害は無い）
    this.maybeAutoReply(entry, state, turnFinished);
    // ターンの完了を見て次の指示を送るため、描画より先にループへ渡す
    entry.loop.observe(state);
    this.postState(entry);
    // 控えを取ってから回す。listenerの中で購読を解く経路があり（セカンドオピニオンの
    // 待機。Issue #949）、配列そのものを回していると、外した位置より後ろのlistenerが
    // その1回だけ呼ばれずに飛ぶ
    for (const listener of [...entry.stateListeners]) {
      listener(state);
    }
  }

  private cancelLimitAutoResume(entry: ClaudePanel): void {
    if (entry.limitAutoResumeTimer !== undefined) {
      clearTimeout(entry.limitAutoResumeTimer);
      entry.limitAutoResumeTimer = undefined;
    }
    entry.limitAutoResumeAt = undefined;
    entry.limitAutoResumeAwaitingResult = false;
  }

  /**
   * 人の操作で自動再開を打ち切る（Issue #1202。`chatView.ts`の同名メソッドと同じ扱い）。
   */
  private suppressLimitAutoResume(entry: ClaudePanel): void {
    this.cancelLimitAutoResume(entry);
    entry.limitAutoResumeSuppressed = true;
  }

  /** 明示的な送信・再開操作で、手動中断による抑止を解く（Issue #1202）。 */
  private clearLimitAutoResumeSuppression(entry: ClaudePanel): void {
    entry.limitAutoResumeSuppressed = false;
  }

  /**
   * 共通設定 `agent.chat.limitAutoResume.enabled` の現在値を、開いている全会話へ適用する
   * （Issue #1209。`chatView.ts`の同名メソッドと同じ扱い）。設定はCodex画面とClaude Code画面で
   * 共有する1つの値なので、どちらの画面で切り替えても両方のマネージャーが呼ばれる。
   */
  refreshLimitAutoResume(): void {
    const enabled = readChatLimitAutoResumeEnabled();
    for (const entry of this.allPanels()) {
      if (!enabled) {
        this.cancelLimitAutoResume(entry);
      } else {
        // 入れ直しは再開の指示。中断で止めていた分もここで解く（Issue #1202）
        this.clearLimitAutoResumeSuppression(entry);
        this.scheduleLimitAutoResume(entry, entry.session.getState());
      }
      this.postState(entry);
      void entry.panel?.webview.postMessage({ type: 'limitAutoResume', enabled });
    }
  }

  /**
   * Reflexモード（issue #1455）のトグルの表示を全会話で揃える。設定の書き込み時は
   * `extension.ts`の`onDidChangeConfiguration`からCodex画面・Claude Code画面の両方で呼ばれる。
   * 表示には書いた値ではなく実効値を使う（ワークスペース側の上書きがあると、Globalへ
   * 書いた値は動かない）。
   */
  refreshReflex(): void {
    const enabled = readReflexEnabled();
    for (const entry of this.allPanels()) {
      void entry.panel?.webview.postMessage({ type: 'reflex', enabled });
    }
  }

  private limitAutoResumeStatus(entry: ClaudePanel): Record<string, unknown> {
    return {
      enabled: readChatLimitAutoResumeEnabled(),
      scheduledAt: entry.limitAutoResumeAt,
      awaitingResult: entry.limitAutoResumeAwaitingResult,
      suppressed: entry.limitAutoResumeSuppressed,
    };
  }

  private scheduleLimitAutoResume(
    entry: ClaudePanel,
    state: ChatState,
    turnFinished = false,
  ): void {
    if (!readChatLimitAutoResumeEnabled() || entry.panel === undefined) {
      this.cancelLimitAutoResume(entry);
      return;
    }
    // 人が止めた後は、上限の条件が残っていても予約し直さない（Issue #1202）
    if (entry.limitAutoResumeSuppressed) {
      this.cancelLimitAutoResume(entry);
      return;
    }
    // 上限で止まったターンだけを対象にする（Issue #1206）。レート制限の通知は
    // アカウント単位で全タブへ届き、`allowed`が来るまで残るため、それだけで予約すると
    // 成功した会話へも継続指示を送ってしまう
    const stoppedByLimit = stoppedByUsageLimit(state);
    if (entry.limitAutoResumeAwaitingResult) {
      if (!turnFinished) {
        return;
      }
      entry.limitAutoResumeAwaitingResult = false;
      if (stoppedByLimit) {
        this.armLimitAutoResume(entry, LIMIT_AUTO_RESUME_RETRY_MS);
      } else {
        this.cancelLimitAutoResume(entry);
      }
      return;
    }
    if (!stoppedByLimit) {
      this.cancelLimitAutoResume(entry);
      return;
    }
    if (entry.limitAutoResumeTimer !== undefined) {
      return;
    }
    const resetAt = state.usage?.resetsAt;
    const waitMs =
      resetAt === undefined
        ? LIMIT_AUTO_RESUME_FALLBACK_MS
        : Math.max(0, resetAt * 1_000 - Date.now()) + LIMIT_AUTO_RESUME_GRACE_MS;
    this.armLimitAutoResume(entry, waitMs);
  }

  private armLimitAutoResume(entry: ClaudePanel, waitMs: number): void {
    if (entry.limitAutoResumeTimer !== undefined) {
      clearTimeout(entry.limitAutoResumeTimer);
    }
    entry.limitAutoResumeAt = Date.now() + waitMs;
    this.postState(entry);
    entry.limitAutoResumeTimer = setTimeout(() => {
      entry.limitAutoResumeTimer = undefined;
      entry.limitAutoResumeAt = undefined;
      const latest = entry.session.getState();
      if (
        entry.disposed ||
        entry.panel === undefined ||
        !readChatLimitAutoResumeEnabled() ||
        // 人が中断・ループ停止で止めた後は送らない（Issue #1202）
        entry.limitAutoResumeSuppressed ||
        latest.busy ||
        latest.approvals.length > 0 ||
        latest.prompts.length > 0
      ) {
        this.postState(entry);
        return;
      }
      entry.limitAutoResumeAwaitingResult = true;
      this.postState(entry);
      try {
        entry.session.noteLocalEvent(
          `limitAutoResume:${Date.now()}`,
          '使用量上限の解除後に自動続行しています',
        );
        entry.session.send(LIMIT_AUTO_RESUME_INSTRUCTION);
      } catch (e) {
        entry.limitAutoResumeAwaitingResult = false;
        this.reportError(e);
        if (readChatLimitAutoResumeEnabled() && entry.panel !== undefined) {
          this.armLimitAutoResume(entry, LIMIT_AUTO_RESUME_RETRY_MS);
        }
      }
    }, waitMs);
  }

  /**
   * ループの状態変化。停止（running: true→false）を検知して `onFinished` を1度だけ呼ぶ。
   *
   * 反復のたびに呼ばれるため、`refreshSettings`（間引き・差分を通さない全量送信）ではなく
   * `postState`（Codex側の`onLoopStatus`と同じ、`STATE_POST_INTERVAL_MS`の間引きに乗る
   * 経路）を呼ぶ（issue #420）。設定は`flushState`が毎回`settings`を載せるようにしたため、
   * この経路でも反映は途切れない。
   */
  private onLoopStatus(entry: ClaudePanel, status: LoopStatus): void {
    const stopped = entry.wasLoopRunning && !status.running;
    if (!entry.wasLoopRunning && status.running) {
      this.beginLoopCommandRecording(entry);
    }
    entry.wasLoopRunning = status.running;
    this.postState(entry);
    if (stopped) {
      void this.postLoopEvidence(entry);
    }
    if (stopped && status.stopReason !== undefined) {
      const state = entry.session.getState();
      for (const listener of entry.finishedListeners) {
        listener(status.stopReason, state);
      }
    }
  }

  /**
   * 承認レベル（3段階）を適用する。
   *
   * Claude Codeでは `permissionMode` 1項目へ展開される。書き込みは
   * `SettingsProvider.updateApprovalLevel` が担い（「全承認」の同意もそこで取る）、
   * 実行中のセッションへの反映は `permissionMode` を変えたときと同じ経路に乗せる。
   */
  private async applyApprovalLevel(entry: ClaudePanel, level: unknown): Promise<void> {
    if (!isApprovalLevel(level)) {
      this.log.warn(`承認レベルの変更要求が不正です: ${String(level)}`);
      return;
    }
    // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
    const applied = await this.settings.updateApprovalLevel('claude', level);
    if (applied) {
      this.applyToSession(entry, 'permissionMode', claudePermissionModeForLevel(level));
    }
    this.refreshSettings(entry);
  }

  /** 設定行のキーはCodex画面と共通なので、Claude側のキーへ読み替える。 */
  private async applyConfig(entry: ClaudePanel, key: unknown, value: unknown): Promise<void> {
    if (typeof value !== 'string') {
      return;
    }
    const mapped: ClaudeEditableKey | undefined =
      key === 'model'
        ? 'model'
        : key === 'reasoningEffort'
          ? 'effort'
          : key === 'approvalMode'
            ? 'permissionMode'
            : key === 'agent'
              ? 'agent'
              : undefined;
    if (mapped === undefined) {
      this.log.warn(`変更を許可していないキーです: ${String(key)}`);
      return;
    }
    if (mapped === 'model' || mapped === 'effort') {
      if (mapped === 'model') {
        entry.modelSettings.model = value;
        const snapshot = this.settings.claudeSnapshot();
        const allowed = effortsFor(snapshot.models, value, CLAUDE_EFFORTS);
        if (entry.modelSettings.effort !== '' && !allowed.includes(entry.modelSettings.effort)) {
          entry.modelSettings.effort = '';
        }
      } else {
        entry.modelSettings.effort = value;
      }
      await this.persistModelSettings(entry);
      this.applyToSession(entry, mapped, value);
      this.refreshSettings(entry);
      return;
    }
    // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
    const applied = await this.settings.updateClaude(mapped, value);
    if (applied) {
      this.applyToSession(entry, mapped, value);
    }
    this.refreshSettings(entry);
  }

  /**
   * 変更を実行中のセッションへ流す。
   *
   * Codex画面はターンごとに設定を渡せるが、Claude Codeは1プロセス1セッションで
   * 起動引数が固定なので、control protocol で伝える。
   *
   * 「既定」（空文字）へ戻す操作は送らない。CLI側に元へ戻す手段が無く、
   * 何を送っても嘘になるため。次に開くセッションから効く。
   *
   * `agent` だけは値の有無によらず常にここで返す。エージェントは起動引数
   * （`--agent`）でのみ決まり、実行中のセッションへ切り替えを伝える制御要求が無い
   * （`set_agent` 等7種の候補を実測し、いずれも `Unsupported control request subtype`
   * で拒否されることを確認済み）。値を送っても効かないので、常に「次のセッションから」
   * と伝えるだけにする。
   */
  private applyToSession(entry: ClaudePanel, key: ClaudeEditableKey, value: string): void {
    if (key === 'agent') {
      this.log.info(
        value === ''
          ? 'agent を既定へ戻しました。セッション中は切り替えられないため、次のセッションから適用されます'
          : `agent を ${value} に変えました。セッション中は切り替えられないため、次のセッションから適用されます`,
      );
      return;
    }
    if (value === '') {
      this.log.info(
        `${key} を既定へ戻しました。今の会話には効かず、次のセッションから適用されます`,
      );
      return;
    }
    if (key === 'model') {
      entry.session.setModel(value);
      return;
    }
    if (key === 'effort') {
      entry.session.setEffort(value);
      return;
    }
    entry.session.setPermissionMode(value);
  }

  /**
   * 発言を送り、作業記録へ流す。手動でもループからでも通り道は同じにする。
   * 送信のたび毎回記録する。
   *
   * `logText` を渡した場合、作業記録にはそちらを残し、実際の送信は `text` を使う
   * （design.md §16.12。テンプレート展開前の文面を記録するため。`sendFromLoop` から使う）。
   */
  private dispatch(
    entry: ClaudePanel,
    text: string,
    withAttachments: boolean | Attachment[] = false,
    logText: string = text,
  ): 'sent' | 'queued' {
    // 配列なら取り出し済みの添付（skill選択の判定を待つ間に取り出したもの）
    const attachments = Array.isArray(withAttachments)
      ? withAttachments
      : withAttachments
        ? entry.attachments.take()
        : [];
    let result: 'sent' | 'queued';
    try {
      result = entry.session.sendOrQueue(text, attachments);
    } catch (e) {
      // 取り出したまま失わない。貼り直しを強いない
      entry.attachments.restore(attachments);
      throw e;
    }
    const sessionId = entry.session.threadId;
    if (sessionId !== undefined) {
      this.onActivity({ sessionId, cwd: entry.cwd, kind: 'prompt', text: logText });
    }
    return result;
  }

  /**
   * 発言に合うskillをReflex判定で選んでから送る（issue #1451）。判定中に来た発言が追い越さない
   * よう、有効な間は`/`始まりも含めて関門を通す。選んだときは読み込ませる固定文を前に置く。
   * 取り消されたら送らず、本文と添付を入力欄へ戻す。
   */
  private async dispatchWithSkillSelect(
    entry: ClaudePanel,
    text: string,
    sent: string,
    threshold: number,
  ): Promise<void> {
    const attachments = entry.attachments.take();
    const gate = (entry.skillSelectGate ??= new SkillSelectGate());
    try {
      await gate.run(async (signal) => {
        const skillName =
          shouldSelectSkill(text) && !signal.aborted
            ? await this.chooseClaudeSkill(entry, text, threshold, signal)
            : undefined;
        if (signal.aborted) {
          entry.attachments.restore(attachments);
          void entry.panel?.webview.postMessage({
            type: 'restoreQueuedText',
            text: gate.collectAborted(text),
          });
          this.postState(entry);
          return;
        }
        const prompt = skillName === undefined ? sent : buildClaudeSkillPrompt(skillName, sent);
        this.dispatch(entry, prompt, attachments, text);
        this.refreshSettings(entry);
      });
    } catch (e) {
      this.reportError(e);
    }
  }

  /** 発言に合うskillの名前。選ばなかったとき・判定できなかったときは`undefined`。 */
  private async chooseClaudeSkill(
    entry: ClaudePanel,
    text: string,
    threshold: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const judging = (async () => {
      const skills = await entry.session.prepareSkillSelection();
      if (skills === undefined) {
        return undefined;
      }
      return selectSkill(
        {
          provider: 'claude',
          executable: this.claudePath(),
          logWarn: (message) => this.log.warn(message),
          signal,
        },
        text,
        toSkillCandidates(skills, false),
        threshold,
      );
    })();
    vscode.window.setStatusBarMessage('$(sync~spin) skillを選んでいます…', judging);
    let result;
    try {
      result = await judging;
    } catch (e) {
      this.log.warn(`skill選択に失敗しました: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
    if (result === undefined || signal.aborted) {
      return undefined;
    }
    const note = describeSkillSelect(result);
    if (result.kind !== 'selected' || note === undefined) {
      return undefined;
    }
    entry.session.noteLocalEvent(`skillSelect:${Date.now()}`, note);
    return result.skill.name;
  }

  /**
   * ループを介さずに本文を1回だけ送る（`TaskSession.send`。design.md §16.23）。
   *
   * `sendFromLoop` と違い `promptTransform` は通さず、`dispatch` も経由しない（`dispatch`
   * は必ず作業記録へ通知するため）。この口を使うのはオーケストレーターセッションだけで、
   * その会話本文は §16.12 の記録対象外にしてある。送信の失敗はループを止める理由に
   * ならないため、報告するだけで投げ直さない。
   */
  private sendOnce(entry: ClaudePanel, text: string): void {
    try {
      entry.session.sendOrQueue(text, []);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * Diffで確定したレビュー指摘を、明示された会話へ1回だけ送る。
   *
   * 送信先が応答中なら待ち行列に積み、`queued` を返す。入力欄に貼られた添付は
   * 利用者が別の発言のために用意したものなので、指摘と一緒に送らずパネルに残す。
   */
  sendReviewFeedback(threadId: string, text: string): ReviewDeliveryResult {
    const entry = this.panels.get(threadId);
    if (
      entry === undefined ||
      entry.disposed ||
      entry.inputLock ||
      entry.session.getState().restore !== undefined
    ) {
      return 'sessionUnavailable';
    }
    this.cancelLimitAutoResume(entry);
    this.clearLimitAutoResumeSuppression(entry);
    this.noteUserAction(entry);
    try {
      const sent = appendManualSendInstructions(
        text,
        readChatProsConsConfig(),
        readChatTurnSummaryConfig(),
      );
      const result = this.dispatch(entry, sent, false, text);
      this.refreshSettings(entry);
      return result;
    } catch (e) {
      this.reportError(e);
      return 'deliveryFailed';
    }
  }

  /**
   * ループからの送信。失敗はループを止める理由になるため、報告したうえで投げ直す。
   *
   * `promptTransform` が設定されていれば、実際にCLIへ送る本文だけそちらを通す。
   * 作業記録には変換前の `text`（テンプレート展開前）を残す（design.md §16.12）。
   */
  private sendFromLoop(entry: ClaudePanel, text: string): void {
    const toSend = entry.promptTransform?.(text) ?? text;
    try {
      this.dispatch(entry, toSend, false, text);
    } catch (e) {
      this.reportError(e);
      throw e;
    }
  }

  private reportError(e: unknown): void {
    const reason = e instanceof Error ? e.message : String(e);
    this.log.error(`Claude Code画面: ${reason}`);
    void vscode.window.showErrorMessage(`Claude Code: ${reason}`);
  }

  private handleMessage(entry: ClaudePanel, message: unknown): void {
    const m =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    const type = m['type'];

    try {
      if (type === 'send' && typeof m['text'] === 'string') {
        const text = m['text'];
        // 画像だけ送るのも許す。本文が無くても添付があれば送る意味がある
        if (text.trim() === '' && entry.attachments.list.length === 0) {
          return;
        }
        this.cancelLimitAutoResume(entry);
        // 人が自分で送り直したら、中断で止めていた自動再開も再び有効にする（Issue #1202）
        this.clearLimitAutoResumeSuppression(entry);
        // 手動の発言はループへの割り込み。指示が交互に飛ぶ状態を作らない
        this.noteUserAction(entry);
        // 行頭が !/# の入力はCLIへ送らず、拡張機能側の機能として扱う（issue #5/#6、
        // design.md §14.29）。control_requestに相当する経路が無いため、Claudeへ発言として
        // 渡すとモデルのターンを消費して意図とずれる（design.mdの調査結果を参照）
        const inputMode = routeInputMode(text);
        if (inputMode !== undefined) {
          void this.runInputMode(entry, inputMode);
          return;
        }
        // `/btw`（脇道の質問、issue #334）はCLIへ送らず拡張機能側の機能として扱う。
        // CLIへ送っても普通の発言として素通しされるだけ（`pseudoCommands.ts`参照）
        const pseudo = routePseudoCommand(CLAUDE_PSEUDO_COMMANDS, text);
        if (pseudo !== undefined) {
          void this.runPseudoCommand(entry, pseudo);
          return;
        }
        // 手動の発言にだけメリデメ説明・要約の指示を足す（issue #1474・#709）。擬似コマンド・
        // 入力モードより後に置いてあるので、CLIへ送らない入力には付かない。ループの自動送信も対象外。
        // 作業記録には元の文面を残す（`logText`。テンプレート展開前を記録する§16.12と同じ扱い）
        const sent = appendManualSendInstructions(
          text,
          readChatProsConsConfig(),
          readChatTurnSummaryConfig(),
        );
        const skillSelect = readSkillSelectConfig();
        if (skillSelect.enabled) {
          void this.dispatchWithSkillSelect(entry, text, sent, skillSelect.threshold);
          return;
        }
        this.dispatch(entry, sent, true, text);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'requestFiles') {
        // タブが閉じている（タスク管理下でパネルが無い）間は送り先が無い
        if (entry.panel !== undefined) {
          void postFileMentions(entry.panel, this.mentions, entry.cwd, m['query']);
        }
        return;
      }
      if (type === 'requestImage') {
        if (entry.panel !== undefined) {
          void postImageData(entry.panel, this.fs, entry.session.getState().items, m['path']);
        }
        return;
      }
      if (type === 'openUrl' && typeof m['url'] === 'string') {
        // Markdownのfile: URI・相対パスは会話の作業ディレクトリから開く。
        // それ以外のhttp(s) URLだけが従来どおり外部ブラウザへ渡る。
        const url = m['url'];
        void openChatFileLink(url, entry.cwd).then((opened) => {
          if (!opened && isOpenableSearchUrl(url)) {
            void vscode.env.openExternal(vscode.Uri.parse(url));
          }
        });
        return;
      }
      if (type === 'insertCode' && typeof m['code'] === 'string') {
        // コードブロックの「エディタへ挿入」。`chatView.ts` と共通の実装（issue #290）
        void insertCodeIntoEditor(m['code']);
        return;
      }
      if (type === 'openCodeFile' && typeof m['code'] === 'string') {
        // コードブロックの「新規ファイルで開く」（issue #290）
        void openCodeInNewFile(m['code'], typeof m['lang'] === 'string' ? m['lang'] : '');
        return;
      }
      if (type === 'openDiffFile') {
        // 差分の見出し行「エディタで開く」。`chatView.ts` と共通の実装（issue #291）
        void handleOpenDiffFile(
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
          entry.cwd,
        );
        return;
      }
      if (type === 'openDiffEditor') {
        // 差分の見出し行「差分を開く」。`chatView.ts` と共通の実装（issue #291）
        void handleOpenDiffEditor(
          this.fs,
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
          entry.cwd,
        ).then((opened) => {
          if (opened !== undefined && entry.session.threadId !== undefined) {
            void vscode.commands.executeCommand('agent.localReview.registerDiff', {
              provider: 'claude',
              threadId: entry.session.threadId,
              cwd: entry.cwd,
              ...opened,
            });
          }
        });
        return;
      }
      if (type === 'revertDiff') {
        // 差分の見出し行「この変更を戻す」。`chatView.ts` と共通の実装（issue #291）
        void handleRevertDiff(
          this.fs,
          entry.session.getState().items,
          m['itemId'],
          m['diffIndex'],
          entry.cwd,
        );
        return;
      }
      if (type === 'attach') {
        addAttachment(entry.attachments, m['name'], m['dataUrl']);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'dropRejected') {
        noteDropRejected(m['kind']);
        return;
      }
      if (type === 'removeAttachment' && typeof m['id'] === 'string') {
        entry.attachments.remove(m['id']);
        this.refreshSettings(entry);
        return;
      }
      if (type === 'interrupt') {
        // `ClaudeStreamSession.interrupt`は`usage`を残したまま`busy:false`を通知する。
        // タイマーを消すだけでは、その通知から予約が作り直される（Issue #1202）
        this.suppressLimitAutoResume(entry);
        this.noteUserAction(entry);
        // skillの判定中・待機中の発言は送らずに入力欄へ戻す（issue #1451）
        entry.skillSelectGate?.abortAll();
        entry.session.interrupt();
        return;
      }
      if (type === 'compact') {
        void this.compact(entry);
        return;
      }
      if (type === 'claudeImport') {
        void this.importConfig(entry);
        return;
      }
      if (type === 'usageCreditsRequest') {
        void this.requestUsageCredits(entry);
        return;
      }
      if (type === 'recap') {
        this.recap(entry);
        return;
      }
      if (type === 'localReview') {
        const threadId = entry.session.threadId;
        if (threadId !== undefined) {
          void vscode.commands.executeCommand('agent.localReview.start', {
            provider: 'claude',
            threadId,
            cwd: entry.cwd,
          });
        }
        return;
      }
      if (type === 'autocompactWindow') {
        this.setAutocompactWindow(entry, typeof m['window'] === 'string' ? m['window'] : '');
        return;
      }
      if (type === 'openDebugLog') {
        void this.openDebugLog(entry);
        return;
      }
      if (type === 'debugCommand') {
        void this.sendDebugCommand(entry);
        return;
      }
      if (type === 'stopBackgroundTask' && typeof m['id'] === 'string') {
        void this.stopBackgroundTask(
          entry,
          m['id'],
          typeof m['command'] === 'string' ? m['command'] : m['id'],
        );
        return;
      }
      if (type === 'openItemOutput') {
        // ディスクへ退避したツール出力の全文を開く（issue #1325）。会話には触れないため
        // ループへの割り込み扱いにもしない
        const itemId = m['itemId'];
        if (typeof itemId === 'string') {
          void runOpenItemOutput(() => entry.session.loadOffloadedOutput(itemId));
        }
        return;
      }
      if (type === 'exportTranscript') {
        // 発言や中断とは独立した操作。ループへの割り込み扱いにはしない
        void runExportTranscript(entry.session.getState().items, LABEL);
        return;
      }
      if (type === 'workflowMenu') {
        // この会話とは関係のない全体の操作（issue #250）。`chatView.ts`と同じ扱いで、
        // 応答中でも押せる。QuickPickの組み立ては`extension.ts`側に一本化してある。
        // 生成（分解・ロードマップ）をこの画面と同じエージェントで走らせるため、
        // プロバイダを添えて渡す（issue #266。省略するとその場で選ばされる）
        void vscode.commands.executeCommand('agent.workflows.menu', 'claude');
        return;
      }
      if (type === 'teamWorkflow') {
        void vscode.commands.executeCommand('agent.workflows.team', 'claude');
        return;
      }
      if (type === 'workflowView') {
        void vscode.commands.executeCommand('agent.workflows.view');
        return;
      }
      if (type === 'sessionKanban') {
        void vscode.commands.executeCommand('agent.sessionKanban');
        return;
      }
      if (type === 'forgeHub') {
        void vscode.commands.executeCommand('agent.forgeHub', 'claude');
        return;
      }
      if (type === 'openProgress') {
        void vscode.commands.executeCommand('agent.openProgress');
        return;
      }
      if (type === 'handoffToNewSession') {
        void this.handoffToNewSessionIn(entry);
        return;
      }
      if (type === 'secondOpinion') {
        void this.startSecondOpinionFor(entry);
        return;
      }
      if (type === 'webGptDiscussion') {
        void this.discussWithWebGptIn(entry);
        return;
      }
      if (type === 'secondOpinionContinue') {
        // 追加の相談（Issue #929）。メインセッションへは1ターンも送らない
        void continueSecondOpinion(
          this.secondOpinionPortFor(entry),
          this.secondOpinionRegistry,
          this.advisorStore,
          this.log,
        );
        return;
      }
      if (type === 'secondOpinionUpdateMaterial') {
        // 相談の途中で材料を最新へ更新する（Issue #975）。押したときだけ更新する
        void updateSecondOpinionMaterial(
          this.secondOpinionPortFor(entry),
          this.secondOpinionRegistry,
          this.advisorStore,
          this.log,
        );
        return;
      }
      if (type === 'secondOpinionDraft') {
        // メインAIへの指示の下書き（Issue #929）。作るだけで、送信はしない
        void draftSecondOpinionHandoff(
          this.secondOpinionPortFor(entry),
          this.secondOpinionRegistry,
          this.advisorStore,
          this.log,
        );
        return;
      }
      if (type === 'secondOpinionApprove') {
        // 人が読み、直し、承認したときにだけ送る（Issue #929 Human Gate）
        void approveSecondOpinionHandoff(
          this.secondOpinionPortFor(entry),
          this.advisorStore,
          this.handoffDrafts.get(entry.secondOpinionKey),
          this.log,
        );
        return;
      }
      if (type === 'secondOpinionEnd') {
        endSecondOpinionConsult(entry.secondOpinionKey, this.advisorStore, 'userEnded');
        return;
      }
      if (type === 'secondOpinionStop' && typeof m['itemId'] === 'string') {
        // 会話の項目から止める（Issue #940）。タブを開かない設定でもここから止まる
        stopSecondOpinion(
          entry.secondOpinionKey,
          this.secondOpinionRegistry,
          m['itemId'],
          this.log,
        );
        return;
      }
      if (type === 'rewind' && typeof m['messageId'] === 'string') {
        this.noteUserAction(entry);
        void this.rewindFiles(entry, m['messageId']);
        return;
      }
      if (type === 'fork' && typeof m['turnId'] === 'string') {
        // 会話の途中のターンから分岐（issue #333、design.md §14.61）。新しいタブを
        // 開くだけで、この会話（entry）そのものには何も送らない
        void this.forkFromTurn(entry, m['turnId']);
        return;
      }
      if (
        type === 'editResend' &&
        typeof m['turnId'] === 'string' &&
        typeof m['text'] === 'string'
      ) {
        // 送った指示の書き直し（issue #1073）。分岐と同じく新しいタブを開くだけで、
        // この会話（entry）そのものには何も送らない
        this.noteUserAction(entry);
        void this.forkFromTurn(entry, m['turnId'], m['text'], m['restoreFiles'] === true);
        return;
      }
      if (type === 'planMode') {
        this.noteUserAction(entry);
        // 抜けるときは設定の承認方法へ戻す。タスク単位の設定があればそちらを優先する
        // （design.md §16.10の5。無ければ従来通りグローバル設定、空なら既定=manual）
        const fallback = (entry.taskConfig ?? readClaudeConfig().claude).permissionMode;
        entry.session.setPlanMode(m['on'] === true, fallback);
        return;
      }
      if (type === 'fastMode') {
        this.noteUserAction(entry);
        entry.session.setFastMode(m['on'] === true);
        return;
      }
      if (type === 'autoHandoff') {
        entry.loop.noteUserAction();
        const on = m['on'] === true;
        // 一度自動で引き継いだ後に入れ直したら、また引き継げるようにする
        if (on) {
          entry.autoHandoffStarted = false;
        }
        entry.session.setAutoHandoff(on);
        return;
      }
      if (type === 'autoHandoffAutoApprove') {
        entry.loop.noteUserAction();
        entry.session.setAutoHandoffAutoApprove(m['on'] === true);
        return;
      }
      if (type === 'autoReply') {
        // トグル自体の操作。`noteUserAction`（wrapper）経由だと自分でONにした直後に
        // 自分でOFFへ戻してしまうため、ループへの割り込みだけ生で行う
        entry.loop.noteUserAction();
        const on = m['on'] === true;
        if (on) {
          entry.session.setAutoReply(true);
        } else {
          this.stopAutoReply(entry, 'userAction');
        }
        return;
      }
      if (type === 'handoffCostPreset') {
        // 設定を選ぶだけで会話へは何も送らない。ループへの割り込み扱いにはしない。
        // このハンドラは同期のため、QuickPickの完了は待たずに投げっぱなしにする
        void pickHandoffCostPreset('claude').catch((e: unknown) => {
          this.log.warn(`コスト方針の選択に失敗しました: ${String(e)}`);
        });
        return;
      }
      if (type === 'cancelQueued' && typeof m['index'] === 'number') {
        entry.session.cancelQueued(m['index']);
        return;
      }
      if (type === 'sendQueued' && typeof m['index'] === 'number') {
        // 待たせていた指示を人が通すのも明示的な送信（Issue #1202）
        this.clearLimitAutoResumeSuppression(entry);
        this.noteUserAction(entry);
        entry.session.sendQueued(m['index']);
        return;
      }
      if (type === 'popLastQueuedForInput') {
        // 常に拡張側の最新stateから取り出す（UI側の古いスナップショット由来のズレを防ぐ）
        const popped = entry.session.popLastQueuedForInput();
        if (popped !== undefined && entry.panel !== undefined) {
          void entry.panel.webview.postMessage({ type: 'restoreQueuedText', text: popped.text });
        }
        return;
      }
      if (type === 'flushQueue') {
        // 待たせていた指示を先に通すため、ループは割り込みとして止める
        this.clearLimitAutoResumeSuppression(entry);
        this.noteUserAction(entry);
        entry.session.flushQueue();
        return;
      }
      if (type === 'loop/start') {
        // ループエンジニアリングの方針（issue #891）は設定から読んで渡す。webviewから
        // 届いた`plan`には含めない（`chatView.ts`側と同じ理由）
        // Advisor（issue #957）。設定で無効なら`undefined`が返り、計画にも載らない
        const advisor = createLoopAdvisorConfig('claude', this.log, (advice, iteration, runId) =>
          entry.session.noteSecondOpinion(
            // 実行ごとに別のidにする（issue #1009。`chatView.ts`側と同じ理由）
            `loopAdvisor:${runId}:${iteration}`,
            advisorDisplay(advice, iteration),
          ),
        );
        // 完了宣言の検証（issue #1447）。設定で無効なら`undefined`が返り、計画にも載らない
        const doneCheck = this.buildLoopDoneCheck(entry);
        const plan = normalizeLoopPlan(
          m['plan'],
          readChatLoopEngineeringConfig(),
          createGoalLoopOptions('claude', this.log),
          advisor,
          doneCheck,
        );
        if (plan === undefined) {
          void vscode.window.showErrorMessage('ループの継続指示と最大回数を入力してください');
          return;
        }
        // 有効なのにゴールが無いループでは動かない（issue #1009。`chatView.ts`側と同じ）
        if (advisor !== undefined && plan.goal === undefined) {
          entry.session.noteSecondOpinion(
            `loopAdvisor:skipped:${randomUUID()}`,
            advisorSkippedDisplay(),
          );
        }
        this.log.info(`ループ開始: 最大${plan.maxIterations}回`);
        // 人が回し直したら、中断で止めていた自動再開も再び有効にする（Issue #1202）
        this.clearLimitAutoResumeSuppression(entry);
        // ループと自動返信（Issue #1353）は排他。ループを始めるときは自動返信を切る
        this.stopAutoReply(entry, 'loopStarted');
        entry.loop.start(plan, entry.session.getState().items);
        return;
      }
      if (type === 'loop/planGoal') {
        void this.planGoalDraftFor(entry, m['id'], m['text']);
        return;
      }
      if (type === 'loop/stop') {
        // 人が止めた自動送信を、上限の条件が残っているだけで再開しない（Issue #1202）
        this.suppressLimitAutoResume(entry);
        entry.loop.stop('manual');
        return;
      }
      if (type === 'refreshLoopEvidence') {
        void this.postLoopEvidence(entry);
        return;
      }
      if (type === 'stateFull') {
        // webview側が会話の取りこぼしに気付いたときの作り直し要求（issue #262、
        // `chatView.ts`の同名分岐と同じ理由）。間引きに巻き込むと戻りが遅れるため、
        // その場で送る
        entry.sentItems = undefined;
        this.flushState(entry);
        return;
      }
      if (type === 'ready') {
        // webviewを作り直した直後は会話項目の積み直し状態（`mergedItems`）が空に戻る。
        // 差し分ではなく全量から送り直す（issue #262、#356）
        entry.sentItems = undefined;
        this.refreshSettings(entry);
        void entry.panel?.webview.postMessage({
          type: 'loopAutoGoal',
          enabled: readGoalDraftConfig().enabled,
        });
        // お気に入り（Issue #1366）も作り直したwebviewへ送り直す（前回値と同じでも送る）
        this.resendFavorite(entry);
        void this.postCommands(entry);
        return;
      }
      if (type === 'approvalLevel') {
        void this.applyApprovalLevel(entry, m['level']);
        return;
      }
      if (type === 'config') {
        void this.applyConfig(entry, m['key'], m['value']);
        return;
      }
      if (type === 'toggleTurnSummary') {
        const enabled = !readChatTurnSummaryConfig().enabled;
        void setChatTurnSummaryEnabled(enabled)
          .then(() => entry.panel?.webview.postMessage({ type: 'turnSummary', enabled }))
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleProsCons') {
        const enabled = !readChatProsConsConfig().enabled;
        void setChatProsConsEnabled(enabled)
          .then(() => entry.panel?.webview.postMessage({ type: 'prosCons', enabled }))
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleEndSummary') {
        const enabled = !readChatEndSummaryConfig().enabled;
        if (!enabled) {
          entry.endSummary?.cancel('要約エージェントを無効にしたため');
        }
        void setChatEndSummaryEnabled(enabled)
          .then(() => entry.panel?.webview.postMessage({ type: 'endSummary', enabled }))
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleLoopEngineering') {
        const enabled = !readChatLoopEngineeringConfig().enabled;
        void setChatLoopEngineeringEnabled(enabled)
          .then(() => entry.panel?.webview.postMessage({ type: 'loopEngineering', enabled }))
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleLimitAutoResume') {
        void setChatLimitAutoResumeEnabled(!readChatLimitAutoResumeEnabled())
          // 共通設定なので、操作したタブだけでなく全会話へ反映する（Issue #1209）。ここで
          // 届くのはClaude Code画面の会話だけで、Codex画面へは`extension.ts`の
          // `onDidChangeConfiguration`（設定の書き込みで発火する）経由で届く
          .then(() => this.refreshLimitAutoResume())
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleReflex') {
        void setReflexEnabled(!readReflexEnabled())
          // 共通設定なので、全会話の表示は`extension.ts`の`onDidChangeConfiguration`で揃える。
          // 書き込みで実効値が変わらなかった場合（ワークスペース側の上書き）は設定変更が発火しないので、ここでも揃える
          .then(() => this.refreshReflex())
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleLoopAdvisor') {
        void setLoopAdvisorEnabled(!readLoopAdvisorConfig().enabled)
          // 書いたのはGlobalだが、workspace側に上書きがあると実効値は動かない。要求値ではなく
          // 読み直した値を返し、表示と実際の動作を食い違わせない（issue #994）
          .then(() =>
            entry.panel?.webview.postMessage({
              type: 'loopAdvisor',
              enabled: readLoopAdvisorConfig().enabled,
            }),
          )
          .catch((e: unknown) => this.reportError(e));
        return;
      }
      if (type === 'toggleFavorite') {
        this.toggleFavorite(entry);
        return;
      }
      if (type === 'approve' && isApprovalDecision(m['decision'])) {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          this.resolveApproval(entry, requestId, m['decision']);
        }
        return;
      }
      // AskUserQuestion（issue #685）の選択送信。汎用の`approve`（4値decision）では
      // 選んだ回答を運べないため専用メッセージにしている（拒否は従来通り`approve`を使う）
      if (type === 'answerAskUserQuestion' && isAskUserQuestionSelections(m['answers'])) {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.answerAskUserQuestion(requestId, m['answers']);
        }
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 会話を圧縮する。内容を不可逆に変えるため、実行前に必ず確認する。
   */
  private async compact(entry: ClaudePanel): Promise<void> {
    if (!(await confirmCompact())) {
      return;
    }
    try {
      // 圧縮は新しいターンを起こす。ループの指示と重ならないよう割り込み扱いにする
      this.noteUserAction(entry);
      entry.session.compact();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 他エージェント（Codex／Gemini）の設定インポートのプレビューを要求する
   * （issue #200、design.md TP-88）。
   *
   * ここで書き込みは起きない（`streamSession.ts` の `importConfig` 参照）。それでも
   * 「何を・どこから・どこへ」を確認してから送るのは、実際に取り込むまでの二段階目
   * （CLIが提示するダイジェスト付き確認コマンド）へ迷わず進めるようにするため。
   */
  private async importConfig(entry: ClaudePanel): Promise<void> {
    if (!(await confirmClaudeImport())) {
      return;
    }
    try {
      // compactと同じく新しいターンを起こす。ループの指示と重ならないよう割り込み扱いにする
      this.noteUserAction(entry);
      entry.session.importConfig();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 追加クレジット（usage credits）の設定・管理者への要求を送る
   * （issue #204、design.md §14.38）。
   *
   * `importConfig`と同じく外部（組織の管理者）へ影響しうる操作のため、必ず確認してから
   * 送る（`streamSession.ts` の `requestUsageCredits` 参照。実測ではこの拡張機能からの
   * 送信は管理ページへのURLを返すだけの見込みだが、安全側に倒して確認は省かない）。
   */
  private async requestUsageCredits(entry: ClaudePanel): Promise<void> {
    if (!(await confirmUsageCreditsRequest())) {
      return;
    }
    try {
      // compact/importConfigと同じく新しいターンを起こす。ループの指示と重ならないよう
      // 割り込み扱いにする
      this.noteUserAction(entry);
      entry.session.requestUsageCredits();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 会話の1行要約をその場で作る（issue #203、design.md §14.36）。
   *
   * `compact` / `importConfig` と違い、会話の中身を要約へ置き換えたり書き込みが起きたり
   * することはない（`streamSession.ts` の `recap` のJSDoc参照。実測では新しい発言が
   * 1件増えるだけ）。壊れる／戻せない操作ではないため、確認ダイアログは挟まない
   * （`planToggle` / `fastToggle` と同じ扱い）。
   */
  private recap(entry: ClaudePanel): void {
    try {
      this.noteUserAction(entry);
      entry.session.recap();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 自動圧縮の窓サイズを確認・変更する（issue #201、design.md §14.37）。
   *
   * 空文字なら現在値の問い合わせ、それ以外なら変更として扱う（`streamSession.ts` の
   * `setAutocompactWindow` 参照）。`recap`と同じく、壊れる・戻せない操作ではないため
   * 確認ダイアログは挟まない。
   */
  private setAutocompactWindow(entry: ClaudePanel, window: string): void {
    try {
      this.noteUserAction(entry);
      entry.session.setAutocompactWindow(window);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * CLI側のデバッグログをエディタで開く（issue #205、design.md §14.39）。
   *
   * 本体の実測どおり、ログは`/debug`を送らなくても常時`~/.claude/debug/`配下に
   * 出ているため、**CLIへは何も送らず**ファイルを直接開くだけで済む（課金もツール
   * 実行も伴わない。壊れる・戻せない操作ではないため確認ダイアログも挟まない）。
   *
   * `debugLogCandidates`が返す候補（このセッション専用のログ→`latest`の順）を先頭から
   * 順に開けるか試す。`vscode.workspace.openTextDocument`はファイルが無いと reject
   * するため、候補ごとにtry/catchで次点へ進む。全滅した場合はログがまだ無い旨を案内する
   * （エラー扱いにはしない。CLIの初回起動直後などで実際に起こりうる）。
   *
   * 開けたら「どこを開いたか」を会話に1行残す（issue本文の受入基準「操作すると…会話に
   * 記録が残る」を、実際の中身に合わせて「ログを開いたこと」の記録として満たす。design.md
   * §14.39の設計判断を参照）。
   */
  private async openDebugLog(entry: ClaudePanel): Promise<void> {
    const candidates = debugLogCandidates(this.claudeHome, entry.session.threadId);
    for (const path of candidates) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        await vscode.window.showTextDocument(doc, { preview: false });
        entry.session.noteLocalEvent(
          `openDebugLog:${randomUUID()}`,
          `デバッグログを開きました（CLIへは何も送っていません）: ${path}`,
        );
        return;
      } catch {
        // 次の候補へ（ファイルが無い等）。最後まで開けなければループの外で案内する
      }
    }
    void vscode.window.showInformationMessage(
      'デバッグログがまだ見つかりません。セッションを開始した直後は書き込みが' +
        '間に合っていない可能性があります。少し待ってからもう一度お試しください。',
    );
  }

  /**
   * `/debug`を送り、実モデルにデバッグログを読ませて診断させる（issue #205、
   * design.md §14.39）。
   *
   * `requestUsageCredits`と同じく、実モデルが動き課金・ツール実行（承認カード）を
   * 伴いうる操作のため、必ず確認してから送る（`streamSession.ts`の`sendDebugCommand`
   * 参照）。
   */
  private async sendDebugCommand(entry: ClaudePanel): Promise<void> {
    if (!(await confirmDebugCommand())) {
      return;
    }
    try {
      // compact/importConfig/requestUsageCreditsと同じく新しいターンを起こす。
      // ループの指示と重ならないよう割り込み扱いにする
      this.noteUserAction(entry);
      entry.session.sendDebugCommand();
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * バックグラウンドタスクを止める（issue #33、design.md §14.23）。
   *
   * 実行中の処理を打ち切る破壊的な操作のため、必ず確認してから送る。止まったことは
   * `background_tasks_changed` 通知（一覧から消える）で画面に反映されるため、ここでは
   * 要求を出すだけでよい。
   */
  private async stopBackgroundTask(
    entry: ClaudePanel,
    taskId: string,
    command: string,
  ): Promise<void> {
    if (!(await confirmStopBackgroundTask(command))) {
      return;
    }
    try {
      entry.session.stopBackgroundTask(taskId);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * 行頭が !/# の入力を、拡張機能側の機能として実行する（issue #5/#6、design.md §14.29）。
   * `routeInputMode` が「送るべきでない」と判定した時点で呼ばれるため、ここではCLIへは
   * 一切送らない。
   */
  private async runInputMode(entry: ClaudePanel, mode: InputModeCall): Promise<void> {
    if (mode.kind === 'shell') {
      await this.runShellInputMode(entry, mode.command);
      return;
    }
    await this.runMemoryInputMode(entry, mode.content);
  }

  /**
   * シェルコマンドを統合ターミナルへ入力する（issue #5）。
   *
   * **自動実行はしない**。CLIの承認設定（`claude.permissionMode`）はモデルがツールを
   * 呼ぶときの仕組みで、ここで打つコマンドはユーザーが自分で書いた文字列そのものであり、
   * その仕組みを経由しない。拡張機能が代わりに自動実行すると、CLIの承認・サンドボックスの
   * 外側で任意コマンドを実行する経路になってしまうため、`openLoginTerminal`
   * （`controlPanelView.ts`）と同じ流儀で「入力するだけ」に留める。実行するかどうかは
   * 開いたターミナルでユーザーが自分でEnterを押して決める。
   */
  private async runShellInputMode(entry: ClaudePanel, command: string): Promise<void> {
    if (!(await confirmRunShellCommand(command))) {
      return;
    }
    openShellCommandTerminal(entry.cwd, command);
    entry.session.noteLocalEvent(
      `shellCommand:${randomUUID()}`,
      `シェルコマンドを統合ターミナルへ入力しました（自動実行はしていません）: ${command}`,
    );
  }

  /**
   * 内容をメモリ（CLAUDE.md）へ追記する（issue #6、issue #144で安全性を強化）。
   *
   * 追記先を選ばせ（各workspaceFolder + ユーザー、`resolveMemoryCandidates`）、内容・追記先
   * （シンボリックリンクなら実体パスも、実体パスが特定できなければ警告も）を確認してから
   * 書き込む。読み取りに`readStrict`（メモリ追記専用、ENOENT以外は投げる）を使うのは、
   * 既存ファイルの読み込みに失敗したときに「無い」と誤認して追記のつもりで上書きするのを
   * 防ぐため（issue #144の核心）。書き込み直前にシンボリックリンクの判定を取り直し、
   * 確認ダイアログを見せた時点の結果と食い違っていれば書き込みを中止する（TOCTOU対策。
   * 確認からユーザー応答までは不定長で、その間にリンク先が変わりうる）。
   * 書き込み後は「どこに書いたか」を会話に1行残す（受入基準）。
   */
  private async runMemoryInputMode(entry: ClaudePanel, content: string): Promise<void> {
    const candidates = await this.resolveMemoryCandidates(entry.cwd);
    const choice = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.label,
        description: c.exists ? '既存' : '新規作成',
        detail: c.path,
        candidate: c,
      })),
      { title: `メモリへ追記: ${content}`, placeHolder: '追記先を選んでください' },
    );
    if (choice === undefined) {
      return;
    }
    // 書き込み先はQuickPickが列挙した候補のパスに限る（パストラバーサルの入口を作らない。issue #144）
    const targetPath = choice.candidate.path;
    const confirmedSymlink = await this.resolveSymlinkTargetSafely(targetPath);

    if (!(await confirmMemoryAppend(content, targetPath, confirmedSymlink))) {
      return;
    }

    // TOCTOU対策: モーダル確認（ユーザー応答待ちで不定長）の間にリンク先が変わりうるため、
    // 書き込み直前に取り直し、確認時に見せた結果と食い違えば中止する（issue #144）。
    const symlinkAtWrite = await this.resolveSymlinkTargetSafely(targetPath);
    if (!symlinkResolutionEquals(confirmedSymlink, symlinkAtWrite)) {
      this.reportError(
        new Error(
          `追記先の状態が確認時から変わったため、書き込みを中止しました: ${targetPath}。もう一度操作しなおしてください。`,
        ),
      );
      return;
    }

    let existing: string | undefined;
    try {
      existing = await this.memoryFs.readStrict(targetPath);
    } catch (e) {
      // ENOENT以外の理由で読めなかった。「無い」と誤認して既存の内容を消さないよう、
      // ここで打ち切って書き込まない（issue #144の受入基準）
      this.reportError(e);
      return;
    }
    const next = appendMemoryLine(existing, content);
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), Buffer.from(next, 'utf8'));
    } catch (e) {
      this.reportError(e);
      return;
    }
    // 追記自体は既に成功しているため、記憶の失敗で処理全体は止めない。ただし黙って握り潰さず
    // 報告する（`src/orchestrator/runStore.ts` は同型の`update`を常に`await`しており、
    // fire-and-forgetのまま放置しない流儀に揃える。issue #144レビュー指摘）。
    try {
      await this.memoryMemento.update(MEMORY_LAST_SELECTED_PATH_KEY, targetPath);
    } catch (e) {
      this.reportError(e);
    }
    entry.session.noteLocalEvent(
      `memoryAppend:${randomUUID()}`,
      describeMemoryAppendResult(targetPath, symlinkAtWrite),
    );
  }

  /**
   * `this.memoryFs.resolveSymlinkTarget` を安全に呼ぶ。
   *
   * `MemoryFileSystemPort.resolveSymlinkTarget` はJSDoc上「例外を投げない」契約で、既定実装
   * （`nodeMemoryFileSystem`）もそのとおりだが、`memoryFs` はテストで差し替え可能な口のため、
   * 契約違反があっても追記処理全体を落とさず、実体パスが分からない扱いへ倒す
   * （防御的プログラミング。issue #144レビュー指摘）。
   */
  private async resolveSymlinkTargetSafely(filePath: string): Promise<SymlinkResolution> {
    try {
      return await this.memoryFs.resolveSymlinkTarget(filePath);
    } catch (e) {
      this.reportError(e);
      return { kind: 'unresolved' };
    }
  }

  /**
   * メモリ追記先の候補を列挙する（issue #144）。
   *
   * プロジェクト側は各workspaceFolderごとに1件出す（マルチルートワークスペースで
   * どのフォルダのCLAUDE.mdか分からない問題への対処、受入基準）。加えて、この画面の
   * 実際の作業ディレクトリ（`fallbackCwd`。タスクのworktree等でworkspaceFolderと
   * 一致しないことがある）がworkspaceFolderに含まれていなければ、それも候補へ足す
   * （従来どおりworktree自身のCLAUDE.mdへ追記できるようにするため）。
   * 存在確認は共有の `FileSystemPort.readTextFile`（読めなければ無い扱いでよい。
   * ここではラベル表示にしか使わず、書き込み判断には使わない）で行う。
   */
  private async resolveMemoryCandidates(fallbackCwd: string): Promise<MemoryCandidate[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((f) => ({ name: f.name, cwd: f.uri.fsPath }));
    if (!roots.some((r) => r.cwd === fallbackCwd)) {
      roots.push({ name: basename(fallbackCwd), cwd: fallbackCwd });
    }

    const projectInputs = await Promise.all(
      roots.map(async (r) => {
        const rootExists = (await this.fs.readTextFile(`${r.cwd}/CLAUDE.md`)) !== undefined;
        const dotClaudeExists =
          (await this.fs.readTextFile(`${r.cwd}/.claude/CLAUDE.md`)) !== undefined;
        return {
          name: r.name,
          cwd: r.cwd,
          rootClaudeMdExists: rootExists,
          dotClaudeMdExists: dotClaudeExists,
        };
      }),
    );
    const projectCandidates = buildProjectMemoryCandidates(projectInputs);

    const userPath = resolveUserMemoryFile(this.claudeHome);
    const userCandidate: MemoryCandidate = {
      label: 'ユーザー',
      path: userPath,
      exists: (await this.fs.readTextFile(userPath)) !== undefined,
    };

    const lastSelected = this.memoryMemento.get<string | undefined>(
      MEMORY_LAST_SELECTED_PATH_KEY,
      undefined,
    );
    return orderMemoryCandidates([...projectCandidates, userCandidate], lastSelected);
  }

  /**
   * ファイルを指定した発言の直前まで戻す。**会話の履歴には触れない**
   * （design.md「Claude Codeの巻き戻し」・Issue #21）。
   *
   * 手順: 1) dry_runで対象ファイルを確かめる（押しても何も起きないボタンにしない）
   * 2) 対象が無ければ、その旨を伝えて確認ダイアログは出さない
   * 3) 対象ファイルを列挙し「会話は変わらない」ことを明記した確認ダイアログ
   * 4) 承認されたら適用し、結果を必ず画面に返す（成功も失敗も黙って終わらせない）
   */
  private async rewindFiles(
    entry: ClaudePanel,
    userMessageId: string,
    resending = false,
  ): Promise<boolean> {
    let preview: Awaited<ReturnType<ClaudeStreamSession['previewRewindFiles']>>;
    try {
      preview = await entry.session.previewRewindFiles(userMessageId);
    } catch (e) {
      this.reportError(e);
      return false;
    }
    if (!preview.ok) {
      void vscode.window.showErrorMessage(
        `この発言まで戻せません: ${preview.error}（CLIのバージョンや実行環境によって使えないことがあります）`,
      );
      return false;
    }
    if (preview.filesChanged.length === 0) {
      void vscode.window.showInformationMessage('戻すファイルの変更はありませんでした。');
      return true;
    }
    if (entry.session.getState().busy) {
      void vscode.window.showErrorMessage('実行中の会話を停止してからファイルを戻してください');
      return false;
    }
    const confirmed = resending
      ? (await vscode.window.showWarningMessage(
          'ファイルも戻して新しいタブへ送り直しますか？',
          { modal: true, detail: preview.filesChanged.join('\n') },
          '戻して送信する',
        )) === '戻して送信する'
      : await confirmRewindFiles(preview.filesChanged);
    if (!confirmed || entry.session.getState().busy) {
      return false;
    }

    let result: Awaited<ReturnType<ClaudeStreamSession['applyRewindFiles']>>;
    try {
      result = await entry.session.applyRewindFiles(userMessageId);
    } catch (e) {
      this.reportError(e);
      return false;
    }
    if (!result.ok) {
      void vscode.window.showErrorMessage(`ファイルを戻せませんでした: ${result.error}`);
      return false;
    }
    void vscode.window.showInformationMessage(
      `${preview.filesChanged.length}件のファイルを戻しました: ${preview.filesChanged.join(', ')}`,
    );
    return true;
  }

  /**
   * 承認要求を受け取れない構成だと判ったときの案内。
   * 会話自体は続くため、通知は一度だけにする。
   */
  private warnApprovalsUnavailable(): void {
    if (this.approvalWarned) {
      return;
    }
    this.approvalWarned = true;
    void vscode.window.showWarningMessage(
      'この画面ではツール実行の承認を受け取れませんでした。claude.permissionMode の設定に従って動作します。',
    );
  }
}

/**
 * タブ名。解決順は「**オーケストレータが指定した名前（`pinnedName`）** > 人が付けた名前
 * （`state.name`） > 最初の指示から作った名前」（issue #199の受入基準、Issue #599）。
 * Claude Codeは要約名をCLI側に持たないため、最後は最初のユーザー発言から作る。
 *
 * `pinnedName`を最優先にするのは、**ワークフローが並列に開いたタスクを見分けるため**。
 * これが無いと、`openTaskSession`が渡したタブ名は初回表示の一瞬しか生き残らない。
 */
export function deriveTitle(state: ChatState, pinnedName?: string): string | undefined {
  if (pinnedName !== undefined && pinnedName.trim() !== '') {
    return pinnedName;
  }
  if (state.name !== undefined && state.name.trim() !== '') {
    return `${LABEL}: ${state.name}`;
  }
  const first = state.items.find((i) => i.kind === 'userMessage' && i.text.trim() !== '');
  if (first === undefined) {
    return undefined;
  }
  const text = first.text.replace(/\s+/gu, ' ').trim();
  return `${LABEL}: ${text.length > 32 ? `${text.slice(0, 32)}…` : text}`;
}

function randomSessionId(): string {
  return randomUUID();
}
