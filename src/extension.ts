import * as vscode from 'vscode';
import {
  ActivityLogger,
  InMemoryLoggedSessions,
  nodeClock,
  resolveBufferDir,
  retentionCutoff,
} from './activity/activityLogger';
import type { RecordRequest as ActivityRequest } from './activity/activityLogger';
import { nodeActivityAppender } from './activity/nodeAppender';
import { claudePaths, resolveClaudeHome } from './claude/cliLocator';
import { isUnsafeClaudeCombination } from './claude/argvBuilder';
import { ClaudeProvider } from './claude/provider';
import { ClaudeSessionStore } from './claude/sessionStore';
import { ClaudeTranscriptWatcher } from './claude/transcriptWatcher';
import { AppServerClient } from './codex/appServerClient';
import { isUnsafeCombination } from './codex/argvBuilder';
import { codexPaths, nodeLocatorDeps, resolveCodexHome } from './codex/cliLocator';
import { CodexProvider } from './codex/provider';
import type { LaunchTarget, SessionMeta, SessionSummary } from './codex/types';
import type { UsageSnapshot } from './codex/usage';
import {
  currentWorkspaceFolder,
  readActivityLogConfig,
  readClaudeConfig,
  readConfig,
  workspaceFolderPaths,
} from './config';
import { ProviderRegistry } from './provider/registry';
import type { AgentProvider } from './provider/types';
import { createLogger, type Logger } from './log';
import { nodeFileSystem } from './session/nodeFileSystem';
import { InMemoryMetaCache } from './session/ports';
import { SessionStore } from './session/sessionStore';
import { SessionActions, nodeCommandRunner, type SessionAction } from './session/sessionActions';
import { SessionWatcher } from './session/sessionWatcher';
import { UsageReader } from './session/usageReader';
import { TabStateStore } from './state/tabStateStore';
import { sortForRestore } from './state/tabState';
import { TerminalRenamer } from './terminal/terminalRenamer';
import { SessionBinder } from './terminal/sessionBinder';
import { createLaunchTag } from './terminal/sessionBinder';
import { TerminalSessionManager } from './terminal/terminalSessionManager';
import { ChatViewManager } from './view/chatView';
import { ClaudeChatViewManager } from './view/claudeChatView';
import { ControlPanelViewProvider } from './view/controlPanelView';
import { ConversationViewManager } from './view/conversationView';
import { formatRelativeTime } from './view/relativeTime';
import { SessionTreeProvider } from './view/sessionTreeProvider';
import { SettingsProvider } from './view/settingsProvider';
import { UsageStatusBar } from './view/usageStatusBar';

const META_CACHE_KEY = 'codex.metaCache.v1';
const ACTIVITY_LOGGED_KEY = 'agent.activityLogged.v1';
/** 作業記録のためにtranscriptを読む件数。開いているタブの分が入れば足りる。 */
const CLAUDE_ACTIVITY_SCAN_LIMIT = 50;

