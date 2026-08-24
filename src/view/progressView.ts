import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatState } from '../appserver/chatState';
import type { Logger } from '../log';
import { chatCsp } from './chatCsp';
import type { ChatStateChange, ProgressTarget } from './chatManagerBase';
import { buildProgress } from './progressModel';
import { progressScript } from './progressScript';
import { progressStyles } from './progressStyles';

/** 対象スレッドの現在の状態を引く口。開いているチャットが無ければ `undefined`。 */
export type ProgressStateReader = (threadId: string) => ChatState | undefined;

/**
 * セッションの進捗を出す専用タブ（issue #721）。
 *
 * チャットの状態が変わるたびに描き直す。会話の本文はすべて信頼できない入力として扱い、
 * webview側でDOMのテキストとして入れる（HTMLとして組み立てない）。
 */
export class ProgressViewManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /**
   * 見えていない間に状態が変わったスレッド。
   *
   * `buildProgress`は会話項目を毎回全部走る。状態の通知は応答中に間引き後でも
   * 秒間20回ほど届くため、見えていないタブのために毎回組み立てると、会話が長いほど
   * 拡張ホスト側の無駄が増える。`retainContextWhenHidden`で中身は保たれるので、
   * 見えるようになった時点で最新へ追いつかせれば足りる。
   */
  private readonly staleThreadIds = new Set<string>();

  constructor(
    private readonly read: ProgressStateReader,
    private readonly log: Logger,
  ) {}

  /** 対象スレッドの進捗タブを開く。既に開いていれば前に出すだけ。 */
  open(target: ProgressTarget): void {
    const existing = this.panels.get(target.threadId);
    if (existing !== undefined) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agent.progress',
      `進捗: ${target.title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panels.set(target.threadId, panel);
    panel.onDidDispose(() => {
      this.panels.delete(target.threadId);
      this.staleThreadIds.delete(target.threadId);
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible && this.staleThreadIds.delete(target.threadId)) {
        this.post(target.threadId, panel);
      }
    });
    panel.webview.html = render(panel.webview);
    // webviewの読み込みが終わってから初期表示を送る（HTMLを入れた直後は受け取れない）
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isReady(message)) {
        this.post(target.threadId, panel);
      }
    });
    this.log.info(`進捗画面を開いた: thread=${target.threadId}`);
  }

  /** チャットの状態が変わったときに呼ぶ。対象のタブが開いていなければ何もしない。 */
  notify(change: ChatStateChange): void {
    const panel = this.panels.get(change.threadId);
    if (panel === undefined) {
      return;
    }
    if (!panel.visible) {
      this.staleThreadIds.add(change.threadId);
      return;
    }
    void panel.webview.postMessage({ type: 'progress', view: buildProgress(change.state) });
  }

  private post(threadId: string, panel: vscode.WebviewPanel): void {
    const state = this.read(threadId);
    if (state === undefined) {
      // チャットのタブが閉じられた後にリロードされた場合。数字を出すより空だと判る方がよい
      void panel.webview.postMessage({ type: 'progress', view: undefined });
      return;
    }
    void panel.webview.postMessage({ type: 'progress', view: buildProgress(state) });
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.staleThreadIds.clear();
  }
}

function isReady(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['type'] === 'ready'
  );
}

function render(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  // 画像は扱わない（本文はすべてテキストとして出す）ため img-src は足さない（chatCsp.ts参照）
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${progressStyles()}
</style>
</head>
<body>
  <div id="empty">まだ進捗はありません。</div>
  <section id="summary" hidden>
    <h1>進捗</h1>
    <div id="summaryLine" class="meta"></div>
    <div id="progressBar"><div id="progressFill"></div></div>
  </section>
  <section id="checklistSection" hidden>
    <h2>チェックリスト</h2>
    <ul id="checklist"></ul>
  </section>
  <section id="filesSection" hidden>
    <h2>変更したファイル</h2>
    <ul id="files"></ul>
  </section>
  <section id="timelineSection" hidden>
    <h2>タイムライン</h2>
    <div id="timeline"></div>
  </section>
<script nonce="${nonce}">
${progressScript()}
</script>
</body>
</html>`;
}
