import { describe, expect, it } from 'vitest';
import { noDefaults } from '../../src/codex/configToml';
import { noClaudeDefaults } from '../../src/claude/settingsJson';
import type { Logger } from '../../src/log';
import { chatCsp } from '../../src/view/chatCsp';
import { ControlPanelViewProvider } from '../../src/view/controlPanelView';
import type { SettingsProvider } from '../../src/view/settingsProvider';

/**
 * `vscode.WebviewView` の最小フェイク。`ControlPanelViewProvider` が使うのは
 * `webview.options` / `webview.html` / `webview.onDidReceiveMessage` /
 * `webview.postMessage` / `webview.cspSource` だけなので、それだけを実装する
 * （`test/mocks/vscode.ts` の `FakeWebview` はexportされていないため、ここで最小限を組む）。
 */
function fakeWebviewView(): {
  view: {
    webview: Record<string, unknown>;
    onDidDispose: (listener: () => void) => { dispose: () => void };
  };
  sent: unknown[];
  simulateMessage: (message: unknown) => Promise<void>;
  simulateDispose: () => void;
} {
  const sent: unknown[] = [];
  let handler: ((message: unknown) => void) | undefined;
  let disposeListener: (() => void) | undefined;
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
    view: {
      webview,
      // `vscode.WebviewView.onDidDispose`の最小フェイク。破棄をテストから起こせるように
      // 登録されたlistenerを`simulateDispose`から呼べるようにしておく
      onDidDispose: (listener: () => void) => {
        disposeListener = listener;
        return { dispose: () => undefined };
      },
    },
    sent,
    // handleMessageは非同期なので、送出したメッセージへの反応を待ちたいテスト側は
    // このヘルパーの返すPromiseを待つ
    simulateMessage: async (message: unknown) => {
      handler?.(message);
      await flushAsync();
    },
    simulateDispose: () => {
      disposeListener?.();
    },
  };
}

/**
 * 非同期の解決を待つ（issue #741）。
 *
 * もとは`await Promise.resolve()`を2回並べていたが、これは実装側のawaitの段数と
 * ちょうど一致していることに依存する。hooksの先読み（issue #741）で段数が増えたときに
 * 4本まとめて落ちたため、段数に依存しないタイマー待ちへ替える。
 */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSettingsProvider(): {
  settings: SettingsProvider;
  ensureSectionLoadedCalls: string[];
  /**
   * `settings.loadingSections`をテスト側から差し替える（issue #225 レビュー指摘1）。
   * `ControlPanelViewProvider.buildState()`がこの値をそのまま`state.loadingSections`
   * へ載せて送ることを確認するために使う
   */
  setLoadingSections: (ids: string[]) => void;
} {
  const ensureSectionLoadedCalls: string[] = [];
  let loadingSections: string[] = [];
  const settings = {
    load: async () => undefined,
    get loadingSections() {
      return loadingSections;
    },
    /** 異常のまとめ（issue #741）が未読込と読み込み失敗を区別するのに使う。 */
    loadedSectionIds: new Set<string>(),
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
  return {
    settings: settings as unknown as SettingsProvider,
    ensureSectionLoadedCalls,
    setLoadingSections: (ids: string[]) => {
      loadingSections = ids;
    },
  };
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
    await flushAsync();

    expect(stateMessagesOf(sent).length).toBeGreaterThan(0);
    // hooksだけは折りたたまれていても読む（issue #741。未信頼のhookに気付けないまま
    // 実行されるのを避けるため、起動コスト1回と引き換えにする）。他のセクションは
    // 展開されるまで取得しに行かない
    expect(ensureSectionLoadedCalls.sort()).toEqual(['claudeHooks', 'codexHooks']);
  });

  it('toggleSectionを受け取ると、そのセクションだけensureSectionLoadedを呼び、状態を送り返す', async () => {
    const { settings, ensureSectionLoadedCalls } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, sent, simulateMessage } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await flushAsync();
    const before = stateMessagesOf(sent).length;

    await simulateMessage({ type: 'toggleSection', id: 'codexMcp' });

    // hooksの先読み（issue #741）とは別に、展開されたセクションだけが読まれる
    expect(ensureSectionLoadedCalls.filter((id) => !id.endsWith('Hooks'))).toEqual(['codexMcp']);
    expect(stateMessagesOf(sent).length).toBeGreaterThan(before);
  });

  it('不正なセクション識別子は無視し、警告を出すだけでensureSectionLoadedを呼ばない', async () => {
    const { settings, ensureSectionLoadedCalls } = fakeSettingsProvider();
    const { logger, warnings } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, simulateMessage } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await flushAsync();

    await simulateMessage({ type: 'toggleSection', id: 'notASection' });

    // hooksの先読み（issue #741）以外は何も読まれない
    expect(ensureSectionLoadedCalls.filter((id) => !id.endsWith('Hooks'))).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it(
    '取得中のセクションはsettings.loadingSectionsからそのままstate.loadingSectionsへ' +
      '転送される（issue #225 レビュー指摘1）',
    async () => {
      const { settings, setLoadingSections } = fakeSettingsProvider();
      const { logger } = fakeLogger();
      const provider = new ControlPanelViewProvider(settings, logger);
      const { view, sent } = fakeWebviewView();

      // セクションAが取得中である状態を模す。別セクションの操作でstateが再送されても
      // Aの取得中状態が反映され続けることを確かめたいので、resolveWebviewView前に
      // セットしておく
      setLoadingSections(['codexMcp']);
      provider.resolveWebviewView(view as never);
      await flushAsync();

      const states = stateMessagesOf(sent) as { state: { loadingSections: string[] } }[];
      expect(states.length).toBeGreaterThan(0);
      const last = states[states.length - 1];
      expect(last?.state.loadingSections).toEqual(['codexMcp']);
    },
  );
});

