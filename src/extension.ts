import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ActivityLogger, nodeClock, resolveBufferDir } from './activity/activityLogger';
import type { RecordRequest as ActivityRequest } from './activity/activityLogger';
import { nodeActivityAppender } from './activity/nodeAppender';
import { ClaudeAgentProbe } from './claude/agentProbe';
import { ClaudeAuthActions } from './claude/authActions';
import { ClaudeAuthProbe } from './claude/authProbe';
import { claudePaths, resolveClaudeHome } from './claude/cliLocator';
import { ClaudeHooksProbe } from './claude/hooksProbe';
import { ClaudeMcpProbe } from './claude/mcpProbe';
import { ClaudeModelProbe } from './claude/modelProbe';
import { ClaudePluginActions } from './claude/pluginsActions';
import { ClaudePluginsProbe } from './claude/pluginsProbe';
import { ClaudeProvider } from './claude/provider';
import { ClaudeSessionNameStore } from './claude/sessionNames';
import { ClaudeSessionStore } from './claude/sessionStore';
import { ClaudeSkillsProbe } from './claude/skillsProbe';
import { ClaudeTranscriptWatcher } from './claude/transcriptWatcher';
import { CodexAccountActions } from './codex/accountActions';
import {
  AppServerConnection,
  type AppServerConnectionPort,
  type NotificationHandler,
  type ServerRequestHandler,
} from './appserver/connection';
import type { ClaudeSpawnPort } from './claude/streamSession';
import type { ClaudeConfig } from './claude/types';
import { AppServerClient } from './codex/appServerClient';
import { codexPaths, nodeLocatorDeps, resolveCodexHome } from './codex/cliLocator';
import { CodexProvider } from './codex/provider';
import type { CodexConfig, SessionMeta, SessionSummary } from './codex/types';
import type { UsageSnapshot } from './codex/usage';
import {
  currentWorkspaceFolder,
  readActivityLogConfig,
  readClaudeConfig,
  readConfig,
  readSessionPresetsConfig,
  readWorkflowsConfig,
  workspaceFolderPaths,
} from './config';
import {
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  WorktreeCreationQueue,
  type BranchNaming,
  type GitCommandRunner,
} from './orchestrator/worktree';
import {
  nodeCliAvailability,
  nodeCliCommandRunner,
  nodeForgeFileSystem,
  type CliAvailabilityPort,
  type CliCommandRunner,
  type FinalMergeConfig,
  type ForgeHostConfig,
  type PullRequestLayerConfig,
} from './orchestrator/forge';
import { startHttpMcpTransport } from './orchestrator/messaging';
import { nodePseudoWorktreeFileSystem } from './orchestrator/pseudoWorktree';
import {
  buildRoadmapPlanGoal,
  createCliIssueListPort,
  createTaskSessionRoadmapGenerationPort,
  generateRoadmap,
  nodeRoadmapFileSystem,
  parseRoadmapMarkdown,
  planWorkflowFromRoadmapPhases,
  splitRoadmapPhasesIntoChunks,
  type CorrectedIssue,
  type DroppedRoadmapDependency,
  type ParsedRoadmap,
  type RoadmapIssueEntry,
  type RoadmapPhase,
  withRoadmapReference,
  selectNextRoadmapPhase,
  validateRoadmap,
  type IssueListPort,
} from './orchestrator/roadmap';
import { sanitizeForLog } from './orchestrator/sanitize';
import { WorkflowRunStore } from './orchestrator/runStore';
import { ProgramStore } from './orchestrator/programStore';
import { ProgramRunner } from './orchestrator/programRunner';
import { WorkflowRunner, nodeWorkflowFilePort } from './orchestrator/runner';
import type { ExtensionSafetyBaseline } from './orchestrator/taskConfig';
import type { TaskSessionHost } from './orchestrator/taskSession';
import {
  buildWorkspaceSummary,
  nodePlannerWorkspacePort,
  planWorkflow,
  providerHintToProvider,
  resolveUniqueFileName,
  reviewWorkflowPlan,
  slugifyGoal,
  validateSlugInput,
  locateSecurityWarningLine,
  type PlanWorkflowResult,
} from './orchestrator/planner';
import { MAX_PROMPT_LENGTH, MAX_TASK_COUNT } from './orchestrator/workflow';
import type { Provider } from './orchestrator/workflow';
import {
  formatResolutionFailureMessage,
  resolveSpawnPath,
  ResolutionNotificationTracker,
} from './provider/executableResolution';
import { ProviderRegistry } from './provider/registry';
import type { AgentProvider } from './provider/types';
import { createLogger, type Logger } from './log';
import {
  buildEffectivePresetConfig,
  buildSessionPresetQuickPickLabel,
  resolveWorkingDirectory,
  type PresetSafetyBaseline,
  type SessionPreset,
} from './sessionPresets';
import { nodeCommandRunner as nodeAccountCommandRunner } from './process/commandRunner';
import { nodeFileSystem, nodeMemoryFileSystem } from './session/nodeFileSystem';
import { nodeFileScan } from './session/nodeFileScan';
import { FileMentionCatalog } from './provider/fileMentions';
import { InMemoryMetaCache } from './session/ports';
import { pruneMetaCacheOnStartup } from './session/pruneOnStartup';
import { SessionStore } from './session/sessionStore';
import { SessionActions, nodeCommandRunner, type SessionAction } from './session/sessionActions';
import { SessionWatcher } from './session/sessionWatcher';
import { UsageReader } from './session/usageReader';
import { PinnedSessionStore } from './util/pinnedSessions';
import {
  buildSelectionPayload,
  computeSelectionLineRange,
  selectionTextExceedsLimit,
  MAX_SELECTION_BYTES,
} from './util/editorSelection';
import { ChatViewManager } from './view/chatView';
import type { ActiveComposerTarget } from './view/activePanelSequence';
import { ClaudeChatViewManager } from './view/claudeChatView';
import { ControlPanelViewProvider } from './view/controlPanelView';
import { ConversationViewManager } from './view/conversationView';
import { formatRelativeTime } from './view/relativeTime';
import { SessionTreeProvider } from './view/sessionTreeProvider';
import { SettingsProvider } from './view/settingsProvider';
import { UsageStatusBar } from './view/usageStatusBar';
import { buildWorkflowMenuEntries } from './view/workflowMenu';
import { WorkflowViewManager } from './view/workflowView';

const META_CACHE_KEY = 'codex.metaCache.v1';

/**
 * `test/integration/**` だけが使う内部参照。エンドユーザー向けの公開APIではない
 * （このプロジェクトは他拡張機能からの利用を想定しておらず、`extensionDependencies` も
 * 無い）。VSCodeに依存する層（`view/**`）はユニットテストから触れないため（設計書 §11）、
 * `SessionTreeProvider` の実インスタンスをテストへ渡す最小限の口として `activate` の
 * 戻り値に載せる。
 */
export interface ExtensionTestApi {
  readonly sessionTree: SessionTreeProvider;
  /**
   * ワークフロー（design.md §16）の統合テスト（`test/integration`）専用の口。
   * `AGENT_SESSIONS_INTEGRATION_TEST=1` が立っているときだけ実体が入り、それ以外では
   * `undefined` になる（Issue #158）。
   */
  readonly workflow?: WorkflowTestApi | undefined;
  /**
   * チャット画面（design.md §9.5 / §14.4）の統合テスト専用の口。`workflow` と同じく
   * `AGENT_SESSIONS_INTEGRATION_TEST=1` が立っているときだけ実体が入る（Issue #186）。
   */
  readonly chat?: ChatTestApi | undefined;
}

/**
 * 統合テストからチャット画面を動かすための口（Issue #186）。
 *
 * 実VSCode上でCLI（codex / claude）を起動することはできないため、**CLIとの境界だけ**を
 * フェイクへ差し替える。ワークフロー（`WorkflowTestApi`）が `TaskSessionHost` を差し替える
 * のに対し、こちらはもう1段下（Codexは`app-server`との接続、Claude Codeはプロセスの起動）を
 * 差し替える。会話の組み立て・承認の往復・状態遷移・パネルの復元は実物を通る。
 */
export interface ChatTestApi {
  /**
   * Codex画面が使う `app-server` との接続を差し替える。`undefined` で実物へ戻る。
   *
   * 引数のファクトリは、`ChatViewManager` が実物へ渡しているのと同じ通知・要求のハンドラを
   * 受け取る。フェイクはここへ通知（`item/*` など）や承認要求を流し込める。
   */
  setCodexConnection(
    factory:
      | ((
          onNotification: NotificationHandler,
          onServerRequest: ServerRequestHandler,
        ) => AppServerConnectionPort)
      | undefined,
  ): void;
  /**
   * Claude Code画面が使う `claude` プロセスの起動を差し替える。`undefined` で実物へ戻る。
   *
   * stream-json の組み立てとcontrol protocolの往復は実物（`ClaudeStreamSession`）を通るため、
   * 送っている中身と順序をフェイク側で観測できる。
   */
  setClaudeSpawn(spawn: ClaudeSpawnPort | undefined): void;
  /**
   * 統合テスト専用: 指定したスレッドのCodex画面へ、webviewから届いたふりをした
   * メッセージを流し込む（Issue #187、`ChatViewManager.simulateWebviewMessage` 参照）。
   * 承認カードの決定・発言の送信・分岐など、本来はwebview内のクリックでしか起こせない
   * 操作を、実VSCode上でも駆動するための入口。
   */
  simulateCodexWebviewMessage(threadId: string, message: unknown): Promise<void>;
  /**
   * 統合テスト専用: 指定したセッションのClaude Code画面へ、webviewから届いたふりをした
   * メッセージを流し込む（Issue #188、`ClaudeChatViewManager.simulateWebviewMessage` 参照）。
   * `simulateCodexWebviewMessage` のClaude Code版で、考え方は同じ。
   */
  simulateClaudeWebviewMessage(sessionId: string, message: unknown): Promise<void>;
}

/**
 * 統合テストからワークフローを動かすための口（Issue #158）。
 *
 * 実VSCode上でCLI（codex / claude）を起動することはできない（`test/integration/fixtures/setup.mjs`
 * が実行ファイルパスを存在しないパスへ固定している）。CLIとの境界は `TaskSessionHost` の
 * `openTaskSession` 1メソッドだけなので、**そこだけ**をフェイクへ差し替え、worktreeの作成・
 * スケジューリング・状態遷移・ワークフローView・workspaceStateへの保存は実物を通す。
 */
export interface WorkflowTestApi {
  readonly runner: WorkflowRunner;
  /**
   * `provider` のタスクセッションの開き方を差し替える。`undefined` を渡すと実物
   * （`ChatViewManager` / `ClaudeChatViewManager`）へ戻る。
   */
  setTaskSessionHost(provider: Provider, host: TaskSessionHost | undefined): void;
  /**
   * PR/MRまわり（design.md §16.18）の差し替え（Issue #169・#172）。`gh` / `glab` の
   * 実行と、その前提の判定に使う設定を差し替える。**渡した項目だけ**が差し替わり、
   * 省略した項目は実物のまま（`{}` や `undefined` を渡すと全て実物へ戻る）。
   *
   * `git` も差し替えられるが、これは**実gitへ委譲しつつ呼び出しを記録する**ための口で
   * （Issue #172。design.md §16.18「作る順序」はpushとPR/MR作成の順序なので、CLIの記録
   * だけでは順序を確かめられない）、gitの動作そのものを置き換える用途ではない。
   */
  setForgeOverrides(overrides: ForgeOverrides | undefined): void;
}

/**
 * `WorkflowTestApi.setForgeOverrides` が受け取る差し替え。`WorkflowRunnerForgeDeps` の
 * うち、統合テストが実物と入れ替えたい3つだけを任意項目として持つ。
 */
export interface ForgeOverrides {
  cli?: CliCommandRunner;
  cliAvailability?: CliAvailabilityPort;
  readConfig?: () => {
    host: ForgeHostConfig;
    pullRequest: PullRequestLayerConfig;
    finalMerge: FinalMergeConfig;
    branchNaming: BranchNaming;
    draftPullRequest: boolean;
    createTaskIssue: boolean;
    reviewTaskPullRequest: boolean;
  };
  /**
   * `WorkflowRunner` が使うgitコマンドの実行（`WorkflowRunnerDeps.git`）。forgeまわり
   * だけでなくworktreeの作成・統合のマージも同じポートを通るため、渡すものは実gitへ
   * 委譲する実装であることが前提（Issue #172のテストは記録のためだけに使う）。
   */
  git?: GitCommandRunner;
}

/**
 * 統合テスト用の差し替えを受け付けるかどうか。`.vscode-test.mjs` の `env` で立てる。
 * 立っていなければ `activate` は `workflow` を返さず、差し替えの経路そのものが無くなる。
 */
