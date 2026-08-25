import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import type { SessionStore } from '../../src/session/sessionStore';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager, deriveTitle } from '../../src/view/chatView';
import { STATE_POST_INTERVAL_MS, type ChatActivity } from '../../src/view/chatShared';
import { RECAP_INSTRUCTION } from '../../src/appserver/chatSession';
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

/** セッション引き継ぎ（issue #694）のテスト用フェイク。既定は「見つからない」。 */
function fakeSessionStore(overrides?: Partial<SessionStore>): SessionStore {
  return {
    resolveRolloutPath: async () => undefined,
    ...overrides,
  } as unknown as SessionStore;
}

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

/**
 * 状態送信の間引き（`STATE_POST_INTERVAL_MS`、issue #246）で予約に回った分を吐き出す。
 *
 * 連続して状態が変わると最後の1回はタイマー越しに送られる。マイクロタスクだけでは流れないため、
 * 送信済みメッセージを検査する前にこれを挟む。実時間で待つとCIの負荷次第で不安定になるので、
 * 偽のタイマーを間隔ぶん進めて確定させる。
 */
async function flushStatePosts(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

function createManager(options?: {
  isTaskManagedThread?: (threadId: string) => boolean;
  onActivity?: (activity: ChatActivity) => void;
  revealImportSection?: () => void | Promise<void>;
  store?: SessionStore;
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
    fakeMentions(),
    fakeLogger,
    options?.onActivity ?? (() => undefined),
    options?.isTaskManagedThread ?? (() => false),
    options?.revealImportSection ?? (() => undefined),
    factory,
    options?.store,
  );
  return { manager, connection: connection() };
}

function threadStartResult(threadId: string): unknown {
  return { thread: { id: threadId } };
}

type StateItem = { id: string; kind: string; text: string; detail: string };

type StateMessage = {
  type: string;
  state: { approvals: unknown[]; items: StateItem[] };
  /** 会話項目は差し分で届く（issue #262）。 */
  items?: { mode: string; items: StateItem[]; total: number };
};

/**
 * 送られた状態を、webviewが見るのと同じ形（その時点の全項目つき）へ戻す。
 *
 * 会話項目は差し分で送るため（issue #262）、`state.items` は空で届く。webview側の
 * `mergeItems` と同じ積み方をここで再現し、既存のテストが全項目を見られるようにする。
 */
function stateMessagesOf(panel: { webview: { sent: unknown[] } } | undefined): StateMessage[] {
  const merged: StateItem[] = [];
  return (panel?.webview.sent ?? [])
    .filter(
      (m): m is StateMessage =>
        typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
    )
    .map((m) => {
      const delta = m.items;
      if (delta === undefined) {
        return m;
      }
      if (delta.mode === 'full') {
        merged.length = 0;
      }
      for (const item of delta.items) {
        const at = merged.findIndex((x) => x.id === item.id);
        if (at === -1) merged.push(item);
        else merged[at] = item;
      }
      return { ...m, state: { ...m.state, items: [...merged] } };
    });
}

describe('ChatViewManager', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('codex', {});
    // 状態送信の間引き（issue #246）を確定的に進めるため。`shouldAdvanceTime` を立てて
    // おくと実時間も進むので、タイマーを明示的に進めない既存のテストはそのまま通る
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
      await flushStatePosts();
      const lastOf = (panel: typeof panelA): StateMessage | undefined => {
        const messages = stateMessagesOf(panel);
        return messages[messages.length - 1];
      };
      expect(lastOf(panelA)?.state.approvals).toEqual([]);
      expect(lastOf(panelB)?.state.approvals).toEqual([]);
    });

    it('sendはループを介さず本文をそのまま送り、作業記録に残さない（design.md §16.23）', async () => {
      const activities: ChatActivity[] = [];
      const { manager, connection } = createManager({ onActivity: (a) => activities.push(a) });

      const started = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await started;
      // `setPromptTransform` の変換は `runLoop` 経由の送信専用で、`send` は通さない
      task.setPromptTransform((text) => `変換済み: ${text}`);

      task.send('進捗を教えて');
      await tick();

      const turn = connection.requests.filter((r) => r.method === 'turn/start');
      expect(turn).toHaveLength(1);
      expect(JSON.stringify(turn[0]?.params)).toContain('進捗を教えて');
      expect(JSON.stringify(turn[0]?.params)).not.toContain('変換済み');
      expect(activities).toHaveLength(0);
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
      await flushStatePosts();
      const messages = stateMessagesOf(panel);
      const last = messages[messages.length - 1];
      expect(last?.state.items.some((i) => i.text === '着手します')).toBe(true);
    });

    it('2回目からは変わった項目だけを送る（issue #262）', async () => {
      const { manager, connection } = createManager();
      const started = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      (await started).open({ preserveFocus: true });
      const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
      panel?.webview.simulateMessage({ type: 'ready' });
      await flushStatePosts();

      connection.notify('item/started', {
        threadId: 'thread-A',
        turnId: 'turn-1',
        item: { id: 'i1', type: 'agentMessage', text: '1件目' },
      });
      await flushStatePosts();
      connection.notify('item/started', {
        threadId: 'thread-A',
        turnId: 'turn-1',
        item: { id: 'i2', type: 'agentMessage', text: '2件目' },
      });
      await flushStatePosts();

      const raw = (panel?.webview.sent ?? []).filter(
        (m): m is StateMessage =>
          typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
      );
      const last = raw[raw.length - 1];
      // 増えた1件だけが載り、丸ごとの直列化にはならない
      expect(last?.items?.mode).toBe('delta');
      expect(last?.items?.items.map((i) => i.id)).toEqual(['i2']);
      expect(last?.items?.total).toBe(2);
      expect(last?.state.items).toEqual([]);
      // それでも積み直せば全項目が揃う
      const merged = stateMessagesOf(panel);
      expect(merged[merged.length - 1]?.state.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    });

    it('webviewが取りこぼしに気付いたら全量を送り直す（issue #262）', async () => {
      const { manager, connection } = createManager();
      const started = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      (await started).open({ preserveFocus: true });
      const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
      panel?.webview.simulateMessage({ type: 'ready' });
      connection.notify('item/started', {
        threadId: 'thread-A',
        turnId: 'turn-1',
        item: { id: 'i1', type: 'agentMessage', text: '1件目' },
      });
      await flushStatePosts();

      await manager.simulateWebviewMessage('thread-A', { type: 'stateFull' });

      const raw = (panel?.webview.sent ?? []).filter(
        (m): m is StateMessage =>
          typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
      );
      const last = raw[raw.length - 1];
      expect(last?.items?.mode).toBe('full');
      expect(last?.items?.items.map((i) => i.id)).toEqual(['i1']);
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

  describe('接続断で保留中の承認を解放する（issue #354）', () => {
    it('thread/start応答待ち（pendingStarts）に出た承認カードも、接続断で解放される', async () => {
      const { manager, connection } = createManager();

      // thread/startがまだ応答していない間はpanelsではなくpendingStartsに居る
      // （design.md §16.10の3）。この状態で届いた承認要求も、接続断で解放されなければ
      // ならない（レビュー指摘: handleConnectionLostがpanelsだけを見ていた問題の回帰防止）
      const p1 = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();

      const responded = connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });

      connection.simulateDisconnect();

      // 承認された扱いにならず、拒否側の値（decide(id, 'cancel')と同じ）で解決される
      await expect(responded).resolves.toEqual({ decision: 'cancel' });

      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p1;
    });
  });

  describe('接続断でbusyが戻らない問題を直す（issue #420）', () => {
    it('turn/start応答待ち中に接続が切れると、busyがfalse・turnFailedがtrueに戻る', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      const states: { busy: boolean; turnFailed: boolean }[] = [];
      task.onStateChanged((s) => states.push({ busy: s.busy, turnFailed: s.turnFailed }));

      // send()はturn/startの応答が届く前にbusy: trueへ更新する。fakeConnectionは
      // 明示的にresolveFirstするまで応答を保留するため、以降の状態はまだ
      // 「応答待ち」のまま止まる
      task.send('こんにちは');
      await tick();
      expect(states[states.length - 1]).toEqual({ busy: true, turnFailed: false });

      // ここでapp-serverが落ちたとする。turn/startは二度と応答しないため、
      // handleConnectionLostがreleasePendingApprovalsと並べて呼ぶmarkTurnFailed()が
      // 無いと、busy: trueのまま画面が固まる（修正前の再現）
      connection.simulateDisconnect();

      expect(states[states.length - 1]).toEqual({ busy: false, turnFailed: true });
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

      await flushStatePosts();

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
      await flushStatePosts();
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

    it('設定を読んでいなければCodex側の実描画でも既定4つ（attach/loopToggle/compact/claudeImport）が表に残り、残り11個はメニューへ畳まれる', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-composer-buttons'));
      await p;

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      for (const id of ['attach', 'loopToggle', 'compact', 'claudeImport']) {
        expect(isInOverflowMenu(html, id), `${id} は表にあるはず`).toBe(false);
      }
      for (const id of [
        'recap',
        'planToggle',
        'fastToggle',
        'review',
        'exportTranscript',
        'workflowMenu',
        'teamWorkflow',
        'workflowView',
        'sessionKanban',
        'openProgress',
        'handoffToNewSession',
      ]) {
        expect(isInOverflowMenu(html, id), `${id} は「…」メニューにあるはず`).toBe(true);
      }
    });

    it('agent.chat.composerButtonsをreview/workflowMenuに絞るとCodex側の実描画にも反映される', async () => {
      __mock.setConfig('agent', { 'chat.composerButtons': ['review', 'workflowMenu'] });
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-composer-buttons-2'));
      await p;

      const html = __mock.lastCreatedPanel()?.webview.html ?? '';
      expect(isInOverflowMenu(html, 'review'), 'review は表にあるはず').toBe(false);
      expect(isInOverflowMenu(html, 'workflowMenu'), 'workflowMenu は表にあるはず').toBe(false);
      expect(isInOverflowMenu(html, 'attach'), 'attach は「…」メニューにあるはず').toBe(true);
      expect(isInOverflowMenu(html, 'claudeImport'), 'claudeImport は「…」メニューにあるはず').toBe(
        true,
      );
    });

    it('未知のIDを含む設定は既定へ丸められ、Codex側のロガーへ警告が出る', async () => {
      __mock.setConfig('agent', { 'chat.composerButtons': ['attach', 'nope'] });
      const warnSpy = vi.spyOn(fakeLogger, 'warn');
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-composer-buttons-3'));
      await p;

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
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      expect(connection.requests.some((r) => r.method === 'thread/start')).toBe(true);
      connection.resolveFirst('thread/start', threadStartResult('thread-x'));
      await p;
      expect(manager.isOpen('thread-x')).toBe(true);
    });

    it(
      'インポートボタン（claudeImport）を押すと、会話へは何も送らずrevealImportSectionだけを' +
        '呼ぶ（issue #227、設定パネルを表示してセクションを開く経路はrevealImportSection側の責務）',
      async () => {
        let revealCalls = 0;
        const { manager, connection } = createManager({
          revealImportSection: () => {
            revealCalls += 1;
          },
        });
        const p = manager.openNew();
        await tick();
        connection.resolveFirst('thread/start', threadStartResult('thread-import'));
        await p;

        const panel = __mock.lastCreatedPanel();
        panel?.webview.simulateMessage({ type: 'claudeImport' });
        await tick();

        expect(revealCalls).toBe(1);
        // 会話への発言（turn/start）は起きない。Claude Code側の`/import`プレビュー送信とは
        // 違い、押しても何も会話へ送らないのが仕様（`ChatShellOptions.showImport`のJSDoc参照）
        expect(connection.requests.some((r) => r.method === 'turn/start')).toBe(false);
      },
    );

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

    it('背面で開いたタスクのタブは名前変更の対象（active）を奪わない（レビュー指摘: critical 2）', async () => {
      const { manager, connection } = createManager();

      // 人が自分のチャットを前面で開く
      const humanChat = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-human'));
      await humanChat;

      // タスクは必ずpreserveFocus: trueで背面に開く（design.md §16.10の2）
      const taskPromise = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-task'));
      const task = await taskPromise;
      task.open({ preserveFocus: true });

      // 背面で開いただけなので、人のチャットが選択中のまま
      __mock.showInputBoxAnswer = 'タスクの名前になってはいけない';
      const renamePromise = manager.renameActive();
      await tick();
      connection.resolveFirst('thread/name/set', {});
      await renamePromise;

      const renameRequest = connection.requests.find((r) => r.method === 'thread/name/set');
      expect((renameRequest?.params as { threadId?: string } | undefined)?.threadId).toBe(
        'thread-human',
      );
    });
  });

  describe('エディタの選択範囲の送り先（getActiveComposerTarget、issue #292）', () => {
    it('開いているタブが無ければundefined', () => {
      const { manager } = createManager();
      expect(manager.getActiveComposerTarget()).toBeUndefined();
    });

    it('選択中の画面の入力欄へテキストを挿し込み、そのタブを表に出す', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-insert'));
      await p;

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

    it('activeSequenceは後からアクティブになったタブの方が大きい（Claude Code側との横断比較に使う）', async () => {
      const { manager, connection } = createManager();
      const p1 = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-1'));
      await p1;
      const first = manager.getActiveComposerTarget();

      const p2 = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-2'));
      await p2;
      const second = manager.getActiveComposerTarget();

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second?.activeSequence).toBeGreaterThan(first?.activeSequence as number);
    });
  });

  describe('会話のクリア（TUIの /clear 相当）', () => {
    it('いまの会話を閉じて、同じ作業フォルダで新しい会話を開き直す', async () => {
      const { manager, connection } = createManager();
      const opened = manager.openNew('/workspace/root/sub');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-old'));
      await opened;
      const oldPanel = __mock.lastCreatedPanel();

      const cleared = manager.clearActive();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-new'));
      await cleared;

      expect(manager.isOpen('thread-old')).toBe(false);
      expect(manager.isOpen('thread-new')).toBe(true);
      expect(oldPanel?.disposed).toBe(true);
      // 作業フォルダは引き継ぐ（ワークスペース直下へ戻さない）
      const starts = connection.requests.filter((r) => r.method === 'thread/start');
      expect((starts[starts.length - 1]?.params as { cwd?: string } | undefined)?.cwd).toBe(
        '/workspace/root/sub',
      );
    });

    it('応答の途中は確認を出し、キャンセルすれば会話を残す', async () => {
      const { manager, connection } = createManager();
      const opened = manager.openNew();
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-busy'));
      await opened;

      // 送信は `turn/start` の応答待ちで解決しないため、待たずに進めてbusyだけ作る
      void manager.simulateWebviewMessage('thread-busy', { type: 'send', text: 'こんにちは' });
      await tick();

      __mock.showWarningMessageAnswer = undefined;
      await manager.clearActive();

      expect(__mock.messages.warnings).toHaveLength(1);
      expect(manager.isOpen('thread-busy')).toBe(true);
      expect(connection.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    });

    it('アクティブな画面が無ければ案内を出すだけで何もしない', async () => {
      const { manager, connection } = createManager();

      await manager.clearActive();

      expect(__mock.messages.infos).toHaveLength(1);
      expect(connection.requests.filter((r) => r.method === 'thread/start')).toHaveLength(0);
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

  describe('タスク間メッセージングのMCP設定・可視性確認（design.md §16.21、Issue #123）', () => {
    it('input.mcpを渡すとthread/startのconfig.mcp_serversへ差し込まれる（実測: streamable_http）', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
      });
      await tick();

      const threadStart = connection.requests.find((r) => r.method === 'thread/start');
      const params = threadStart?.params as { config?: { mcp_servers?: Record<string, unknown> } };
      expect(params.config?.mcp_servers?.['task-messaging']).toEqual({
        url: 'http://127.0.0.1:12345/mcp/abc',
        type: 'streamable_http',
      });

      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;
    });

    it('input.mcpを渡さなければthread/startにconfigを含めない（後方互換）', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();

      const threadStart = connection.requests.find((r) => r.method === 'thread/start');
      expect((threadStart?.params as Record<string, unknown>)['config']).toBeUndefined();

      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;
    });

    it(
      'mcpServer/startupStatus/updated(ready)が届くとcheckMessagingToolVisible()はtrueで解決する' +
        '（design.md「確認はthread/startの後に行う」）',
      async () => {
        const { manager, connection } = createManager();
        const p = manager.openTaskSession({
          cwd: '/workspace/root/task-a',
          config: EMPTY_TASK_CONFIG,
          sandbox: '',
          mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
        });
        await tick();
        connection.resolveFirst('thread/start', threadStartResult('thread-A'));
        const task = await p;

        const visiblePromise = task.checkMessagingToolVisible();
        connection.notify('mcpServer/startupStatus/updated', {
          threadId: 'thread-A',
          name: 'task-messaging',
          status: 'ready',
        });
        await expect(visiblePromise).resolves.toBe(true);
      },
    );

    it('mcpServer/startupStatus/updated(failed)が届くとcheckMessagingToolVisible()はfalseで解決する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/abc' },
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      const visiblePromise = task.checkMessagingToolVisible();
      connection.notify('mcpServer/startupStatus/updated', {
        threadId: 'thread-A',
        name: 'task-messaging',
        status: 'failed',
      });
      await expect(visiblePromise).resolves.toBe(false);
    });

    it('別スレッド・別サーバ名の通知は無視する（誤配送しない）', async () => {
      const { manager, connection } = createManager();
      const p1 = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/a' },
      });
      const p2 = manager.openTaskSession({
        cwd: '/workspace/root/task-b',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
        mcp: { url: 'http://127.0.0.1:12345/mcp/b' },
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      connection.resolveFirst('thread/start', threadStartResult('thread-B'));
      const taskA = await p1;
      await p2;

      const visiblePromise = taskA.checkMessagingToolVisible();
      // 別スレッド宛のready通知は無視する
      connection.notify('mcpServer/startupStatus/updated', {
        threadId: 'thread-B',
        name: 'task-messaging',
        status: 'ready',
      });
      // 同じスレッドでも別のサーバ名は無視する
      connection.notify('mcpServer/startupStatus/updated', {
        threadId: 'thread-A',
        name: 'other-server',
        status: 'ready',
      });
      // 本来の通知
      connection.notify('mcpServer/startupStatus/updated', {
        threadId: 'thread-A',
        name: 'task-messaging',
        status: 'ready',
      });
      await expect(visiblePromise).resolves.toBe(true);
    });

    it('input.mcpを渡していなければ確認そのものを行わず常にtrueを返す', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      await expect(task.checkMessagingToolVisible()).resolves.toBe(true);
    });
  });

  describe('pauseLoop/resumeLoop（design.md §16.21、Issue #123）', () => {
    it('pauseLoop()するとターンが終わっても継続指示を送らず、resumeLoop()で送る', async () => {
      const { manager, connection } = createManager();
      const p = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      const task = await p;

      task.runLoop({
        initialPrompt: '第1ターン',
        continuePrompt: '続けて',
        maxIterations: 5,
        condition: '',
      });
      await tick();
      connection.resolveFirst('turn/start', {});
      await tick();

      task.pauseLoop();
      connection.notify('turn/completed', { threadId: 'thread-A' });
      await tick();

      expect(connection.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);

      task.resumeLoop();
      await tick();
      expect(connection.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    });
  });

  /**
   * 会話の1行要約（issue #228、design.md §14.41）。
   *
   * Claude Code画面の`/recap`（issue #203、design.md §14.36）と違い、Codex側は要約専用の
   * 経路が無いため`RECAP_INSTRUCTION`を通常のターンとして送る。会話が空のときはCLI側に
   * 「Nothing to recap yet」相当の判定が無いため、`ChatSession.recap()`が拡張機能側で判定して
   * `turn/start`を送らずに一言だけ残す（`chatSessionRecap.test.ts`のセッション単体テストと
   * 対になる、`recap`メッセージの配線側の確認）。
   */
  describe('会話の1行要約（recapメッセージ、issue #228、design.md §14.41）', () => {
    it('会話が空の状態で押すとturn/startを送らず、一言だけ会話に残す', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'recap' });
      await tick();

      expect(connection.requests.some((r) => r.method === 'turn/start')).toBe(false);
      await flushStatePosts();
      const messages = stateMessagesOf(panel);
      const last = messages[messages.length - 1];
      expect(
        last?.state.items.some(
          (i) =>
            i.kind === 'settingsChanged' &&
            i.detail === 'まだ要約できる会話がありません。まず何か送ってから試してください',
        ),
      ).toBe(true);
    });

    it('会話がある状態で押すとRECAP_INSTRUCTIONを通常のターンとして送る', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;

      // 会話が1件以上ある状態を作る
      connection.notify('item/agentMessage/delta', {
        threadId: 'thread-A',
        itemId: 'msg-1',
        delta: 'これまでの会話',
      });

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'recap' });
      await tick();

      const turnStart = connection.requests.find((r) => r.method === 'turn/start');
      expect(turnStart).toBeDefined();
      expect(
        (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input,
      ).toEqual([{ type: 'text', text: RECAP_INSTRUCTION }]);
    });
  });

  describe('ワークフローの導線（issue #250）', () => {
    it('ワークフローボタンを押すとagent.workflows.menuを実行する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'workflowMenu' });
      await tick();

      expect(__mock.executedCommands).toContain('agent.workflows.menu');
    });

    it('三点メニューのチームモード開始からagent.workflows.teamを実行する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;
      const panel = __mock.lastCreatedPanel();

      panel?.webview.simulateMessage({ type: 'teamWorkflow' });
      await tick();

      expect(__mock.executedCommands).toContain('agent.workflows.team');
    });

  it('三点メニューのワークフローViewからagent.workflows.viewを実行する', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;
      const panel = __mock.lastCreatedPanel();

      panel?.webview.simulateMessage({ type: 'workflowView' });
      await tick();

      expect(__mock.executedCommands).toContain('agent.workflows.view');
    });

    it('会話へは何も送らない（ターンを消費しない）', async () => {
      const { manager, connection } = createManager();
      const p = manager.openNew('/workspace/root');
      await tick();
      connection.resolveFirst('thread/start', threadStartResult('thread-A'));
      await p;

      const panel = __mock.lastCreatedPanel();
      panel?.webview.simulateMessage({ type: 'workflowMenu' });
      await tick();

      expect(connection.requests.find((r) => r.method === 'turn/start')).toBeUndefined();
    });
  });

  it('三点メニューのセッションカンバンからagent.sessionKanbanを実行する', async () => {
    const { manager, connection } = createManager();
    const opened = manager.openNew();
    await tick();
    connection.resolveFirst('thread/start', threadStartResult('thread-session-kanban'));
    await opened;

    __mock.lastCreatedPanel()?.webview.simulateMessage({ type: 'sessionKanban' });
    await tick();

    expect(__mock.executedCommands).toContain('agent.sessionKanban');
  });

  describe('タブ名の状態表示（issue #286、design.md §14.55）', () => {
    it('実行中はタブ名の先頭に * が付く', async () => {
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

      connection.notify('turn/started', { turn: { id: 't1' } });

      expect(__mock.lastCreatedPanel()?.title).toBe('* Codex');
    });

    it('承認待ちはタブ名の先頭に ! が付く（実行中より優先）', async () => {
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
      connection.notify('turn/started', { turn: { id: 't1' } });

      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();

      expect(__mock.lastCreatedPanel()?.title).toBe('! Codex');
    });

    it('承認が解決すると印が外れる（実行中の印へ戻る）', async () => {
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
      connection.notify('turn/started', { turn: { id: 't1' } });
      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();
      expect(__mock.lastCreatedPanel()?.title).toBe('! Codex');

      task.decideApproval(1, 'accept');

      expect(__mock.lastCreatedPanel()?.title).toBe('* Codex');
    });
  });

  describe('承認待ち・ターン完了の通知（issue #286、design.md §14.55）', () => {
    beforeEach(() => {
      __mock.setConfig('agent', {});
    });

    async function openHiddenTaskPanel(): Promise<{
      task: Awaited<ReturnType<ChatViewManager['openTaskSession']>>;
      connection: FakeAppServerConnection;
    }> {
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
      // 既定では作られた直後のパネルは`visible: true`（唯一のタブなので前面にある）。
      // 「背面タブ」を模すため、明示的に見えない状態へ切り替える
      __mock.lastCreatedPanel()?.simulateVisibilityChange(false);
      return { task, connection };
    }

    it('非表示のタブで承認待ちになった直後に通知が1回出て、開くでタブを表示する', async () => {
      const { connection } = await openHiddenTaskPanel();

      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();

      expect(__mock.messages.infos).toHaveLength(1);
      expect(__mock.messages.infos[0]).toContain('コマンドの実行を許可しますか');

      // 既定（AUTO_CONFIRM）は通知の最初のボタン（「開く」）を選んだ扱いになる
      await tick();
      expect(__mock.lastCreatedPanel()?.revealCount).toBeGreaterThan(0);
    });

    it('タブが見えている間は通知を出さない', async () => {
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
      // simulateVisibilityChangeを呼ばないため visible: true のまま

      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();

      expect(__mock.messages.infos).toHaveLength(0);
    });

    it('見えている間に来た承認要求は、あとでタブを背面へ回しても通知しない', async () => {
      // 判定は承認要求を受け取ったその瞬間の一度きり（design.md §14.55）。
      // `onDidChangeViewState` は通知判定を呼ばないという構造でこれを保証しているため、
      // 将来そこへ再判定を足すと黙って壊れる。その回帰を捕まえるためのテスト
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
      // visible: true のまま承認要求を受け取る

      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();
      expect(__mock.messages.infos).toHaveLength(0);

      // ここで背面へ回しても、既に判定済みの要求を蒸し返さない
      __mock.lastCreatedPanel()?.simulateVisibilityChange(false);
      await tick();

      expect(__mock.messages.infos).toHaveLength(0);
    });

    it('同じ承認要求では通知が重複しない（後続の状態更新でも1回のまま）', async () => {
      const { task, connection } = await openHiddenTaskPanel();

      const approvalPromise = connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();
      expect(__mock.messages.infos).toHaveLength(1);

      // 同じ承認要求が保留のまま、無関係な通知（別の項目開始）で状態更新が続いても
      // 通知は増えない
      connection.notify('item/started', {
        item: { id: 'i2', type: 'agentMessage', text: '' },
      });
      connection.notify('item/started', {
        item: { id: 'i3', type: 'agentMessage', text: '' },
      });
      expect(__mock.messages.infos).toHaveLength(1);

      task.decideApproval(1, 'accept');
      await approvalPromise;
    });

    it('設定 agent.notifications.approvalPending を false にすると承認待ちの通知を出さない', async () => {
      __mock.setConfig('agent', { 'notifications.approvalPending': false });
      const { connection } = await openHiddenTaskPanel();

      void connection.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root/task-a',
      });
      await tick();

      expect(__mock.messages.infos).toHaveLength(0);
    });

    it('ターン完了の通知は既定オフ（非表示タブでも出ない）', async () => {
      const { connection } = await openHiddenTaskPanel();

      connection.notify('turn/started', { turn: { id: 't1' } });
      connection.notify('turn/completed', { turn: { id: 't1' } });

      expect(__mock.messages.infos).toHaveLength(0);
    });

    it('設定 agent.notifications.turnComplete を true にすると非表示タブでターン完了の通知が出る', async () => {
      __mock.setConfig('agent', { 'notifications.turnComplete': true });
      const { connection } = await openHiddenTaskPanel();

      connection.notify('turn/started', { turn: { id: 't1' } });
      connection.notify('turn/completed', { turn: { id: 't1' } });

      expect(__mock.messages.infos).toHaveLength(1);
      expect(__mock.messages.infos[0]).toContain('応答が終わりました');
    });
  });
});

