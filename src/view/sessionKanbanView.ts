import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import { chatCsp } from './chatCsp';
import type { SessionControlAction, SessionControlResult } from './chatManagerBase';
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
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ALL WINDOWS</p><h1>セッション統括</h1><p class="description">このPCで開いている全VS Codeウィンドウの、この拡張機能が管理している会話を表示します。カードから、開く・中断・ループの一時停止と再開・指示の送信ができます。別ウィンドウのカードを開くと、相手ウィンドウの中でタブが開いた状態になりますが、ウィンドウ自体は前面に出ません。承認待ちへの対応は、開いたタブ側（相手ウィンドウ）で行ってください。</p><div class="filters"><input id="filterQuery" class="filter-input" type="search" autocomplete="off" placeholder="タイトル・フォルダ名で絞り込む" aria-label="タイトル・フォルダ名で絞り込む"><label class="filter-toggle"><input id="filterCurrent" type="checkbox">このウィンドウのみ</label><button id="filterClear" class="filter-clear" type="button" disabled>絞り込みを解除</button></div></div><div id="summary" class="summary" aria-live="polite"></div></header><section id="board" class="board" aria-label="セッションの状態"></section></main><div id="toast" class="toast" role="status" aria-live="polite"></div><script nonce="${nonce}">${script}</script></body></html>`;
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
.cards { display: grid; gap: 9px; padding: 10px; } .card { color: inherit; font: inherit; text-align: left; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; } .card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
/* 見出しの部分だけが「開く」ボタン。カード全体をボタンにすると操作を中に置けない（Issue #1258） */
.card-open { appearance: none; display: block; width: 100%; color: inherit; font: inherit; text-align: left; cursor: pointer; background: none; border: 0; padding: 0; } .card-open:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.card-action { appearance: none; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 8px; white-space: nowrap; cursor: pointer; } .card-action:disabled { opacity: .5; cursor: default; } .card-action:focus-visible, .send-input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.card-send { display: flex; gap: 6px; flex: 1 1 150px; min-width: 150px; } .send-input { flex: 1 1 auto; min-width: 60px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 6px; } .card.approvalPending { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); } .card.backgroundRunning { border-left: 4px solid var(--vscode-charts-orange); } .card-title { display: block; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .meta { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; margin-top: 8px; } .provider { text-transform: uppercase; font-weight: 700; } .window-label.current { color: var(--vscode-charts-green); } .empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 14px; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translate(-50%, 12px); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color: var(--vscode-notifications-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border)); border-radius: 6px; padding: 8px 16px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (max-width: 1180px) { .board { grid-template-columns: repeat(2, minmax(220px, 1fr)); } }
@media (max-width: 820px) { header { display:block; } .summary { justify-content:flex-start; margin-top:16px; } .board { grid-template-columns: 1fr; } }
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
body.skin-cyber .filter-input, body.skin-cyber .filter-clear { border-color: var(--agent-neon-edge); }
body.skin-cyber .filter-input:focus-visible, body.skin-cyber .filter-clear:focus-visible, body.skin-cyber .filter-toggle input:focus-visible { outline-color: var(--agent-neon-1); box-shadow: 0 0 12px -4px var(--agent-neon-glow); }
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
body.skin-cyber .card.running { border-left-color: var(--agent-neon-1); }
body.skin-cyber .card.backgroundRunning { border-left-color: var(--agent-neon-2); }
body.skin-cyber .card.idle { box-shadow: inset 2px 0 0 var(--agent-card-accent); }
body.skin-cyber .card:hover { border-color: color-mix(in srgb, var(--agent-neon-1) 55%, var(--vscode-panel-border)); box-shadow: inset 0 0 20px -10px var(--agent-neon-glow); }
body.skin-cyber .card.idle:hover { box-shadow: inset 2px 0 0 var(--agent-card-accent), inset 0 0 20px -10px var(--agent-neon-glow); }
/* フォーカスの輪郭はカードそのものではなく、中の操作要素に付く（Issue #1258） */
body.skin-cyber .card-open:focus-visible, body.skin-cyber .card-action:focus-visible, body.skin-cyber .send-input:focus-visible { outline-color: var(--agent-neon-1); }
body.skin-cyber .card-action, body.skin-cyber .send-input { border-color: var(--agent-neon-edge); }
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
const specs = [{ key:'approvalPending', label:'承認待ち', icon:'⚠', empty:'対応待ちの会話はありません' }, { key:'running', label:'実行中', icon:'↻', empty:'実行中の会話はありません' }, { key:'backgroundRunning', label:'バックグラウンド実行中', icon:'◐', empty:'バックグラウンド実行中の会話はありません' }, { key:'idle', label:'待機中', icon:'●', empty:'待機中の会話はありません' }];
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
// 送った操作と、その結果を結び付ける通し番号
let controlSeq = 0; const pendingControls = new Map();
const actionLabels = { open: '開く', interrupt: '中断', pauseLoop: '一時停止', resumeLoop: '再開', send: '指示の送信' };
function sendControl(card, action, text) { controlSeq += 1; const seq = controlSeq; pendingControls.set(seq, { label: actionLabels[action], place: card.isCurrentWindow ? '' : windowLabel(card) + 'の', key: cardKey(card), text }); vscode.postMessage({ type:'control', seq, action, windowId:card.windowId, provider:card.provider, threadId:card.threadId, text }); }
// 生のwindowId（UUID）はユーザーには読めないため、初出順の連番に置き換えて表示する。
// 番号は絞り込み前の盤面全体から先に割り当てる。絞り込みで隠れたカードを飛ばして
// 採番すると、条件を変えるたびに同じウィンドウの番号が変わる（Issue #1250）
const windowAliases = new Map(); let windowAliasCounter = 0;
function registerAlias(card) { if(card.isCurrentWindow || windowAliases.has(card.windowId)) return; windowAliasCounter += 1; windowAliases.set(card.windowId, windowAliasCounter); }
function windowLabel(card) { if(card.isCurrentWindow) return 'このウィンドウ'; registerAlias(card); return 'ウィンドウ' + windowAliases.get(card.windowId); }
// 絞り込みはこのページの中だけで完結させる（Issue #1250）。拡張側は全件を送り続け、
// 描画時に絞る。往復させないので入力に即応し、全体の件数も画面に残せる
let latestBoard = { cards: { approvalPending: [], running: [], backgroundRunning: [], idle: [] }, total: 0 };
let query = ''; let currentOnly = false;
function isFiltering() { return query !== '' || currentOnly; }
// 絶対パス（cwdFull）は検索対象にしない。画面へ出さない方針（Issue #1039）と揃える
function matches(card) { if(currentOnly && !card.isCurrentWindow) return false; if(query === '') return true; return ((card.title || '') + ' ' + (card.cwdLabel || '')).toLowerCase().includes(query); }
function countLabel(shown, total) { return isFiltering() ? shown + ' / ' + total : String(total); }
function applyFilter() { clearButton.disabled = !isFiltering(); render(latestBoard); }
let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
// 承認待ちの列の見出しと走査線を切り替える（Issue #1253）。判定は上の注意の色と同じく
// 絞り込み前の全体の件数で行う
function setApprovalFlag(has) { document.body.classList.toggle('has-approval', has); }
// 承認待ちの強調は絞り込み後ではなく全体の件数で決める。絞り込みで隠れただけの
// 承認待ちがあるのに注意の色が消えると、対応漏れを誘う（Issue #1250）
function render(data) { const focused = focusedCard(); board.replaceChildren(); summary.replaceChildren(); const counts=data.cards; for(const spec of specs) for(const card of counts[spec.key]) registerAlias(card); const shown={}; let shownTotal=0; for(const spec of specs) { shown[spec.key]=counts[spec.key].filter(matches); shownTotal+=shown[spec.key].length; } summary.append(text('span', countLabel(shownTotal, data.total) + ' セッション', 'metric')); for(const spec of specs) { const list=shown[spec.key]; const total=counts[spec.key].length; const metric=text('span', spec.label + ' ' + countLabel(list.length, total), 'metric' + (spec.key==='approvalPending' && total ? ' alert' : '')); summary.append(metric); const column=document.createElement('section'); column.className='column ' + spec.key; const head=document.createElement('div'); head.className='column-head'; head.append(text('span', spec.icon, 'icon'), text('span', spec.label), text('span', countLabel(list.length, total), 'count')); const cards=document.createElement('div'); cards.className='cards'; if(list.length===0) cards.append(text('p', total===0 ? spec.empty : '条件に一致する会話はありません', 'empty')); for(const card of list) cards.append(buildCard(card, spec.key)); column.append(head,cards); board.append(column); } setApprovalFlag(counts.approvalPending.length > 0); restoreFocus(focused); }
function actionButton(key, role, label, onClick) { const b=document.createElement('button'); b.type='button'; b.className='card-action'; b.dataset.cardKey=key; b.dataset.role=role; b.textContent=label; b.addEventListener('click', onClick); return b; }
// カード1枚。見出しの部分が「開く」ボタンで、その下に操作が並ぶ（Issue #1258）。
// カード全体をボタンにすると中に操作ボタンを置けない（入れ子のボタンは作れない）
function buildCard(card, column) {
  const key = cardKey(card);
  const item = document.createElement('div'); item.className = 'card ' + column;
  const open = document.createElement('button'); open.type='button'; open.className='card-open'; open.dataset.cardKey=key; open.dataset.role='open'; open.title=card.title || '名称未設定';
  open.append(text('span', card.title || '名称未設定', 'card-title'));
  const meta=document.createElement('span'); meta.className='meta'; const cwdSpan=text('span', card.cwdLabel); cwdSpan.title=card.cwdFull; const windowSpan=text('span', windowLabel(card), 'window-label' + (card.isCurrentWindow ? ' current' : '')); meta.append(text('span', card.provider, 'provider'), text('span', '•'), cwdSpan, text('span', '•'), windowSpan); open.append(meta);
  open.addEventListener('click', () => sendControl(card, 'open'));
  item.append(open);
  const actions=document.createElement('div'); actions.className='card-actions';
  // 待機中のカードには止めるものが無い。承認待ちは「承認せずに止める」ことがあるので押せる
  const stop=actionButton(key, 'interrupt', '中断', () => sendControl(card, 'interrupt')); stop.disabled = column === 'idle'; actions.append(stop);
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
  actions.append(form); item.append(actions);
  return item;
}
// 入力欄はboard・summaryの外にあるため、盤面の再描画では作り直されない。
// 絞り込み条件も変数で持ち続けるので、250msごとの再描画をまたいで残る（Issue #1250）
queryInput.addEventListener('input', () => { query = queryInput.value.trim().toLowerCase(); applyFilter(); });
currentToggle.addEventListener('change', () => { currentOnly = currentToggle.checked; applyFilter(); });
clearButton.addEventListener('click', () => { queryInput.value=''; query=''; currentToggle.checked=false; currentOnly=false; applyFilter(); queryInput.focus(); });
// 操作の結果はトーストで出す（Issue #1258）。別ウィンドウ宛ては応答を待つため、
// 押した直後ではなく相手が実行した（できなかった）ことが分かってから出る
function showControlResult(data) { const info = pendingControls.get(data.seq); pendingControls.delete(data.seq); const label = (info ? info.place + info.label : '操作'); showToast(data.ok ? label + 'を実行しました' : label + 'に失敗しました: ' + (data.error || '理由は不明です')); if(!data.ok && info && info.text !== undefined && drafts.get(info.key) === undefined) { drafts.set(info.key, info.text); applyFilter(); } }
window.addEventListener('message', event => { if(event.data.type==='board') { latestBoard = event.data.board; applyFilter(); } else if(event.data.type==='controlResult') { showControlResult(event.data); } }); vscode.postMessage({type:'ready'});
`;
