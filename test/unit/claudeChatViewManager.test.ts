import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { FileSystemPort, MemoryFileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import { MESSAGING_MCP_SERVER_NAME } from '../../src/orchestrator/messaging';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import type { McpServerView } from '../../src/provider/mcpServers';
import { MEMORY_LAST_SELECTED_PATH_KEY, type MemoryModeMemento } from '../../src/provider/inputModes';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import { __mock, ViewColumn, window as fakeWindow, type FakeWebviewPanel } from '../mocks/vscode';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const fakeFileSystem: FileSystemPort = {
  readTextFile: async () => undefined,
  readFirstLine: async () => undefined,
  readTail: async () => undefined,
  mtimeMs: async () => undefined,
  listRollouts: async () => [],
  listJsonl: async () => [],
  listMarkdown: async () => [],
  readHead: async () => [],
  readBase64File: async () => undefined,
};

/** `@` のファイル候補。走査を伴わない最小のフェイクで足りる。 */
const fakeScanPort: FileScanPort = {
  scan: async () => [],
  readText: async () => undefined,
};
function fakeMentions(): FileMentionCatalog {
  return new FileMentionCatalog(fakeScanPort);
}

function fakeSettingsProvider(): SettingsProvider {
  const settings = {
    claudeSnapshot: () => ({
      models: [],
      efforts: [],
      permissionModes: [],
      agents: [],
      model: '',
      effort: '',
      permissionMode: '',
      agent: '',
      defaults: { model: '', effort: '', permissionMode: '' },
    }),
    updateClaude: async () => true,
  };
  return settings as unknown as SettingsProvider;
}

function fakeStore(): ClaudeSessionStore {
  const store = {
    resolveTranscriptPath: async () => undefined,
    resolveCwd: async () => undefined,
  };
  return store as unknown as ClaudeSessionStore;
}

const EMPTY_TASK_CONFIG: TaskSessionConfig = { model: '', effort: '', approvalMode: '' };

/** メモリ追記（issue #144）専用の読み取り口のフェイク。既定は「無い・シンボリックリンクでない」。 */
function fakeMemoryFileSystem(overrides?: Partial<MemoryFileSystemPort>): MemoryFileSystemPort {
  return {
    readStrict: async () => undefined,
    resolveSymlinkTarget: async () => ({ kind: 'not-symlink' }),
    ...overrides,
  };
}

/** `vscode.Memento` 互換のフェイク。実体はMapだけの単純な実装で足りる。 */
function fakeMemento(): MemoryModeMemento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function createManager(options?: {
  isTaskManagedThread?: (sessionId: string) => boolean;
  memoryFs?: MemoryFileSystemPort;
  memoryMemento?: MemoryModeMemento;
}): {
  manager: ClaudeChatViewManager;
} {
  const manager = new ClaudeChatViewManager(
    () => 'claude',
    fakeFileSystem,
    fakeMentions(),
    '/fake/claude-home',
    fakeStore(),
    fakeSettingsProvider(),
    fakeLogger,
    () => undefined,
    () => undefined,
    options?.isTaskManagedThread ?? (() => false),
    options?.memoryFs ?? fakeMemoryFileSystem(),
    options?.memoryMemento ?? fakeMemento(),
  );
  return { manager };
}

/** `handleMessage` の `send` 分岐は非同期処理を待たずに戻るため、マイクロタスクを流す。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `ClaudeStreamSession.start` は実プロセスを起動する。パネル管理まわりのテストでは
 * 子プロセスの生死を気にしたくないため、呼ばれた引数だけを記録するフェイクに差し替える
 * （design.md §16.10の5「タスク単位の設定」は、この引数を見れば確かめられる）。
 */
function stubStart(): ClaudeStreamOptions[] {
  const calls: ClaudeStreamOptions[] = [];
  vi.spyOn(ClaudeStreamSession.prototype, 'start').mockImplementation(function (
    this: ClaudeStreamSession,
    options: ClaudeStreamOptions,
  ) {
    calls.push(options);
  });
  return calls;
}

/**
 * `stubStart`と同じく実プロセスは起動しないが、`this`（実際の`ClaudeStreamSession`
 * インスタンス）も併せて記録する。`receive()`を直接呼んでターンの完了を模すのに使う
 * （design.md §16.21のpauseLoop/resumeLoopの検証用）。
 */
function stubStartCapturing(): { calls: ClaudeStreamOptions[]; sessions: ClaudeStreamSession[] } {
  const calls: ClaudeStreamOptions[] = [];
  const sessions: ClaudeStreamSession[] = [];
  vi.spyOn(ClaudeStreamSession.prototype, 'start').mockImplementation(function (
    this: ClaudeStreamSession,
    options: ClaudeStreamOptions,
  ) {
    calls.push(options);
    sessions.push(this);
  });
  return { calls, sessions };
}

/** `checkMcpStatus`（design.md §16.21「ツールの可視性の確認」）を差し替える。 */
function stubMcpStatus(servers: McpServerView[] | undefined): void {
  vi.spyOn(ClaudeStreamSession.prototype, 'checkMcpStatus').mockResolvedValue(servers);
}

const initLine = (sessionId: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
const resultLine = (): string => `${JSON.stringify({ type: 'result' })}\n`;

describe('ClaudeChatViewManager', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  describe('セッションの寿命をパネルから切り離す（design.md §16.10の4）', () => {
    it('タスク管理下のセッションはタブを閉じても追跡され続け、開き直しても再起動しない', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      task.open({ preserveFocus: true });
      expect(calls).toHaveLength(1);

      __mock.lastCreatedPanel()?.dispose();

      const panelCountBefore = __mock.createdPanels.length;
      await manager.openThread(task.sessionId, 'task-a', '/workspace/root/task-a');

      // 既存のエントリが見つかったのでタブだけ作り直され、セッションは再起動しない
      expect(calls).toHaveLength(1);
      expect(__mock.createdPanels.length).toBe(panelCountBefore + 1);
    });

    it('人が手で開いた画面は、タブを閉じるとセッションが終わる', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openNew('/workspace/root');
      const sessionId = calls[calls.length - 1]?.sessionId;
      expect(sessionId).toBeDefined();

      __mock.lastCreatedPanel()?.dispose();

      await manager.openThread(sessionId as string, 'x', '/workspace/root');

      // 見つからず新規エントリとして作り直されるため、resume経由でstart()がもう一度呼ばれる
      expect(calls).toHaveLength(2);
    });
  });

  describe('タスク単位の設定（design.md §16.10の5）', () => {
    it('タスクの設定がClaudeStreamSession.startへそのまま渡る', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: { model: 'task-model', effort: 'high', approvalMode: 'plan' },
        // Claudeにsandboxの概念は無いため無視される
        sandbox: 'workspace-write',
      });

      const call = calls[calls.length - 1];
      expect(call?.config).toEqual({
        model: 'task-model',
        effort: 'high',
        permissionMode: 'plan',
        // タスクオーケストレーションはエージェントの語彙を持たないため常に空文字
        agent: '',
        additionalArgs: [],
      });
    });

    it('タスクは安全でない組み合わせの確認ダイアログを経由しない（無人実行のため）', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: { model: '', effort: '', approvalMode: 'bypassPermissions' },
        sandbox: '',
      });

      expect(calls).toHaveLength(1);
      expect(__mock.messages.warnings).toHaveLength(0);
    });
  });

  describe('タスク管理下スレッドの汎用復元除外（design.md §16.10の7）', () => {
    it('isTaskManagedThreadがtrueを返すスレッドはrestorePanelの対象から外れる', async () => {
      const { manager } = createManager({ isTaskManagedThread: (id) => id === 'session-task' });
      const panel = fakeWindow.createWebviewPanel('claude.chat', 'x', ViewColumn.Active, {});

      await manager.restorePanel(panel, { threadId: 'session-task' });

      expect(panel.disposed).toBe(true);
    });

    it('タスク管理下でないセッションは従来通り復元される', async () => {
      const calls = stubStart();
      const { manager } = createManager({ isTaskManagedThread: () => false });
      const panel = fakeWindow.createWebviewPanel('claude.chat', 'x', ViewColumn.Active, {});

      await manager.restorePanel(panel, { threadId: 'session-normal' });

      expect(panel.disposed).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.target).toEqual({ kind: 'resume', sessionId: 'session-normal' });
    });
  });

  describe('既存機能の回帰', () => {
    it('新しい会話（openNew）は引数無しでも従来通り動く', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openNew();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.target).toEqual({ kind: 'new' });
      expect(__mock.lastCreatedPanel()).toBeDefined();
    });

    it('履歴から開く（openThread）は既に開いていればパネルを増やさない', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openThread('session-y', '既存セッション', '/workspace/root');
      const panelCountBefore = __mock.createdPanels.length;
      await manager.openThread('session-y', '既存セッション', '/workspace/root');

      expect(calls).toHaveLength(1);
      expect(__mock.createdPanels.length).toBe(panelCountBefore);
    });
  });

  describe('reloadSkillsForOpenSessions（issue #202、design.md TP-90）', () => {
    it('開いている会話それぞれのreloadSkillsを呼び、結果を会話に1行残す', async () => {
      const { calls, sessions } = stubStartCapturing();
      vi.spyOn(ClaudeStreamSession.prototype, 'reloadSkills')
        .mockResolvedValueOnce({
          ok: true,
          skills: [
            {
              key: 'zzz-temp',
              name: 'zzz-temp',
              description: '増えた一時skill',
              origin: 'user',
              originDetail: undefined,
              enabled: true,
              toggleable: false,
            },
          ],
          warnings: [],
        })
        .mockResolvedValueOnce({ ok: false, reason: 'Unsupported control request subtype' });
      const { manager } = createManager();

      await manager.openNew('/workspace/root');
      const firstPanel = __mock.lastCreatedPanel();
      await manager.openThread('session-y', '2つ目', '/workspace/root');
      const secondPanel = __mock.lastCreatedPanel();
      expect(calls).toHaveLength(2);

      await manager.reloadSkillsForOpenSessions();

      expect(sessions).toHaveLength(2);
      const firstItems = (
        firstPanel?.webview.sent[firstPanel.webview.sent.length - 1] as {
          state: { items: Array<{ detail?: string }> };
        }
      ).state.items;
      expect(firstItems.some((i) => i.detail === '設定 ・ skillsを読み直しました（1件）')).toBe(
        true,
      );
      const secondItems = (
        secondPanel?.webview.sent[secondPanel.webview.sent.length - 1] as {
          state: { items: Array<{ detail?: string }> };
        }
      ).state.items;
      expect(
        secondItems.some(
          (i) =>
            i.detail ===
            '設定 ・ skillsを読み直せませんでした: Unsupported control request subtype',
        ),
      ).toBe(true);
    });

    it('プロセスが無い（閉じている）会話にはreloadSkillsがundefinedを返し、何も書き込まない', async () => {
      stubStartCapturing();
      vi.spyOn(ClaudeStreamSession.prototype, 'reloadSkills').mockResolvedValue(undefined);
      const { manager } = createManager();
      await manager.openNew('/workspace/root');

      await expect(manager.reloadSkillsForOpenSessions()).resolves.toBeUndefined();
    });
  });

  describe('タスク間メッセージングのMCP設定・可視性確認（design.md §16.21、Issue #123）', () => {
    it('input.mcpを渡すと--mcp-configがadditionalArgsへ追加される（実測: type=http）', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
      });

      const call = calls[calls.length - 1];
      expect(call?.config.additionalArgs).toEqual([
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            [MESSAGING_MCP_SERVER_NAME]: { type: 'http', url: 'http://127.0.0.1:12345/mcp/abc' },
          },
        }),
      ]);
    });

    it('input.mcpを渡さなければadditionalArgsは空のまま（後方互換）', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });

      expect(calls[calls.length - 1]?.config.additionalArgs).toEqual([]);
    });

    it('mcp_statusでサーバがconnectedならcheckMessagingToolVisible()はtrueを返す', async () => {
      stubStart();
      stubMcpStatus([
        { name: MESSAGING_MCP_SERVER_NAME, state: 'connected', toolCount: 2, version: '1', reason: undefined },
      ]);
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
      });

      await expect(task.checkMessagingToolVisible()).resolves.toBe(true);
    });

    it('mcp_statusにサーバが現れない、またはconnectedでなければfalseを返す（runは止めない）', async () => {
      stubStart();
      stubMcpStatus(undefined);
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
      });

      await expect(task.checkMessagingToolVisible()).resolves.toBe(false);
    });

    it('input.mcpを渡していなければ確認そのものを行わず常にtrueを返す', async () => {
      stubStart();
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });

      await expect(task.checkMessagingToolVisible()).resolves.toBe(true);
    });
  });

  describe('pauseLoop/resumeLoop（design.md §16.21、Issue #123）', () => {
    it('pauseLoop()するとターンが終わっても継続指示を送らず、resumeLoop()で直ちに送る', async () => {
      const { sessions } = stubStartCapturing();
      const sendCalls: string[] = [];
      vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockImplementation((text: string) => {
        sendCalls.push(text);
        return 'sent';
      });
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      const session = sessions[sessions.length - 1];
      if (session === undefined) {
        throw new Error('セッションが記録されていません');
      }

      task.runLoop({
        initialPrompt: '第1ターン',
        continuePrompt: '続けて',
        maxIterations: 5,
        condition: '',
      });
      // 初回指示（runLoop）とターン完了後の継続指示（1回）
      session.receive(initLine('s1'));
      session.receive(resultLine());
      expect(sendCalls).toEqual(['第1ターン', '続けて']);

      task.pauseLoop();
      session.receive(initLine('s1'));
      session.receive(resultLine());
      // 一時停止中はターンが終わっても継続指示を送らない
      expect(sendCalls).toEqual(['第1ターン', '続けて']);

      task.resumeLoop();
      expect(sendCalls).toEqual(['第1ターン', '続けて', '続けて']);
    });
  });
});