describe('deriveTitle（Issue #533、優先順位の固定）', () => {
  const baseState = (
    overrides: Partial<Parameters<typeof deriveTitle>[0]> = {},
  ): Parameters<typeof deriveTitle>[0] =>
    ({
      items: [],
      name: undefined,
      ...overrides,
    }) as Parameters<typeof deriveTitle>[0];

  it('名前があれば最優先で使う', () => {
    const state = baseState({
      name: '人が付けた名前',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state)).toBe('Codex: 人が付けた名前');
  });

  it('名前が無ければ最初の発言から作る', () => {
    const state = baseState({
      items: [{ kind: 'userMessage', id: '1', text: '設計を見直したい' } as never],
    });
    expect(deriveTitle(state)).toBe('Codex: 設計を見直したい');
  });

  it('どちらも無ければundefined（タブ名は前の値のまま）', () => {
    expect(deriveTitle(baseState())).toBeUndefined();
  });

  // Issue #533の時点では chatView.ts 側が state.name !== '' のみで、claudeChatView.ts 側の
  // .trim() !== '' と挙動が違った（空白のみの名前がそのままタブ名になった）。差の意図は
  // 未検証のまま現状を固定していたが、Issue #599 で claudeChatView.ts 側へ揃えた。
  // 空白だけのタブ名は、どのタブが何か分からなくする点で「名前が無い」と同じである。
  it('空白のみの名前は使わず、最初の発言へ落ちる（claudeChatView.tsと揃えた。Issue #599）', () => {
    const state = baseState({
      name: '   ',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state)).toBe('Codex: 最初の発言');
  });
});

