import * as vscode from 'vscode';
import { AppServerClient } from './codex/appServerClient';
import { isUnsafeCombination } from './codex/argvBuilder';
import {
  codexPaths,
  nodeLocatorDeps,
  resolveCodexHome,
  resolveCodexPath,
} from './codex/cliLocator';
import type { SessionMeta, SessionSummary } from './codex/types';
import type { UsageSnapshot } from './codex/usage';
import { currentWorkspaceFolder, readConfig, workspaceFolderPaths } from './config';
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
import { TerminalSessionManager } from './terminal/terminalSessionManager';
import { ChatViewManager } from './view/chatView';
import { ControlPanelViewProvider } from './view/controlPanelView';
import { ConversationViewManager } from './view/conversationView';
import { formatRelativeTime } from './view/relativeTime';
import { SessionTreeProvider } from './view/sessionTreeProvider';
import { SettingsProvider } from './view/settingsProvider';
import { UsageStatusBar } from './view/usageStatusBar';

const META_CACHE_KEY = 'codex.metaCache.v1';
const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Codex Sessions');
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

  const manager = new TerminalSessionManager(
    () => resolveExecutable(log)?.path ?? 'codex',
    binder,
    nodeFileSystem,
    log,
    {
      onBound: () => {
        tree.refresh();
        captureTabs();
      },
      onClosed: () => {
        tree.refresh();
        captureTabs();
      },
    },
  );
  context.subscriptions.push(manager);

  const settings = new SettingsProvider(nodeFileSystem, paths.modelsCache, paths.configToml, log);
  const chat = new ChatViewManager(() => resolveExecutable(log)?.path ?? 'codex', settings, log);
  context.subscriptions.push(chat);

  const appServer = new AppServerClient(() => resolveExecutable(log)?.path ?? 'codex', log);
  const conversations = new ConversationViewManager(nodeFileSystem, store, log, (session, turnId) =>
    forkFromTurn(appServer, manager, tree, log, session, turnId),
  );
  context.subscriptions.push(conversations);

  const tabs = new TabStateStore(context.workspaceState);
  const renamer = new TerminalRenamer(log);
  context.subscriptions.push(renamer);
  const actions = new SessionActions(
    nodeCommandRunner,
    () => resolveExecutable(log)?.path ?? 'codex',
  );

  // タブの開閉・移動をまとめて拾い、並び順ごと保存する
  const captureTabs = debounce(() => void tabs.capture(manager), 500);
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => captureTabs()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => captureTabs()),
  );

  const tree = new SessionTreeProvider(
    store,
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
      void syncTabNames(manager, renamer, store);
    },
  });
  context.subscriptions.push(watcher);

  // リロード後にCodex画面のタブを復元する（TUIタブは TabStateStore が担当）
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('codex.chat', {
      deserializeWebviewPanel: (panel, state) => chat.restorePanel(panel, state),
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codex')) {
        void panel.refresh();
        chat.refreshSettings();
        tree.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codex.newSession', () => newSession(manager, log)),
    vscode.commands.registerCommand('codex.openSession', (s: SessionSummary) =>
      openSession(manager, log, s),
    ),
    vscode.commands.registerCommand('codex.resumeSession', () =>
      pickAndResume(manager, store, tree, log),
    ),
    vscode.commands.registerCommand('codex.resumeLast', () =>
      resumeLast(manager, store, tree, log),
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
    vscode.commands.registerCommand('codex.renameChat', () => chat.renameActive()),
    vscode.commands.registerCommand('codex.openChat', (s: SessionSummary) =>
      chat.openThread(s.id, s.threadName ?? s.id.slice(0, 8), s.cwd),
    ),
    vscode.commands.registerCommand('codex.openConversation', (s: SessionSummary) =>
      conversations.open(s),
    ),
    vscode.commands.registerCommand('codex.forkSession', (s: SessionSummary) =>
      forkSession(manager, log, s),
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
    void restoreTabs(manager, tabs, log);
  }
}

/**
 * 前回開いていたセッションのタブを開き直す。
 * プロセスは新規なので、復元されるのは画面ではなく会話履歴。
 */
async function restoreTabs(
  manager: TerminalSessionManager,
  store: TabStateStore,
  log: Logger,
): Promise<void> {
  const saved = sortForRestore(store.load());
  if (saved.length === 0) {
    return;
  }
  if (resolveExecutable(log) === undefined) {
    return;
  }

  const config = readConfig();
  const target = saved.slice(0, Math.max(0, config.restoreMaxTabs));
  if (target.length < saved.length) {
    log.warn(
      `復元上限 ${config.restoreMaxTabs} を超えたため ${saved.length - target.length} 件を開きません`,
    );
  }

  for (const tab of target) {
    manager.launch({
      target: { kind: 'resume', sessionId: tab.sessionId },
      cwd: tab.cwd,
      config: config.codex,
      name: `Codex: ${tab.threadName ?? tab.sessionId.slice(0, 8)}`,
      // 列を保ちつつフォーカスを奪わない
      location: { viewColumn: tab.viewColumn, preserveFocus: true },
      sessionId: tab.sessionId,
      ...(tab.threadName === undefined ? {} : { threadName: tab.threadName }),
    });
  }
  log.info(`${target.length}件のタブを復元しました`);
}

/** Codexが要約名を確定/更新したらタブ名へ反映する。 */
async function syncTabNames(
  manager: TerminalSessionManager,
  renamer: TerminalRenamer,
  store: SessionStore,
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
  appServer: AppServerClient,
  manager: TerminalSessionManager,
  tree: SessionTreeProvider,
  log: Logger,
  session: SessionSummary,
  turnId: string,
): Promise<void> {
  if (resolveExecutable(log) === undefined) {
    return;
  }

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
  const { terminal } = manager.launch({
    target: { kind: 'resume', sessionId: result.threadId },
    cwd: session.cwd,
    config: readConfig().codex,
    name: `Codex: ${session.threadName ?? session.id.slice(0, 8)} (分岐)`,
    sessionId: result.threadId,
  });
  terminal.show();
  tree.refresh();
}

function forkSession(manager: TerminalSessionManager, log: Logger, session: SessionSummary): void {
  if (resolveExecutable(log) === undefined) {
    return;
  }
  // forkは新しいセッションになるため、idは起動後の紐付けで確定させる
  const { terminal } = manager.launch({
    target: { kind: 'fork', sessionId: session.id },
    cwd: session.cwd,
    config: readConfig().codex,
    name: `Codex: ${session.threadName ?? session.id.slice(0, 8)} (fork)`,
  });
  terminal.show();
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

function resolveExecutable(log: Logger): { path: string } | undefined {
  const config = readConfig();
  const located = resolveCodexPath(config.executablePath, nodeLocatorDeps);
  if (located.ok) {
    return { path: located.path };
  }

  const message =
    located.reason === 'setting-not-executable'
      ? `codex.executablePath が実行できません: ${located.attempted}`
      : 'codex コマンドが見つかりません。Codex CLIを導入するか codex.executablePath を設定してください';
  log.error(message);

  void vscode.window.showErrorMessage(message, 'インストール手順', '設定を開く').then((choice) => {
    if (choice === 'インストール手順') {
      void vscode.env.openExternal(vscode.Uri.parse(CODEX_INSTALL_URL));
    } else if (choice === '設定を開く') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'codex.executablePath');
    }
  });
  return undefined;
}

async function newSession(manager: TerminalSessionManager, log: Logger): Promise<void> {
  if (resolveExecutable(log) === undefined) {
    return;
  }

  const config = readConfig();
  if (isUnsafeCombination(config.codex) && !(await confirmUnsafe())) {
    return;
  }

  // フォルダが無いと -C を決められず、Codexが不定のディレクトリで起動してしまう。
  // 履歴のワークスペースフィルタも成立しないため、ここで止める。
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    log.error('ワークスペースフォルダが開かれていないため起動できません');
    void vscode.window.showErrorMessage(
      'Codexを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
    );
    return;
  }

  const { terminal } = manager.launch({
    target: { kind: 'new' },
    cwd: folder.uri.fsPath,
    config: config.codex,
    name: `Codex: ${folder.name}`,
  });
  terminal.show();
}

