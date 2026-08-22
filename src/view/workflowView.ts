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
import { aggregateProgress, layoutGraph, summarizeIntegration } from './workflowGraph';
import { workflowScript } from './workflowScript';
import { workflowStyles } from './workflowStyles';

/**
 * ワークフローViewパネルの生成オプション（design.md §14.48、issue #287）。
 * `enableFindWidget: true` でCtrl+Fの検索窓を有効にする。オブジェクトの組み立てを
 * 関数として切り出すことで、`createWebviewPanel`（vscode本体のAPI）を実際に呼ばずとも
 * 内容をテストできるようにしている。ワークフローViewはタブ復元（`WebviewPanelSerializer`）
 * を登録していないため、生成時のこの1箇所だけで完結する。
 */
export function buildWorkflowPanelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true };
}

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
  /**
   * Webviewが報告してきたグラフ描画領域の幅（px、design.md §16.8「依存グラフ」）。
   * 段の折り返し（`layoutGraph`の`maxWidth`）に使う。パネルの幅は拡張機能側からは
   * 取れないため、Webview側の`ResizeObserver`から`viewport`メッセージで受け取る。
   * 未受信の間は`undefined`＝折り返さない（従来どおりのレイアウト）。
   */
  private graphViewportWidth: number | undefined;
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
   *
   * `warnings`には`plannerSecurity`（安全設定の上書き）と`plannerReview`（タスク分解の
   * レビュー指摘、design.md §16.28）が混在しうる。呼び出し側（`extension.ts`の
   * `handlePlanSuccess`）は、レビュー結果が出るより先にこのメソッドを呼んで表示を先出し
   * し、レビューが完了した時点でもう一度この同じメソッドを呼んで`warnings`だけを
   * 差し替える（スナップショットは毎回作り直すため、2回目の呼び出しは1回目を上書きする）。
   *
   * **この上書きは無条件**——`activeRunId`を問わず、パネルの現在の表示をこのプレビュー
   * へ戻す。レビュー完了前にユーザーが別のrunの表示へ切り替えていた場合、その表示が
   * レビュー結果の到着で差し替わりうる（フォーカスは奪わない。`reveal`の第2引数
   * `preserveFocus: true`のため）。この取り回しはW3の受入基準の対象外として許容して
   * いる（design.md §16.28）。
   */
  previewDefinition(
    defPath: string,
    def: WorkflowDefinition,
    warnings: readonly WorkflowWarning[],
  ): void {
    this.activeRunId = undefined;
    this.previewSnapshot = buildPreviewSnapshot(defPath, def, warnings);
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
      buildWorkflowPanelOptions(),
    );
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.render(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      // 次にパネルを開いたときは新しいWebviewが幅を報告し直す。古い幅を持ち越すと
      // 開き直した直後の1回だけ違う幅で折り返してしまう
      this.graphViewportWidth = undefined;
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
    const layout = layoutGraph(snapshot.tasks, { maxWidth: this.graphViewportWidth });
    // 進捗の内訳・統合の状況の集計は`workflowGraph.ts`の純粋関数（テスト済み）で行い、
    // Webview側では受け取った結果を表示するだけにする（design.md §16.8「全体の進捗」・
    // 「そのほか」・Issue #104。以前はWebview内のJavaScriptで独自に集計しており、
    // `merging`/`blocked`/`waitingReply`の3状態がここでの追随漏れの原因になっていた）
    const progress = aggregateProgress(snapshot.tasks);
    const integration = summarizeIntegration(snapshot.integrationBranch, snapshot.tasks, {
      number: snapshot.integrationPullRequestNumber,
      url: snapshot.integrationPullRequestUrl,
      finalMergeOutcome: snapshot.finalMergeOutcome,
      finalMergeDecision: snapshot.finalMergeDecision,
    });
    void this.panel.webview.postMessage({ type: 'state', snapshot, layout, progress, integration });
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
    if (type === 'viewport' && typeof m['width'] === 'number') {
      // Webviewは信頼境界の外側。NaN・負値・極端な値をそのままレイアウトへ渡さない
      // （`layoutGraph`側も最低1ノードは並べるが、ここでも常識的な範囲に丸めておく）
      const raw = m['width'];
      if (!Number.isFinite(raw)) {
        return;
      }
      const width = Math.min(20000, Math.max(0, Math.round(raw)));
      if (width === this.graphViewportWidth) {
        return;
      }
      this.graphViewportWidth = width;
      this.postState();
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
      } else if (result.removed.length === 0) {
        // `cleanup: after-merge`（既定）の正常完了直後は自動撤去済みで対象が1件も無い。
        // 何も起きず黙るだけだと「押しても反応が無い」ように見えるため、その旨を伝える
        // （Issue #252）
        void vscode.window.showInformationMessage(
          '撤去するworktreeはありません（既に撤去済みです）。',
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
    if (type === 'openIntegrationPullRequest') {
      // Webviewからは番号やURLを受け取らず、runIdだけでrunner.tsへ問い合わせる
      // （design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして挿入する」の
      // 精神と同じく、Webview側が持つ値を操作の起点として信用しない）
      const snapshot = this.runner.getSnapshot(runId);
      await this.openPullRequestUrl(snapshot?.integrationPullRequestUrl);
      return;
    }
    if (type === 'cleanupIntegration') {
      // design.md §16.17「worktreeの片付け」・Issue #118「統合ブランチと残った
      // worktreeをまとめて片付ける」。統合worktreeの撤去は人が明示的にこの操作を
      // 押したときだけ実行する（`blocked`タスクの再マージが使い続けるため、runの
      // 終了時に無条件で撤去してはいけない）。破壊的操作なので確認を挟む
      const choice = await vscode.window.showWarningMessage(
        '統合ブランチのworktreeと、このワークフローで作られた残りのworktreeをまとめて撤去します。' +
          '未コミットの変更が残っているものは撤去せず警告します。統合ブランチ自体（履歴）は消しません。',
        { modal: true },
        '撤去する',
      );
      if (choice !== '撤去する') {
        return;
      }
      // 撤去はタスク数だけ`git status`と`git worktree remove`（疑似worktreeなら
      // ディレクトリの再帰削除）を逐次待つため、時間がかかることがある。押しても
      // 反応が無いように見えないよう進捗を出す（Issue #298「進捗が分からない」）
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'worktreeを撤去しています' },
        (progress) =>
          this.runner.cleanupIntegration(runId, ({ done, total, label }) => {
            progress.report({
              message: `${label}（${done}/${total}）`,
              increment: total > 0 ? 100 / total : 0,
            });
          }),
      );
      const problems: string[] = [];
      if (result.tasksFailed.length > 0) {
        problems.push(`worktreeの撤去に失敗したタスクがあります: ${result.tasksFailed.join(', ')}`);
      }
      if (!result.integrationRemoved && result.integrationFailedMessage !== undefined) {
        problems.push(result.integrationFailedMessage);
      }
      if (problems.length > 0) {
        this.log.warn(`[workflowView] ${problems.join(' / ')}`);
        void vscode.window.showWarningMessage(problems.join(' / '));
        return;
      }
      // 成功時は無言で終わらず、何をどれだけ撤去したかを伝える（Issue #298
      // 「成功しても何も表示されない」）。「worktreeの撤去」（Issue #252）と同じ扱いで、
      // 対象が0件（既に撤去済み、または統合worktreeがそもそも対象で無い）なら
      // その旨だけ伝える
      if (result.tasksRemoved.length === 0 && !result.integrationRemoved) {
        // 統合worktreeがそもそも作られていないrun（gitの作業ツリーでも疑似worktreeでも
        // ないため統合先を持たないrun）と、既に撤去済みのrunとを言い分ける
        void vscode.window.showInformationMessage(
          result.integrationApplicable
            ? '撤去するworktreeはありません（既に撤去済みです）。'
            : '撤去するworktreeはありません（このワークフローは統合worktreeを作っていません）。',
        );
        return;
      }
      const integrationNote = result.integrationRemoved ? '、統合worktreeも撤去しました' : '';
      void vscode.window.showInformationMessage(
        `worktreeを${result.tasksRemoved.length}件撤去しました${integrationNote}。`,
      );
      return;
    }

    if (type === 'orchestratorSend' && typeof m['text'] === 'string') {
      // design.md §16.23「会話のUI」。入力欄の文字列は**人の入力**であってタスクの出力では
      // ないため、`wrapTaskMessage`の囲いは付けずそのまま渡す。空文字・空白のみは
      // `sendToOrchestrator`（runner.ts）側が弾く
      this.runner.sendToOrchestrator(runId, m['text']);
      return;
    }
    if (type === 'orchestratorReveal') {
      // 同じセッションのチャットタブを前面に出す（`reveal`）。オーケストレーター用の
      // チャット画面は作らず、既存の画面をそのまま使う。開いた時点で未読の印が消える
      this.runner.revealOrchestrator(runId);
      return;
    }
    if (
      type === 'decideFinalMerge' &&
      (m['decision'] === 'merge' || m['decision'] === 'hold') &&
      typeof m['reason'] === 'string'
    ) {
      // design.md §16.26。`finalMerge: confirm`の人の判断。`orchestrator`モードの
      // オーケストレーターからの判断はMCPツール（`decide_final_merge`）経由で、Webviewの
      // このメッセージは通らない。空文字の理由は`workflowScript.ts`側で送信前に弾いている
      //
      // `WorkflowRunner.decideFinalMerge`はhaltedByUserしか見ておらず、呼び出し元の
      // モードまでは区別しない（MCP経由=`orchestrator`専用・Webview経由=`confirm`専用、と
      // 要件が逆向きのため、合流点である本体には置けない）。`workflowScript.ts`側で
      // ボタンの表示を`confirm`のときだけに絞っているが、それはUIの見た目でしかなく、
      // 受信側であるここが素通しだと、webviewの再読み込みで古い状態が残った場合や、
      // 将来この画面へ外部由来の内容を描くようになった場合に、`orchestrator`モードの
      // 判断を人の操作として確定させられてしまう（レビュー指摘）。ここで`mode`を
      // 確かめてから呼ぶ
      if (this.runner.getSnapshot(runId)?.finalMergeDecision?.mode === 'confirm') {
        this.runner.decideFinalMerge(runId, m['decision'], m['reason']);
      }
      return;
    }
    if (type === 'answerAskUser' && typeof m['choiceIndex'] === 'number') {
      // design.md §16.33。Webviewは信頼境界の外側なので、回答待ちが実際に存在するかは
      // `WorkflowRunner.answerAskUser`側（`runnerOrchestrator.ts`の`answerAskUser`）が
      // 都度確かめる。ここでは型だけ絞って渡す
      this.runner.answerAskUser(runId, m['choiceIndex']);
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
    if (type === 'continueTask') {
      // 回数切れで止まったタスクを同じ会話のまま続ける（design.md §16.8、issue #284）。
      // 対象外のタスクや存在しないidに対しては`runner.ts`側が何もせず`false`を返す。
      // `allow`の確認を挟まないのはセッションが生きている場合しか成立しない操作だから
      // （そのセッションを起動した時点で確認済み。`WorkflowRunner.continueTask`に理由を書いた）
      this.runner.continueTask(runId, taskId);
      return;
    }
    if (type === 'retryMerge') {
      // design.md §16.17「Viewから人が解決したうえで『再マージ』を指示できる」（Issue #104）。
      // `blocked`以外のタスクや存在しないidに対しては`runner.ts`側が何もせず`false`を
      // 返すだけなので、ここでは呼び出すだけでよい
      this.runner.retryMerge(runId, taskId);
      return;
    }
    if (type === 'openTaskPullRequest') {
      // openIntegrationPullRequestと同じく、Webviewからは値を受け取らずtaskIdだけで
      // runner.tsへ問い合わせる
      const snapshot = this.runner.getSnapshot(runId);
      const task = snapshot?.tasks.find((t) => t.id === taskId);
      await this.openPullRequestUrl(task?.pullRequestUrl);
      return;
    }
    if (type === 'approve' && isApprovalDecision(m['decision'])) {
      this.runner.decideApproval(runId, taskId, m['decision']);
    }
  }

  /**
   * PR/MRのURLを開く（design.md §16.8「そのほか」・§16.18、Issue #118）。`gh`/`glab`が
   * 返したURLをそのまま`workspaceState`経由で持ち回っており、ホスト側の出力を全面的には
   * 信用しない。**`https://`以外のスキームは開かない**（タスク指示「URLを開く導線では、
   * `https://`以外のスキームを開かないこと（ホストのCLIが返す値をそのまま信用しない）」）。
   */
  private async openPullRequestUrl(url: string | undefined): Promise<void> {
    if (url === undefined || !url.startsWith('https://')) {
      return;
    }
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url, true));
    } catch (e) {
      this.log.error(`PR/MRのURLを開けません: ${e instanceof Error ? e.message : String(e)}`);
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
      <button id="openIntegrationPrBtn" type="button" class="secondary" disabled>統合ブランチのPR/MRを開く</button>
      <button id="cleanupIntegrationBtn" type="button" class="danger">統合ブランチと残ったworktreeをまとめて片付ける</button>
    </div>
    <div id="progressBar"><div class="fill" id="progressFill"></div></div>
    <div id="progressPercent"></div>
    <div id="banner" hidden></div>
    <div id="orchestrator" hidden>
      <div class="orch-head">
        <span class="orch-title">オーケストレーター</span>
        <span id="orchStatus" class="orch-status"></span>
        <span id="orchUnread" class="orch-unread" hidden></span>
      </div>
      <div id="orchSummary" class="orch-summary"></div>
      <div class="orch-input">
        <input id="orchInput" type="text" placeholder="run全体への指示や質問を1行で送る">
        <button id="orchSendBtn" type="button">送る</button>
        <button id="orchOpenBtn" type="button" class="secondary">会話を開く</button>
      </div>
      <div id="orchAskUser" class="orch-ask-user" hidden></div>
    </div>
  </div>

  <div id="content" hidden>
    <div class="section-head">
      <h2>依存グラフ</h2>
      <div class="graph-tools">
        <span id="graphWrapNote" class="hint" hidden>幅に合わせて折り返し表示</span>
        <button id="graphZoomOutBtn" type="button" class="secondary" title="縮小">−</button>
        <span id="graphZoomLabel" class="zoom-label"></span>
        <button id="graphZoomInBtn" type="button" class="secondary" title="拡大">＋</button>
        <button id="graphZoomFitBtn" type="button" class="secondary" title="幅に合わせて全体を表示">全体表示</button>
      </div>
    </div>
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

    <div id="integrationSection" hidden>
      <h2>統合の状況</h2>
      <div id="integrationInfo"></div>
    </div>

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
    expandedContinuePrompt: undefined,
    lastSentPrompt: undefined,
    mergeResolutionActive: false,
    mergeResolutionWaitingApproval: false,
    pullRequestNumber: undefined,
    pullRequestUrl: undefined,
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