/**
 * 行頭 `#` のメモリ追記（issue #6、issue #144で安全性を強化）。
 *
 * `handleMessage` の `send` 分岐からの一連の流れ（QuickPick→確認→書き込み→会話への通知）を、
 * `ClaudeChatViewManager` に注入したフェイクの `MemoryFileSystemPort` / `MemoryModeMemento` を
 * 通して検証する。
 */
describe('ClaudeChatViewManagerのメモリ追記（issue #6/#144）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  async function openPanel(manager: ClaudeChatViewManager): Promise<FakeWebviewPanel | undefined> {
    await manager.openNew('/workspace/root');
    return __mock.lastCreatedPanel();
  }

  async function send(panel: FakeWebviewPanel | undefined, text: string): Promise<void> {
    panel?.webview.simulateMessage({ type: 'send', text });
    await flush();
  }

  /** 開いてすぐ送る（候補・確認ダイアログの設定を先に済ませたテストで使う）。 */
  async function openAndSend(
    manager: ClaudeChatViewManager,
    text: string,
  ): Promise<FakeWebviewPanel | undefined> {
    const panel = await openPanel(manager);
    await send(panel, text);
    return panel;
  }

  it('候補を選び確認すると内容が追記され、前回選択が記憶され、会話に1行残る', async () => {
    stubStart();
    const memento = fakeMemento();
    const { manager } = createManager({ memoryFs: fakeMemoryFileSystem(), memoryMemento: memento });
    const panel = await openPanel(manager);
    __mock.showQuickPickAnswer = (items) => items[0];

    await send(panel, '#常にpnpmを使う');

    // 確認ダイアログ（`confirmMemoryAppend`）が実際に呼ばれたことを見る。ここを見ていないと、
    // 呼び出しが丸ごと消える回帰（確認なしで書き込む）をこのテストが検出できない（レビュー指摘）。
    expect(__mock.messages.warnings).toEqual([
      '次の内容を追記します:\n\n常にpnpmを使う\n\n追記先: /workspace/root/CLAUDE.md',
    ]);
    expect(__mock.writtenFiles).toEqual([
      { path: '/workspace/root/CLAUDE.md', content: '- 常にpnpmを使う\n' },
    ]);
    expect(memento.get<string | undefined>(MEMORY_LAST_SELECTED_PATH_KEY, undefined)).toBe(
      '/workspace/root/CLAUDE.md',
    );
    const lastState = panel?.webview.sent[panel.webview.sent.length - 1] as {
      state: { items: Array<{ detail?: string }> };
    };
    expect(lastState.state.items.some((i) => i.detail === 'メモリへ追記しました: /workspace/root/CLAUDE.md')).toBe(
      true,
    );
  });

  it('追記先がシンボリックリンクなら、確認と会話の記録の両方に実体パスが出る', async () => {
    stubStart();
    const memoryFs = fakeMemoryFileSystem({
      resolveSymlinkTarget: async (p) =>
        p === '/workspace/root/CLAUDE.md'
          ? { kind: 'resolved', target: '/home/user/dotfiles/CLAUDE.md' }
          : { kind: 'not-symlink' },
    });
    const { manager } = createManager({ memoryFs });
    const panel = await openPanel(manager);
    __mock.showQuickPickAnswer = (items) => items[0];

    await send(panel, '#note');

    expect(__mock.messages.warnings.at(-1)).toContain('リンク先: /home/user/dotfiles/CLAUDE.md');
    const lastState = panel?.webview.sent[panel.webview.sent.length - 1] as {
      state: { items: Array<{ detail?: string }> };
    };
    expect(
      lastState.state.items.some((i) => i.detail?.includes('リンク先: /home/user/dotfiles/CLAUDE.md')),
    ).toBe(true);
  });

  it('追記先が壊れたシンボリックリンク（実体パスを特定できない）なら、確認と会話の記録の両方に警告が出る（issue #144レビューのCRITICAL指摘の再発防止。書き込み自体は中止しない）', async () => {
    stubStart();
    const memoryFs = fakeMemoryFileSystem({
      resolveSymlinkTarget: async (p) =>
        p === '/workspace/root/CLAUDE.md' ? { kind: 'unresolved' } : { kind: 'not-symlink' },
    });
    const { manager } = createManager({ memoryFs });
    const panel = await openPanel(manager);
    __mock.showQuickPickAnswer = (items) => items[0];

    await send(panel, '#note');

    expect(__mock.messages.warnings.at(-1)).toContain('実体のパスを特定できません');
    expect(__mock.writtenFiles).toEqual([{ path: '/workspace/root/CLAUDE.md', content: '- note\n' }]);
    const lastState = panel?.webview.sent[panel.webview.sent.length - 1] as {
      state: { items: Array<{ detail?: string }> };
    };
    expect(
      lastState.state.items.some((i) => i.detail?.includes('実体のパスを特定できません')),
    ).toBe(true);
  });

  it('確認時と書き込み直前でシンボリックリンクの解決結果が食い違えば、書き込まずエラーを出す（TOCTOU対策）', async () => {
    stubStart();
    let calls = 0;
    const memoryFs = fakeMemoryFileSystem({
      resolveSymlinkTarget: async (p) => {
        if (p !== '/workspace/root/CLAUDE.md') {
          return { kind: 'not-symlink' };
        }
        calls += 1;
        // 1回目（確認ダイアログ用）は無害な実体、2回目（書き込み直前の再検証）では
        // 攻撃者がリンク先を差し替えた想定で別の実体を返す。
        return calls === 1
          ? { kind: 'resolved', target: '/home/user/dotfiles/CLAUDE.md' }
          : { kind: 'resolved', target: '/etc/attacker-controlled' };
      },
    });
    const { manager } = createManager({ memoryFs });
    __mock.showQuickPickAnswer = (items) => items[0];

    await openAndSend(manager, '#note');

    expect(calls).toBe(2);
    expect(__mock.writtenFiles).toEqual([]);
    expect(__mock.messages.errors.some((m) => m.includes('確認時から変わった'))).toBe(true);
  });

  it('前回選んだ追記先がQuickPickの候補の先頭に来る', async () => {
    stubStart();
    const memento = fakeMemento();
    await memento.update(MEMORY_LAST_SELECTED_PATH_KEY, '/fake/claude-home/CLAUDE.md');
    const { manager } = createManager({ memoryMemento: memento });
    let seenItems: Array<{ candidate: { path: string } }> | undefined;
    __mock.showQuickPickAnswer = (items) => {
      seenItems = items as unknown as Array<{ candidate: { path: string } }>;
      return undefined; // 並び順の確認だけが目的なのでキャンセルする
    };

    await openAndSend(manager, '#note');

    expect(seenItems?.[0]?.candidate.path).toBe('/fake/claude-home/CLAUDE.md');
  });

  it('読み取りがENOENT以外の理由で失敗したら、書き込まずエラーを出す（既存ファイルの上書き破壊を防ぐ）', async () => {
    stubStart();
    const memoryFs = fakeMemoryFileSystem({
      readStrict: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const { manager } = createManager({ memoryFs });
    __mock.showQuickPickAnswer = (items) => items[0];

    await openAndSend(manager, '#note');

    expect(__mock.writtenFiles).toEqual([]);
    expect(__mock.messages.errors.some((m) => m.includes('EACCES'))).toBe(true);
  });

  it('書き込みが失敗したらエラーを出す', async () => {
    stubStart();
    const { manager } = createManager();
    __mock.showQuickPickAnswer = (items) => items[0];
    __mock.writeFileError = new Error('ENOSPC: no space left');

    await openAndSend(manager, '#note');

    expect(__mock.writtenFiles).toEqual([]);
    expect(__mock.messages.errors.some((m) => m.includes('ENOSPC'))).toBe(true);
  });

  it('QuickPickをキャンセルしたら何も起きない', async () => {
    stubStart();
    const { manager } = createManager();
    __mock.showQuickPickAnswer = () => undefined;

    await openAndSend(manager, '#note');

    expect(__mock.writtenFiles).toEqual([]);
    expect(__mock.messages.warnings).toEqual([]);
    expect(__mock.messages.errors).toEqual([]);
  });

  it('確認ダイアログをキャンセルしたら何も起きない', async () => {
    stubStart();
    const { manager } = createManager();
    __mock.showQuickPickAnswer = (items) => items[0];
    __mock.showWarningMessageAnswer = undefined;

    await openAndSend(manager, '#note');

    expect(__mock.writtenFiles).toEqual([]);
  });

  /**
   * `resolveMemoryCandidates` の統合テスト（issue #144レビュー指摘）。
   *
   * 上のテスト群は `workspaceFolder` と `entry.cwd` が常に一致する構成しか通していない。
   * design.mdが明示的に想定している「entry.cwdがworkspaceFoldersに含まれない」経路と、
   * 受入基準にあるマルチルート・フォルダ未オープンの経路を、QuickPickへ渡る候補そのもので確かめる。
   */
  describe('resolveMemoryCandidates（issue #144の統合テスト）', () => {
    async function captureCandidates(
      manager: ClaudeChatViewManager,
      openCwd: string | undefined,
    ): Promise<Array<{ label: string; path: string }>> {
      let seenItems: Array<{ candidate: { label: string; path: string; exists: boolean } }> | undefined;
      __mock.showQuickPickAnswer = (items) => {
        seenItems = items as unknown as Array<{
          candidate: { label: string; path: string; exists: boolean };
        }>;
        return undefined; // 候補の中身だけが目的なのでキャンセルする
      };
      await manager.openNew(openCwd);
      await send(__mock.lastCreatedPanel(), '#note');
      // `exists`（既存/新規作成）はここでは見ない。ラベル・パスの並びだけが検証対象のため
      return (seenItems ?? []).map((i) => ({ label: i.candidate.label, path: i.candidate.path }));
    }

    it('entry.cwdがworkspaceFoldersに含まれない場合、その分の候補も追加される（worktreeタスク）', async () => {
      stubStart();
      const { manager } = createManager();

      const candidates = await captureCandidates(manager, '/workspace/worktree-1');

      const paths = candidates.map((c) => c.path);
      expect(paths).toContain('/workspace/root/CLAUDE.md');
      expect(paths).toContain('/workspace/worktree-1/CLAUDE.md');
    });

    it('workspaceFoldersが複数なら、フォルダごとに候補が出る（マルチルート）', async () => {
      stubStart();
      __mock.setWorkspaceFolders([
        { fsPath: '/workspace/a', name: 'a' },
        { fsPath: '/workspace/b', name: 'b' },
      ]);
      const { manager } = createManager();

      const candidates = await captureCandidates(manager, '/workspace/a');

      expect(candidates).toEqual(
        expect.arrayContaining([
          { label: 'プロジェクト（a）', path: '/workspace/a/CLAUDE.md' },
          { label: 'プロジェクト（b）', path: '/workspace/b/CLAUDE.md' },
          { label: 'ユーザー', path: '/fake/claude-home/CLAUDE.md' },
        ]),
      );
      expect(candidates).toHaveLength(3);
    });

    it('workspaceFoldersがundefined（フォルダ未オープン）でも、フォールバックの1件だけで候補が出る', async () => {
      stubStart();
      __mock.clearWorkspaceFolder();
      const { manager } = createManager();

      const candidates = await captureCandidates(manager, '/standalone/dir');

      expect(candidates).toEqual([
        { label: 'プロジェクト（dir）', path: '/standalone/dir/CLAUDE.md' },
        { label: 'ユーザー', path: '/fake/claude-home/CLAUDE.md' },
      ]);
    });
  });
});

