import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type { McSnapshot } from '../webview/missionControl/protocol';
import { MISSION_CONTROL_STYLES } from '../webview/missionControl/styles';
import type { SessionControlResult } from './chatManagerBase';
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

  constructor(
    private readonly read: () => McSnapshot,
    private readonly control: SessionKanbanControl,
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
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
        this.dirty = false;
        this.panel = undefined;
        for (const d of this.panelDisposables.splice(0)) {
          d.dispose();
        }
      }),
      // 非表示の間の更新は溜めておき、表に戻った時点で送り直す
      panel.onDidChangeViewState(() => {
        if (this.panel?.visible === true && this.dirty) {
          this.schedulePost();
        }
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
    this.dirty = !panel.visible;
    if (this.dirty) {
      return;
    }
    void panel.webview.postMessage({ type: 'snapshot', snapshot });
  }

  private receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    if (m.type === 'ready') {
      this.post();
      return;
    }
    if (m.type === 'control') {
      this.handleControl(m);
    }
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
