import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager, type ChatActivity } from '../../src/view/chatView';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import { __mock, ViewColumn, window as fakeWindow } from '../mocks/vscode';
import {
  fakeConnectionFactory,
  type FakeAppServerConnection,
} from '../helpers/fakeAppServerConnection';

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
};

function fakeSettingsProvider(): SettingsProvider {
  const settings = {
    snapshot: () => ({
      models: [],
      efforts: [],
      model: '',
      reasoningEffort: '',
      approvalMode: '',
      sandbox: '',
      defaults: noDefaults,
      profile: '',
    }),
    update: async () => true,
  };
  return settings as unknown as SettingsProvider;
}

const EMPTY_TASK_CONFIG: TaskSessionConfig = { model: '', effort: '', approvalMode: '' };

/**
 * `ChatSession.start`/`resume` は `connection.ensureStarted()` の1tick分だけ
 * `thread/start`/`thread/resume` の発行が遅れる。フェイク接続は実プロセスを
 * 起こさないため、テスト側でマイクロタスクを明示的に流してから要求を確認する。
 */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function createManager(options?: {
  isTaskManagedThread?: (threadId: string) => boolean;
  onActivity?: (activity: ChatActivity) => void;
}): {
  manager: ChatViewManager;
  connection: FakeAppServerConnection;
} {
  const { factory, connection } = fakeConnectionFactory();
  const manager = new ChatViewManager(
    () => 'codex',
    fakeSettingsProvider(),
    '/fake/codex-home',
    fakeFileSystem,
    fakeLogger,
    options?.onActivity ?? (() => undefined),
    options?.isTaskManagedThread ?? (() => false),
    factory,
  );
  return { manager, connection: connection() };
}

function threadStartResult(threadId: string): unknown {
  return { thread: { id: threadId } };
}

type StateMessage = {
  type: string;
  state: { approvals: unknown[]; items: Array<{ text: string }> };
};

function stateMessagesOf(panel: { webview: { sent: unknown[] } } | undefined): StateMessage[] {
  return (panel?.webview.sent ?? []).filter(
    (m): m is StateMessage =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
  );
}

