import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ChatViewManager } from '../../src/view/chatView';
import type { TaskSessionConfig } from '../../src/orchestrator/taskSession';
import { __mock } from '../mocks/vscode';
import {
  fakeConnectionFactory,
  type FakeAppServerConnection,
} from '../helpers/fakeAppServerConnection';

/**
 * `openNew()` / `openTaskSession()` が `thread/start` の失敗（reject）を
 * 正しく後始末するかの確認（issue #460の穴2）。
 *
 * 多重セッション時の宛先解決（`chatViewManager.test.ts`）とタブを閉じたあとの後始末
 * （同ファイル）は既に厚く検証されているが、`thread/start` そのものが失敗したときの
 * 経路（ネットワーク断・app-server側のエラー応答）を通すテストが無かった。
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

const EMPTY_TASK_CONFIG: TaskSessionConfig = { model: '', effort: '', approvalMode: '' };

function createManager(): {
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
    () => undefined,
    () => false,
    () => undefined,
    factory,
  );
  return { manager, connection: connection() };
}

/**
 * `ChatSession.start`/`resume` は `connection.ensureStarted()` の1tick分だけ
 * `thread/start`/`thread/resume` の発行が遅れる（`chatViewManager.test.ts`と同じ理由）。
 */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/** `pendingStarts`/`panels`は`protected`のため、テストからは内部キャストで覗く。 */
function internals(manager: ChatViewManager): {
  pendingCount: () => number;
  panelCount: () => number;
} {
  const m = manager as unknown as {
    pendingStarts: { values(): unknown[] };
    panels: Map<string, unknown>;
  };
  return {
    pendingCount: () => m.pendingStarts.values().length,
    panelCount: () => m.panels.size,
  };
}

describe('セッション開始の失敗経路（issue #460）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    __mock.setConfig('codex', {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('openNew()', () => {
    it('thread/startが失敗すると、pendingStartsを終え・teardownを呼び・panelsに登録が残らない', async () => {
      const { manager, connection } = createManager();
      const teardownSpy = vi.spyOn(
        manager as unknown as { teardown: (entry: unknown) => void },
        'teardown',
      );
      const { pendingCount, panelCount } = internals(manager);

      const opened = manager.openNew('/workspace/root');
      await tick();
      expect(pendingCount()).toBe(1);

      connection.rejectFirst('thread/start', 'app-serverとの接続が切れました');

      // openNewはcatchでreportErrorするだけで再送出しない
      // （呼び出し元がコマンドパレット等でPromiseを待ち受けないため）。
      await expect(opened).resolves.toBeUndefined();

      expect(pendingCount()).toBe(0);
      expect(panelCount()).toBe(0);
      // teardown()の内部で`entry.panel?.dispose()`を呼ぶと、パネル側のonDidDispose
      // （`dispose: () => this.teardown(entry)`）が再度teardown()を呼び戻す。2回目は
      // `entry.disposed`の早期returnで実処理はしないが、spy呼び出し回数には乗るため
      // 「呼ばれたこと」自体（回数の下限）だけを見る
      expect(teardownSpy).toHaveBeenCalled();
      expect(__mock.messages.errors).toHaveLength(1);
      expect(__mock.messages.errors[0]).toContain('app-serverとの接続が切れました');

      // teardown()が実際にパネルを畳んだことを確認する（explicitなpendingStarts.end()
      // だけでは説明できない、teardown固有の副作用）
      const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
      expect(panel?.disposed).toBe(true);
    });
  });

  describe('openTaskSession()', () => {
    it('thread/startが失敗すると、pendingStartsを終え・teardownを呼び・panelsに登録が残らず・呼び出し元へ再送出する', async () => {
      const { manager, connection } = createManager();
      const teardownSpy = vi.spyOn(
        manager as unknown as { teardown: (entry: unknown) => void },
        'teardown',
      );
      const { pendingCount, panelCount } = internals(manager);

      const opened = manager.openTaskSession({
        cwd: '/workspace/root/task-a',
        config: EMPTY_TASK_CONFIG,
        sandbox: '',
      });
      await tick();
      expect(pendingCount()).toBe(1);

      connection.rejectFirst('thread/start', 'app-serverが応答しません: thread/start');

      // runner.tsがタスクをfailedにできるよう、呼び出し元へ再送出する
      // （JSDoc「失敗時は例外を投げ直し」の通り）
      await expect(opened).rejects.toThrow(/app-serverが応答しません/u);

      expect(pendingCount()).toBe(0);
      expect(panelCount()).toBe(0);
      expect(teardownSpy).toHaveBeenCalled();
      expect(__mock.messages.errors).toHaveLength(1);
      expect(__mock.messages.errors[0]).toContain('app-serverが応答しません');

      // openTaskSessionはパネルをここでは作らない（design.md §16.10の2）ため、
      // teardown()の効果はcreatedPanelsでは観測できない。pendingStarts/panelsの
      // クリアとteardownSpyの呼び出しで代える。
      expect(__mock.createdPanels).toHaveLength(0);
    });
  });
});