function isIntegrationTestMode(): boolean {
  return process.env.AGENT_SESSIONS_INTEGRATION_TEST === '1';
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  const channel = vscode.window.createOutputChannel('Agent Sessions');
  const log = createLogger(channel);
  context.subscriptions.push(channel);

  const home = resolveCodexHome(readConfig().codexHome, nodeLocatorDeps);
  const paths = codexPaths(home);
  log.info(`CODEX_HOME=${home}`);

  const cache = new InMemoryMetaCache(
    context.globalState.get<Record<string, SessionMeta>>(META_CACHE_KEY) ?? {},
  );
  const store = new SessionStore(nodeFileSystem, paths, cache);
  // 実体が消えたセッションのメタキャッシュを起動時に掃除する（issue #382）。activateを
  // 妨げないよう非同期で投げっぱなしにし、失敗してもここで吸収する
  // （`pruneMetaCacheOnStartup` 参照）
  void pruneMetaCacheOnStartup(
    store,
    (removed) => {
      log.info(`起動時にメタキャッシュを${removed}件掃除しました`);
      return persistCache(context, cache);
    },
    log,
  );

  const claudeHome = resolveClaudeHome(readClaudeConfig().configDir, nodeLocatorDeps);
  const claudeDirs = claudePaths(claudeHome);
  log.info(`CLAUDE_CONFIG_DIR=${claudeHome}`);
  // 人が付け直したセッション名（issue #199）。globalStateはワークスペースをまたいで
  // 有効なため、セッションidがワークスペースをまたいでも一意であることと合わせられる
  const claudeSessionNames = new ClaudeSessionNameStore(context.globalState);
  const claudeStore = new ClaudeSessionStore(nodeFileSystem, claudeDirs, claudeSessionNames);

  const codex = new CodexProvider(store);
  const claude = new ClaudeProvider(claudeStore);
  const providers = new ProviderRegistry([codex, claude]);
  /** Codex固有の機能（app-server・設定パネル・破壊操作）が使う実行ファイル。 */
  const codexPath = createExecutablePathResolver(codex, log);

  const activity = new ActivityLogger(
    nodeActivityAppender,
    () => {
      const config = readActivityLogConfig();
      return {
        enabled: config.enabled,
        dir: resolveBufferDir(config.dir, process.env, nodeLocatorDeps.homedir()),
      };
    },
    nodeClock,
  );
  const recordActivity = (request: ActivityRequest): void => {
    void activity.record(request);
  };

  /** Claude Code固有の機能（設定パネル・モデル一覧）が使う実行ファイル。 */
  const claudePath = createExecutablePathResolver(claude, log);

  // 単発の問い合わせ（fork・モデル一覧・エージェント一覧・MCP一覧・hooks一覧・ログイン状態）に
  // 使う。会話用の接続とは別プロセス
  const appServer = new AppServerClient(codexPath, log);
  // 履歴の取得はまずthread/listを試し、空か失敗ならファイル読みへ退避する（issue #45）。
  // storeの構築時点ではcodexPath（codexの解決結果）がまだ無いため、appServerを作った
  // ここで事後に配線する
  store.attachThreadList((limit, archivedSessionsDir) =>
    appServer.listThreads(limit, archivedSessionsDir),
  );
  const claudeModels = new ClaudeModelProbe(claudePath, log);
  const claudeAgents = new ClaudeAgentProbe(claudePath, log);
  const claudeMcp = new ClaudeMcpProbe(claudePath, log);
  const claudeHooks = new ClaudeHooksProbe(claudePath, log);
  const claudeSkills = new ClaudeSkillsProbe(claudePath, log);
  const claudeAuth = new ClaudeAuthProbe(claudePath, log);
  // ログイン/ログアウトの実行はCLIサブコマンドへ委譲する（issue #29、accountActions.ts参照）
  const codexAccountActions = new CodexAccountActions(nodeAccountCommandRunner, codexPath);
  const claudeAuthActions = new ClaudeAuthActions(nodeAccountCommandRunner, claudePath);
  // plugins/appsの一覧・操作（issue #32、design.md §14.20）
  const claudePlugins = new ClaudePluginsProbe(claudePath, log);
  const claudePluginActions = new ClaudePluginActions(nodeAccountCommandRunner, claudePath);

  const settings = new SettingsProvider(
    nodeFileSystem,
    paths.modelsCache,
    paths.configToml,
    `${claudeDirs.home}/settings.json`,
    () => appServer.listModels(),
    () => claudeModels.read(),
    () => claudeAgents.read(),
    () => appServer.listMcpServers(),
    () => claudeMcp.read(),
    (name, enabled) => appServer.setMcpServerEnabled(name, enabled),
    (name, enabled) => claudeMcp.toggle(name, enabled),
    // hooks/list はcwdを渡さないと単発起動時のセッション既定に委ねる形になるため、
    // ワークスペースフォルダを明示する（issue #28、`hooksStatus.ts` のコメント参照）
    () => appServer.listHooks(workspaceFolderPaths()),
    () => claudeHooks.read(),
    (key, currentHash) => appServer.setHookTrusted(key, currentHash),
    // skills/list もcwdを渡さないと単発起動時のセッション既定に委ねる形になるため、
    // hooks/list と同じくワークスペースフォルダを明示する（issue #35、design.md TP-56）
    () => appServer.listSkills(workspaceFolderPaths()),
    () => claudeSkills.read(),
    (path, enabled) => appServer.setSkillEnabled(path, enabled),
    () => appServer.readAccount(),
    () => claudeAuth.read(),
    () => codexAccountActions.logout(),
    () => claudeAuthActions.logout(),
    (apiKey) => codexAccountActions.loginWithApiKey(apiKey),
    () => appServer.listPlugins(),
    () => claudePlugins.read(),
    (pluginName, marketplace) => appServer.installPlugin(pluginName, marketplace),
    (pluginId) => appServer.uninstallPlugin(pluginId),
    (id, scope, enabled) =>
      enabled ? claudePluginActions.enable(id, scope) : claudePluginActions.disable(id, scope),
    (spec, scope) => claudePluginActions.install(spec, scope),
    (id, scope) => claudePluginActions.uninstall(id, scope),
    () => appServer.listApps(),
    // インポート候補の検出もcwdを渡さないと単発起動時のセッション既定に委ねる形になるため、
    // hooks/skillsと同じくワークスペースフォルダを明示する（issue #36、design.md TP-57）
    () => appServer.detectImportCandidates(workspaceFolderPaths()),
    () => appServer.readImportHistories(),
    (items) => appServer.runImport(items),
    log,
  );
  // オーケストレータ（design.md §16）。`chat` / `claudeChat` は `WorkflowRunner` の
  // hostsとして要るため先に作れないが、`WorkflowRunner` は「このスレッドはタスク管理下か」を
  // `chat` / `claudeChat` へ答える口（`isTaskManagedThread`）を要求する（design.md §16.10の7）。
  // 循環しているため、書き換え可能な箱（`workflowRunnerRef`）を先に用意してクロージャに
  // 渡し、`WorkflowRunner` を実際に作った後で埋める
  // （レビュー指摘: critical 1。以前はこの口が一切結線されておらず、リロード後に
  // worktreeで走っていたタスクのタブが汎用復元へ拾われ、ワークスペース直下のcwdで
  // セッションが復活していた）。`workflowRunnerRef` 自体は再代入しないため `const`。
  const workflowRunnerRef: { current: WorkflowRunner | undefined } = { current: undefined };
  const isTaskManagedThread = (id: string): boolean =>
    workflowRunnerRef.current?.isTaskManagedSessionId(id) ?? false;

  // 設定パネルを開かずCodex画面だけ使う場合でも選択肢が揃うよう、起動時に読む
  void settings.load();
  // `@` のファイル候補。両方の画面で同じ一覧とキャッシュを使う
  const mentions = new FileMentionCatalog(nodeFileScan);

  // Codex画面の統合テスト（Issue #186）。`app-server` との接続を差し替えるための包み。
  // `ChatViewManager` は構築時に接続を1つ作るため、`activate()` が終わってから差し替える
  // には、常に間へ1枚挟んでおく必要がある。差し替えが無ければ実物へそのまま委譲するので、
  // 本番の経路は包みが無かったときと変わらない（`forgeOverrides` と同じ設計判断）。
  const chatConnectionOverride: { port?: AppServerConnectionPort } = {};
  let chatConnectionHandlers:
    { onNotification: NotificationHandler; onServerRequest: ServerRequestHandler } | undefined;
  /** Claude Code画面のプロセス起動の差し替え（Issue #186）。空なら実物が起動する。 */
  const claudeSpawnOverride: { spawn?: ClaudeSpawnPort } = {};

  // 設定パネル。Codex画面のインポートボタン（issue #227、下の`chat`構築）がパネルを
  // 表示してセクションを展開する経路（`revealSection`）を使うため、`chat`より先に
  // 構築しておく（以前はセッション一覧まわりの構築の後段でまとめて作っていた）
  const panel = new ControlPanelViewProvider(settings, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ControlPanelViewProvider.viewType, panel),
  );

  const chat = new ChatViewManager(
    codexPath,
    settings,
    home,
    nodeFileSystem,
    mentions,
    log,
    (activity) => recordActivity({ ...activity, source: 'codex' }),
    isTaskManagedThread,
    // インポートボタン（issue #227、design.md §14.42）。機能の実体は設定パネル側
    // （issue #36）にあるため、二重実装せずパネルを表示してセクションを展開するだけに
    // する（`codex.showUsage`コマンドと同じ、`codex.controlPanel.focus`で先に開く順序）
    async () => {
      await vscode.commands.executeCommand('codex.controlPanel.focus');
      panel.revealSection('codexImport');
    },
    (onNotification, onServerRequest, onDisconnect) => {
      chatConnectionHandlers = { onNotification, onServerRequest };
      const real = new AppServerConnection(
        codexPath,
        log,
        onNotification,
        onServerRequest,
        onDisconnect,
      );
      return {
        ensureStarted: () => (chatConnectionOverride.port ?? real).ensureStarted(),
        request: (method, params) => (chatConnectionOverride.port ?? real).request(method, params),
        dispose: () => {
          real.dispose();
          chatConnectionOverride.port?.dispose();
        },
      };
    },
  );
  context.subscriptions.push(chat);

  const claudeChat = new ClaudeChatViewManager(
    claudePath,
    nodeFileSystem,
    mentions,
    claudeHome,
    claudeStore,
    settings,
    log,
    (activity) => recordActivity({ ...activity, source: 'claude-code' }),
    (usage) => usageBar.updateClaude(usage),
    isTaskManagedThread,
    // メモリ追記（issue #6/#144）専用の読み取り口と、前回選んだ追記先の記憶先
    nodeMemoryFileSystem,
    context.workspaceState,
    // Claude Code画面の統合テスト（Issue #186）。セッションを作るたびに読み直すため、
    // `activate()` が終わった後からでも差し替えられる。
    () => claudeSpawnOverride.spawn,
  );
  context.subscriptions.push(claudeChat);

  const workflowStore = new WorkflowRunStore(context.workspaceState);
  // プログラム（複数runの束、design.md §16.37、roadmap W12-1、Issue #604）の永続化。
  // この段ではrunのスケジューリングは持たないため、実際に読み書きするのは
  // `reconcileAfterReload`（リロード直後の中断扱い）のみ
  const programStore = new ProgramStore(context.workspaceState);
  // 統合テスト（Issue #158）だけがここへフェイクを入れる。空のままなら常に実物へ委譲
  // するため、本番の経路は差し替え口が無かったときと変わらない。
  const taskSessionHostOverrides: Partial<Record<Provider, TaskSessionHost>> = {};
  const overridableHost = (provider: Provider, real: TaskSessionHost): TaskSessionHost => ({
    openTaskSession: (input) => (taskSessionHostOverrides[provider] ?? real).openTaskSession(input),
  });
  // PR/MRまわりの差し替え口（Issue #169・#172）。`gh` / `glab` の呼び出しと、その前提の
  // 判定に使う設定を統合テストから差し替えるためのもの。`taskSessionHostOverrides` と同じく
  // 空のままなら常に実物へ委譲するので、本番の経路は差し替え口が無かったときと変わらない。
  const forgeOverrides: ForgeOverrides = {};
  const workflowRunner = new WorkflowRunner({
    hosts: {
      codex: overridableHost('codex', chat),
      claude: overridableHost('claude', claudeChat),
    },
    worktreeQueue: new WorktreeCreationQueue(),
    git: {
      run: (args, cwd) => (forgeOverrides.git ?? nodeGitCommandRunner).run(args, cwd),
    },
    fs: nodeWorktreeFileSystem,
    filePort: nodeWorkflowFilePort,
    store: workflowStore,
    log,
    // `planWorkflowCommand`（#58）も同じ基準を使う。#52セキュリティ監査指摘の
    // クランプ入口を1つに保つのと同じ理由で、baselineの読み方も1箇所にまとめる
    readBaseline: readSafetyBaseline,
    // PR/MRの作成（design.md §16.18、Issue #105）。`agent.workflows.forge` は既定の
    // `auto`のままだと、`origin` remote・`gh`/`glab`の有無を実行のたびに確かめたうえで
    // 対応するホストへPR/MRを作る。前提が欠けていれば`runner.ts`側が警告のうえ
    // ローカルのマージだけへ倒す（`checkForgePrerequisites`。ワークフロー自体は止めない）
    forge: {
      cli: {
        run: (command, args, cwd) =>
          (forgeOverrides.cli ?? nodeCliCommandRunner).run(command, args, cwd),
      },
      cliAvailability: {
        isOnPath: (command) =>
          (forgeOverrides.cliAvailability ?? nodeCliAvailability).isOnPath(command),
      },
      fs: nodeForgeFileSystem,
      readConfig: () => {
        const c = readWorkflowsConfig();
        const actual = {
          host: c.forge,
          pullRequest: c.pullRequest,
          finalMerge: c.finalMerge,
          branchNaming: c.branchNaming,
          draftPullRequest: c.draftPullRequest,
          createTaskIssue: c.createTaskIssue,
          reviewTaskPullRequest: c.reviewTaskPullRequest,
        };
        return forgeOverrides.readConfig?.() ?? actual;
      },
    },
    // 疑似worktree（design.md §16.20、Issue #105）。gitの作業ツリーでないワークスペースで
    // `isolation: worktree`のタスクを走らせるときの隔離手段。`decideWorkingDirectory`の
    // `sharedFallback`から`resolveWorkingDirectory`が呼ぶ
    // ロードマップの更新（design.md §16.19、Issue #173）。runが終わったとき、`done`に
    // なったタスクに対応する項目のチェックを定義の`roadmap`が指すファイルへ書き戻す。
    roadmap: { fs: nodeRoadmapFileSystem },
    pseudoWorktree: {
      fs: nodePseudoWorktreeFileSystem,
      exclude: readWorkflowsConfig().pseudoWorktreeExclude,
    },
    // タスク間メッセージング（design.md §16.21、Issue #105・#123）。runごとにMCPサーバ
    // （HTTP。`messaging.ts`の`startHttpMcpTransport`のJSDoc参照）を立て、CLIの起動設定へ
    // 反映する配線・waitingReplyへの遷移は`src/view/`側と`runner.ts`で完結している
    // （`WorkflowRunnerMessagingDeps`のJSDoc参照）
    messaging: {
      startTransport: startHttpMcpTransport,
      readReplyTimeoutSec: () => readWorkflowsConfig().replyTimeoutSec,
    },
    // 衝突解決セッションの承認待ちアイドルタイムアウト（design.md §16.17「承認待ちの
    // アイドルタイムアウト」、Issue #413 PR5）。`messaging`（省略可能な機能）とは無関係に
    // 常に効かせるため、トップレベルへ配線する（`WorkflowRunnerDeps.readMergeApprovalTimeoutSec`
    // のJSDoc参照）
    readMergeApprovalTimeoutSec: () => readWorkflowsConfig().mergeApprovalTimeoutSec,
    // 通常タスクの承認待ちアイドルタイムアウト（design.md §16.39、Issue #579）。
    // `readMergeApprovalTimeoutSec`とは別のキーを読む（`mergeApprovalTimeoutSec`は
    // 衝突解決セッション専用）。`messaging`（省略可能な機能）とは無関係に常に効かせるため、
    // 同じくトップレベルへ配線する
    readTaskApprovalTimeoutSec: () => readWorkflowsConfig().taskApprovalTimeoutSec,
    // 最終マージの判断待ち（design.md §16.26、`finalMerge: orchestrator`）。オーケストレーターが
    // `decide_final_merge`で応答しない場合に自動的に`hold`へ倒すまでの秒数。`messaging`とは
    // 無関係に常に効かせるため、`readMergeApprovalTimeoutSec`と同じくトップレベルへ配線する
    readFinalMergeDecisionTimeoutSec: () => readWorkflowsConfig().finalMergeDecisionTimeoutSec,
    // CIの完了待ち・baseの取り込み直し（design.md §16.36、Issue #556）。`readMergeApprovalTimeoutSec`
    // と同じくトップレベルへ配線し、`performFinalMerge`が呼ぶたびに現在値を読み直す
    readCiWaitTimeoutSec: () => readWorkflowsConfig().ciWaitTimeoutSec,
    readCiUpdateBranchMaxRetries: () => readWorkflowsConfig().ciUpdateBranchMaxRetries,
    // レビューコメントの取得間隔（design.md §16.30、roadmap W5、Issue #339）。他のreadXxxと
    // 同じくトップレベルへ配線し、`finalizeForge`が呼ぶたびに現在値を読み直す
    readReviewCommentPollIntervalSec: () => readWorkflowsConfig().reviewCommentPollIntervalSec,
    // ask_user（design.md §16.33、Issue #583）の呼び出し上限。他のreadXxxと同じく
    // トップレベルへ配線し、`buildOrchestratorControlPort`が呼ぶたびに現在値を読み直す
    readMaxAskUserPerRun: () => readWorkflowsConfig().maxAskUserPerRun,
    // 自動再開（design.md §16.35、roadmap W10、Issue #584）。他のreadXxxと同じく
    // トップレベルへ配線し、`restoreRunsForView`が呼ぶたびに現在値を読み直す
    readAutoResume: () => readWorkflowsConfig().autoResume,
    readMaxAutoResumeAttempts: () => readWorkflowsConfig().maxAutoResumeAttempts,
  });
  // isTaskManagedThreadのクロージャが参照する箱を埋める。以降の`workflowRunner`
  // （コマンド登録などで使う）はこの束縛を指し、常にWorkflowRunnerとして扱える
  workflowRunnerRef.current = workflowRunner;
  // 生成したDisposableは生成直後にcontext.subscriptionsへ登録する（規約）。
  // `WorkflowRunner.dispose()`はオーケストレーターセッションを解放する契約（design.md
  // §16.23「セッションの生成と寿命」）だが、ここで登録し忘れると拡張機能の終了時に
  // 一度も呼ばれない（Issue #363）。`dispose()`は複数回呼ばれても安全
  // （`disposeOrchestrator`が`live.orchestrator`をundefinedへ戻すため冪等）。
  context.subscriptions.push({ dispose: () => workflowRunner.dispose() });

  // プログラム（design.md §16.37、roadmap W12-1・W12-2、Issue #604・#605）の永続化状態も、
  // 単発runと同じタイミングでリロード直後の中断扱いへ書き換える（W10の自動再開の対象に
  // 含める）。reconcile前後でプログラムごとに実際に書き換わったか（`running`だったrunが
  // `failed`へ倒れたか）を比較するため、先にrunごとの状態をスナップショットしておく
  const runStatesBeforeReconcile = new Map(
    programStore.list().map((p) => [p.programId, JSON.stringify(p.state)] as const),
  );
  // 波のスケジューリング（design.md §16.37.2、roadmap W12-2、Issue #605）。`WorkflowRunner`は
  // `ProgramWorkflowPort`（`start` / `listLive` / `onChanged`）を構造的に満たすため、
  // アダプタを挟まずそのまま渡す。
  //
  // **`workflowView`（次のブロック）より先に作る。** `WorkflowViewManager`のコンストラクタが
  // `programRunner.onChanged`を即座に購読するため（design.md §16.37.3のレビュー指摘F1、
  // Issue #606）、この時点で`programRunner`が存在している必要がある
  // （`halt`のようにクロージャ越しの遅延参照では済まない）
  const programRunner = new ProgramRunner({
    programStore,
    filePort: nodeWorkflowFilePort,
    workflow: workflowRunner,
    log,
  });
  programRunner.attach();
  context.subscriptions.push({ dispose: () => programRunner.dispose() });

  // ワークフローView（#57）。`restoreRunsForView`がworkspaceStateのreconcileと
  // メモリ上への復元（design.md §16.11「リロード後の実行再開」）を両方行う
  const workflowView = new WorkflowViewManager(workflowRunner, log, {
    list: () => programStore.list(),
    halt: (programId) => programRunner.haltProgram(programId),
    onChanged: (listener) => programRunner.onChanged(listener),
  });
  context.subscriptions.push(workflowView);
  const restoreRunsForViewDone = workflowRunner.restoreRunsForView().then(() => {
    const interrupted = workflowStore
      .list()
      .filter((r) => Object.values(r.tasks).some((t) => t.failure?.kind === 'reloadInterrupted'));
    if (interrupted.length > 0) {
      log.info(
        `リロードにより中断扱いにしたワークフロー実行: ${interrupted.map((r) => r.runId).join(', ')}`,
      );
    }
  });

  const reconcileProgramStoreDone = programStore.reconcileAfterReload().then((reconciled) => {
    const interruptedProgramIds = reconciled
      .filter((p) => runStatesBeforeReconcile.get(p.programId) !== JSON.stringify(p.state))
      .map((p) => p.programId);
    if (interruptedProgramIds.length > 0) {
      log.info(`リロードにより中断扱いにしたプログラム: ${interruptedProgramIds.join(', ')}`);
    }
  });
  // `programRunner.reconcileAfterReload()`は、`WorkflowRunner`側で生きている（＝W10が
  // 再開した）runを`ProgramState`とtrackedRunsへ拾い直す（design.md §16.37.2「リロードと
  // W10の自動再開の整合」、Issue #605のレビュー指摘F1）。そのため`workflowRunner.
  // restoreRunsForView()`（W10の自動再開そのもの）と`programStore.reconcileAfterReload()`
  // （`running`を暫定`failed`へ倒す側）の**両方が完了してから**呼ぶ必要がある。順序を
  // 崩すと、まだ再開されていない・まだfailedへ倒されていない状態を見て誤った判断をする
  void Promise.all([restoreRunsForViewDone, reconcileProgramStoreDone])
    .then(() => programRunner.reconcileAfterReload())
    .catch((e: unknown) => {
      log.error(
        `[program] リロード直後の整合に失敗しました: ${sanitizeForLog(
          e instanceof Error ? e.message : String(e),
        )}`,
      );
    });

  // ロードマップ（design.md §16.19、#95・配線はIssue #105）。既存Issueの取得は
  // `git remote` + `gh`/`glab` をポート越しに呼ぶだけなので、ここで実装を組み立てて渡す。
  const roadmapIssuePort = createCliIssueListPort(nodeGitCommandRunner, nodeCliCommandRunner);

  const conversations = new ConversationViewManager(nodeFileSystem, store, log, (session, turnId) =>
    forkFromTurn(codex, appServer, chat, tree, log, session, turnId),
  );
  context.subscriptions.push(conversations);

  const actions = new SessionActions(nodeCommandRunner, codexPath);

  // ピン留め（issue #293）。セッションidはワークスペースをまたいでも一意なため、
  // `ClaudeSessionNameStore`と同じくglobalStateへ持たせる
  const pinnedSessions = new PinnedSessionStore(context.globalState);
  // 開いているかどうかはチャット画面が持つ
  // 開いているか・実行中か・承認待ちかはチャット画面（`chat` / `claudeChat`）が持つ
  // （issue #286、design.md §14.55）。providerでどちらのマネージャへ引くかを決める
  const getSessionActivity = (session: SessionSummary) =>
    session.provider === 'claude'
      ? claudeChat.getActivityState(session.id)
      : chat.getActivityState(session.id);
  const tree = new SessionTreeProvider(providers, getSessionActivity, log, pinnedSessions);
  const sessionsView = vscode.window.createTreeView('codex.sessions', {
    treeDataProvider: tree,
    showCollapseAll: false,
  });
  context.subscriptions.push(tree, sessionsView);
  void tree.setScope(readConfig().historyScope);
  // プリセットが空のときはコマンドを出さない（issue #295、design.md §14.56）
  void updateSessionPresetsContext(log);

  // 絞り込み中はタイトルバーにその旨を出す（issue #293）。`setFilter`/`clearFilter`は
  // それぞれ`refresh()`まで済ませるので、ここでは表示テキストだけ合わせる
  const updateSessionFilterDescription = (): void => {
    // `TreeView.description`はexactOptionalPropertyTypesの都合でundefinedを明示代入できない
    // （vscode.d.tsの宣言が`description?: string`のため）。絞り込み無しは空文字で表す
    sessionsView.description = tree.filterActive ? `絞り込み中: "${tree.filterQuery}"` : '';
  };

  const usageReader = new UsageReader(nodeFileSystem, paths);
  const usageBar = new UsageStatusBar();
  context.subscriptions.push(usageBar);

  let usageSnapshot: UsageSnapshot | undefined;
  const readUsage = async (): Promise<void> => {
    // app-serverに聞ければ現在値が返る。繋がっていないときだけロールアウトを読む
    usageSnapshot = (await chat.readUsage()) ?? (await usageReader.read());
    usageBar.update(usageSnapshot);
    panel.setUsage(usageSnapshot);
  };
  // 会話中は追記が頻発するため間引く
  const readUsageDebounced = debounce(() => void readUsage(), 1_500);
  // リセットまでの残り時間の表記を進めるだけの再描画（ファイルは読まない）
  const ticker = setInterval(() => usageBar.update(usageSnapshot), 60_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(ticker)));
  void readUsage();

  const watcher = new SessionWatcher(paths, {
    onRolloutCreated: () => tree.refresh(),
    onRolloutChanged: () => readUsageDebounced(),
    onIndexChanged: () => {
      tree.refreshDebounced();
      void persistCache(context, cache);
    },
  });
  context.subscriptions.push(watcher);

  // Claude Codeには索引が無いため、transcriptの作成・追記を一覧更新の契機にする
  const claudeWatcher = new ClaudeTranscriptWatcher(claudeDirs, {
    onTranscriptChanged: () => {
      tree.refreshDebounced();
    },
  });
  context.subscriptions.push(claudeWatcher);

  // リロード後にチャット画面のタブを復元する
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codex.chat', {
      deserializeWebviewPanel: (panel, state) => chat.restorePanel(panel, state),
    }),
    vscode.window.registerWebviewPanelSerializer('claude.chat', {
      deserializeWebviewPanel: (panel, state) => claudeChat.restorePanel(panel, state),
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codex') || e.affectsConfiguration('claude')) {
        void panel.refresh();
        chat.refreshSettings();
        tree.refresh();
      }
      if (e.affectsConfiguration('agent.sessionPresets')) {
        void updateSessionPresetsContext(log);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codex.openSession',
      withSession(log, 'codex.openSession', (s) => openSession(chat, claudeChat, log, s)),
    ),
    vscode.commands.registerCommand('codex.resumeSession', () =>
      pickAndResume(providers, chat, claudeChat, tree, log),
    ),
    vscode.commands.registerCommand('codex.resumeLast', () =>
      resumeLast(providers, chat, claudeChat, tree, log),
    ),
    vscode.commands.registerCommand('codex.refreshSessions', () => tree.refresh()),
    vscode.commands.registerCommand('codex.showAllSessions', () => tree.setScope('all')),
    vscode.commands.registerCommand('codex.showWorkspaceSessions', () =>
      tree.setScope('workspace'),
    ),
    // 履歴の絞り込み（issue #293）。セッション名・作業ディレクトリに対する部分一致
    vscode.commands.registerCommand('codex.filterSessions', async () => {
      const value = await vscode.window.showInputBox({
        title: '履歴を絞り込む',
        prompt: 'セッション名・作業ディレクトリに対して部分一致で絞り込みます',
        placeHolder: '例: 認証まわり, my-project',
        value: tree.filterQuery,
      });
      // Escでのキャンセルはundefinedが返る。空文字での確定（クリア相当）とは区別し、
      // キャンセル時は現在の絞り込みを変えない
      if (value === undefined) {
        return;
      }
      await tree.setFilter(value);
      updateSessionFilterDescription();
    }),
    vscode.commands.registerCommand('codex.clearSessionFilter', async () => {
      await tree.clearFilter();
      updateSessionFilterDescription();
    }),
    // ピン留め（issue #293）。globalStateへ保存し、先頭のグループへ出す
    vscode.commands.registerCommand(
      'codex.pinSession',
      withSession(log, 'codex.pinSession', (s) => void tree.pin(s)),
    ),
    vscode.commands.registerCommand(
      'codex.unpinSession',
      withSession(log, 'codex.unpinSession', (s) => void tree.unpin(s)),
    ),
    vscode.commands.registerCommand('codex.showUsage', async () => {
      await vscode.commands.executeCommand('codex.controlPanel.focus');
      await readUsage();
    }),
    vscode.commands.registerCommand('codex.newChat', () => chat.openNew()),
    vscode.commands.registerCommand('claude.newChat', () => claudeChat.openNew()),
    // プリセットを選んで新しい会話を開く（issue #295、design.md §14.56）。既存の
    // `codex.newChat` / `claude.newChat` は変えず、別コマンドとして追加する
    vscode.commands.registerCommand('agent.openPresetChat', () =>
      openPresetChat(chat, claudeChat, log),
    ),
    vscode.commands.registerCommand(
      'claude.openChat',
      withSession(log, 'claude.openChat', (s) => {
        void claudeChat.openThread(s.id, s.threadName ?? s.id.slice(0, 8), s.cwd);
      }),
    ),
    // 設定パネルの「読み直す」から会話中のセッションへ橋渡しする（issue #202、
    // design.md TP-90）。`newSession` と同じ、webview→VS Codeコマンド→この画面の
    // 管理クラス、という経路
    vscode.commands.registerCommand('claude.reloadSkills', () =>
      claudeChat.reloadSkillsForOpenSessions(),
    ),
    // 会話をクリアして同じフォルダで開き直す（TUI/CLIの `/clear` 相当）。対象は
    // 名前変更と同じく最後にアクティブだったチャット画面
    vscode.commands.registerCommand('codex.clearChat', () => chat.clearActive()),
    vscode.commands.registerCommand('claude.clearChat', () => claudeChat.clearActive()),
    vscode.commands.registerCommand('codex.renameChat', () => chat.renameActive()),
    // 保存後にツリーへ即時反映させる（issue #199）。転記漏れ防止のため、
    // キャンセル時も含めて常に呼ぶ（`codex.refreshSessions` と同じく副作用が無いため安全）
    vscode.commands.registerCommand('claude.renameChat', async () => {
      await claudeChat.renameActive();
      tree.refresh();
    }),
    vscode.commands.registerCommand(
      'codex.openChat',
      withSession(log, 'codex.openChat', (s) => {
        void chat.openThread(s.id, s.threadName ?? s.id.slice(0, 8), s.cwd);
      }),
    ),
    vscode.commands.registerCommand(
      'codex.openConversation',
      withSession(log, 'codex.openConversation', (s) => {
        void conversations.open(s);
      }),
    ),
    // `codex.forkSession` / `claude.forkSession` はコマンド自体を分ける（`codex.openChat` /
    // `claude.openChat` と同じ、プロバイダ別にコマンドを分ける慣習。package.jsonのメニューの
    // `when` 句で対象セッションを絞り込む）が、実処理の `forkSession` 関数は共通化する
    // （issue #218）
    vscode.commands.registerCommand(
      'codex.forkSession',
      withSession(log, 'codex.forkSession', (s) => {
        void forkSession(providers, chat, claudeChat, log, s);
      }),
    ),
    vscode.commands.registerCommand(
      'claude.forkSession',
      withSession(log, 'claude.forkSession', (s) => {
        void forkSession(providers, chat, claudeChat, log, s);
      }),
    ),
    vscode.commands.registerCommand(
      'codex.archiveSession',
      withSession(log, 'codex.archiveSession', (s) => {
        void runAction(actions, tree, log, 'archive', s);
      }),
    ),
    vscode.commands.registerCommand(
      'codex.unarchiveSession',
      withSession(log, 'codex.unarchiveSession', (s) => {
        void runAction(actions, tree, log, 'unarchive', s);
      }),
    ),
    vscode.commands.registerCommand(
      'codex.deleteSession',
      withSession(log, 'codex.deleteSession', (s) => {
        void runAction(actions, tree, log, 'delete', s);
      }),
    ),
    vscode.commands.registerCommand('codex.showLog', () => log.show()),
    // エディタの選択範囲をチャットへ送る（issue #292、design.md §14.57）。
    // 送信はしない（入力欄へ挿すだけ）
    vscode.commands.registerCommand('agent.sendSelectionToChat', () =>
      sendEditorSelectionToChat(chat, claudeChat),
    ),
    vscode.commands.registerCommand('agent.workflows.run', () =>
      runWorkflow(workflowRunner, workflowView, log),
    ),
    vscode.commands.registerCommand('agent.workflows.runProgram', () =>
      runProgram(programRunner, log),
    ),
    vscode.commands.registerCommand('agent.workflows.stop', () => stopWorkflow(workflowRunner)),
    vscode.commands.registerCommand('agent.workflows.stopProgram', () =>
      stopProgram(programRunner, programStore),
    ),
    vscode.commands.registerCommand('agent.workflows.view', () => workflowView.show()),
    vscode.commands.registerCommand('agent.workflows.plan', (providerHint?: unknown) =>
      planWorkflowCommand(chat, claudeChat, workflowView, log, providerHint),
    ),
    vscode.commands.registerCommand('agent.workflows.roadmap', (providerHint?: unknown) =>
      runRoadmap(roadmapIssuePort, chat, claudeChat, log, providerHint),
    ),
    vscode.commands.registerCommand('agent.workflows.menu', (providerHint?: unknown) =>
      showWorkflowMenu(workflowRunner, providerHint),
    ),
  );

  return {
    sessionTree: tree,
    chat: isIntegrationTestMode()
      ? {
          setCodexConnection: (factory) => {
            chatConnectionOverride.port?.dispose();
            if (factory === undefined) {
              delete chatConnectionOverride.port;
              return;
            }
            if (chatConnectionHandlers === undefined) {
              // `ChatViewManager` は構築時に接続を1つ作るため、ここへ来る時点で必ず埋まっている
              throw new Error('Codex画面の接続がまだ作られていません');
            }
            chatConnectionOverride.port = factory(
              chatConnectionHandlers.onNotification,
              chatConnectionHandlers.onServerRequest,
            );
          },
          setClaudeSpawn: (spawnPort) => {
            if (spawnPort === undefined) {
              delete claudeSpawnOverride.spawn;
              return;
            }
            claudeSpawnOverride.spawn = spawnPort;
          },
          simulateCodexWebviewMessage: (threadId, message) =>
            chat.simulateWebviewMessage(threadId, message),
          simulateClaudeWebviewMessage: (sessionId, message) =>
            claudeChat.simulateWebviewMessage(sessionId, message),
        }
      : undefined,
    workflow: isIntegrationTestMode()
      ? {
          runner: workflowRunner,
          setTaskSessionHost: (provider, host) => {
            if (host === undefined) {
              delete taskSessionHostOverrides[provider];
              return;
            }
            taskSessionHostOverrides[provider] = host;
          },
          setForgeOverrides: (overrides) => {
            delete forgeOverrides.cli;
            delete forgeOverrides.cliAvailability;
            delete forgeOverrides.readConfig;
            delete forgeOverrides.git;
            if (overrides === undefined) {
              return;
            }
            if (overrides.cli !== undefined) {
              forgeOverrides.cli = overrides.cli;
            }
            if (overrides.cliAvailability !== undefined) {
              forgeOverrides.cliAvailability = overrides.cliAvailability;
            }
            if (overrides.readConfig !== undefined) {
              forgeOverrides.readConfig = overrides.readConfig;
            }
            if (overrides.git !== undefined) {
              forgeOverrides.git = overrides.git;
            }
          },
        }
      : undefined,
  };
}

