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
import {
  createWorkflowFeed,
  type WorkflowChange,
  type WorkflowFeed,
  type WorkflowFeedProgramPort,
} from '../orchestrator/workflowFeed';
import {
  parseRoadmapMarkdown,
  reconcileRoadmapIssues,
  type RoadmapIssueSummary,
} from '../orchestrator/roadmap';
import type { WorkflowDefinition } from '../orchestrator/workflow';
import { chatCsp } from './chatCsp';
import {
  aggregateProgress,
  kanbanBucket,
  progressSegments,
  layoutGraph,
  summarizeIntegration,
  summarizeKanban,
  taskRoleLabel,
  formatTaskContext,
  type GraphLayout,
  type IntegrationSummary,
  type KanbanBucket,
  type KanbanSummary,
  type ProgressSegment,
  type ProgressSummary,
} from './workflowGraph';
import type { VerificationStore } from '../verification/store';
import {
  loadTaskCompletionEvidence,
  type CompletionEvidenceView,
} from '../verification/completionEvidence';
import { workflowScript } from './workflowScript';
import { workflowStyles } from './workflowStyles';
import { buildTaskWorkSummary } from '../orchestrator/taskSummary';

/**
 * ワークフローViewから、失敗の伝播・人による停止の状態が読める最小限の口
 * （design.md §16.37.3、roadmap W12-3、Issue #606の受入基準「失敗・停止の状態が
 * ワークフローViewから読める」）。`WorkflowViewManager`は`ProgramRunner`本体には
 * 依存せず、必要な操作（一覧・停止）だけをこの口として注入で受け取る
 * （`WorkflowRunner`を直接持たず`WorkflowRunner`型として受け取っているのと近い方針だが、
 * こちらは`ProgramRunner`が持つ操作のうちビューに要る分だけを切り出した専用の口にした。
 * `ProgramRunner`自体を丸ごと持たせると、ビューが実行の起動判断まで呼べてしまい、
 * 「どのrunをいつ起動するか」の判断はプログラム層に閉じるという既存の役割分担
 * （design.md §16.37.2「上位のオーケストレーターは置かない」）を崩しかねないため）。
 *
 * **省略可能。** コンストラクタでこの口を渡さない場合（既存のテスト・W12-2までの
 * `extension.ts`の配線）は、プログラムに関する表示・操作を一切行わない
 * （feedのスナップショットの`programs`が常に空になる）。既存の単発run実行の挙動には
 * 一切影響しない（受入基準「既存の単発runの挙動が変わらない」）。
 *
 * 実体は`workflowFeed.ts`の`WorkflowFeedProgramPort`（Issue #1272でfeed側へ移した。
 * Viewはこの口を直接使わず、feed越しに読む）。`extension.ts`が渡す形は変わらない。
 */
export type ProgramViewPort = WorkflowFeedProgramPort;

/**
 * ワークフローViewのロードマップ欄（Issue #1257）が使う口。**省略可能**で、渡さなければ
 * ロードマップ欄を一切出さない（`ProgramViewPort`と同じ方針）。
 *
 * ファイルの読み取りとCLIの実行という副作用をここへ閉じ込め、`WorkflowViewManager`側は
 * 受け取った文字列とIssue一覧を組み立てるだけにする（テストで差し替えられる）。
 */
export interface RoadmapViewPort {
  /**
   * ワークスペース相対のロードマップMarkdownを読む。**実装はワークスペースフォルダ配下に
   * 収まっていることを確かめてから読むこと**（`extension.ts`の実装参照）。読めなければ
   * `undefined`。
   */
  readRoadmap(relativePath: string): Promise<string | undefined>;
  /** Issue一覧（クローズ済みを含む）。取れなければ`undefined`（「取れなければ飛ばす」）。 */
  listIssues(): Promise<readonly RoadmapIssueSummary[] | undefined>;
  /** 一覧の上限外にあるIssueを番号で照会する。省略時は一覧の結果だけを使う。 */
  getIssueUrl?(issue: number): Promise<string | undefined>;
}

/**
 * `feed`メッセージの`state`（表示中のrun、または下書きプレビュー）の中身。
 *
 * 段レイアウトと各種の集計は拡張機能側の純粋関数（`workflowGraph.ts`）で済ませて
 * 同送する。Webview側はこれらを再計算しない（design.md §16.8、Issue #104の再発防止）。
 */
