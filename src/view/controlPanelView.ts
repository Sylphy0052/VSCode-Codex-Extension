import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { APPROVAL_MODES, SANDBOX_MODES } from '../codex/types';
import {
  formatResetsIn,
  formatWindow,
  severityOf,
  type UsageSeverity,
  type UsageSnapshot,
} from '../codex/usage';
import type { Logger } from '../log';
import {
  APPROVAL_LEVELS,
  APPROVAL_LEVEL_LABELS,
  approvalLevelMeta,
  isApprovalLevel,
} from '../provider/approvalLevel';
import { isProviderId } from '../provider/id';
import type { ImportHistoryItemTypeResultView, ImportHistorySnapshot } from '../provider/import';
import { chatCsp } from './chatCsp';
import { buildPanelAlert, type PanelAlert } from './controlPanelAlerts';
import { buildSectionSummaries, type SectionSummaries } from './controlPanelSummaries';
import { controlPanelScript } from './controlPanelScript';
import { controlPanelStyles } from './controlPanelStyles';
import { formatAbsoluteTime } from './relativeTime';
import {
  isClaudeEditableKey,
  isEditableKey,
  isSectionId,
  type ClaudeSettingsSnapshot,
  type SectionId,
  type SettingsProvider,
  type SettingsSnapshot,
} from './settingsProvider';

interface UsageView {
  percent: number;
  windowLabel: string;
  resets: string;
  plan: string;
  credits: string;
  capturedAt: string;
  severity: UsageSeverity;
}

/** インポート履歴の表示用整形（`completedAtMs` を文字列にする）。issue #36。 */
interface ImportHistoryEntryDisplay {
  importId: string;
  completedAt: string;
  providerId: string | undefined;
  results: ImportHistoryItemTypeResultView[];
}

type ImportHistoryDisplaySnapshot =
  { ok: true; entries: ImportHistoryEntryDisplay[] } | { ok: false; reason: string };

interface PanelState extends Omit<SettingsSnapshot, 'importHistory'> {
  usage: UsageView | undefined;
  claude: ClaudeSettingsSnapshot;
  importHistory: ImportHistoryDisplaySnapshot;
  /**
   * 取得中のセクション（issue #225 レビュー指摘1）。webview側はここに載っている
   * セクションを「取得できませんでした」ではなく「読み込み中」として描画する
   * （応答待ちの間に別セクションの操作で先に`state`が届いても、誤って失敗表示に
   * 化けないようにするため）。
   */
  loadingSections: SectionId[];
  /**
   * 先頭に出す異常のまとめ（issue #741）。無ければ`undefined`＝帯を出さない。
   * 判定は`controlPanelAlerts.ts`。
   */
  alert: PanelAlert | undefined;
  /**
   * 折りたたまれたセクションの見出しに出す集計（issue #740）。
   * 載っていないセクションは何も出さない。集計は`controlPanelSummaries.ts`。
   */
  sectionSummaries: SectionSummaries;
}

/**
 * サイドバーの操作パネル。モデル・reasoning effort・承認方法・sandboxを切り替える。
 *
 * ここでの変更は「次に開くセッション」に効く。実行中のセッションはCodex TUI側の
 * スラッシュコマンドで変更する（描画をTUIに委ねる構成上の帰結）。
 */