/** `workflowRunner` / `planWorkflowCommand` が共通して使うクランプ基準（design.md §16.16）。 */
function readSafetyBaseline(): ExtensionSafetyBaseline {
  return {
    codexSandbox: readConfig().codex.sandbox,
    codexApprovalMode: readConfig().codex.approvalMode,
    claudePermissionMode: readClaudeConfig().claude.permissionMode,
    allowAutoApprove: readWorkflowsConfig().allowAutoApprove,
    allowClaudeBypassPermissions: readWorkflowsConfig().allowClaudeBypassPermissions,
  };
}

/**
 * `agent.hasSessionPresets` コンテキストキーを更新する（issue #295、design.md §14.56）。
 *
 * `package.json`の`menus.commandPalette`・`view/title`の`when`句がこれを見て、プリセットが
 * 空（既定）のときは「プリセットから新しい会話を開く」を出さない。検証で無視した項目が
 * あればここでログにも残す（活性化のたび・設定変更のたびに呼ぶため、ここで
 * `showWarningMessage`は出さない。実際に選ぶ操作をしたときの`openPresetChat`側で通知する）。
 */
async function updateSessionPresetsContext(log: Logger): Promise<void> {
  const { presets, warnings } = readSessionPresetsConfig();
  for (const w of warnings) {
    log.warn(w);
  }
  await vscode.commands.executeCommand('setContext', 'agent.hasSessionPresets', presets.length > 0);
}

