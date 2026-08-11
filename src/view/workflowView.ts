import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isApprovalDecision } from '../appserver/approvals';
import type { Logger } from '../log';
import type {
  TaskSnapshot,
  WorkflowRunner,
  WorkflowRunSnapshot,
  WorkflowWarning,
} from '../orchestrator/runner';
import type { WorkflowDefinition } from '../orchestrator/workflow';
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
  /**
   * 生成直後・未実行のワークフロー定義のプレビュー（design.md §16.9手順4）。
   * `activeRunId === undefined` の間だけ意味を持つ。`WorkflowRunner`には一切登録しない
   * ため、`runner.onChanged` はこれを更新しない（そもそも実行が始まっていないので
   * 変化しようがない）。
   */
  private previewSnapshot: WorkflowRunSnapshot | undefined;
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
    // 実行中/終了済みのrunを明示的に見にきたときは、生成直後のプレビューから離れる
    this.previewSnapshot = undefined;

    if (this.panel === undefined) {
      this.ensurePanel();
    } else {
      this.panel.reveal();
    }
    this.postAll();
  }

  /**
   * ゴール文から生成した直後・未実行のワークフロー定義をプレビュー表示する
   * （design.md §16.9手順4「ワークフローViewを同時に開き、依存関係の図を見ながら人が直す」）。
   *
   * `WorkflowRunner`には一切登録せず、セッションも開かない。表示するのは全タスク
   * `pending`のスナップショットで、依存グラフとタスク一覧だけを見せる。実行するには
   * 「実行」操作（design.md §16.8）を人が選ぶ必要がある（design.md §16.13「生成した
   * まま自動で実行しない」をView側でも徹底する。実際、`retry`/`stopTask`等の操作は
   * `activeRunId`が無いと何もしない実装になっている）。
   */
  previewDefinition(
    defPath: string,
    def: WorkflowDefinition,
    securityWarnings: readonly WorkflowWarning[],
  ): void {
    this.activeRunId = undefined;
    this.previewSnapshot = buildPreviewSnapshot(defPath, def, securityWarnings);
    this.ensurePanel().reveal(vscode.ViewColumn.Beside, true);
    this.postAll();
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel !== undefined) {
      return this.panel;
    }
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
    return panel;
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
      if (this.previewSnapshot !== undefined) {
        this.postSnapshot(this.previewSnapshot, '（下書き・未実行）');
        return;
      }
      void this.panel.webview.postMessage({ type: 'noRun' });
      return;
    }
    const snapshot = this.runner.getSnapshot(this.activeRunId);
    if (snapshot === undefined) {
      void this.panel.webview.postMessage({ type: 'noRun' });
      return;
    }
    this.postSnapshot(snapshot, '');
  }

  private postSnapshot(snapshot: WorkflowRunSnapshot, titleSuffix: string): void {
    if (this.panel === undefined) {
      return;
    }
    this.panel.title = (snapshot.name === '' ? 'ワークフロー' : snapshot.name) + titleSuffix;
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
      // Webviewは信頼境界の外側。存在しないidをそのまま`activeRunId`へ入れても
      // 実害は薄い（`getSnapshot`がundefinedを返すだけ）が、多層防御として
      // `listLive()`にある実在のidかを確かめてから採用する（レビュー指摘: low）
      const requestedRunId = m['runId'];
      if (this.runner.listLive().some((r) => r.runId === requestedRunId)) {
        this.activeRunId = requestedRunId;
        this.postState();
      }
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
      // 未コミットの変更があるworktreeは`removeWorktree`自身が拒否するためデータ損失は
      // 防がれるが、クリーンなworktreeとブランチは確認無しで一発で消える。セッション削除
      // 等の他の破壊的操作と同じく確認を挟む（レビュー指摘: low）
      const choice = await vscode.window.showWarningMessage(
        'このワークフローで作られたworktreeを撤去します。未コミットの変更があるものは残ります。',
        { modal: true },
        '撤去する',
      );
      if (choice !== '撤去する') {
        return;
      }
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
      await this.retryWithAllowConfirmation(runId, taskId);
      return;
    }
    if (type === 'approve' && isApprovalDecision(m['decision'])) {
      this.runner.decideApproval(runId, taskId, m['decision']);
    }
  }

  /**
   * 「再実行」操作。対象タスクに `allow` があれば確認を挟む（design.md §16.7、
   * レビュー指摘: high）。`start()` の実行前確認はプロセス最初の起動時にしか効かず、
   * ウィンドウのリロード後に復元した実行を「再実行」する経路はそれを経由しないため、
   * ここで独立して確認する。
   */
  private async retryWithAllowConfirmation(runId: string, taskId: string): Promise<void> {
    const first = this.runner.retryTask(runId, taskId);
    if (first.ok || first.needsAllowConfirmation !== true) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `タスク「${taskId}」は既定の危険操作チェックを解除しています（allow）。` +
        'このタスクではallowに一致する操作が承認なしで実行されます。再実行しますか？',
      { modal: true },
      '再実行する',
    );
    if (choice !== '再実行する') {
      return;
    }
    this.runner.retryTask(runId, taskId, { allowConfirmed: true });
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

/**
 * 未実行のワークフロー定義から、全タスク`pending`のスナップショットを組み立てる
 * （`WorkflowViewManager.previewDefinition`専用）。
 *
 * `runId`はワークフロー全体に対して一意であればよい（`WorkflowRunner`のrunIdとは無関係の
 * 別名前空間）。定義ファイルのパスは実行のたびに変わらないため、そのままキーに使う。
 */
function buildPreviewSnapshot(
  defPath: string,
  def: WorkflowDefinition,
  warnings: readonly WorkflowWarning[],
): WorkflowRunSnapshot {
  const tasks: TaskSnapshot[] = def.tasks.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn,
    provider: task.provider,
    state: 'pending',
    cwd: undefined,
    branch: undefined,
    submissionCount: 0,
    retryCount: 0,
    startedAt: undefined,
    lastResponseSummary: '',
    failure: undefined,
    pendingApproval: undefined,
    hasLiveSession: false,
    expandedPrompt: undefined,
  }));
  return {
    runId: `preview:${defPath}`,
    name: def.name,
    defPath,
    // 「実行中ではない」ことだけを表現したいための便宜的な値（stopAllBtnの無効化にしか
    // 使わない）。「下書きである」という本来伝えたい意味は`isDraft`が持つ
    outcome: 'aborted',
    startedAt: new Date().toISOString(),
    tasks,
    warnings,
    haltedByUser: false,
    isDraft: true,
  };
}