export class ControlPanelViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codex.controlPanel';

  private view: vscode.WebviewView | undefined;
  private usage: UsageSnapshot | undefined;

  constructor(
    private readonly settings: SettingsProvider,
    private readonly log: Logger,
  ) {}

  /** 使用量が更新されたときに外から差し込む。読み取りはUsageReaderの責務。 */
  setUsage(snapshot: UsageSnapshot | undefined): void {
    this.usage = snapshot;
    void this.post();
  }

  /**
   * 指定したセクションを展開させる（issue #227、design.md §14.34）。
   *
   * webview→ホストの`toggleSection`（セクションを展開したときの遅延取得、issue #225）とは
   * 逆向き（ホスト→webview）の経路がこれまで無かったため、新しく`openSection`メッセージを
   * 追加した。webview側（`controlPanelScript.ts`）はこれを受けてプロバイダのタブを
   * 切り替え、対象の`<details>`を`open = true`にする。それが`toggle`イベントを起こし、
   * 既存の`toggleSection`往復（→`ensureSectionLoaded`）へそのまま合流する。
   *
   * `view`がまだ無い（パネルを一度も開いていない）間は送り先が無いため何もしない。
   * 呼び出し側（`extension.ts`）は`codex.controlPanel.focus`コマンドで先にパネル自体を
   * 開いてから呼ぶ（`codex.showUsage`コマンドと同じ順序）。
   */
  revealSection(id: SectionId): void {
    void this.view?.webview.postMessage({ type: 'openSection', id });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    // パネルが破棄されたら参照をクリアする。chatView.tsのteardown（entry.panel = undefined）と
    // 同じく、破棄後にrevealSection/postが古いviewへpostMessageし続けないようにする。
    view.onDidDispose(() => {
      this.view = undefined;
    });

    void this.refresh();
  }

  /** 設定やカタログの変化をパネルへ反映する。 */
  async refresh(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    await this.settings.load();
    await this.loadHooksForAlert();
    await this.post();
  }

  /**
   * hooksは折りたたまれていても読む（issue #741）。
   *
   * 他のセクションは開いたときにだけ読む（issue #225。パネルを開いた直後にCLIを
   * いくつも起動しないため）が、hooksだけは例外にする。hooksは任意のコマンドを実行する
   * 仕組みで、未信頼のものがあることに気付けないまま実行されるのが最悪の結果になる。
   * 起動コスト1回と引き換えにしてよい。
   *
   * `ensureSectionLoaded`は既に取得済みなら何もしないため、2回目以降の`refresh`で
   * 余計な起動は増えない（`load()`が展開済みセクションとして読み直す対象にはなる）。
   */
  private async loadHooksForAlert(): Promise<void> {
    await Promise.all([
      this.settings.ensureSectionLoaded('codexHooks'),
      this.settings.ensureSectionLoaded('claudeHooks'),
    ]);
  }

  private async post(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'state', state: this.buildState() });
  }

  private buildState(): PanelState {
    const snapshot = this.settings.snapshot();
    const claude = this.settings.claudeSnapshot();
    return {
      ...snapshot,
      usage: buildUsageView(this.usage),
      claude,
      importHistory: buildImportHistoryView(snapshot.importHistory),
      loadingSections: this.settings.loadingSections,
      // 折りたたまれたセクションの中にしか出ていない異常を最上部へ引き上げる（issue #741）。
      // 判定はホスト側で行い、webviewへは結果だけを渡す
      alert: buildPanelAlert({
        codexHooks: snapshot.hooks,
        claudeHooks: claude.hooks,
        codexMcp: snapshot.mcpServers,
        claudeMcp: claude.mcpServers,
        loadedSections: this.settings.loadedSectionIds,
      }),
      // 閉じたままでも中身の状態が読めるようにする（issue #740）
      sectionSummaries: buildSectionSummaries({
        codexMcp: snapshot.mcpServers,
        codexHooks: snapshot.hooks,
        codexSkills: snapshot.skills,
        codexPlugins: snapshot.plugins,
        codexApps: snapshot.apps,
        claudeMcp: claude.mcpServers,
        claudeHooks: claude.hooks,
        claudeSkills: claude.skills,
        claudePlugins: claude.plugins,
        loadedSections: this.settings.loadedSectionIds,
      }),
    };
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;

    if (m['type'] === 'ready') {
      await this.refresh();
      return;
    }

    if (m['type'] === 'toggleSection') {
      // セクションを展開したときの遅延取得（issue #225）。未取得なら取得し、
      // 取得済みならCLIを起動し直さずに現在の状態をそのまま送り返す
      // （webview側は応答を待つあいだ読み込み中の表示を出している）
      const id = m['id'];
      if (!isSectionId(id)) {
        this.log.warn(`セクションの展開要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.settings.ensureSectionLoaded(id);
      await this.post();
      return;
    }

    if (m['type'] === 'newSession') {
      await vscode.commands.executeCommand(
        m['provider'] === 'claude' ? 'claude.newChat' : 'codex.newChat',
      );
      return;
    }

    if (m['type'] === 'updateApprovalLevel') {
      // 承認レベル（3段階）はCodexでは3項目、Claude Codeでは1項目へ展開して書く。
      // どちらのプロバイダを触っているかはwebview側が渡す
      const provider = m['provider'];
      const level = m['level'];
      if (!isProviderId(provider) || !isApprovalLevel(level)) {
        this.log.warn(`承認レベルの変更要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      // 取り消された場合も表示を現在値へ戻す必要がある
      await this.settings.updateApprovalLevel(provider, level);
      await this.post();
      return;
    }

    if (m['type'] === 'updateClaude') {
      const key = m['key'];
      const value = m['value'];
      if (!isClaudeEditableKey(key) || typeof value !== 'string') {
        this.log.warn(`変更を許可していないキーです: ${String(key)}`);
        return;
      }
      // 取り消された場合も表示を現在値へ戻す必要がある
      await this.settings.updateClaude(key, value);
      await this.post();
      return;
    }

    if (m['type'] === 'toggleMcp') {
      const cli = m['cli'];
      const name = m['name'];
      const enabled = m['enabled'];
      if ((cli !== 'codex' && cli !== 'claude') || typeof name !== 'string' || name === '') {
        this.log.warn(`MCPサーバーの切替要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.settings.toggleMcpServer(cli, name, enabled === true);
      // 成功/失敗にかかわらず、実際の状態を読み直してから表示する
      await this.refresh();
      return;
    }

    if (m['type'] === 'trustHook') {
      // Codex専用（issue #28）。Claude Codeには信頼を書き込む経路が無い
      const key = m['key'];
      const hash = m['hash'];
      if (typeof key !== 'string' || key === '' || typeof hash !== 'string' || hash === '') {
        this.log.warn(`hookの信頼要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.settings.trustCodexHook(key, hash);
      await this.refresh();
      return;
    }

    if (m['type'] === 'toggleSkill') {
      // Codex専用（issue #35）。Claude Codeには有効/無効を切り替える経路が無い
      const path = m['path'];
      const enabled = m['enabled'];
      if (typeof path !== 'string' || path === '') {
        this.log.warn(`skillの切替要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.settings.toggleCodexSkill(path, enabled === true);
      await this.refresh();
      return;
    }

    if (m['type'] === 'reloadClaudeSkills') {
      // Claude Code専用（issue #202、design.md TP-90）。Codexには`reload_skills`に
      // 相当する制御要求が無く、一覧の取得自体は`refresh()`のたびに毎回新しく読んでいる
      // ため「読み直す」操作を別途持つ意味が無い（`skills/list`はforceReloadを渡さない
      // 限り単なる再読込であり、専用ボタンはClaude Codeにしか無い理由になる）
      await this.settings.reloadClaudeSkills();
      // 開いている会話があれば、そちらのプロセスへも送る。設定パネルの
      // `ClaudeSkillsProbe`は単発プロセスで、既に開いている会話には触れられないため、
      // VS Codeコマンド経由で`ClaudeChatViewManager`へ橋渡しする（`newSession`と同じ形）
      await vscode.commands.executeCommand('claude.reloadSkills');
      await this.post();
      return;
    }

    if (m['type'] === 'togglePlugin') {
      // Claude Code専用（issue #32）。Codexには有効/無効を切り替える経路が無い
      const cli = m['cli'];
      const id = m['id'];
      const scope = m['scope'];
      const enabled = m['enabled'];
      if (cli !== 'claude' || typeof id !== 'string' || id === '') {
        this.log.warn(`pluginの切替要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.settings.toggleClaudePlugin(
        id,
        typeof scope === 'string' ? scope : undefined,
        enabled === true,
      );
      await this.refresh();
      return;
    }

    if (m['type'] === 'uninstallPlugin') {
      const cli = m['cli'];
      const id = m['id'];
      const name = m['name'];
      const scope = m['scope'];
      if (
        (cli !== 'codex' && cli !== 'claude') ||
        typeof id !== 'string' ||
        id === '' ||
        typeof name !== 'string' ||
        name === ''
      ) {
        this.log.warn(`pluginのアンインストール要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      const result =
        cli === 'codex'
          ? await this.settings.uninstallCodexPlugin(id, name)
          : await this.settings.uninstallClaudePlugin(
              id,
              typeof scope === 'string' ? scope : undefined,
              name,
            );
      if (!result.ok && result.error !== undefined) {
        void vscode.window.showErrorMessage(
          `pluginをアンインストールできませんでした: ${result.error}`,
        );
      }
      await this.refresh();
      return;
    }

    if (m['type'] === 'installPlugin') {
      const cli = m['cli'];
      if (cli !== 'codex' && cli !== 'claude') {
        this.log.warn(`pluginのインストール要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      await this.installPlugin(cli);
      return;
    }

    if (m['type'] === 'runCodexImport') {
      // Codex専用（issue #36、design.md TP-57）。設定を書き換えうる操作のため、
      // `SettingsProvider.runCodexImport` 側で確認ダイアログを必ず挟む
      const keys = m['keys'];
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
        this.log.warn(`インポート実行要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      const result = await this.settings.runCodexImport(keys as string[]);
      if (!result.ok) {
        if (result.error !== undefined) {
          void vscode.window.showErrorMessage(`インポートを実行できませんでした: ${result.error}`);
        }
        await this.refresh();
        return;
      }
      if (result.results === undefined) {
        void vscode.window.showInformationMessage(
          `インポートを開始しました（importId: ${result.importId}）。完了の通知が届かなかったため、結果は下の履歴一覧で後から確認してください。`,
        );
      } else {
        const failed = result.results.filter((r) => r.failureCount > 0);
        if (failed.length > 0) {
          void vscode.window.showWarningMessage(
            `インポートが完了しましたが、一部失敗しました: ${failed.map((r) => r.label).join('、')}`,
          );
        } else {
          void vscode.window.showInformationMessage('インポートが完了しました。');
        }
      }
      await this.refresh();
      return;
    }

    if (m['type'] === 'logoutCodex') {
      await this.runAccountAction(() => this.settings.logoutCodex(), 'Codexからログアウト');
      return;
    }

    if (m['type'] === 'logoutClaude') {
      await this.runAccountAction(() => this.settings.logoutClaude(), 'Claude Codeからログアウト');
      return;
    }

    if (m['type'] === 'loginCodexApiKey') {
      const apiKey = await vscode.window.showInputBox({
        title: 'OpenAIのAPIキーでログイン',
        prompt: 'APIキーを入力してください。値は画面にもログにも表示されません。',
        password: true,
        ignoreFocusOut: true,
      });
      // 空文字も含め未入力なら中止する（誤って空キーでログインを試みない）
      if (apiKey === undefined || apiKey === '') {
        return;
      }
      await this.runAccountAction(
        () => this.settings.loginCodexApiKey(apiKey),
        'CodexへAPIキーでログイン',
      );
      return;
    }

    if (m['type'] === 'openLoginTerminal') {
      const cli = m['cli'];
      if (cli !== 'codex' && cli !== 'claude') {
        this.log.warn(`ログイン用ターミナルの要求が不正です: ${JSON.stringify(m)}`);
        return;
      }
      openLoginTerminal(cli);
      return;
    }

    if (m['type'] !== 'update') {
      return;
    }

    const key = m['key'];
    const value = m['value'];
    if (!isEditableKey(key) || typeof value !== 'string') {
      this.log.warn(`変更を許可していないキーです: ${String(key)}`);
      return;
    }

    // 取り消された場合も表示を現在値へ戻す必要がある
    await this.settings.update(key, value);
    await this.post();
  }

  /**
   * pluginをインストールする（issue #32）。
   *
   * どちらも名前をテキスト入力で受ける（既存の `loginCodexApiKey` と同じ
   * `showInputBox` パターン）。Codexは `plugin/install` が名前だけでは対象を特定できない
   * （マーケットプレイスの指定が要る。スキーマ根拠）ため、続けてマーケットプレイスを
   * `showQuickPick` で選ばせる。確認ダイアログ（「何をどこから入れるか」の明示）は
   * `SettingsProvider.installCodexPlugin` / `installClaudePlugin` 側で必ず挟む。
   */
  private async installPlugin(cli: 'codex' | 'claude'): Promise<void> {
    const pluginName = await vscode.window.showInputBox({
      title: 'pluginをインストール',
      prompt:
        cli === 'codex'
          ? 'インストールするpluginの名前を入力してください（例: github）'
          : 'インストールするpluginを入力してください（例: name または name@marketplace）',
      ignoreFocusOut: true,
    });
    if (pluginName === undefined || pluginName === '') {
      return;
    }

    if (cli === 'claude') {
      await this.runAccountAction(
        () => this.settings.installClaudePlugin(pluginName),
        'pluginのインストール',
      );
      return;
    }

    const snapshot = this.settings.snapshot().plugins;
    const marketplaces = snapshot.ok ? snapshot.marketplaces : [];
    if (marketplaces.length === 0) {
      void vscode.window.showErrorMessage(
        'マーケットプレイスの一覧を取得できていないため、インストールできません。',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      marketplaces.map((m) => ({
        label: m.displayName ?? m.name,
        description: m.name,
        marketplace: m,
      })),
      { title: 'インストール元のマーケットプレイスを選択', ignoreFocusOut: true },
    );
    if (picked === undefined) {
      return;
    }
    await this.runAccountAction(
      () =>
        this.settings.installCodexPlugin(pluginName, {
          name: picked.marketplace.name,
          path: picked.marketplace.path,
        }),
      'pluginのインストール',
    );
  }

  /**
   * ログイン/ログアウト操作を実行し、結果にかかわらず実際の状態を読み直して表示する
   * （issue #29）。確認ダイアログでの取り消し（`error` が `undefined`）は静かに終える。
   * 失敗時だけエラーを通知する。
   */
  private async runAccountAction(
    action: () => Promise<{ ok: true } | { ok: false; error: string | undefined }>,
    label: string,
  ): Promise<void> {
    const result = await action();
    if (!result.ok && result.error !== undefined) {
      void vscode.window.showErrorMessage(`${label}に失敗しました: ${result.error}`);
    }
    await this.refresh();
  }

  private render(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    // #376で集約したCSP組み立てへ揃える（issue #420）。この画面は画像を扱わないため
    // `chatView.ts`/`claudeChatView.ts`と同じく`includeImgData: false`を渡す。値は
    // ここに手組みしていたディレクティブ列と同一（バイト単位で変わらないことをテストで確認）
    const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });

    const approvalOptions = APPROVAL_MODES.map((m) => `<option value="${m}">${m}</option>`).join(
      '',
    );
    const sandboxOptions = SANDBOX_MODES.map((m) => `<option value="${m}">${m}</option>`).join('');
    // 承認レベル（3段階）の選択肢。CodexとClaude Codeで同じ語彙・同じ並びを使う
    const levelOptions = APPROVAL_LEVELS.map(
      (level) => `<option value="${level}">${APPROVAL_LEVEL_LABELS[level]}</option>`,
    ).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${controlPanelStyles()}
</style>
</head>
<body>
  <!-- 折りたたまれたセクションの中にしか出ていない異常のまとめ（issue #741）。
       タブより上に置き、どちらのプロバイダを見ていても目に入るようにする -->
  <button type="button" id="alertBanner" hidden></button>

  <div class="tabs" role="tablist">
    <button id="tabCodex" type="button" role="tab" aria-selected="true">Codex</button>
    <button id="tabClaude" type="button" role="tab" aria-selected="false">Claude Code</button>
  </div>

  <div id="panelCodex">
  <div class="usage" id="usage" hidden>
    <div class="usage-head">
      <span id="usageLabel"></span><span class="percent" id="usagePercent"></span>
    </div>
    <div class="bar"><div class="fill" id="usageFill"></div></div>
    <div class="hint" id="usageMeta"></div>
  </div>

  <div class="row">
    <label for="model">モデル</label>
    <select id="model"></select>
    <div class="hint" id="modelHint"></div>
  </div>

  <div class="row">
    <label for="reasoningEffort">Reasoning effort</label>
    <select id="reasoningEffort"></select>
    <div class="hint" id="effortHint"></div>
  </div>

  <div class="row">
    <label for="approvalLevel">承認</label>
    <select id="approvalLevel">
      ${levelOptions}
    </select>
    <div class="hint" id="approvalLevelHint"></div>
  </div>

  <details class="section subsection">
  <summary class="sectionTitle">承認の詳細</summary>
  <div class="sectionBody">
  <div class="row">
    <label for="approvalMode">承認方法</label>
    <select id="approvalMode">
      <option value="">既定 (config.toml)</option>
      ${approvalOptions}
    </select>
  </div>

  <div class="row">
    <label for="sandbox">サンドボックス</label>
    <select id="sandbox">
      <option value="">既定 (config.toml)</option>
      ${sandboxOptions}
    </select>
  </div>
  </div>
  </details>

  <button id="newSession" type="button">この設定で新しい会話を開く</button>

  <p class="note">「既定」はCodex側の <code>config.toml</code> の値を使います。ここでの変更は次に開くセッションに適用されます。実行中のセッションはタブ内のCodexで変更してください。</p>
  <p class="note" id="profileNote"></p>

  <details class="section" id="section-codexAccount">
  <summary class="sectionTitle">アカウント</summary>
  <div class="sectionBody">
  <div class="accountBox" id="accountCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexMcp">
  <summary class="sectionTitle">MCPサーバー<span class="sectionCount" id="count-codexMcp"></span></summary>
  <div class="sectionBody">
  <div class="mcpList" id="mcpListCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexHooks">
  <summary class="sectionTitle">hooks<span class="sectionCount" id="count-codexHooks"></span></summary>
  <div class="sectionBody">
  <p class="note">hooksは任意のコマンドを実行する仕組みです。特にプロジェクト側で定義されたhookは、cloneしただけで任意コマンドが動く経路になりえます。何が実行されるかを確認してから信頼してください。</p>
  <div class="hooksList" id="hooksListCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexSkills">
  <summary class="sectionTitle">skills<span class="sectionCount" id="count-codexSkills"></span></summary>
  <div class="sectionBody">
  <p class="note">skillsはモデルへ渡す指示（プロンプト）です。特にプロジェクト側で定義されたskillは、cloneしただけで効く経路になりえます。どこ由来かを確認してから使ってください。</p>
  <div class="skillsList" id="skillsListCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexPlugins">
  <summary class="sectionTitle">plugins<span class="sectionCount" id="count-codexPlugins"></span></summary>
  <div class="sectionBody">
  <p class="note">pluginは任意のコード（hookやMCPサーバーなど）を持ち込む仕組みです。中身を確認してから使ってください。Codexには有効/無効を切り替える経路がありません（実測。導入済みかどうかはインストール/アンインストールで扱います）。</p>
  <div class="pluginsList" id="pluginsListCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexApps">
  <summary class="sectionTitle">apps<span class="sectionCount" id="count-codexApps"></span></summary>
  <div class="sectionBody">
  <p class="note">appはChatGPTに接続されたコネクタです。この一覧は閲覧のみです。Codexには有効/無効・インストール/アンインストールを拡張機能から操作する確定した経路がありません。</p>
  <div class="appsList" id="appsListCodex"></div>
  </div>
  </details>

  <details class="section" id="section-codexImport">
  <summary class="sectionTitle">他エージェントからの設定インポート</summary>
  <div class="sectionBody">
  <p class="note">Claude Codeの設定・skills・plugins・最近のセッションなどをCodexへ取り込みます。既存の設定を上書きすることがあるため、実行前に必ず内容を確認してください。</p>
  <div class="importList" id="importListCodex"></div>
  <h3 class="sectionSubTitle">インポート履歴</h3>
  <div class="importHistoryList" id="importHistoryListCodex"></div>
  </div>
  </details>
  </div>

  <div id="panelClaude" hidden>
    <div class="row">
      <label for="claudeModel">モデル</label>
      <select id="claudeModel"></select>
      <div class="hint" id="claudeModelHint"></div>
    </div>

    <div class="row">
      <label for="claudeEffort">Effort</label>
      <select id="claudeEffort"></select>
      <div class="hint" id="claudeEffortHint"></div>
    </div>

    <div class="row">
      <label for="claudeApprovalLevel">承認</label>
      <select id="claudeApprovalLevel">
        ${levelOptions}
      </select>
      <div class="hint" id="claudeApprovalLevelHint"></div>
    </div>

    <details class="section subsection">
    <summary class="sectionTitle">承認の詳細</summary>
    <div class="sectionBody">
    <div class="row">
      <label for="claudePermissionMode">承認方法</label>
      <select id="claudePermissionMode"></select>
    </div>

    <div class="row">
      <label for="claudeAgent">エージェント</label>
      <select id="claudeAgent"></select>
      <div class="hint" id="claudeAgentHint"></div>
    </div>
    </div>
    </details>

    <button id="newClaudeSession" type="button">この設定で新しい会話を開く</button>

    <p class="note">「既定」はClaude Code側の <code>settings.json</code> の値を使います。使用量はチャット画面に表示されます（ステータスバーはCodex専用）。</p>

    <details class="section" id="section-claudeAccount">
    <summary class="sectionTitle">アカウント</summary>
    <div class="sectionBody">
    <div class="accountBox" id="accountClaude"></div>
    </div>
    </details>

    <details class="section" id="section-claudeMcp">
    <summary class="sectionTitle">MCPサーバー<span class="sectionCount" id="count-claudeMcp"></span></summary>
    <div class="sectionBody">
    <div class="mcpList" id="mcpListClaude"></div>
    </div>
    </details>

    <details class="section" id="section-claudeHooks">
    <summary class="sectionTitle">hooks<span class="sectionCount" id="count-claudeHooks"></span></summary>
    <div class="sectionBody">
    <p class="note">hooksは任意のコマンドを実行する仕組みです。特にプロジェクト側で定義されたhookは、cloneしただけで任意コマンドが動く経路になりえます。Claude Codeにはこの拡張機能から信頼状態を確認・操作する経路がありません（実測。CLI側の挙動に委ねます）。</p>
    <div class="hooksList" id="hooksListClaude"></div>
    </div>
    </details>

    <details class="section" id="section-claudeSkills">
    <summary class="sectionTitle">skills<span class="sectionCount" id="count-claudeSkills"></span></summary>
    <div class="sectionBody">
    <p class="note">skillsはモデルへ渡す指示（プロンプト）です。特にプロジェクト側で定義されたskillは、cloneしただけで効く経路になりえます。Claude Codeにはこの拡張機能から有効/無効を切り替える経路がありません（実測。出どころの表示はCLIの説明文からの推測です）。</p>
    <button id="reloadClaudeSkills" type="button">skillsを読み直す</button>
    <p class="note">会話中にディスク上へ増減したskillを読み直します。開いている会話があれば、そちらのスラッシュコマンド候補も入れ替わります。</p>
    <div class="skillsList" id="skillsListClaude"></div>
    </div>
    </details>

    <details class="section" id="section-claudePlugins">
    <summary class="sectionTitle">plugins<span class="sectionCount" id="count-claudePlugins"></span></summary>
    <div class="sectionBody">
    <p class="note">pluginは任意のコード（hookやMCPサーバーなど）を持ち込む仕組みです。中身を確認してから使ってください。Claude Codeは <code>claude plugin</code> CLI経由で有効/無効・インストール/アンインストールをすべて操作できます。</p>
    <div class="pluginsList" id="pluginsListClaude"></div>
    </div>
    </details>
  </div>

<script nonce="${nonce}">
${controlPanelScript(JSON.stringify(approvalLevelMeta()))}
</script>
</body>
</html>`;
  }
}

/** 表示用の整形はここで済ませ、Webview側のスクリプトを単純に保つ。 */
function buildUsageView(snapshot: UsageSnapshot | undefined): UsageView | undefined {
  if (snapshot?.usedPercent === undefined) {
    return undefined;
  }
  return {
    percent: Math.round(snapshot.usedPercent),
    windowLabel: formatWindow(snapshot.windowMinutes) || '制限',
    resets: formatResetsIn(snapshot.resetsAt, Date.now()),
    plan: snapshot.planType ?? '',
    credits: snapshot.creditsBalance ?? '',
    capturedAt: snapshot.capturedAt === undefined ? '' : formatAbsoluteTime(snapshot.capturedAt),
    severity: severityOf(snapshot.usedPercent),
  };
}

/** インポート履歴の `completedAtMs`（epoch ms）を表示用の文字列にする（issue #36）。 */
function buildImportHistoryView(snapshot: ImportHistorySnapshot): ImportHistoryDisplaySnapshot {
  if (!snapshot.ok) {
    return snapshot;
  }
  return {
    ok: true,
    entries: snapshot.entries.map((entry) => ({
      importId: entry.importId,
      completedAt: formatAbsoluteTime(new Date(entry.completedAtMs).toISOString()),
      providerId: entry.providerId,
      results: entry.results,
    })),
  };
}

const LOGIN_TERMINAL_NAME = 'Agent Sessions: ログイン';
/** ブラウザでのOAuthを要するログインコマンド。両方ともCLIの`--help`で確認済み。 */
const LOGIN_COMMANDS: Record<'codex' | 'claude', string> = {
  codex: 'codex login',
  claude: 'claude auth login',
};

/**
 * ブラウザでの操作が必要なログインをターミナルへ委ねる（issue #29）。
 *
 * コマンドは入力するだけで**自動実行はしない**（`sendText` の第2引数を `false` にする）。
 * ユーザーがコマンドを目で確認し、自分でEnterを押して初めて実行される。
 */
function openLoginTerminal(cli: 'codex' | 'claude'): void {
  const existing = vscode.window.terminals.find((t) => t.name === LOGIN_TERMINAL_NAME);
  const terminal = existing ?? vscode.window.createTerminal(LOGIN_TERMINAL_NAME);
  terminal.show();
  terminal.sendText(LOGIN_COMMANDS[cli], false);
}
