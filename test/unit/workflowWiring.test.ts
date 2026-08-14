import { beforeEach, describe, expect, it } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager } from '../../src/view/chatView';
import { WorkflowRunner, type WorkflowFilePort } from '../../src/orchestrator/runner';
import { WorkflowRunStore, type WorkflowRunMemento } from '../../src/orchestrator/runStore';
import {
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';
import type { Provider } from '../../src/orchestrator/workflow';
import type { TaskSessionHost } from '../../src/orchestrator/taskSession';
import { __mock, ViewColumn, window as fakeWindow } from '../mocks/vscode';
import {
  fakeConnectionFactory,
  type FakeAppServerConnection,
} from '../helpers/fakeAppServerConnection';

/**
 * `extension.ts` が実際に組み立てる配線（`WorkflowRunner` ⇄ `ChatViewManager` の
 * `isTaskManagedThread`）を、実クラス同士で再現するテスト（レビュー指摘: critical 1）。
 *
 * `runner.test.ts` はフェイクの `TaskSessionHost` で `WorkflowRunner` 単体のロジックを
 * 検証するが、それだけでは「`extension.ts` が実際に口を渡し忘れる」バグを検出できない。
 * ここでは実の `ChatViewManager` を使い、ウィンドウのリロードで
 * `ChatViewManager` / `WorkflowRunner` の両方が新しいインスタンスに置き換わっても、
 * `workspaceState`（`fakeMemento`）だけは生き残るという実際の条件を再現する。
 */

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

function fakeGit(): GitCommandRunner {
  return {
    async run(args) {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` };
    },
  };
}

const identityFs: WorktreeFileSystemPort = {
  realpath: async (target) => target,
  readTextFile: async () => '.agents/worktrees/\n',
  isSymbolicLink: async () => false,
  pathExists: async () => true,
};

function filePort(content: string): WorkflowFilePort {
  return {
    fileSize: async () => Buffer.byteLength(content, 'utf8'),
    readTextFile: async () => content,
  };
}

/** `context.workspaceState` の代わり。テスト内でリロードをまたいで使い回す。 */
function fakeMemento(): WorkflowRunMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

const YAML = `
version: 1
name: wiring-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

/** `extension.ts` と同じ配線パターン（箱＋クロージャ）で `ChatViewManager` と `WorkflowRunner` を組み立てる。 */
function wireWindow(memento: WorkflowRunMemento): {
  chat: ChatViewManager;
  runner: WorkflowRunner;
  connection: FakeAppServerConnection;
} {
  const workflowRunnerRef: { current: WorkflowRunner | undefined } = { current: undefined };
  const { factory, connection } = fakeConnectionFactory();
  const chat = new ChatViewManager(
    () => 'codex',
    fakeSettingsProvider(),
    '/fake/codex-home',
    fakeFileSystem,
    fakeMentions(),
    fakeLogger,
    () => undefined,
    (id) => workflowRunnerRef.current?.isTaskManagedSessionId(id) ?? false,
    () => undefined,
    factory,
  );
  const store = new WorkflowRunStore(memento);
  const hosts: Record<Provider, TaskSessionHost> = { codex: chat, claude: chat };
  const runner = new WorkflowRunner({
    hosts,
    worktreeQueue: new WorktreeCreationQueue(),
    git: fakeGit(),
    fs: identityFs,
    filePort: filePort(YAML),
    store,
    log: fakeLogger,
    readBaseline: () => ({
      codexSandbox: 'read-only',
      codexApprovalMode: 'on-request',
      claudePermissionMode: 'manual',
      allowAutoApprove: true,
    }),
  });
  workflowRunnerRef.current = runner;
  return { chat, runner, connection: connection() };
}

describe('isTaskManagedThreadの結線（design.md §16.10の7、レビュー指摘: critical 1）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.setConfig('codex', {});
  });

  it('リロードでChatViewManager/WorkflowRunnerが作り直されても、タスク管理下スレッドの復元は汎用復元に拾われない', async () => {
    // ウィンドウ1（リロード前）。workspaceStateに相当するmementoだけが生き残る想定
    const memento = fakeMemento();
    const before = wireWindow(memento);
    const result = await before.runner.start('/repo/.agents/workflows/w.yaml', '/repo');
    expect(result.ok).toBe(true);
    await flush();
    before.connection.resolveFirst('thread/start', { thread: { id: 'thread-task' } });
    await flush();

    // 実際にタスクのセッションが開始されている（前提の確認）
    expect(before.chat.isOpen('thread-task')).toBe(true);

    // ウィンドウ2（リロード後）。ChatViewManager・WorkflowRunnerとも新しいインスタンスだが、
    // mementoは同じインスタンスを渡す（workspaceStateの永続化を模す）
    const after = wireWindow(memento);
    const restoredPanel = fakeWindow.createWebviewPanel('codex.chat', 'x', ViewColumn.Active, {});

    await after.chat.restorePanel(restoredPanel, { threadId: 'thread-task' });

    // 汎用復元はここで手を引く。パネルは破棄され、ワークスペース直下のcwdで
    // thread/resumeされることは無い
    expect(restoredPanel.disposed).toBe(true);
    expect(after.chat.isOpen('thread-task')).toBe(false);
    expect(after.connection.requests.find((r) => r.method === 'thread/resume')).toBeUndefined();
  });

  it('タスク管理下でない（人が手で開いた）スレッドは、リロード後も従来通り復元される', async () => {
    const memento = fakeMemento();
    const after = wireWindow(memento);
    const panel = fakeWindow.createWebviewPanel('codex.chat', 'x', ViewColumn.Active, {});

    const p = after.chat.restorePanel(panel, { threadId: 'thread-manual' });
    await flush();
    after.connection.resolveFirst('thread/resume', { thread: { id: 'thread-manual' } });
    await p;

    expect(panel.disposed).toBe(false);
    expect(after.chat.isOpen('thread-manual')).toBe(true);
  });
});
