import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { SideQuestionHistoryEntry } from '../../src/claude/control';
import { MAX_SIDE_QUESTION_HISTORY } from '../../src/claude/sideQuestion';
import type { Logger } from '../../src/log';
import type { FileSystemPort, MemoryFileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import { MESSAGING_MCP_SERVER_NAME } from '../../src/orchestrator/messaging';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import type { McpServerView } from '../../src/provider/mcpServers';
import {
  MEMORY_LAST_SELECTED_PATH_KEY,
  type MemoryModeMemento,
} from '../../src/provider/inputModes';
import { STATE_POST_INTERVAL_MS, type ChatActivity } from '../../src/view/chatShared';
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
    get: <T>(key: string, defaultValue: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
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
  onActivity?: (activity: ChatActivity) => void;
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
    options?.onActivity ?? (() => undefined),
    () => undefined,
    options?.isTaskManagedThread ?? (() => false),
    options?.memoryFs ?? fakeMemoryFileSystem(),
    options?.memoryMemento ?? fakeMemento(),
  );
  return { manager, store };
}

/**
 * `handleMessage` の `send` 分岐は非同期処理を待たずに戻るため、マイクロタスクを流す。
 *
 * `postState` の間引き（`STATE_POST_INTERVAL_MS`、issue #356）で予約に回った分もここで
 * 確定させる。フェイクタイマー越しに進めることで、実時間待ちによるCIの不安定化を避ける
 * （`chatViewManager.test.ts`の`flushStatePosts`と同じ理由）。
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

type StateItem = {
  id: string;
  detail?: string;
  text?: string;
  diffs?: { diff?: string; editReplace?: unknown }[];
};

type StateMessage = {
  type: string;
  state: { items: StateItem[]; [key: string]: unknown };
  /** 会話項目は差し分で届く（issue #356）。 */
  items?: { mode: string; items: StateItem[]; total: number };
};

