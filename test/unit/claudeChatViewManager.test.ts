import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_MEMORY_TARGET_KEY, type MemoryFilePort } from '../../src/claude/memoryTargets';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import { MESSAGING_MCP_SERVER_NAME } from '../../src/orchestrator/messaging';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import type { McpServerView } from '../../src/provider/mcpServers';
import type { ShellCommandRunner } from '../../src/process/shellCommandRunner';
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

/** テストからは触らない口の既定fake。呼ばれたら失敗させて、意図せぬ利用に気づけるようにする。 */
function unusedBashRunner(): ShellCommandRunner {
  return {
    run: async () => {
      throw new Error('bashRunner.runが呼ばれるはずのないテストで呼ばれました');
    },
  };
}

function unusedMemoryFiles(): MemoryFilePort {
  return {
    exists: async () => false,
    readTextFile: async () => undefined,
    writeTextFile: async () => {
      throw new Error('memoryFiles.writeTextFileが呼ばれるはずのないテストで呼ばれました');
    },
    resolveSymlinkTarget: async () => undefined,
  };
}

interface CreateManagerOptions {
  isTaskManagedThread?: (sessionId: string) => boolean;
  bashRunner?: ShellCommandRunner;
  memoryFiles?: MemoryFilePort;
  memento?: {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Promise<void>;
  };
}

function createManager(options?: CreateManagerOptions): {
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
    options?.bashRunner ?? unusedBashRunner(),
    options?.memoryFiles ?? unusedMemoryFiles(),
    options?.memento,
  );
  return { manager };
}

