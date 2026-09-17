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

/**
 * このPCの全ウィンドウで拡張機能が管理中の会話を状態別に並べる専用View
 * （Issue #811、全ウィンドウ横断化はIssue #1244）。
 */
export class SessionKanbanViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.sessionKanban';
  private panel: vscode.WebviewPanel | undefined;
  /** 非表示の間に来た更新（Issue #1012）。表に戻った時点で1回だけ送り直す */
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPostAt = 0;

  constructor(
    private readonly read: SessionKanbanReader,
    /** 自ウィンドウのカードをクリックしたときにタブを開く。既に閉じていれば`false`。 */
    private readonly reveal: (provider: 'codex' | 'claude', threadId: string) => boolean,
    /**
     * 別ウィンドウのカードをクリックしたときに、要求ファイル経由で相手へ依頼する
     * （Issue #1244）。相手ウィンドウの中でタブが開いた状態にはなるが、ウィンドウ
     * そのものをOSレベルで前面へ出すAPIは無いため、それは保証しない（画面内に明示）。
     */
    private readonly requestOpen: (
      windowId: string,
      provider: 'codex' | 'claude',
      threadId: string,
    ) => void,
    private readonly currentWindowId: string,
    private readonly log: Logger,
  ) {}

  show(): void {
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        SessionKanbanViewManager.viewType,
        'セッション統括',
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
      this.log.info('セッション統括を開いた');
      return;
    }
    this.panel.reveal();
    this.schedulePost();
    this.log.info('セッション統括を表に出した');
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
      typeof message.threadId === 'string' &&
      typeof message.windowId === 'string'
    ) {
      if (message.windowId !== this.currentWindowId) {
        // 別ウィンドウのカード。要求ファイルを書くだけで、開けたかどうかはここでは分からない
        // （Issue #1244。相手ウィンドウが既に落ちていた場合も、共有ファイルのheartbeat失効で
        // 次の描画から一覧から消える）
        this.requestOpen(message.windowId, message.provider, message.threadId);
        return;
      }
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
    // まとめ待ちの間に非表示へ移ったときは、送った分が画面へ反映された保証が無い。
    // dirtyは表に出ているときだけ下ろし、非表示なら表に戻った時点で送り直す
    this.dirty = !this.panel.visible;
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
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body><main><header><div><p class="eyebrow">ALL WINDOWS</p><h1>セッション統括</h1><p class="description">このPCで開いている全VS Codeウィンドウの、この拡張機能が管理している会話を表示します。別ウィンドウのカードを開くと、相手ウィンドウの中でタブが開いた状態になりますが、ウィンドウ自体は前面に出ません。承認待ちへの対応も、開いたタブ側（相手ウィンドウ）で行ってください。</p><div class="filters"><input id="filterQuery" class="filter-input" type="search" autocomplete="off" placeholder="タイトル・フォルダ名で絞り込む" aria-label="タイトル・フォルダ名で絞り込む"><label class="filter-toggle"><input id="filterCurrent" type="checkbox">このウィンドウのみ</label><button id="filterClear" class="filter-clear" type="button" disabled>絞り込みを解除</button></div></div><div id="summary" class="summary" aria-live="polite"></div></header><section id="board" class="board" aria-label="セッションの状態"></section></main><div id="toast" class="toast" role="status" aria-live="polite"></div><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
main { padding: 24px; max-width: 1440px; margin: 0 auto; }
header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
h1 { font-size: 22px; margin: 2px 0 6px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0; } .description { color: var(--vscode-descriptionForeground); margin: 0; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.filter-input { flex: 1 1 260px; min-width: 200px; max-width: 420px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 13px; padding: 5px 8px; }
.filter-input:focus-visible, .filter-clear:focus-visible, .filter-toggle input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.filter-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 13px; white-space: nowrap; cursor: pointer; }
.filter-clear { appearance: none; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 13px; padding: 5px 10px; cursor: pointer; }
.filter-clear:disabled { opacity: .5; cursor: default; }
.summary { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .metric { border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 12px; padding: 6px 10px; white-space: nowrap; } .metric strong { font-size: 16px; margin-right: 4px; } .metric.alert { border-color: var(--vscode-charts-yellow); }
.board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 16px; align-items: start; } .column { background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 260px; overflow: hidden; } .column-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; } .icon { font-size: 16px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 10px; } .card { appearance: none; color: inherit; font: inherit; text-align: left; cursor: pointer; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; } .card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); } .card:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; } .card.approvalPending { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); } .card.backgroundRunning { border-left: 4px solid var(--vscode-charts-orange); } .card-title { display: block; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .meta { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; margin-top: 8px; } .provider { text-transform: uppercase; font-weight: 700; } .window-label.current { color: var(--vscode-charts-green); } .empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 14px; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translate(-50%, 12px); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color: var(--vscode-notifications-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border)); border-radius: 6px; padding: 8px 16px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (max-width: 1180px) { .board { grid-template-columns: repeat(2, minmax(220px, 1fr)); } }
@media (max-width: 820px) { header { display:block; } .summary { justify-content:flex-start; margin-top:16px; } .board { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const script = `
const vscode = acquireVsCodeApi(); const board = document.getElementById('board'); const summary = document.getElementById('summary'); const toast = document.getElementById('toast');
const queryInput = document.getElementById('filterQuery'); const currentToggle = document.getElementById('filterCurrent'); const clearButton = document.getElementById('filterClear');
const specs = [{ key:'approvalPending', label:'承認待ち', icon:'⚠', empty:'対応待ちの会話はありません' }, { key:'running', label:'実行中', icon:'↻', empty:'実行中の会話はありません' }, { key:'backgroundRunning', label:'バックグラウンド実行中', icon:'◐', empty:'バックグラウンド実行中の会話はありません' }, { key:'idle', label:'待機中', icon:'●', empty:'待機中の会話はありません' }];
function text(tag, value, cls) { const el=document.createElement(tag); el.textContent=value; if(cls) el.className=cls; return el; }
// 盤面を作り直すとフォーカス中のカードも消える。同じ会話のカードへ戻す（Issue #1012）
function focusedCard() { const el=document.activeElement; return el && el.dataset && el.dataset.threadId ? { windowId: el.dataset.windowId, provider: el.dataset.provider, threadId: el.dataset.threadId } : undefined; }
function restoreFocus(target) { if(!target) return; const next=board.querySelector('[data-window-id="' + CSS.escape(target.windowId) + '"][data-provider="' + CSS.escape(target.provider) + '"][data-thread-id="' + CSS.escape(target.threadId) + '"]'); if(next) next.focus(); }
// 生のwindowId（UUID）はユーザーには読めないため、初出順の連番に置き換えて表示する。
// 番号は絞り込み前の盤面全体から先に割り当てる。絞り込みで隠れたカードを飛ばして
// 採番すると、条件を変えるたびに同じウィンドウの番号が変わる（Issue #1250）
const windowAliases = new Map(); let windowAliasCounter = 0;
function registerAlias(card) { if(card.isCurrentWindow || windowAliases.has(card.windowId)) return; windowAliasCounter += 1; windowAliases.set(card.windowId, windowAliasCounter); }
function windowLabel(card) { if(card.isCurrentWindow) return 'このウィンドウ'; registerAlias(card); return 'ウィンドウ' + windowAliases.get(card.windowId); }
// 絞り込みはこのページの中だけで完結させる（Issue #1250）。拡張側は全件を送り続け、
// 描画時に絞る。往復させないので入力に即応し、全体の件数も画面に残せる
const emptyBoard = { cards: { approvalPending: [], running: [], backgroundRunning: [], idle: [] }, total: 0 };
let latestBoard = emptyBoard; let query = ''; let currentOnly = false;
function isFiltering() { return query !== '' || currentOnly; }
// 絶対パス（cwdFull）は検索対象にしない。画面へ出さない方針（Issue #1039）と揃える
function matches(card) { if(currentOnly && !card.isCurrentWindow) return false; if(query === '') return true; return ((card.title || '') + ' ' + (card.cwdLabel || '')).toLowerCase().includes(query); }
function countLabel(shown, total) { return isFiltering() ? shown + ' / ' + total : String(total); }
function applyFilter() { clearButton.disabled = !isFiltering(); render(latestBoard); }
let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
function render(data) { const focused = focusedCard(); board.replaceChildren(); summary.replaceChildren(); const counts=data.cards; for(const spec of specs) for(const card of counts[spec.key]) registerAlias(card); const shown={}; let shownTotal=0; for(const spec of specs) { shown[spec.key]=counts[spec.key].filter(matches); shownTotal+=shown[spec.key].length; } summary.append(text('span', countLabel(shownTotal, data.total) + ' セッション', 'metric')); for(const spec of specs) { const list=shown[spec.key]; const total=counts[spec.key].length; const metric=text('span', spec.label + ' ' + countLabel(list.length, total), 'metric' + (spec.key==='approvalPending' && list.length ? ' alert' : '')); summary.append(metric); const column=document.createElement('section'); column.className='column'; const head=document.createElement('div'); head.className='column-head'; head.append(text('span', spec.icon, 'icon'), text('span', spec.label), text('span', countLabel(list.length, total), 'count')); const cards=document.createElement('div'); cards.className='cards'; if(list.length===0) cards.append(text('p', total===0 ? spec.empty : '条件に一致する会話はありません', 'empty')); for(const card of list) { const button=document.createElement('button'); button.type='button'; button.className='card ' + spec.key; button.dataset.threadId=card.threadId; button.dataset.provider=card.provider; button.dataset.windowId=card.windowId; button.title=card.title || '名称未設定'; button.append(text('span', card.title || '名称未設定', 'card-title')); const meta=document.createElement('span'); meta.className='meta'; const cwdSpan=text('span', card.cwdLabel); cwdSpan.title=card.cwdFull; const label=windowLabel(card); const windowSpan=text('span', label, 'window-label' + (card.isCurrentWindow ? ' current' : '')); meta.append(text('span', card.provider, 'provider'), text('span', '•'), cwdSpan, text('span', '•'), windowSpan); button.append(meta); button.addEventListener('click', () => { if(!card.isCurrentWindow) showToast(label + ' へ開く要求を送信しました'); vscode.postMessage({type:'open', windowId:card.windowId, provider:card.provider, threadId:card.threadId}); }); cards.append(button); } column.append(head,cards); board.append(column); } restoreFocus(focused); }
// 入力欄はboard・summaryの外にあるため、盤面の再描画では作り直されない。
// 絞り込み条件も変数で持ち続けるので、250msごとの再描画をまたいで残る（Issue #1250）
queryInput.addEventListener('input', () => { query = queryInput.value.trim().toLowerCase(); applyFilter(); });
currentToggle.addEventListener('change', () => { currentOnly = currentToggle.checked; applyFilter(); });
clearButton.addEventListener('click', () => { queryInput.value=''; query=''; currentToggle.checked=false; currentOnly=false; applyFilter(); queryInput.focus(); });
window.addEventListener('message', event => { if(event.data.type==='board') { latestBoard = event.data.board; applyFilter(); } }); vscode.postMessage({type:'ready'});
`;
