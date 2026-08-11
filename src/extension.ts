import * as vscode from 'vscode';
import { ActivityLogger, nodeClock, resolveBufferDir } from './activity/activityLogger';
import type { RecordRequest as ActivityRequest } from './activity/activityLogger';
import { nodeActivityAppender } from './activity/nodeAppender';
import { claudePaths, resolveClaudeHome } from './claude/cliLocator';
import { ClaudeProvider } from './claude/provider';
import { ClaudeSessionStore } from './claude/sessionStore';
import { ClaudeTranscriptWatcher } from './claude/transcriptWatcher';
import { AppServerClient } from './codex/appServerClient';
import { codexPaths, nodeLocatorDeps, resolveCodexHome } from './codex/cliLocator';
import { CodexProvider } from './codex/provider';
import type { SessionMeta, SessionSummary } from './codex/types';
import type { UsageSnapshot } from './codex/usage';
import {
  readActivityLogConfig,
  readClaudeConfig,
  readConfig,
  workspaceFolderPaths,
} from './config';
import { ProviderRegistry } from './provider/registry';
import type { AgentProvider } from './provider/types';
import { createLogger, type Logger } from './log';
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

const META_CACHE_KEY = 'codex.metaCache.v1';
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

  const settings = new SettingsProvider(
    nodeFileSystem,
    paths.modelsCache,
    paths.configToml,
    `${claudeDirs.home}/settings.json`,
    log,
  );
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
  );
  context.subscriptions.push(chat);

  const claudeChat = new ClaudeChatViewManager(
    () => resolveExecutable(claude, log) ?? 'claude',
    nodeFileSystem,
    mentions,
    claudeHome,
    claudeStore,
    settings,
    log,
    (activity) => recordActivity({ ...activity, source: 'claude-code' }),
    (usage) => usageBar.updateClaude(usage),
  );
  context.subscriptions.push(claudeChat);

  const appServer = new AppServerClient(codexPath, log);
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