describe('ChatViewManager', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('codex', {});
  });

  describe('並列開始時の宛先解決（design.md §16.10の3の回帰）', () => {
    it('2つのタスクを並列で開始しても、threadIdの判らない要求を誤って別タスクへ渡さない', async () => {
      const { manager, connection } = createManager();

      // 2つのタスクセッションをどちらも thread/start の応答が返る前に開始する
      const p1 = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      const p2 = manager.openTaskSession({
        cwd: '/workspace/root/task-b',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();

      expect(connection.requests.filter((r) => r.method === 'thread/start')).toHaveLength(2);

      // どちらの thread/start もまだ応答していない時点で、app-serverから
      // 承認要求が届いたとする（threadIdは実際にはA宛だが、こちらはまだそれを知らない）。
      const responsePromise = connection.serverRequest(
        99,
        'item/commandExecution/requestApproval',
        {
          threadId: 'thread-A',
          itemId: 'i1',
          command: 'ls',
          cwd: '/workspace/root/task-a',
        },
      );

      // 誤配送（別タスクの承認カードとして出る）より、宛先不明として拒否するほうが安全。
      // 修正前（`pending`が単一値）は、後から開始したタスクのエントリへ誤って渡していた
      // （`pendingStarts.test.ts` で単体の挙動として再現・固定している）。
      await expect(responsePromise).resolves.toEqual({ decision: 'decline' });

      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      connection.resolveFirst('thread/start', threadStartResult('thread-B'));
      const taskA = await p1;
      const taskB = await p2;
      taskA.open({ preserveFocus: true });
      taskB.open({ preserveFocus: true });

      // 誤配送されていれば承認カードが積まれているはずなので、両方とも空のままであることを確認する
      const panelA = __mock.createdPanels[__mock.createdPanels.length - 2];
      const panelB = __mock.createdPanels[__mock.createdPanels.length - 1];
      panelA?.webview.simulateMessage({ type: 'ready' });
      panelB?.webview.simulateMessage({ type: 'ready' });
      const lastOf = (panel: typeof panelA): StateMessage | undefined => {
        const messages = stateMessagesOf(panel);
        return messages[messages.length - 1];
      };
      expect(lastOf(panelA)?.state.approvals).toEqual([]);
      expect(lastOf(panelB)?.state.approvals).toEqual([]);
    });

    it('開始待ちが1件だけなら、thread/startの応答前に届いた通知も取りこぼさない', async () => {
      // 応答前にもそのスレッド宛の通知は届く（従来の実装が単一の`pending`へ流していた理由）。
      // 開始待ちが1件しか無ければ宛先は一意に定まるので、拾わないと開始直後の通知を落とす。
      const { manager, connection } = createManager();

      const started = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();

      // thread/start がまだ応答していない時点で、そのスレッド宛の通知が届く
      connection.notify('item/started', {
        threadId: 'thread-A',
        turnId: 'turn-1',
        item: { id: 'i1', type: 'agentMessage', text: '着手します' },
      });

      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await started;
      task.open({ preserveFocus: true });

      const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
      panel?.webview.simulateMessage({ type: 'ready' });
      const messages = stateMessagesOf(panel);
      const last = messages[messages.length - 1];
      expect(last?.state.items.some((i) => i.text === '着手します')).toBe(true);
    });

    it('threadIdが解決済みなら、並列に開始した別タスクではなく正しいタスクへ届く', async () => {
      const { manager, connection } = createManager();

      const p1 = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      const p2 = manager.openTaskSession({
        cwd: '/workspace/root/task-b',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      connection.resolveFirst('thread/start', threadStartResult('thread-B'));
      const taskA = await p1;
      const taskB = await p2;

      const handlerA = vi.fn().mockResolvedValue({ kind: 'auto', decision: 'accept' });
      const handlerB = vi.fn().mockResolvedValue({ kind: 'auto', decision: 'accept' });
      taskA.setApprovalHandler(handlerA);
      taskB.setApprovalHandler(handlerB);

      await connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });
  });

  describe('セッションの寿命をパネルから切り離す（design.md §16.10の4）', () => {
    it('タスク管理下のセッションはタブを閉じてもpanelsに残り、通知が届き続ける', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;
      task.open({ preserveFocus: true });

      expect(manager.isOpen('thread-A')).toBe(true);
      const panel = __mock.lastCreatedPanel();
      expect(panel).toBeDefined();
      panel?.dispose();

      // タブを閉じてもタスク管理下のエントリはpanelsに残る
      expect(manager.isOpen('thread-A')).toBe(true);

      const changed: unknown[] = [];
      task.onStateChanged((s) => changed.push(s));
      connection.notify('item/agentMessage/delta', {
        threadId: 'thread-A',
        itemId: 'msg-1',
        delta: 'こんにちは',
      });

      expect(changed).toHaveLength(1);
    });

    it('タブを閉じたあとreveal()すると、それまでの会話が復元される', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;
      task.open({ preserveFocus: true });

      connection.notify('item/agentMessage/delta', {
        threadId: 'thread-A',
        itemId: 'msg-1',
        delta: 'これまでの会話',
      });

      __mock.lastCreatedPanel()?.dispose();
      expect(manager.isOpen('thread-A')).toBe(true);

      task.reveal();
      const revealedPanel = __mock.lastCreatedPanel();
      expect(revealedPanel).toBeDefined();
      expect(revealedPanel?.disposed).toBe(false);

      revealedPanel?.webview.simulateMessage({ type: 'ready' });

      const messages = stateMessagesOf(revealedPanel);
      const last = messages[messages.length - 1];
      expect(last?.state.items.some((i) => i.text === 'これまでの会話')).toBe(true);
    });

    it('人が手で開いた画面は、タブを閉じるとセッションが終わる', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-manual'));
      await p;

      expect(manager.isOpen('thread-manual')).toBe(true);
      __mock.lastCreatedPanel()?.dispose();
      expect(manager.isOpen('thread-manual')).toBe(false);
    });
  });

  describe('タスク単位の設定（design.md §16.10の5）', () => {
    it('タスクの設定は画面ごとに保持され、後からのグローバル設定変更に影響されない', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: { model: 'task-model', effort: 'high', approvalMode: 'never' },
        sandbox: 'workspace-write',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;
      task.open({ preserveFocus: true });

      // タスク開始後にグローバル設定が変わっても、このタスクの送信には影響しない
      __mock.setConfig('codex', { model: 'global-model', reasoningEffort: 'low' });

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'send', text: '続けて' });

      const turnStart = connection.requests.find((r) => r.method === 'turn/start');
      expect(turnStart).toBeDefined();
      expect((turnStart?.params as { model?: string } | undefined)?.model).toBe('task-model');
    });
  });

  describe('承認ハンドラの差し込み（design.md §16.10の6）', () => {
    it('autoを返せば承認カードを出さずに応答する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;
      task.setApprovalHandler(async () => ({ kind: 'auto', decision: 'accept' }));

      const response = await connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });

      expect(response).toEqual({ decision: 'accept' });
    });

    it('askを返せば従来どおり承認カードを出して人を待つ', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;
      task.setApprovalHandler(async () => ({ kind: 'ask' }));
      task.open({ preserveFocus: true });

      let resolved = false;
      void connection
        .serverRequest(1, 'item/commandExecution/requestApproval', {
          threadId: 'thread-A',
          itemId: 'i1',
          command: 'ls',
          cwd: '/workspace/root/task-a',
        })
        .then(() => {
          resolved = true;
        });
      await tick();

      // askのときは人の決定が無い限り応答しない（承認カードが出た状態のまま）
      expect(resolved).toBe(false);
      const panel = __mock.lastCreatedPanel();
      const messages = stateMessagesOf(panel);
      const last = messages[messages.length - 1];
      expect(last?.state.approvals.length).toBe(1);
    });
  });

  describe('interrupt()はループを止めない', () => {
    it('タスクのinterrupt()を呼んでもループは走り続ける', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      const finished = vi.fn();
      task.onFinished(finished);
      task.runLoop({
        initialPrompt: '',
        continuePrompt: '次へ',
        maxIterations: 20,
        condition: '',
      });

      await task.interrupt();

      // 画面の「中断」ボタン（loop.noteUserAction）と違い、タスクのinterrupt()は
      // ターンだけ止めてループ自体は止めない（design.md §16.8）
      expect(finished).not.toHaveBeenCalled();
    });
  });

  describe('既存機能の回帰', () => {
    it('新しい会話（openNew）は引数無しでも従来通り動く', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      expect(connection.requests.some((r) => r.method === 'thread/start')).toBe(true);
      connection.resolveFirst('thread/start', threadStartResult('thread-x'));
      await p;
      expect(manager.isOpen('thread-x')).toBe(true);
    });

    it('履歴から開く（openThread）は既に開いていればreveal、無ければ作って resume する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openThread('thread-y', '既存スレッド', '/workspace/root');
      await tick();
      connection.resolveFirst('thread/resume', threadStartResult('thread-y'));
      await p;
      expect(connection.requests.some((r) => r.method === 'thread/resume')).toBe(true);
      expect(manager.isOpen('thread-y')).toBe(true);

      const panelCountBefore = __mock.createdPanels.length;
      await manager.openThread('thread-y', '既存スレッド', '/workspace/root');
      // 既に開いているので新しいパネルを作らない
      expect(__mock.createdPanels.length).toBe(panelCountBefore);
    });

    it('ループ開始のwebviewメッセージでLoopControllerが走る', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-loop'));
      await p;

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({
        type: 'loop/start',
        plan: { initialPrompt: '', continuePrompt: '次へ', maxIterations: 3, condition: '' },
      });

      expect(connection.requests.some((r) => r.method === 'turn/start')).toBe(true);
    });

    it('承認カードの決定（approve）が保留中の要求を解決する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-approve'));
      await p;

      const responsePromise = connection.serverRequest(5, 'item/commandExecution/requestApproval', {
        threadId: 'thread-approve',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root',
      });

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'approve', requestId: 5, decision: 'accept' });

      await expect(responsePromise).resolves.toEqual({ decision: 'accept' });
    });

    it('名前変更（renameActive）は選択中の画面へ反映する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-rename'));
      await p;

      __mock.showInputBoxAnswer = 'あたらしい名前';
      const renamePromise = manager.renameActive();
      await tick();
      connection.resolveFirst('thread/name/set', {});
      await renamePromise;

      const renameRequest = connection.requests.find((r) => r.method === 'thread/name/set');
      expect(renameRequest).toBeDefined();
      expect((renameRequest?.params as { name?: string } | undefined)?.name).toBe('あたらしい名前');
    });
  });

  describe('タスク管理下スレッドの汎用復元除外（design.md §16.10の7）', () => {
    it('isTaskManagedThreadがtrueを返すスレッドはrestorePanelの対象から外れる', async () => {
      const { manager } = createManager({ isTaskManagedThread: (id) => id === 'thread-task' });
      const panel = fakeWindow.createWebviewPanel('codex.chat', 'x', ViewColumn.Active, {});

      await manager.restorePanel(panel, { threadId: 'thread-task' });

      // オーケストレータ側が正しいcwdで開き直すため、汎用復元はここで手を引く
      expect(panel.disposed).toBe(true);
      expect(manager.isOpen('thread-task')).toBe(false);
    });

    it('タスク管理下でないスレッドは従来通り復元される', async () => {
      const { manager, connection } = createManager({ isTaskManagedThread: () => false });
      const panel = fakeWindow.createWebviewPanel('codex.chat', 'x', ViewColumn.Active, {});

      const p = manager.restorePanel(panel, { threadId: 'thread-normal' });
      await tick();
      connection.resolveFirst('thread/resume', threadStartResult('thread-normal'));
      await p;

      expect(panel.disposed).toBe(false);
      expect(manager.isOpen('thread-normal')).toBe(true);
    });
  });

  describe('setPromptTransform（design.md §16.4 / §16.12）', () => {
    it('実際の送信は展開後、作業記録には展開前の文面を残す', async () => {
      const activities: ChatActivity[] = [];
      const { manager, connection } = createManager({ onActivity: (a) => activities.push(a) });
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      task.setPromptTransform((text) => text.replace('{{T1.result}}', '前タスクの応答テキスト'));
      task.runLoop({
        initialPrompt: '前タスクの結果: {{T1.result}}',
        continuePrompt: '続けて',
        maxIterations: 3,
        condition: '',
      });
      await tick();
      connection.resolveFirst('turn/start', {});
      await tick();

      // 実際にapp-serverへ送った内容は展開済み
      const turnStart = connection.requests.find((r) => r.method === 'turn/start');
      const input = (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input;
      expect(input?.[0]?.text).toBe('前タスクの結果: 前タスクの応答テキスト');

      // 作業記録には展開前の文面（{{T1.result}}のまま）が残る
      const promptActivity = activities.find((a) => a.kind === 'prompt');
      expect(promptActivity?.text).toBe('前タスクの結果: {{T1.result}}');
    });

    it('promptTransformを設定しなければ従来通り同じ文字列を送信・記録する', async () => {
      const activities: ChatActivity[] = [];
      const { manager, connection } = createManager({ onActivity: (a) => activities.push(a) });
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      task.runLoop({
        initialPrompt: '素の指示',
        continuePrompt: '続けて',
        maxIterations: 3,
        condition: '',
      });
      await tick();
      connection.resolveFirst('turn/start', {});
      await tick();

      const turnStart = connection.requests.find((r) => r.method === 'turn/start');
      const input = (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input;
      expect(input?.[0]?.text).toBe('素の指示');
      expect(activities.find((a) => a.kind === 'prompt')?.text).toBe('素の指示');
    });
  });
});