export function activate(context: vscode.ExtensionContext): void {
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
  const binder = new SessionBinder();

  const claudeHome = resolveClaudeHome(readClaudeConfig().configDir, nodeLocatorDeps);
  const claudeDirs = claudePaths(claudeHome);
  log.info(`CLAUDE_CONFIG_DIR=${claudeHome}`);
  const claudeStore = new ClaudeSessionStore(nodeFileSystem, claudeDirs);

  const codex = new CodexProvider(store);
  const claude = new ClaudeProvider(claudeStore);
  const providers = new ProviderRegistry([codex, claude]);
  /** Codex固有の機能（app-server・設定パネル・破壊操作）が使う実行ファイル。 */
  const codexPath = (): string => resolveExecutable(codex, log) ?? 'codex';

  const loggedSessions = new InMemoryLoggedSessions(
    context.globalState.get<Record<string, string>>(ACTIVITY_LOGGED_KEY) ?? {},
  );
  loggedSessions.prune(retentionCutoff(new Date()));
  const activity = new ActivityLogger(
    nodeActivityAppender,
    loggedSessions,
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
    void activity.record(request).then(() => {
      void context.globalState.update(ACTIVITY_LOGGED_KEY, loggedSessions.toRecord());
    });
  };

  const manager = new TerminalSessionManager(binder, nodeFileSystem, log, {
    onBound: () => {
      tree.refresh();
      captureTabs();
    },
    onClosed: () => {
      tree.refresh();
      captureTabs();
    },
  });
  context.subscriptions.push(manager);

  const settings = new SettingsProvider(
    nodeFileSystem,
    paths.modelsCache,
    paths.configToml,
    `${claudeDirs.home}/settings.json`,
    log,
  );
  // 設定パネルを開かずCodex画面だけ使う場合でも選択肢が揃うよう、起動時に読む
  void settings.load();
  const chat = new ChatViewManager(
    codexPath,
    settings,
    home,
    nodeFileSystem,
    log,
    ({ sessionId, cwd, text }) => recordActivity({ sessionId, source: 'codex', cwd, text }),
  );
  context.subscriptions.push(chat);

  const claudeChat = new ClaudeChatViewManager(
    () => resolveExecutable(claude, log) ?? 'claude',
    nodeFileSystem,
    claudeHome,
    claudeStore,
    settings,
    log,
    ({ sessionId, cwd, text }) => recordActivity({ sessionId, source: 'claude-code', cwd, text }),
    (usage) => usageBar.updateClaude(usage),
  );
  context.subscriptions.push(claudeChat);

  const appServer = new AppServerClient(codexPath, log);
  const conversations = new ConversationViewManager(nodeFileSystem, store, log, (session, turnId) =>
    forkFromTurn(codex, appServer, manager, tree, log, session, turnId),
  );
  context.subscriptions.push(conversations);

  const tabs = new TabStateStore(context.workspaceState);
  const renamer = new TerminalRenamer(log);
  context.subscriptions.push(renamer);
  const actions = new SessionActions(nodeCommandRunner, codexPath);

  // タブの開閉・移動をまとめて拾い、並び順ごと保存する
  const captureTabs = debounce(() => void tabs.capture(manager), 500);
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => captureTabs()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => captureTabs()),
  );

  const tree = new SessionTreeProvider(
    providers,
    (id) => manager.findBySessionId(id) !== undefined,
    log,
  );
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
    usageSnapshot = await usageReader.read();
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
    onRolloutCreated: (filePath) => void manager.handleRolloutCreated(filePath),
    onRolloutChanged: () => readUsageDebounced(),
    onIndexChanged: () => {
      tree.refreshDebounced();
      void persistCache(context, cache);
      void syncTabNames(manager, renamer, store, recordActivity);
    },
  });
  context.subscriptions.push(watcher);

  // Claude Codeには索引が無いため、transcriptの作成・追記を一覧更新の契機にする
  const claudeWatcher = new ClaudeTranscriptWatcher(claudeDirs, {
    onTranscriptChanged: () => {
      tree.refreshDebounced();
      void syncClaudeActivity(manager, claudeStore, recordActivity);
    },
  });
  context.subscriptions.push(claudeWatcher);

  // リロード後にCodex画面のタブを復元する（TUIタブは TabStateStore が担当）
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codex.chat', {
      deserializeWebviewPanel: (panel, state) => chat.restorePanel(panel, state),
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
    vscode.commands.registerCommand('codex.newSession', () => newSession(codex, manager, log)),
    vscode.commands.registerCommand('claude.newSession', () => newSession(claude, manager, log)),
    vscode.commands.registerCommand('codex.openSession', (s: SessionSummary) =>
      openSession(providers, manager, log, s),
    ),
    vscode.commands.registerCommand('codex.resumeSession', () =>
      pickAndResume(providers, manager, tree, log),
    ),
    vscode.commands.registerCommand('codex.resumeLast', () =>
      resumeLast(providers, manager, tree, log),
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
    vscode.commands.registerCommand('codex.forkSession', (s: SessionSummary) =>
      forkSession(providers, manager, log, s),
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
  );

  if (readConfig().restoreEnabled) {
    void restoreTabs(providers, manager, tabs, log);
  }
}

/**
 * 前回開いていたセッションのタブを開き直す。
 * プロセスは新規なので、復元されるのは画面ではなく会話履歴。
 */
