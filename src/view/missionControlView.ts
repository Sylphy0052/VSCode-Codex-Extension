import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type {
  McLaunchRepo,
  McLaunchRequest,
  McSnapshot,
  McTarget,
} from '../webview/missionControl/protocol';
import { MISSION_CONTROL_STYLES } from '../webview/missionControl/styles';
import type { SessionControlResult } from './chatManagerBase';
import { parseLaunchRequest, type McLaunchResult } from './missionControlLaunch';
import { missionControlTitle } from './missionControlModel';
import { parseAction, parseTarget, type SessionKanbanControl } from './sessionKanbanView';

export const MISSION_CONTROL_OPEN_COMMAND = 'agent.missionControl.open';

/** webviewのbundle（`npm run build`が`src/webview/missionControl/main.tsx`から作る）。 */
const SCRIPT_PATH = ['dist', 'missionControl.js'] as const;

/**
 * スナップショットを送る間隔（`sessionKanbanView.ts`の`POST_INTERVAL_MS`と同じ流儀）。
 * 最初の1件はすぐ送り、以降は間隔ごとにまとめ、最後の1回は必ず送る。
 */
const POST_INTERVAL_MS = 250;

/** ライブtailで他ウィンドウのセッションの直近のやり取りを取り直す間隔（Issue #2137の3）。 */
export const LIVE_POLL_MS = 2_000;
/** ライブtailで送る直近のやり取りの件数。 */
export const LIVE_TURNS = 6;

/** 新規セッションの起動（Issue #2137の1）。vscodeに依る部分は`extension.ts`が組む。 */
export interface McLaunchPort {
  options(): Promise<McLaunchRepo[]>;
  /** フォルダ選択のダイアログを出す。選ばれなければ`undefined`。 */
  pickFolder(): Promise<McLaunchRepo | undefined>;
  launch(request: McLaunchRequest): Promise<McLaunchResult>;
}

/**
 * Mission Control（Issue #2136）のエディタタブ。
 *
 * 全ウィンドウのセッションと回答待ちの項目を1画面に出し、Inboxから答えさせる。宛先の解決
 * （自ウィンドウか、共有ディレクトリ経由で別ウィンドウか）は統括ページと同じ
 * `controlSessionAnywhere`（`extension.ts`）に任せる。
 */
