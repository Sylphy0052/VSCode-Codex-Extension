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
import {
  buildClaudeChatPanelOptions,
  ClaudeChatViewManager,
  deriveTitle,
} from '../../src/view/claudeChatView';
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

/**
 * `getName` / `rename` はMapで実体化する（issue #199）。ただの no-op スタブだと
 * 「保存してから読み直す」往復を検証するテストが書けないため。
 */
function fakeStore(overrides?: Partial<ClaudeSessionStore>): ClaudeSessionStore {
  const names = new Map<string, string>();
  const store = {
    resolveTranscriptPath: async () => undefined,
    resolveCwd: async () => undefined,
    getName: (sessionId: string) => names.get(sessionId),
    rename: async (sessionId: string, name: string) => {
      names.set(sessionId, name);
    },
    ...overrides,
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
  store?: ClaudeSessionStore;
}): {
  manager: ClaudeChatViewManager;
  store: ClaudeSessionStore;
} {
  const store = options?.store ?? fakeStore();
  const manager = new ClaudeChatViewManager(
    () => 'claude',
    fakeFileSystem,
    fakeMentions(),
    '/fake/claude-home',
    store,
    fakeSettingsProvider(),
    fakeLogger,
    () => undefined,
    () => undefined,
    options?.isTaskManagedThread ?? (() => false),
    options?.memoryFs ?? fakeMemoryFileSystem(),
    options?.memoryMemento ?? fakeMemento(),
  );
  return { manager, store };
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
/** `can_use_tool`制御要求（issue #286の承認待ち通知テスト用）。 */
const canUseToolLine = (
  requestId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): string =>
  `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: toolName, input },
  })}\n`;

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

  describe('送信キー設定の配線（agent.chat.sendOn、issue #288）', () => {
    it('設定を読んでいなければ既定のctrlEnter扱いの文言のままになる', async () => {
      stubStart();
      const { manager } = createManager();

      await manager.openNew();

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      expect(html).toContain('SEND_ON = "ctrlEnter"');
      expect(html).toContain('Ctrl+Enterで送信');
    });

    it('agent.chat.sendOnをenterにするとwebview側の定数とプレースホルダに反映される', async () => {
      __mock.setConfig('agent', { 'chat.sendOn': 'enter' });
      stubStart();
      const { manager } = createManager();

      await manager.openNew();

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      expect(html).toContain('SEND_ON = "enter"');
      expect(html).toContain('Enterで送信、Shift+Enterで改行');
    });
  });

  describe('入力欄アイコン列の設定配線（agent.chat.composerButtons、issue #296）', () => {
    /**
     * ボタンidが「…」メニュー（`#composerOverflowMenu`）の中にあるか、表
     * （`#composerIconRow`直下）にあるかを、`<div id="composerOverflowMenu"`の
     * 開始タグより後に現れるかどうかで判別する（chatView.test.tsの同名ヘルパーと同じ判定）。
     */
    function isInOverflowMenu(html: string, id: string): boolean {
      const menuOpenIndex = html.indexOf('<div id="composerOverflowMenu"');
      const buttonIndex = html.indexOf(`id="${id}"`);
      if (menuOpenIndex < 0 || buttonIndex < 0) {
        throw new Error(`composerOverflowMenu または button#${id} が見つからない`);
      }
      return buttonIndex > menuOpenIndex;
    }

    it('設定を読んでいなければClaude Code側の実描画でも既定4つ（attach/loopToggle/compact/claudeImport）が表に残り、残り6つはメニューへ畳まれる', async () => {
      stubStart();
      const { manager } = createManager();

      await manager.openNew();

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      for (const id of ['attach', 'loopToggle', 'compact', 'claudeImport']) {
        expect(isInOverflowMenu(html, id), `${id} は表にあるはず`).toBe(false);
      }
      for (const id of ['recap', 'planToggle', 'fastToggle', 'review', 'exportTranscript', 'workflowMenu']) {
        expect(isInOverflowMenu(html, id), `${id} は「…」メニューにあるはず`).toBe(true);
      }
    });

    it('agent.chat.composerButtonsをreview/workflowMenuに絞るとClaude Code側の実描画にも反映される', async () => {
      __mock.setConfig('agent', { 'chat.composerButtons': ['review', 'workflowMenu'] });
      stubStart();
      const { manager } = createManager();

      await manager.openNew();

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      expect(isInOverflowMenu(html, 'review'), 'review は表にあるはず').toBe(false);
      expect(isInOverflowMenu(html, 'workflowMenu'), 'workflowMenu は表にあるはず').toBe(false);
      expect(isInOverflowMenu(html, 'attach'), 'attach は「…」メニューにあるはず').toBe(true);
      expect(isInOverflowMenu(html, 'claudeImport'), 'claudeImport は「…」メニューにあるはず').toBe(
        true,
      );
    });

    it('未知のIDを含む設定は既定へ丸められ、Claude Code側のロガーへ警告が出る', async () => {
      __mock.setConfig('agent', { 'chat.composerButtons': ['attach', 'nope'] });
      stubStart();
      const warnSpy = vi.spyOn(fakeLogger, 'warn');
      const { manager } = createManager();

      await manager.openNew();

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      for (const id of ['attach', 'loopToggle', 'compact', 'claudeImport']) {
        expect(isInOverflowMenu(html, id), `${id} は表にあるはず`).toBe(false);
      }
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nope'));

      warnSpy.mockRestore();
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

  describe('セッション全体のfork（issue #218、design.md §14.40）', () => {
    it('target.kind=forkでClaudeStreamSession.startを起動し、新しいidはCLIに任せる（sessionIdは渡さない）', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openFork('origin-session-id', '元の会話 (fork)', '/workspace/root');

      expect(calls).toHaveLength(1);
      expect(calls[0]?.target).toEqual({ kind: 'fork', sessionId: 'origin-session-id' });
      // --session-idで指定できるのは新規セッションだけ。forkの新しいidはCLIが振るため
      // ここへ値を渡すと矛盾した起動引数になる（argvBuilder.tsのtargetArgs参照）
      expect(calls[0]?.sessionId).toBeUndefined();
      expect(__mock.lastCreatedPanel()).toBeDefined();
    });

    it('黙って「復元されないタブ」を作らない。開いた直後に会話へ1行残す', async () => {
      const { sessions } = stubStartCapturing();
      const { manager } = createManager();

      await manager.openFork('origin-session-id', '元の会話 (fork)', '/workspace/root');

      const session = sessions[0];
      if (session === undefined) {
        throw new Error('セッションが記録されていません');
      }
      const items = session.getState().items;
      const notice = items.find((i) => i.id.startsWith('forkNotice:'));
      expect(notice).toBeDefined();
      expect(notice?.detail).toContain('復元');
      expect(notice?.detail).toContain('作業記録');
    });

    it('cwd省略時はワークスペースフォルダを使う', async () => {
      const calls = stubStart();
      const { manager } = createManager();

      await manager.openFork('origin-session-id', '元の会話 (fork)', undefined);

      expect(calls).toHaveLength(1);
      expect(__mock.lastCreatedPanel()).toBeDefined();
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
 * 会話の名前変更（issue #199）。
 *
 * 表示用の名前は拡張機能側（`ClaudeSessionStore`）を正として持つ設計のため、CLIの応答を
 * 待たずに `store.rename` → `session.setName` の順で即座に反映されることを確かめる
 * （`renameActive` のJSDoc参照）。`session.receive(initLine(...))` で `system init` を
 * 直接流し込み、`stubStart` で実プロセスを起こさずに `threadId` だけ確定させる
 * （既存の pauseLoop/resumeLoop テストと同じ手法）。
 */
describe('ClaudeChatViewManagerの名前変更（issue #199）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('名前変更は選択中の画面のタブ名と履歴一覧の名前解決に反映する', async () => {
    const { sessions } = stubStartCapturing();
    const store = fakeStore();
    const { manager } = createManager({ store });

    await manager.openNew('/workspace/root');
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-rename'));

    __mock.showInputBoxAnswer = '設計方針の相談';
    await manager.renameActive();

    // 拡張機能側のストアに保存され、次回以降の名前解決（getName）に反映される
    expect(store.getName('session-rename')).toBe('設計方針の相談');
    // タブ名も即座に追従する（`deriveTitle` が `state.name` を優先するため）。
    // `system init` 直後は`busy: true`（`streamJson.ts`）なので、実行中の印
    // （issue #286、design.md §14.55）が先頭に付く
    expect(__mock.lastCreatedPanel()?.title).toBe('* Claude Code: 設計方針の相談');
  });

  it('変更していない・空文字・キャンセルでは保存しない', async () => {
    const { sessions } = stubStartCapturing();
    const store = fakeStore();
    const { manager } = createManager({ store });

    await manager.openNew('/workspace/root');
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-cancel'));

    __mock.showInputBoxAnswer = undefined;
    await manager.renameActive();
    expect(store.getName('session-cancel')).toBeUndefined();

    __mock.showInputBoxAnswer = '   ';
    await manager.renameActive();
    expect(store.getName('session-cancel')).toBeUndefined();
  });

  it('アクティブな画面が無ければ案内を出すだけで何もしない', async () => {
    const { manager } = createManager();

    __mock.showInputBoxAnswer = '使われないはずの名前';
    await manager.renameActive();

    expect(__mock.messages.infos).toHaveLength(1);
  });
});

describe('ClaudeChatViewManagerの会話クリア（CLIの /clear 相当）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('いまの会話を閉じて、同じ作業フォルダで新しい会話を開き直す', async () => {
    const { calls, sessions } = stubStartCapturing();
    const { manager } = createManager();

    await manager.openNew('/workspace/root/sub');
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-old'));
    const oldPanel = __mock.lastCreatedPanel();

    await manager.clearActive();

    expect(oldPanel?.disposed).toBe(true);
    expect(calls).toHaveLength(2);
    // 作業フォルダは引き継ぐ。新しいセッションとして開き直す
    expect(calls[1]?.cwd).toBe('/workspace/root/sub');
    expect(calls[1]?.target).toEqual({ kind: 'new' });
    expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId);
  });

  it('アクティブな画面が無ければ案内を出すだけで何もしない', async () => {
    const { calls } = stubStartCapturing();
    const { manager } = createManager();

    await manager.clearActive();

    expect(__mock.messages.infos).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe('エディタの選択範囲の送り先（getActiveComposerTarget、issue #292）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('開いているタブが無ければundefined', () => {
    const { manager } = createManager();
    expect(manager.getActiveComposerTarget()).toBeUndefined();
  });

  it('選択中の画面の入力欄へテキストを挿し込み、そのタブを表に出す', async () => {
    stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');

    const target = manager.getActiveComposerTarget();
    expect(target).toBeDefined();

    const panel = __mock.lastCreatedPanel();
    const revealCountBefore = panel?.revealCount ?? 0;

    target?.insert('src/foo.ts:1-1\nconst x = 1;');

    expect(panel?.webview.sent).toContainEqual({
      type: 'insertComposerText',
      text: 'src/foo.ts:1-1\nconst x = 1;',
    });
    expect(panel?.revealCount).toBe(revealCountBefore + 1);
    expect(panel?.active).toBe(true);
  });

  it('activeSequenceは後からアクティブになったタブの方が大きい（Codex側との横断比較に使う）', async () => {
    stubStartCapturing();
    const { manager } = createManager();

    await manager.openNew('/workspace/root/a');
    const first = manager.getActiveComposerTarget();

    await manager.openNew('/workspace/root/b');
    const second = manager.getActiveComposerTarget();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.activeSequence).toBeGreaterThan(first?.activeSequence as number);
  });
});

describe('deriveTitle（issue #199の名前解決順）', () => {
  const baseState = (
    overrides: Partial<Parameters<typeof deriveTitle>[0]> = {},
  ): Parameters<typeof deriveTitle>[0] =>
    ({
      items: [],
      name: undefined,
      ...overrides,
    }) as Parameters<typeof deriveTitle>[0];

  it('人が付けた名前があれば最優先で使う', () => {
    const state = baseState({
      name: '人が付けた名前',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state)).toBe('Claude Code: 人が付けた名前');
  });

  it('人が付けた名前が無ければ最初の発言から作る', () => {
    const state = baseState({
      items: [{ kind: 'userMessage', id: '1', text: '設計を見直したい' } as never],
    });
    expect(deriveTitle(state)).toBe('Claude Code: 設計を見直したい');
  });

  it('どちらも無ければ undefined（タブ名は前の値のまま）', () => {
    expect(deriveTitle(baseState())).toBeUndefined();
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

/**
 * 追加クレジット（usage credits）の要求（issue #204、design.md §14.38）。
 *
 * `/usage-credits`は「管理者への要求」を伴いうるためimportConfigと同じく確認ダイアログを
 * 挟む（`streamSession.ts`の`requestUsageCredits`のJSDoc参照）。ここでは「確認してから
 * 送る」ことと「取り消したら何も送らない」ことを検証する。
 */
describe('ClaudeChatViewManagerの追加クレジット要求（issue #204）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  async function openPanel(manager: ClaudeChatViewManager): Promise<FakeWebviewPanel | undefined> {
    await manager.openNew('/workspace/root');
    return __mock.lastCreatedPanel();
  }

  it('確認ダイアログを経てから/usage-creditsを送る', async () => {
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

    panel?.webview.simulateMessage({ type: 'usageCreditsRequest' });
    await flush();

    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('usage-credits');
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/usage-credits' }] },
    });
  });

  it('確認ダイアログをキャンセルすると何も送らない', async () => {
    stubStart();
    const { manager } = createManager();
    const panel = await openPanel(manager);
    __mock.showWarningMessageAnswer = undefined;

    panel?.webview.simulateMessage({ type: 'usageCreditsRequest' });
    await flush();

    // キャンセル時はrequestUsageCredits()自体を呼ばないため、未起動セッションでもエラーにならない
    expect(__mock.messages.errors).toEqual([]);
  });
});

/**
 * CLI側のデバッグログを開く（issue #205、design.md §14.39）。
 *
 * `openDebugLog`はCLIへは何も送らないため確認ダイアログを挟まず、`debugLogCandidates`
 * （このセッション専用のログ→`latest`の順）を順に開けるか試す。開けたら会話に1行残し、
 * 全滅したら案内だけ出す（会話には何も残さない）。
 */
describe('ClaudeChatViewManagerのデバッグログを開く（issue #205）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('このセッション専用のログが開ければそれを開き、会話に記録を残す', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-abc'));
    __mock.setExistingTextDocumentPaths(['/fake/claude-home/debug/session-abc.txt']);

    panel?.webview.simulateMessage({ type: 'openDebugLog' });
    await flush();

    expect(__mock.openedTextDocumentPaths).toEqual(['/fake/claude-home/debug/session-abc.txt']);
    const items = session.getState().items;
    const last = items[items.length - 1];
    expect(last?.detail).toContain('/fake/claude-home/debug/session-abc.txt');
    expect(__mock.messages.infos).toEqual([]);
  });

  it('セッション専用のログが無ければlatestへフォールバックする', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-abc'));
    // session-abc.txtは無く、latestだけ存在する状態を再現する
    __mock.setExistingTextDocumentPaths(['/fake/claude-home/debug/latest']);

    panel?.webview.simulateMessage({ type: 'openDebugLog' });
    await flush();

    expect(__mock.openedTextDocumentPaths).toEqual(['/fake/claude-home/debug/latest']);
  });

  it('候補が全部無ければ案内を出し、会話には何も残さない', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    const itemsBefore = session.getState().items.length;

    panel?.webview.simulateMessage({ type: 'openDebugLog' });
    await flush();

    expect(__mock.openedTextDocumentPaths).toEqual([]);
    expect(__mock.messages.infos).toHaveLength(1);
    expect(session.getState().items.length).toBe(itemsBefore);
  });
});