interface SessionPresetPick extends vscode.QuickPickItem {
  preset: SessionPreset;
}

/**
 * プリセットを選んで新しい会話を開く（issue #295、design.md §14.56）。
 *
 * QuickPickの表示文字列の組み立ては`buildSessionPresetQuickPickLabel`（`src/sessionPresets.ts`）
 * へ切り出した。実際に会話を開く処理は`applyPresetChat`が担う。
 */
async function openPresetChat(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
): Promise<void> {
  const { presets, warnings: parseWarnings } = readSessionPresetsConfig();
  for (const w of parseWarnings) {
    log.warn(w);
  }
  // `when`句（`agent.hasSessionPresets`）で通常は出ないはずだが、コマンドパレットの
  // 直接実行など`when`句を経由しない呼び出しに備えて実行時にも防御する
  if (presets.length === 0) {
    void vscode.window.showInformationMessage(
      'プリセットが設定されていません（設定 agent.sessionPresets）',
    );
    return;
  }

  const baseline = readSafetyBaseline();
  const items: SessionPresetPick[] = presets.map((preset) => ({
    ...buildSessionPresetQuickPickLabel(preset, baseline),
    preset,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'プリセットを選択' });
  if (picked === undefined) {
    return;
  }

  await applyPresetChat(picked.preset, baseline, chat, claudeChat, log);
}

/**
 * 選んだプリセットの実効値（`buildEffectivePresetConfig`、拡張機能側の現在の設定より
 * 緩めない）を組み立て、作業ディレクトリを解決してから会話を開く。
 *
 * `chat.openNew` / `claudeChat.openNew` は`cwd`/`taskConfig`を渡せる既存のAPI
 * （`src/view/chatView.ts` / `src/view/claudeChatView.ts`。ワークフローのタスクセッションが
 * 使っているのと同じ経路）にそのまま乗せる。`chatView.ts` / `claudeChatView.ts` 自体は
 * 変更しない。
 */
async function applyPresetChat(
  preset: SessionPreset,
  baseline: PresetSafetyBaseline,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
): Promise<void> {
  const effective = buildEffectivePresetConfig(preset, baseline);
  const warnings = [...effective.warnings];

  const resolvedCwd = await resolveWorkingDirectory(
    preset.workingDirectory,
    workspaceFolderPaths(),
  );
  if (resolvedCwd.warning !== undefined) {
    warnings.push(resolvedCwd.warning);
  }
  // 出力チャネルへは、この後フォルダ選択をキャンセルして会話を開かなかった場合でも残す
  // （設定の異常はキャンセルの有無に関わらず記録しておく価値があるため）
  for (const w of warnings) {
    log.warn(w);
  }

  let cwd = resolvedCwd.path;
  if (cwd === undefined) {
    // マルチルートのときだけ作業ディレクトリを選ばせる（issue #295の受入基準。
    // フォルダが1つのときは毎回1択を選ばせず、`openNew`の既定（`currentWorkspaceFolder`）に委ねる）
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 1) {
      const pickedFolder = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: '作業ディレクトリを選択' },
      );
      if (pickedFolder === undefined) {
        return;
      }
      cwd = pickedFolder.folder.uri.fsPath;
    }
  }

  if (warnings.length > 0) {
    void vscode.window.showWarningMessage(
      `プリセット「${preset.name}」の一部の指定を無視しました:\n${warnings.join('\n')}`,
    );
  }

  if (effective.provider === 'codex') {
    const base = readConfig().codex;
    const config: CodexConfig = {
      ...base,
      model: effective.model,
      reasoningEffort: effective.effort,
      approvalMode: effective.approvalMode,
      sandbox: effective.sandbox,
    };
    await chat.openNew(cwd, config);
  } else {
    const base = readClaudeConfig().claude;
    const config: ClaudeConfig = {
      ...base,
      model: effective.model,
      effort: effective.effort,
      permissionMode: effective.approvalMode,
    };
    await claudeChat.openNew(cwd, config);
  }
}

