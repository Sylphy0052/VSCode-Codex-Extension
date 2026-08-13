import { describe, expect, it } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import { noClaudeDefaults } from '../../src/claude/settingsJson';
import type { Logger } from '../../src/log';
import { ControlPanelViewProvider } from '../../src/view/controlPanelView';
import type { SettingsProvider } from '../../src/view/settingsProvider';

/**
 * `vscode.WebviewView` の最小フェイク。`ControlPanelViewProvider` が使うのは
 * `webview.options` / `webview.html` / `webview.onDidReceiveMessage` /
 * `webview.postMessage` / `webview.cspSource` だけなので、それだけを実装する
 * （`test/mocks/vscode.ts` の `FakeWebview` はexportされていないため、ここで最小限を組む）。
 */
function fakeWebviewView(): {
  view: { webview: Record<string, unknown> };
  sent: unknown[];
  simulateMessage: (message: unknown) => Promise<void>;
} {
  const sent: unknown[] = [];
  let handler: ((message: unknown) => void) | undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'https://fake-webview.test',
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      handler = listener;
      return { dispose: () => undefined };
    },
    postMessage: (message: unknown) => {
      sent.push(message);
      return Promise.resolve(true);
    },
  };
  return {
    view: { webview },
    sent,
    // handleMessageは非同期なので、送出したメッセージへの反応を待ちたいテスト側は
    // このヘルパーの返すPromiseを待つ
    simulateMessage: async (message: unknown) => {
      handler?.(message);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function fakeSettingsProvider(): {
  settings: SettingsProvider;
  ensureSectionLoadedCalls: string[];
} {
  const ensureSectionLoadedCalls: string[] = [];
  const settings = {
    load: async () => undefined,
    snapshot: () => ({
      models: [],
      efforts: [],
      model: '',
      reasoningEffort: '',
      approvalMode: '',
      sandbox: '',
      defaults: noDefaults,
      profile: '',
      mcpServers: { ok: false, reason: 'まだ読み込んでいません' },
      hooks: { ok: false, reason: 'まだ読み込んでいません' },
      skills: { ok: false, reason: 'まだ読み込んでいません' },
      account: { ok: false, reason: 'まだ読み込んでいません' },
      plugins: { ok: false, reason: 'まだ読み込んでいません' },
      apps: { ok: false, reason: 'まだ読み込んでいません' },
      importCandidates: { ok: false, reason: 'まだ読み込んでいません' },
      importHistory: { ok: false, reason: 'まだ読み込んでいません' },
    }),
    claudeSnapshot: () => ({
      models: [],
      efforts: [],
      permissionModes: [],
      agents: [],
      model: '',
      effort: '',
      permissionMode: '',
      agent: '',
      defaults: noClaudeDefaults,
      mcpServers: { ok: false, reason: 'まだ読み込んでいません' },
      hooks: { ok: false, reason: 'まだ読み込んでいません' },
      skills: { ok: false, reason: 'まだ読み込んでいません' },
      account: { ok: false, reason: 'まだ読み込んでいません' },
      plugins: { ok: false, reason: 'まだ読み込んでいません' },
    }),
    ensureSectionLoaded: async (id: string) => {
      ensureSectionLoadedCalls.push(id);
    },
  };
  return { settings: settings as unknown as SettingsProvider, ensureSectionLoadedCalls };
}

function fakeLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: {
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
      error: () => undefined,
      show: () => undefined,
    },
    warnings,
  };
}

function stateMessagesOf(sent: unknown[]): unknown[] {
  return sent.filter(
    (m) => typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'state',
  );
}

describe('ControlPanelViewProviderのセクション遅延取得（issue #225）', () => {
  it('パネルを開いた直後はsettings.load()を1回呼び、状態を送る', async () => {
    const { settings, ensureSectionLoadedCalls } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, sent } = fakeWebviewView();

    provider.resolveWebviewView(view as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(stateMessagesOf(sent).length).toBeGreaterThan(0);
    // 展開されたセクションが無いので、この時点ではどのセクションも取得しに行かない
    expect(ensureSectionLoadedCalls).toEqual([]);
  });

  it('toggleSectionを受け取ると、そのセクションだけensureSectionLoadedを呼び、状態を送り返す', async () => {
    const { settings, ensureSectionLoadedCalls } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, sent, simulateMessage } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await Promise.resolve();
    await Promise.resolve();
    const before = stateMessagesOf(sent).length;

    await simulateMessage({ type: 'toggleSection', id: 'codexMcp' });

    expect(ensureSectionLoadedCalls).toEqual(['codexMcp']);
    expect(stateMessagesOf(sent).length).toBeGreaterThan(before);
  });

  it('不正なセクション識別子は無視し、警告を出すだけでensureSectionLoadedを呼ばない', async () => {
    const { settings, ensureSectionLoadedCalls } = fakeSettingsProvider();
    const { logger, warnings } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, simulateMessage } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await Promise.resolve();
    await Promise.resolve();

    await simulateMessage({ type: 'toggleSection', id: 'notASection' });

    expect(ensureSectionLoadedCalls).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