describe('ControlPanelViewProvider.revealSection（issue #227、ホスト→webviewの逆向き経路）', () => {
  it('パネルを開いた状態でrevealSectionを呼ぶと、openSectionメッセージを対象セクションのidで送る', async () => {
    const { settings } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, sent } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await flushAsync();

    provider.revealSection('codexImport');

    expect(sent).toContainEqual({ type: 'openSection', id: 'codexImport' });
  });

  it('パネルを一度も開いていない（viewが無い）間は何もしない（例外を投げない）', () => {
    const { settings } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);

    expect(() => provider.revealSection('codexImport')).not.toThrow();
  });
});

describe('ControlPanelViewProvider（issue #358、パネル破棄時の参照クリア）', () => {
  it('viewが破棄されると参照をクリアし、以後のrevealSection/refreshは何もしない（例外を投げない）', async () => {
    const { settings } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view, sent, simulateDispose } = fakeWebviewView();
    provider.resolveWebviewView(view as never);
    await flushAsync();
    sent.length = 0;

    simulateDispose();

    expect(() => provider.revealSection('codexImport')).not.toThrow();
    await expect(provider.refresh()).resolves.toBeUndefined();
    // 破棄後は送り先（this.view）が無いので何も送られない
    expect(sent).toEqual([]);
  });
});

describe('CSPを`chatCsp()`へ集約する（issue #420）', () => {
  it('生成されるCSP文字列は、集約前に手組みしていたものとバイト単位で変わらない', async () => {
    const { settings } = fakeSettingsProvider();
    const { logger } = fakeLogger();
    const provider = new ControlPanelViewProvider(settings, logger);
    const { view } = fakeWebviewView();

    provider.resolveWebviewView(view as never);
    await flushAsync();

    const html = (view.webview as { html: string }).html;
    const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
    expect(match).not.toBeNull();
    const actualCsp = match?.[1] ?? '';

    // nonceは`render()`のたびに乱数で変わるため、実際に埋め込まれたnonceを抜き出して
    // 期待値の組み立てに使う（値そのものの一致ではなく、組み立て方が変わっていないことを見る）
    const nonceMatch = actualCsp.match(/script-src 'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch?.[1] ?? '';

    // 集約前にこのファイルへ直接手組みしていたディレクティブ列
    // （`"default-src 'none'"`, `style-src ${cspSource} 'unsafe-inline'`,
    // `script-src 'nonce-${nonce}'`を`; `で結合）と同一の値になることを確かめる。
    // この画面は画像を扱わないため`includeImgData: false`（既定はtrueで`img-src data:`が付く）
    const expectedCsp = chatCsp('https://fake-webview.test', nonce, { includeImgData: false });

    expect(actualCsp).toBe(expectedCsp);
    expect(actualCsp).toBe(
      "default-src 'none'; style-src https://fake-webview.test 'unsafe-inline'; " +
        `script-src 'nonce-${nonce}'`,
    );
  });
});
