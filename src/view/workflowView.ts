import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalDecision } from '../appserver/approvals';
import type { Logger } from '../log';
import type { WorkflowRunner } from '../orchestrator/runner';
import { chatCsp } from './chatCsp';
import { layoutGraph } from './workflowGraph';
import { workflowScript } from './workflowScript';
import { workflowStyles } from './workflowStyles';

/**
 * ワークフローViewのWebviewパネル（design.md §16.8）。専用パネル（`workflow.run`）で
 * 進捗の要約・依存グラフ・タスク一覧・会話への導線・ノードからの操作を1枚にまとめる。
 *
 * `WorkflowRunner` はVSCode APIに依存しない設計（design.md §16.10）なので、
 * VSCode固有の部分（パネルの生成、ファイルを開く、コマンドの実行）は全てここに置く。
 */
export class WorkflowViewManager implements vscode.Disposable {
  static readonly viewType = 'workflow.run';

  private panel: vscode.WebviewPanel | undefined;
  private activeRunId: string | undefined;
  private readonly unsubscribeChanged: () => void;

  constructor(
    private readonly runner: WorkflowRunner,
    private readonly log: Logger,
  ) {
    this.unsubscribeChanged = runner.onChanged((runId) => this.onRunnerChanged(runId));
  }

  dispose(): void {
    this.unsubscribeChanged();
    this.panel?.dispose();
  }

  /**
   * パネルを開く（無ければ作る）。`runId` を渡せばその実行を表示する。省略時は
   * 現在表示中のrun、それも無ければ直近のrunを既定にする。
   */
  show(runId?: string): void {
    if (runId !== undefined) {
      this.activeRunId = runId;
    } else if (this.activeRunId === undefined) {
      this.activeRunId = this.runner.listLive()[0]?.runId;
    }

    if (this.panel === undefined) {
      const panel = vscode.window.createWebviewPanel(
        WorkflowViewManager.viewType,
        'ワークフロー',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.options = { enableScripts: true };
      panel.webview.html = this.render(panel.webview);
      panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
      panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel = panel;
    } else {
      this.panel.reveal();
    }
    this.postAll();
  }

  private onRunnerChanged(runId: string): void {
    if (this.panel === undefined) {
      return;
    }
    // run一覧（実行中/終了の別）はどのrunが変わっても揺れうるので毎回更新する
    this.postRunList();
    if (runId === this.activeRunId) {
      this.postState();
    }
  }

  private postAll(): void {
    this.postRunList();
    this.postState();
  }

  private postRunList(): void {
    if (this.panel === undefined) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'runs', runs: this.runner.listLive() });
  }

  /**
   * 現在表示中のrunのスナップショットを送る。段レイアウトはここで計算して同送する
   * （`layoutGraph` は純粋関数。Webview側では再計算しない）。
   *
   * ここが更新の唯一の入口。差分計算はしていない（design.mdの「送るのは差分のみ」を
   * 「状態が変わっていないのに送らない」という意味で解釈している。runIdあたり最大
   * 50タスクという上限があるため、スナップショット全体を送っても軽い）。
   */
  private postState(): void {
    if (this.panel === undefined) {
      return;
    }
    if (this.activeRunId === undefined) {
      void this.panel.webview.postMessage({ type: 'noRun' });
      return;
    }
    const snapshot = this.runner.getSnapshot(this.activeRunId);
    if (snapshot === undefined) {
      void this.panel.webview.postMessage({ type: 'noRun' });
      return;
    }
    this.panel.title = snapshot.name === '' ? 'ワークフロー' : snapshot.name;
    const layout = layoutGraph(snapshot.tasks);
    void this.panel.webview.postMessage({ type: 'state', snapshot, layout });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    const type = m['type'];

    if (type === 'ready') {
      this.postAll();
      return;
    }
    if (type === 'selectRun' && typeof m['runId'] === 'string') {
      this.activeRunId = m['runId'];
      this.postState();
      return;
    }
    if (type === 'run') {
      // 定義ファイルの選択・allow確認・開始は`extension.ts`側（vscodeのQuickPick等を
      // 使う既存の入口）に集約する。ここから同じコマンドを呼び直すだけにして、
      // ロジックの持ち場を1つに保つ
      await vscode.commands.executeCommand('agent.workflows.run');
      return;
    }

    const runId = this.activeRunId;
    if (runId === undefined) {
      return;
    }

    if (type === 'stopAll') {
      this.runner.stop(runId);
      return;
    }
    if (type === 'removeWorktrees') {
      const result = await this.runner.removeWorktrees(runId);
      if (result.failed.length > 0) {
        this.log.warn(`[workflowView] worktreeの撤去に失敗したタスク: ${result.failed.join(', ')}`);
        void vscode.window.showWarningMessage(
          `worktreeの撤去に失敗したタスクがあります: ${result.failed.join(', ')}`,
        );
      }
      return;
    }
    if (type === 'openDefFile') {
      const snapshot = this.runner.getSnapshot(runId);
      if (snapshot === undefined) {
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(snapshot.defPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (e) {
        this.log.error(`定義ファイルを開けません: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    const taskId = m['taskId'];
    if (typeof taskId !== 'string') {
      return;
    }
    if (type === 'reveal') {
      this.runner.revealTask(runId, taskId);
      return;
    }
    if (type === 'interrupt') {
      await this.runner.interruptTask(runId, taskId);
      return;
    }
    if (type === 'stopTask') {
      this.runner.stopTask(runId, taskId);
      return;
    }
    if (type === 'retry') {
      this.runner.retryTask(runId, taskId);
      return;
    }
    if (type === 'approve' && typeof m['decision'] === 'string') {
      this.runner.decideApproval(runId, taskId, m['decision'] as ApprovalDecision);
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = chatCsp(webview.cspSource, nonce);

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${workflowStyles()}
</style>
</head>
<body>
  <div id="header">
    <div>
      <div class="title-row">
        <h1 id="runName"></h1>
        <select id="runSelect" hidden></select>
      </div>
      <div class="counts" id="runCounts"></div>
    </div>
    <div class="elapsed" id="runStartedAt"></div>
    <div class="actions">
      <button id="runBtn" type="button">実行</button>
      <button id="stopAllBtn" type="button" class="danger">全体の停止</button>
      <button id="removeWorktreesBtn" type="button" class="secondary">worktreeの撤去</button>
      <button id="openDefBtn" type="button" class="secondary">定義ファイルを開く</button>
    </div>
    <div id="progressBar"><div class="fill" id="progressFill"></div></div>
    <div id="progressPercent"></div>
    <div id="banner" hidden></div>
  </div>

  <div id="content" hidden>
    <h2>依存グラフ</h2>
    <div id="graphWrap">
      <svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg>
    </div>

    <h2>タスク一覧</h2>
    <table id="taskTable">
      <thead>
        <tr>
          <th>id</th><th>状態</th><th>provider</th><th>作業ディレクトリ</th>
          <th>経過</th><th>送信回数</th><th>直近の応答</th><th>操作</th>
        </tr>
      </thead>
      <tbody id="taskTableBody"></tbody>
    </table>

    <div id="warningsSection" hidden>
      <h2>警告</h2>
      <div id="warnings"></div>
    </div>
  </div>

  <div id="empty">実行中のワークフローがありません。「実行」から定義ファイルを選んでください。</div>

<script nonce="${nonce}">
${workflowScript()}
</script>
</body>
</html>`;
  }
}
