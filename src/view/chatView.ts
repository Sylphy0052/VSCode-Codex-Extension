import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { defaultDenyResponse, type ApprovalDecision } from '../appserver/approvals';
import type { ChatState } from '../appserver/chatState';
import { ChatSession } from '../appserver/chatSession';
import { AppServerConnection, type ServerRequest } from '../appserver/connection';
import { readForkedThreadId } from '../codex/jsonRpc';
import { currentWorkspaceFolder, readConfig } from '../config';
import type { Logger } from '../log';
import { APPROVAL_MODES, SANDBOX_MODES } from '../codex/types';
import { isEditableKey, type SettingsProvider } from './settingsProvider';

interface ChatPanel {
  panel: vscode.WebviewPanel;
  session: ChatSession;
}

/**
 * Codex画面。app-server と繋いで会話をその場で描画し、承認と分岐も画面内で完結させる。
 *
 * TUIタブ方式と併存する。こちらは設定がターン単位で効き、会話の途中から直接分岐できる。
 */
export class ChatViewManager implements vscode.Disposable {
  private readonly connection: AppServerConnection;
  /** threadIdが確定するまでは undefined キーで1件だけ保持する。 */
  private readonly panels = new Map<string, ChatPanel>();
  private pending: ChatPanel | undefined;
  /** 名前変更コマンドの対象。最後にアクティブだったCodex画面。 */
  private active: ChatPanel | undefined;

  constructor(
    codexPath: () => string,
    private readonly settings: SettingsProvider,
    private readonly log: Logger,
  ) {
    this.connection = new AppServerConnection(
      codexPath,
      log,
      (method, params) => this.routeNotification(method, params),
      (request) => this.routeServerRequest(request),
    );
  }

  /** 新しい会話を開く。 */
  async openNew(): Promise<void> {
    const folder = currentWorkspaceFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage(
        'Codexを開始するにはフォルダを開いてください（ファイル > フォルダーを開く）',
      );
      return;
    }