/**
 * 定義ファイルを選んで実行し、ワークフローViewを開く（design.md §16.8）。
 *
 * `allow` を含むタスクがあれば、`runner.start` が `needsAllowConfirmation` を返す
 * （design.md §16.7「実行開始時に...確認を取る」）。ここで確認し、了承が得られたときだけ
 * `allowConfirmed: true` を付けて呼び直す。
 */
async function runWorkflow(
  runner: WorkflowRunner,
  view: WorkflowViewManager,
  log: Logger,
): Promise<void> {
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('ワークフローを実行するにはフォルダを開いてください');
    return;
  }
  const dir = readWorkflowsConfig().dir;
  const pattern = new vscode.RelativePattern(folder, `${dir}/**/*.{yaml,yml}`);
  const files = await vscode.workspace.findFiles(pattern, undefined, 200);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      `ワークフロー定義が見つかりません（${dir} 配下に .yaml / .yml を置いてください）`,
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    files.map((f) => ({ label: vscode.workspace.asRelativePath(f), file: f })),
    { placeHolder: '実行するワークフロー定義を選択' },
  );
  if (picked === undefined) {
    return;
  }

  let result = await runner.start(picked.file.fsPath, folder.uri.fsPath);
  if (!result.ok && result.needsAllowConfirmation === true) {
    const ids = (result.allowTaskIds ?? []).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `このワークフローは既定の危険操作チェックを解除しているタスクがあります（${ids}）。` +
        'これらのタスクでは allow に一致する操作が承認なしで実行されます。実行しますか？',
      { modal: true },
      '実行する',
    );
    if (choice !== '実行する') {
      return;
    }
    result = await runner.start(picked.file.fsPath, folder.uri.fsPath, { allowConfirmed: true });
  }
  if (!result.ok) {
    const detail = (result.errors ?? []).map((e) => e.message).join('\n');
    log.error(`ワークフローを開始できません:\n${detail}`);
    void vscode.window.showErrorMessage(`ワークフローを開始できません: ${detail}`);
    return;
  }
  void vscode.window.showInformationMessage(`ワークフローを開始しました: ${picked.label}`);
  view.show(result.runId);
}

/**
 * プログラム定義ファイルを選んで実行する（design.md §16.37.2、roadmap W12-2、Issue #605）。
 *
 * `runWorkflow`と同じ形のQuickPick選択にしてあるが、探索ディレクトリは`.agents/programs`
 * 固定。兄弟の`runWorkflow`は`readWorkflowsConfig().dir`で探索先を設定できるが、
 * プログラム側は現時点で設定項目を増やしたくないため、あえて固定パスにした
 * （design.md §16.37.2「設定・固定パスの判断」。「既存の慣例」を根拠にしていた
 * 以前の記述はIssue #605のレビュー指摘F4により誤り。この`.agents/programs`という
 * 文字列自体はW12-1でこの機能のために新規に決めたもので、先行する慣例は無い）。
 *
 * ワークフローView（`agent.workflows.view`）は、起動した各runを個別に確認できることに加えて
 * W12-3（design.md §16.37.3、Issue #606）でプログラム全体の状態（各runの進捗・失敗伝播による
 * スキップ理由・人による停止の有無）も表示するようになった。停止は`agent.workflows.stopProgram`
 * コマンド、またはワークフローView内の「プログラムを停止」ボタンから行える（`stopProgram`）。
 */
async function runProgram(programRunner: ProgramRunner, log: Logger): Promise<void> {
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('プログラムを実行するにはフォルダを開いてください');
    return;
  }
  const dir = '.agents/programs';
  const pattern = new vscode.RelativePattern(folder, `${dir}/**/*.{yaml,yml}`);
  const files = await vscode.workspace.findFiles(pattern, undefined, 200);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      `プログラム定義が見つかりません（${dir} 配下に .yaml / .yml を置いてください）`,
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    files.map((f) => ({ label: vscode.workspace.asRelativePath(f), file: f })),
    { placeHolder: '実行するプログラム定義を選択' },
  );
  if (picked === undefined) {
    return;
  }

  const result = await programRunner.startProgram(picked.file.fsPath, folder.uri.fsPath);
  if (!result.ok) {
    const detail = (result.errors ?? []).map((e) => e.message).join('\n');
    log.error(`プログラムを開始できません:\n${detail}`);
    void vscode.window.showErrorMessage(`プログラムを開始できません: ${detail}`);
    return;
  }
  void vscode.window.showInformationMessage(`プログラムを開始しました: ${picked.label}`);
}

/** 実行中のワークフローを選んで停止する。 */
async function stopWorkflow(runner: WorkflowRunner): Promise<void> {
  const live = runner.listLive().filter((r) => r.outcome === 'running');
  if (live.length === 0) {
    void vscode.window.showInformationMessage('実行中のワークフローはありません');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    live.map((r) => ({
      label: r.name === '' ? r.runId : r.name,
      description: r.defPath,
      runId: r.runId,
    })),
    { placeHolder: '停止するワークフロー実行を選択' },
  );
  if (picked === undefined) {
    return;
  }
  runner.stop(picked.runId);
}

/**
 * 実行中のプログラムを選んで人の手で止める（design.md §16.37.3、roadmap W12-3、Issue #606）。
 *
 * `stopWorkflow`と対になるコマンド。停止対象は`programStore.list()`のうち未完了
 * （`finishedAt === undefined`）のものに絞る。実際の停止処理は`ProgramRunner.haltProgram`が
 * 持つ（配下の生存中runへの`stop`呼び出し・`haltedByUser`の永続化・保留中runの一括skipped化）。
 */
async function stopProgram(
  programRunner: ProgramRunner,
  programStore: ProgramStore,
): Promise<void> {
  const unfinished = programStore.list().filter((p) => p.finishedAt === undefined);
  if (unfinished.length === 0) {
    void vscode.window.showInformationMessage('実行中のプログラムはありません');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    unfinished.map((p) => ({
      label: p.state.haltedByUser ? `${p.defPath}（停止処理中）` : p.defPath,
      description: p.programId,
      programId: p.programId,
    })),
    { placeHolder: '停止するプログラムを選択' },
  );
  if (picked === undefined) {
    return;
  }
  await programRunner.haltProgram(picked.programId);
}

/**
 * ワークフローの操作をまとめたQuickPick（issue #250、design.md §16.22）。
 *
 * サイドパネル（Agentsビューのタイトル行）とチャット画面（`#composer` のアイコン）の
 * どちらから押してもこれが開く。項目の組み立ては `buildWorkflowMenuEntries` にあり、
 * ここは実行中の件数を数えて選ばれたコマンドへ渡すだけにしてある。
 *
 * `providerHint` はチャット画面から押されたときだけ入る（その画面のプロバイダ）。生成系の
 * コマンドへそのまま素通しし、どのエージェントで生成するかの判断は受け手に委ねる。
 */
async function showWorkflowMenu(runner: WorkflowRunner, providerHint?: unknown): Promise<void> {
  const runningCount = runner.listLive().filter((r) => r.outcome === 'running').length;
  const picked = await vscode.window.showQuickPick(buildWorkflowMenuEntries(runningCount), {
    placeHolder: 'ワークフロー（複数タスクの並列実行）の操作を選択',
  });
  if (picked === undefined) {
    return;
  }
  await vscode.commands.executeCommand(picked.command, providerHint);
}

/**
 * 生成セッション（分解・ロードマップ）を走らせるプロバイダを決める（issue #266）。
 *
 * チャット画面のアイコンから起動したときは、その画面のプロバイダをそのまま使う
 * （Claude Codeの画面から押したらClaude Codeで生成する）。サイドパネルやコマンド
 * パレットのように起動元が特定できないときだけ、その場で選んでもらう。
 *
 * `hint` は `executeCommand` の引数、つまり拡張機能の外からも渡せる値なので、
 * `isProvider` を通してから使う（未知の文字列は「指定なし」と同じ扱いにする）。
 * 選択せずに閉じたときは `undefined` を返し、呼び出し側は何もしない。
 */
async function resolvePlannerProvider(hint: unknown): Promise<Provider | undefined> {
  const fromHint = providerHintToProvider(hint);
  if (fromHint !== undefined) {
    return fromHint;
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Codex', description: 'codex CLIで生成します', provider: 'codex' as const },
      {
        label: 'Claude Code',
        description: 'claude CLIで生成します',
        provider: 'claude' as const,
      },
    ],
    { placeHolder: '生成に使うエージェントを選択', ignoreFocusOut: true },
  );
  return picked?.provider;
}

/**
 * エディタの選択範囲をチャットの入力欄へ送る（issue #292、design.md §14.57）。
 *
 * 「パス:開始行-終了行」を見出し行にした本文を、直近にアクティブだったタブの入力欄へ
 * 挿すだけで、**送信はしない**（人が指示を書き足してから自分で送る。受入基準）。
 * メニューの`when`句（`editorHasSelection`）で選択が空のときは通常出ないが、
 * コマンドパレット経由の直接実行に備えて実行時にも防御する。
 */
async function sendEditorSelectionToChat(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    return;
  }

  const text = editor.document.getText(editor.selection);
  if (selectionTextExceedsLimit(text)) {
    void vscode.window.showWarningMessage(
      `選択範囲が大きすぎるため送れません（上限${MAX_SELECTION_BYTES}バイト）`,
    );
    return;
  }

  const range = computeSelectionLineRange(
    editor.selection.start.line,
    editor.selection.end.line,
    editor.selection.end.character,
  );
  const payload = buildSelectionPayload(
    workspaceRelativeDisplayPath(editor.document.uri),
    range,
    text,
  );

  // 複数開いているときは直近にアクティブだったタブを使う（Codex/Claude Codeを横断して
  // `activeSequence`で比べる。`ChatViewManager.getActiveComposerTarget`のJSDoc参照）
  const target = pickActiveComposerTarget(chat, claudeChat);
  if (target !== undefined) {
    target.insert(payload);
    return;
  }

  // チャットタブが1枚も無いときは、新しい会話を開いてから挿入する（受入基準）。
  // 起動元がエディタのため、どちらのエージェントを使うかは選んでもらう
  // （`resolvePlannerProvider`と同じ形だが、文言が「生成」専用のため使い回さない）
  const provider = await pickProviderForNewChat();
  if (provider === undefined) {
    return;
  }
  const manager = provider === 'codex' ? chat : claudeChat;
  await manager.openNew();
  manager.getActiveComposerTarget()?.insert(payload);
}

/** Codex/Claude Codeのうち、より最近アクティブだった方の挿入先を返す。両方無ければ`undefined`。 */
function pickActiveComposerTarget(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
): ActiveComposerTarget | undefined {
  const codex = chat.getActiveComposerTarget();
  const claude = claudeChat.getActiveComposerTarget();
  if (codex === undefined) {
    return claude;
  }
  if (claude === undefined) {
    return codex;
  }
  return codex.activeSequence >= claude.activeSequence ? codex : claude;
}

