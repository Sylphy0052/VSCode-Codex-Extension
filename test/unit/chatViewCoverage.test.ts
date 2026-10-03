import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager, confirmGenerateAgentsFile, deriveTitle } from '../../src/view/chatView';
import { readChatLimitAutoResumeEnabled, readReflexEnabled } from '../../src/config';
import { STATE_POST_INTERVAL_MS } from '../../src/view/chatShared';
import type { ChatState } from '../../src/appserver/chatState';
import type { ChatSession } from '../../src/appserver/chatSession';
import type { TaskSession, TaskSessionInput } from '../../src/orchestrator/taskSession';
import * as vscode from 'vscode';
import { __mock } from '../mocks/vscode';
import {
  fakeConnectionFactory,
  type FakeAppServerConnection,
} from '../helpers/fakeAppServerConnection';

/**
 * `src/view/chatView.ts` の行カバレッジを埋める補完テスト（Issue #1854）。
 * 既存の `chatViewManager.test.ts` と同じフェイク（接続・vscode・設定）で、
 * webviewメッセージの配線・周辺コマンド・通知の振り分けなど、未検証だった経路を確かめる。
 */

const loggedErrors: string[] = [];
const loggedWarnings: string[] = [];
const loggedInfos: string[] = [];
const fakeLogger: Logger = {
  info: (m) => void loggedInfos.push(m),
  warn: (m) => void loggedWarnings.push(m),
  error: (m) => void loggedErrors.push(m),
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

const fakeScanPort: FileScanPort = {
  scan: async () => [],
  readText: async () => undefined,
};

function fakeSettingsProvider(
  overrides: Record<string, unknown> = {},
  updates: unknown[][] = [],
): SettingsProvider {
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
    update: async (...args: unknown[]) => {
      updates.push(args);
      return true;
    },
    updateApprovalLevel: async (...args: unknown[]) => {
      updates.push(['approvalLevel', ...args]);
      return true;
    },
    ...overrides,
  };
  return settings as unknown as SettingsProvider;
}

/** `afterEach`で消す使い捨てディレクトリ。 */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'codex-cov-'));
  tempDirs.push(dir);
  return dir;
}

interface ManagerOptions {
  settings?: SettingsProvider;
  revealImportSection?: () => void | Promise<void>;
  onActivity?: (activity: unknown) => void;
  isTaskManagedThread?: (threadId: string) => boolean;
}