    const entry = this.createPanel('Codex');
    this.pending = entry;
    try {
      const threadId = await entry.session.start(folder.uri.fsPath, readConfig().codex);
      this.pending = undefined;
      this.panels.set(threadId, entry);
    } catch (e) {
      this.pending = undefined;
      entry.panel.dispose();
      this.reportError(e);
    }
  }

  /** 既存のスレッドを開く。 */
  async openThread(threadId: string, title: string, cwd: string | undefined): Promise<void> {
    const existing = this.panels.get(threadId);
    if (existing !== undefined) {
      existing.panel.reveal();
      return;
    }

    const entry = this.createPanel(`Codex: ${title}`);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, cwd);
    } catch (e) {
      this.panels.delete(threadId);
      entry.panel.dispose();
      this.reportError(e);
    }
  }

  /**
   * リロード後にVSCodeが復元したパネルを引き取る。
   * webview側が `setState` で保持していた threadId を使い、会話を読み直す。
   */
  async restorePanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const threadId = readPersistedThreadId(state);
    if (threadId === undefined) {
      // どのスレッドか判らないパネルは残しても操作できない
      panel.dispose();
      return;
    }
    if (this.panels.has(threadId)) {
      panel.dispose();
      return;
    }

    const entry = this.adopt(panel);
    this.panels.set(threadId, entry);
    try {
      await entry.session.resume(threadId, undefined);
    } catch (e) {
      this.panels.delete(threadId);
      panel.dispose();
      this.reportError(e);
    }
  }

  private createPanel(title: string): ChatPanel {
    const panel = vscode.window.createWebviewPanel('codex.chat', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    return this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): ChatPanel {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = renderShell(panel.webview);

    const session = new ChatSession(this.connection, this.log, (state) => {
      // Codexが会話内容から名前を付けたらタブ名に反映する
      const next = state.name === undefined ? undefined : `Codex: ${state.name}`;
      if (next !== undefined && panel.title !== next) {
        panel.title = next;
      }
      void panel.webview.postMessage({
        type: 'state',
        state: { ...state, settings: this.settings.snapshot() },
      });
    });

    const entry: ChatPanel = { panel, session };
    this.active = entry;
    panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(entry, message),
    );
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = entry;
      }
    });
    panel.onDidDispose(() => {
      session.dispose();
      if (this.pending === entry) {
        this.pending = undefined;
      }
      if (this.active === entry) {
        this.active = undefined;
      }
      for (const [id, value] of this.panels) {
        if (value === entry) {
          this.panels.delete(id);
        }
      }
    });
    return entry;
  }

  private async handleMessage(entry: ChatPanel, message: unknown): Promise<void> {
    const m =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
    const type = m['type'];

    try {
      if (type === 'send' && typeof m['text'] === 'string' && m['text'].trim() !== '') {
        await entry.session.send(m['text'], readConfig().codex);
        return;
      }
      if (type === 'interrupt') {
        await entry.session.interrupt();
        return;
      }
      if (type === 'approve' && typeof m['decision'] === 'string') {
        const requestId = m['requestId'];
        if (typeof requestId === 'number' || typeof requestId === 'string') {
          entry.session.decide(requestId, m['decision'] as ApprovalDecision);
        }
        return;
      }
      if (type === 'fork' && typeof m['turnId'] === 'string') {
        await this.forkFrom(entry, m['turnId']);
        return;
      }
      if (type === 'config') {
        const key = m['key'];
        const value = m['value'];
        if (isEditableKey(key) && typeof value === 'string') {
          // 取り消された場合も表示を現在値へ戻すため、結果によらず再送する
          await this.settings.update(key, value);
        }
        this.refreshSettings();
        return;
      }
      if (type === 'ready') {
        this.refreshSettings();
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /** 会話の途中から分岐し、新しい画面で開く。元のスレッドは変更されない。 */
  private async forkFrom(entry: ChatPanel, turnId: string): Promise<void> {
    const threadId = entry.session.threadId;
    if (threadId === undefined) {
      return;
    }

    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'この指示から分岐しています…' },
      () => this.connection.request('thread/fork', { threadId, lastTurnId: turnId }),
    );

    const newThreadId = readForkedThreadId(response.result);
    if (newThreadId === undefined) {
      void vscode.window.showErrorMessage('分岐後のスレッドidを読み取れませんでした');
      return;
    }
    this.log.info(`分岐しました: ${threadId} → ${newThreadId}`);
    await this.openThread(newThreadId, '分岐', undefined);
  }

  /**
   * タブ名を変更する。Codex側に永続化されるため、履歴一覧やTUIタブにも反映される。
   * 名前は会話内容からCodexが自動で付けるので、これはその上書き。
   */
  async renameActive(): Promise<void> {
    const entry = this.active;
    if (entry === undefined || entry.session.threadId === undefined) {
      void vscode.window.showInformationMessage('名前を変更するCodex画面を開いてください');
      return;
    }

    const current = entry.session.getState().name ?? '';
    const name = await vscode.window.showInputBox({
      prompt: 'このセッションの名前',
      value: current,
      validateInput: (v) => (v.trim() === '' ? '名前を入力してください' : undefined),
    });
    if (name === undefined || name.trim() === '' || name === current) {
      return;
    }

    try {
      await entry.session.setName(name.trim());
    } catch (e) {
      this.reportError(e);
    }
  }

  /** 設定が外部で変わったときに、開いている全画面のプルダウンを更新する。 */
  refreshSettings(): void {
    const snapshot = this.settings.snapshot();
    for (const entry of this.allPanels()) {
      void entry.panel.webview.postMessage({
        type: 'state',
        state: { ...entry.session.getState(), settings: snapshot },
      });
    }
  }

  private allPanels(): ChatPanel[] {
    const entries = [...this.panels.values()];
    if (this.pending !== undefined && !entries.includes(this.pending)) {
      entries.push(this.pending);
    }
    return entries;
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    const target = this.findByThreadId(params['threadId']);
    target?.session.applyNotification(method, params);
  }

  private async routeServerRequest(request: ServerRequest): Promise<unknown> {
    const target = this.findByThreadId(request.params['threadId']);
    if (target === undefined) {
      // 対応する画面が無い要求に「許可」を返してはいけない
      this.log.warn(`宛先不明の要求を拒否しました: ${request.method}`);
      return defaultDenyResponse(request.method);
    }
    return target.session.requestApproval(request);
  }

  private findByThreadId(threadId: unknown): ChatPanel | undefined {
    if (typeof threadId === 'string' && this.panels.has(threadId)) {
      return this.panels.get(threadId);
    }
    // thread/start の応答が返る前に届く通知は、開始待ちの画面のもの
    return this.pending;
  }

  private reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error(`Codex画面: ${message}`);
    void vscode.window.showErrorMessage(`Codex: ${message}`);
  }

  dispose(): void {
    for (const entry of this.panels.values()) {
      entry.session.dispose();
      entry.panel.dispose();
    }
    this.panels.clear();
    this.connection.dispose();
  }
}