/**
 * 選択範囲を送るための新しい会話を、どちらのエージェントで開くか選ばせる（issue #292）。
 * `resolvePlannerProvider`（issue #266）と同じ形のQuickPickだが、あちらの文言は
 * 「生成」専用（ワークフローの分解・ロードマップ生成）のためこの用途では使い回さない。
 */
async function pickProviderForNewChat(): Promise<Provider | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Codex',
        description: 'codex CLIで新しい会話を開きます',
        provider: 'codex' as const,
      },
      {
        label: 'Claude Code',
        description: 'claude CLIで新しい会話を開きます',
        provider: 'claude' as const,
      },
    ],
    { placeHolder: '新しい会話を開くエージェントを選択', ignoreFocusOut: true },
  );
  return picked?.provider;
}

/**
 * 見出し行に使うパスの表示形式（issue #292）。ワークスペース直下からの相対パスにする。
 *
 * ワークスペース外のファイル（別フォルダを直接開いている等）は、ホームディレクトリ等の
 * 絶対パスをそのまま会話へ流し込まないよう、ファイル名だけを返す（会話はCLIプロセスへ
 * 送られ、記録にも残るため。design.md §14.57の判断）。
 */
function workspaceRelativeDisplayPath(uri: vscode.Uri): string {
  if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
    return path.basename(uri.fsPath);
  }
  return vscode.workspace.asRelativePath(uri, false);
}

/** ワークスペース直下の構成（ファイル・ディレクトリ名。隠しファイルは除く）。取得できなければ空配列。 */
async function listWorkspaceSummary(folder: vscode.WorkspaceFolder): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    return entries
      .filter(([name]) => !name.startsWith('.'))
      .slice(0, 50)
      .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name));
  } catch {
    return [];
  }
}

/** ワークスペース直下に指定した名前のファイルがあるか。 */
async function fileExists(folder: vscode.WorkspaceFolder, name: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * ロードマップ検証の警告（`RoadmapValidationResult.warnings`）をログ表示用の1行にまとめる
 * （Issue #427）。`errors`の組み立て方（メッセージを`separator`でつなげるだけ）に揃える。
 *
 * `RoadmapIssueEntry.message`は`roadmap.ts`側で組み立てる時点で既にid等を`sanitizeForLog`
 * 済み（#424）のため、ここでの再無害化は不要。
 */
export function formatRoadmapWarningsDetail(
  warnings: readonly RoadmapIssueEntry[],
  separator: string,
): string {
  return warnings.map((w) => w.message).join(separator);
}

/**
 * `correctedIssues`をログ表示用の1行にまとめる（Issue #427）。`itemId`はロードマップ
 * Markdown・LLM生成YAML由来で、双方向制御文字等を含みうるため`sanitizeForLog`を通す。
 *
 * 要素ごとに無害化してから連結する（`roadmap.ts`の配列連結箇所と同じ流儀）。文字列へ
 * まとめてから1回だけ`sanitizeForLog`を通すと、`SANITIZE_MAX_LEN`（200文字）で切り詰め
 * られたとき件数が多い場合に後続の要素が丸ごと失われるため、この順序は選ばない。
 */
export function formatCorrectedIssuesDetail(issues: readonly CorrectedIssue[]): string {
  return issues
    .map((c) => `${sanitizeForLog(c.itemId)}: ${c.actual ?? 'なし'} → ${c.expected ?? 'なし'}`)
    .join(', ');
}

/**
 * `droppedDependencies`をログ表示用の1行にまとめる（Issue #427）。
 * `formatCorrectedIssuesDetail`と同じ理由で要素ごとに`sanitizeForLog`を通す。
 */
export function formatDroppedDependenciesDetail(deps: readonly DroppedRoadmapDependency[]): string {
  return deps
    .map((d) => `${sanitizeForLog(d.itemId)} → ${sanitizeForLog(d.dependsOnId)}`)
    .join(', ');
}

/** `warnWithLogLink`が出す通知のボタンの文言（Issue #524）。 */
export const OPEN_LOG_ACTION = 'ログを開く';

/**
 * 「詳しくはログ」と書いてある警告通知を、ログを開くボタン付きで出す（Issue #524）。
 *
 * 文面はログを見ろと言っているのに、出力チャネルを開く導線はコマンドパレットの
 * `Codex: ログを表示`しかなく、通知からは辿れなかった。ボタンが押されたときだけ
 * `log.show()`を呼ぶ。
 *
 * 呼び出し側は返り値を待たない（`void`を付ける）。元の
 * `void vscode.window.showWarningMessage(...)`と同じく、通知の表示で後続の処理を
 * 止めない。Promiseを返しているのはテストからボタンの選択後まで進めるためで、
 * 呼び出し側で待つためではない。
 */
export async function warnWithLogLink(log: Logger, message: string): Promise<void> {
  const picked = await vscode.window.showWarningMessage(message, OPEN_LOG_ACTION);
  if (picked === OPEN_LOG_ACTION) {
    log.show();
  }
}

/**
 * ゴールの文からロードマップを生成する（design.md §16.19、#95・配線はIssue #105）。
 *
 * 生成セッションの起動は `roadmap.ts` の `createTaskSessionRoadmapGenerationPort` に委ねる。
 * `planWorkflowCommand`（分解セッション）と同じく、プロバイダは起動元のチャット画面から
 * 受け取り、特定できないときは `resolvePlannerProvider` が選ばせる（issue #266）。
 */
async function runRoadmap(
  issues: IssueListPort,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
  providerHint?: unknown,
): Promise<void> {
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('ロードマップを生成するにはフォルダを開いてください');
    return;
  }
  const goal = await vscode.window.showInputBox({
    prompt: 'ロードマップを生成するゴールを入力してください',
    ignoreFocusOut: true,
  });
  if (goal === undefined || goal.trim() === '') {
    return;
  }

  const provider = await resolvePlannerProvider(providerHint);
  if (provider === undefined) {
    return;
  }
  const workspaceRoot = folder.uri.fsPath;
  const host = provider === 'claude' ? claudeChat : chat;
  const generation = createTaskSessionRoadmapGenerationPort(host, provider, workspaceRoot);
  const [workspaceSummary, hasAgentsFile, hasClaudeFile] = await Promise.all([
    listWorkspaceSummary(folder),
    fileExists(folder, 'AGENTS.md'),
    fileExists(folder, 'CLAUDE.md'),
  ]);

  const roadmapDir = readWorkflowsConfig().roadmapDir;
  const fileName = await askOutputFileName(goal, roadmapDir, '.md');
  if (fileName === undefined) {
    log.info('ロードマップの生成を取り消しました');
    return;
  }

  const result = await generateRoadmap(
    { generation, issues, fs: nodeRoadmapFileSystem },
    {
      goal,
      workspaceRoot,
      roadmapDir,
      workspaceSummary,
      hasAgentsFile,
      hasClaudeFile,
      slug: fileName,
    },
  );

  if (!result.ok) {
    log.error(`ロードマップを生成できません: ${result.message}`);
    void vscode.window.showErrorMessage(`ロードマップを生成できません: ${result.message}`);
    return;
  }

  if (result.validation.errors.length > 0) {
    const detail = result.validation.errors.map((e) => e.message).join('\n');
    log.error(`生成されたロードマップに問題があります:\n${detail}`);
    void warnWithLogLink(
      log,
      '生成されたロードマップに問題があります。内容を確認してください（詳しくはログ）',
    );
  }

  if (result.validation.warnings.length > 0) {
    const detail = formatRoadmapWarningsDetail(result.validation.warnings, '\n');
    log.warn(`生成されたロードマップに警告があります:\n${detail}`);
    // Issue #427: この通知（showWarningMessage）を消すと、警告の握り潰しが再発する。
    // 呼び出し側のこの配線は自動テストでは検出できない（純粋関数側はユニットテストで担保）。
    void warnWithLogLink(
      log,
      `生成されたロードマップに警告が${result.validation.warnings.length}件あります。内容を確認してください（詳しくはログ）`,
    );
  }

  const doc = await vscode.workspace.openTextDocument(result.path);
  await vscode.window.showTextDocument(doc);
}

/**
 * ワークフロー定義（YAML）を生成する（design.md §16.9・§16.19、`agent.workflows.plan`）。
 *
 * 入力の経路を2つ持つ（design.md §16.19 2段目「ゴール文に加えて、ロードマップのファイルを
 * 取れるようにする」）。ゴール文からの直接生成はこれまでどおり、ロードマップからの生成は
 * `planWorkflowFromRoadmapCommand` に委ねる。
 */
async function planWorkflowCommand(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  view: WorkflowViewManager,
  log: Logger,
  providerHint?: unknown,
): Promise<void> {
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage('ワークフローを生成するにはフォルダを開いてください');
    return;
  }

  const source = await vscode.window.showQuickPick(
    [
      { label: 'ゴール文から生成', sourceKind: 'goal' as const },
      {
        label: 'ロードマップから生成',
        description: '既存のロードマップの1フェーズをタスクへ変換する（design.md §16.19）',
        sourceKind: 'roadmap' as const,
      },
    ],
    { placeHolder: 'ワークフローの生成方法を選択', ignoreFocusOut: true },
  );
  if (source === undefined) {
    return;
  }
  const provider = await resolvePlannerProvider(providerHint);
  if (provider === undefined) {
    return;
  }
  if (source.sourceKind === 'roadmap') {
    await planWorkflowFromRoadmapCommand(chat, claudeChat, view, log, folder, provider);
    return;
  }
  await planWorkflowFromGoalCommand(chat, claudeChat, view, log, folder, provider);
}

/**
 * ゴール文からワークフロー定義（YAML）を生成する（design.md §16.9）。
 *
 * `planWorkflow`（`planner.ts`）はYAML文字列を作るだけで、実行は一切行わない。
 * ここではその結果を保存し、エディタとワークフローViewを開くところまでを担う。
 * `WorkflowRunner.start` は呼ばない — 生成したワークフローを走らせるのは、人が
 * ワークフローViewから明示的に「実行」を選んだとき（design.md §16.13）。
 */
async function planWorkflowFromGoalCommand(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  view: WorkflowViewManager,
  log: Logger,
  folder: vscode.WorkspaceFolder,
  provider: Provider,
): Promise<void> {
  const goal = await vscode.window.showInputBox({
    title: 'ワークフローのゴール',
    prompt:
      '達成したいことを文章で入力してください（例: 認証機能を追加してテストとレビューまで終える）',
    ignoreFocusOut: true,
    // `workflow.ts`のprompt/done等と同じ上限を流用する（design.md §16.9セキュリティ監査
    // low「ゴール入力に長さ上限が無い」）。ここで拒否しておけば、プロンプトへ埋め込んだ
    // 結果生成されるYAMLがMAX_PROMPT_LENGTHで弾かれる事態を入力時点で避けられる
    validateInput: (value) =>
      value.length > MAX_PROMPT_LENGTH
        ? `ゴールが長すぎます（上限${MAX_PROMPT_LENGTH}文字）: ${value.length}文字`
        : undefined,
  });
  if (goal === undefined || goal.trim() === '') {
    return;
  }

  const host = provider === 'claude' ? claudeChat : chat;
  const workspaceRoot = folder.uri.fsPath;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ワークフローを生成しています…' },
    async () => {
      const workspaceSummary = await buildWorkspaceSummary(workspaceRoot, nodePlannerWorkspacePort);
      return planWorkflow({
        goal,
        workspaceSummary,
        provider,
        host,
        cwd: workspaceRoot,
        baseline: readSafetyBaseline(),
        log,
      });
    },
  );

  if (result.ok) {
    await handlePlanSuccess(result, goal, workspaceRoot, view, log, provider, host);
    return;
  }
  await handlePlanFailure(result, log);
}

/**
 * ロードマップの1フェーズから、ワークフロー定義（YAML）を生成する（design.md §16.19
 * 2段目、`agent.workflows.plan`のロードマップ入力経路）。
 *
 * 材料の組み立てと分解セッションの起動は`roadmap.ts`の`planWorkflowFromRoadmapPhase`に
 * 委ねる。ここではロードマップファイルの選択・フェーズの選択（design.md §16.19「1回の
 * ワークフローで扱うのはロードマップの一部でよい」「次のフェーズだけYAMLにするを選べる
 * ようにする」）・結果の保存とView表示（`handlePlanSuccess`/`handlePlanFailure`をゴール文
 * 経路と共通で使う）を担う。
 */
