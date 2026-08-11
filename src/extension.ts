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
import { ClaudeSessionStore } from './claude/sessionStore';
import { ClaudeSkillsProbe } from './claude/skillsProbe';
import { ClaudeTranscriptWatcher } from './claude/transcriptWatcher';
import { CodexAccountActions } from './codex/accountActions';
import { AppServerClient } from './codex/appServerClient';
import { codexPaths, nodeLocatorDeps, resolveCodexHome } from './codex/cliLocator';
import { CodexProvider } from './codex/provider';
import type { SessionMeta, SessionSummary } from './codex/types';
import type { UsageSnapshot } from './codex/usage';
import {
  currentWorkspaceFolder,
  readActivityLogConfig,
  readClaudeConfig,
  readConfig,
  readWorkflowsConfig,
  workspaceFolderPaths,
} from './config';
import {
  nodeGitCommandRunner,
  nodeWorktreeFileSystem,
  WorktreeCreationQueue,
} from './orchestrator/worktree';
import {
  nodeCliAvailability,
  nodeCliCommandRunner,
  nodeForgeFileSystem,
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
  planWorkflowFromRoadmapPhase,
  selectNextRoadmapPhase,
  validateRoadmap,
  type IssueListPort,
} from './orchestrator/roadmap';
import { WorkflowRunStore } from './orchestrator/runStore';
import { WorkflowRunner, nodeWorkflowFilePort } from './orchestrator/runner';
import type { ExtensionSafetyBaseline } from './orchestrator/taskConfig';
import {
  buildWorkspaceSummary,
  nodePlannerWorkspacePort,
  planWorkflow,
  resolveUniqueFileName,
  slugifyGoal,
  locateSecurityWarningLine,
  type PlanWorkflowResult,
} from './orchestrator/planner';
import { DEFAULT_PROVIDER, MAX_PROMPT_LENGTH } from './orchestrator/workflow';
import { ProviderRegistry } from './provider/registry';
import type { AgentProvider } from './provider/types';
import { createLogger, type Logger } from './log';
import { nodeCommandRunner as nodeAccountCommandRunner } from './process/commandRunner';
import { nodeFileSystem } from './session/nodeFileSystem';
import { nodeFileScan } from './session/nodeFileScan';
import { FileMentionCatalog } from './provider/fileMentions';
import { InMemoryMetaCache } from './session/ports';
import { SessionStore } from './session/sessionStore';
import { SessionActions, nodeCommandRunner, type SessionAction } from './session/sessionActions';
import { SessionWatcher } from './session/sessionWatcher';
import { UsageReader } from './session/usageReader';
import { ChatViewManager } from './view/chatView';
import { ClaudeChatViewManager } from './view/claudeChatView';
import { ControlPanelViewProvider } from './view/controlPanelView';
import { ConversationViewManager } from './view/conversationView';
import { formatRelativeTime } from './view/relativeTime';
import { SessionTreeProvider } from './view/sessionTreeProvider';
import { SettingsProvider } from './view/settingsProvider';
import { UsageStatusBar } from './view/usageStatusBar';
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

  const claudeHome = resolveClaudeHome(readClaudeConfig().configDir, nodeLocatorDeps);
  const claudeDirs = claudePaths(claudeHome);
  log.info(`CLAUDE_CONFIG_DIR=${claudeHome}`);
  const claudeStore = new ClaudeSessionStore(nodeFileSystem, claudeDirs);

  const codex = new CodexProvider(store);
  const claude = new ClaudeProvider(claudeStore);
  const providers = new ProviderRegistry([codex, claude]);
  /** Codex固有の機能（app-server・設定パネル・破壊操作）が使う実行ファイル。 */
  const codexPath = (): string => resolveExecutable(codex, log) ?? 'codex';

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
  const claudePath = (): string => resolveExecutable(claude, log) ?? 'claude';

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

  const chat = new ChatViewManager(
    codexPath,
    settings,
    home,
    nodeFileSystem,
    mentions,
    log,
    (activity) => recordActivity({ ...activity, source: 'codex' }),
    isTaskManagedThread,
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
  );
  context.subscriptions.push(claudeChat);

  const workflowStore = new WorkflowRunStore(context.workspaceState);
  const workflowRunner = new WorkflowRunner({
    hosts: { codex: chat, claude: claudeChat },
    worktreeQueue: new WorktreeCreationQueue(),
    git: nodeGitCommandRunner,
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
      cli: nodeCliCommandRunner,
      cliAvailability: nodeCliAvailability,
      fs: nodeForgeFileSystem,
      readConfig: () => {
        const c = readWorkflowsConfig();
        return { host: c.forge, pullRequest: c.pullRequest, finalMerge: c.finalMerge };
      },
    },
    // 疑似worktree（design.md §16.20、Issue #105）。gitの作業ツリーでないワークスペースで
    // `isolation: worktree`のタスクを走らせるときの隔離手段。`decideWorkingDirectory`の
    // `sharedFallback`から`resolveWorkingDirectory`が呼ぶ
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
  });
  // isTaskManagedThreadのクロージャが参照する箱を埋める。以降の`workflowRunner`
  // （コマンド登録などで使う）はこの束縛を指し、常にWorkflowRunnerとして扱える
  workflowRunnerRef.current = workflowRunner;

  // ワークフローView（#57）。`restoreRunsForView`がworkspaceStateのreconcileと
  // メモリ上への復元（design.md §16.11「リロード後の実行再開」）を両方行う
  const workflowView = new WorkflowViewManager(workflowRunner, log);
  context.subscriptions.push(workflowView);
  void workflowRunner.restoreRunsForView().then(() => {
    const interrupted = workflowStore
      .list()
      .filter((r) => Object.values(r.tasks).some((t) => t.failure?.kind === 'reloadInterrupted'));
    if (interrupted.length > 0) {
      log.info(
        `リロードにより中断扱いにしたワークフロー実行: ${interrupted.map((r) => r.runId).join(', ')}`,
      );
    }
  });

  // ロードマップ（design.md §16.19、#95・配線はIssue #105）。既存Issueの取得は
  // `git remote` + `gh`/`glab` をポート越しに呼ぶだけなので、ここで実装を組み立てて渡す。
  const roadmapIssuePort = createCliIssueListPort(nodeGitCommandRunner, nodeCliCommandRunner);

  const conversations = new ConversationViewManager(nodeFileSystem, store, log, (session, turnId) =>
    forkFromTurn(codex, appServer, chat, tree, log, session, turnId),
  );
  context.subscriptions.push(conversations);

  const actions = new SessionActions(nodeCommandRunner, codexPath);

  // 開いているかどうかはチャット画面が持つ
  const tree = new SessionTreeProvider(providers, (id) => chat.isOpen(id), log);
  context.subscriptions.push(
    tree,
    vscode.window.createTreeView('codex.sessions', {
      treeDataProvider: tree,
      showCollapseAll: false,
    }),
  );
  void tree.setScope(readConfig().historyScope);

  const panel = new ControlPanelViewProvider(settings, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ControlPanelViewProvider.viewType, panel),
  );

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
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codex.openSession', (s: SessionSummary) =>
      openSession(chat, claudeChat, log, s),
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
    vscode.commands.registerCommand('codex.showUsage', async () => {
      await vscode.commands.executeCommand('codex.controlPanel.focus');
      await readUsage();
    }),
    vscode.commands.registerCommand('codex.newChat', () => chat.openNew()),
    vscode.commands.registerCommand('claude.newChat', () => claudeChat.openNew()),
    vscode.commands.registerCommand('claude.openChat', (s: SessionSummary) =>
      claudeChat.openThread(s.id, s.threadName ?? s.id.slice(0, 8), s.cwd),
    ),
    vscode.commands.registerCommand('codex.renameChat', () => chat.renameActive()),
    vscode.commands.registerCommand('codex.openChat', (s: SessionSummary) =>
      chat.openThread(s.id, s.threadName ?? s.id.slice(0, 8), s.cwd),
    ),
    vscode.commands.registerCommand('codex.openConversation', (s: SessionSummary) =>
      conversations.open(s),
    ),
    vscode.commands.registerCommand(
      'codex.forkSession',
      (s: SessionSummary) => void forkSession(providers, chat, log, s),
    ),
    vscode.commands.registerCommand('codex.archiveSession', (s: SessionSummary) =>
      runAction(actions, tree, log, 'archive', s),
    ),
    vscode.commands.registerCommand('codex.unarchiveSession', (s: SessionSummary) =>
      runAction(actions, tree, log, 'unarchive', s),
    ),
    vscode.commands.registerCommand('codex.deleteSession', (s: SessionSummary) =>
      runAction(actions, tree, log, 'delete', s),
    ),
    vscode.commands.registerCommand('codex.showLog', () => log.show()),
    vscode.commands.registerCommand('agent.workflows.run', () =>
      runWorkflow(workflowRunner, workflowView, log),
    ),
    vscode.commands.registerCommand('agent.workflows.stop', () => stopWorkflow(workflowRunner)),
    vscode.commands.registerCommand('agent.workflows.view', () => workflowView.show()),
    vscode.commands.registerCommand('agent.workflows.plan', () =>
      planWorkflowCommand(chat, claudeChat, workflowView, log),
    ),
    vscode.commands.registerCommand('agent.workflows.roadmap', () =>
      runRoadmap(roadmapIssuePort, chat, claudeChat, log),
    ),
  );

  return { sessionTree: tree };
}