/**
 * `/debug`の送信（issue #205、design.md §14.39）。
 *
 * `/usage-credits`と同じく実モデルが動き課金・ツール実行（承認カード）を伴いうるため、
 * `confirmDebugCommand`で必ず確認してから送る。
 */
describe('ClaudeChatViewManagerの/debug送信（issue #205）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('確認ダイアログを経てから/debugを送る', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
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

    panel?.webview.simulateMessage({ type: 'debugCommand' });
    await flush();

    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('/debug');
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/debug' }] },
    });
  });

  it('確認ダイアログをキャンセルすると何も送らない', async () => {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    __mock.showWarningMessageAnswer = undefined;

    panel?.webview.simulateMessage({ type: 'debugCommand' });
    await flush();

    // キャンセル時はsendDebugCommand()自体を呼ばないため、未起動セッションでもエラーにならない
    expect(__mock.messages.errors).toEqual([]);
  });
});

/**
 * 会話の1行要約（issue #203、design.md §14.36）。
 *
 * compact/importConfigと違って会話を壊したり書き込みが起きたりしないため、確認ダイアログを
 * 挟まず、Webviewから届いた `recap` メッセージをそのまま `/recap` の発言送信へつなぐだけで
 * よい（`streamSession.ts` の `recap` のJSDoc参照）。ここでは「確認なしで即座に送る」ことを
 * 検証する。
 */