/**
 * `void this.runBashMode(...)` / `void this.runMemoryAppend(...)`（fire-and-forget）の
 * 完了を待つ。マクロタスク（`setTimeout`）を複数回はさみ、内部の複数の `await`
 * （ファイルI/O・QuickPick・確認ダイアログ等）が進み切るのを確実にする。
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 最後にwebviewへ送られた `state` メッセージの `items` を取り出す。 */
function lastPostedItems(panel: FakeWebviewPanel): unknown[] {
  const sent = panel.webview.sent as Array<{ type: string; state?: { items?: unknown[] } }>;
  for (let i = sent.length - 1; i >= 0; i--) {
    const message = sent[i];
    if (message?.type === 'state' && message.state?.items !== undefined) {
      return message.state.items;
    }
  }
  return [];
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
        {
          name: MESSAGING_MCP_SERVER_NAME,
          state: 'connected',
          toolCount: 2,
          version: '1',
          reason: undefined,
        },
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

  describe('入力欄の判定の統合（design.md §14.25）', () => {
    it('空のbash/メモリ入力はCLIへ送らず、会話にも項目を残さない', async () => {
      const calls = stubStart();
      const { manager } = createManager();
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      const sendOrQueueSpy = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');

      panel.webview.simulateMessage({ type: 'send', text: '!   ' });
      await flushAsync();
      panel.webview.simulateMessage({ type: 'send', text: '#' });
      await flushAsync();

      expect(sendOrQueueSpy).not.toHaveBeenCalled();
      expect(lastPostedItems(panel)).toHaveLength(0);
      expect(calls).toHaveLength(1);
    });

    it('`\\!` / `\\#` はエスケープ。先頭のバックスラッシュだけ外した通常のメッセージとしてCLIへ送る', async () => {
      stubStart();
      const { manager } = createManager();
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      const sendOrQueueSpy = vi
        .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
        .mockImplementation(() => 'sent');

      panel.webview.simulateMessage({ type: 'send', text: '\\!echo hi' });
      await flushAsync();

      expect(sendOrQueueSpy).toHaveBeenCalledWith('!echo hi', []);
    });

    it(
      '`!` / `#` は添付ファイルを消費せず、次の通常の発言へ持ち越す' +
        '（design.md §14.25。`entry.attachments.take()`は`dispatch()`からしか呼ばれない）',
      async () => {
        stubStart();
        const { manager } = createManager();
        await manager.openNew('/workspace/root');
        const panel = __mock.lastCreatedPanel();
        if (panel === undefined) throw new Error('panel not created');
        const sendOrQueueSpy = vi
          .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
          .mockImplementation(() => 'sent');

        panel.webview.simulateMessage({
          type: 'attach',
          name: 'a.png',
          dataUrl: `data:image/png;base64,${Buffer.from('x').toString('base64')}`,
        });
        // bashモードは既定で無効。それでも添付は消費されないことを確かめる
        panel.webview.simulateMessage({ type: 'send', text: '!echo hi' });
        await flushAsync();

        const sent = panel.webview.sent as Array<{
          type: string;
          state?: { attachments?: unknown[] };
        }>;
        const lastState = [...sent].reverse().find((m) => m.type === 'state' && m.state);
        expect(lastState?.state?.attachments).toHaveLength(1);

        // 続く通常の発言に、持ち越された添付が一緒に送られる
        panel.webview.simulateMessage({ type: 'send', text: '通常の発言' });
        await flushAsync();
        expect(sendOrQueueSpy).toHaveBeenCalledWith(
          '通常の発言',
          expect.arrayContaining([expect.objectContaining({ name: 'a.png' })]),
        );
      },
    );
  });

  describe('bashモード（`!`。design.md §14.25、Issue #5）', () => {
    it('claude.bashMode.enabledが既定(false)のときは実行せず、無効である旨の項目を残す', async () => {
      stubStart();
      const runSpy = vi.fn();
      const { manager } = createManager({ bashRunner: { run: runSpy } });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');

      panel.webview.simulateMessage({ type: 'send', text: '!echo hi' });
      await flushAsync();

      expect(runSpy).not.toHaveBeenCalled();
      const items = lastPostedItems(panel) as Array<{ kind: string; detail: string }>;
      expect(
        items.some(
          (i) => i.kind === 'settingsChanged' && i.detail.includes('claude.bashMode.enabled'),
        ),
      ).toBe(true);
    });

    it('無効時の通知で「設定を開く」を選ぶと設定画面を開くコマンドが呼ばれる', async () => {
      stubStart();
      const { manager } = createManager();
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('設定を開く');

      panel.webview.simulateMessage({ type: 'send', text: '!echo hi' });
      await flushAsync();

      expect(__mock.executedCommands).toContainEqual({
        command: 'workbench.action.openSettings',
        args: ['claude.bashMode.enabled'],
      });
    });

    it('有効時、確認をキャンセルすると実行されない', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      const runSpy = vi.fn();
      const { manager } = createManager({ bashRunner: { run: runSpy } });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer(undefined);

      panel.webview.simulateMessage({ type: 'send', text: '!echo hi' });
      await flushAsync();

      expect(runSpy).not.toHaveBeenCalled();
      expect(lastPostedItems(panel)).toHaveLength(0);
    });

    it('有効時、確認を承認すると実行され、成功時はstdoutと終了コードが会話に出る', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      const { manager } = createManager({
        bashRunner: {
          run: async () => ({
            stdout: 'hello\n',
            stderr: '',
            code: 0,
            timedOut: false,
            aborted: false,
            spawnError: undefined,
            truncated: false,
          }),
        },
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('実行する');

      panel.webview.simulateMessage({ type: 'send', text: '!echo hello' });
      await flushAsync();

      const items = lastPostedItems(panel) as Array<{
        kind: string;
        text: string;
        status: string | undefined;
        detail: string;
      }>;
      const commandItem = items.find(
        (i) => i.kind === 'commandExecution' && i.detail === 'echo hello',
      );
      expect(commandItem?.text).toBe('hello\n');
      expect(commandItem?.status).toBe('exit 0');
    });

    it('非ゼロ終了・タイムアウト・起動失敗は理由が会話から分かる', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      const { manager } = createManager({
        bashRunner: {
          run: async () => ({
            stdout: '',
            stderr: 'boom',
            code: 1,
            timedOut: false,
            aborted: false,
            spawnError: undefined,
            truncated: false,
          }),
        },
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('実行する');

      panel.webview.simulateMessage({ type: 'send', text: '!false' });
      await flushAsync();

      const items = lastPostedItems(panel) as Array<{
        kind: string;
        text: string;
        status: string | undefined;
      }>;
      const commandItem = items.find((i) => i.kind === 'commandExecution');
      expect(commandItem?.status).toBe('exit 1');
      expect(commandItem?.text).toContain('boom');
    });

    it('出力が上限を超えたら切り詰められ、会話にもtruncatedが反映される', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      const { manager } = createManager({
        bashRunner: {
          run: async () => ({
            stdout: 'x'.repeat(10),
            stderr: '',
            code: 0,
            timedOut: false,
            aborted: false,
            spawnError: undefined,
            truncated: true,
          }),
        },
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('実行する');

      panel.webview.simulateMessage({ type: 'send', text: '!yes' });
      await flushAsync();

      const items = lastPostedItems(panel) as Array<{ kind: string; truncated?: boolean }>;
      const commandItem = items.find((i) => i.kind === 'commandExecution');
      expect(commandItem?.truncated).toBe(true);
    });

    it(
      'ランナー自体が想定外の例外を投げても、実行中項目が畳まれエラーが通知される' +
        '（レビュー指摘: fire-and-forgetでエラーが握り潰される）',
      async () => {
        stubStart();
        __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
        const { manager } = createManager({
          bashRunner: {
            run: async () => {
              throw new Error('想定外の異常');
            },
          },
        });
        await manager.openNew('/workspace/root');
        const panel = __mock.lastCreatedPanel();
        if (panel === undefined) throw new Error('panel not created');
        __mock.setShowWarningMessageAnswer('実行する');

        panel.webview.simulateMessage({ type: 'send', text: '!echo hi' });
        await flushAsync();

        // ユーザーへ見せる（fire-and-forgetのまま握り潰されない）
        expect(__mock.messages.errors.some((m) => m.includes('想定外の異常'))).toBe(true);
        // 「実行中」項目が残らず、失敗として畳まれている
        const items = lastPostedItems(panel) as Array<{ kind: string; status?: string }>;
        const commandItem = items.find((i) => i.kind === 'commandExecution');
        expect(commandItem?.status).not.toBe('running');
        expect(commandItem?.status).toBe('失敗');
      },
    );

    it('タブを閉じると実行中のbashコマンドが中断される（Issue #5レビュー指摘）', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      let capturedSignal: AbortSignal | undefined;
      const { manager } = createManager({
        bashRunner: {
          run: (_command, _cwd, _timeoutMs, signal) => {
            capturedSignal = signal;
            return new Promise(() => undefined); // 完了させない。中断だけを見る
          },
        },
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('実行する');

      panel.webview.simulateMessage({ type: 'send', text: '!sleep 100' });
      await flushAsync();

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      panel.dispose(); // タブを閉じる → teardown()

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('manager.dispose()すると実行中の全パネルのbashコマンドが中断される', async () => {
      stubStart();
      __mock.setConfig('claude', { bashMode: { enabled: true, timeoutMs: 5000 } });
      let capturedSignal: AbortSignal | undefined;
      const { manager } = createManager({
        bashRunner: {
          run: (_command, _cwd, _timeoutMs, signal) => {
            capturedSignal = signal;
            return new Promise(() => undefined);
          },
        },
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.setShowWarningMessageAnswer('実行する');

      panel.webview.simulateMessage({ type: 'send', text: '!sleep 100' });
      await flushAsync();
      expect(capturedSignal?.aborted).toBe(false);

      manager.dispose();

      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('メモリモード（`#`。design.md §14.25、Issue #6）', () => {
    const WORKSPACE_MEMORY_PATH = '/workspace/root/CLAUDE.md';
    const USER_MEMORY_PATH = '/config/CLAUDE.md';

    function fakeMemento(): {
      get<T>(key: string, defaultValue: T): T;
      update(key: string, value: unknown): Promise<void>;
      store: Record<string, unknown>;
    } {
      const store: Record<string, unknown> = {};
      return {
        get: <T>(key: string, defaultValue: T): T =>
          key in store ? (store[key] as T) : defaultValue,
        update: async (key: string, value: unknown) => {
          store[key] = value;
        },
        store,
      };
    }

    function recordingMemoryFiles(
      writes: { filePath: string; content: string }[],
      overrides: Partial<MemoryFilePort> = {},
    ): MemoryFilePort {
      return {
        exists: async () => false,
        readTextFile: async () => undefined,
        writeTextFile: async (filePath, content) => {
          writes.push({ filePath, content });
        },
        resolveSymlinkTarget: async () => undefined,
        ...overrides,
      };
    }

    it('QuickPickをキャンセルすると何も書き込まない', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const writes: { filePath: string; content: string }[] = [];
      const { manager } = createManager({ memoryFiles: recordingMemoryFiles(writes) });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.showQuickPickAnswerIndex = undefined;

      panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
      await flushAsync();

      expect(writes).toHaveLength(0);
    });

    it('確認をキャンセルすると何も書き込まない', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const writes: { filePath: string; content: string }[] = [];
      const { manager } = createManager({ memoryFiles: recordingMemoryFiles(writes) });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.showQuickPickAnswerIndex = 0;
      __mock.setShowWarningMessageAnswer(undefined);

      panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
      await flushAsync();

      expect(writes).toHaveLength(0);
    });

    it('確認を承認すると、選んだ候補へ追記し、会話にもファイル・本文が残る', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const writes: { filePath: string; content: string }[] = [];
      const { manager } = createManager({ memoryFiles: recordingMemoryFiles(writes) });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.showQuickPickAnswerIndex = 0; // workspaceFolder直下のCLAUDE.md
      __mock.setShowWarningMessageAnswer('追記する');

      panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
      await flushAsync();

      expect(writes).toEqual([{ filePath: WORKSPACE_MEMORY_PATH, content: '- 次はこれを試す\n' }]);
      const items = lastPostedItems(panel) as Array<{ kind: string; text: string; detail: string }>;
      const memoryItem = items.find((i) => i.kind === 'memoryAppend');
      expect(memoryItem?.text).toBe('次はこれを試す');
      expect(memoryItem?.detail).toBe(WORKSPACE_MEMORY_PATH);
    });

    it('前回選んだ追記先をmementoへ覚え、次回の候補の先頭に並ぶ', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const writes: { filePath: string; content: string }[] = [];
      const memento = fakeMemento();
      const { manager } = createManager({ memoryFiles: recordingMemoryFiles(writes), memento });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');

      // 1回目: 一覧2番目（ユーザーメモリ、index 1）を選ぶ
      __mock.showQuickPickAnswerIndex = 1;
      __mock.setShowWarningMessageAnswer('追記する');
      panel.webview.simulateMessage({ type: 'send', text: '#1回目のメモ' });
      await flushAsync();
      expect(writes[0]?.filePath).toBe(USER_MEMORY_PATH);
      expect(memento.store[LAST_MEMORY_TARGET_KEY]).toBe(USER_MEMORY_PATH);

      // 2回目: 先頭（index 0）を選ぶと、前回選んだユーザーメモリが先頭に来ているはず
      __mock.showQuickPickAnswerIndex = 0;
      panel.webview.simulateMessage({ type: 'send', text: '#2回目のメモ' });
      await flushAsync();
      expect(writes[1]?.filePath).toBe(USER_MEMORY_PATH);
    });

    it('複数行のノートは追記ファイルで2行目以降がインデントされる', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const writes: { filePath: string; content: string }[] = [];
      const { manager } = createManager({ memoryFiles: recordingMemoryFiles(writes) });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.showQuickPickAnswerIndex = 0;
      __mock.setShowWarningMessageAnswer('追記する');

      panel.webview.simulateMessage({ type: 'send', text: '#見出し\n詳細1\n詳細2' });
      await flushAsync();

      expect(writes[0]?.content).toBe('- 見出し\n  詳細1\n  詳細2\n');
    });

    it(
      '選んだ候補がシンボリックリンクなら、確認ダイアログと会話の記録にリンク先の実パスが出る' +
        '（レビュー指摘: シンボリックリンク追従で書き込み先が別ファイルへすり替わる）',
      async () => {
        stubStart();
        __mock.setConfig('claude', { configDir: '/config' });
        const writes: { filePath: string; content: string }[] = [];
        const realPath = '/real/CLAUDE.md';
        const { manager } = createManager({
          memoryFiles: recordingMemoryFiles(writes, {
            resolveSymlinkTarget: async (filePath) =>
              filePath === WORKSPACE_MEMORY_PATH ? realPath : undefined,
          }),
        });
        await manager.openNew('/workspace/root');
        const panel = __mock.lastCreatedPanel();
        if (panel === undefined) throw new Error('panel not created');
        __mock.showQuickPickAnswerIndex = 0;
        __mock.setShowWarningMessageAnswer('追記する');

        panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
        await flushAsync();

        // 中止はせず、実パスを見せた上で書き込みは実行される
        expect(writes).toEqual([{ filePath: WORKSPACE_MEMORY_PATH, content: '- 次はこれを試す\n' }]);
        expect(__mock.messages.warnings.some((m) => m.includes(`リンク先: ${realPath}`))).toBe(
          true,
        );
        const items = lastPostedItems(panel) as Array<{ kind: string; detail: string }>;
        const memoryItem = items.find((i) => i.kind === 'memoryAppend');
        expect(memoryItem?.detail).toContain(realPath);
      },
    );

    it(
      'readTextFileが例外を投げると、書き込まずエラーを通知する' +
        '（レビュー指摘: fire-and-forgetでエラーが握り潰される／既存メモリファイルの内容破壊）',
      async () => {
        stubStart();
        __mock.setConfig('claude', { configDir: '/config' });
        const writes: { filePath: string; content: string }[] = [];
        const { manager } = createManager({
          memoryFiles: recordingMemoryFiles(writes, {
            readTextFile: async () => {
              throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            },
          }),
        });
        await manager.openNew('/workspace/root');
        const panel = __mock.lastCreatedPanel();
        if (panel === undefined) throw new Error('panel not created');
        __mock.showQuickPickAnswerIndex = 0;
        __mock.setShowWarningMessageAnswer('追記する');

        panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
        await flushAsync();

        expect(writes).toHaveLength(0);
        expect(__mock.messages.errors.some((m) => m.includes('EACCES'))).toBe(true);
        const items = lastPostedItems(panel) as Array<{ kind: string }>;
        expect(items.some((i) => i.kind === 'memoryAppend')).toBe(false);
      },
    );

    it('writeTextFileが失敗すると、エラーを通知する（fire-and-forgetでエラーが握り潰されない）', async () => {
      stubStart();
      __mock.setConfig('claude', { configDir: '/config' });
      const { manager } = createManager({
        memoryFiles: recordingMemoryFiles([], {
          writeTextFile: async () => {
            throw new Error('ディスクがいっぱいです');
          },
        }),
      });
      await manager.openNew('/workspace/root');
      const panel = __mock.lastCreatedPanel();
      if (panel === undefined) throw new Error('panel not created');
      __mock.showQuickPickAnswerIndex = 0;
      __mock.setShowWarningMessageAnswer('追記する');

      panel.webview.simulateMessage({ type: 'send', text: '#次はこれを試す' });
      await flushAsync();

      expect(__mock.messages.errors.some((m) => m.includes('ディスクがいっぱいです'))).toBe(true);
      const items = lastPostedItems(panel) as Array<{ kind: string }>;
      expect(items.some((i) => i.kind === 'memoryAppend')).toBe(false);
    });
  });
});