describe('deriveTitle（Issue #599、pinnedNameを最優先にする）', () => {
  const baseState = (
    overrides: Partial<Parameters<typeof deriveTitle>[0]> = {},
  ): Parameters<typeof deriveTitle>[0] =>
    ({
      items: [],
      name: undefined,
      ...overrides,
    }) as Parameters<typeof deriveTitle>[0];

  it('pinnedNameがあれば、Codexが付けた名前より優先する', () => {
    const state = baseState({
      name: 'Codexが付けた要約名',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state, 'Codex: task-3')).toBe('Codex: task-3');
  });

  // pinnedNameは`buildSessionPanelTitle`が組み立てた完成形（ラベルを含む）なので、
  // ここでラベルを重ねない。`Codex: Codex: task-3`にならないことを固定する
  it('pinnedNameはそのまま使い、ラベルを重ねない', () => {
    expect(deriveTitle(baseState(), 'Codex: 衝突解決 task-9')).toBe('Codex: 衝突解決 task-9');
  });

  it('pinnedNameが空白のみなら無視して、次の優先度へ落ちる', () => {
    const state = baseState({ name: 'Codexが付けた要約名' });
    expect(deriveTitle(state, '   ')).toBe('Codex: Codexが付けた要約名');
  });

  it('pinnedNameが無ければ従来どおりの優先順位（人が手で開いた画面）', () => {
    const state = baseState({
      items: [{ kind: 'userMessage', id: '1', text: '設計を見直したい' } as never],
    });
    expect(deriveTitle(state, undefined)).toBe('Codex: 設計を見直したい');
  });
});

