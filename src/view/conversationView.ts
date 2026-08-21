import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseConversation, type ConversationTurn } from '../codex/conversation';
import type { SessionSummary } from '../codex/types';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import type { SessionStore } from '../session/sessionStore';
import { chatCsp } from './chatCsp';
import { formatAbsoluteTime } from './relativeTime';

export type ForkHandler = (session: SessionSummary, turnId: string) => Promise<void>;

/**
 * 会話を読みながら分岐点を選ぶためのビューア。
 *
 * Codexの応答をそのまま再現するのが目的ではなく、「どの指示まで戻すか」を判断できる
 * だけの文脈を出すことが目的。そのためMarkdownの描画は行わず、本文はすべてエスケープして
 * そのまま表示する（会話の内容は信頼できない入力として扱う）。
 */
export class ConversationViewManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly fs: FileSystemPort,
    private readonly store: SessionStore,
    private readonly log: Logger,
    private readonly onFork: ForkHandler,
  ) {}

  async open(session: SessionSummary): Promise<void> {
    const existing = this.panels.get(session.id);
    if (existing !== undefined) {
      existing.reveal();
      return;
    }

    const path = await this.store.resolveRolloutPath(session.id);
    if (path === undefined) {
      void vscode.window.showErrorMessage('このセッションの記録が見つかりません');
      return;
    }

    const content = await this.fs.readTextFile(path);
    if (content === undefined) {
      void vscode.window.showErrorMessage('セッションの記録を読めませんでした');
      return;
    }

    const turns = parseConversation(content);
    if (turns.length === 0) {
      void vscode.window.showInformationMessage('分岐できる指示がまだありません');
      return;
    }

    const title = session.threadName ?? session.id.slice(0, 8);
    const panel = vscode.window.createWebviewPanel(
      'codex.conversation',
      `会話: ${title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panels.set(session.id, panel);
    panel.onDidDispose(() => this.panels.delete(session.id));

    panel.webview.html = render(panel.webview, title, turns);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const turnId = readForkRequest(message);
      if (turnId === undefined) {
        return;
      }
      this.log.info(`分岐を要求: session=${session.id} turn=${turnId}`);
      void this.onFork(session, turnId);
    });
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

function readForkRequest(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const m = message as Record<string, unknown>;
  if (m['type'] !== 'fork') {
    return undefined;
  }
  const turnId = m['turnId'];
  return typeof turnId === 'string' && turnId !== '' ? turnId : undefined;
}

/** 会話本文は信頼できない入力として扱い、必ずエスケープする。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param previousTurnId 直前のターン。分岐は「この指示の手前まで」を引き継ぐため、
 *   クリックした指示そのものは含めない。最初の指示には手前が無いのでボタンを出さない。
 */
function renderTurn(
  turn: ConversationTurn,
  index: number,
  previousTurnId: string | undefined,
): string {
  const time = turn.timestamp === undefined ? '' : formatAbsoluteTime(turn.timestamp);
  const tools = summarizeTools(turn.toolNames);
  const agent = turn.agentMessages
    .map((m) => `<div class="bubble agent">${escapeHtml(m)}</div>`)
    .join('');
  const forkButton =
    previousTurnId === undefined
      ? ''
      : `<button type="button" data-turn="${escapeHtml(previousTurnId)}">ここから分岐</button>`;

  return `<article class="turn">
  <header>
    <span class="meta">#${index + 1}${time === '' ? '' : ` ・ ${time}`}${tools === '' ? '' : ` ・ ${escapeHtml(tools)}`}</span>
    ${forkButton}
  </header>
  <div class="bubble user">${escapeHtml(turn.userMessage)}</div>
  ${agent}
</article>`;
}

function summarizeTools(names: readonly string[]): string {
  if (names.length === 0) {
    return '';
  }
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(', ');
}

function render(webview: vscode.Webview, title: string, turns: ConversationTurn[]): string {
  const nonce = randomBytes(16).toString('base64');
  // このビューアは画像を扱わない（本文はすべてエスケープしてそのまま表示するだけ）ため、
  // chatCsp()の既定であるimg-src data:は意図的に含めない（chatCsp.ts参照）。
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 16px 32px;
    max-width: 900px;
  }
  h1 { font-size: 1.2em; margin: 0 0 4px; }
  .lead { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
  .turn {
    padding: 10px 0 14px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .turn header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  button {
    flex: none;
    padding: 3px 10px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button:hover {
    background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
  }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .bubble {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 8px 10px;
    border-radius: 4px;
    margin-bottom: 6px;
  }
  .user {
    background-color: var(--vscode-textBlockQuote-background);
    border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .agent { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">「ここから分岐」を押すと、<strong>その指示の手前まで</strong>を引き継いだ新しいセッションが別タブで開きます。押した指示からやり直せます。元のセッションは変更されません。</p>
  ${turns.map((turn, i) => renderTurn(turn, i, turns[i - 1]?.turnId)).join('\n')}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-turn]');
    if (!button) return;
    button.disabled = true;
    button.textContent = '分岐しています…';
    vscode.postMessage({ type: 'fork', turnId: button.dataset.turn });
  });
</script>
</body>
</html>`;
}