function createManager(options: ManagerOptions = {}): {
  manager: ChatViewManager;
  connection: FakeAppServerConnection;
} {
  const { factory, connection } = fakeConnectionFactory();
  const manager = new ChatViewManager(
    () => 'codex',
    options.settings ?? fakeSettingsProvider(),
    '/fake/codex-home',
    fakeFileSystem,
    new FileMentionCatalog(fakeScanPort),
    fakeLogger,
    options.onActivity ?? (() => undefined),
    options.isTaskManagedThread ?? (() => false),
    options.revealImportSection ?? (() => undefined),
    factory,
    undefined,
    undefined,
    makeTempDir(),
  );
  return { manager, connection: connection() };
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function flushStatePosts(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

interface OpenedChat {
  manager: ChatViewManager;
  connection: FakeAppServerConnection;
  panel: NonNullable<ReturnType<typeof __mock.lastCreatedPanel>>;
  threadId: string;
  /** webviewから届いたふりをして、完了まで待つ。 */
  post: (message: unknown) => Promise<void>;
  /** 内部のパネル（entry）のセッション。 */
  session: () => ChatSession;
}

async function openChat(
  options: ManagerOptions = {},
  threadId = 'thread-A',
  startExtra: Record<string, unknown> = {},
): Promise<OpenedChat> {
  const { manager, connection } = createManager(options);
  const p = manager.openNew('/workspace/root');
  await tick();
  connection.resolveFirst('thread/start', { thread: { id: threadId }, ...startExtra });
  await p;
  const panel = __mock.lastCreatedPanel();
  if (panel === undefined) throw new Error('パネルが作られていない');
  return {
    manager,
    connection,
    panel,
    threadId,
    post: (message) => manager.simulateWebviewMessage(threadId, message),
    session: () =>
      (manager as unknown as { panels: Map<string, { session: ChatSession }> }).panels.get(
        threadId,
      )!.session,
  };
}

function sentOfType(chat: OpenedChat, type: string): Array<Record<string, unknown>> {
  return (chat.panel.webview.sent as Array<Record<string, unknown>>).filter(
    (m) => m['type'] === type,
  );
}

function requestsOf(chat: OpenedChat, method: string): Array<{ params: unknown }> {
  return chat.connection.requests.filter((r) => r.method === method);
}

function stateOf(chat: OpenedChat): ChatState {
  return chat.session().getState();
}

describe('chatView.ts の補完カバレッジ', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('codex', {});
    loggedErrors.length = 0;
    loggedWarnings.length = 0;
    loggedInfos.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    // 途中のexpectが落ちてもspyを持ち越さない（__mock.reset()はspyを戻さない）
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('単体の関数', () => {
    it('confirmGenerateAgentsFile は「更新する」を選んだときだけ true を返す', async () => {
      __mock.showWarningMessageAnswer = '更新する';
      await expect(confirmGenerateAgentsFile()).resolves.toBe(true);
      __mock.showWarningMessageAnswer = undefined;
      await expect(confirmGenerateAgentsFile()).resolves.toBe(false);
    });

    it('deriveTitle は固定名があればそれを、無ければ undefined を返す', () => {
      const state = { name: undefined, items: [] } as unknown as ChatState;
      expect(deriveTitle(state, '手で付けた名前')).toBe('手で付けた名前');
      expect(deriveTitle(state)).toBeUndefined();
    });
  });

  describe('webviewメッセージ: 設定の切り替え', () => {
    it.each([
      ['toggleLoopEngineering', 'loopEngineering'],
      ['toggleLoopAdvisor', 'loopAdvisor'],
      ['toggleTurnSummary', 'turnSummary'],
      ['toggleProsCons', 'prosCons'],
      ['toggleEndSummary', 'endSummary'],
    ])('%s は設定を反転して %s を返し、もう一度押すと元に戻る', async (type, replyType) => {
      const chat = await openChat();
      await chat.post({ type });
      await chat.post({ type });
      const replies = sentOfType(chat, replyType);
      expect(replies).toHaveLength(2);
      expect(replies[0]?.['enabled']).toBe(!replies[1]?.['enabled']);
    });

    it('toggleLimitAutoResume は設定を反転する（拡張が読む値が変わる）', async () => {
      const chat = await openChat();
      const before = readChatLimitAutoResumeEnabled();
      await chat.post({ type: 'toggleLimitAutoResume' });
      expect(readChatLimitAutoResumeEnabled()).toBe(!before);
    });

    it('toggleReflex は設定を反転する', async () => {
      const chat = await openChat();
      const before = readReflexEnabled();
      await chat.post({ type: 'toggleReflex' });
      expect(readReflexEnabled()).toBe(!before);
    });

    it('toggleFavorite は例外なく通る', async () => {
      const chat = await openChat();
      await expect(chat.post({ type: 'toggleFavorite' })).resolves.toBeUndefined();
    });

    it('approvalLevel は有効な段階だけ設定へ渡し、無効な値は無視して設定を再送する', async () => {
      const updates: unknown[][] = [];
      const chat = await openChat({ settings: fakeSettingsProvider({}, updates) });
      await chat.post({ type: 'approvalLevel', level: 'bogus-level' });
      expect(updates).toHaveLength(0);
      await chat.post({ type: 'approvalLevel', level: 'full' });
      expect(updates.some((u) => u[0] === 'approvalLevel' && u[1] === 'codex')).toBe(true);
    });

    it('config は編集できるキーだけを設定へ渡す', async () => {
      const updates: unknown[][] = [];
      const chat = await openChat({ settings: fakeSettingsProvider({}, updates) });
      await chat.post({ type: 'config', key: 'sandbox', value: 'read-only' });
      expect(updates).toEqual([['sandbox', 'read-only']]);
      await chat.post({ type: 'config', key: 'notAKey', value: 'x' });
      await chat.post({ type: 'config', key: 'sandbox', value: 123 });
      expect(updates).toHaveLength(1);
    });
  });

  /** `send` を送り、`turn/start` の応答を返して完了まで待つ。 */
  async function sendText(chat: OpenedChat, text: string): Promise<void> {
    const sending = chat.post({ type: 'send', text });
    await tick(10);
    chat.connection.resolveFirst('turn/start', {});
    await sending;
  }

  describe('webviewメッセージ: 送信とキュー', () => {
    it('send は空文字を無視し、本文があれば turn/start を送って作業記録へ通知する', async () => {
      const activities: unknown[] = [];
      const chat = await openChat({ onActivity: (a) => activities.push(a) });

      await chat.post({ type: 'send', text: '   ' });
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);

      await sendText(chat, 'テストを直して');
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('テストを直して');
      expect(activities).toEqual([
        { sessionId: 'thread-A', cwd: '/workspace/root', kind: 'prompt', text: 'テストを直して' },
      ]);
      expect(stateOf(chat).busy).toBe(true);
    });

    it('応答中の send は待ち行列へ積み、取り出す・取り消すで元に戻る', async () => {
      const chat = await openChat();
      await sendText(chat, '最初の指示');
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });

      await chat.post({ type: 'send', text: '二つ目' });
      expect(stateOf(chat).queued.map((q) => q.text)).toEqual(['二つ目']);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(1);

      await chat.post({ type: 'popLastQueuedForInput' });
      expect(stateOf(chat).queued).toHaveLength(0);
      expect(sentOfType(chat, 'restoreQueuedText').map((m) => m['text'])).toEqual(['二つ目']);

      // 空のときは何も返さない
      await chat.post({ type: 'popLastQueuedForInput' });
      expect(sentOfType(chat, 'restoreQueuedText')).toHaveLength(1);

      await chat.post({ type: 'send', text: '三つ目' });
      await chat.post({ type: 'cancelQueued', index: 0 });
      expect(stateOf(chat).queued).toHaveLength(0);
    });

    it('sendQueued と flushQueue は進行中のターンへ turn/steer で割り込む', async () => {
      const chat = await openChat();
      await sendText(chat, '最初の指示');
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });
      await chat.post({ type: 'send', text: '追加A' });
      await chat.post({ type: 'send', text: '追加B' });

      const first = chat.post({ type: 'sendQueued', index: 0 });
      await tick(10);
      chat.connection.resolveFirst('turn/steer', {});
      await first;
      expect(stateOf(chat).queued.map((q) => q.text)).toEqual(['追加B']);

      const second = chat.post({ type: 'flushQueue' });
      await tick(10);
      chat.connection.resolveFirst('turn/steer', {});
      await second;
      expect(stateOf(chat).queued).toHaveLength(0);
      const steers = requestsOf(chat, 'turn/steer');
      expect(steers).toHaveLength(2);
      expect(JSON.stringify(steers[0]?.params)).toContain('追加A');
      expect(JSON.stringify(steers[1]?.params)).toContain('追加B');
    });

    it('interrupt は進行中のターンへ turn/interrupt を送る', async () => {
      const chat = await openChat();
      await sendText(chat, '長い作業');
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });

      const interrupting = chat.post({ type: 'interrupt' });
      await tick(10);
      chat.connection.resolveFirst('turn/interrupt', {});
      await interrupting;
      expect(requestsOf(chat, 'turn/interrupt')).toHaveLength(1);
      expect(JSON.stringify(requestsOf(chat, 'turn/interrupt')[0]?.params)).toContain('turn-1');
    });

    it('compact は確認が通ったときだけ thread/compact/start を送る', async () => {
      const chat = await openChat();
      __mock.showWarningMessageAnswer = undefined;
      await chat.post({ type: 'compact' });
      expect(requestsOf(chat, 'thread/compact/start')).toHaveLength(0);

      __mock.showWarningMessageAnswer = '圧縮する';
      const compacting = chat.post({ type: 'compact' });
      await tick(10);
      chat.connection.resolveFirst('thread/compact/start', {});
      await compacting;
      expect(requestsOf(chat, 'thread/compact/start')).toHaveLength(1);
    });

    it('send の擬似コマンド /compact は引数を無視して圧縮する', async () => {
      const chat = await openChat();
      __mock.showWarningMessageAnswer = '圧縮する';
      const compacting = chat.post({ type: 'send', text: '/compact 余計な引数' });
      await tick(10);
      chat.connection.resolveFirst('thread/compact/start', {});
      await compacting;
      expect(requestsOf(chat, 'thread/compact/start')).toHaveLength(1);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
      expect(loggedWarnings.some((w) => w.includes('余計な引数'))).toBe(true);
    });

    it('send の擬似コマンド /btw は質問が空ならエラーを出し、会話へは何も送らない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'send', text: '/btw' });
      expect(__mock.messages.errors.some((e) => String(e).includes('脇道の質問を入力'))).toBe(true);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
    });

    it('send の擬似コマンド /init は AGENTS.md の指示文を送る', async () => {
      const activities: unknown[] = [];
      const chat = await openChat({ onActivity: (a) => activities.push(a) });
      const sending = chat.post({ type: 'send', text: '/init' });
      await tick(10);
      chat.connection.resolveFirst('turn/start', {});
      await sending;
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('AGENTS.md');
      expect(activities).toHaveLength(1);
    });

    it('send の擬似コマンド /clear は会話を閉じて新しい会話を開く', async () => {
      const chat = await openChat();
      const before = __mock.createdPanels.length;
      const clearing = chat.post({ type: 'send', text: '/clear' });
      await tick(10);
      chat.connection.resolveFirst('thread/start', { thread: { id: 'thread-B' } });
      await clearing;
      expect(__mock.createdPanels.length).toBe(before + 1);
      expect(chat.manager.isOpen('thread-A')).toBe(false);
      expect(chat.manager.isOpen('thread-B')).toBe(true);
    });

    it('attach は添付を状態へ載せ、removeAttachment で外せる', async () => {
      const chat = await openChat();
      await chat.post({
        type: 'attach',
        name: 'a.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      });
      await flushStatePosts();
      const attachmentsOf = (): Array<{ id: string }> => {
        const states = sentOfType(chat, 'state');
        const last = states[states.length - 1]?.['state'] as { attachments: Array<{ id: string }> };
        return last.attachments;
      };
      expect(attachmentsOf()).toHaveLength(1);
      const id = attachmentsOf()[0]!.id;

      await chat.post({ type: 'removeAttachment', id });
      await flushStatePosts();
      expect(attachmentsOf()).toHaveLength(0);
    });

    it('添付だけでも send は通り、dropRejected は例外なく終わる', async () => {
      const chat = await openChat();
      await chat.post({
        type: 'attach',
        name: 'a.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      });
      await chat.post({ type: 'dropRejected', kind: 'folder' });
      await sendText(chat, '');
      expect(requestsOf(chat, 'turn/start')).toHaveLength(1);
    });
  });

  describe('webviewメッセージ: モードと拡張コマンド', () => {
    it('planMode は開始時の権限を読めていないとエラーにして入らない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'planMode', on: true });
      expect(stateOf(chat).planMode).toBe(false);
      expect(__mock.messages.errors.some((e) => String(e).includes('計画モードに入れません'))).toBe(
        true,
      );
    });

    it('planMode は権限を読めていれば入って抜けられる', async () => {
      const chat = await openChat({}, 'thread-A', {
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
      });
      await chat.post({ type: 'planMode', on: true });
      expect(stateOf(chat).planMode).toBe(true);
      await chat.post({ type: 'planMode', on: false });
      expect(stateOf(chat).planMode).toBe(false);
    });

    it('autoHandoff / autoHandoffAutoApprove は状態へ反映される', async () => {
      const chat = await openChat();

      await chat.post({ type: 'autoHandoff', on: true });
      expect(stateOf(chat).autoHandoff).toBe(true);
      await chat.post({ type: 'autoHandoffAutoApprove', on: true });
      expect(stateOf(chat).autoHandoffAutoApprove).toBe(true);
      await chat.post({ type: 'autoHandoff', on: false });
      expect(stateOf(chat).autoHandoff).toBe(false);
    });

    it('autoReply は ON で状態へ反映し、OFF で止める', async () => {
      const chat = await openChat();
      await chat.post({ type: 'autoReply', on: true });
      expect(stateOf(chat).autoReply).toBeTruthy();
      await chat.post({ type: 'autoReply', on: false });
      expect(stateOf(chat).autoReply).toBeFalsy();
    });

    it.each([
      ['workflowMenu', 'agent.workflows.menu'],
      ['teamWorkflow', 'agent.workflows.team'],
      ['workflowView', 'agent.workflows.view'],
      ['sessionKanban', 'agent.sessionKanban'],
      ['forgeHub', 'agent.forgeHub'],
      ['orchestratorMode', 'agent.taskRun.start'],
      ['openProgress', 'agent.openProgress'],
    ])('%s は %s を実行する', async (type, command) => {
      const chat = await openChat();
      await chat.post({ type });
      expect(__mock.executedCommands).toContain(command);
    });

    it('localReview は agent.localReview.start を実行する', async () => {
      const chat = await openChat();
      await chat.post({ type: 'localReview' });
      expect(__mock.executedCommands).toContain('agent.localReview.start');
    });

    it('claudeImport は設定のインポート欄を開く', async () => {
      const revealImportSection = vi.fn();
      const chat = await openChat({ revealImportSection });
      await chat.post({ type: 'claudeImport' });
      expect(revealImportSection).toHaveBeenCalledTimes(1);
    });
  });

  /** 保留中の要求が出るまで待って応答する（連鎖する要求を順に返すため）。 */
  async function answer(chat: OpenedChat, method: string, result: unknown): Promise<void> {
    await tick(20);
    chat.connection.resolveFirst(method, result);
  }

  describe('webviewメッセージ: 承認・問い合わせ・ループ', () => {
    it('approve は保留中の承認要求を、選んだ決定で解決する', async () => {
      const chat = await openChat();
      const responded = chat.connection.serverRequest(11, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root',
      });
      await tick();
      expect(stateOf(chat).approvals).toHaveLength(1);

      await chat.post({ type: 'approve', requestId: 11, decision: 'accept' });
      await expect(responded).resolves.toEqual({ decision: 'accept' });
      expect(stateOf(chat).approvals).toHaveLength(0);
    });

    it('approve は不正な決定や requestId の欠けを無視する', async () => {
      const chat = await openChat();
      const responded = chat.connection.serverRequest(12, 'item/commandExecution/requestApproval', {
        threadId: 'thread-A',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root',
      });
      await tick();
      await chat.post({ type: 'approve', requestId: 12, decision: 'bogus' });
      await chat.post({ type: 'approve', decision: 'accept' });
      expect(stateOf(chat).approvals).toHaveLength(1);
      await chat.post({ type: 'approve', requestId: 12, decision: 'decline' });
      await expect(responded).resolves.toEqual({ decision: 'decline' });
    });

    it('prompt は画面の回答を読み、問い合わせを閉じて応答する', async () => {
      const chat = await openChat();
      const responded = chat.connection.serverRequest(21, 'item/tool/requestUserInput', {
        threadId: 'thread-A',
        itemId: 'i1',
        turnId: 'turn-1',
        questions: [
          {
            id: 'q1',
            header: '色',
            question: '好きな色は？',
            isOther: false,
            isSecret: false,
            options: [{ label: '赤', description: '' }],
          },
        ],
      });
      await tick();
      expect(stateOf(chat).prompts).toHaveLength(1);

      // 型の合わない回答は読み捨てられ、問い合わせは残る
      await chat.post({ type: 'prompt', requestId: 21, submission: { action: 'bogus' } });
      await chat.post({ type: 'prompt', submission: { action: 'cancel' } });
      expect(stateOf(chat).prompts).toHaveLength(1);

      await chat.post({
        type: 'prompt',
        requestId: 21,
        submission: { action: 'submit', values: { q1: ['赤', 3], bad: 'x' } },
      });
      await expect(responded).resolves.toEqual({ answers: { q1: { answers: ['赤'] } } });
      expect(stateOf(chat).prompts).toHaveLength(0);
    });

    it('loop/start は計画が不正ならエラーを出し、正しければ初回の指示を送る', async () => {
      const chat = await openChat();
      await chat.post({ type: 'loop/start', plan: { initialPrompt: '', continuePrompt: '' } });
      expect(
        __mock.messages.errors.some((e) => String(e).includes('ループの継続指示と最大回数')),
      ).toBe(true);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);

      await chat.post({
        type: 'loop/start',
        plan: { initialPrompt: '最初の指示', continuePrompt: '続けて', maxIterations: 2 },
      });
      await tick(20);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('最初の指示');
      expect(loggedInfos.some((m) => m.includes('ループ開始: 最大2回'))).toBe(true);
    });

    it('loop/stop はループを止める', async () => {
      const chat = await openChat();
      await chat.post({
        type: 'loop/start',
        plan: { initialPrompt: '最初の指示', continuePrompt: '続けて', maxIterations: 3 },
      });
      await tick(20);
      await chat.post({ type: 'loop/stop' });
      await flushStatePosts();
      const states = sentOfType(chat, 'state');
      const loop = (states[states.length - 1]?.['state'] as { loop: { running: boolean } }).loop;
      expect(loop.running).toBe(false);
    });

    it('loop/planGoal はゴールの下書きの応答を必ず1回返す', async () => {
      const chat = await openChat();
      await chat.post({ type: 'loop/planGoal', id: 7, text: '' });
      const replies = sentOfType(chat, 'loop/goalDraft');
      expect(replies).toHaveLength(1);
      expect(replies[0]?.['id']).toBe(7);
    });
  });

  describe('webviewメッセージ: 分岐・書き直し・再開', () => {
    it('fork は分岐先のスレッドを開く', async () => {
      const chat = await openChat();
      const forking = chat.post({ type: 'fork', turnId: 'turn-1' });
      await answer(chat, 'thread/fork', { thread: { id: 'thread-B' } });
      await answer(chat, 'thread/resume', { thread: { id: 'thread-B', turns: [] } });
      await forking;
      expect(JSON.stringify(requestsOf(chat, 'thread/fork')[0]?.params)).toContain('turn-1');
      expect(chat.manager.isOpen('thread-B')).toBe(true);
      expect(sentOfType(chat, 'forkFailed')).toHaveLength(0);
    });

    it('editResend は turnId が無ければ新しい会話を開いて書き直した指示を送る', async () => {
      const activities: unknown[] = [];
      const chat = await openChat({ onActivity: (a) => activities.push(a) });
      const resending = chat.post({ type: 'editResend', text: '書き直した指示' });
      await answer(chat, 'thread/start', { thread: { id: 'thread-B' } });
      await answer(chat, 'turn/start', {});
      await resending;
      expect(chat.manager.isOpen('thread-B')).toBe(true);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('書き直した指示');
      expect(JSON.stringify(starts[0]?.params)).toContain('thread-B');
    });

    it('editResend は空の指示を送らない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'editResend', text: '  ' });
      expect(requestsOf(chat, 'thread/start')).toHaveLength(1);
      expect(requestsOf(chat, 'thread/fork')).toHaveLength(0);
    });

    it('editResend は turnId があれば分岐して、分岐先へ書き直した指示を送る', async () => {
      const chat = await openChat();
      const resending = chat.post({ type: 'editResend', turnId: 'turn-1', text: '修正した指示' });
      await answer(chat, 'thread/fork', { thread: { id: 'thread-B' } });
      await answer(chat, 'thread/resume', { thread: { id: 'thread-B', turns: [] } });
      await answer(chat, 'turn/start', {});
      await resending;
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('thread-B');
      expect(JSON.stringify(starts[0]?.params)).toContain('修正した指示');
    });

    it('editResend のファイル復元は作業ディレクトリ・発言の特定ができないと失敗として報告する', async () => {
      const chat = await openChat();
      await chat.post({ type: 'editResend', text: '直す', restoreFiles: true });
      expect(
        __mock.messages.errors.some((e) =>
          String(e).includes('復元対象の発言または作業ディレクトリ'),
        ),
      ).toBe(true);
      await chat.post({
        type: 'editResend',
        text: '直す',
        restoreFiles: true,
        messageId: 'no-such-message',
        turnId: 'turn-1',
      });
      expect(
        __mock.messages.errors.some((e) =>
          String(e).includes('会話とファイルの戻り先が一致しません'),
        ),
      ).toBe(true);
    });

    it('resume の失敗は理由を出して復元失敗の状態にする', async () => {
      const chat = await openChat();
      const resuming = chat.post({ type: 'resume' });
      await tick(20);
      chat.connection.rejectFirst('thread/resume', 'no rollout found for thread id thread-A');
      await resuming;
      expect(stateOf(chat).restore?.state).toBe('failed');
      expect(__mock.messages.errors).toHaveLength(1);
    });

    it('resume は読み込み中の会話には重ねて要求しない', async () => {
      const chat = await openChat();
      const first = chat.post({ type: 'resume' });
      await tick(20);
      expect(stateOf(chat).restore?.state).toBe('loading');
      await chat.post({ type: 'resume' });
      expect(requestsOf(chat, 'thread/resume')).toHaveLength(1);
      chat.connection.rejectFirst('thread/resume', 'boom');
      await first;
    });
  });

  describe('webviewメッセージ: ファイル・URL・出力', () => {
    it('requestFiles は @ 候補を files で返し、query が文字列でなければ返さない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'requestFiles', query: 'src' });
      expect(sentOfType(chat, 'files')).toEqual([{ type: 'files', query: 'src', files: [] }]);
      await chat.post({ type: 'requestFiles', query: 5 });
      expect(sentOfType(chat, 'files')).toHaveLength(1);
    });

    it('requestImage は会話に無いパスの画像を返さない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'requestImage', path: '/etc/passwd' });
      expect(sentOfType(chat, 'imageData')).toHaveLength(0);
    });

    it('openUrl は https を外部ブラウザへ渡し、javascript: は渡さない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'openUrl', url: 'https://example.com/docs' });
      expect(__mock.openedExternalUris).toHaveLength(1);
      await chat.post({ type: 'openUrl', url: 'javascript:alert(1)' });
      await chat.post({ type: 'openUrl', url: 'command:workbench.action.reloadWindow' });
      expect(__mock.openedExternalUris).toHaveLength(1);
      expect(__mock.executedCommands).not.toContain('workbench.action.reloadWindow');
    });

    it('insertCode は選択範囲ごとに差し替え、エディタが無ければ案内する', async () => {
      const chat = await openChat();
      const replaced: unknown[][] = [];
      const editor = {
        selections: ['選択1', '選択2'],
        edit: async (callback: (builder: { replace: (...args: unknown[]) => void }) => void) => {
          callback({ replace: (...args: unknown[]) => void replaced.push(args) });
          return true;
        },
      };
      const spy = vi.spyOn(vscode.window, 'activeTextEditor', 'get');
      spy.mockReturnValue(editor as never);
      await chat.post({ type: 'insertCode', code: 'const a = 1;' });
      expect(replaced).toEqual([
        ['選択1', 'const a = 1;'],
        ['選択2', 'const a = 1;'],
      ]);

      spy.mockReturnValue(undefined);
      await chat.post({ type: 'insertCode', code: 'const a = 1;' });
      expect(__mock.messages.infos).toContain('挿入先のエディタが開かれていません');
    });

    it('openCodeFile は保存前の文書としてコードを開く', async () => {
      const chat = await openChat();
      await chat.post({ type: 'openCodeFile', code: 'print(1)', lang: 'python' });
      expect(__mock.untitledDocumentContents).toEqual(['print(1)']);
    });

    it('exportTranscript は会話が空なら取り出せないと案内する', async () => {
      const chat = await openChat();
      await chat.post({ type: 'exportTranscript' });
      expect(__mock.messages.infos).toContain('会話がまだ無いため取り出せません');
    });

    it('openItemOutput は退避された全文が無ければ警告し、itemId が無ければ何もしない', async () => {
      const chat = await openChat();
      await chat.post({ type: 'openItemOutput', itemId: 'item-1' });
      expect(__mock.messages.warnings.some((w) => w.includes('ツール出力の全文を読めません'))).toBe(
        true,
      );
      const before = __mock.messages.warnings.length;
      await chat.post({ type: 'openItemOutput' });
      expect(__mock.messages.warnings).toHaveLength(before);
    });

    it('存在しない差分を指す openDiffFile / openDiffEditor / revertDiff は何も起こさない', async () => {
      const chat = await openChat();
      for (const type of ['openDiffFile', 'openDiffEditor', 'revertDiff']) {
        await chat.post({ type, itemId: 'ghost', diffIndex: 0 });
      }
      expect(__mock.executedCommands).not.toContain('agent.localReview.registerDiff');
      expect(__mock.messages.warnings).toHaveLength(0);
      expect(loggedErrors).toHaveLength(0);
    });
  });

  describe('webviewメッセージ: 設定・画面の再構築', () => {
    it('config の model は会話ごとの設定へ入れて状態を再送する（共有設定は更新しない）', async () => {
      const updates: unknown[][] = [];
      const chat = await openChat({ settings: fakeSettingsProvider({}, updates) });
      await chat.post({ type: 'config', key: 'model', value: 'gpt-x' });
      await chat.post({ type: 'config', key: 'reasoningEffort', value: 'high' });
      await flushStatePosts();
      expect(updates).toHaveLength(0);
      const states = sentOfType(chat, 'state');
      expect(states.length).toBeGreaterThan(0);
    });

    it('stateFull は差し分ではなく会話の全量を送り直す', async () => {
      const chat = await openChat();
      await sendText(chat, '最初の指示');
      chat.connection.notify('item/completed', {
        threadId: 'thread-A',
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '最初の指示' }] },
      });
      await flushStatePosts();
      const before = sentOfType(chat, 'state').length;
      await chat.post({ type: 'stateFull' });
      const states = sentOfType(chat, 'state');
      expect(states.length).toBe(before + 1);
      const last = states[states.length - 1] as {
        items: { mode: string; items: Array<{ kind: string }> };
      };
      expect(last.items.mode).toBe('full');
      expect(last.items.items.some((i) => i.kind === 'userMessage')).toBe(true);
    });

    it('ready は設定・ループの自動ゴール・お気に入り・入力候補を送り直す', async () => {
      const chat = await openChat();
      const loading = chat.post({ type: 'ready' });
      await answer(chat, 'skills/list', {
        data: [
          {
            cwd: '/workspace/root',
            skills: [{ name: 'my-skill', description: '手順書', enabled: true, path: '/s' }],
            errors: [],
          },
        ],
      });
      await loading;
      expect(sentOfType(chat, 'loopAutoGoal')).toHaveLength(1);
      const commands = sentOfType(chat, 'commands');
      expect(commands).toHaveLength(1);
      const names = (commands[0]?.['commands'] as Array<{ name: string }>).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['compact', 'init', 'btw', 'clear']));
    });

    it('ready はスキル一覧を取れなくても擬似コマンドだけは候補に出す', async () => {
      const chat = await openChat();
      const loading = chat.post({ type: 'ready' });
      await tick(20);
      chat.connection.rejectFirst('skills/list', 'unavailable');
      await loading;
      const commands = sentOfType(chat, 'commands');
      expect(commands).toHaveLength(1);
      const names = (commands[0]?.['commands'] as Array<{ name: string }>).map((c) => c.name);
      expect(names).toContain('compact');
      expect(loggedWarnings.some((w) => w.includes('スキル一覧を取得できませんでした'))).toBe(true);
    });
  });

  /** レビューの2回のQuickPickへ、対象と出し先を順に答える。 */
  function answerReviewPicks(targetKind: string, delivery: string | undefined): void {
    __mock.showQuickPickAnswer = (items) => {
      const list = items as Array<Record<string, unknown>>;
      if (list.some((i) => 'targetKind' in i)) {
        return list.find((i) => i['targetKind'] === targetKind);
      }
      return delivery === undefined ? undefined : list.find((i) => i['delivery'] === delivery);
    };
  }

  describe('レビュー', () => {
    it('対象の選択をやめたら review/start を送らない', async () => {
      const chat = await openChat();
      __mock.showQuickPickAnswer = () => undefined;
      await chat.post({ type: 'review' });
      expect(requestsOf(chat, 'review/start')).toHaveLength(0);
    });

    it('未コミットの変更を会話の中でレビューすると review/start を送り、busy にする', async () => {
      const chat = await openChat();
      answerReviewPicks('uncommittedChanges', 'inline');
      const reviewing = chat.post({ type: 'review' });
      await tick(20);
      const starts = requestsOf(chat, 'review/start');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params).toMatchObject({
        threadId: 'thread-A',
        target: { type: 'uncommittedChanges' },
      });
      expect(stateOf(chat).busy).toBe(true);
      chat.connection.resolveFirst('review/start', { reviewThreadId: 'thread-A' });
      await reviewing;
      expect(loggedInfos.some((m) => m.includes('レビューを開始しました: thread-A (inline)'))).toBe(
        true,
      );
    });

    it('自由記述の指示文をレビュー対象として渡す', async () => {
      const chat = await openChat();
      answerReviewPicks('custom', 'inline');
      __mock.showInputBoxAnswer = '例外処理だけ見て';
      const reviewing = chat.post({ type: 'review' });
      await tick(20);
      expect(JSON.stringify(requestsOf(chat, 'review/start')[0]?.params)).toContain(
        '例外処理だけ見て',
      );
      chat.connection.resolveFirst('review/start', { reviewThreadId: 'thread-A' });
      await reviewing;
    });

    it('入力欄をキャンセルすると送らず、読み取れない入力はエラーにして中止する', async () => {
      const chat = await openChat();
      answerReviewPicks('custom', 'inline');
      __mock.showInputBoxAnswer = undefined;
      await chat.post({ type: 'review' });
      expect(requestsOf(chat, 'review/start')).toHaveLength(0);
      expect(__mock.messages.errors).toHaveLength(0);

      __mock.showInputBoxAnswer = '   ';
      await chat.post({ type: 'review' });
      expect(requestsOf(chat, 'review/start')).toHaveLength(0);
      expect(__mock.messages.errors).toContain('レビューの対象を読み取れませんでした');
    });

    it('出し先の選択をやめたら送らない', async () => {
      const chat = await openChat();
      answerReviewPicks('uncommittedChanges', undefined);
      await chat.post({ type: 'review' });
      expect(requestsOf(chat, 'review/start')).toHaveLength(0);
    });

    it('インラインのレビュー開始に失敗するとエラーを出し、busy を戻す', async () => {
      const chat = await openChat();
      answerReviewPicks('uncommittedChanges', 'inline');
      const reviewing = chat.post({ type: 'review' });
      await tick(20);
      chat.connection.rejectFirst('review/start', 'review failed');
      await reviewing;
      expect(stateOf(chat).busy).toBe(false);
      expect(__mock.messages.errors.some((e) => String(e).includes('review failed'))).toBe(true);
    });

    it('別タブのレビューは返ってきたレビュースレッドを thread/resume で開く', async () => {
      const chat = await openChat();
      answerReviewPicks('uncommittedChanges', 'detached');
      const reviewing = chat.post({ type: 'review' });
      await tick(20);
      chat.connection.resolveFirst('review/start', { reviewThreadId: 'thread-R' });
      await tick(30);
      const resumes = requestsOf(chat, 'thread/resume');
      expect(resumes).toHaveLength(1);
      expect(resumes[0]?.params).toMatchObject({ threadId: 'thread-R' });
      chat.connection.resolveFirst('thread/resume', { thread: { id: 'thread-R' } });
      await reviewing;
      expect(loggedInfos.some((m) => m.includes('thread-R (detached)'))).toBe(true);
    });
  });

  describe('名前の変更とクリア', () => {
    it('renameActive は会話が無ければ案内だけを出す', async () => {
      const { manager } = createManager();
      await manager.renameActive();
      expect(__mock.messages.infos).toContain('名前を変更するCodex画面を開いてください');
    });

    it('renameActive は入力した名前を前後を除いて thread/name/set へ送る', async () => {
      const chat = await openChat();
      __mock.showInputBoxAnswer = '  新しい名前  ';
      const renaming = chat.manager.renameActive();
      await tick(20);
      const sets = requestsOf(chat, 'thread/name/set');
      expect(sets).toHaveLength(1);
      expect(sets[0]?.params).toEqual({ threadId: 'thread-A', name: '新しい名前' });
      chat.connection.resolveFirst('thread/name/set', {});
      await renaming;
      expect(stateOf(chat).name).toBe('新しい名前');
    });

    it('renameActive は入力をやめたときと同じ名前のときは何も送らない', async () => {
      const chat = await openChat();
      __mock.showInputBoxAnswer = undefined;
      await chat.manager.renameActive();
      __mock.showInputBoxAnswer = '';
      await chat.manager.renameActive();
      expect(requestsOf(chat, 'thread/name/set')).toHaveLength(0);
    });

    it('renameActive の保存に失敗するとエラーを出す', async () => {
      const chat = await openChat();
      __mock.showInputBoxAnswer = '名前';
      const renaming = chat.manager.renameActive();
      await tick(20);
      chat.connection.rejectFirst('thread/name/set', 'name rejected');
      await renaming;
      expect(__mock.messages.errors.some((e) => String(e).includes('name rejected'))).toBe(true);
    });

    it('clearActive は会話が無ければ案内だけを出す', async () => {
      const { manager } = createManager();
      await manager.clearActive();
      expect(__mock.messages.infos).toContain('クリアするCodex画面を開いてください');
    });

    it('clearActive は待機中の会話を閉じて、同じフォルダで新しい会話を始める', async () => {
      const chat = await openChat();
      const clearing = chat.manager.clearActive();
      await tick(20);
      const starts = requestsOf(chat, 'thread/start');
      expect(starts).toHaveLength(2);
      expect(JSON.stringify(starts[1]?.params)).toContain('/workspace/root');
      chat.connection.resolveFirst('thread/start', { thread: { id: 'thread-B' } });
      await clearing;
      expect(chat.manager.isOpen('thread-A')).toBe(false);
      expect(chat.manager.isOpen('thread-B')).toBe(true);
    });

    it('clearActive は応答の途中で確認を断られたら何も閉じない', async () => {
      const chat = await openChat();
      const sending = chat.post({ type: 'send', text: '作業して' });
      await tick(10);
      chat.connection.resolveFirst('turn/start', {});
      await sending;
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });
      expect(stateOf(chat).busy).toBe(true);

      __mock.showWarningMessageAnswer = undefined;
      await chat.manager.clearActive();
      expect(requestsOf(chat, 'thread/start')).toHaveLength(1);
      expect(chat.manager.isOpen('thread-A')).toBe(true);
    });

    it('入力欄の /clear は引数を無視した旨を記録して会話を作り直す', async () => {
      const chat = await openChat();
      const clearing = chat.post({ type: 'send', text: '/clear 余計な引数' });
      await tick(20);
      expect(loggedWarnings.some((w) => w.includes('余計な引数'))).toBe(true);
      chat.connection.resolveFirst('thread/start', { thread: { id: 'thread-B' } });
      await clearing;
      expect(chat.manager.isOpen('thread-A')).toBe(false);
    });
  });

  describe('使用量とレビュー指摘の送信', () => {
    it('readUsage は account/rateLimits/read の応答を使用量にして返す', async () => {
      const { manager, connection } = createManager();
      const reading = manager.readUsage();
      await tick(20);
      connection.resolveFirst('account/rateLimits/read', {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        },
      });
      const usage = await reading;
      expect(usage).toBeDefined();
      expect(JSON.stringify(usage)).toContain('42');
    });

    it('readUsage は取得に失敗すると警告を残して undefined を返す', async () => {
      const { manager, connection } = createManager();
      const reading = manager.readUsage();
      await tick(20);
      connection.rejectFirst('account/rateLimits/read', 'offline');
      await expect(reading).resolves.toBeUndefined();
      expect(loggedWarnings.some((w) => w.includes('使用量を取得できませんでした'))).toBe(true);
    });

    it('sendReviewFeedback は開いていない会話には送らず sessionUnavailable を返す', async () => {
      const chat = await openChat();
      await expect(chat.manager.sendReviewFeedback('thread-none', '指摘')).resolves.toBe(
        'sessionUnavailable',
      );
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
    });

    it('sendReviewFeedback は明示された会話へ1回送って sent を返し、作業記録へ通知する', async () => {
      const activities: unknown[] = [];
      const chat = await openChat({ onActivity: (a) => activities.push(a) });
      const delivering = chat.manager.sendReviewFeedback('thread-A', 'ここを直して');
      await tick(20);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('ここを直して');
      chat.connection.resolveFirst('turn/start', {});
      await expect(delivering).resolves.toBe('sent');
      expect(activities).toHaveLength(1);
    });

    it('sendReviewFeedback は送信に失敗すると deliveryFailed を返してエラーを出す', async () => {
      const chat = await openChat();
      const delivering = chat.manager.sendReviewFeedback('thread-A', 'ここを直して');
      await tick(20);
      chat.connection.rejectFirst('turn/start', 'send failed');
      await expect(delivering).resolves.toBe('deliveryFailed');
      expect(__mock.messages.errors.some((e) => String(e).includes('send failed'))).toBe(true);
    });
  });

  describe('脇道の質問と引き継ぎの入口', () => {
    const FORK_RESULT = {
      thread: {
        id: 'th-side-1',
        name: null,
        turns: [
          {
            id: 'turn-1',
            items: [
              { type: 'agentMessage', id: 'item-2', text: '元の返事', phase: 'final_answer' },
            ],
          },
        ],
      },
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    };

    it('/btw は元の会話を変えず、forkした別スレッドへ質問を送る', async () => {
      const chat = await openChat();
      const asking = chat.post({ type: 'send', text: '/btw 今のタイムゾーンは？' });
      await tick(20);
      expect(requestsOf(chat, 'thread/fork')).toHaveLength(1);
      chat.connection.resolveFirst('thread/fork', FORK_RESULT);
      await tick(20);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params).toMatchObject({ threadId: 'th-side-1' });
      expect(JSON.stringify(starts[0]?.params)).toContain('今のタイムゾーンは？');
      chat.connection.resolveFirst('turn/start', {});
      await asking;
      expect(chat.manager.isOpen('th-side-1')).toBe(true);
      expect(stateOf(chat).items).toEqual([]);
    });

    it('/btw は fork の応答を読めないとエラーを出し、質問は送らない', async () => {
      const chat = await openChat();
      const asking = chat.post({ type: 'send', text: '/btw 質問' });
      await tick(20);
      chat.connection.resolveFirst('thread/fork', {});
      await asking;
      expect(__mock.messages.errors.some((e) => String(e).includes('脇道のスレッドid'))).toBe(true);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
    });

    it('/btw は質問の送信に失敗するとエラーを出す', async () => {
      const chat = await openChat();
      const asking = chat.post({ type: 'send', text: '/btw 質問' });
      await tick(20);
      chat.connection.resolveFirst('thread/fork', FORK_RESULT);
      await tick(20);
      chat.connection.rejectFirst('turn/start', 'side send failed');
      await asking;
      expect(__mock.messages.errors.some((e) => String(e).includes('side send failed'))).toBe(true);
    });

    it('handoffToNewSession は会話が選ばれていなければ理由を出す', async () => {
      const { manager } = createManager();
      await manager.handoffToNewSession();
      expect(__mock.messages.infos.some((m) => m.includes('引き継ぐ会話が選ばれていません'))).toBe(
        true,
      );
      expect(loggedInfos.some((m) => m.includes('引き継ぐ会話が選ばれていません'))).toBe(true);
    });

    it('discussWithWebGpt は会話が開かれていなければエラーを出す', async () => {
      const { manager } = createManager();
      await manager.discussWithWebGpt();
      expect(
        __mock.messages.errors.some((m) => m.includes('議論するCodexの会話を開いてください')),
      ).toBe(true);
    });
  });

  describe('統括ページからの脇道の質問', () => {
    const FORK_RESULT = {
      thread: { id: 'th-side-2', name: null, turns: [] },
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    };

    function askSide(chat: OpenedChat, text: string): { id: string } {
      const result = chat.manager.controlSession(chat.threadId, { kind: 'sideQuestion', text });
      if (!result.ok || result.sideQuestion === undefined) {
        throw new Error(`質問を受け付けなかった: ${JSON.stringify(result)}`);
      }
      return { id: result.sideQuestion.id };
    }

    function resultOf(chat: OpenedChat, id: string): Record<string, unknown> {
      const result = chat.manager.controlSession(chat.threadId, {
        kind: 'sideQuestionResult',
        sideQuestionId: id,
      });
      if (!result.ok || result.sideQuestion === undefined) {
        throw new Error(`結果を取れなかった: ${JSON.stringify(result)}`);
      }
      return { ...result.sideQuestion };
    }

    it('forkした別スレッドの回答を返し、タブも本流の会話の項目も増やさない', async () => {
      const chat = await openChat();
      const { id } = askSide(chat, '今どこまで進んだ？');
      await tick(20);
      expect(requestsOf(chat, 'thread/fork')).toHaveLength(1);
      chat.connection.resolveFirst('thread/fork', FORK_RESULT);
      await tick(20);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.params).toMatchObject({ threadId: 'th-side-2' });
      chat.connection.resolveFirst('turn/start', {});
      await tick(20);
      expect(resultOf(chat, id)['status']).toBe('running');

      chat.connection.notify('turn/started', { threadId: 'th-side-2', turn: { id: 'side-turn' } });
      chat.connection.notify('item/completed', {
        threadId: 'th-side-2',
        turnId: 'side-turn',
        item: { type: 'agentMessage', id: 'a1', text: '  半分終わった  ', phase: 'final_answer' },
      });
      chat.connection.notify('turn/completed', {
        threadId: 'th-side-2',
        turn: { id: 'side-turn', status: 'completed' },
      });
      await tick(20);
      expect(resultOf(chat, id)).toMatchObject({ status: 'done', answer: '半分終わった' });
      expect(chat.manager.isOpen('th-side-2')).toBe(false);
      expect(stateOf(chat).items).toEqual([]);
    });

    it('回答が空のまま終わると failed にする', async () => {
      const chat = await openChat();
      const { id } = askSide(chat, '質問');
      await tick(20);
      chat.connection.resolveFirst('thread/fork', FORK_RESULT);
      await tick(20);
      chat.connection.resolveFirst('turn/start', {});
      await tick(20);
      chat.connection.notify('turn/started', { threadId: 'th-side-2', turn: { id: 'side-turn' } });
      chat.connection.notify('turn/completed', {
        threadId: 'th-side-2',
        turn: { id: 'side-turn', status: 'completed' },
      });
      await tick(20);
      expect(resultOf(chat, id)).toMatchObject({
        status: 'failed',
        error: '脇道の質問に回答が返りませんでした',
      });
    });

    it('fork に失敗すると failed にして理由を返し、同じ会話へ続けて質問できる', async () => {
      const chat = await openChat();
      const { id } = askSide(chat, '質問');
      const busy = chat.manager.controlSession(chat.threadId, {
        kind: 'sideQuestion',
        text: '重ねて質問',
      });
      expect(busy).toEqual({ ok: false, error: 'この会話は前の脇道の質問の回答待ちです' });
      await tick(20);
      chat.connection.rejectFirst('thread/fork', 'fork refused');
      await tick(20);
      expect(resultOf(chat, id)).toMatchObject({ status: 'failed' });
      expect(String(resultOf(chat, id)['error'])).toContain('fork refused');
      expect(() => askSide(chat, '次の質問')).not.toThrow();
    });

    it('fork の応答を読めなければ failed にする', async () => {
      const chat = await openChat();
      const { id } = askSide(chat, '質問');
      await tick(20);
      chat.connection.resolveFirst('thread/fork', {});
      await tick(20);
      expect(resultOf(chat, id)).toMatchObject({ status: 'failed' });
      expect(String(resultOf(chat, id)['error'])).toContain('脇道のスレッドid');
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
    });

    it('脇道のスレッドから来た承認要求は人に聞かず拒否する', async () => {
      const chat = await openChat();
      askSide(chat, '質問');
      await tick(20);
      chat.connection.resolveFirst('thread/fork', FORK_RESULT);
      await tick(20);
      const responded = chat.connection.serverRequest(21, 'item/commandExecution/requestApproval', {
        threadId: 'th-side-2',
        itemId: 'i1',
        command: 'rm -rf /',
        cwd: '/workspace/root',
      });
      await tick(20);
      await expect(responded).resolves.toEqual({ decision: 'decline' });
      expect(stateOf(chat).approvals).toHaveLength(0);
    });
  });

  describe('セカンドオピニオンとWebGPT議論の入口', () => {
    it('secondOpinion は候補の選択をやめたらセッションを開かない', async () => {
      const chat = await openChat();
      __mock.showQuickPickAnswer = () => undefined;
      await chat.post({ type: 'secondOpinion' });
      expect(requestsOf(chat, 'thread/start')).toHaveLength(1);
      expect(__mock.messages.errors).toHaveLength(0);
    });

    it('続けられる相談が無いときは、追加の相談・材料更新・下書き・承認のどれも案内を出して止まる', async () => {
      const chat = await openChat();
      await chat.post({ type: 'secondOpinionContinue' });
      expect(__mock.messages.infos).toContain(
        'この会話で続けられる相談はありません（もう一度セカンドオピニオンを実行してください）',
      );
      expect(sentOfType(chat, 'secondOpinionAdvisor')).toEqual([
        { type: 'secondOpinionAdvisor', itemId: undefined, canUpdateMaterial: false },
      ]);

      await chat.post({ type: 'secondOpinionUpdateMaterial' });
      await chat.post({ type: 'secondOpinionDraft' });
      await tick(10);
      expect(sentOfType(chat, 'secondOpinionAdvisor')).toHaveLength(3);

      await chat.post({ type: 'secondOpinionApprove' });
      await tick(10);
      expect(__mock.messages.infos).toContain(
        '送れる指示の下書きがありません（「メインAIへの指示を作る」から作成してください）',
      );
    });

    it('secondOpinionStop は実行中でない項目なら、見つからなかったことを記録するだけにする', async () => {
      const chat = await openChat();
      await chat.post({ type: 'secondOpinionStop', itemId: 'secondOpinion:none' });
      expect(loggedInfos.some((m) => m.includes('停止の対象が見つかりませんでした'))).toBe(true);
    });

    it('handoffToNewSession は履歴の解決口が無ければ引き継がず、旧タブを残す', async () => {
      const chat = await openChat();
      await chat.post({ type: 'handoffToNewSession' });
      expect(loggedWarnings.some((m) => m.includes('引き継ぎに必要な履歴の解決口'))).toBe(true);
      expect(requestsOf(chat, 'thread/start')).toHaveLength(1);
      expect(chat.manager.isOpen('thread-A')).toBe(true);
    });

    it('webGptDiscussion は応答中なら完了後にやり直すよう案内して始めない', async () => {
      const chat = await openChat();
      const sending = chat.post({ type: 'send', text: '作業して' });
      await tick(10);
      chat.connection.resolveFirst('turn/start', {});
      await sending;
      expect(stateOf(chat).busy).toBe(true);

      await chat.post({ type: 'webGptDiscussion' });
      await tick(20);
      expect(
        __mock.messages.errors.some((e) => String(e).includes('Codexの応答と送信待ちの完了後')),
      ).toBe(true);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(1);
    });
  });

  describe('タスクセッションの口', () => {
    function taskInput(extra: Partial<TaskSessionInput> = {}): TaskSessionInput {
      return {
        cwd: '/workspace/root',
        config: { model: '', effort: '', approvalMode: '' },
        sandbox: 'workspace-write',
        ...extra,
      };
    }

    async function openTask(
      extra: Partial<TaskSessionInput> = {},
      threadId = 'thread-T',
    ): Promise<{
      manager: ChatViewManager;
      connection: FakeAppServerConnection;
      task: TaskSession;
    }> {
      const { manager, connection } = createManager();
      const opening = manager.openTaskSession(taskInput(extra));
      await tick(30);
      connection.resolveFirst('thread/start', { thread: { id: threadId } });
      const task = await opening;
      return { manager, connection, task };
    }

    it('開いたセッションは thread/start の id を持ち、send は turn/start へ流れる', async () => {
      const { manager, connection, task } = await openTask();
      expect(task.sessionId).toBe('thread-T');
      expect(manager.isOpen('thread-T')).toBe(true);
      task.send('工程を進めて');
      await tick(20);
      const starts = connection.requests.filter((r) => r.method === 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('工程を進めて');
    });

    it('note は会話へ1行残し、状態の購読者へ通知する', async () => {
      const { manager, task } = await openTask();
      const seen: string[] = [];
      task.onStateChanged((state) => seen.push(JSON.stringify(state.items)));
      task.note('task-note', '工程メモ');
      expect(seen.some((items) => items.includes('工程メモ'))).toBe(true);
      const entry = (
        manager as unknown as { panels: Map<string, { session: ChatSession }> }
      ).panels.get('thread-T');
      expect(JSON.stringify(entry?.session.getState().items)).toContain('工程メモ');
    });

    it('承認ハンドラを差し込むと、承認要求へ人に聞かずその判定で答える', async () => {
      const { connection, task } = await openTask();
      task.setApprovalHandler(() => Promise.resolve({ kind: 'auto', decision: 'accept' }));
      const responded = connection.serverRequest(31, 'item/commandExecution/requestApproval', {
        threadId: 'thread-T',
        itemId: 'i1',
        command: 'ls',
        cwd: '/workspace/root',
      });
      await tick(20);
      await expect(responded).resolves.toEqual({ decision: 'accept' });
    });

    it('MCPを要求していないセッションの checkMessagingToolVisible は確認せず true を返す', async () => {
      const { task } = await openTask();
      await expect(task.checkMessagingToolVisible()).resolves.toBe(true);
      expect(task.stopLoop()).toBe(false);
    });

    it('compact は thread/compact/start を送る', async () => {
      const { connection, task } = await openTask();
      const compacting = task.compact();
      await tick(20);
      const compacts = connection.requests.filter((r) => r.method === 'thread/compact/start');
      expect(compacts).toHaveLength(1);
      expect(compacts[0]?.params).toEqual({ threadId: 'thread-T' });
      connection.resolveFirst('thread/compact/start', {});
      await compacting;
    });

    it('dispose はタブごと閉じる', async () => {
      const { manager, task } = await openTask();
      task.dispose();
      expect(manager.isOpen('thread-T')).toBe(false);
    });

    it('releaseForPause は購読を外してタブを閉じ、メモリは空いていないと伝える', async () => {
      const { manager, connection, task } = await openTask();
      const releasing = task.releaseForPause?.();
      await tick(20);
      const unsubscribes = connection.requests.filter((r) => r.method === 'thread/unsubscribe');
      expect(unsubscribes).toHaveLength(1);
      expect(unsubscribes[0]?.params).toEqual({ threadId: 'thread-T' });
      connection.resolveFirst('thread/unsubscribe', {});
      await expect(releasing).resolves.toEqual({ memoryFreed: false });
      expect(manager.isOpen('thread-T')).toBe(false);
    });

    it('resume を渡すと新しいスレッドを作らず thread/resume で開き直す', async () => {
      const { manager, connection } = createManager();
      const opening = manager.openTaskSession(taskInput({ resume: { sessionId: 'thread-old' } }));
      await tick(30);
      expect(connection.requests.some((r) => r.method === 'thread/start')).toBe(false);
      const resumes = connection.requests.filter((r) => r.method === 'thread/resume');
      expect(resumes).toHaveLength(1);
      expect(resumes[0]?.params).toMatchObject({ threadId: 'thread-old' });
      connection.resolveFirst('thread/resume', { thread: { id: 'thread-old' } });
      const task = await opening;
      expect(task.sessionId).toBe('thread-old');
      expect(manager.isOpen('thread-old')).toBe(true);
    });

    it('thread/start に失敗すると例外を返し、エラーを出してタブを残さない', async () => {
      const { manager, connection } = createManager();
      const opening = manager.openTaskSession(taskInput());
      const rejected = expect(opening).rejects.toThrow('start failed');
      await tick(30);
      connection.rejectFirst('thread/start', 'start failed');
      await rejected;
      expect(__mock.messages.errors.some((e) => String(e).includes('start failed'))).toBe(true);
    });

    it('MCPを無効化するセッションは、設定を読めなければ開始せず理由を出す', async () => {
      const { manager, connection } = createManager();
      const opening = manager.openTaskSession(taskInput({ disableMcpServers: true }));
      const rejected = expect(opening).rejects.toThrow('MCPサーバ一覧を読めなかった');
      await tick(30);
      connection.rejectFirst('config/read', 'config unreadable');
      await rejected;
      expect(connection.requests.some((r) => r.method === 'thread/start')).toBe(false);
      expect(loggedErrors.some((m) => m.includes('config unreadable'))).toBe(true);
    });

    it('入力欄を閉じたセッションには、レビュー指摘も統括ページの送信も届けない', async () => {
      const { manager, connection } = await openTask({ inputLock: true });
      await expect(manager.sendReviewFeedback('thread-T', '指摘')).resolves.toBe(
        'sessionUnavailable',
      );
      const result = manager.controlSession('thread-T', { kind: 'send', text: '指示' });
      expect(result.ok).toBe(false);
      expect(connection.requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
    });

    it('タスクが動かしている画面は clearActive でクリアできない', async () => {
      const { manager, task } = await openTask();
      task.reveal?.();
      await manager.clearActive();
      expect(__mock.messages.warnings).toContain('タスクが動かしている画面はクリアできません');
      expect(manager.isOpen('thread-T')).toBe(true);
    });
  });

  describe('パネルの復元', () => {
    function newPanel(): ReturnType<typeof vscode.window.createWebviewPanel> {
      return vscode.window.createWebviewPanel('codex.chat', 'x', vscode.ViewColumn.Active, {});
    }

    it('threadId の無い状態のパネルは破棄する', async () => {
      const { manager } = createManager();
      const panel = newPanel();
      await manager.restorePanel(panel, {});
      expect((panel as unknown as { disposed: boolean }).disposed).toBe(true);
    });

    it('既に開いている会話のパネルは重ねず破棄する', async () => {
      const chat = await openChat();
      const panel = newPanel();
      await chat.manager.restorePanel(panel, { threadId: 'thread-A' });
      expect((panel as unknown as { disposed: boolean }).disposed).toBe(true);
      expect(chat.manager.isOpen('thread-A')).toBe(true);
    });

    it('タスク管理下で預かっているスレッドは thread/read で会話だけを表示し、再開した旨を残す', async () => {
      const { manager, connection } = createManager({ isTaskManagedThread: () => true });
      manager.holdsRestoredTaskPanel = () => true;
      const panel = newPanel();
      const holding = manager.restorePanel(panel, { threadId: 'thread-task' });
      await tick(20);
      const reads = connection.requests.filter((r) => r.method === 'thread/read');
      expect(reads).toHaveLength(1);
      expect(reads[0]?.params).toEqual({ threadId: 'thread-task', includeTurns: true });
      connection.resolveFirst('thread/read', {
        thread: {
          id: 'thread-task',
          name: 'タスクの会話',
          turns: [
            {
              id: 'turn-1',
              items: [{ type: 'agentMessage', id: 'a1', text: '途中経過', phase: 'final_answer' }],
            },
          ],
        },
      });
      await holding;
      expect((panel as unknown as { disposed: boolean }).disposed).toBe(false);
      const entry = (
        manager as unknown as { panels: Map<string, { session: ChatSession }> }
      ).panels.get('thread-task');
      const items = JSON.stringify(entry?.session.getState().items);
      expect(items).toContain('途中経過');
      expect(items).toContain('CLIは起動していません');
      expect(connection.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    });

    it('預かるスレッドを読み込めなければ理由を会話へ残す', async () => {
      const { manager, connection } = createManager({ isTaskManagedThread: () => true });
      manager.holdsRestoredTaskPanel = () => true;
      const holding = manager.restorePanel(newPanel(), { threadId: 'thread-task' });
      await tick(20);
      connection.rejectFirst('thread/read', 'no such thread');
      await holding;
      const entry = (
        manager as unknown as { panels: Map<string, { session: ChatSession }> }
      ).panels.get('thread-task');
      expect(JSON.stringify(entry?.session.getState().items)).toContain(
        '会話を読み込めませんでした',
      );
    });

    it('預かっていないタスク管理下のスレッドは、汎用復元をせずパネルを破棄する', async () => {
      const { manager, connection } = createManager({ isTaskManagedThread: () => true });
      const panel = newPanel();
      await manager.restorePanel(panel, { threadId: 'thread-task' });
      expect((panel as unknown as { disposed: boolean }).disposed).toBe(true);
      expect(connection.requests).toHaveLength(0);
    });
  });

  describe('使用量上限の自動再開', () => {
    function limitStatusOf(chat: OpenedChat): Record<string, unknown> {
      const last = sentOfType(chat, 'state').at(-1);
      const state = last?.['state'] as Record<string, unknown> | undefined;
      return (state?.['limitAutoResumeStatus'] ?? {}) as Record<string, unknown>;
    }

    /** 上限で失敗したターンを作る。 */
    async function limitedChat(): Promise<OpenedChat> {
      const chat = await openChat();
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });
      chat.connection.notify('turn/completed', {
        threadId: 'thread-A',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: '上限に達しました', codexErrorInfo: 'usageLimitExceeded' },
        },
      });
      await flushStatePosts();
      return chat;
    }

    it('上限で止まると予約を表示し、時間が来たら継続指示を1回送る', async () => {
      const chat = await limitedChat();
      const status = limitStatusOf(chat);
      expect(typeof status['scheduledAt']).toBe('number');
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const starts = requestsOf(chat, 'turn/start');
      expect(starts).toHaveLength(1);
      expect(JSON.stringify(starts[0]?.params)).toContain('前回の作業を続けて');
    });

    it('継続指示の送信に失敗するとエラーを出し、1分後の再試行を予約し直す', async () => {
      const chat = await limitedChat();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      chat.connection.rejectFirst('turn/start', 'resume failed');
      await tick(20);
      expect(__mock.messages.errors.some((e) => String(e).includes('resume failed'))).toBe(true);

      await flushStatePosts();
      const status = limitStatusOf(chat);
      expect(status['awaitingResult']).toBe(false);
      expect(typeof status['scheduledAt']).toBe('number');
    });

    it('自動返信モードは失敗でターンが終わると止まり、理由を会話へ残す', async () => {
      const chat = await openChat();
      await chat.post({ type: 'autoReply', on: true });
      expect(stateOf(chat).autoReply).toBeTruthy();
      chat.connection.notify('turn/started', { threadId: 'thread-A', turn: { id: 'turn-1' } });
      chat.connection.notify('turn/completed', {
        threadId: 'thread-A',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' } },
      });
      await flushStatePosts();
      expect(stateOf(chat).autoReply).toBeFalsy();
      expect(JSON.stringify(stateOf(chat).items)).toContain('autoReplyStop:');
    });

    it('設定で無効にすると予約せず、継続指示も送らない', async () => {
      __mock.setConfig('agent', { 'chat.limitAutoResume.enabled': false });
      const chat = await limitedChat();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(requestsOf(chat, 'turn/start')).toHaveLength(0);
    });
  });
});
