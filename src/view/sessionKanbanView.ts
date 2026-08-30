import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import { chatCsp } from './chatCsp';
import type { SessionKanbanBoard } from './sessionKanbanModel';

export type SessionKanbanReader = () => SessionKanbanBoard;

/**
 * 盤面を送る間隔（Issue #1012）。
 *
 * 更新の元は`chatView.ts`の`flushState`で、`STATE_POST_INTERVAL_MS`（50ms）ごとに
 * 発火しうる。そのまま繋ぐとカンバンは1セッションあたり毎秒20回まで全カードを
 * 作り直す。ここでまとめる。デバウンスにすると更新が続く間ずっと描画されないため、
 * 「最初の1件はすぐ送り、以降は間隔ごとにまとめ、最後の1回は必ず送る」形にする
 * （`chatView.ts`の`postState`と同じ流儀）。
 */
const POST_INTERVAL_MS = 250;

/** 現在のワークスペースで拡張機能が管理中の会話を状態別に並べる専用View（Issue #811）。 */
export class SessionKanbanViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.sessionKanban';
  private panel: vscode.WebviewPanel | undefined;
  /** 非表示の間に来た更新（Issue #1012）。表に戻った時点で1回だけ送り直す */
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPostAt = 0;

  constructor(
    private readonly read: SessionKanbanReader,
    private readonly reveal: (provider: 'codex' | 'claude', threadId: string) => boolean,
    private readonly log: Logger,
  ) {}

  show(): void {
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        SessionKanbanViewManager.viewType,
        'セッションカンバン',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
      );
      this.panel.onDidDispose(() => {
        this.clearTimer();
        this.dirty = false;
        this.panel = undefined;
      });
      // 非表示の間の更新は溜めておき、表に戻った時点で送り直す（Issue #1012）。
      // `retainContextWhenHidden`でDOMは残るため、送り直さないと古い盤面が残る
      this.panel.onDidChangeViewState(() => {
        if (this.panel?.visible === true && this.dirty) {
          this.schedulePost();
        }
      });
      this.panel.webview.html = render(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
      // 初回の盤面はwebviewからの`ready`に対して送る。ここで送っても、webview側が
      // `message`のlistenerを登録する前なら届かない（VS Codeは順序を保証しない）
      this.log.info('セッションカンバンを開いた');
      return;
    }
    this.panel.reveal();
    this.schedulePost();
    this.log.info('セッションカンバンを表に出した');
  }

  refresh(): void {
    if (this.panel === undefined) {
      return;
    }
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    this.schedulePost();
  }

  dispose(): void {
    this.clearTimer();
    this.panel?.dispose();
  }

  /** 最初の1件はすぐ、以降は`POST_INTERVAL_MS`ごとにまとめ、最後の1回は必ず送る */
  private schedulePost(): void {
    if (this.postTimer !== undefined) {
      return;
    }
    const since = Date.now() - this.lastPostAt;
    if (since >= POST_INTERVAL_MS) {
      this.post();
      return;
    }
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.post();
    }, POST_INTERVAL_MS - since);
  }

  private clearTimer(): void {
    if (this.postTimer !== undefined) {
      clearTimeout(this.postTimer);
      this.postTimer = undefined;
    }
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    if (message.type === 'ready') {
      this.post();
      return;
    }
    if (
      message.type === 'open' &&
      (message.provider === 'codex' || message.provider === 'claude') &&
      typeof message.threadId === 'string'
    ) {
      if (!this.reveal(message.provider, message.threadId)) {
        vscode.window.showWarningMessage('この会話は既に閉じられています。');
        this.refresh();
      }
    }
  }

  private post(): void {
    if (this.panel === undefined) {
      return;
    }
    this.lastPostAt = Date.now();
    this.dirty = false;
    void this.panel.webview.postMessage({ type: 'board', board: this.read() });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function render(webview: vscode.Webview): string {
  // 他の画面（`chatShared.ts`・`progressView.ts`など）と同じく予測できない値にする
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body><main><header><div><p class="eyebrow">CURRENT WORKSPACE</p><h1>セッションカンバン</h1><p class="description">この拡張機能が開いて管理している会話だけを表示します。</p></div><div id="summary" class="summary" aria-live="polite"></div></header><section id="board" class="board" aria-label="セッションの状態"></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
main { padding: 24px; max-width: 1440px; margin: 0 auto; }
header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
h1 { font-size: 22px; margin: 2px 0 6px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0; } .description { color: var(--vscode-descriptionForeground); margin: 0; }
.summary { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .metric { border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 12px; padding: 6px 10px; white-space: nowrap; } .metric strong { font-size: 16px; margin-right: 4px; } .metric.alert { border-color: var(--vscode-charts-yellow); }
.board { display: grid; grid-template-columns: repeat(3, minmax(240px, 1fr)); gap: 16px; align-items: start; } .column { background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 260px; overflow: hidden; } .column-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; } .icon { font-size: 16px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 10px; } .card { appearance: none; color: inherit; font: inherit; text-align: left; cursor: pointer; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; } .card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); } .card:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; } .card.approvalPending { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); } .card-title { display: block; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .meta { color: var(--vscode-descriptionForeground); display: flex; gap: 6px; font-size: 12px; margin-top: 8px; } .provider { text-transform: uppercase; font-weight: 700; } .empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 14px; }
@media (max-width: 820px) { header { display:block; } .summary { justify-content:flex-start; margin-top:16px; } .board { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const script = `
const vscode = acquireVsCodeApi(); const board = document.getElementById('board'); const summary = document.getElementById('summary');
const specs = [{ key:'approvalPending', label:'承認待ち', icon:'⚠', empty:'対応待ちの会話はありません' }, { key:'running', label:'実行中', icon:'↻', empty:'実行中の会話はありません' }, { key:'idle', label:'待機中', icon:'●', empty:'待機中の会話はありません' }];
function text(tag, value, cls) { const el=document.createElement(tag); el.textContent=value; if(cls) el.className=cls; return el; }
// 盤面を作り直すとフォーカス中のカードも消える。同じ会話のカードへ戻す（Issue #1012）
function focusedCard() { const el=document.activeElement; return el && el.dataset && el.dataset.threadId ? { provider: el.dataset.provider, threadId: el.dataset.threadId } : undefined; }
function restoreFocus(target) { if(!target) return; const next=board.querySelector('[data-provider="' + CSS.escape(target.provider) + '"][data-thread-id="' + CSS.escape(target.threadId) + '"]'); if(next) next.focus(); }
function render(data) { const focused = focusedCard(); board.replaceChildren(); summary.replaceChildren(); const counts=data.cards; summary.append(text('span', data.total + ' セッション', 'metric')); for(const spec of specs) { const count=counts[spec.key].length; const metric=text('span', spec.label + ' ' + count, 'metric' + (spec.key==='approvalPending' && count ? ' alert' : '')); summary.append(metric); const column=document.createElement('section'); column.className='column'; const head=document.createElement('div'); head.className='column-head'; head.append(text('span', spec.icon, 'icon'), text('span', spec.label), text('span', String(count), 'count')); const cards=document.createElement('div'); cards.className='cards'; if(count===0) cards.append(text('p', spec.empty, 'empty')); for(const card of counts[spec.key]) { const button=document.createElement('button'); button.type='button'; button.className='card ' + spec.key; button.dataset.threadId=card.threadId; button.dataset.provider=card.provider; button.title=card.title + '\\n' + card.cwd; button.append(text('span', card.title || '名称未設定', 'card-title')); const meta=document.createElement('span'); meta.className='meta'; meta.append(text('span', card.provider, 'provider'), text('span', '•'), text('span', card.cwdLabel)); button.append(meta); button.addEventListener('click', () => vscode.postMessage({type:'open', provider:card.provider, threadId:card.threadId})); cards.append(button); } column.append(head,cards); board.append(column); } restoreFocus(focused); }
window.addEventListener('message', event => { if(event.data.type==='board') render(event.data.board); }); vscode.postMessage({type:'ready'});
`;