async function restoreTabs(
  providers: ProviderRegistry,
  manager: TerminalSessionManager,
  store: TabStateStore,
  log: Logger,
): Promise<void> {
  const saved = sortForRestore(store.load());
  if (saved.length === 0) {
    return;
  }

  const config = readConfig();
  const target = saved.slice(0, Math.max(0, config.restoreMaxTabs));
  if (target.length < saved.length) {
    log.warn(
      `復元上限 ${config.restoreMaxTabs} を超えたため ${saved.length - target.length} 件を開きません`,
    );
  }

  let restored = 0;
  for (const tab of target) {
    const provider = providers.get(tab.provider);
    // 実行ファイルが無いCLIのタブは黙って飛ばす（もう一方の復元は続ける）
    if (provider === undefined || !provider.locate().ok) {
      continue;
    }
    launchSession(provider, manager, log, {
      target: { kind: 'resume', sessionId: tab.sessionId },
      cwd: tab.cwd,
      name: provider.tabTitle({ id: tab.sessionId, threadName: tab.threadName }),
      // 列を保ちつつフォーカスを奪わない
      location: { viewColumn: tab.viewColumn, preserveFocus: true },
      ...(tab.threadName === undefined ? {} : { threadName: tab.threadName }),
    });
    restored++;
  }
  log.info(`${restored}件のタブを復元しました`);
}

/**
 * Codexが要約名を確定/更新したらタブ名へ反映する。
 *
 * 作業記録もここで行う。要約名はCodexが初回発言から付けたものなので、
 * 会話本文を読まずに日報向けの1行が得られる（設計書 §8）。
 */
async function syncTabNames(
  manager: TerminalSessionManager,
  renamer: TerminalRenamer,
  store: SessionStore,
  recordActivity: (request: ActivityRequest) => void,
): Promise<void> {
  const tracked = manager.trackedSessions();
  if (tracked.length === 0) {
    return;
  }

  const names = await store.threadNames();
  for (const session of tracked) {
    const id = session.sessionId;
    const name = id === undefined ? undefined : names.get(id);
    if (id === undefined || name === undefined) {
      continue;
    }
    if (session.cwd !== undefined) {
      recordActivity({ sessionId: id, source: 'codex', cwd: session.cwd, text: name });
    }
    if (manager.setThreadName(id, name) !== undefined) {
      await renamer.request(session.terminal, `Codex: ${name}`);
    }
  }
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
  manager: TerminalSessionManager,
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
  launchSession(codex, manager, log, {
    target: { kind: 'resume', sessionId: result.threadId },
    cwd: session.cwd,
    name: `${codex.tabTitle(session)} (分岐)`,
  })?.show();
  tree.refresh();
}