interface WorkflowStateMessage {
  /** 表示用に`roleLabel` / `kanbanBucket` / `contextLabel`を足したタスクを持つスナップショット。 */
  snapshot: Omit<WorkflowRunSnapshot, 'tasks'> & {
    tasks: readonly (TaskSnapshot & {
      roleLabel: string | undefined;
      kanbanBucket: KanbanBucket;
      contextLabel: string;
    })[];
  };
  layout: GraphLayout;
  progress: ProgressSummary;
  progressSegments: readonly ProgressSegment[];
  kanban: KanbanSummary;
  integration: IntegrationSummary | undefined;
}

/**
 * Issue一覧の再取得を抑える時間（ミリ秒）。パネルを開くたび・状態が変わるたびに
 * `gh`/`glab`を起動すると実行中のrunの更新のたびにプロセスが増えるため、この時間内は
 * 直近の結果を使い回す。人が「更新」を押したときはこの窓を無視して取り直す。
 */
const ROADMAP_ISSUE_CACHE_MS = 60_000;

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
  /**
   * 直近に取れたIssue一覧と、その取得時刻（Issue #1257）。`ROADMAP_ISSUE_CACHE_MS`の間は
   * これを使い回す。`issues`が`undefined`（取得に失敗した）でもキャッシュする——失敗も
   * 同じ頻度で繰り返し試すと、CLI未導入の環境で毎回プロセスを起こすことになるため。
   */
  private roadmapIssueCache:
    { at: number; issues: readonly RoadmapIssueSummary[] | undefined } | undefined;
  /**
   * ロードマップ欄の更新の世代（Issue #1257）。CLIの結果は遅れて届くため、その間に別の
   * runへ切り替わった・更新が再度走った場合に、古い結果で上書きしないための番号。
   */
  private roadmapRequestSeq = 0;
  private readonly unsubscribeChanged: () => void;
  /** 実行中の完了根拠の導出（Issue #1380）。`refreshCompletionEvidence` のJSDoc参照 */
  private evidenceRefresh: Promise<void> | undefined;
  private evidenceRefreshQueued = false;
  /**
   * 単発runとプログラムの変化・状態を1本にまとめた口（Issue #1272）。Viewが購読する
   * イベントも、読むスナップショットもこれ1つだけにする（`workflowFeed.ts`のJSDoc参照）。
   */
  private readonly feed: WorkflowFeed;

  constructor(
    private readonly runner: WorkflowRunner,
    private readonly log: Logger,
    /**
     * プログラムの一覧・停止・変化通知（design.md §16.37.3、roadmap W12-3、Issue #606）。
     * 省略可能（`ProgramViewPort`のJSDoc参照）。`extension.ts`が`ProgramStore`/
     * `ProgramRunner`から組み立てて渡す。
     */
    programs?: ProgramViewPort,
    /**
     * ロードマップ欄（Issue #1257）。省略可能（`RoadmapViewPort`のJSDoc参照）。
     */
    private readonly roadmap?: RoadmapViewPort,
    /**
     * 検証記録の読出口（Issue #1380）。完了根拠の列に使う。省略時は列を「—」のままにする。
     * `extension.ts` が作る唯一の `VerificationStore` を渡す。
     */
    private readonly verificationStore?: Pick<VerificationStore, 'list'>,
  ) {
    this.feed = createWorkflowFeed({ runner, ...(programs === undefined ? {} : { programs }) });
    this.unsubscribeChanged = this.feed.onChanged((change) => this.onFeedChanged(change));
  }

  dispose(): void {
    this.unsubscribeChanged();
    this.feed.dispose();
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

  /**
   * feed（`workflowFeed.ts`）からの唯一の変化通知。単発runの変化もプログラムの変化も
   * ここへ届く（Issue #1272）。
   *
   * 何が変わったかで送る内容を変えない——run一覧・プログラム欄・表示中のrunは全て
   * `feed.getSnapshot()`**1回の結果**から作るため、常に同じ時点の状態がそろって届く。
   * 以前は`runner.onChanged`でrun側だけ、`programs.onChanged`でプログラム側だけを
   * 更新しており、片方だけ新しい状態を描く余地が残っていた。
   *
   * 発火の順序（`ProgramRunner`が永続化を終えてから`kind: 'program'`が流れる）は
   * feedを挟んでも変わらない（`workflowFeed.ts`のJSDoc参照）。
   */
  private onFeedChanged(change: WorkflowChange): void {
    // ロードマップ欄だけは取り直さない場合がある。ファイルの読み取りとCLIの起動
    // （`gh`/`glab`）を伴うため、表示中のrunに関係しない変化——別runの進行や
    // プログラム側の更新——のたびに走らせると、実行中はタスクの状態が変わるたびに
    // プロセスが増える。統合前の`onRunnerChanged`も、表示中のrunの変化でなければ
    // `postState`（その中の`postRoadmap`）を呼んでいなかった
    const affectsActiveRun = change.kind !== 'run' || change.runId === this.activeRunId;
    this.postAll({ refreshRoadmap: affectsActiveRun });
  }

  /**
   * その時点の全状態（run一覧・プログラム一覧・表示中のrun）を1通のメッセージで送る。
   *
   * 段レイアウト・進捗の集計はここで計算して同送する（`layoutGraph`等は純粋関数。
   * Webview側では再計算しない）。差分計算はしていない（design.mdの「送るのは差分のみ」を
   * 「状態が変わっていないのに送らない」という意味で解釈している。runIdあたり最大
   * 50タスクという上限があるため、スナップショット全体を送っても軽い）。
   */
  private postAll(options: { refreshRoadmap?: boolean } = {}): void {
    if (this.panel === undefined) {
      return;
    }
    const feed = this.feed.getSnapshot(this.activeRunId);
    // 下書きプレビュー（`previewSnapshot`）は`WorkflowRunner`に登録しないためfeedには
    // 現れない。表示中のrunが無いときだけ、その代わりに出す
    const isPreview = feed.activeRun === undefined && this.previewSnapshot !== undefined;
    const snapshot = feed.activeRun ?? (isPreview ? this.previewSnapshot : undefined);
    if (snapshot !== undefined) {
      this.panel.title =
        (snapshot.name === '' ? 'ワークフロー' : snapshot.name) +
        (isPreview ? '（下書き・未実行）' : '');
    }
    void this.panel.webview.postMessage({
      type: 'feed',
      runs: feed.runs,
      programs: feed.programs,
      state: snapshot === undefined ? undefined : this.buildStateMessage(snapshot),
    });
    if (options.refreshRoadmap !== false) {
      void this.postRoadmap(snapshot?.roadmapPath);
    }
    this.refreshCompletionEvidence();
  }

  /**
   * 完了根拠（Issue #1380）を導き直して送る。gitの起動と記録の読出を伴うため、実行中に
   * 呼ばれたら終わってから1回だけやり直す（状態が変わるたびに重ねて走らせない）。
   */
  private refreshCompletionEvidence(): void {
    if (this.verificationStore === undefined) {
      return;
    }
    if (this.evidenceRefresh !== undefined) {
      this.evidenceRefreshQueued = true;
      return;
    }
    this.evidenceRefresh = this.postCompletionEvidence().finally(() => {
      this.evidenceRefresh = undefined;
      if (this.evidenceRefreshQueued) {
        this.evidenceRefreshQueued = false;
        this.refreshCompletionEvidence();
      }
    });
  }

  private async postCompletionEvidence(): Promise<void> {
    const store = this.verificationStore;
    if (this.panel === undefined || store === undefined) {
      return;
    }
    const snapshot = this.feed.getSnapshot(this.activeRunId).activeRun;
    if (snapshot === undefined) {
      return;
    }
    // 完了（done）したタスクだけを対象にする。途中のタスクの区分は完了根拠ではない
    const tasks = snapshot.tasks
      .filter((task) => task.state === 'done')
      .map((task) => ({ id: task.id, cwd: task.cwd }));
    let evidence: Record<string, CompletionEvidenceView>;
    try {
      evidence = await loadTaskCompletionEvidence(store, snapshot.runId, tasks);
    } catch (e) {
      this.log.warn(
        `[workflowView] 完了根拠を読めません: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (this.panel === undefined) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'completionEvidence',
      runId: snapshot.runId,
      tasks: evidence,
    });
  }

  private buildStateMessage(snapshot: WorkflowRunSnapshot): WorkflowStateMessage {
    const layout = layoutGraph(snapshot.tasks, { maxWidth: this.graphViewportWidth });
    // 進捗の内訳・統合の状況の集計は`workflowGraph.ts`の純粋関数（テスト済み）で行い、
    // Webview側では受け取った結果を表示するだけにする（design.md §16.8「全体の進捗」・
    // 「そのほか」・Issue #104。以前はWebview内のJavaScriptで独自に集計しており、
    // `merging`/`blocked`/`waitingReply`の3状態がここでの追随漏れの原因になっていた）
    const progress = aggregateProgress(snapshot.tasks);
    // カンバン風の3バケット + 要対応枠の集計（design.md §16.44、Issue #693）。progressと同じく
    // 純粋関数（workflowGraph.ts、テスト済み）で集計し、Webview側では受け取った結果を
    // 表示するだけにする（aggregateProgressのコメントと同じ理由。Issue #104の再発防止）
    const kanban = summarizeKanban(snapshot.tasks);
    const integration = summarizeIntegration(snapshot.integrationBranch, snapshot.tasks, {
      number: snapshot.integrationPullRequestNumber,
      url: snapshot.integrationPullRequestUrl,
      finalMergeOutcome: snapshot.finalMergeOutcome,
      finalMergeDecision: snapshot.finalMergeDecision,
    });
    // 役割ラベル（design.md §16.44、Issue #693）。`TaskSnapshot.role`（runner.ts）は
    // 定義ファイルの解決結果（`WorkflowTask.role`）を`buildTaskSnapshot`が都度写したもので、
    // 実行中のrunでも下書きのプレビューでも同じように入る。役割が無いタスクは
    // `taskRoleLabel`が`undefined`を返し、Webview側は何も表示しない
    const tasksWithRoleLabel = snapshot.tasks.map((t) => ({
      ...t,
      roleLabel: taskRoleLabel(t.role),
      // カンバンのバッジから該当タスクを絞り込む（issue #752）ための分類。Webview側で
      // 状態を振り分け直すと、状態が増えたときにここだけ追随漏れになる（Issue #104）
      kanbanBucket: kanbanBucket(t.state),
      // コンテキスト残量・累計トークン数の表示文字列（Issue #1272）。組み立てはここ
      // （純粋関数、テスト済み）で済ませ、Webview側は受け取った文字列を出すだけにする
      // （役割ラベル・進捗の集計と同じ方針。Issue #104の再発防止）
      contextLabel: formatTaskContext(t),
    }));
    return {
      snapshot: { ...snapshot, tasks: tasksWithRoleLabel },
      layout,
      progress,
      // 全体進捗バーの積み上げ（issue #754）。集計はここ（純粋関数）で済ませ、
      // Webview側は受け取った幅を当てるだけにする（Issue #104の再発防止と同じ方針）
      progressSegments: progressSegments(progress),
      kanban,
      integration,
    };
  }

  /**
   * ロードマップ欄を送る（Issue #1257）。二段構えで送る。
   *
   * 1. ロードマップMarkdownを読んでパースした結果（Issueの状態は`unknown`）
   * 2. Issue一覧が取れてから、突き合わせた結果で上書き
   *
   * こうするのは、`gh`/`glab`の起動を待つ間ロードマップ本体すら出ないのを避けるため。
   * 一覧が取れない環境（CLI未導入・未認証・remoteが無い）では2段目でも`unknown`のままで、
   * ロードマップ本体は読める。
   *
   * `roadmap`（`RoadmapViewPort`）が未注入、または定義が`roadmap`を持たない場合は、
   * 欄を隠す指示（`roadmap: undefined`）だけを送る。
   */
  private async postRoadmap(relativePath: string | undefined, forceRefresh = false): Promise<void> {
    if (this.panel === undefined) {
      return;
    }
    const seq = ++this.roadmapRequestSeq;
    if (this.roadmap === undefined || relativePath === undefined) {
      void this.panel.webview.postMessage({ type: 'roadmap', roadmap: undefined });
      return;
    }

    let markdown: string | undefined;
    try {
      markdown = await this.roadmap.readRoadmap(relativePath);
    } catch (e) {
      this.log.warn(
        `[workflowView] ロードマップを読めません: ${e instanceof Error ? e.message : String(e)}`,
      );
      markdown = undefined;
    }
    if (seq !== this.roadmapRequestSeq || this.panel === undefined) {
      return;
    }
    if (markdown === undefined) {
      void this.panel.webview.postMessage({
        type: 'roadmap',
        roadmap: undefined,
        path: relativePath,
        error: 'ロードマップのファイルを読めませんでした。',
      });
      return;
    }

    const parsed = parseRoadmapMarkdown(markdown);
    void this.panel.webview.postMessage({
      type: 'roadmap',
      path: relativePath,
      roadmap: reconcileRoadmapIssues(parsed, undefined),
      pending: true,
    });

    const issues = await this.listRoadmapIssues(forceRefresh);
    if (seq !== this.roadmapRequestSeq || this.panel === undefined) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'roadmap',
      path: relativePath,
      roadmap: reconcileRoadmapIssues(parsed, issues),
      pending: false,
    });
  }

  /** Issue一覧をキャッシュ越しに取る（Issue #1257）。取れなければ`undefined`。 */
  private async listRoadmapIssues(
    forceRefresh: boolean,
  ): Promise<readonly RoadmapIssueSummary[] | undefined> {
    if (this.roadmap === undefined) {
      return undefined;
    }
    const cached = this.roadmapIssueCache;
    if (!forceRefresh && cached !== undefined && Date.now() - cached.at < ROADMAP_ISSUE_CACHE_MS) {
      return cached.issues;
    }
    let issues: readonly RoadmapIssueSummary[] | undefined;
    try {
      issues = await this.roadmap.listIssues();
    } catch (e) {
      this.log.warn(
        `[workflowView] Issue一覧を取れません: ${e instanceof Error ? e.message : String(e)}`,
      );
      issues = undefined;
    }
    if (issues === undefined && cached?.issues !== undefined) {
      // 一時的な失敗（CLIのタイムアウト・ネットワーク瞬断）で、直前まで出せていた
      // Issueの状態を一斉に「照合できません」へ後退させない（自己レビュー指摘: medium）。
      // 取得時刻だけ更新して、次の再取得までの間隔は保つ
      this.roadmapIssueCache = { at: Date.now(), issues: cached.issues };
      return cached.issues;
    }
    this.roadmapIssueCache = { at: Date.now(), issues };
    return issues;
  }

  /** 表示中のrun（または下書きプレビュー）のロードマップのパス。 */
  private activeRoadmapPath(): string | undefined {
    if (this.activeRunId === undefined) {
      return this.previewSnapshot?.roadmapPath;
    }
    return this.runner.getSnapshot(this.activeRunId)?.roadmapPath;
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
        this.postAll();
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
    if (type === 'stopProgram' && typeof m['programId'] === 'string') {
      // `activeRunId`の有無を問わない（プログラムのpendingなrun参照はそもそも
      // `WorkflowRunner`側のrunIdを持たない。design.md §16.37.3、roadmap W12-3、
      // Issue #606）。`programs`（`ProgramViewPort`）が未注入なら何もしない
      await this.feed.haltProgram(m['programId']);
      this.postAll();
      return;
    }

    if (type === 'refreshCompletionEvidence') {
      this.refreshCompletionEvidence();
      return;
    }
    if (type === 'roadmapRefresh') {
      // 人が押したときはキャッシュの窓を無視して取り直す（Issue #1257）。下書きプレビューでも
      // 効かせたいので、`activeRunId`の有無を問わないこの位置に置く
      await this.postRoadmap(this.activeRoadmapPath(), true);
      return;
    }
    if (
      (type === 'openRoadmapIssue' || type === 'openTaskIssue') &&
      typeof m['issue'] === 'number' &&
      Number.isSafeInteger(m['issue']) &&
      m['issue'] > 0
    ) {
      // WebviewからはIssue番号だけを受け取り、URLは拡張機能側が持つ一覧から引く
      // （`openTaskPullRequest`と同じ方針。Webviewから渡されたURLは開かない）
      const issues = await this.listRoadmapIssues(false);
      const issue = issues?.find((i) => i.number === m['issue']);
      const url = issue?.url ?? (await this.roadmap?.getIssueUrl?.(m['issue']));
      await this.openIssueUrl(url);
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
   * ロードマップ欄からIssueのページを開く（Issue #1257）。`openPullRequestUrl`と同じく、
   * ホストのCLIが返した値をそのまま信用せず**`https://`以外のスキームは開かない**。
   */
  private async openIssueUrl(url: string | undefined): Promise<void> {
    if (url === undefined || !url.startsWith('https://')) {
      return;
    }
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url, true));
    } catch (e) {
      this.log.error(`IssueのURLを開けません: ${e instanceof Error ? e.message : String(e)}`);
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
    <div id="progressBar" role="img"><div class="fill seg-done" id="segDone" hidden></div><div class="fill seg-active" id="segActive" hidden></div><div class="fill seg-attention" id="segAttention" hidden></div></div>
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

  <div id="programsSection" hidden>
    <h2>プログラム</h2>
    <div id="programs"></div>
  </div>

  <div id="content" hidden>
    <div id="kanbanBadges" class="kanban-badges" hidden>
      <div id="kanbanBadgeGroup" class="kanban-badge-group" role="group" aria-label="状態で強調表示"></div>
      <div id="kanbanHighlightStatus" class="kanban-highlight-status" hidden>
        <span id="kanbanHighlightText"></span>
        <button id="kanbanHighlightClearBtn" type="button" class="secondary">強調を解除</button>
      </div>
      <!-- 通知は可視の欄と分ける（issue #1037）。解除すると可視の欄は hidden になり、
           hidden の要素は読み上げられないため、解除・自動解除を伝えられない -->
      <div id="kanbanHighlightLive" class="sr-only" aria-live="polite"></div>
    </div>
    <section id="qualitySection" hidden>
      <div class="quality-head">
        <h2>計画・品質契約</h2>
        <span id="qualityPhase" class="quality-phase"></span>
      </div>
      <div id="qualityContract" class="quality-contract"></div>
    </section>
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
    <!-- 拡大中に全体のどこを見ているかを示す帯（issue #753）。全体表示のときは隠す -->
    <div id="graphViewport" hidden><div id="graphViewportWindow"></div></div>
    <div id="graphWrap">
      <svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg>
    </div>

    <h2>タスク一覧</h2>
    <div id="taskTableWrap" tabindex="0" aria-label="タスク一覧。横にスクロールできます">
      <table id="taskTable">
        <thead>
          <tr>
            <th>id</th><th>役割</th><th>作業内容要約</th><th>状態</th><th>検証</th><th>完了根拠</th>
            <th>Issue</th><th>cleanup</th><th>provider</th><th>model / effort</th><th>コンテキスト</th><th>経過</th><th>送信回数</th><th>操作</th>
          </tr>
        </thead>
        <tbody id="taskTableBody"></tbody>
      </table>
    </div>

    <section id="roadmapSection" hidden>
      <div class="section-head">
        <h2>ロードマップ</h2>
        <div class="roadmap-tools">
          <span id="roadmapPath" class="hint"></span>
          <span id="roadmapStatus" class="hint"></span>
          <button id="roadmapRefreshBtn" type="button" class="secondary">Issueの状態を更新</button>
        </div>
      </div>
      <div id="roadmapBody"></div>
    </section>

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
    ...(task.issue === undefined ? {} : { issue: task.issue }),
    cleanupStatus: 'notStarted',
    workSummary: buildTaskWorkSummary(task.prompt),
    contract: {
      ...(task.outcome === undefined ? {} : { outcome: task.outcome }),
      evidence: task.evidence ?? [],
      outputs: task.outputs ?? [],
      risks: task.risks ?? [],
    },
    verification: {
      status: task.verify === undefined ? 'notConfigured' : 'pending',
      attempts: 0,
    },
    role: task.role,
    model: task.model,
    effort: task.effort,
    dependsOn: task.dependsOn,
    provider: task.provider,
    state: 'pending' as const,
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
    // 下書きはまだセッションを開いていないので、コンテキストの使用量は取れない
    context: undefined,
    sessionTokens: undefined,
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
    quality: {
      phase:
        def.reviewStatus === 'reviewing'
          ? 'reviewing'
          : def.reviewStatus === 'ready'
            ? 'ready'
            : 'planning',
      ...(def.goal === undefined ? {} : { goal: def.goal }),
      acceptance: def.acceptance ?? [],
      assumptions: def.assumptions ?? [],
      nonGoals: def.nonGoals ?? [],
      ...(def.roadmapRevision === undefined ? {} : { roadmapRevision: def.roadmapRevision }),
      ...(def.reviewStatus === undefined ? {} : { reviewStatus: def.reviewStatus }),
      ...(def.plannerPromptVersion === undefined
        ? {}
        : { plannerPromptVersion: def.plannerPromptVersion }),
      ...(def.plannerProvider === undefined ? {} : { plannerProvider: def.plannerProvider }),
      ...(def.plannerModel === undefined ? {} : { plannerModel: def.plannerModel }),
      ...(def.reviewRevision === undefined ? {} : { reviewRevision: def.reviewRevision }),
      ...(def.reviewFindingCount === undefined
        ? {}
        : { reviewFindingCount: def.reviewFindingCount }),
      ...(def.reviewFindingsResolved === undefined
        ? {}
        : { reviewFindingsResolved: def.reviewFindingsResolved }),
      taskModels: [
        ...new Set(def.tasks.map((task) => task.model).filter((v): v is string => v !== undefined)),
      ],
    },
    haltedByUser: false,
    isDraft: true,
    // 下書きプレビューでもロードマップ欄を出す（Issue #1257）。生成直後の定義でも、
    // 元にしたロードマップの項目とIssueの状態は読めたほうがよい
    roadmapPath: def.roadmap,
  };
}