export type { ChatState };

/** webview側が `setState` で保持している値。 */
function readPersistedThreadId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const threadId = (state as Record<string, unknown>)['threadId'];
  return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
}

function renderShell(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  #log { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .item { margin-bottom: 12px; }
  .item .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 8px 10px;
    border-radius: 4px;
  }
  .user .body {
    background-color: var(--vscode-textBlockQuote-background);
    border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .agent .body { padding-left: 0; }
  .tool .body {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    background-color: var(--vscode-textCodeBlock-background);
    max-height: 240px;
    overflow: auto;
  }
  .reasoning .body { color: var(--vscode-descriptionForeground); font-style: italic; }
  .approval {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 4px;
    background-color: var(--vscode-inputValidation-warningBackground, transparent);
  }
  .approval h3 { margin: 0 0 6px; font-size: 1em; }
  .approval pre {
    margin: 0 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    padding: 4px 10px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background-color: var(--vscode-button-secondaryBackground);
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  #composer {
    display: flex;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  textarea {
    flex: 1;
    min-height: 54px;
    max-height: 200px;
    resize: vertical;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #status { padding: 0 16px 6px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  #settings {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 0 16px 12px;
  }
  #settings label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #settings select {
    padding: 2px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #settings select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="status"></div>
  <div id="composer">
    <textarea id="input" placeholder="Codexへの指示を入力（Ctrl+Enterで送信）"></textarea>
    <button id="send" type="button">送信</button>
    <button id="stop" type="button" class="secondary" hidden>中断</button>
  </div>
  <div id="settings">
    <label>モデル <select id="model"></select></label>
    <label>Effort <select id="reasoningEffort"></select></label>
    <label>承認 <select id="approvalMode">
      <option value="">既定</option>
      ${APPROVAL_MODES.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>
    <label>Sandbox <select id="sandbox">
      <option value="">既定</option>
      ${SANDBOX_MODES.map((m) => `<option value="${m}">${m}</option>`).join('')}
    </select></label>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);

  const KIND_LABEL = {
    userMessage: 'あなた',
    agentMessage: 'Codex',
    reasoning: '思考',
    commandExecution: 'コマンド',
    fileChange: 'ファイル変更',
    mcpToolCall: 'ツール',
    webSearch: 'Web検索',
    plan: '計画',
  };

  const CLASS_OF = {
    userMessage: 'user',
    agentMessage: 'agent',
    reasoning: 'reasoning',
    commandExecution: 'tool',
    fileChange: 'tool',
    mcpToolCall: 'tool',
  };

  function renderItem(item) {
    const wrap = document.createElement('div');
    wrap.className = 'item ' + (CLASS_OF[item.kind] || '');

    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    const bits = [KIND_LABEL[item.kind] || item.kind];
    if (item.detail) bits.push(item.detail);
    if (item.status) bits.push(item.status);
    label.textContent = bits.join(' ・ ');
    head.appendChild(label);

    if (item.kind === 'userMessage' && item.turnId) {
      const fork = document.createElement('button');
      fork.className = 'secondary';
      fork.textContent = 'ここから分岐';
      fork.addEventListener('click', () => {
        fork.disabled = true;
        vscode.postMessage({ type: 'fork', turnId: item.turnId });
      });
      head.appendChild(fork);
    }
    wrap.appendChild(head);

    if (item.text) {
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = item.text;
      wrap.appendChild(body);
    }
    return wrap;
  }

  function renderApproval(approval) {
    const wrap = document.createElement('div');
    wrap.className = 'approval';

    const title = document.createElement('h3');
    title.textContent = approval.title;
    wrap.appendChild(title);

    if (approval.detail) {
      const pre = document.createElement('pre');
      pre.textContent = approval.detail;
      wrap.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [label, decision, secondary] of [
      ['許可', 'accept', false],
      ['この会話では常に許可', 'acceptForSession', true],
      ['拒否', 'decline', true],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (secondary) button.className = 'secondary';
      button.addEventListener('click', () => {
        actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
        vscode.postMessage({ type: 'approve', requestId: approval.requestId, decision });
      });
      actions.appendChild(button);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function defaultLabel(value) {
    return value ? '既定: ' + value : '既定';
  }

  function fillSelect(select, values, current, defaultText, labelOf) {
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defaultText;
    select.appendChild(def);
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labelOf ? labelOf(v) : v;
      select.appendChild(o);
    }
    if (current !== '' && !values.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current + ' (一覧外)';
      select.appendChild(o);
    }
    select.value = current;
  }

  function applySettings(s) {
    if (!s) return;
    const nameOf = (slug) => {
      const m = s.models.find((x) => x.slug === slug);
      return m ? m.displayName : slug;
    };
    const d = s.defaults || {};
    fillSelect(
      el('model'),
      s.models.map((m) => m.slug),
      s.model,
      defaultLabel(d.model ? nameOf(d.model) : ''),
      nameOf,
    );
    fillSelect(el('reasoningEffort'), s.efforts, s.reasoningEffort, defaultLabel(d.reasoningEffort));
    for (const [id, value] of [['approvalMode', d.approvalMode], ['sandbox', d.sandbox]]) {
      const opt = el(id).querySelector('option[value=""]');
      if (opt) opt.textContent = defaultLabel(value);
    }
    el('approvalMode').value = s.approvalMode;
    el('sandbox').value = s.sandbox;
  }

  for (const key of ['model', 'reasoningEffort', 'approvalMode', 'sandbox']) {
    el(key).addEventListener('change', (e) => {
      vscode.postMessage({ type: 'config', key, value: e.target.value });
    });
  }

  function apply(state) {
    // リロード後にVSCodeがパネルを復元したとき、どのスレッドかを思い出すために保持する
    if (state.threadId) {
      vscode.setState({ threadId: state.threadId });
    }
    applySettings(state.settings);
    const log = el('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren();
    for (const item of state.items) log.appendChild(renderItem(item));
    for (const approval of state.approvals) log.appendChild(renderApproval(approval));
    if (atBottom) log.scrollTop = log.scrollHeight;

    el('stop').hidden = !state.busy;
    el('send').disabled = state.busy;
    const bits = [];
    if (state.busy) bits.push('応答中…');
    if (state.usage && state.usage.usedPercent !== undefined) {
      bits.push('使用量 ' + Math.round(state.usage.usedPercent) + '%');
    }
    if (state.usage && state.usage.totalTokens !== undefined) {
      bits.push(state.usage.totalTokens.toLocaleString() + ' tokens');
    }
    el('status').textContent = bits.join(' ・ ');
  }

  function send() {
    const input = el('input');
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }

  el('send').addEventListener('click', send);
  el('stop').addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  el('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') apply(event.data.state);
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