/**
 * 他エージェント（Codex／Gemini）からの設定インポート（issue #200、design.md TP-88）。
 *
 * control protocolに構造化API（Codex側の`externalAgentConfig/detect`相当）が無いことを
 * 実測済み（`streamSession.ts`の`importConfig`参照）のため、拡張機能が保証できるのは
 * 「確認ダイアログで何を・どこから・どこへを明示してから`/import`を送る」ことと
 * 「取り消したら何も送らない」ことだけ。この2点をここで検証する。
 */
describe('ClaudeChatViewManagerの他エージェント設定インポート（issue #200）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  async function openPanel(manager: ClaudeChatViewManager): Promise<FakeWebviewPanel | undefined> {
    await manager.openNew('/workspace/root');
    return __mock.lastCreatedPanel();
  }

  it('確認ダイアログで対象（Codex/Gemini→Claude Code）を明示してから/importを送る', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    const panel = await openPanel(manager);
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    const written: string[] = [];
    (
      session as unknown as {
        proc: {
          killed: boolean;
          stdin: { write: (line: string) => void; destroyed: boolean; writable: boolean };
        };
      }
    ).proc = {
      killed: false,
      stdin: { write: (line) => written.push(line), destroyed: false, writable: true },
    };

    panel?.webview.simulateMessage({ type: 'claudeImport' });
    await flush();

    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('Codex');
    expect(__mock.messages.warnings[0]).toContain('Gemini');
    expect(__mock.messages.warnings[0]).toContain('Claude Code');
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/import' }] },
    });
  });

  it('確認ダイアログをキャンセルすると何も送らない', async () => {
    stubStart();
    const { manager } = createManager();
    const panel = await openPanel(manager);
    __mock.showWarningMessageAnswer = undefined;

    panel?.webview.simulateMessage({ type: 'claudeImport' });
    await flush();

    // キャンセル時はimportConfig()自体を呼ばないため、未起動セッションでもエラーにならない
    expect(__mock.messages.errors).toEqual([]);
  });
});