async function planWorkflowFromRoadmapCommand(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  view: WorkflowViewManager,
  log: Logger,
  folder: vscode.WorkspaceFolder,
  provider: Provider,
): Promise<void> {
  const roadmapDir = readWorkflowsConfig().roadmapDir;
  const pattern = new vscode.RelativePattern(folder, `${roadmapDir}/**/*.md`);
  const files = await vscode.workspace.findFiles(pattern, undefined, 200);
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      `ロードマップが見つかりません（${roadmapDir} 配下に .md を置いてください。先に「ロードマップの生成」を実行してください）`,
    );
    return;
  }
  const pickedFile = await vscode.window.showQuickPick(
    files.map((f) => ({ label: vscode.workspace.asRelativePath(f), file: f })),
    { placeHolder: '元にするロードマップを選択', ignoreFocusOut: true },
  );
  if (pickedFile === undefined) {
    return;
  }

  const doc = await vscode.workspace.openTextDocument(pickedFile.file);
  const parsed = parseRoadmapMarkdown(doc.getText());
  if (parsed.phases.length === 0) {
    void vscode.window.showErrorMessage('選択したロードマップにフェーズ・項目がありません');
    return;
  }
  const validation = validateRoadmap(parsed);
  if (validation.errors.length > 0) {
    log.error(
      `[planner] 選択したロードマップに問題があります: ${validation.errors
        .map((e) => e.message)
        .join(' / ')}`,
    );
    void warnWithLogLink(
      log,
      '選択したロードマップに問題があります。内容を確認してください（詳しくはログ）',
    );
  }

  if (validation.warnings.length > 0) {
    log.warn(
      `[planner] 選択したロードマップに警告があります: ${formatRoadmapWarningsDetail(
        validation.warnings,
        ' / ',
      )}`,
    );
    // Issue #427: この通知（showWarningMessage）を消すと、警告の握り潰しが再発する。
    // 呼び出し側のこの配線は自動テストでは検出できない（純粋関数側はユニットテストで担保）。
    void warnWithLogLink(
      log,
      `選択したロードマップに警告が${validation.warnings.length}件あります。内容を確認してください（詳しくはログ）`,
    );
  }

  const pickedPhases = await pickRoadmapPhases(parsed);
  if (pickedPhases === undefined) {
    return;
  }

  // 選んだフェーズをまとめて1本のYAMLにする。合計がタスク数の上限を超える選択では
  // フェーズ単位で複数のYAMLへ分ける（design.md §16.19 2段目）
  const chunks = splitRoadmapPhasesIntoChunks(pickedPhases);
  if (chunks.length > 1) {
    void vscode.window.showInformationMessage(
      `選んだフェーズの項目数がタスク数の上限（${MAX_TASK_COUNT}件）を超えるため、` +
        `${chunks.length}個のワークフローへ分けて生成します。` +
        '分けた分は別々のrunになるため、前のrunが終わってから次を実行してください。',
    );
  }

  const host = provider === 'claude' ? claudeChat : chat;
  const workspaceRoot = folder.uri.fsPath;
  const roadmapPath = vscode.workspace.asRelativePath(pickedFile.file, false);
  let failed = 0;

  for (const [index, chunk] of chunks.entries()) {
    const progressTitle =
      chunks.length > 1
        ? `ワークフローを生成しています…（${index + 1}/${chunks.length}）`
        : 'ワークフローを生成しています…';
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: progressTitle },
      async () => {
        const workspaceSummary = await buildWorkspaceSummary(
          workspaceRoot,
          nodePlannerWorkspacePort,
        );
        return planWorkflowFromRoadmapPhases({
          roadmapTitle: parsed.title,
          chunk,
          workspaceSummary,
          provider,
          host,
          cwd: workspaceRoot,
          baseline: readSafetyBaseline(),
          log,
        });
      },
    );

    if (!result.ok) {
      failed += 1;
      await handlePlanFailure(result, log);
      continue;
    }

    // 生成した定義に「どのロードマップから作ったか」を残す（design.md §16.19）。runが
    // 終わったとき、この値を頼りにチェックを書き戻す。
    const withRoadmap = withRoadmapReference(result.yaml, result.definition, roadmapPath);
    const resultWithRoadmap = {
      ...result,
      yaml: withRoadmap.yaml,
      definition: withRoadmap.definition,
    };

    if (result.correctedIssues.length > 0) {
      const detail = formatCorrectedIssuesDetail(result.correctedIssues);
      log.warn(`[planner] issueをロードマップの値へ直しました: ${detail}`);
      void vscode.window.showWarningMessage(
        `生成されたワークフローのissueがロードマップと違っていたため、${result.correctedIssues.length}件を` +
          'ロードマップの値へ直しました（誤った番号のままだとPR/MRのマージで無関係のIssueが閉じるため）',
      );
    }

    if (result.roadmapMismatches.length > 0) {
      log.warn(
        `[planner] ロードマップの材料が正しく転記されていない可能性があります: ${result.roadmapMismatches
          .map((m) => m.message)
          .join(' / ')}`,
      );
      void warnWithLogLink(
        log,
        '生成されたワークフローが、ロードマップの内容（id・依存・Issue）と一致しない箇所があります' +
          `（${result.roadmapMismatches.length}件）。内容を確認してください（詳しくはログ）`,
      );
    }

    if (result.droppedDependencies.length > 0) {
      const detail = formatDroppedDependenciesDetail(result.droppedDependencies);
      log.warn(`[planner] 分割によりYAMLをまたぐ依存を落としました: ${detail}`);
      void warnWithLogLink(
        log,
        `分割したため、このワークフローでは表現できない依存を${result.droppedDependencies.length}件` +
          '落としました。落とした依存の順序は、runを実行する順で守ってください（詳しくはログ）',
      );
    }

    if (chunk.overCapacity) {
      log.warn(
        `[planner] 1フェーズだけでタスク数の上限を超えています（${chunk.phaseNames.join(', ')}: ${chunk.items.length}件）`,
      );
      void vscode.window.showWarningMessage(
        `「${chunk.phaseNames.join('」「')}」は1フェーズだけでタスク数の上限（${MAX_TASK_COUNT}件）を超えています。` +
          'ロードマップ側でフェーズを分けてください',
      );
    }

    await handlePlanSuccess(
      resultWithRoadmap,
      buildRoadmapPlanGoal(parsed.title, chunk.phaseNames),
      workspaceRoot,
      view,
      log,
      provider,
      host,
    );
  }

  if (failed > 0) {
    void vscode.window.showErrorMessage(
      `${chunks.length}個のうち${failed}個のワークフローを生成できませんでした（開いたエディタの内容を確認してください）`,
    );
  }
}

/**
 * YAML化するフェーズを選ばせる（design.md §16.19 2段目）。
 *
 * 複数選択できる。フェーズをまたいで1本のYAMLにできるため、「全フェーズ」を先頭に置いて
 * ワンクリックで全体を選べるようにする（1つも選ばずに閉じた場合と、キャンセルした場合は
 * どちらも `undefined`）。返す順はロードマップ上の並び順に揃える（選んだ順ではない）。
 */
async function pickRoadmapPhases(parsed: ParsedRoadmap): Promise<RoadmapPhase[] | undefined> {
  const nextPhase = selectNextRoadmapPhase(parsed);
  const allPick = {
    label: `$(check-all) 全フェーズ（${parsed.phases.length}件）`,
    phase: undefined,
    description: 'ロードマップ全体を対象にします',
  };
  const phasePicks: { label: string; phase: RoadmapPhase | undefined; description?: string }[] = [
    allPick,
    ...parsed.phases.map((phase) => ({
      label: phase.name === '' ? '(無題のフェーズ)' : phase.name,
      phase,
      // `exactOptionalPropertyTypes`下では`description: undefined`を明示できないため、
      // 次のフェーズでなければキー自体を持たせない
      ...(phase === nextPhase ? { description: '次に着手すべきフェーズ' } : {}),
    })),
  ];

  const picked = await vscode.window.showQuickPick(phasePicks, {
    placeHolder: '変換するフェーズを選択（複数選べます。まとめて1本のYAMLにします）',
    ignoreFocusOut: true,
    canPickMany: true,
  });
  if (picked === undefined || picked.length === 0) {
    return undefined;
  }
  if (picked.some((item) => item.phase === undefined)) {
    return [...parsed.phases];
  }
  const selected = new Set(picked.map((item) => item.phase));
  return parsed.phases.filter((phase) => selected.has(phase));
}

/**
 * 生成物の保存先ファイル名（拡張子なし）を利用者に確認してもらう。
 *
 * 既定値は `slugifyGoal` がゴール文から機械的に作るが、ゴールにファイルパスや指示の
 * 言い回しが混ざっているとそのまま読みにくい名前になる。保存の直前に一度見せて直せる
 * ようにする（Enterでそのまま採用できるので、既定で良ければ操作は増えない）。
 *
 * 取り消し（Escape）は `undefined` を返す。呼び出し側は保存を中止する。
 */
async function askOutputFileName(
  goal: string,
  relativeDir: string,
  extension: string,
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: `保存先のファイル名（${relativeDir}/<名前>${extension}）`,
    value: slugifyGoal(goal),
    ignoreFocusOut: true,
    validateInput: (input) => validateSlugInput(input),
  });
  return value === undefined ? undefined : value.trim();
}

/**
 * 一覧取得と書き込みの間に別の生成が割り込んでも上書きしないよう、排他フラグ（`wx`）で
 * 書き込む（design.md §16.9セキュリティ監査 low）。`EEXIST`（他プロセス・他コマンド
 * 呼び出しが同名で先に作っていた）なら、その名前を候補集合へ足して連番を1つ進め、
 * 空いている名前が見つかるまで再試行する。
 */
async function writeUniqueWorkflowFile(
  dirAbs: string,
  slug: string,
  existingBaseNames: Set<string>,
  yaml: string,
): Promise<string> {
  for (;;) {
    const baseName = resolveUniqueFileName(slug, existingBaseNames);
    const filePath = path.join(dirAbs, `${baseName}.yaml`);
    try {
      await fsPromises.writeFile(filePath, yaml, { encoding: 'utf8', flag: 'wx' });
      return filePath;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw e;
      }
      existingBaseNames.add(baseName);
    }
  }
}

/**
 * 生成が検証を通ったときの後処理。`agent.workflows.dir`へ保存し、エディタとワークフロー
 * Viewを開く（design.md §16.9手順4）。セキュリティ警告があれば、該当行へ移動したうえで
 * 強調して知らせる（design.md §16.9「多数のタスクに紛れた1件のallowを人が見落とすのを
 * 防ぐ」）。
 *
 * 保存の後、別の読み取り専用セッションでタスク分解の妥当性をレビューする
 * （design.md §16.28、roadmap W3）。ゴール文からの生成（`planWorkflowFromGoalCommand`）と
 * ロードマップからの生成（`planWorkflowFromRoadmapCommand`）の両方がこの関数を通るため、
 * ここに置くことでどちらの起点で生成しても同じくレビューがかかる（片方だけ塞ぐ実装に
 * しない）。
 *
 * **エディタとワークフローViewの表示は、レビューの完了を待たない。** レビューは
 * `PLANNER_TURN_TIMEOUT_MS`（既定5分）までかかりうるため、表示までそれだけ人を待たせる
 * と「保存は妨げない」という受入基準の実質を損なう。表示はまず`securityWarnings`だけで
 * 出し、レビューはバックグラウンドで走らせて、指摘が見つかった時点で`previewDefinition`
 * をもう一度呼んで警告欄へ追加し、`showWarningMessage`も別途出す（design.md §16.28）。
 * このもう一度の呼び出しは無条件——ユーザーが既に別のrunの表示へ切り替えていた場合、
 * その表示がレビュー結果の到着で差し替わりうる（フォーカスは奪わない。W3の受入基準の
 * 対象外として許容している）。
 *
 * レビューを追いかける処理はバックグラウンドの`void`な即時実行関数（IIFE）の中にあり、
 * この関数自体は先に`resolve`済みのため、IIFE内で投げた例外を受け取る呼び出し元が無い。
 * `reviewWorkflowPlan`自体は例外を投げない設計だが、IIFE内の他の呼び出し
 * （`withProgress`・`previewDefinition`・`showWarningMessage`）は投げうるため、
 * **IIFE全体を`try/catch`で囲み、失敗しても`log.warn`に留めて表示済みの内容へは
 * 波及させない。**
 */
