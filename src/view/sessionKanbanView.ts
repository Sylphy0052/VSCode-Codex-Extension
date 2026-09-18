import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import { chatCsp } from './chatCsp';
import type { SessionControlAction, SessionControlResult } from './chatManagerBase';
import { isSharedApprovalDecision, isSharedHandoffDecision } from './sessionHub';
import type { SessionKanbanBoard } from './sessionKanbanModel';
import { skinBodyClass } from './skin';

export type SessionKanbanReader = () => SessionKanbanBoard;

/** 操作の相手。どのウィンドウのどのセッションか。 */
export interface SessionKanbanTarget {
  windowId: string;
  provider: 'codex' | 'claude';
  threadId: string;
}

/**
 * カードの操作を実行する（Issue #1258）。
 *
 * 自ウィンドウか別ウィンドウかの判定と、別ウィンドウ宛ての要求ファイルの送受信は
 * `extension.ts`側が持つ。この画面は「誰に何をするか」だけを渡し、結果を受け取って出す。
 */
export type SessionKanbanControl = (
  target: SessionKanbanTarget,
  action: SessionControlAction,
) => Promise<SessionControlResult>;

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
    /**
     * カードの操作（開く・中断・一時停止・再開・指示を送る）を実行する（Issue #1258）。
     *
     * 別ウィンドウ宛ての操作は要求ファイル経由で届く。相手ウィンドウの中でタブが開いた
     * 状態にはなるが、ウィンドウそのものをOSレベルで前面へ出すAPIは無いため、それは
     * 保証しない（画面内に明示）。
     */
    private readonly control: SessionKanbanControl,
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
    if (message.type === 'control') {
      this.handleControl(message);
    }
  }

  /**
   * カードの操作を実行し、結果を画面へ返す（Issue #1258）。
   *
   * `seq`は画面側が振る通し番号で、どのボタンの結果かを結び付けるためだけに使う。
   * 応答を待つ間に盤面が更新されても、結果は押した本人のカードへ出る。
   */
  private handleControl(message: Record<string, unknown>): void {
    const target = parseTarget(message);
    const action = parseAction(message);
    if (target === undefined || action === undefined || typeof message.seq !== 'number') {
      return;
    }
    const seq = message.seq;
    void this.control(target, action)
      .then((result) => {
        this.postControlResult(seq, result);
        // 中断・一時停止・再開は盤面の見た目に効く。次の定期更新を待たずに描き直す
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(`セッション統括: 操作に失敗しました（${action.kind}）: ${String(e)}`);
        this.postControlResult(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  private postControlResult(seq: number, result: SessionControlResult): void {
    void this.panel?.webview.postMessage({
      type: 'controlResult',
      seq,
      ok: result.ok,
      error: result.error,
      // 承認の中身（Issue #1259）・直近のやり取り（Issue #1260）。応答に載せるだけで、
      // 盤面（`board`）には混ぜない。盤面は250msごとに送り直すため、そこへ入れると
      // 会話の中身が流れ続けることになる
      approvals: result.approvals,
      turns: result.turns,
      capturedAt: result.capturedAt,
      // 脇道の質問の進み具合（Issue #1261）。回答は本流の会話に残さないため、
      // ここを通って統括ページのカードにだけ出る
      sideQuestion: result.sideQuestion,
      // 保留中の引き継ぎ確認（Issue #1280）。これも応答にだけ載せる
      handoff: result.handoff,
    });
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

function parseTarget(message: Record<string, unknown>): SessionKanbanTarget | undefined {
  if (
    typeof message.windowId !== 'string' ||
    typeof message.threadId !== 'string' ||
    (message.provider !== 'codex' && message.provider !== 'claude')
  ) {
    return undefined;
  }
  return {
    windowId: message.windowId,
    provider: message.provider,
    threadId: message.threadId,
  };
}

function parseAction(message: Record<string, unknown>): SessionControlAction | undefined {
  switch (message.action) {
    case 'open':
      return { kind: 'open' };
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'pauseLoop':
      return { kind: 'pauseLoop' };
    case 'resumeLoop':
      return { kind: 'resumeLoop' };
    case 'send':
      return typeof message.text === 'string' ? { kind: 'send', text: message.text } : undefined;
    case 'approvalDetail':
      return { kind: 'approvalDetail' };
    case 'recentTurns':
      return typeof message.limit === 'number'
        ? { kind: 'recentTurns', limit: message.limit }
        : undefined;
    case 'sideQuestion':
      return typeof message.text === 'string'
        ? { kind: 'sideQuestion', text: message.text }
        : undefined;
    case 'sideQuestionResult':
      return typeof message.sideQuestionId === 'string'
        ? { kind: 'sideQuestionResult', sideQuestionId: message.sideQuestionId }
        : undefined;
    case 'approvalDecision':
      // webviewは信頼境界の外側（`chatView.ts`と同じ扱い）。決定はホワイトリストで確かめる
      return typeof message.approvalRequestId === 'string' &&
        isSharedApprovalDecision(message.decision)
        ? {
            kind: 'approvalDecision',
            approvalRequestId: message.approvalRequestId,
            decision: message.decision,
          }
        : undefined;
    case 'handoffDetail':
      return { kind: 'handoffDetail' };
    case 'handoffDecision':
      // 承認の決定と同じ扱い。model / effortは受け取った側（`PendingHandoffChoice`）が
      // 公開した候補と突き合わせるので、ここでは形だけ確かめる
      return typeof message.handoffRequestId === 'string' &&
        isSharedHandoffDecision(message.decision)
        ? {
            kind: 'handoffDecision',
            handoffRequestId: message.handoffRequestId,
            decision: message.decision,
            model: typeof message.model === 'string' ? message.model : undefined,
            effort: typeof message.effort === 'string' ? message.effort : undefined,
          }
        : undefined;
    default:
      return undefined;
  }
}

function render(webview: vscode.Webview): string {
  // 他の画面（`chatShared.ts`・`progressView.ts`など）と同じく予測できない値にする
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });
  // 外装は会話画面と同じ設定（`agent.chat.skin`）で切り替える（Issue #1253）。
  // 統括画面だけ別の設定にすると、2画面を並べたときに片方だけ装飾が残る
  const skin = skinBodyClass(readChatSkinConfig());
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ALL WINDOWS</p><h1>セッション統括</h1><p class="description">このPCで開いている全VS Codeウィンドウの、この拡張機能が管理している会話を表示します。カードから、開く・中断・ループの一時停止と再開・指示の送信ができます。別ウィンドウのカードを開くと、相手ウィンドウの中でタブが開いた状態になりますが、ウィンドウ自体は前面に出ません。承認待ちのカードは「内容を見る」で中身を取り寄せ、表示したうえで承認・拒否できます。「やり取りを見る」で直近のやり取りを読めます（開いている間だけ取り寄せ、閉じると破棄します）。「脇道の質問」で本流の会話を汚さずに質問でき、回答はこのページのカードにだけ表示します。引き継ぎ確認待ちのカードは「引き継ぎ内容を見る」で引き継ぎ先のmodel / effortと判定理由を読み、引き継ぐ・設定を変えて引き継ぐ・再判定・中止を選べます。</p><div class="filters"><input id="filterQuery" class="filter-input" type="search" autocomplete="off" placeholder="タイトル・フォルダ名で絞り込む" aria-label="タイトル・フォルダ名で絞り込む"><details id="filterRepos" class="filter-repos"><summary id="filterReposSummary">リポジトリ: すべて</summary><div id="filterRepoList" class="filter-repo-list" role="group" aria-label="リポジトリで絞り込む"></div></details><label class="filter-toggle"><input id="filterCurrent" type="checkbox">このウィンドウのみ</label><button id="filterClear" class="filter-clear" type="button" disabled>絞り込みを解除</button></div></div><div id="summary" class="summary" aria-live="polite"></div></header><section id="board" class="board" aria-label="セッションの状態"></section></main><div id="toast" class="toast" role="status" aria-live="polite"></div><script nonce="${nonce}">${script}</script></body></html>`;
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
.filter-repos { position: relative; font-size: 13px; }
.filter-repos > summary { list-style: none; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 5px 10px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-repos > summary::-webkit-details-marker { display: none; }
.filter-repos > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.filter-repo-list { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 360px; max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
.filter-repo { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 3px; cursor: pointer; }
.filter-repo:hover { background: var(--vscode-list-hoverBackground); }
.filter-repo input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.filter-repo-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-repo-count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.filter-repo-empty { margin: 4px; color: var(--vscode-descriptionForeground); }
.summary { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .metric { border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 12px; padding: 6px 10px; white-space: nowrap; } .metric strong { font-size: 16px; margin-right: 4px; } .metric.alert { border-color: var(--vscode-charts-yellow); }
/* 4列は常に横一列のまま画面へ収める（Issue #1282）。列の最小幅を0にし、カード側の
   要素にも min-width: 0 を入れて、中身が列トラックを押し広げないようにする */
.board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; } .column { min-width: 0; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 260px; overflow: hidden; } .column-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; } .icon { font-size: 16px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 10px; min-width: 0; } .card { min-width: 0; overflow: hidden; color: inherit; font: inherit; text-align: left; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; } .card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
/* 見出しの部分だけが「開く」ボタン。カード全体をボタンにすると操作を中に置けない（Issue #1258） */
.card-open { appearance: none; display: block; width: 100%; min-width: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; background: none; border: 0; padding: 0; } .card-open:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; min-width: 0; }
/* 列幅が狭いときはボタンの文字を省略して収める。ボタン自体がカードをはみ出さない */
.card-action { appearance: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 8px; white-space: nowrap; cursor: pointer; } .card-action:disabled { opacity: .5; cursor: default; } .card-action:focus-visible, .send-input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* 指示を送る欄は展開したカードにだけ出る（Issue #1282）。列が狭いので1行占有にする */
.card-send { display: flex; gap: 6px; flex: 1 1 100%; min-width: 0; } .send-input { flex: 1 1 auto; min-width: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 6px; } .card.approvalPending { border-left: 4px solid var(--vscode-charts-yellow); } .card.handoffPending { border-left: 4px solid var(--vscode-charts-purple); } .card.running { border-left: 4px solid var(--vscode-charts-blue); } .card.backgroundRunning { border-left: 4px solid var(--vscode-charts-orange); } .card-title { display: block; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } /* 折りたたんだカードのメタ情報は1行に収め、あふれる分は省略する（Issue #1282）。
    フォルダ名はhover（title属性）で全体を読める。展開したら折り返して全部出す */
 .meta { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: nowrap; overflow: hidden; gap: 6px; font-size: 12px; margin-top: 6px; } .meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .meta > .sep { flex: 0 0 auto; } .card.is-open .meta { flex-wrap: wrap; } .provider { flex: 0 0 auto; text-transform: uppercase; font-weight: 700; } .window-label.current { color: var(--vscode-charts-green); } .empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 14px; }
/* 直近のやり取り（Issue #1260）。役割で左の線を分け、発言の切れ目を判るようにする */
.turn { border-left: 2px solid var(--vscode-panel-border); padding-left: 8px; display: grid; gap: 2px; }
.turn.user { border-left-color: var(--vscode-charts-blue); }
.turn-role { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .04em; margin: 0; }
.turn-text { font-size: 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
/* 承認の中身（Issue #1259）。展開しているカードにだけ出る */
.card-detail { border-top: 1px solid var(--vscode-panel-border); margin-top: 10px; padding-top: 10px; display: grid; gap: 10px; }
.detail-note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; }
.approval { display: grid; gap: 6px; }
.approval-title { font-size: 12px; font-weight: 650; margin: 0; }
/* コマンド全文は折り返して全部出す。横スクロールにすると末尾を見落とす */
.approval-detail { background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 0; max-height: 220px; overflow: auto; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-paths { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
.approval-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.handoff-picker { display: flex; flex-wrap: wrap; gap: 8px; }
.handoff-field { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.handoff-caption { color: var(--vscode-descriptionForeground); }
.handoff-select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 12px; padding: 2px 4px; max-width: 180px; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translate(-50%, 12px); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color: var(--vscode-notifications-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border)); border-radius: 6px; padding: 8px 16px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
/* 狭い画面でも列は折り返さない（Issue #1282）。横スクロールを出さず、カード側を
   折りたたんで収める方針にしたため、2列・1列へ組み替えるとかえって縦に伸びる */
@media (max-width: 820px) { header { display:block; } .summary { justify-content:flex-start; margin-top:16px; } main { padding: 16px; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

/*
 * ここから下はサイバー外装（Issue #1253、設定 agent.chat.skin = cyber、既定）。
 *
 * 会話画面（chatStyles.ts の同名の節）と同じ線引きで書く。
 *
 * - 規則はすべて body.skin-cyber の配下に置く。plain を選んだときに従来と1pxも変わらない
 *   ことを、この構造だけで担保する。ここより上は外装に関わらず効く地の見た目。
 * - 可読性: 文字色・文字サイズ・余白・カードの情報量は変えない。本文へ text-shadow を
 *   掛けない。発光は枠・バー・見出しといった装飾側にだけ載せる。
 * - 軽さ: filter / backdrop-filter は使わない。常時掛かる box-shadow はカードの1層まで
 *   （それ以上はホバーとフォーカスのときだけ）。無限アニメーションは承認待ちがある
 *   ときの走査線1本だけで、0件なら動くものが無い。
 *
 * 色の変数名と役割は会話画面と揃える（シアン=いま動いているもの、紫=補助、
 * マゼンタ=対応を待っているもの）。ネオンはテーマ変数から作れないため、外装を選んだ
 * ときだけ効く独自色としてここに閉じ込め、地の色はテーマ変数のままにする。
 */
body.skin-cyber {
  --agent-neon-1: #4fe3ff;
  --agent-neon-2: #b388ff;
  --agent-neon-3: #ff5c8a;
  --agent-neon-edge: color-mix(in srgb, var(--agent-neon-1) 28%, var(--vscode-panel-border));
  --agent-neon-glow: color-mix(in srgb, var(--agent-neon-1) 45%, transparent);
  --agent-grid-line: color-mix(in srgb, var(--agent-neon-1) 7%, transparent);
  --agent-grid-step: 48px;
  --agent-panel-bg: color-mix(in srgb, var(--agent-neon-1) 4%, var(--vscode-editorWidget-background));
  /* パネル右上の切り欠き。0px にすると角が戻る（高コントラストテーマで使う） */
  --agent-notch: 12px;
  --agent-head-font: var(--vscode-editor-font-family, var(--vscode-font-family));
  --agent-head-tracking: .06em;
  --agent-scan-opacity: .5;
  /* 待機中カードの左のバー。他の種別は地の border-left をネオンで塗り直す */
  --agent-card-accent: color-mix(in srgb, var(--agent-neon-1) 35%, transparent);
}
/* lightテーマでは彩度と発光を落とす。白地では明るいネオンが本文より目立つ */
body.skin-cyber.vscode-light { --agent-neon-1: #0f7f9c; --agent-neon-2: #6b3fd4; --agent-neon-3: #c2185b; --agent-grid-line: color-mix(in srgb, var(--agent-neon-1) 5%, transparent); --agent-neon-glow: color-mix(in srgb, var(--agent-neon-1) 25%, transparent); --agent-panel-bg: color-mix(in srgb, var(--agent-neon-1) 2%, var(--vscode-editorWidget-background)); --agent-scan-opacity: .35; }
/*
 * 高コントラストテーマでは装飾を無効化する。規則を1つずつ名指しで消すと後から足した
 * 装飾が漏れるため、装飾が参照している変数を無色・無寸法へ倒す。
 */
body.skin-cyber.vscode-high-contrast, body.skin-cyber.vscode-high-contrast-light { --agent-neon-1: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); --agent-neon-2: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); --agent-neon-3: var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder)); --agent-neon-edge: var(--vscode-panel-border); --agent-neon-glow: transparent; --agent-grid-line: transparent; --agent-panel-bg: var(--vscode-editorWidget-background); --agent-notch: 0px; --agent-head-font: var(--vscode-font-family); --agent-head-tracking: normal; --agent-card-accent: transparent; }
/* 背景の方眼。1枚の背景画像で出すので要素は増えない */
body.skin-cyber { background-image: repeating-linear-gradient(to right, var(--agent-grid-line) 0 1px, transparent 1px var(--agent-grid-step)), repeating-linear-gradient(to bottom, var(--agent-grid-line) 0 1px, transparent 1px var(--agent-grid-step)); }
/* 見出し。端末寄りの書体と字間にし、発光は見出しの文字だけに載せる */
body.skin-cyber .eyebrow { color: var(--agent-neon-1); font-family: var(--agent-head-font); letter-spacing: .18em; }
body.skin-cyber h1 { font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); text-shadow: 0 0 12px var(--agent-neon-glow); }
/* ヘッダーとボードの境目に1本線を引き、画面を2段に切って見せる */
body.skin-cyber header { border-bottom: 1px solid var(--agent-neon-edge); padding-bottom: 16px; }
/* 件数バッジ。承認待ちがある行だけマゼンタで、他は地の線に寄せる */
body.skin-cyber .metric { border-color: var(--agent-neon-edge); background: var(--agent-panel-bg); font-family: var(--agent-head-font); }
body.skin-cyber .metric strong { color: var(--agent-neon-1); }
body.skin-cyber .metric.alert { border-color: var(--agent-neon-3); color: var(--agent-neon-3); box-shadow: inset 0 0 16px -10px var(--agent-neon-3); }
/* 絞り込み。入力中はリングで囲う */
body.skin-cyber .filter-input, body.skin-cyber .filter-clear, body.skin-cyber .filter-repos > summary, body.skin-cyber .filter-repo-list { border-color: var(--agent-neon-edge); }
body.skin-cyber .filter-input:focus-visible, body.skin-cyber .filter-clear:focus-visible, body.skin-cyber .filter-toggle input:focus-visible, body.skin-cyber .filter-repos > summary:focus-visible { outline-color: var(--agent-neon-1); box-shadow: 0 0 12px -4px var(--agent-neon-glow); }
/*
 * 列のパネル。右上の角を落として、四角い箱ではなく切り出した区画に見せる。
 * clip-path は外側へ出る box-shadow を切り落とすため、発光は必ず inset で書く。
 */
body.skin-cyber .column { border-color: var(--agent-neon-edge); background: var(--agent-panel-bg); clip-path: polygon(0 0, calc(100% - var(--agent-notch)) 0, 100% var(--agent-notch), 100% 100%, 0 100%); }
body.skin-cyber .column-head { border-bottom-color: var(--agent-neon-edge); font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--agent-neon-1) 22%, transparent); }
body.skin-cyber .column-head .icon { color: var(--agent-neon-1); }
body.skin-cyber .count { color: var(--agent-neon-1); }
/*
 * 承認待ちの列の見出しをマゼンタにする。件数バッジの強調（Issue #1250）と同じく、
 * 実際に承認待ちがあるとき（body.has-approval）だけにする。0件でも注意の色が出て
 * いると、色が「対応が要る」の合図として働かなくなる。
 */
body.skin-cyber.has-approval .column.approvalPending .column-head { color: var(--agent-neon-3); }
body.skin-cyber.has-approval .column.approvalPending .column-head .icon, body.skin-cyber.has-approval .column.approvalPending .count { color: var(--agent-neon-3); }
/*
 * カード。種別ごとの左のバーは地の border-left（4px）をネオンで塗り直すだけにする
 * （inset の影を重ねると同じ位置に色違いのバーが2本並ぶ）。待機中だけは地にバーが
 * 無いので、そこにだけ inset で細いバーを足す。
 *
 * 常時掛ける影はこの1層までで、枠を起こして光らせるのはホバーとフォーカスのときにする
 * （カード数に比例して増える描画を避けるため）。
 */
body.skin-cyber .card { border-color: var(--agent-neon-edge); background: color-mix(in srgb, var(--agent-neon-1) 3%, var(--vscode-editor-background)); }
body.skin-cyber .card.approvalPending { border-left-color: var(--agent-neon-3); }
body.skin-cyber .card.handoffPending { border-left-color: var(--agent-neon-2); }
body.skin-cyber .card.running { border-left-color: var(--agent-neon-1); }
body.skin-cyber .card.backgroundRunning { border-left-color: var(--agent-neon-2); }
body.skin-cyber .card.idle { box-shadow: inset 2px 0 0 var(--agent-card-accent); }
body.skin-cyber .card:hover { border-color: color-mix(in srgb, var(--agent-neon-1) 55%, var(--vscode-panel-border)); box-shadow: inset 0 0 20px -10px var(--agent-neon-glow); }
body.skin-cyber .card.idle:hover { box-shadow: inset 2px 0 0 var(--agent-card-accent), inset 0 0 20px -10px var(--agent-neon-glow); }
/* フォーカスの輪郭はカードそのものではなく、中の操作要素に付く（Issue #1258） */
body.skin-cyber .card-open:focus-visible, body.skin-cyber .card-action:focus-visible, body.skin-cyber .send-input:focus-visible { outline-color: var(--agent-neon-1); }
body.skin-cyber .card-action, body.skin-cyber .send-input { border-color: var(--agent-neon-edge); }
/* 承認の中身。境目と枠だけネオンに寄せ、本文の見た目は地のままにする（Issue #1259） */
body.skin-cyber .card-detail { border-top-color: var(--agent-neon-edge); }
body.skin-cyber .approval-detail { border-color: var(--agent-neon-edge); background: color-mix(in srgb, var(--agent-neon-1) 5%, var(--vscode-editor-background)); }
body.skin-cyber .approval-title { color: var(--agent-neon-3); }
body.skin-cyber .turn { border-left-color: var(--agent-neon-edge); }
body.skin-cyber .turn.user { border-left-color: var(--agent-neon-1); }
body.skin-cyber .turn-role { color: var(--agent-neon-2); font-family: var(--agent-head-font); }
/* 種別と所属を示すラベルだけ端末寄りにする。タイトルと作業ディレクトリ名は地のまま */
body.skin-cyber .provider { color: var(--agent-neon-1); font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); }
body.skin-cyber .window-label.current { color: var(--agent-neon-1); }
body.skin-cyber .toast { border-color: var(--agent-neon-1); box-shadow: inset 0 0 20px -12px var(--agent-neon-glow); }
/*
 * 承認待ちが1件以上あるときだけ走査線を1本流す（会話画面が応答中に流すのと同じ役割）。
 * この画面で無限に回るアニメーションはこれだけで、0件になると要素ごと消える。
 * 動かすのは transform だけで、レイアウトと塗りは再計算させない。
 * prefers-reduced-motion のときは上の全称セレクタが animation ごと止める。
 */
body.skin-cyber.has-approval::before { content: ''; position: fixed; left: 0; right: 0; top: 0; height: 2px; pointer-events: none; z-index: 1; background-image: linear-gradient(to right, transparent, var(--agent-neon-3), transparent); opacity: var(--agent-scan-opacity); animation: agent-kanban-scanline 3.2s linear infinite; }
/* 高コントラストテーマでは走査線そのものを出さない（動きごと止める） */
body.skin-cyber.vscode-high-contrast.has-approval::before, body.skin-cyber.vscode-high-contrast-light.has-approval::before { content: none; }
@keyframes agent-kanban-scanline { from { transform: translateY(0); } to { transform: translateY(100vh); } }
`;

const script = `
const vscode = acquireVsCodeApi(); const board = document.getElementById('board'); const summary = document.getElementById('summary'); const toast = document.getElementById('toast');
const queryInput = document.getElementById('filterQuery'); const currentToggle = document.getElementById('filterCurrent'); const clearButton = document.getElementById('filterClear');
const repoDetails = document.getElementById('filterRepos'); const repoSummary = document.getElementById('filterReposSummary'); const repoList = document.getElementById('filterRepoList');
const specs = [{ key:'approvalPending', label:'承認待ち', icon:'⚠', empty:'対応待ちの会話はありません' }, { key:'handoffPending', label:'引き継ぎ確認待ち', icon:'⇄', empty:'引き継ぎ確認待ちの会話はありません' }, { key:'running', label:'実行中', icon:'↻', empty:'実行中の会話はありません' }, { key:'backgroundRunning', label:'バックグラウンド実行中', icon:'◐', empty:'バックグラウンド実行中の会話はありません' }, { key:'idle', label:'待機中', icon:'●', empty:'待機中の会話はありません' }];
function text(tag, value, cls) { const el=document.createElement(tag); el.textContent=value; if(cls) el.className=cls; return el; }
// カードの中の要素はどれも data-card-key と data-role を持つ。1枚のカードに操作の
// ボタンと入力欄が並ぶため、会話だけでなく「その中のどれ」までを鍵にする（Issue #1258）
function cardKey(card) { return card.windowId + '|' + card.provider + '|' + card.threadId; }
// 盤面を作り直すとフォーカス中の要素も消える。同じ場所へ戻す（Issue #1012）。
// 入力欄はカーソル位置まで戻す。250msごとの再描画で毎回末尾へ飛ぶと入力できない
function focusedSpot() { const el=document.activeElement; if(!el || !el.dataset || !el.dataset.cardKey) return undefined; return { key: el.dataset.cardKey, role: el.dataset.role, start: el.selectionStart, end: el.selectionEnd }; }
function restoreFocus(spot) { if(!spot) return; const next=board.querySelector('[data-card-key="' + CSS.escape(spot.key) + '"][data-role="' + CSS.escape(spot.role) + '"]'); if(!next) return; next.focus(); if(spot.start !== null && spot.start !== undefined && next.setSelectionRange) next.setSelectionRange(spot.start, spot.end); }
// 入力途中の指示。再描画をまたいで残す。送信したら消す
const drafts = new Map();
// 承認待ちカードの展開状態と、取り寄せた中身（Issue #1259）。
// 中身は展開している間だけ持ち、閉じたら捨てる。盤面（board）には混ぜないので、
// 250msごとの再描画で会話の中身が送られ続けることはない
const expanded = new Set(); const details = new Map(); const detailErrors = new Map();
// カードそのものの展開状態（Issue #1282）。既定は折りたたみで、展開したカードにだけ
// 指示の入力欄と、承認の中身・やり取り・脇道の質問のボタンを出す
const cardsExpanded = new Set();
// 直近のやり取り（Issue #1260）。承認の中身と同じく展開している間だけ持つ。
// 実行中のセッションは内容が進むため、展開中は TURNS_POLL_MS ごとに取り直す
// turnsInflight は「いま応答を待っている要求のseq」をカードごとに持つ。多重要求の抑止と、
// 古い応答の取り違えの判定を兼ねる（閉じて開き直すと前の要求のseqとは一致しなくなる）
const turnsExpanded = new Set(); const turns = new Map(); const turnsErrors = new Map(); const turnsInflight = new Map();
const TURNS_LIMIT = 6; const TURNS_POLL_MS = 3000;
// 脇道の質問（Issue #1261）。カードごとに直近の1件だけを持つ。回答は本流の会話に
// 残らないため、ここに出ているものが唯一の読み場所になる。
// btwRuns の値は { id, question, status, answer, error }。status が running の間は
// TURNS_POLL_MS ごとに進み具合を取りに行き、done / failed になったら止める
const btwExpanded = new Set(); const btwRuns = new Map(); const btwDrafts = new Map(); const btwInflight = new Map();
// 保留中の引き継ぎ確認（Issue #1280）。やり取りと同じく展開している間だけ持ち、展開中は
// 取り直す。元ウィンドウのモーダルや「再判定」で提案が入れ替わるため、一度取り寄せた
// 内容がそのまま古くなる
const handoffExpanded = new Set(); const handoffs = new Map(); const handoffErrors = new Map(); const handoffInflight = new Map();
// 選び直しで選んだmodel / effort。250msごとの再描画をまたいで残す
const handoffPicks = new Map();
// 送った操作と、その結果を結び付ける通し番号
let controlSeq = 0; const pendingControls = new Map();
const actionLabels = { open: '開く', interrupt: '中断', pauseLoop: '一時停止', resumeLoop: '再開', send: '指示の送信', approvalDetail: '承認の内容の取り寄せ', recentTurns: 'やり取りの取り寄せ', sideQuestion: '脇道の質問', sideQuestionResult: '脇道の回答の取り寄せ', handoffDetail: '引き継ぎの確認内容の取り寄せ' };
const decisionLabels = { accept: '承認', decline: '拒否' };
const handoffLabels = { proceed: '引き継ぎ', repick: '引き継ぎ先の変更', reclassify: '再判定', cancel: '引き継ぎの中止' };
function controlLabel(action, extra) { if(action === 'approvalDecision') return decisionLabels[extra.decision]; if(action === 'handoffDecision') return handoffLabels[extra.decision]; return actionLabels[action]; }
function sendControl(card, action, text, extra) { controlSeq += 1; const seq = controlSeq; pendingControls.set(seq, { action, card, label: controlLabel(action, extra), place: card.isCurrentWindow ? '' : windowLabel(card) + 'の', key: cardKey(card), text }); vscode.postMessage({ type:'control', seq, action, windowId:card.windowId, provider:card.provider, threadId:card.threadId, text, approvalRequestId: extra && extra.approvalRequestId, decision: extra && extra.decision, limit: extra && extra.limit, sideQuestionId: extra && extra.sideQuestionId, handoffRequestId: extra && extra.handoffRequestId, model: extra && extra.model, effort: extra && extra.effort }); return seq; }
// カードを折りたたむと、その中で開いていた欄もすべて閉じる（Issue #1282）。
// 閉じたカードから承認の中身・やり取りの取り寄せが飛び続けないようにする。
// 脇道の質問の回答（btwRuns）は受信側が預かっている分なので消さない（開き直せば読める）
function toggleCard(card) {
  const key = cardKey(card);
  if(cardsExpanded.has(key)) {
    cardsExpanded.delete(key);
    expanded.delete(key); details.delete(key); detailErrors.delete(key);
    turnsExpanded.delete(key); turns.delete(key); turnsErrors.delete(key); turnsInflight.delete(key);
    btwExpanded.delete(key);
    // 引き継ぎの確認内容も閉じる（Issue #1280）。選び直しの選択は開き直したら取り直す
    handoffExpanded.delete(key); handoffs.delete(key); handoffErrors.delete(key); handoffInflight.delete(key); handoffPicks.delete(key);
  } else {
    cardsExpanded.add(key);
  }
  applyFilter();
}
// 展開したときだけ中身を要求し、閉じたら捨てる（Issue #1259の受入基準）
function toggleDetail(card) { const key = cardKey(card); if(expanded.has(key)) { expanded.delete(key); details.delete(key); detailErrors.delete(key); } else { expanded.add(key); detailErrors.delete(key); sendControl(card, 'approvalDetail'); } applyFilter(); }
// 取り寄せた結果を仕舞う。閉じた後に届いた分は捨てる（閉じたのに中身が出るのを防ぐ）
function applyApprovalDetail(info, data) { if(!expanded.has(info.key)) return; if(data.ok) { details.set(info.key, data.approvals || []); detailErrors.delete(info.key); } else { details.delete(info.key); detailErrors.set(info.key, data.error || '理由は不明です'); } applyFilter(); }
// やり取りも展開したときだけ要求し、閉じたら要求も保持した中身も止める（Issue #1260）
function toggleTurns(card) { const key = cardKey(card); if(turnsExpanded.has(key)) { turnsExpanded.delete(key); turns.delete(key); turnsErrors.delete(key); turnsInflight.delete(key); } else { turnsExpanded.add(key); turnsErrors.delete(key); requestTurns(card); } applyFilter(); }
// 応答が返る前に次を送らない。3秒より応答が遅い相手へ要求を積み上げない
function requestTurns(card) { const key = cardKey(card); if(turnsInflight.has(key)) return; turnsInflight.set(key, sendControl(card, 'recentTurns', undefined, { limit: TURNS_LIMIT })); }
// いま待っている要求の応答だけを採る。閉じて開き直した後に前の応答が届いても、
// seqが一致しないので新しい内容を古い内容で上書きしない
function applyRecentTurns(info, data) { if(turnsInflight.get(info.key) !== data.seq) return; turnsInflight.delete(info.key); if(!turnsExpanded.has(info.key)) return; if(data.ok) { turns.set(info.key, { list: data.turns || [], capturedAt: data.capturedAt }); turnsErrors.delete(info.key); } else { turnsErrors.set(info.key, data.error || '理由は不明です'); } applyFilter(); }
// 引き継ぎの確認内容も展開したときだけ要求し、閉じたら要求も保持した中身も止める（Issue #1280）
function toggleHandoff(card) { const key = cardKey(card); if(handoffExpanded.has(key)) { handoffExpanded.delete(key); handoffs.delete(key); handoffErrors.delete(key); handoffInflight.delete(key); handoffPicks.delete(key); } else { handoffExpanded.add(key); handoffErrors.delete(key); requestHandoff(card); } applyFilter(); }
function requestHandoff(card) { const key = cardKey(card); if(handoffInflight.has(key)) return; handoffInflight.set(key, sendControl(card, 'handoffDetail')); }
// やり取りと同じく、いま待っている要求の応答だけを採る。提案が入れ替わったら
// （requestIdが変わったら）選び直しの選択も捨てる。見ていない候補のまま押させない
function applyHandoffDetail(info, data) { if(handoffInflight.get(info.key) !== data.seq) return; handoffInflight.delete(info.key); if(!handoffExpanded.has(info.key)) return; if(data.ok && data.handoff) { const previous = handoffs.get(info.key); if(previous === undefined || previous.requestId !== data.handoff.requestId) handoffPicks.delete(info.key); handoffs.set(info.key, data.handoff); handoffErrors.delete(info.key); } else { handoffs.delete(info.key); handoffErrors.set(info.key, data.error || '理由は不明です'); } applyFilter(); }
// 脇道の質問の入力欄を開く・閉じる（Issue #1261）。
// 回答待ちの間に閉じても、回答そのものは受信側が預かっているので消さない（開き直せば読める）
function toggleSideQuestion(card) { const key = cardKey(card); if(btwExpanded.has(key)) btwExpanded.delete(key); else btwExpanded.add(key); applyFilter(); }
// 質問を投げる。回答は待たず、受け付けられたら running のカードとして描き直す
// submitSeq は「この欄でいま生きている質問はどれか」の印。続けて投げたとき、
// 前の質問の応答で新しい質問を上書きしないために持つ（結果の取得側は btwInflight で見る）
function sendSideQuestion(card, question) { const key = cardKey(card); btwInflight.delete(key); const seq = sendControl(card, 'sideQuestion', question); btwRuns.set(key, { id: undefined, question, status: 'running', answer: undefined, error: undefined, submitSeq: seq }); applyFilter(); }
function applySideQuestion(info, data) {
  const key = info.key;
  if(info.action === 'sideQuestionResult') { if(btwInflight.get(key) !== data.seq) return; btwInflight.delete(key); }
  const run = btwRuns.get(key);
  if(run === undefined) return;
  // 投げ直した後に前の質問の応答が届くことがある。いま生きている質問の分だけ採る
  if(info.action === 'sideQuestion' && run.submitSeq !== data.seq) return;
  if(!data.ok || !data.sideQuestion) { btwRuns.set(key, Object.assign({}, run, { status: 'failed', error: (data.error || '理由は不明です') })); applyFilter(); return; }
  const next = data.sideQuestion;
  if(info.action === 'sideQuestionResult' && run.id !== next.id) return;
  btwRuns.set(key, { id: next.id, question: next.question, status: next.status, answer: next.answer, error: next.error, submitSeq: run.submitSeq });
  applyFilter();
}
// 回答待ちの質問だけ取りに行く。応答が返る前に次は送らない（recentTurnsと同じ流儀）
function requestSideQuestionResult(card) { const key = cardKey(card); const run = btwRuns.get(key); if(!run || run.status !== 'running' || run.id === undefined) return; if(btwInflight.has(key)) return; btwInflight.set(key, sendControl(card, 'sideQuestionResult', undefined, { sideQuestionId: run.id })); }
// 展開中のカードだけを定期的に取り直す。盤面（250ms）とは別の間隔で回す
// タブが見えていない間は取り直さない（相手ウィンドウへ無駄な要求を送らない）。
// 脇道の回答は展開していなくても取りに行く。カードの待機表示を進めるのに要る（Issue #1261）
setInterval(() => { if(document.hidden) return; if(turnsExpanded.size === 0 && btwRuns.size === 0 && handoffExpanded.size === 0) return; for(const spec of specs) for(const card of latestBoard.cards[spec.key]) { const key = cardKey(card); if(turnsExpanded.has(key)) requestTurns(card); if(handoffExpanded.has(key)) requestHandoff(card); requestSideQuestionResult(card); } }, TURNS_POLL_MS);
// 生のwindowId（UUID）はユーザーには読めないため、初出順の連番に置き換えて表示する。
// 番号は絞り込み前の盤面全体から先に割り当てる。絞り込みで隠れたカードを飛ばして
// 採番すると、条件を変えるたびに同じウィンドウの番号が変わる（Issue #1250）
const windowAliases = new Map(); let windowAliasCounter = 0;
function registerAlias(card) { if(card.isCurrentWindow || windowAliases.has(card.windowId)) return; windowAliasCounter += 1; windowAliases.set(card.windowId, windowAliasCounter); }
function windowLabel(card) { if(card.isCurrentWindow) return 'このウィンドウ'; registerAlias(card); return 'ウィンドウ' + windowAliases.get(card.windowId); }
// 絞り込みはこのページの中だけで完結させる（Issue #1250）。拡張側は全件を送り続け、
// 描画時に絞る。往復させないので入力に即応し、全体の件数も画面に残せる
let latestBoard = { cards: { approvalPending: [], handoffPending: [], running: [], backgroundRunning: [], idle: [] }, total: 0 };
let query = ''; let currentOnly = false;
// 選んだリポジトリ（Issue #1276）。同名の別フォルダを区別するため、鍵は絶対パス（cwdFull）にする。
// 表示はフォルダ名だけで、絶対パスは画面へ出さない（Issue #1039）。
// 盤面から一時的に消えたリポジトリの選択も残す。消えるたびにチェックが外れると、
// 実行が終わった会話が居なくなっただけで絞り込みが崩れる
const selectedRepos = new Set();
function isFiltering() { return query !== '' || currentOnly || selectedRepos.size > 0; }
// 絶対パス（cwdFull）は検索対象にしない。画面へ出さない方針（Issue #1039）と揃える
function matches(card) { if(currentOnly && !card.isCurrentWindow) return false; if(selectedRepos.size > 0 && !selectedRepos.has(repoKey(card))) return false; if(query === '') return true; return ((card.title || '') + ' ' + (card.cwdLabel || '')).toLowerCase().includes(query); }
function repoKey(card) { return card.cwdFull || '(不明)'; }
// 選択肢は絞り込み前の盤面全体から作る。絞り込み後の結果から作ると、選んだ瞬間に
// 他のリポジトリが選択肢から消えて選び直せなくなる（ウィンドウ番号の採番と同じ方針、Issue #1250）
function collectRepos(data) {
  const byKey = new Map();
  for(const spec of specs) for(const card of data.cards[spec.key]) {
    const key = repoKey(card); const entry = byKey.get(key);
    if(entry === undefined) byKey.set(key, { key, label: card.cwdLabel || '(不明)', count: 1 }); else entry.count += 1;
  }
  // 同じフォルダ名が別の場所に同時に居るときだけ、親を1階層だけ足して見分けられるようにする。
  // それでも同じになる場合は同じ表示のまま別項目として並べる（絶対パスは出さない方針を優先）
  const byLabel = new Map();
  for(const entry of byKey.values()) { const group = byLabel.get(entry.label); if(group === undefined) byLabel.set(entry.label, [entry]); else group.push(entry); }
  for(const group of byLabel.values()) { if(group.length < 2) continue; for(const entry of group) entry.label = withParent(entry.key, entry.label); }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}
function withParent(key, label) { const parts = key.split('/'); return parts.length >= 2 && parts[parts.length - 2] !== '' ? parts[parts.length - 2] + '/' + label : label; }
// 盤面は250msごとに届く。並んでいる項目が変わっていなければDOMは作り直さない。
// 作り直すと開いている一覧の中でフォーカスやスクロール位置が毎回失われる。
// 件数は会話が動くたびに変わるため、この判定には入れずテキストだけ書き換える
let repoSignature = '';
function renderRepoOptions(list) {
  const signature = list.map(entry => entry.key + '>' + entry.label).join('|');
  if(signature !== repoSignature) {
    repoSignature = signature;
    repoList.replaceChildren();
    if(list.length === 0) repoList.append(text('p', '表示できるリポジトリがありません', 'filter-repo-empty'));
    for(const entry of list) {
      const row = document.createElement('label'); row.className = 'filter-repo'; row.title = entry.label;
      const box = document.createElement('input'); box.type = 'checkbox'; box.value = entry.key; box.checked = selectedRepos.has(entry.key);
      box.addEventListener('change', () => { if(box.checked) selectedRepos.add(entry.key); else selectedRepos.delete(entry.key); applyFilter(); });
      const count = text('span', String(entry.count), 'filter-repo-count'); count.dataset.repoKey = entry.key;
      row.append(box, text('span', entry.label, 'filter-repo-label'), count);
      repoList.append(row);
    }
  } else {
    // 作り直さないときも、件数と、絞り込みの解除でチェックが外れたことは反映する
    for(const box of repoList.querySelectorAll('input[type=checkbox]')) box.checked = selectedRepos.has(box.value);
    for(const entry of list) { const count = repoList.querySelector('[data-repo-key="' + CSS.escape(entry.key) + '"]'); if(count) count.textContent = String(entry.count); }
  }
  repoSummary.textContent = repoSummaryLabel(list);
}
function repoSummaryLabel(list) {
  if(selectedRepos.size === 0) return 'リポジトリ: すべて';
  if(selectedRepos.size === 1) { const only = [...selectedRepos][0]; const hit = list.find(entry => entry.key === only); return 'リポジトリ: ' + (hit === undefined ? '1件' : hit.label); }
  return 'リポジトリ: ' + selectedRepos.size + '件';
}
function countLabel(shown, total) { return isFiltering() ? shown + ' / ' + total : String(total); }
function applyFilter() { clearButton.disabled = !isFiltering(); render(latestBoard); }
let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
// 承認待ちの列の見出しと走査線を切り替える（Issue #1253）。判定は上の注意の色と同じく
// 絞り込み前の全体の件数で行う
function setApprovalFlag(has) { document.body.classList.toggle('has-approval', has); }
// 承認待ちの強調は絞り込み後ではなく全体の件数で決める。絞り込みで隠れただけの
// 承認待ちがあるのに注意の色が消えると、対応漏れを誘う（Issue #1250）
// 承認が解決したカードは承認待ちの列から出ていき、「内容を閉じる」を押す手段が無くなる。
// 列に残っていないキーはここで捨てる（開きっぱなしの統括ページに溜め続けないため）
function dropStaleDetails(counts) { const alive=new Set(counts.approvalPending.map(cardKey)); for(const key of [...expanded]) { if(!alive.has(key)) { expanded.delete(key); details.delete(key); detailErrors.delete(key); } } const live=new Set(); for(const spec of specs) for(const card of counts[spec.key]) live.add(cardKey(card)); for(const key of [...turnsExpanded]) { if(!live.has(key)) { turnsExpanded.delete(key); turns.delete(key); turnsErrors.delete(key); turnsInflight.delete(key); } } for(const key of [...btwRuns.keys()]) { if(!live.has(key)) { btwRuns.delete(key); btwInflight.delete(key); btwDrafts.delete(key); btwExpanded.delete(key); } } const handoffAlive=new Set(counts.handoffPending.map(cardKey)); for(const key of [...handoffExpanded]) { if(!handoffAlive.has(key)) { handoffExpanded.delete(key); handoffs.delete(key); handoffErrors.delete(key); handoffInflight.delete(key); handoffPicks.delete(key); } } for(const key of [...cardsExpanded]) { if(!live.has(key)) cardsExpanded.delete(key); } }
function render(data) { const focused = focusedSpot(); board.replaceChildren(); summary.replaceChildren(); const counts=data.cards; dropStaleDetails(counts); for(const spec of specs) for(const card of counts[spec.key]) registerAlias(card); renderRepoOptions(collectRepos(data)); const shown={}; let shownTotal=0; for(const spec of specs) { shown[spec.key]=counts[spec.key].filter(matches); shownTotal+=shown[spec.key].length; } summary.append(text('span', countLabel(shownTotal, data.total) + ' セッション', 'metric')); for(const spec of specs) { const list=shown[spec.key]; const total=counts[spec.key].length; const metric=text('span', spec.label + ' ' + countLabel(list.length, total), 'metric' + (spec.key==='approvalPending' && total ? ' alert' : '')); summary.append(metric); const column=document.createElement('section'); column.className='column ' + spec.key; const head=document.createElement('div'); head.className='column-head'; head.append(text('span', spec.icon, 'icon'), text('span', spec.label), text('span', countLabel(list.length, total), 'count')); const cards=document.createElement('div'); cards.className='cards'; if(list.length===0) cards.append(text('p', total===0 ? spec.empty : '条件に一致する会話はありません', 'empty')); for(const card of list) cards.append(buildCard(card, spec.key)); column.append(head,cards); board.append(column); } setApprovalFlag(counts.approvalPending.length > 0); restoreFocus(focused); }
function actionButton(key, role, label, onClick) { const b=document.createElement('button'); b.type='button'; b.className='card-action'; b.dataset.cardKey=key; b.dataset.role=role; b.textContent=label; b.addEventListener('click', onClick); return b; }
// カード1枚。見出しの部分が「開く」ボタンで、その下に操作が並ぶ（Issue #1258）。
// カード全体をボタンにすると中に操作ボタンを置けない（入れ子のボタンは作れない）
function buildCard(card, column) {
  const key = cardKey(card);
  // 折りたたんだカードは「開く」「中断」「展開」だけを出す（Issue #1282）。
  // 列幅に収めるため、指示の入力欄とそれ以外の操作は展開したときにだけ出す
  const isOpen = cardsExpanded.has(key);
  const item = document.createElement('div'); item.className = 'card ' + column + (isOpen ? ' is-open' : '');
  const open = document.createElement('button'); open.type='button'; open.className='card-open'; open.dataset.cardKey=key; open.dataset.role='open'; open.title=card.title || '名称未設定';
  open.append(text('span', card.title || '名称未設定', 'card-title'));
  const meta=document.createElement('span'); meta.className='meta'; const cwdSpan=text('span', card.cwdLabel); cwdSpan.title=card.cwdFull; const windowSpan=text('span', windowLabel(card), 'window-label' + (card.isCurrentWindow ? ' current' : '')); meta.append(text('span', card.provider, 'provider'), text('span', '•', 'sep'), cwdSpan, text('span', '•', 'sep'), windowSpan); open.append(meta);
  open.addEventListener('click', () => sendControl(card, 'open'));
  item.append(open);
  const actions=document.createElement('div'); actions.className='card-actions';
  // 待機中のカードには止めるものが無い。承認待ちは「承認せずに止める」ことがあるので押せる
  const stop=actionButton(key, 'interrupt', '中断', () => sendControl(card, 'interrupt')); stop.disabled = column === 'idle'; actions.append(stop);
  // 回答待ちの脇道の質問は、折りたたんでいても展開ボタンの側で判るようにする
  const pendingRun = btwRuns.get(key);
  const hasPendingSideQuestion = pendingRun !== undefined && pendingRun.status === 'running';
  actions.append(actionButton(key, 'expand', isOpen ? '折りたたむ' : (hasPendingSideQuestion ? '展開（回答待ち）' : '展開'), () => toggleCard(card)));
  item.append(actions);
  if(!isOpen) return item;
  // ループのボタンは走っているときだけ出す。走っていないカードに並んでいると、
  // 押せる操作があるように見える
  const loop=card.loop;
  if(loop && loop.running) { const act = loop.paused ? 'resumeLoop' : 'pauseLoop'; actions.append(actionButton(key, 'loop', actionLabels[act], () => sendControl(card, act))); }
  const form=document.createElement('div'); form.className='card-send';
  const input=document.createElement('input'); input.type='text'; input.className='send-input'; input.placeholder='指示を送る'; input.setAttribute('aria-label', 'このセッションへ指示を送る'); input.dataset.cardKey=key; input.dataset.role='input'; input.value=drafts.get(key) || '';
  // 送った時点で入力欄は空にする。届かなかったときだけ書いた内容を戻す（showControlResult）
  const submit=() => { const value=input.value; if(value.trim()==='') return; sendControl(card, 'send', value); drafts.delete(key); input.value=''; };
  input.addEventListener('input', () => drafts.set(key, input.value));
  input.addEventListener('keydown', e => { if(e.key === 'Enter') { e.preventDefault(); submit(); } });
  form.append(input, actionButton(key, 'send', '送信', submit));
  actions.append(form);
  // 承認待ちのカードだけ、中身を取り寄せて広げられる（Issue #1259）
  if(column === 'approvalPending') { const open = expanded.has(key); actions.append(actionButton(key, 'detail', open ? '内容を閉じる' : '内容を見る', () => toggleDetail(card))); if(open) item.append(buildDetail(card, key)); }
  // 引き継ぎ確認待ちのカードだけ、確認の中身を取り寄せて広げられる（Issue #1280）
  if(column === 'handoffPending') { const handoffOpen = handoffExpanded.has(key); actions.append(actionButton(key, 'handoff', handoffOpen ? '引き継ぎ内容を閉じる' : '引き継ぎ内容を見る', () => toggleHandoff(card))); if(handoffOpen) item.append(buildHandoff(card, key)); }
  // 直近のやり取りはどの列のカードでも読める（Issue #1260）
  const turnsOpen = turnsExpanded.has(key);
  actions.append(actionButton(key, 'turns', turnsOpen ? 'やり取りを閉じる' : 'やり取りを見る', () => toggleTurns(card)));
  if(turnsOpen) item.append(buildTurns(key));
  // 脇道の質問（Issue #1261）。回答待ちの間は、欄を閉じていてもボタンで判るようにする
  const btwOpen = btwExpanded.has(key); const run = btwRuns.get(key);
  const waiting = run !== undefined && run.status === 'running';
  actions.append(actionButton(key, 'btw', btwOpen ? '脇道の質問を閉じる' : (waiting ? '脇道の質問（回答待ち）' : '脇道の質問'), () => toggleSideQuestion(card)));
  if(btwOpen) item.append(buildSideQuestion(card, key));
  return item;
}
// 脇道の質問の入力欄と、投げた質問の進み具合（Issue #1261）。
// 回答は本流の会話に残らないため、この欄が唯一の読み場所になる
function buildSideQuestion(card, key) {
  const box = document.createElement('div'); box.className = 'card-detail';
  const form = document.createElement('div'); form.className = 'card-send';
  const input = document.createElement('input'); input.type='text'; input.className='send-input'; input.placeholder='本流を汚さずに聞く（例: いま何をしていますか）'; input.setAttribute('aria-label', 'このセッションへ脇道の質問を送る'); input.dataset.cardKey=key; input.dataset.role='btwInput'; input.value=btwDrafts.get(key) || '';
  const run = btwRuns.get(key);
  // 回答待ちの間は送れない。受信側も同じ会話への重ね投げを断るので、押せるままにすると
  // 「押したのに失敗した」だけになる
  const waiting = run !== undefined && run.status === 'running';
  const submit=() => { if(waiting) return; const value=input.value; if(value.trim()==='') return; sendSideQuestion(card, value.trim()); btwDrafts.delete(key); input.value=''; };
  input.disabled = waiting;
  input.addEventListener('input', () => btwDrafts.set(key, input.value));
  input.addEventListener('keydown', e => { if(e.key === 'Enter') { e.preventDefault(); submit(); } });
  const submitButton = actionButton(key, 'btwSend', '質問', submit); submitButton.disabled = waiting;
  form.append(input, submitButton);
  box.append(form);
  if(run === undefined) { box.append(text('p', '質問と回答はこのカードにだけ出ます（会話には残りません）', 'detail-note')); return box; }
  const block = document.createElement('div'); block.className = 'turn user';
  block.append(text('p', '脇道の質問', 'turn-role'));
  // 相手プロセスが書いた文字列はtextContentで入れる（HTMLとして解釈させない）
  block.append(text('p', run.question, 'turn-text'));
  box.append(block);
  if(run.status === 'running') { box.append(text('p', '回答を待っています…（時間がかかります）', 'detail-note')); return box; }
  if(run.status === 'failed') { box.append(text('p', '回答を受け取れませんでした: ' + (run.error || '理由は不明です'), 'detail-note')); return box; }
  const answer = document.createElement('div'); answer.className = 'turn';
  answer.append(text('p', '回答', 'turn-role'));
  answer.append(text('p', run.answer || '（回答が空でした）', 'turn-text'));
  box.append(answer);
  return box;
}
// 取り寄せた直近のやり取り。長い本文は切り詰めて送られてくるので、全文はタブ側で読む
function buildTurns(key) {
  const box = document.createElement('div'); box.className = 'card-detail';
  const error = turnsErrors.get(key); const snapshot = turns.get(key);
  if(error !== undefined) { box.append(text('p', 'やり取りを取り寄せられませんでした: ' + error, 'detail-note')); return box; }
  if(snapshot === undefined) { box.append(text('p', 'やり取りを取り寄せています…', 'detail-note')); return box; }
  if(snapshot.list.length === 0) { box.append(text('p', 'まだやり取りがありません', 'detail-note')); return box; }
  for(const turn of snapshot.list) {
    const block = document.createElement('div'); block.className = 'turn ' + turn.role;
    block.append(text('p', turn.role === 'user' ? 'あなた' : 'エージェント', 'turn-role'));
    // 相手プロセスが書いた文字列はtextContentで入れる（HTMLとして解釈させない）
    block.append(text('p', turn.text + (turn.truncated ? '…' : ''), 'turn-text'));
    if(turn.truncated) block.append(text('p', '全文はカードを開いたタブで読めます', 'detail-note'));
    box.append(block);
  }
  if(snapshot.capturedAt) box.append(text('p', capturedLabel(snapshot.capturedAt), 'detail-note'));
  return box;
}
// 1件ずつの時刻は会話の状態が持っていないため、いつ時点の内容かだけを出す
function capturedLabel(at) { const seconds = Math.max(0, Math.round((Date.now() - at) / 1000)); return seconds < 5 ? 'いま時点の内容' : seconds + '秒前の内容'; }
function labelOf(value) { return value === '' ? '既定' : value; }
// 選び直しの現在値。まだ触っていなければ提案された値をそのまま出す
function currentPick(key, detail) { const pick = handoffPicks.get(key); return pick === undefined ? { model: detail.model, effort: detail.effort } : pick; }
function labelledSelect(caption, select) { const wrap = document.createElement('label'); wrap.className = 'handoff-field'; wrap.append(text('span', caption, 'handoff-caption'), select); return wrap; }
// 別ウィンドウのセッションにはQuickPickを出せない（VS Codeは操作した本人のウィンドウに
// しか出せない）ため、選び直しはこの画面の中で選ぶ（Issue #1280の確認点3）
function buildHandoffPicker(card, key, detail) {
  const wrap = document.createElement('div'); wrap.className = 'handoff-picker';
  const pick = currentPick(key, detail);
  const options = detail.models || [];
  const modelSelect = document.createElement('select'); modelSelect.className = 'handoff-select'; modelSelect.dataset.cardKey = key; modelSelect.dataset.role = 'handoffModel'; modelSelect.setAttribute('aria-label', '引き継ぎ先のモデル');
  for(const option of options) { const item = document.createElement('option'); item.value = option.slug; item.textContent = option.label; modelSelect.append(item); }
  // 提案されたモデルが候補に無い（版が違う等）ときは、選べる先頭へ寄せる
  modelSelect.value = pick.model;
  const model = modelSelect.value;
  const chosen = options.find(option => option.slug === model);
  const effortSelect = document.createElement('select'); effortSelect.className = 'handoff-select'; effortSelect.dataset.cardKey = key; effortSelect.dataset.role = 'handoffEffort'; effortSelect.setAttribute('aria-label', '引き継ぎ先のeffort');
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = '既定'; effortSelect.append(defaultOption);
  const efforts = chosen === undefined ? [] : chosen.efforts;
  for(const effort of efforts) { const item = document.createElement('option'); item.value = effort; item.textContent = effort; effortSelect.append(item); }
  effortSelect.value = model === pick.model ? pick.effort : '';
  // 実際に選ばれている値を持ち直す。候補に無い値へ寄せた分をここで揃える
  handoffPicks.set(key, { model, effort: effortSelect.value });
  modelSelect.addEventListener('change', () => { handoffPicks.set(key, { model: modelSelect.value, effort: '' }); applyFilter(); });
  effortSelect.addEventListener('change', () => { handoffPicks.set(key, { model: modelSelect.value, effort: effortSelect.value }); applyFilter(); });
  wrap.append(labelledSelect('Model', modelSelect), labelledSelect('Effort', effortSelect));
  return wrap;
}
function decideHandoff(card, key, detail, decision) {
  const extra = { handoffRequestId: detail.requestId, decision };
  if(decision === 'repick') { const pick = currentPick(key, detail); extra.model = pick.model; extra.effort = pick.effort; }
  sendControl(card, 'handoffDecision', undefined, extra);
}
// 取り寄せた引き継ぎ確認の中身（Issue #1280）。承認と同じく、表示していない状態では押せない
function buildHandoff(card, key) {
  const box = document.createElement('div'); box.className = 'card-detail';
  const error = handoffErrors.get(key); const detail = handoffs.get(key);
  if(error !== undefined) { box.append(text('p', '引き継ぎの確認内容を取り寄せられませんでした: ' + error, 'detail-note')); return box; }
  if(detail === undefined) { box.append(text('p', '引き継ぎの確認内容を取り寄せています…', 'detail-note')); return box; }
  const block = document.createElement('div'); block.className = 'approval';
  block.append(text('p', '引き継ぎ先: Model ' + labelOf(detail.model) + ' / Effort ' + labelOf(detail.effort), 'approval-title'));
  // 相手プロセスが書いた文字列はtextContentで入れる（HTMLとして解釈させない）
  if(detail.trigger) block.append(text('p', '契機: ' + detail.trigger, 'detail-note'));
  if(detail.reasons && detail.reasons.length) { const reasons = document.createElement('ul'); reasons.className = 'approval-paths'; for(const reason of detail.reasons) reasons.append(text('li', reason)); block.append(reasons); }
  block.append(buildHandoffPicker(card, key, detail));
  const row = document.createElement('div'); row.className = 'approval-actions';
  row.append(actionButton(key, 'handoff:proceed', 'この設定で引き継ぐ', () => decideHandoff(card, key, detail, 'proceed')));
  row.append(actionButton(key, 'handoff:repick', '選んだ設定で引き継ぐ', () => decideHandoff(card, key, detail, 'repick')));
  if(detail.canReclassify) row.append(actionButton(key, 'handoff:reclassify', '再判定', () => decideHandoff(card, key, detail, 'reclassify')));
  row.append(actionButton(key, 'handoff:cancel', '引き継ぎを中止', () => decideHandoff(card, key, detail, 'cancel')));
  block.append(row); box.append(block);
  box.append(text('p', '元のウィンドウにダイアログが出ている場合、ここで答えても閉じられません（VS Codeに閉じる手段が無いため）。残ったダイアログを押しても二重には実行されません。', 'detail-note'));
  return box;
}
// 取り寄せた承認の中身。承認・拒否のボタンはここにしか無いので、
// 中身を表示していない状態では押せない（Issue #1259の受入基準）
function buildDetail(card, key) {
  const box = document.createElement('div'); box.className = 'card-detail';
  const error = detailErrors.get(key); const list = details.get(key);
  if(error !== undefined) { box.append(text('p', '内容を取り寄せられませんでした: ' + error, 'detail-note')); return box; }
  if(list === undefined) { box.append(text('p', '内容を取り寄せています…', 'detail-note')); return box; }
  if(list.length === 0) { box.append(text('p', '承認待ちはありません', 'detail-note')); return box; }
  for(const approval of list) {
    const block = document.createElement('div'); block.className = 'approval';
    block.append(text('p', approval.title || '承認待ち', 'approval-title'));
    // 相手プロセスが書いた文字列はtextContentで入れる（HTMLとして解釈させない）
    if(approval.detail) block.append(text('pre', approval.detail, 'approval-detail'));
    if(approval.paths && approval.paths.length) { const paths = document.createElement('ul'); paths.className = 'approval-paths'; for(const p of approval.paths) paths.append(text('li', p)); block.append(paths); }
    const row = document.createElement('div'); row.className = 'approval-actions';
    if(approval.decidable) { row.append(actionButton(key, 'approve:' + approval.requestId, '承認', () => sendControl(card, 'approvalDecision', undefined, { approvalRequestId: approval.requestId, decision: 'accept' })), actionButton(key, 'decline:' + approval.requestId, '拒否', () => sendControl(card, 'approvalDecision', undefined, { approvalRequestId: approval.requestId, decision: 'decline' }))); }
    else { row.append(text('span', 'この問い合わせは会話のタブ側で答えてください', 'detail-note')); }
    block.append(row); box.append(block);
  }
  return box;
}
// 入力欄はboard・summaryの外にあるため、盤面の再描画では作り直されない。
// 絞り込み条件も変数で持ち続けるので、250msごとの再描画をまたいで残る（Issue #1250）
queryInput.addEventListener('input', () => { query = queryInput.value.trim().toLowerCase(); applyFilter(); });
currentToggle.addEventListener('change', () => { currentOnly = currentToggle.checked; applyFilter(); });
clearButton.addEventListener('click', () => { queryInput.value=''; query=''; currentToggle.checked=false; currentOnly=false; selectedRepos.clear(); applyFilter(); queryInput.focus(); });
// 一覧の外を押したら閉じる。detailsは既定では開いたままで、盤面のカードを押しても被り続ける
document.addEventListener('click', event => { if(repoDetails.open && !repoDetails.contains(event.target)) repoDetails.open = false; });
// 操作の結果はトーストで出す（Issue #1258）。別ウィンドウ宛ては応答を待つため、
// 押した直後ではなく相手が実行した（できなかった）ことが分かってから出る
function showControlResult(data) {
  const info = pendingControls.get(data.seq); pendingControls.delete(data.seq);
  // 中身の取り寄せはカードの中へ出す。トーストにすると展開のたびに通知が出る
  if(info && info.action === 'approvalDetail') { applyApprovalDetail(info, data); return; }
  if(info && info.action === 'recentTurns') { applyRecentTurns(info, data); return; }
  // 脇道の質問もカードの中へ出す。回答はトーストに載せない（読みながら操作するため）
  if(info && (info.action === 'sideQuestion' || info.action === 'sideQuestionResult')) { applySideQuestion(info, data); return; }
  if(info && info.action === 'handoffDetail') { applyHandoffDetail(info, data); return; }
  const label = (info ? info.place + info.label : '操作');
  showToast(data.ok ? label + 'を実行しました' : label + 'に失敗しました: ' + (data.error || '理由は不明です'));
  // 承認・拒否の後は手元の中身が古い。捨てて取り直す（解決済みの要求を押せないように）
  if(info && info.action === 'approvalDecision') { details.delete(info.key); if(expanded.has(info.key)) { sendControl(info.card, 'approvalDetail'); } applyFilter(); return; }
  // 引き継ぎの決定の後も手元の中身は古い。捨てて取り直す（解決済みの保留を押せないように）
  if(info && info.action === 'handoffDecision') { handoffs.delete(info.key); if(handoffExpanded.has(info.key)) { requestHandoff(info.card); } applyFilter(); return; }
  if(!data.ok && info && info.text !== undefined && drafts.get(info.key) === undefined) { drafts.set(info.key, info.text); applyFilter(); }
}
window.addEventListener('message', event => { if(event.data.type==='board') { latestBoard = event.data.board; applyFilter(); } else if(event.data.type==='controlResult') { showControlResult(event.data); } }); vscode.postMessage({type:'ready'});
`;