/**
 * 履歴からセッションを開く。既に開いているタブがあれば新規に開かず、そのタブへ移る
 * （ファイルタブと同じ挙動）。
 */
function openSession(manager: TerminalSessionManager, log: Logger, session: SessionSummary): void {
  const existing = manager.findBySessionId(session.id);
  if (existing !== undefined) {
    existing.terminal.show();
    return;
  }

  if (resolveExecutable(log) === undefined) {
    return;
  }

  if (session.cwd === undefined) {
    log.warn(`cwdが判らないセッションのため -C を渡しません: ${session.id}`);
  }

  const { terminal } = manager.launch({
    target: { kind: 'resume', sessionId: session.id },
    // 現在のワークスペースではなく、そのセッション自身のcwdを渡す。
    // 全ワークスペース表示から別プロジェクトのセッションを開いても移動させないため。
    cwd: session.cwd,
    config: readConfig().codex,
    name: `Codex: ${session.threadName ?? session.id.slice(0, 8)}`,
    sessionId: session.id,
  });
  terminal.show();
}

async function listSessions(
  store: SessionStore,
  tree: SessionTreeProvider,
): Promise<SessionSummary[]> {
  const config = readConfig();
  const result = await store.list({
    scope: tree.scope,
    workspaceFolders: workspaceFolderPaths(),
    maxEntries: config.historyMaxEntries,
  });
  return result.sessions;
}

interface SessionPick extends vscode.QuickPickItem {
  session: SessionSummary;
}

async function pickAndResume(
  manager: TerminalSessionManager,
  store: SessionStore,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<void> {
  const sessions = await listSessions(store, tree);
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('再開できるセッションがありません');
    return;
  }

  const now = Date.now();
  const items: SessionPick[] = sessions.map((s) => ({
    label: s.threadName ?? '(名称未設定)',
    description: formatRelativeTime(s.updatedAt, now),
    ...(s.cwd === undefined ? {} : { detail: s.cwd }),
    session: s,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '再開するセッションを選択',
  });

  if (picked !== undefined) {
    openSession(manager, log, picked.session);
  }
}

async function resumeLast(
  manager: TerminalSessionManager,
  store: SessionStore,
  tree: SessionTreeProvider,
  log: Logger,
): Promise<void> {
  const sessions = await listSessions(store, tree);
  const latest = sessions[0];
  if (latest === undefined) {
    void vscode.window.showInformationMessage('再開できるセッションがありません');
    return;
  }
  openSession(manager, log, latest);
}

async function confirmUnsafe(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'サンドボックスと承認の両方が無効です。Codexはコマンドを確認なしで実行します。',
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