export class MissionControlViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.missionControl';
  private panel: vscode.WebviewPanel | undefined;
  private readonly panelDisposables: vscode.Disposable[] = [];
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPostAt = 0;
  /** 最後に送ったスナップショットのウィンドウid（自ウィンドウか他ウィンドウかの判定に使う）。 */
  private windowId: string | undefined;
  /** ライブtailの対象（詳細で選択中のセッション）。 */
  private watched: McTarget | undefined;
  private liveTimer: ReturnType<typeof setInterval> | undefined;
  private liveInFlight = false;

  constructor(
    private readonly read: () => McSnapshot,
    private readonly control: SessionKanbanControl,
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly launcher?: McLaunchPort,
  ) {}

  /** webviewの設定。`createWebviewPanel`と、Reload後の復元の両方で使う。 */
  webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
  }

  show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal();
      this.schedulePost();
      return;
    }
    const snapshot = this.read();
    const panel = vscode.window.createWebviewPanel(
      MissionControlViewManager.viewType,
      missionControlTitle(snapshot.pending.length),
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );
    this.attach(panel);
    this.log.info('Mission Controlを開いた');
  }

  /** Reload後に、VS Codeが残しておいたタブを引き取る（`registerWebviewPanelSerializer`）。 */
  restore(panel: vscode.WebviewPanel): void {
    if (this.panel !== undefined) {
      // 既に開いている（復元より先にコマンドで開かれた）。2枚目は持たない
      panel.dispose();
      this.panel.reveal();
      return;
    }
    panel.webview.options = this.webviewOptions();
    this.attach(panel);
    this.log.info('Mission Controlを復元した');
  }

  refresh(): void {
    if (this.panel === undefined) {
      return;
    }
    this.schedulePost();
  }

  dispose(): void {
    this.clearTimer();
    this.stopLive();
    this.panel?.dispose();
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = renderMissionControlHtml(
      panel.webview,
      vscode.Uri.joinPath(this.extensionUri, ...SCRIPT_PATH),
    );
    this.panelDisposables.push(
      panel.onDidDispose(() => {
        this.clearTimer();
        this.stopLive();
        this.watched = undefined;
        this.dirty = false;
        this.panel = undefined;
        for (const d of this.panelDisposables.splice(0)) {
          d.dispose();
        }
      }),
      // 非表示の間の更新は溜めておき、表に戻った時点で送り直す。ライブtailの取り直しも
      // 非表示の間は止め、表に戻ったら再開する
      panel.onDidChangeViewState(() => {
        if (this.panel?.visible === true && this.dirty) {
          this.schedulePost();
        }
        this.restartLive();
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
    );
  }

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

  private post(): void {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }
    this.lastPostAt = Date.now();
    const snapshot = this.read();
    // タブ名の件数は非表示の間も合わせる（タブ自体は見えている）
    panel.title = missionControlTitle(snapshot.pending.length);
    this.windowId = snapshot.windowId;
    this.dirty = !panel.visible;
    if (this.dirty) {
      return;
    }
    void panel.webview.postMessage({ type: 'snapshot', snapshot });
    // 自ウィンドウのセッションは状態の変化（このpostの契機）ごとにやり取りを送り直す
    if (this.watched !== undefined && this.watched.windowId === this.windowId) {
      this.pushLive();
    }
  }

  private receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'control':
        this.handleControl(m);
        return;
      case 'watch':
        this.setWatch(m.target);
        return;
      case 'launchOptions':
      case 'pickFolder':
      case 'launch':
        this.handleLaunch(m);
        return;
      default:
        return;
    }
  }

  /**
   * ライブtailの対象を差し替える（Issue #2137の3）。自ウィンドウのセッションは状態の変化で
   * 送り、他ウィンドウのセッションは選択中の間だけ`recentTurns`を間隔を空けて取り直す。
   */
  private setWatch(raw: unknown): void {
    const target =
      typeof raw === 'object' && raw !== null
        ? parseTarget(raw as Record<string, unknown>)
        : undefined;
    this.watched = target;
    this.restartLive();
  }

  private restartLive(): void {
    this.stopLive();
    const target = this.watched;
    if (target === undefined || this.panel?.visible !== true) {
      return;
    }
    this.pushLive();
    if (target.windowId !== this.windowId) {
      this.liveTimer = setInterval(() => this.pushLive(), LIVE_POLL_MS);
    }
  }

  private stopLive(): void {
    if (this.liveTimer !== undefined) {
      clearInterval(this.liveTimer);
      this.liveTimer = undefined;
    }
  }

  /** 直近のやり取りを1回取り、webviewへ送る。前の取り寄せが返るまでは重ねない。 */
  private pushLive(): void {
    const target = this.watched;
    if (target === undefined || this.liveInFlight || this.panel?.visible !== true) {
      return;
    }
    this.liveInFlight = true;
    void this.control(target, { kind: 'recentTurns', limit: LIVE_TURNS })
      .then((result) => {
        // 取り寄せの間に選択が変わっていたら捨てる（前の会話のやり取りを出さない）
        if (this.watched !== target) {
          return;
        }
        void this.panel?.webview.postMessage({
          type: 'liveTurns',
          target,
          ok: result.ok,
          error: result.error,
          turns: result.turns,
        });
      })
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: やり取りを取り寄せられませんでした: ${String(e)}`);
      })
      .finally(() => {
        this.liveInFlight = false;
      });
  }

  /** 新規セッションの起動にかかわる要求（Issue #2137の1）。応答は`reply`で返す。 */
  private handleLaunch(message: Record<string, unknown>): void {
    const seq = message.seq;
    if (typeof seq !== 'number') {
      return;
    }
    const launcher = this.launcher;
    if (launcher === undefined) {
      this.postReply(seq, { ok: false, error: '新規起動はこの画面では使えません' });
      return;
    }
    const run = async (): Promise<Record<string, unknown>> => {
      if (message.type === 'launchOptions') {
        return { ok: true, repos: await launcher.options() };
      }
      if (message.type === 'pickFolder') {
        const repo = await launcher.pickFolder();
        return { ok: true, repo };
      }
      const request = parseLaunchRequest(message);
      if (typeof request === 'string') {
        return { ok: false, error: request };
      }
      const result = await launcher.launch(request);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      this.log.info(`Mission Control: ${request.provider}の会話を起動した（${result.cwd}）`);
      this.refresh();
      return { ok: true, cwd: result.cwd };
    };
    void run()
      .then((reply) => this.postReply(seq, reply))
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 起動にかかわる操作に失敗しました: ${String(e)}`);
        this.postReply(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  private postReply(seq: number, reply: Record<string, unknown>): void {
    void this.panel?.webview.postMessage({ ...reply, type: 'reply', seq });
  }

  /**
   * webviewからの操作。webviewは信頼境界の外側として、統括ページと同じ関数で形を確かめる。
   * 中身（承認の内容・回答）の妥当性は宛先側（`controlSession`）が確かめる。
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
        this.postResult(seq, result);
        this.refresh();
      })
      .catch((e: unknown) => {
        this.log.warn(`Mission Control: 操作に失敗しました（${action.kind}）: ${String(e)}`);
        this.postResult(seq, { ok: false, error: '操作に失敗しました' });
      });
  }

  private postResult(seq: number, result: SessionControlResult): void {
    // 承認の中身・直近のやり取りは応答にだけ載せ、スナップショットには混ぜない
    void this.panel?.webview.postMessage({
      type: 'controlResult',
      seq,
      ok: result.ok,
      error: result.error,
      approvals: result.approvals,
      turns: result.turns,
    });
  }
}

/**
 * webviewのHTML。CSPは`default-src 'none'`で、scriptはnonce付きの1ファイルだけを許す。
 * スタイルは`<style>`へ埋める（`style-src 'unsafe-inline'`は他の画面と同じ）。
 */
export function renderMissionControlHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const src = webview.asWebviewUri(scriptUri).toString();
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Mission Control</title><style>${MISSION_CONTROL_STYLES}</style></head><body><div id="root"></div><script nonce="${nonce}" src="${escapeAttribute(src)}"></script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;',
  );
}