/**
 * 送られた状態を、webviewが見るのと同じ形（その時点の全項目つき）へ戻す。
 *
 * 会話項目は差し分で送るため（issue #356）、`state.items` は空で届く。webview側の
 * `mergeItems`（実装は`stateDelta.ts`の`MERGE_ITEMS_SOURCE`）と同じ積み方をここで
 * 再現し、既存のテストが全項目を見られるようにする
 * （`chatViewManager.test.ts`の`stateMessagesOf`と同じ考え方）。
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
      // 実クライアントのmergeItems（stateDelta.tsのMERGE_ITEMS_SOURCE）が持つ安全弁と
      // 同じ検証。積み直した件数がtotalと合わなければbuildItemsDeltaの回帰であり、
      // 実クライアントはstateFull要求へ倒して黙って復旧するが、テストでは見逃さず落とす
      if (merged.length !== delta.total) {
        throw new Error(
          `postStateの差分でtotalが合わない（積み直し後${merged.length}件 / total${delta.total}件）`,
        );
      }
      return { ...m, state: { ...m.state, items: [...merged] } };
    });
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
/** 発言テキスト1件分の`agentMessage`。`uuid`をそのまま項目idに使う（issue #356の間引きテスト用）。 */
const assistantTextLine = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid,
    message: { id: uuid, content: [{ type: 'text', text }] },
  })}\n`;
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe('ループを介さない1回きりの送信（TaskSession.send。design.md §16.23）', () => {
    it('本文をそのままCLIへ送る（promptTransformは通さない）', async () => {
      stubStart();
      const sent: string[] = [];
      vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockImplementation((text: string) => {
        sent.push(text);
        return 'sent';
      });
      const { manager } = createManager();

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      task.setPromptTransform((text) => `変換済み: ${text}`);
      task.send('進捗を教えて');

      expect(sent).toEqual(['進捗を教えて']);
    });

    it('作業記録には残さない（design.md §16.23「信頼境界」）', async () => {
      stubStart();
      vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockImplementation(() => 'sent');
      const activities: ChatActivity[] = [];
      const { manager } = createManager({ onActivity: (a) => activities.push(a) });

      const task = await manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      task.send('進捗を教えて');

      expect(activities).toHaveLength(0);
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
      for (const id of [
        'recap',
        'planToggle',
        'fastToggle',
        'review',
        'exportTranscript',
        'workflowMenu',
      ]) {
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

  describe('会話の途中のターンから分岐（issue #333、design.md §14.61）', () => {
    it('セッション全体のforkと同じ経路で新しいタブを開き、rewindConversationToTurnへ対象のuuidを渡す', async () => {
      const startCalls = stubStart();
      const rewind = vi
        .spyOn(ClaudeStreamSession.prototype, 'rewindConversationToTurn')
        .mockResolvedValue({
          ok: true,
          prefillText: '元の発言',
          error: undefined,
          succeededCount: 3,
        });
      const { manager } = createManager();

      await manager.openForkFromTurn(
        'origin-session-id',
        '分岐',
        '/workspace/root',
        ['u1', 'u2', 'u3'],
        'u1',
      );

      // セッション全体のfork（openFork）と同じtarget形（issue #218）
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0]?.target).toEqual({ kind: 'fork', sessionId: 'origin-session-id' });
      expect(startCalls[0]?.sessionId).toBeUndefined();
      // ロジック層（forkFromTurn.ts）が組み立てる新しい順の送信は、streamSession側の
      // rewindConversationToTurnにそのまま委ねる（呼び出し引数だけを確認する）
      expect(rewind).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'u1');
    });

    it('戻し切れると prefillText を新しいタブの入力欄へ挿す（insertComposerTextを再利用）', async () => {
      stubStart();
      vi.spyOn(ClaudeStreamSession.prototype, 'rewindConversationToTurn').mockResolvedValue({
        ok: true,
        prefillText: '元の発言の本文',
        error: undefined,
        succeededCount: 1,
      });
      const { manager } = createManager();

      await manager.openForkFromTurn('origin-session-id', '分岐', '/workspace/root', ['u1'], 'u1');

      const panel = __mock.lastCreatedPanel();
      expect(panel?.webview.sent).toContainEqual({
        type: 'insertComposerText',
        text: '元の発言の本文',
      });
    });

    it('1件も戻せずに失敗した場合はエラーを表示し、開いたばかりの新しいタブを閉じる（issue #494のレビュー指摘）', async () => {
      stubStart();
      vi.spyOn(ClaudeStreamSession.prototype, 'rewindConversationToTurn').mockResolvedValue({
        ok: false,
        prefillText: undefined,
        error: { message: 'stale target', origin: 'cli' },
        succeededCount: 0,
      });
      const { manager } = createManager();

      await manager.openForkFromTurn('origin-session-id', '分岐', '/workspace/root', ['u1'], 'u1');

      // CLIの生の文言（'stale target'）は画面へ出さず、日本語へマッピングした文言を出す
      expect(__mock.messages.errors.some((m) => m.includes('stale target'))).toBe(false);
      expect(__mock.messages.errors.some((m) => m.includes('会話がその後に進んでいる'))).toBe(true);
      const panel = __mock.lastCreatedPanel();
      expect(panel?.disposed).toBe(true);
      expect(
        panel?.webview.sent.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: unknown }).type === 'insertComposerText',
        ),
      ).toBe(false);
    });

    it('途中まで戻ってから失敗した場合はタブを閉じず、不整合な状態であることを会話へ残す（issue #494のレビュー指摘）', async () => {
      const { sessions } = stubStartCapturing();
      vi.spyOn(ClaudeStreamSession.prototype, 'rewindConversationToTurn').mockResolvedValue({
        ok: false,
        prefillText: undefined,
        error: { message: 'stale target', origin: 'cli' },
        succeededCount: 2,
      });
      const { manager } = createManager();

      await manager.openForkFromTurn(
        'origin-session-id',
        '分岐',
        '/workspace/root',
        ['u1', 'u2', 'u3'],
        'u1',
      );

      const panel = __mock.lastCreatedPanel();
      // 途中まで戻った不整合な状態のタブは、ユーザーがやり直せるよう残す（黙って閉じない）
      expect(panel?.disposed).toBe(false);
      expect(
        __mock.messages.errors.some(
          (m) => m.includes('不整合') && m.includes('会話がその後に進んでいる'),
        ),
      ).toBe(true);
      const session = sessions[0];
      if (session === undefined) {
        throw new Error('セッションが記録されていません');
      }
      const items = session.getState().items;
      const warning = items.find((i) => i.id.startsWith('forkFromTurnFailed:'));
      expect(warning).toBeDefined();
      expect(warning?.detail).toContain('不整合');
    });

    it('元のセッションのstartは呼ばない（新しいタブだけを開く）', async () => {
      const startCalls = stubStart();
      vi.spyOn(ClaudeStreamSession.prototype, 'rewindConversationToTurn').mockResolvedValue({
        ok: true,
        prefillText: undefined,
        error: undefined,
        succeededCount: 1,
      });
      const { manager } = createManager();

      await manager.openForkFromTurn('origin-session-id', '分岐', '/workspace/root', ['u1'], 'u1');

      // 開いたのは新しいfork先のタブだけ。元のセッション（origin-session-id）に対する
      // startは呼ばれない
      expect(startCalls).toHaveLength(1);
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
      await flush();

      expect(sessions).toHaveLength(2);
      const firstMessages = stateMessagesOf(firstPanel);
      const firstItems = firstMessages[firstMessages.length - 1]?.state.items ?? [];
      expect(firstItems.some((i) => i.detail === '設定 ・ skillsを読み直しました（1件）')).toBe(
        true,
      );
      const secondMessages = stateMessagesOf(secondPanel);
      const secondItems = secondMessages[secondMessages.length - 1]?.state.items ?? [];
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // Issue #533の時点では chatView.ts 側が state.name !== '' で判定していて挙動が違った
  // （あちらは空白のみの名前をそのまま使った）。Issue #599 でこちらへ揃えたため、
  // これは相違点ではなく両者で同じ挙動になっている
  it('空白のみの名前は空文字扱いとなり、最初の発言から作る（Issue #599でchatView.tsと揃えた）', () => {
    const state = baseState({
      name: '   ',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state)).toBe('Claude Code: 最初の発言');
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

  it('pinnedNameがあれば、人が付けた名前より優先する', () => {
    const state = baseState({
      name: '人が付けた名前',
      items: [{ kind: 'userMessage', id: '1', text: '最初の発言' } as never],
    });
    expect(deriveTitle(state, 'Claude Code: task-3')).toBe('Claude Code: task-3');
  });

  // pinnedNameは`buildSessionPanelTitle`が組み立てた完成形（ラベルを含む）なので、
  // ここでラベルを重ねない
  it('pinnedNameはそのまま使い、ラベルを重ねない', () => {
    expect(deriveTitle(baseState(), 'Claude Code: 衝突解決 task-9')).toBe(
      'Claude Code: 衝突解決 task-9',
    );
  });

  it('pinnedNameが空白のみなら無視して、次の優先度へ落ちる', () => {
    const state = baseState({ name: '人が付けた名前' });
    expect(deriveTitle(state, '   ')).toBe('Claude Code: 人が付けた名前');
  });

  it('pinnedNameが無ければ従来どおりの優先順位（人が手で開いた画面）', () => {
    const state = baseState({
      items: [{ kind: 'userMessage', id: '1', text: '設計を見直したい' } as never],
    });
    expect(deriveTitle(state, undefined)).toBe('Claude Code: 設計を見直したい');
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const lastMessages = stateMessagesOf(panel);
    const lastItems = lastMessages[lastMessages.length - 1]?.state.items ?? [];
    expect(
      lastItems.some((i) => i.detail === 'メモリへ追記しました: /workspace/root/CLAUDE.md'),
    ).toBe(true);
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
    const lastMessages = stateMessagesOf(panel);
    const lastItems = lastMessages[lastMessages.length - 1]?.state.items ?? [];
    expect(
      lastItems.some((i) => i.detail?.includes('リンク先: /home/user/dotfiles/CLAUDE.md')),
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
    expect(__mock.writtenFiles).toEqual([
      { path: '/workspace/root/CLAUDE.md', content: '- note\n' },
    ]);
    const lastMessages = stateMessagesOf(panel);
    const lastItems = lastMessages[lastMessages.length - 1]?.state.items ?? [];
    expect(lastItems.some((i) => i.detail?.includes('実体のパスを特定できません'))).toBe(true);
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
      let seenItems:
        Array<{ candidate: { label: string; path: string; exists: boolean } }> | undefined;
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // 会話項目は差し分で届く（issue #356）ため、`mergeItems`と同じ積み方で
    // 積み直してから最後の状態を見る（`stateMessagesOf`参照）。
    const messages = stateMessagesOf(__mock.lastCreatedPanel());
    const last = messages[messages.length - 1];
    if (last === undefined) {
      throw new Error('state メッセージが送られていません');
    }
    return last.state.items;
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

/**
 * Claude側の`postState`間引き（issue #356）。
 *
 * `onSessionChange`はNDJSONイベント1件ごとに同期的に発火するため、間引きが無いと
 * ストリーミング中は毎回`state.items`全量が構造化クローンで直列化される
 * （Codex側は`STATE_POST_INTERVAL_MS`と`buildItemsDelta`で既に対処済み、issue #246/#262）。
 * ここではCodex側と同じ挙動がClaude側にも入ったことを確かめる。
 */
describe('Claude側のpostState間引きと差分送信（issue #356）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
    // 「タイマーが進むまで送信されない」ことを確認するテストのため、他のdescribeと違い
    // `shouldAdvanceTime` は立てない（実時間が紛れ込むとDate.now()の差が不安定になる）
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openWithSession(): Promise<{
    session: ClaudeStreamSession;
    panel: FakeWebviewPanel;
  }> {
    const { sessions } = stubStartCapturing();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const session = sessions[sessions.length - 1];
    const panel = __mock.lastCreatedPanel();
    if (session === undefined || panel === undefined) {
      throw new Error('セッションかパネルが記録されていません');
    }
    // 最初の1件は間引きに巻き込まれず即座に送られる（`postState`のJSDoc参照）。
    // ここで送信済みにしてから、以降の連続更新の挙動を見る
    session.receive(initLine('session-throttle'));
    return { session, panel };
  }

  it('短時間に連続した状態更新は間引かれ、まとめて1回だけ送られる', async () => {
    const { session, panel } = await openWithSession();
    const sentBefore = panel.webview.sent.length;

    // STATE_POST_INTERVAL_MS未満の間隔で複数件届く（実際のストリーミングを模す）
    session.receive(assistantTextLine('item-a', '1件目'));
    session.receive(assistantTextLine('item-b', '2件目'));

    // タイマーが進むまでは追加の送信が無い（間引かれている）
    expect(panel.webview.sent.length).toBe(sentBefore);

    await flush();

    const stateMessages = panel.webview.sent
      .slice(sentBefore)
      .filter(
        (m): m is StateMessage =>
          typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
      );
    // まとめられて1回だけ送られる（2件がそれぞれ別送信にならない）
    expect(stateMessages.length).toBe(1);
    expect(stateMessages[0]?.items?.mode).toBe('delta');
    expect(stateMessages[0]?.items?.items.map((i) => i.id)).toEqual([
      'item-a:text:0',
      'item-b:text:0',
    ]);
    // 直列化コストを避けるため、`state.items`自体は空で送る
    expect(stateMessages[0]?.state.items).toEqual([]);
  });

  it('間引き中に増えた分も含め、最終状態が必ず送信される（送り漏らしが無い）', async () => {
    const { session, panel } = await openWithSession();

    session.receive(assistantTextLine('item-a', '1件目'));
    await flush();
    session.receive(assistantTextLine('item-b', '2件目'));
    session.receive(assistantTextLine('item-c', '3件目'));
    // ここではまだタイマーを進めない → 直近2件は間引きの予約に乗ったまま
    await flush();

    const messages = stateMessagesOf(panel);
    const last = messages[messages.length - 1];
    expect(last?.state.items.map((i) => i.id)).toEqual([
      'item-a:text:0',
      'item-b:text:0',
      'item-c:text:0',
    ]);
  });

  it('パネルを破棄すると間引きタイマーが解放される（放置されたタイマーが残らない）', async () => {
    const { session, panel } = await openWithSession();

    // 更新を1件だけ届け、間引きの予約（setTimeout）を積ませる
    session.receive(assistantTextLine('item-a', '1件目'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    __mock.lastCreatedPanel()?.dispose();

    // タイマーが解放され、以降どれだけ時間を進めても新しい送信は起きない
    expect(vi.getTimerCount()).toBe(0);
    const sentBefore = panel.webview.sent.length;
    await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS * 5);
    expect(panel.webview.sent.length).toBe(sentBefore);
  });

  it('readyの後、次のflushStateはdeltaではなくmode: fullで送る（issue #420レビュー指摘、HIGH）', async () => {
    const { session, panel } = await openWithSession();
    // webview側の積み先（mergedItems）を実際に進めておく（1件目はすでに送信済み）
    session.receive(assistantTextLine('item-a', '1件目'));
    await flush();
    expect(stateMessagesOf(panel).at(-1)?.items?.mode).toBe('delta');

    // webviewを作り直した（`ready`）。`refreshSettings`はitemsキーを付けずに送るため、
    // webview側のmergedItemsはこの時点では更新されない（`chatScript.ts`の
    // `!data.items`分岐がstate.itemsをそのまま`apply`するだけで、差し分の基準は
    // 進まない）。ホスト側の基準（entry.sentItems）だけ`undefined`へ戻る
    panel.webview.simulateMessage({ type: 'ready' });
    const sentBeforeNextChange = panel.webview.sent.length;

    // ready直後に会話が進む。次のflushStateは「前回との差分」ではなく、
    // entry.sentItemsがundefinedのままであることを根拠に全量（mode: 'full'）を送らないと、
    // webviewの古いmergedItemsを基準にした差分計算がtotal不一致でstateFullの
    // 往復を招く（回帰前の実際の壊れ方）
    session.receive(assistantTextLine('item-b', '2件目'));
    await flush();

    const sentAfterReady = panel.webview.sent.slice(sentBeforeNextChange);
    const stateMessagesAfterReady = sentAfterReady.filter(
      (m): m is StateMessage =>
        typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
    );
    expect(stateMessagesAfterReady.length).toBe(1);
    expect(stateMessagesAfterReady[0]?.items?.mode).toBe('full');
    expect(stateMessagesAfterReady[0]?.items?.items.map((i) => i.id)).toEqual([
      'item-a:text:0',
      'item-b:text:0',
    ]);
  });
});

/**
 * X3（脇道の質問、issue #334）のmanager層配線。
 *
 * X2（会話の途中のターンから分岐、issue #333）は`openForkFromTurn`の配線を上の
 * 「会話の途中のターンから分岐」describeで5件固定しているが、X3は同層のテストが
 * 0件だった（issue #340横断レビュー指摘）。`/btw`のルーティング・
 * `sideQuestionHistory`の蓄積と`capSideQuestionHistory`の実適用・`postCommands`への
 * `/btw`の追加の3点を固定する。
 */
describe('X3: 脇道の質問のmanager層配線（issue #334、issue #340横断レビュー指摘）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
    // 状態送信の間引き（issue #356）を確定的に進めるため
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openPanel(): Promise<FakeWebviewPanel> {
    stubStart();
    const { manager } = createManager();
    await manager.openNew('/workspace/root');
    const panel = __mock.lastCreatedPanel();
    if (panel === undefined) {
      throw new Error('パネルが記録されていません');
    }
    return panel;
  }

  it('/btwはCLIへ送らず askSideQuestion を呼び、応答を会話へ1項目として残す（ルーティング）', async () => {
    const askSideQuestion = vi
      .spyOn(ClaudeStreamSession.prototype, 'askSideQuestion')
      .mockResolvedValue({
        ok: true,
        response: '午後3時です',
        synthetic: false,
        refusalFallback: undefined,
        error: undefined,
      });
    const panel = await openPanel();

    panel.webview.simulateMessage({ type: 'send', text: '/btw 今何時？' });
    await flush();

    expect(askSideQuestion).toHaveBeenCalledTimes(1);
    expect(askSideQuestion.mock.calls[0]?.[0]).toBe('今何時？');
    const items = stateMessagesOf(panel).at(-1)?.state.items ?? [];
    expect(items.some((i) => i.text?.includes('午後3時です'))).toBe(true);
  });

  it('sideQuestionHistoryは送るたびに蓄積し、capSideQuestionHistoryでMAX_SIDE_QUESTION_HISTORY件を超えない', async () => {
    let callCount = 0;
    const askSideQuestion = vi
      .spyOn(ClaudeStreamSession.prototype, 'askSideQuestion')
      .mockImplementation(async () => {
        callCount += 1;
        return {
          ok: true,
          response: `応答${callCount}`,
          synthetic: false,
          refusalFallback: undefined,
          error: undefined,
        };
      });
    const panel = await openPanel();

    const total = MAX_SIDE_QUESTION_HISTORY + 3;
    for (let i = 1; i <= total; i += 1) {
      panel.webview.simulateMessage({ type: 'send', text: `/btw 質問${i}` });
      await flush();
    }

    expect(askSideQuestion).toHaveBeenCalledTimes(total);
    // 最後の呼び出しに渡ったhistoryは、直前まで（total-1件）の応答が
    // capSideQuestionHistoryでMAX_SIDE_QUESTION_HISTORY件へ切り詰められている
    const lastCallHistory = askSideQuestion.mock.calls[total - 1]?.[1] as
      readonly SideQuestionHistoryEntry[] | undefined;
    expect(lastCallHistory).toHaveLength(MAX_SIDE_QUESTION_HISTORY);
    // 古いものから捨てられ（FIFO）、直近の質問だけが残る
    expect(lastCallHistory?.[0]?.question).toBe(`質問${total - MAX_SIDE_QUESTION_HISTORY}`);
    expect(lastCallHistory?.[lastCallHistory.length - 1]?.question).toBe(`質問${total - 1}`);
  });

  it('postCommandsが送る候補一覧に、CLIの一覧に無い/btwを足す', async () => {
    const panel = await openPanel();
    const sentBefore = panel.webview.sent.length;

    panel.webview.simulateMessage({ type: 'ready' });
    await flush();

    const commandsMessage = panel.webview.sent
      .slice(sentBefore)
      .find(
        (m): m is { type: string; commands: { name: string }[] } =>
          typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'commands',
      );
    expect(commandsMessage).toBeDefined();
    expect(commandsMessage?.commands.some((c) => c.name === 'btw')).toBe(true);
  });
});

describe('handoffToNewSession（issue #694）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('アクティブなタブが無ければ何もしない', async () => {
    const { manager } = createManager();
    await manager.handoffToNewSession();
    expect(__mock.messages.errors).toHaveLength(0);
  });

  it('transcriptが解決できれば、新セッションへ固定文言とパスを送る', async () => {
    stubStartCapturing();
    const sendSpy = vi
      .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
      .mockReturnValue('sent');
    const store = fakeStore({ resolveTranscriptPath: async () => '/home/user/.claude/x.jsonl' });
    const { manager } = createManager({ store });
    await manager.openNew('/workspace/root');

    await manager.handoffToNewSession();

    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/.claude/x.jsonl'),
      [],
    );
    // 新セッションが増えている（元のタブ+新タブ）
    expect(__mock.createdPanels.length).toBe(2);
  });

  it('transcriptが解決できなければ、短時間リトライ後にエラー通知して新セッションを作らない', async () => {
    stubStartCapturing();
    const sendSpy = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    const store = fakeStore({ resolveTranscriptPath: async () => undefined });
    const { manager } = createManager({ store });
    await manager.openNew('/workspace/root');
    const panelsBefore = __mock.createdPanels.length;

    const handoff = manager.handoffToNewSession();
    await vi.runAllTimersAsync();
    await handoff;

    expect(sendSpy).not.toHaveBeenCalled();
    expect(__mock.createdPanels.length).toBe(panelsBefore);
    expect(__mock.messages.errors).toContainEqual(
      expect.stringContaining('transcriptが見つかりませんでした'),
    );
  });
});
