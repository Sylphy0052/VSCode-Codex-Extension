import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseConversation, type ConversationTurn } from '../codex/conversation';
import type { SessionSummary } from '../codex/types';
import type { Logger } from '../log';
import type { FileSystemPort } from '../session/ports';
import type { SessionStore } from '../session/sessionStore';
import { chatCsp } from './chatCsp';
import { formatAbsoluteTime } from './relativeTime';

/**
 * 分岐を実行する。成功したかを返す（Issue #1156）。
 *
 * 押した時点でwebview側がボタンを無効化するため、失敗したことを返さないと画面が
 * 「分岐しています…」のまま固まり、同じ指示から再試行できない。
 */
export type ForkHandler = (session: SessionSummary, turnId: string) => Promise<boolean>;

/**
 * webviewへ渡すターン数の上限（Issue #1325）。
 *
 * rolloutは上限なく伸びるため、全ターンをHTMLへ展開すると開いたときのメモリとwebview描画が
 * ターン数に比例して無制限に重くなる。直近のみを表示し、それより前は省略した旨だけ出す。
 */
const MAX_CONVERSATION_TURNS = 300;

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
    const omittedCount = Math.max(0, turns.length - MAX_CONVERSATION_TURNS);
    const visibleTurns = omittedCount === 0 ? turns : turns.slice(omittedCount);

    const title = session.threadName ?? session.id.slice(0, 8);
    const panel = vscode.window.createWebviewPanel(
      'codex.conversation',
      `会話: ${title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panels.set(session.id, panel);
    panel.onDidDispose(() => this.panels.delete(session.id));

    panel.webview.html = render(panel.webview, title, visibleTurns, omittedCount);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const turnId = readForkRequest(message);
      if (turnId === undefined) {
        return;
      }
      this.log.info(`分岐を要求: session=${session.id} turn=${turnId}`);
      // 分岐は数秒かかる。その間にタブを閉じられていると、破棄済みのwebviewへの
      // postMessageが投げる。閉じられていれば戻す相手も居ないので送らない
      const notifyFailure = (): void => {
        if (this.panels.get(session.id) !== panel) {
          return;
        }
        void panel.webview.postMessage({ type: 'forkFailed', turnId });
      };
      void this.onFork(session, turnId).then(
        (ok) => {
          if (!ok) {
            notifyFailure();
          }
        },
        (e: unknown) => {
          // 投げて終わった場合もボタンを戻す。戻さないと再試行できない（Issue #1156）
          this.log.error(`分岐に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
          notifyFailure();
        },
      );
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
 * 1ターンを描く。
 *
 * 分岐ボタンが渡すのは**このターン自身**のid（`thread/fork` の `beforeTurnId`。そのターンと
 * それ以降を除外する指定。Issue #1161）。除外すると何も残らないターンにはボタンを出さない
 * （`hasEarlierTurn`）。表示を`MAX_CONVERSATION_TURNS`で絞っている場合、表示上の最初のターンでも
 * その手前に非表示のターンが実在する（Issue #1325）ため、その場合はボタンを出す。
 */
function renderTurn(
  turn: ConversationTurn,
  displayNumber: number,
  hasEarlierTurn: boolean,
): string {
  const time = turn.timestamp === undefined ? '' : formatAbsoluteTime(turn.timestamp);
  const tools = summarizeTools(turn.toolNames);
  const agent = turn.agentMessages
    .map((m) => `<div class="bubble agent">${escapeHtml(m)}</div>`)
    .join('');
  const forkButton = !hasEarlierTurn
    ? ''
    : `<button type="button" data-turn="${escapeHtml(turn.turnId)}">ここから分岐</button>`;

  return `<article class="turn">
  <header>
    <span class="meta">#${displayNumber}${time === '' ? '' : ` ・ ${time}`}${tools === '' ? '' : ` ・ ${escapeHtml(tools)}`}</span>
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

function render(
  webview: vscode.Webview,
  title: string,
  turns: ConversationTurn[],
  omittedCount: number,
): string {
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
  ${omittedCount === 0 ? '' : `<p class="lead">古いやり取り${omittedCount}件は表示を省略しています（直近${MAX_CONVERSATION_TURNS}件のみ表示）。</p>`}
  ${turns.map((turn, i) => renderTurn(turn, omittedCount + i + 1, omittedCount > 0 || i > 0)).join('\n')}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-turn]');
    if (!button) return;
    button.disabled = true;
    button.textContent = '分岐しています…';
    vscode.postMessage({ type: 'fork', turnId: button.dataset.turn });
  });
  // 分岐が失敗したら押せる状態へ戻す（Issue #1156）。戻さないとこのタブを開き直すまで
  // 同じ指示から再試行できない
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'forkFailed' || typeof data.turnId !== 'string') return;
    for (const button of document.querySelectorAll('button[data-turn]')) {
      if (button.dataset.turn !== data.turnId) continue;
      button.disabled = false;
      button.textContent = 'ここから分岐';
    }
  });
</script>
</body>
</html>`;
}