/** `workflowRunner` / `planWorkflowCommand` が共通して使うクランプ基準（design.md §16.16）。 */
function readSafetyBaseline(): ExtensionSafetyBaseline {
  return {
    codexSandbox: readConfig().codex.sandbox,
    codexApprovalMode: readConfig().codex.approvalMode,
    claudePermissionMode: readClaudeConfig().claude.permissionMode,
    allowAutoApprove: readWorkflowsConfig().allowAutoApprove,
  };
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
 * ゴールの文からロードマップを生成する（design.md §16.19、#95・配線はIssue #105）。
 *
 * 生成セッションの起動は `roadmap.ts` の `createTaskSessionRoadmapGenerationPort` に委ねる。
 * `planWorkflowCommand`（分解セッション）と同じく、プロバイダは `defaults.provider` の
 * 組み込み既定値（`codex`）に固定する（design.md §16.9「設定での切り替えは提供しない」）。
 */
async function runRoadmap(
  issues: IssueListPort,
  chat: ChatViewManager,
  claudeChat: ClaudeChatViewManager,
  log: Logger,
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

  const workspaceRoot = folder.uri.fsPath;
  const provider = DEFAULT_PROVIDER;
  const host = provider === 'claude' ? claudeChat : chat;
  const generation = createTaskSessionRoadmapGenerationPort(host, provider, workspaceRoot);
  const [workspaceSummary, hasAgentsFile, hasClaudeFile] = await Promise.all([
    listWorkspaceSummary(folder),
    fileExists(folder, 'AGENTS.md'),
    fileExists(folder, 'CLAUDE.md'),
  ]);

  const result = await generateRoadmap(
    { generation, issues, fs: nodeRoadmapFileSystem },
    {
      goal,
      workspaceRoot,
      roadmapDir: readWorkflowsConfig().roadmapDir,
      workspaceSummary,
      hasAgentsFile,
      hasClaudeFile,
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
    void vscode.window.showWarningMessage(
      '生成されたロードマップに問題があります。内容を確認してください（詳しくはログ）',
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
  if (source.sourceKind === 'roadmap') {
    await planWorkflowFromRoadmapCommand(chat, claudeChat, view, log, folder);
    return;
  }
  await planWorkflowFromGoalCommand(chat, claudeChat, view, log, folder);
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

  const provider = DEFAULT_PROVIDER;
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
    await handlePlanSuccess(result, goal, workspaceRoot, view, log);
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
    void vscode.window.showWarningMessage(
      '選択したロードマップに問題があります。内容を確認してください（詳しくはログ）',
    );
  }

  const nextPhase = selectNextRoadmapPhase(parsed);
  const phasePicks = parsed.phases.map((phase) => ({
    label: phase.name === '' ? '(無題のフェーズ)' : phase.name,
    phase,
    // `exactOptionalPropertyTypes`下では`description: undefined`を明示できないため、
    // 次のフェーズでなければキー自体を持たせない
    ...(phase === nextPhase ? { description: '次に着手すべきフェーズ' } : {}),
  }));
  const pickedPhase = await vscode.window.showQuickPick(phasePicks, {
    placeHolder: '変換するフェーズを選択（1回のワークフローで扱うのは一部でよい）',
    ignoreFocusOut: true,
  });
  if (pickedPhase === undefined) {
    return;
  }

  const provider = DEFAULT_PROVIDER;
  const host = provider === 'claude' ? claudeChat : chat;
  const workspaceRoot = folder.uri.fsPath;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ワークフローを生成しています…' },
    async () => {
      const workspaceSummary = await buildWorkspaceSummary(workspaceRoot, nodePlannerWorkspacePort);
      return planWorkflowFromRoadmapPhase({
        roadmapTitle: parsed.title,
        phase: pickedPhase.phase,
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
    await handlePlanFailure(result, log);
    return;
  }

  if (result.roadmapMismatches.length > 0) {
    log.warn(
      `[planner] ロードマップの材料が正しく転記されていない可能性があります: ${result.roadmapMismatches
        .map((m) => m.message)
        .join(' / ')}`,
    );
    void vscode.window.showWarningMessage(
      '生成されたワークフローが、ロードマップの内容（id・依存・Issue）と一致しない箇所があります' +
        `（${result.roadmapMismatches.length}件）。内容を確認してください（詳しくはログ）`,
    );
  }

  await handlePlanSuccess(
    result,
    buildRoadmapPlanGoal(parsed.title, pickedPhase.phase),
    workspaceRoot,
    view,
    log,
  );
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
 */
async function handlePlanSuccess(
  result: Extract<PlanWorkflowResult, { ok: true }>,
  goal: string,
  workspaceRoot: string,
  view: WorkflowViewManager,
  log: Logger,
): Promise<void> {
  const dirConfig = readWorkflowsConfig().dir;
  const dirAbs = path.join(workspaceRoot, dirConfig);
  await fsPromises.mkdir(dirAbs, { recursive: true });

  const pattern = new vscode.RelativePattern(dirAbs, '*.{yaml,yml}');
  const existingFiles = await vscode.workspace.findFiles(pattern, undefined, 500);
  const existingBaseNames = new Set(
    existingFiles.map((f) => path.basename(f.fsPath).replace(/\.ya?ml$/i, '')),
  );
  const filePath = await writeUniqueWorkflowFile(
    dirAbs,
    slugifyGoal(goal),
    existingBaseNames,
    result.yaml,
  );

  // エディタより先にViewを開く。エディタの`showTextDocument`が最後に呼ばれるほうへ
  // フォーカスが残るようにするため（Viewのパネル作成自体はフォーカスを奪う作りのため）
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
 * セッション全体を分岐する。
 *
 * Codexはapp-server経由で新しいスレッドを作れる。Claude Codeはidを指定できないため、
 * 分岐先の紐付けは確定しないまま開く。
 */
async function forkSession(
  providers: ProviderRegistry,
  chat: ChatViewManager,
  log: Logger,
  session: SessionSummary,
): Promise<void> {
  const provider = providers.get(session.provider);
  if (provider === undefined || !provider.capabilities.fork) {
    void vscode.window.showInformationMessage('このセッションは分岐に対応していません');
    return;
  }
  if (session.provider !== 'codex') {
    void vscode.window.showInformationMessage(
      'Claude Codeのセッション全体の分岐には対応していません',
    );
    return;
  }
  // ターンを指定しない分岐は、会話の末尾から分岐するのと同じ
  log.info(`セッションを分岐します: ${session.id}`);
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
 * CLIの実行ファイルを解決する。見つからなければ導入手順への導線を出す。
 */
function resolveExecutable(provider: AgentProvider, log: Logger): string | undefined {
  const located = provider.locate();
  if (located.ok) {
    return located.path;
  }

  const message =
    located.reason === 'setting-not-executable'
      ? `${provider.executableSettingKey} が実行できません: ${located.attempted}`
      : `${located.attempted} コマンドが見つかりません。${provider.label} を導入するか ${provider.executableSettingKey} を設定してください`;
  log.error(message);

  void vscode.window.showErrorMessage(message, 'インストール手順', '設定を開く').then((choice) => {
    if (choice === 'インストール手順') {
      void vscode.env.openExternal(vscode.Uri.parse(provider.installUrl));
    } else if (choice === '設定を開く') {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        provider.executableSettingKey,
      );
    }
  });
  return undefined;
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