describe('handoffToNewSession（issue #694）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('アクティブなタブが無ければ何もしない', async () => {
    const { manager } = createManager({ store: fakeSessionStore() });
    await manager.handoffToNewSession();
    expect(__mock.messages.errors).toHaveLength(0);
  });

  it('rolloutが解決できれば、新セッションへ固定文言とパスを送る', async () => {
    const store = fakeSessionStore({
      resolveRolloutPath: async () => '/home/user/.codex/sessions/rollout-x.jsonl',
    });
    const { manager, connection } = createManager({ store });

    const opened = manager.openNew('/workspace/root');
    await tick();
    connection.resolveFirst('thread/start', threadStartResult('thread-orig'));
    await opened;

    const handoff = manager.handoffToNewSession();
    await tick();
    connection.resolveFirst('thread/start', threadStartResult('thread-new'));
    await tick();
    connection.resolveFirst('turn/start', {});
    await handoff;

    const turnStart = connection.requests.filter((r) => r.method === 'turn/start');
    expect(
      turnStart.some((r) =>
        JSON.stringify(r.params).includes('/home/user/.codex/sessions/rollout-x.jsonl'),
      ),
    ).toBe(true);
  });

  it('rolloutが解決できなければ、短時間リトライ後にエラー通知して新セッションを作らない', async () => {
    const store = fakeSessionStore({ resolveRolloutPath: async () => undefined });
    const { manager, connection } = createManager({ store });

    const opened = manager.openNew('/workspace/root');
    await tick();
    connection.resolveFirst('thread/start', threadStartResult('thread-orig'));
    await opened;
    const threadStartsBefore = connection.requests.filter(
      (r) => r.method === 'thread/start',
    ).length;

    const handoff = manager.handoffToNewSession();
    await vi.runAllTimersAsync();
    await handoff;

    expect(connection.requests.filter((r) => r.method === 'thread/start').length).toBe(
      threadStartsBefore,
    );
    expect(__mock.messages.errors).toContainEqual(
      expect.stringContaining('transcriptが見つかりませんでした'),
    );
  });
});