describe('ClaudeChatViewManagerの会話要約（issue #203）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  it('確認なしで/recapを送る', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
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

    panel?.webview.simulateMessage({ type: 'recap' });
    await flush();

    expect(__mock.messages.warnings).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/recap' }] },
    });
  });

  it('セッションが起動していなければエラーとして報告する', async () => {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();

    panel?.webview.simulateMessage({ type: 'recap' });
    await flush();

    expect(__mock.messages.errors).toHaveLength(1);
  });
});

/**
 * 自動圧縮の窓サイズ（issue #201、design.md §14.37）。
 *
 * recapと同じく壊れる操作ではないため確認ダイアログを挟まず、Webviewから届いた
 * `autocompactWindow` メッセージをそのまま `setAutocompactWindow` へつなぐだけでよい
 * （`streamSession.ts` の `setAutocompactWindow` のJSDoc参照）。
 */
describe('ClaudeChatViewManagerの自動圧縮窓サイズ設定（issue #201）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
  });

  function attachFakeProc(session: ClaudeStreamSession): string[] {
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
    return written;
  }

  it('確認なしで空文字を問い合わせとして/autocompactを送る', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    const written = attachFakeProc(session);

    panel?.webview.simulateMessage({ type: 'autocompactWindow', window: '' });
    await flush();

    expect(__mock.messages.warnings).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact' }] },
    });
  });

  it('値を渡すと/autocompact <値>を送る', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    const session = sessions[0];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    const written = attachFakeProc(session);

    panel?.webview.simulateMessage({ type: 'autocompactWindow', window: '300000' });
    await flush();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact 300000' }] },
    });
  });

  it('セッションが起動していなければエラーとして報告する', async () => {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();

    panel?.webview.simulateMessage({ type: 'autocompactWindow', window: 'auto' });
    await flush();

    expect(__mock.messages.errors).toHaveLength(1);
  });
});

