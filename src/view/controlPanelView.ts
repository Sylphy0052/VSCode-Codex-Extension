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
import { controlPanelScript } from './controlPanelScript';
import { controlPanelStyles } from './controlPanelStyles';
import { formatAbsoluteTime } from './relativeTime';
import {
  isClaudeEditableKey,
  isEditableKey,
  type ClaudeSettingsSnapshot,
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

interface PanelState extends SettingsSnapshot {
  usage: UsageView | undefined;
  claude: ClaudeSettingsSnapshot;
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    void this.refresh();
  }

  /** 設定やカタログの変化をパネルへ反映する。 */
  async refresh(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    await this.settings.load();
    await this.post();
  }

  private async post(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'state', state: this.buildState() });
  }

  private buildState(): PanelState {
    return {
      ...this.settings.snapshot(),
      usage: buildUsageView(this.usage),
      claude: this.settings.claudeSnapshot(),
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

    if (m['type'] === 'newSession') {
      await vscode.commands.executeCommand(
        m['provider'] === 'claude' ? 'claude.newChat' : 'codex.newChat',
      );
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

  private render(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const approvalOptions = APPROVAL_MODES.map((m) => `<option value="${m}">${m}</option>`).join(
      '',
    );
    const sandboxOptions = SANDBOX_MODES.map((m) => `<option value="${m}">${m}</option>`).join('');

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

  <button id="newSession" type="button">この設定で新しい会話を開く</button>

  <p class="note">「既定」はCodex側の <code>config.toml</code> の値を使います。ここでの変更は次に開くセッションに適用されます。実行中のセッションはタブ内のCodexで変更してください。</p>
  <p class="note" id="profileNote"></p>

  <h2 class="sectionTitle">MCPサーバー</h2>
  <div class="mcpList" id="mcpListCodex"></div>
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
      <label for="claudePermissionMode">承認方法</label>
      <select id="claudePermissionMode"></select>
    </div>

    <button id="newClaudeSession" type="button">この設定で新しい会話を開く</button>

    <p class="note">「既定」はClaude Code側の <code>settings.json</code> の値を使います。使用量はチャット画面に表示されます（ステータスバーはCodex専用）。</p>

    <h2 class="sectionTitle">MCPサーバー</h2>
    <div class="mcpList" id="mcpListClaude"></div>
  </div>

<script nonce="${nonce}">
${controlPanelScript()}
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