async function handlePlanSuccess(
  result: Extract<PlanWorkflowResult, { ok: true }>,
  goal: string,
  workspaceRoot: string,
  view: WorkflowViewManager,
  log: Logger,
  provider: Provider,
  host: TaskSessionHost,
): Promise<void> {
  const dirConfig = readWorkflowsConfig().dir;
  const dirAbs = path.join(workspaceRoot, dirConfig);
  await fsPromises.mkdir(dirAbs, { recursive: true });

  const pattern = new vscode.RelativePattern(dirAbs, '*.{yaml,yml}');
  const existingFiles = await vscode.workspace.findFiles(pattern, undefined, 500);
  const existingBaseNames = new Set(
    existingFiles.map((f) => path.basename(f.fsPath).replace(/\.ya?ml$/i, '')),
  );
  const fileName = await askOutputFileName(goal, dirConfig, '.yaml');
  if (fileName === undefined) {
    log.info('ワークフロー定義の保存を取り消しました');
    return;
  }
  const filePath = await writeUniqueWorkflowFile(dirAbs, fileName, existingBaseNames, result.yaml);

  // 生成直後の表示はレビューの完了を待たない（design.md §16.28「表示は保存直後に出す。
  // レビューは後追いで警告欄へ足す」）。エディタより先にViewを開く。エディタの
  // `showTextDocument`が最後に呼ばれるほうへフォーカスが残るようにするため（Viewの
  // パネル作成自体はフォーカスを奪う作りのため）
  view.previewDefinition(
    filePath,
    result.definition,
    result.securityWarnings.map((w) => ({
      kind: 'plannerSecurity' as const,
      taskId: w.taskId,
      message: w.message,
    })),
  );

  const doc = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  if (result.droppedTemplateRefs.length > 0) {
    const detail = result.droppedTemplateRefs.map((r) => `${r.taskId}: ${r.ref}`).join(', ');
    log.warn(`[planner] dependsOnに無いタスクを参照するテンプレート変数を落としました: ${detail}`);
    void warnWithLogLink(
      log,
      `dependsOnに挙げていないタスクを参照していたテンプレート変数を${result.droppedTemplateRefs.length}件` +
        '落としました（そのままでは検証を通らないため）。参照が消えて文意が通らないタスクがないか確認してください（詳しくはログ）',
    );
  }

  if (result.securityWarnings.length > 0) {
    const first = result.securityWarnings[0];
    if (first !== undefined) {
      const line = locateSecurityWarningLine(result.yaml, first.taskId, first.kind);
      if (line !== undefined) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
    log.warn(
      `[planner] 生成されたワークフローは既定の安全設定を上書きしています: ${result.securityWarnings
        .map((w) => w.message)
        .join(' / ')}`,
    );
    void vscode.window.showWarningMessage(
      `生成されたワークフローは既定の安全設定を上書きする指定を含んでいます（${result.securityWarnings.length}件）。` +
        '内容を確認してから実行してください。',
    );
  } else {
    void vscode.window.showInformationMessage(
      `ワークフローを生成しました: ${path.relative(workspaceRoot, filePath)}` +
        (result.attempts > 1 ? '（検証エラーを踏まえて再生成しました）' : ''),
    );
  }

  // タスク分解のレビュー（design.md §16.28）は表示の後を追いかけて走らせる。保存済み
  // ファイル・既に開いたエディタ・上のトーストは待たない（await しない）。指摘があれば、
  // 開いたままのプレビューへ後から追加する（`previewDefinition`は毎回スナップショットを
  // 作り直すため、この2回目の呼び出しは1回目を上書きする。ただしユーザーが既に別のrunの
  // 表示へ切り替えていた場合はその表示が差し替わりうる——design.md §16.28「限界」参照）。
  //
  // `reviewWorkflowPlan`自体は例外を投げない設計だが、この関数の外側は既に`resolve`済み
  // （`handlePlanSuccess`の呼び出し元は待っていない）なので、IIFE内の他の呼び出し
  // （`withProgress`・`previewDefinition`・`showWarningMessage`）が投げた場合に受け取る
  // 呼び出し元がどこにも無く、未処理rejectになる。そのためIIFE全体を`try/catch`で囲み、
  // catchでは`log.warn`に留める（レビューは警告を足すだけの機能なので、この経路の失敗で
  // 保存済みの状態や既に開いた表示へ波及させてはならない）。
  void (async () => {
    try {
      const review = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ワークフローをレビューしています…',
        },
        () =>
          reviewWorkflowPlan({
            goal,
            yaml: result.yaml,
            provider,
            host,
            cwd: workspaceRoot,
            log,
          }),
      );

      if (review.findings.length === 0) {
        return;
      }

      view.previewDefinition(filePath, result.definition, [
        ...result.securityWarnings.map((w) => ({
          kind: 'plannerSecurity' as const,
          taskId: w.taskId,
          message: w.message,
        })),
        ...review.findings.map((f) => ({
          kind: 'plannerReview' as const,
          taskId: f.taskIds[0],
          message: f.taskIds.length > 0 ? `[${f.taskIds.join(', ')}] ${f.message}` : f.message,
        })),
      ]);

      log.warn(
        `[planner] タスク分解のレビューで指摘があります: ${review.findings
          .map((f) => sanitizeForLog(f.message))
          .join(' / ')}`,
      );
      void warnWithLogLink(
        log,
        `タスク分解のレビューで指摘があります（${review.findings.length}件）。` +
          '内容を確認してください（自動では直していません。詳しくはログ）',
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn(
        `[planner] タスク分解のレビュー表示中にエラーが発生しました: ${sanitizeForLog(message)}`,
      );
    }
  })();
}

/**
 * 2回とも検証を通らなかったときの後処理（design.md §16.9「生の返答をエディタで開いて
 * 人に委ねる」）。ワークフロー定義として保存はしない（無効なYAMLをそのまま
 * `agent.workflows.dir`へ置くと、他の一覧処理を壊しうるため）。
 */
async function handlePlanFailure(
  result: Extract<PlanWorkflowResult, { ok: false }>,
  log: Logger,
): Promise<void> {
  log.error(
    `[planner] 2回の生成でもワークフロー定義の検証を通せませんでした: ${result.lastErrors
      .map((e) => e.message)
      .join(' / ')}`,
  );
  const doc = await vscode.workspace.openTextDocument({
    content: result.rawResponse,
    language: 'yaml',
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showErrorMessage(
    'ワークフロー定義の生成に失敗しました（検証エラーを踏まえた再生成でも通りませんでした）。' +
      '開いたエディタの内容を確認し、必要なら手で直してから保存してください。',
  );
}

/**
 * 指定した指示までを引き継いだ新しいセッションを作って開く。
 *
 * CLIの `codex fork` はターンを指定できないため、この操作だけ app-server の
 * `thread/fork` を使う。元のセッションは変更されない。
 */
async function forkFromTurn(
  codex: AgentProvider,
  appServer: AppServerClient,
  chat: ChatViewManager,
  tree: SessionTreeProvider,
  log: Logger,
  session: SessionSummary,
  turnId: string,
): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'この指示から分岐しています…' },
    () => appServer.forkThread(session.id, turnId),
  );

  if (!result.ok) {
    log.error(`分岐に失敗しました: ${result.error}`);
    void vscode.window.showErrorMessage(`分岐に失敗しました: ${result.error}`);
    return;
  }

  log.info(`分岐しました: ${session.id} → ${result.threadId}`);
  await chat.openThread(result.threadId, `${codex.tabTitle(session)} (分岐)`, session.cwd);
  tree.refresh();
}

/**
 * セッション全体を分岐する。`codex.forkSession` / `claude.forkSession` の共通処理
 * （`openSession` と同じ、プロバイダで分岐して各画面へ委譲する形。issue #218）。
 *
 * Codexはapp-server経由で新しいスレッドを作れる（ターンを指定しない分岐は、会話の
 * 末尾から分岐するのと同じ）。Claude Codeは`-r <id> --fork-session`で分岐するが、
 * 新しいidをCLIが振るため拡張機能側からは指定できず、分岐先の紐付けは確定しないまま開く
 * （`ClaudeChatViewManager.openFork`のJSDoc、design.md §14.40参照）。
 */
async function forkSession(
  providers: ProviderRegistry,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
  session: SessionSummary,
): Promise<void> {
  const provider = providers.get(session.provider);
  if (provider === undefined || !provider.capabilities.fork) {
    void vscode.window.showInformationMessage('このセッションは分岐に対応していません');
    return;
  }
  log.info(`セッションを分岐します: ${session.id}`);
  if (session.provider === 'claude') {
    await claudeChat.openFork(session.id, `${provider.tabTitle(session)} (fork)`, session.cwd);
    return;
  }
  // ターンを指定しない分岐は、会話の末尾から分岐するのと同じ
  await chat.openThread(session.id, `${provider.tabTitle(session)} (fork)`, session.cwd);
}

const ACTION_LABELS: Record<SessionAction, string> = {
  archive: 'アーカイブ',
  unarchive: 'アーカイブ解除',
  delete: '削除',
};

async function runAction(
  actions: SessionActions,
  tree: SessionTreeProvider,
  log: Logger,
  action: SessionAction,
  session: SessionSummary,
): Promise<void> {
  const label = ACTION_LABELS[action];
  const name = session.threadName ?? session.id;

  // 取り消せるarchiveと違い、deleteは元に戻せないため必ず確認する
  if (action === 'delete') {
    const choice = await vscode.window.showWarningMessage(
      `セッション「${name}」を完全に削除します。元に戻せません。`,
      { modal: true },
      '削除する',
    );
    if (choice !== '削除する') {
      return;
    }
  }

  const result = await actions.run(action, session.id);
  if (result.code === 0) {
    log.info(`${label}しました: ${name}`);
  } else {
    log.error(`${label}に失敗しました (exit ${result.code}): ${result.stderr.trim()}`);
    void vscode.window.showErrorMessage(`${label}に失敗しました: ${result.stderr.trim()}`);
  }
  tree.refresh();
}

function debounce(fn: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(fn, delayMs);
  };
}

export function deactivate(): void {
  // subscriptions で破棄されるため個別の後始末は不要。
}

/**
 * CLIの実行ファイルを解決するクロージャを作る（issue #305）。
 *
 * 明示指定（`codex.executablePath` / `claude.executablePath`）が壊れていても、
 * 黙って別のバイナリ（PATH上の裸のコマンド名）へすり替えない。解決結果は
 * `resolveSpawnPath`が決め、失敗時は「実際に試したパスや名前」をそのまま返すため、
 * 明示指定の失敗はspawn自体の失敗（ENOENT等）として利用者に伝わる。指定が無い場合は
 * 従来通りその名前をspawnのPATH解決に委ねる。
 *
 * 通知（`showErrorMessage`）は`ResolutionNotificationTracker`により同じ失敗の間は
 * 一度だけに絞る。ログ（`log.error`）は毎回出す（診断用途で、通知ほど煩わしくないため）。
 */
function createExecutablePathResolver(provider: AgentProvider, log: Logger): () => string {
  const tracker = new ResolutionNotificationTracker();

  return (): string => {
    const located = provider.locate();
    const spawnPath = resolveSpawnPath(located);
    if (located.ok) {
      tracker.shouldNotify(located);
      return spawnPath;
    }

    const message = formatResolutionFailureMessage(provider, located);
    log.error(message);

    if (tracker.shouldNotify(located)) {
      void vscode.window
        .showErrorMessage(message, 'インストール手順', '設定を開く')
        .then((choice) => {
          if (choice === 'インストール手順') {
            void vscode.env.openExternal(vscode.Uri.parse(provider.installUrl));
          } else if (choice === '設定を開く') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              provider.executableSettingKey,
            );
          }
        });
    }
    return spawnPath;
  };
}

/**
 * セッションツリーの要素を引数に取るコマンドを包む共通ガード（issue #236）。
 *
 * `view/item/context`（インラインアイコン・右クリックメニュー）から呼ばれるコマンドは、
 * VS Codeがツリーの要素を復元できないと引数が `undefined` のまま届く。素通しすると
 * `Cannot read properties of undefined` で落ちるため、ここで受け止めてログだけ残す。
 * 復元が壊れる原因自体は `SessionTreeProvider.getTreeItem` の `id` で塞いであり、
 * これはメニュー定義を増やしたときの再発に備えた防御。
 */
function withSession(
  log: Logger,
  command: string,
  run: (session: SessionSummary) => void,
): (session?: SessionSummary) => void {
  return (session) => {
    if (session === undefined) {
      log.warn(`${command}: 対象のセッションを受け取れませんでした`);
      return;
    }
    run(session);
  };
}

/**
 * 履歴からセッションを開く。既に開いているタブがあれば新規に開かず、そのタブへ移る
 * （ファイルタブと同じ挙動）。
 */
/** 履歴から開く。プロバイダに応じたチャット画面へ渡す。 */
function openSession(
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
  session: SessionSummary,
): void {
  if (session.provider === 'claude') {
    void claudeChat.openThread(session.id, session.threadName ?? 'Claude Code', session.cwd);
    return;
  }
  if (session.provider === 'codex') {
    void chat.openThread(session.id, session.threadName ?? 'Codex', session.cwd);
    return;
  }
  log.error(`未知のCLIのセッションです: ${session.provider}`);
}

async function listSessions(
  providers: ProviderRegistry,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<SessionSummary[]> {
  const config = readConfig();
  return providers.listSessions(
    {
      scope: tree.scope,
      workspaceFolders: workspaceFolderPaths(),
      maxEntries: config.historyMaxEntries,
    },
    log,
  );
}

interface SessionPick extends vscode.QuickPickItem {
  session: SessionSummary;
}

async function pickAndResume(
  providers: ProviderRegistry,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<void> {
  const sessions = await listSessions(providers, tree, log);
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('再開できるセッションがありません');
    return;
  }

  const now = Date.now();
  const items: SessionPick[] = sessions.map((s) => ({
    label: s.threadName ?? '(名称未設定)',
    description: `${providers.get(s.provider)?.label ?? s.provider}  ${formatRelativeTime(s.updatedAt, now)}`,
    ...(s.cwd === undefined ? {} : { detail: s.cwd }),
    session: s,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '再開するセッションを選択',
  });

  if (picked !== undefined) {
    openSession(chat, claudeChat, log, picked.session);
  }
}

async function resumeLast(
  providers: ProviderRegistry,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<void> {
  const sessions = await listSessions(providers, tree, log);
  const latest = sessions[0];
  if (latest === undefined) {
    void vscode.window.showInformationMessage('再開できるセッションがありません');
    return;
  }
  openSession(chat, claudeChat, log, latest);
}

async function persistCache(
  context: vscode.ExtensionContext,
  cache: InMemoryMetaCache,
): Promise<void> {
  await context.globalState.update(META_CACHE_KEY, cache.toRecord());
}