describe('ワークフローの導線（issue #250）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('claude', {});
  });

  it('ワークフローボタンを押すとagent.workflows.menuを実行する', async () => {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();

    panel?.webview.simulateMessage({ type: 'workflowMenu' });
    await flush();

    expect(__mock.executedCommands).toContain('agent.workflows.menu');
  });

  it('セッションが起動していなくてもエラーにしない（会話と独立した操作のため）', async () => {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();

    panel?.webview.simulateMessage({ type: 'workflowMenu' });
    await flush();

    expect(__mock.messages.errors).toHaveLength(0);
  });
});

describe('タブ名の状態表示・通知（issue #286、design.md §14.55）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('agent', {});
    vi.restoreAllMocks();
  });

  it('承認待ちはタブ名の先頭に ! が付く', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();

    const task = await manager.openTaskSession({
      cwd: '/workspace/root/task-a',
      config: EMPTY_TASK_CONFIG,
      sandbox: '',
    });
    task.open({ preserveFocus: true });
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }

    session.receive(canUseToolLine('req-1', 'Bash', { command: 'ls' }));
    await flush();

    expect(__mock.lastCreatedPanel()?.title).toBe('! Claude Code');
  });

  async function openHiddenTaskPanel(): Promise<{
    session: ClaudeStreamSession;
    task: Awaited<ReturnType<ClaudeChatViewManager['openTaskSession']>>;
  }> {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();

    const task = await manager.openTaskSession({
      cwd: '/workspace/root/task-a',
      config: EMPTY_TASK_CONFIG,
      sandbox: '',
    });
    task.open({ preserveFocus: true });
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    // 既定では作られた直後のパネルは`visible: true`。「背面タブ」を模すため
    // 明示的に見えない状態へ切り替える
    __mock.lastCreatedPanel()?.simulateVisibilityChange(false);
    return { session, task };
  }

  it('非表示のタブで承認待ちになった直後に通知が1回出て、開くでタブを表示する', async () => {
    const { session } = await openHiddenTaskPanel();

    session.receive(canUseToolLine('req-1', 'Bash', { command: 'ls' }));
    await flush();

    expect(__mock.messages.infos).toHaveLength(1);
    expect(__mock.messages.infos[0]).toContain('コマンドの実行を許可しますか');

    // 既定（AUTO_CONFIRM）は通知の最初のボタン（「開く」）を選んだ扱いになる
    await flush();
    expect(__mock.lastCreatedPanel()?.revealCount).toBeGreaterThan(0);
  });

  it('タブが見えている間は通知を出さない', async () => {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    const task = await manager.openTaskSession({
      cwd: '/workspace/root/task-a',
      config: EMPTY_TASK_CONFIG,
      sandbox: '',
    });
    task.open({ preserveFocus: true });
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    // simulateVisibilityChangeを呼ばないため visible: true のまま

    session.receive(canUseToolLine('req-1', 'Bash', { command: 'ls' }));
    await flush();

    expect(__mock.messages.infos).toHaveLength(0);
  });

  it('同じ承認要求では通知が重複しない（後続の状態更新でも1回のまま）', async () => {
    const { session, task } = await openHiddenTaskPanel();

    session.receive(canUseToolLine('req-1', 'Bash', { command: 'ls' }));
    await flush();
    expect(__mock.messages.infos).toHaveLength(1);

    // 同じ承認要求が保留のまま、無関係な状態更新（レート制限の通知）が続いても
    // 通知は増えない（`state.approvals`自体は変わらない）
    const rateLimitLine = `${JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
    })}\n`;
    session.receive(rateLimitLine);
    session.receive(rateLimitLine);
    expect(__mock.messages.infos).toHaveLength(1);

    task.decideApproval('req-1', 'accept');
  });

  it('設定 agent.notifications.approvalPending を false にすると承認待ちの通知を出さない', async () => {
    __mock.setConfig('agent', { 'notifications.approvalPending': false });
    const { session } = await openHiddenTaskPanel();

    session.receive(canUseToolLine('req-1', 'Bash', { command: 'ls' }));
    await flush();

    expect(__mock.messages.infos).toHaveLength(0);
  });

  it('ターン完了の通知は既定オフ（非表示タブでも出ない）', async () => {
    const { session } = await openHiddenTaskPanel();

    session.receive(initLine('session-turn'));
    session.receive(resultLine());

    expect(__mock.messages.infos).toHaveLength(0);
  });

  it('設定 agent.notifications.turnComplete を true にすると非表示タブでターン完了の通知が出る', async () => {
    __mock.setConfig('agent', { 'notifications.turnComplete': true });
    const { session } = await openHiddenTaskPanel();

    session.receive(initLine('session-turn'));
    session.receive(resultLine());

    expect(__mock.messages.infos).toHaveLength(1);
    expect(__mock.messages.infos[0]).toContain('応答が終わりました');
  });
});