function forkSession(
  providers: ProviderRegistry,
  manager: TerminalSessionManager,
  log: Logger,
  session: SessionSummary,
): void {
  const provider = providers.get(session.provider);
  if (provider === undefined || !provider.capabilities.fork) {
    void vscode.window.showInformationMessage('このセッションは分岐に対応していません');
    return;
  }
  // forkは新しいセッションになるため、idは起動後に確定する
  launchSession(provider, manager, log, {
    target: { kind: 'fork', sessionId: session.id },
    cwd: session.cwd,
    name: `${provider.tabTitle(session)} (fork)`,
  })?.show();
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

interface LaunchOptions {
  target: LaunchTarget;
  cwd: string | undefined;
  name: string;
  location?: vscode.TerminalEditorLocationOptions;
  threadName?: string;
}

/** プロバイダに引数を組み立てさせてタブを起動する。 */
function launchSession(
  provider: AgentProvider,
  manager: TerminalSessionManager,
  log: Logger,
  options: LaunchOptions,
): vscode.Terminal | undefined {
  const executablePath = resolveExecutable(provider, log);
  if (executablePath === undefined) {
    return undefined;
  }

  const tag = createLaunchTag();
  let spec;
  try {
    spec = provider.buildLaunch({
      target: options.target,
      cwd: options.cwd,
      tag,
      name: options.name,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.error(`起動引数を組み立てられませんでした: ${reason}`);
    void vscode.window.showErrorMessage(`${provider.label} を起動できません: ${reason}`);
    return undefined;
  }

  const { terminal } = manager.launch({
    provider: provider.id,
    tag,
    executablePath,
    spec,
    cwd: options.cwd,
    name: options.name,
    ...(options.location === undefined ? {} : { location: options.location }),
    ...(options.threadName === undefined ? {} : { threadName: options.threadName }),
  });
  return terminal;
}

/**
 * Claude Codeのセッションを作業記録へ流す。
 *
 * Codexと違い要約名がCLI側に無いため、transcriptの初回発言をそのまま使う。
 */
async function syncClaudeActivity(
  manager: TerminalSessionManager,
  store: ClaudeSessionStore,
  recordActivity: (request: ActivityRequest) => void,
): Promise<void> {
  const tracked = manager
    .trackedSessions()
    .filter((t) => t.provider === 'claude' && t.cwd !== undefined);
  if (tracked.length === 0) {
    return;
  }

  const { sessions } = await store.list({
    scope: 'all',
    workspaceFolders: [],
    maxEntries: CLAUDE_ACTIVITY_SCAN_LIMIT,
  });
  const byId = new Map(sessions.map((s) => [s.id, s]));

  for (const session of tracked) {
    const id = session.sessionId;
    const found = id === undefined ? undefined : byId.get(id);
    if (id === undefined || found?.threadName === undefined || session.cwd === undefined) {
      continue;
    }
    recordActivity({
      sessionId: id,
      source: 'claude-code',
      cwd: session.cwd,
      text: found.threadName,
    });
  }
}

async function newSession(
  provider: AgentProvider,
  manager: TerminalSessionManager,
  log: Logger,
): Promise<void> {
  if (isUnsafe(provider) && !(await confirmUnsafe(provider))) {
    return;
  }

  // フォルダが無いと作業ディレクトリを決められず、CLIが不定の場所で起動してしまう。
  // 履歴のワークスペースフィルタも成立しないため、ここで止める。
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    log.error('ワークスペースフォルダが開かれていないため起動できません');
    void vscode.window.showErrorMessage(
      `${provider.label} を開始するにはフォルダを開いてください（ファイル > フォルダーを開く）`,
    );
    return;
  }

  launchSession(provider, manager, log, {
    target: { kind: 'new' },
    cwd: folder.uri.fsPath,
    name: `${provider.label}: ${folder.name}`,
  })?.show();
}

/** 承認とサンドボックスを両方外す設定になっているか。 */
function isUnsafe(provider: AgentProvider): boolean {
  return provider.id === 'claude'
    ? isUnsafeClaudeCombination(readClaudeConfig().claude)
    : isUnsafeCombination(readConfig().codex);
}

/**
 * 履歴からセッションを開く。既に開いているタブがあれば新規に開かず、そのタブへ移る
 * （ファイルタブと同じ挙動）。
 */
function openSession(
  providers: ProviderRegistry,
  manager: TerminalSessionManager,
  log: Logger,
  session: SessionSummary,
): void {
  const existing = manager.findBySessionId(session.id);
  if (existing !== undefined) {
    existing.terminal.show();
    return;
  }

  const provider = providers.get(session.provider);
  if (provider === undefined) {
    log.error(`未知のCLIのセッションです: ${session.provider}`);
    return;
  }

  if (session.cwd === undefined) {
    log.warn(`cwdが判らないセッションのため作業ディレクトリを指定しません: ${session.id}`);
  }

  launchSession(provider, manager, log, {
    target: { kind: 'resume', sessionId: session.id },
    // 現在のワークスペースではなく、そのセッション自身のcwdを渡す。
    // 全ワークスペース表示から別プロジェクトのセッションを開いても移動させないため。
    cwd: session.cwd,
    name: provider.tabTitle(session),
    ...(session.threadName === undefined ? {} : { threadName: session.threadName }),
  })?.show();
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
  manager: TerminalSessionManager,
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
    openSession(providers, manager, log, picked.session);
  }
}

async function resumeLast(
  providers: ProviderRegistry,
  manager: TerminalSessionManager,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<void> {
  const sessions = await listSessions(providers, tree, log);
  const latest = sessions[0];
  if (latest === undefined) {
    void vscode.window.showInformationMessage('再開できるセッションがありません');
    return;
  }
  openSession(providers, manager, log, latest);
}

async function confirmUnsafe(provider: AgentProvider): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `承認が無効になっています。${provider.label} はコマンドを確認なしで実行します。`,
    { modal: true },
    '実行する',
  );
  return choice === '実行する';
}

async function persistCache(
  context: vscode.ExtensionContext,
  cache: InMemoryMetaCache,
): Promise<void> {
  await context.globalState.update(META_CACHE_KEY, cache.toRecord());
}
