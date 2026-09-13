import { beforeEach, describe, expect, it } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import type { SessionStore } from '../../src/session/sessionStore';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager } from '../../src/view/chatView';
import { ConversationViewManager } from '../../src/view/conversationView';
import { __mock } from '../mocks/vscode';
import {
  fakeConnectionFactory,
  type FakeAppServerConnection,
} from '../helpers/fakeAppServerConnection';

/**
 * 分岐に失敗したあと、同じボタンで再試行できること（Issue #1156）。
 *
 * webview側は押した時点でボタンを無効化する。ホスト側が失敗を返さないとボタンは
 * 無効のままで、タブを開き直すまで再試行できない。ここでは「失敗したら `forkFailed` を
 * webviewへ送る」という境界だけを見る（ボタンのDOM操作はwebview内のスクリプト側）。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const ROLLOUT = [
  JSON.stringify({
    timestamp: '2026-09-13T00:00:00.000Z',
    type: 'turn_context',
    payload: { turn_id: 'turn-1' },
  }),
  JSON.stringify({
    timestamp: '2026-09-13T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '1つ目' },
  }),
  JSON.stringify({
    timestamp: '2026-09-13T00:00:02.000Z',
    type: 'turn_context',
    payload: { turn_id: 'turn-2' },
  }),
  JSON.stringify({
    timestamp: '2026-09-13T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '2つ目' },
  }),
].join('\n');

const SESSION: SessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'codex',
  cwd: '/workspace/root',
} as unknown as SessionSummary;

function conversationFs(): FileSystemPort {
  return {
    readTextFile: async () => ROLLOUT,
    readFirstLine: async () => undefined,
    readTail: async () => undefined,
    mtimeMs: async () => undefined,
    listRollouts: async () => [],
    listJsonl: async () => [],
    listMarkdown: async () => [],
    readHead: async () => [],
    readBase64File: async () => undefined,
  };
}

function conversationStore(): SessionStore {
  return {
    resolveRolloutPath: async () => '/fake/rollout.jsonl',
  } as unknown as SessionStore;
}

function lastPanel(): {
  webview: { sent: unknown[]; simulateMessage: (message: unknown) => void };
} {
  const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
  if (panel === undefined) {
    throw new Error('パネルが作られていない');
  }
  return panel as unknown as {
    webview: { sent: unknown[]; simulateMessage: (message: unknown) => void };
  };
}

function forkFailedMessages(sent: readonly unknown[]): unknown[] {
  return sent.filter((m) => (m as { type?: unknown }).type === 'forkFailed');
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('会話閲覧画面の分岐（Issue #1156）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
  });

  it('分岐が失敗したらforkFailedを返す', async () => {
    const manager = new ConversationViewManager(
      conversationFs(),
      conversationStore(),
      fakeLogger,
      async () => false,
    );
    await manager.open(SESSION);
    const panel = lastPanel();

    panel.webview.simulateMessage({ type: 'fork', turnId: 'turn-1' });
    await tick();

    expect(forkFailedMessages(panel.webview.sent)).toEqual([
      { type: 'forkFailed', turnId: 'turn-1' },
    ]);
  });

  it('分岐の処理が例外で終わってもforkFailedを返す', async () => {
    const manager = new ConversationViewManager(
      conversationFs(),
      conversationStore(),
      fakeLogger,
      async () => {
        throw new Error('app-serverとの接続が切れました');
      },
    );
    await manager.open(SESSION);
    const panel = lastPanel();

    panel.webview.simulateMessage({ type: 'fork', turnId: 'turn-1' });
    await tick();

    expect(forkFailedMessages(panel.webview.sent)).toEqual([
      { type: 'forkFailed', turnId: 'turn-1' },
    ]);
  });

  it('分岐が成功したときは何も返さない（成功時の挙動は変えない）', async () => {
    const manager = new ConversationViewManager(
      conversationFs(),
      conversationStore(),
      fakeLogger,
      async () => true,
    );
    await manager.open(SESSION);
    const panel = lastPanel();

    panel.webview.simulateMessage({ type: 'fork', turnId: 'turn-1' });
    await tick();

    expect(forkFailedMessages(panel.webview.sent)).toEqual([]);
  });
});

const fakeScanPort: FileScanPort = {
  scan: async () => [],
  readText: async () => undefined,
};

const chatFileSystem: FileSystemPort = {
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

function fakeSettingsProvider(): SettingsProvider {
  return {
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
  } as unknown as SettingsProvider;
}

function createChatManager(): {
  manager: ChatViewManager;
  connection: FakeAppServerConnection;
} {
  const { factory, connection } = fakeConnectionFactory();
  const manager = new ChatViewManager(
    () => 'codex',
    fakeSettingsProvider(),
    '/fake/codex-home',
    chatFileSystem,
    new FileMentionCatalog(fakeScanPort),
    fakeLogger,
    () => undefined,
    () => false,
    () => undefined,
    factory,
  );
  return { manager, connection: connection() };
}

describe('チャット画面の分岐（Issue #1156）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('codex', {});
  });

  async function openThread(): Promise<{
    connection: FakeAppServerConnection;
    panel: ReturnType<typeof lastPanel>;
  }> {
    const { manager, connection } = createChatManager();
    const started = manager.openNew('/workspace/root');
    await tick();
    connection.resolveFirst('thread/start', { thread: { id: 'th-1' } });
    await started;
    await tick();
    return { connection, panel: lastPanel() };
  }

  it('thread/forkが失敗したらforkFailedを返す', async () => {
    const { connection, panel } = await openThread();

    panel.webview.simulateMessage({ type: 'fork', turnId: 'turn-1' });
    await tick();
    connection.rejectFirst('thread/fork', 'app-serverとの接続が切れました');
    await tick();

    expect(forkFailedMessages(panel.webview.sent)).toEqual([
      { type: 'forkFailed', turnId: 'turn-1' },
    ]);
    expect(__mock.messages.errors.join('\n')).toContain('app-serverとの接続が切れました');
  });

  it('分岐後のスレッドidを読めないときもforkFailedを返す', async () => {
    const { connection, panel } = await openThread();

    panel.webview.simulateMessage({ type: 'fork', turnId: 'turn-1' });
    await tick();
    connection.resolveFirst('thread/fork', {});
    await tick();

    expect(forkFailedMessages(panel.webview.sent)).toEqual([
      { type: 'forkFailed', turnId: 'turn-1' },
    ]);
  });
});