describe('buildClaudeChatPanelOptions（Ctrl+Fの検索窓、issue #287、design.md §14.48）', () => {
  it('enableFindWidgetをtrueにし、既存のenableScripts/retainContextWhenHiddenを保つ', () => {
    expect(buildClaudeChatPanelOptions()).toEqual({
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
    });
  });
});

/**
 * Claude CodeのEditツール由来の `editReplace`（issue #310）を見るのはホスト側の復元処理
 * だけで、webviewは描画に一切使わない。表示用の `diff` と違い `MAX_DIFF_LINES` の切り詰めが
 * 掛からないため、送信内容からは落とす（issue #320）。
 *
 * `editReplace` を作るのはClaude Codeの会話項目だけなので（`src/claude/transcript.ts`）、
 * 落とし忘れが実害になるのはこの画面の送信経路。
 */
describe('webviewへ送る項目からeditReplaceを落とす（issue #320）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('agent', {});
    vi.restoreAllMocks();
  });

  const editToolLine = (): string =>
    `${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-320',
        content: [
          {
            type: 'tool_use',
            id: 'tool-320',
            name: 'Edit',
            input: {
              file_path: '/workspace/root/a.ts',
              old_string: 'const a = 1;',
              new_string: 'const a = 10;',
            },
          },
        ],
      },
    })}\n`;

  /** 直近に送った `state` メッセージの会話項目。 */
  function lastSentItems(): { diffs?: { diff?: string; editReplace?: unknown }[] }[] {
    const sent = __mock.lastCreatedPanel()?.webview.sent ?? [];
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const message = sent[i] as { type?: string; state?: { items?: unknown } } | undefined;
      if (message?.type === 'state' && Array.isArray(message.state?.items)) {
        return message.state.items as { diffs?: { diff?: string; editReplace?: unknown }[] }[];
      }
    }
    throw new Error('state メッセージが送られていません');
  }

  async function openWithEdit(): Promise<ClaudeStreamSession> {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();

    await manager.openNew('/workspace/root');
    const session = sessions[sessions.length - 1];
    if (session === undefined) {
      throw new Error('セッションが記録されていません');
    }
    session.receive(initLine('session-320'));
    session.receive(editToolLine());
    await flush();
    return session;
  }

  it('Edit由来の差分にeditReplaceを載せない', async () => {
    await openWithEdit();

    const diffs = lastSentItems().flatMap((item) => item.diffs ?? []);
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) {
      expect(diff.editReplace).toBeUndefined();
    }
  });

  it('表示用の差分本文は残す', async () => {
    await openWithEdit();

    const diffs = lastSentItems().flatMap((item) => item.diffs ?? []);
    expect(diffs[0]?.diff).toBe('-const a = 1;\n+const a = 10;');
  });

  it('ホスト側の状態は書き換えない（復元はeditReplaceを使い続ける）', async () => {
    const session = await openWithEdit();

    const diffs = session.getState().items.flatMap((item) => item.diffs);
    expect(diffs[0]?.editReplace).toEqual({
      oldString: 'const a = 1;',
      newString: 'const a = 10;',
    });
  });
});
