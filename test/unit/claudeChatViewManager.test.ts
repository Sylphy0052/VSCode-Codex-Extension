import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import { __mock, ViewColumn, window as fakeWindow } from '../mocks/vscode';

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

function createManager(options?: { isTaskManagedThread?: (sessionId: string) => boolean }): {
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
  );
  return { manager };
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
});
