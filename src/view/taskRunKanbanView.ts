import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import { MAX_USER_ANSWER_LENGTH, parseUserAnswer } from '../orchestrator/roadmapQuestionMcp';
import type { TaskRunController } from '../orchestrator/taskRunController';
import type { TaskRunOrchestratorStatus } from '../orchestrator/taskRunOrchestrator';
import { isTaskRunActive, isValidTaskId, taskRunLabel, validateTaskRunTitleInput } from '../orchestrator/taskRunState';
import { TASK_LEASE_HEARTBEAT_MS } from '../orchestrator/taskRunLease';
import { trackChatPanel } from './backgroundPanelTabs';
import { chatCsp } from './chatCsp';
import { GRAPH_SVG_SOURCE } from './graphSvgScript';
import { KANBAN_CYBER_BASE_STYLES } from './kanbanCyberStyles';
import { skinBodyClass } from './skin';
import { layoutTaskRunGraph, TASK_RUN_KANBAN_COLUMNS, type TaskRunKanbanCard } from './taskRunKanbanModel';

/** 盤面を送る間隔。最初はすぐ送り以降はまとめる。 */
const POST_INTERVAL_MS = 250;

/** Kanbanから使うOrchestratorの口。 */
export interface TaskRunKanbanOrchestratorPort {
  open(runId: string, renew: boolean): Promise<boolean>;
  status(runId: string): TaskRunOrchestratorStatus;
  /** Kanbanから人が直接送った指示をOrchestratorへイベントとして知らせる（Issue #1627）。 */
  notifyTaskInstructed(runId: string, taskId: string, instruction: string): void;
}

export interface TaskRunKanbanViewDeps {
  controller: TaskRunController;
  orchestrator: TaskRunKanbanOrchestratorPort;
  /** 工程セッションのタブを前面へ出す。開いていなければ`false`。 */
  revealStage(runId: string, taskId: string): boolean;
  /** runを終える。工程セッションとOrchestratorを止めてから`finishedAt`を立てる（Issue #1558）。 */
  finishRun(runId: string): Promise<{ ok: boolean; message: string }>;
  /** runを中断する。工程セッションとOrchestratorを止めてから中断を立てる（Issue #1560）。 */
  suspendRun(runId: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 中断したrunを再開し、Orchestratorを新しい世代で開く（Issue #1560）。`parallel`なら同じフォルダで
   * 動いているrunと並行して再開する（Issue #1562）。
   */
  resumeRun(runId: string, options?: { parallel?: boolean }): Promise<{ ok: boolean; message: string }>;
  log: Logger;
}

/**
 * オーケストレータモード（Issue #1505）のKanban。タスクを工程別の列に並べ、計画の承認、
 * 並列上限、run全体の一時停止と再開、工程の停止・やり直し、質問への回答、関門の決着を受け付ける。
 *
 * 盤面の組み立ては`taskRunKanbanModel.ts`、操作の判断は`TaskRunController`が持つ。
 * webviewは信頼境界の外側として扱い、届いた値は形を確かめてから使う。
 */
export class TaskRunKanbanViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.taskRunKanban';
  private panel: vscode.WebviewPanel | undefined;
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  /** 専有権（Issue #1628）の表示を追従させる定期の再描画。ロック解放後の書き換えはKanbanに来ないため必要。 */
  private leasePollTimer: ReturnType<typeof setInterval> | undefined;
  /** `post`の連番。専有権の読み取りを待つ間に始まった後の`post`を優先する。 */
  private postSeq = 0;
  private lastPostAt = 0;
  private selectedRunId: string | undefined;
  /** グラフ表示の描画領域の幅（`layoutGraph`の`maxWidth`）。webviewの`viewport`で受け取る。 */
  private graphViewportWidth: number | undefined;

  constructor(private readonly deps: TaskRunKanbanViewDeps) {}

  show(runId?: string): void {
    if (runId !== undefined) {
      this.selectedRunId = runId;
    }
    if (this.panel === undefined) {
      this.attach(
        vscode.window.createWebviewPanel(
          TaskRunKanbanViewManager.viewType,
          'オーケストレータモード',
          // 左の列にKanban、右の列にOrchestratorのチャットタブを並べる
          vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
        ),
      );
      return;
    }
    this.panel.reveal();
    this.schedulePost();
  }

  /**
   * ウィンドウを開き直したときにVSCodeが復元したKanbanのタブを引き取る（Issue #1775）。
   * 見ていたrunはwebviewの状態（`saveViewState`）から戻す。既にKanbanを開いていれば、
   * 同じ盤面が2枚にならないよう復元した方を閉じる。
   */
  restorePanel(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.panel !== undefined) {
      panel.dispose();
      return;
    }
    if (this.selectedRunId === undefined && isRecord(state) && typeof state.runId === 'string') {
      this.selectedRunId = state.runId;
    }
    // 復元したパネルは生成時のオプションを持たないため、webviewのオプションだけ入れ直す
    panel.webview.options = { enableScripts: true };
    this.attach(panel);
  }

  /** パネルへイベントを配線し、盤面のHTMLを入れる。初回の盤面はwebviewからの`ready`に対して送る。 */
  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    // 1列で見ているとき、同じ列へ背面で開く子タブがKanbanを隠さないよう表示し直させる（Issue #1774）
    trackChatPanel(panel);
    panel.onDidDispose(() => {
      this.clearTimer();
      this.clearLeasePollTimer();
      this.dirty = false;
      this.panel = undefined;
    });
    this.leasePollTimer = setInterval(() => this.refresh(), TASK_LEASE_HEARTBEAT_MS);
    panel.onDidChangeViewState(() => {
      if (this.panel?.visible === true && this.dirty) {
        this.schedulePost();
      }
    });
    panel.webview.html = render(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
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
    this.clearLeasePollTimer();
    this.panel?.dispose();
  }

  private schedulePost(): void {
    if (this.postTimer !== undefined) {
      return;
    }
    const since = Date.now() - this.lastPostAt;
    if (since >= POST_INTERVAL_MS) {
      void this.post();
      return;
    }
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      void this.post();
    }, POST_INTERVAL_MS - since);
  }

  private clearTimer(): void {
    if (this.postTimer !== undefined) {
      clearTimeout(this.postTimer);
      this.postTimer = undefined;
    }
  }

  private clearLeasePollTimer(): void {
    if (this.leasePollTimer !== undefined) {
      clearInterval(this.leasePollTimer);
      this.leasePollTimer = undefined;
    }
  }

  private async post(): Promise<void> {
    if (this.panel === undefined) {
      return;
    }
    this.dirty = false;
    this.lastPostAt = Date.now();
    const board = this.deps.controller.board(this.selectedRunId, currentWorkspaceFolders());
    const orchestrator = board.run === undefined ? undefined : this.deps.orchestrator.status(board.run.runId);
    const graph = board.run === undefined ? undefined : layoutTaskRunGraph(board.run.columns, this.graphViewportWidth);
    // 専有権の状態（Issue #1628）。他ウィンドウが持っているときだけKanbanに読み取り専用の案内を出す
    const seq = ++this.postSeq;
    const lease = board.run === undefined ? undefined : await this.deps.controller.leaseStatus(board.run.runId);
    // 選択していないrunも、run一覧で別のウィンドウが持っていると分かるようにする（Issue #1641）。
    // 終わったrunは専有権を取らないため読まない。読むのは未終了のrunの数だけの小さなファイルで、
    // 未終了のrunは通常数件のため、`post`のたびに読み直す
    const others = board.runs.filter((r) => !r.finished && r.runId !== board.run?.runId);
    const statuses = await Promise.all(others.map((r) => this.deps.controller.leaseStatus(r.runId)));
    const heldElsewhere = others.filter((_, i) => statuses[i]?.heldByOther === true).map((r) => r.runId);
    const panel = this.panel;
    // 専有権を読む間に次の`post`が始まっていたら、古い盤面で上書きしないよう捨てる
    if (panel === undefined || seq !== this.postSeq) {
      return;
    }
    void panel.webview.postMessage({ type: 'board', board, orchestrator, graph, lease, heldElsewhere });
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'ready') {
      void this.post();
      return;
    }
    if (message.type === 'viewport') {
      const raw = message.width;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return;
      }
      const width = Math.min(20000, Math.max(0, Math.round(raw)));
      if (width !== this.graphViewportWidth) {
        this.graphViewportWidth = width;
        this.schedulePost();
      }
      return;
    }
    if (message.type === 'selectRun') {
      if (typeof message.runId === 'string') {
        this.selectRun(message.runId);
      }
      return;
    }
    const runId = message.runId;
    if (typeof runId !== 'string') {
      return;
    }
    void this.handle(runId, message).catch((e: unknown) => {
      this.deps.log.warn(`オーケストレータモード: 操作に失敗しました（${message.type as string}）: ${String(e)}`);
      void vscode.window.showErrorMessage('オーケストレータモード: 操作に失敗しました');
    });
  }

  private async handle(runId: string, message: Record<string, unknown>): Promise<void> {
    const controller = this.deps.controller;
    switch (message.type) {
      case 'approvePlan':
        warnIfRejected(await controller.approvePlan(runId));
        return;
      case 'syncRoadmap': {
        const result = await controller.syncRoadmap(runId);
        if (result.ok) {
          void vscode.window.showInformationMessage(`オーケストレータモード: ${result.message}`);
        } else {
          warnIfRejected(result);
        }
        return;
      }
      case 'setMaxParallel': {
        const maxParallel = message.maxParallel;
        if (typeof maxParallel !== 'number') {
          return;
        }
        warnIfRejected(await controller.setMaxParallel(runId, maxParallel));
        return;
      }
      case 'setHalted':
        if (typeof message.halted === 'boolean') {
          warnIfRejected(await controller.setHalted(runId, message.halted));
        }
        return;
      case 'openPullRequest':
        this.openPullRequest(message.url);
        return;
      case 'openOrchestrator':
        await this.openOrchestrator(runId, message.renew === true);
        return;
      case 'finishRun':
        await this.finishRun(runId);
        return;
      case 'suspendRun':
        await this.suspendRun(runId);
        return;
      case 'resumeRun':
        await this.resumeRun(runId);
        return;
      case 'renameRun':
        await this.renameRun(runId);
        return;
      case 'transferLease': {
        // 元のウィンドウは専有権を失ったことに気づくと、動いている工程を止める（Issue #1636）
        const choice = await vscode.window.showWarningMessage(
          '専有権をこのウィンドウへ移しますか？ 元のウィンドウで動いている工程は止まります。worktreeとブランチは残り、このウィンドウの「やり直す」で始め直せます。',
          { modal: true },
          '移す',
        );
        if (choice === '移す') {
          warnIfRejected(await controller.transferLease(runId));
        }
        return;
      }
    }
    const taskId = message.taskId;
    if (typeof taskId !== 'string' || !isValidTaskId(taskId)) {
      return;
    }
    switch (message.type) {
      case 'stopStage':
        await this.stopStage(runId, taskId);
        return;
      case 'retryStage':
        warnIfRejected(await controller.retryStage(runId, taskId));
        return;
      case 'answerQuestion':
        await this.answerQuestion(runId, taskId, message.questionId, message.answer);
        return;
      case 'instructTask':
        await this.instructTask(runId, taskId, message.instruction);
        return;
      case 'resolveGate':
        await this.resolveGate(runId, taskId, message.gateId, message.choice);
        return;
      case 'revealStage':
        if (!this.deps.revealStage(runId, taskId)) {
          void vscode.window.showInformationMessage(
            `${taskId}の工程セッションは開いていません（終わったか、再読み込みで閉じました）`,
          );
        }
        return;
    }
  }

  private async stopStage(runId: string, taskId: string): Promise<void> {
    const card = this.findCard(runId, taskId);
    if (card === undefined || !card.canStop) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${taskId}の工程を停止しますか？ worktreeとブランチは残り、後で「やり直す」で始め直せます。`,
      { modal: true },
      '停止する',
    );
    if (choice === '停止する') {
      warnIfRejected(await this.deps.controller.stopStage(runId, taskId));
    }
  }

  /** 質問への回答。回答待ちでなくなっていれば（既に回答済み・取り消し済み）知らせる。 */
  private async answerQuestion(runId: string, taskId: string, questionId: unknown, raw: unknown): Promise<void> {
    const answer = parseUserAnswer(raw);
    if (typeof questionId !== 'string' || answer === undefined) {
      void vscode.window.showWarningMessage(
        `オーケストレータモード: 回答は1〜${String(MAX_USER_ANSWER_LENGTH)}文字で入力してください`,
      );
      return;
    }
    const result = await this.deps.controller.answerQuestion(runId, taskId, questionId, answer);
    if (!result.ok) {
      void vscode.window.showInformationMessage(`${taskId}: ${result.message}`);
    }
  }

  /**
   * Kanbanの動作中工程カードから人が直接送る指示（Issue #1627）。`instruct_task`と同じ検証
   * （`parseUserAnswer`）と経路（`TaskRunController.instructTask`）を使う。届いたらOrchestrator
   * にもイベントとして知らせ、人の指示を知らずに重ねて指示を送らないようにする。
   */
  private async instructTask(runId: string, taskId: string, raw: unknown): Promise<void> {
    const instruction = parseUserAnswer(raw);
    if (instruction === undefined) {
      void vscode.window.showWarningMessage(
        `オーケストレータモード: 指示は1〜${String(MAX_USER_ANSWER_LENGTH)}文字で入力してください`,
      );
      return;
    }
    const result = await this.deps.controller.instructTask(runId, taskId, instruction);
    if (result.ok) {
      this.deps.orchestrator.notifyTaskInstructed(runId, taskId, instruction);
    } else {
      void vscode.window.showInformationMessage(`${taskId}: ${result.message}`);
    }
  }

  /** レビューの関門の決着（差し戻す・このまま進める）。失敗の関門は「やり直す」で決着させる。 */
  private async resolveGate(runId: string, taskId: string, gateId: unknown, choice: unknown): Promise<void> {
    if (typeof gateId !== 'string' || (choice !== 'sendBack' && choice !== 'proceed')) {
      return;
    }
    const result = await this.deps.controller.resolveGate(runId, taskId, gateId, choice);
    if (!result.ok) {
      void vscode.window.showInformationMessage(`${taskId}: ${result.message}`);
    }
  }

  private findCard(runId: string, taskId: string): TaskRunKanbanCard | undefined {
    const board = this.deps.controller.board(runId, currentWorkspaceFolders());
    if (board.run?.runId !== runId) {
      return undefined;
    }
    return TASK_RUN_KANBAN_COLUMNS.flatMap((col) => board.run?.columns[col] ?? []).find(
      (c) => c.taskId === taskId,
    );
  }

  private async openOrchestrator(runId: string, renew: boolean): Promise<void> {
    const run = this.deps.controller.find(runId);
    if (run?.suspendedAt !== undefined) {
      void vscode.window.showWarningMessage(
        'オーケストレータモード: 中断中のrunです。「runを再開する」で再開してからOrchestratorを開いてください',
      );
      return;
    }
    const opened = await this.deps.orchestrator.open(runId, renew);
    if (!opened) {
      void vscode.window.showWarningMessage(
        'オーケストレータモード: Orchestratorを開けませんでした。詳細は出力パネルを確認してください',
      );
    }
    this.schedulePost();
  }

  private async finishRun(runId: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'このrunを終えますか？',
      {
        modal: true,
        detail:
          '動いている工程セッションとOrchestratorを止めます。終えたrunは再開できません。終えた後は、同じフォルダで新しいrunを始められます。',
      },
      'runを終える',
    );
    if (choice !== 'runを終える') {
      return;
    }
    warnIfRejected(await this.deps.finishRun(runId));
    this.schedulePost();
  }

  private async suspendRun(runId: string): Promise<void> {
    const run = this.deps.controller.find(runId);
    if (run === undefined || !isTaskRunActive(run)) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'このrunを中断しますか？',
      {
        modal: true,
        detail:
          '動いている工程セッションとOrchestratorを止めます。worktreeとブランチは残り、後で「runを再開する」で続けられます。中断した後は、同じフォルダで新しいrunを始められます。',
      },
      'runを中断する',
    );
    if (choice !== 'runを中断する') {
      return;
    }
    warnIfRejected(await this.deps.suspendRun(runId));
    this.schedulePost();
  }

  /**
   * Kanbanで表示するrunを切り替える。動いているrunならOrchestratorのタブも合わせて前面へ出す
   * （閉じていれば新しい世代で開く）。中断中・終了したrunではOrchestratorを開かない（Issue #1561）。
   */
  private selectRun(runId: string): void {
    const run = this.deps.controller.find(runId);
    if (run === undefined) {
      // 一覧を出した後にrunが消えた。描き直して一覧の選択を今の盤面へ戻す
      this.schedulePost();
      return;
    }
    this.selectedRunId = runId;
    this.schedulePost();
    if (isTaskRunActive(run)) {
      void this.openOrchestrator(runId, false);
    }
  }

  private async renameRun(runId: string): Promise<void> {
    const run = this.deps.controller.find(runId);
    if (run === undefined) {
      return;
    }
    const title = await vscode.window.showInputBox({
      title: 'runの名前',
      prompt: '空にすると開始時刻とCLIで表示します',
      value: run.title ?? '',
      validateInput: validateTaskRunTitleInput,
    });
    if (title === undefined) {
      return;
    }
    await this.deps.controller.setTitle(runId, title);
    this.schedulePost();
  }

  /**
   * 中断したrunを再開する。同じフォルダに動いているrunがあれば、並行して再開するか、（1本だけなら）
   * そちらを中断して入れ替えるかを確かめる（Issue #1562）。runの切り替えコマンド（Issue #1561）からも呼ぶ。
   */
  async resumeRun(runId: string): Promise<void> {
    const run = this.deps.controller.find(runId);
    if (run === undefined || run.finishedAt !== undefined || run.suspendedAt === undefined) {
      return;
    }
    const active = this.deps.controller.listActive(run.workspaceRoot).filter((r) => r.runId !== runId);
    let parallel = false;
    if (active.length > 0) {
      const alongside = '並行して再開する';
      const replace = 'そのrunを中断して再開する';
      const choice = await vscode.window.showWarningMessage(
        active.length === 1
          ? `このフォルダには動いているrun「${taskRunLabel(active[0]!)}」があります。どう再開しますか？`
          : `このフォルダには動いているrunが${String(active.length)}本あります。並行して再開しますか？`,
        {
          modal: true,
          detail:
            '並行して再開すると、工程セッションの数はフォルダ全体で設定`agent.taskRun.maxParallelPerFolder`までに抑えます。' +
            (active.length === 1
              ? '中断して再開すると、動いているrunの工程セッションとOrchestratorを止めます。中断したrunは後で「runを再開する」で続けられます。'
              : '動いているrunのどれかと入れ替えたいときは、Kanbanでそのrunを選んで中断してから、このrunを再開してください。'),
        },
        ...(active.length === 1 ? [alongside, replace] : [alongside]),
      );
      if (choice === alongside) {
        parallel = true;
      } else if (choice === replace && active.length === 1) {
        const suspended = await this.deps.suspendRun(active[0]!.runId);
        if (!suspended.ok) {
          warnIfRejected(suspended);
          return;
        }
      } else {
        return;
      }
    }
    warnIfRejected(await this.deps.resumeRun(runId, { parallel }));
    this.selectedRunId = runId;
    this.schedulePost();
  }

  /** PRのURLは外部由来。httpsのURLであることを確かめてから開く。 */
  private openPullRequest(url: unknown): void {
    if (typeof url !== 'string') {
      return;
    }
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(url, true);
    } catch {
      return;
    }
    if (parsed.scheme !== 'https') {
      return;
    }
    void vscode.env.openExternal(parsed);
  }
}

function warnIfRejected(result: { ok: boolean; message: string }): void {
  if (!result.ok) {
    void vscode.window.showWarningMessage(`オーケストレータモード: ${result.message}`);
  }
}

/** いま開いているワークスペースフォルダ。runの一覧でこれらのrunを先に並べる。 */
export function currentWorkspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function render(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });
  const skin = skinBodyClass(readChatSkinConfig());
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ORCHESTRATOR MODE</p><h1>オーケストレータモード</h1><p class="description">Orchestratorが計画したタスクを、工程（Issue計画 / Issue作成 / 実装 / レビュー / mergeとcleanup）ごとのセッションで並列に進めます。計画は「計画を承認」を押すまで始まりません（自動承認が有効なら、Reflexが妥当と判定した計画はそのまま始まります）。</p></div><div id="controls" class="controls"></div></header><section id="progress" class="progress" aria-label="工程ごとの件数"></section><section id="plan" class="plan"></section><div id="view-toggle" class="view-toggle" role="group" aria-label="表示の切り替え"></div><section id="board" class="board" aria-label="タスクの状態"></section><section id="graph-view" class="graph-view" aria-label="タスクの依存グラフ" hidden><div id="graph-scroll" class="graph-scroll"><svg id="graph" class="graph" role="img" aria-label="依存グラフ"></svg></div><div id="graph-detail" class="graph-detail"></div></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
/* 盤面を画面の残り高さへ収め、横スクロールバーを常に画面下部に出す。列が縦に長いと盤面の下端が画面外へ押し出され、ページを縦にスクロールしないとバーが見えなかった（Issue #1788）。ヘッダ等が高く残りが足りないときは盤面の最低高さを保ってmainを縦スクロールさせる */
main { padding: 24px; max-width: 1800px; margin: 0 auto; box-sizing: border-box; height: 100vh; display: flex; flex-direction: column; overflow-y: auto; }
main > * { flex-shrink: 0; }
header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 2px 0 6px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0; } .description { color: var(--vscode-descriptionForeground); margin: 0; max-width: 720px; }
/* ロードマップ名やrun名が長いと、ヘッダがmainからはみ出してページ全体に横スクロールが出る。盤面は画面幅で列を切り取るため、右へスクロールした先が空になる（Issue #1764） */
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; min-width: 0; }
.controls select { max-width: 100%; min-width: 0; text-overflow: ellipsis; }
.controls select, .controls input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; padding: 4px 6px; }
.controls input[type=number] { width: 56px; }
.btn { appearance: none; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.btn:focus-visible, .controls select:focus-visible, .controls input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.status { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 4px 10px; font-size: 12px; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere; } .status.warn { border-color: var(--vscode-charts-yellow); }
.plan { margin-bottom: 16px; } .plan:empty { display: none; }
.plan-box { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border: 1px solid var(--vscode-charts-yellow); border-radius: 8px; padding: 10px 14px; font-size: 13px; }
/* 7列を等分すると狭いパネルで1行数文字まで潰れるため、列に下限幅を持たせて横スクロールにする。空の列は細くする。
   列の高さを画面の高さまでに抑えてカードは列の中で縦スクロールさせ、盤面の横スクロールバーを常に画面内へ置く（Issue #1764）。
   横スクロールバーは列が収まる幅でも常に出し、右に列が続くかどうかで盤面の高さが変わらないようにする */
.board { display: flex; gap: 10px; align-items: flex-start; overflow-x: scroll; overflow-y: hidden; padding-bottom: 8px; flex: 1 1 auto; min-height: 240px; }
.column { flex: 1 1 240px; min-width: 220px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 200px; overflow: hidden; display: flex; flex-direction: column; max-height: 100%; box-sizing: border-box; }
.column.is-empty { flex: 0 0 104px; min-width: 104px; min-height: 0; } .column.is-empty .empty { padding: 8px 12px; }
.column-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; font-size: 13px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; align-content: start; grid-auto-rows: max-content; gap: 9px; padding: 8px; min-width: 0; min-height: 0; overflow-y: auto; }
.card { min-width: 0; overflow: hidden; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; }
.card.attention { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); }
.card-title { display: block; font-weight: 650; overflow-wrap: anywhere; }
.summary { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.summary.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; } .summary.clamp.expanded { display: block; }
.meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.badge { border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 11px; padding: 1px 7px; } .badge.warn { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); } .badge.ok { border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); }
.dep.unmet { text-decoration: underline dotted; color: var(--vscode-charts-yellow); }
.failure { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.paused { color: var(--vscode-editorWarning-foreground); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.link { appearance: none; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 12px; }
.question { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.question-text { font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
.question-note { color: var(--vscode-descriptionForeground); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.gate { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.gate-detail { color: var(--vscode-descriptionForeground); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow-y: auto; }
.question textarea { width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
/* 列表示とグラフ表示の切り替え（Issue #1552）。ノードの枠は列表示の工程色（--col）、要対応・実行中はカードの左バーと同じ色にする */
.view-toggle { display: flex; gap: 4px; margin-bottom: 12px; }
.view-toggle .btn[aria-pressed=true] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.board[hidden], .graph-view[hidden] { display: none; }
.graph-scroll { overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 8px; }
.graph { display: block; }
.tr-edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; } .tr-edge.unmet { stroke-dasharray: 4 3; opacity: .6; }
.tr-arrow-head { fill: var(--vscode-descriptionForeground); }
.tr-node { cursor: pointer; } .tr-node:focus { outline: none; }
.tr-node-rect { fill: var(--vscode-editor-background); stroke: var(--col, var(--vscode-panel-border)); stroke-width: 1.5; }
.tr-node.running .tr-node-rect { stroke: var(--vscode-charts-blue); stroke-width: 2.5; } .tr-node.attention .tr-node-rect { stroke: var(--vscode-charts-yellow); stroke-width: 2.5; }
.tr-node.col-done .tr-node-rect { fill: color-mix(in srgb, var(--vscode-charts-green) 12%, var(--vscode-editor-background)); }
.tr-node.selected .tr-node-rect, .tr-node:focus-visible .tr-node-rect { stroke: var(--vscode-focusBorder); stroke-width: 3; }
.tr-node-title { fill: var(--vscode-foreground); font-size: 12px; font-weight: 650; } .tr-node-meta { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.graph-detail { margin-top: 12px; max-width: 480px; } .graph-detail .empty { padding: 8px 0; }
/* plainではタイトルと同じ見た目のまま、従来の空白1つ分だけ空ける */
.task-id { margin-right: .3em; }
/* 工程ごとの件数を幅へ比例させた進捗バー。セグメントは件数が1以上の工程だけ置く */
.progress { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; font-size: 12px; } .progress:empty { display: none; }
.progress-bar { flex: 1 1 auto; display: flex; gap: 2px; height: 6px; min-width: 120px; }
.progress-seg { min-width: 4px; border-radius: 2px; background: var(--col, var(--vscode-panel-border)); }
.progress-label { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.col-planApproval { --col: var(--vscode-charts-yellow); } .col-issuePlan, .col-issueCreate { --col: var(--vscode-charts-purple); } .col-implement, .col-review, .col-mergeCleanup { --col: var(--vscode-charts-blue); } .col-done { --col: var(--vscode-charts-green); }
${KANBAN_CYBER_BASE_STYLES}
/*
 * サイバー外装（issue #1538）。規則はすべて body.skin-cyber の配下に置き、plain の見た目は変えない。
 * 軽さのため filter / backdrop-filter は使わない。常時動くのは進行中カードの点（opacity だけ）と、
 * 要対応があるときの走査線1本（transform だけ）で、どちらも prefers-reduced-motion で止める。
 */
body.skin-cyber .col-planApproval { --col: var(--agent-neon-3); } body.skin-cyber .col-issuePlan, body.skin-cyber .col-issueCreate { --col: var(--agent-neon-2); } body.skin-cyber .col-implement, body.skin-cyber .col-review, body.skin-cyber .col-mergeCleanup { --col: var(--agent-neon-1); } body.skin-cyber .col-done { --col: color-mix(in srgb, var(--agent-neon-1) 45%, var(--vscode-descriptionForeground)); }
body.skin-cyber .eyebrow { color: var(--agent-neon-1); font-family: var(--agent-head-font); letter-spacing: .18em; }
body.skin-cyber h1 { font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); text-shadow: 0 0 12px var(--agent-neon-glow); }
body.skin-cyber header { border-bottom: 1px solid var(--agent-neon-edge); padding-bottom: 16px; }
body.skin-cyber .status { border-color: var(--agent-neon-edge); background: var(--agent-panel-bg); font-family: var(--agent-head-font); } body.skin-cyber .status.warn { border-color: var(--agent-neon-3); color: var(--agent-neon-3); box-shadow: inset 0 0 14px -10px var(--agent-neon-3); }
body.skin-cyber .btn:hover { border-color: var(--agent-neon-1); } body.skin-cyber .btn.primary:hover { box-shadow: 0 0 10px -4px var(--agent-neon-glow); }
body.skin-cyber .btn:focus-visible, body.skin-cyber .controls select:focus-visible, body.skin-cyber .controls input:focus-visible { outline-color: var(--agent-neon-1); }
body.skin-cyber .plan-box { border-color: var(--agent-neon-3); background: var(--agent-panel-bg); box-shadow: inset 0 0 20px -12px var(--agent-neon-3); }
body.skin-cyber .progress-label { font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); } body.skin-cyber .progress-label strong { color: var(--agent-neon-1); }
body.skin-cyber .progress-seg { box-shadow: 0 0 6px -1px var(--col); }
/* 列。上端に工程色の線、見出しに工程番号（CSSカウンタなので要素は増えない）、右上を切り欠く */
body.skin-cyber .board { counter-reset: stage; }
body.skin-cyber .column { counter-increment: stage; background: var(--agent-panel-bg); border-color: var(--agent-neon-edge); border-top: 2px solid var(--col, var(--agent-neon-edge)); clip-path: polygon(0 0, calc(100% - var(--agent-notch)) 0, 100% var(--agent-notch), 100% 100%, 0 100%); }
body.skin-cyber .column.is-empty { border-top-color: var(--agent-neon-edge); }
body.skin-cyber .column-head { border-bottom-color: var(--agent-neon-edge); font-family: var(--agent-head-font); letter-spacing: var(--agent-head-tracking); }
body.skin-cyber .column-head::before { content: counter(stage, decimal-leading-zero); color: var(--col, var(--agent-neon-1)); font-size: 11px; opacity: .85; }
body.skin-cyber .column:not(.is-empty) .count { color: var(--col, var(--agent-neon-1)); border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; min-width: 1ch; text-align: center; }
/* カード。発光は枠と左バーだけに載せ、本文には掛けない */
body.skin-cyber .card { border-color: var(--agent-neon-edge); clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%); }
body.skin-cyber .card:hover { border-color: color-mix(in srgb, var(--agent-neon-1) 55%, var(--vscode-panel-border)); box-shadow: inset 0 0 20px -10px var(--agent-neon-glow); }
/* 左バーの滲みは box-shadow ではなく背景のグラデーションで出す（切り欠きの clip-path と inset の影が重なると角から斜めに崩れる） */
body.skin-cyber .card.running { border-left-color: var(--agent-neon-1); background-image: linear-gradient(to right, color-mix(in srgb, var(--agent-neon-1) 10%, transparent), transparent 45%); }
body.skin-cyber .card.attention { border-left-color: var(--agent-neon-3); background-image: linear-gradient(to right, color-mix(in srgb, var(--agent-neon-3) 12%, transparent), transparent 45%); }
body.skin-cyber .col-done .card { opacity: .72; } body.skin-cyber .col-done .card:hover { opacity: 1; }
body.skin-cyber .task-id { font-family: var(--agent-head-font); font-size: 12px; font-weight: 600; margin-right: 6px; color: var(--col, var(--agent-neon-1)); letter-spacing: var(--agent-head-tracking); }
body.skin-cyber .card.running .card-title::before, body.skin-cyber .card.attention .card-title::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; vertical-align: middle; background: var(--agent-neon-1); box-shadow: 0 0 6px var(--agent-neon-glow); animation: agent-task-pulse 1.6s ease-in-out infinite; }
body.skin-cyber .card.attention .card-title::before { background: var(--agent-neon-3); box-shadow: 0 0 6px var(--agent-neon-3); animation: none; }
body.skin-cyber .badge { font-family: var(--agent-head-font); letter-spacing: .02em; } body.skin-cyber .badge.ok { border-color: var(--agent-neon-1); color: var(--agent-neon-1); } body.skin-cyber .badge.warn { border-color: var(--agent-neon-3); color: var(--agent-neon-3); }
body.skin-cyber .question, body.skin-cyber .gate { border-top-color: var(--agent-neon-edge); }
body.skin-cyber .graph-scroll { border-color: var(--agent-neon-edge); background: var(--agent-panel-bg); }
body.skin-cyber .tr-node.running .tr-node-rect { stroke: var(--agent-neon-1); } body.skin-cyber .tr-node.attention .tr-node-rect { stroke: var(--agent-neon-3); }
body.skin-cyber .tr-node-title { font-family: var(--agent-head-font); }
@keyframes agent-task-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
/* 要対応のカードか計画の承認待ちがあるときだけ、画面上端に走査線を1本流す */
body.skin-cyber.has-attention::before { content: ''; position: fixed; left: 0; right: 0; top: 0; height: 2px; pointer-events: none; z-index: 1; background-image: linear-gradient(to right, transparent, var(--agent-neon-3), transparent); opacity: var(--agent-scan-opacity); animation: agent-kanban-scanline 3.2s linear infinite; }
body.skin-cyber.vscode-high-contrast.has-attention::before, body.skin-cyber.vscode-high-contrast-light.has-attention::before { content: none; }
@media (prefers-reduced-motion: reduce) { body.skin-cyber *, body.skin-cyber *::before, body.skin-cyber::before { animation: none !important; } }
`;

// webview側のスクリプト。外部由来のテキストはtextContentでだけ入れる（innerHTMLへ入れない）
const script = `
(function () {
  const vscode = acquireVsCodeApi();
  const COLUMNS = [['planApproval', '計画承認待ち'], ['issuePlan', 'Issue計画'], ['issueCreate', 'Issue作成'], ['implement', '実装'], ['review', 'レビュー'], ['mergeCleanup', 'mergeとcleanup'], ['done', '完了']];
  const ORCHESTRATOR_LABELS = { notStarted: '未起動', idle: '待機中', busy: '応答中', handingOff: '次の世代へ引き継ぎ中' };
  const controls = document.getElementById('controls');
  const planEl = document.getElementById('plan');
  const boardEl = document.getElementById('board');
  const progressEl = document.getElementById('progress');
  const toggleEl = document.getElementById('view-toggle');
  const graphViewEl = document.getElementById('graph-view');
  const graphScrollEl = document.getElementById('graph-scroll');
  const graphEl = document.getElementById('graph');
  const graphDetailEl = document.getElementById('graph-detail');
  const COLUMN_LABELS = {};
  COLUMNS.forEach(function (col) { COLUMN_LABELS[col[0]] = col[1]; });
  // グラフのノードの大きさはlayoutGraph（workflowGraph.ts）のNODE_WIDTH・NODE_HEIGHTと揃える
  const NODE_W = 168;
  const NODE_H = 60;
  const NODE_TEXT_MAX_WIDTH = 148;
  const NODE_CLIP_ID = 'trNodeClip';
  const ARROW_ID = 'trArrow';
  // 表示の切り替え（Issue #1552）。webviewの状態へ残し、開き直しても戻す。
  // タスクIDはrunごとに振り直されるため、選んだタスクはrunIdと組で持つ
  const savedState = vscode.getState() || {};
  let viewMode = savedState.viewMode === 'graph' ? 'graph' : 'board';
  let selectedTask = typeof savedState.selectedTask === 'string' && typeof savedState.selectedTaskRunId === 'string'
    ? { runId: savedState.selectedTaskRunId, taskId: savedState.selectedTask }
    : undefined;
  let currentGraph;
  let reportedGraphWidth = -1;
  let current;
  // 概要を展開したカード。盤面の再描画で畳まれないよう覚えておく
  const expandedSummaries = new Set();
  let orchestratorStatus;
  // 専有権（Issue #1628）。他ウィンドウが持っているときだけ{ heldByOther: true, holderText }が届く
  let leaseStatus;
  // 選択していないrunのうち、別のウィンドウが専有権を持つもののrunId（Issue #1641）
  let heldElsewhere = [];
  // 盤面は更新のたびに描き直すため、書きかけの回答は質問IDごとに持っておく
  const drafts = new Map();
  let focusedQuestion;
  // 工程への指示（Issue #1627）。入力欄を開いたタスクIDと書きかけの文面をタスクIDごとに持っておく
  const instructOpen = new Set();
  const instructDrafts = new Map();
  let focusedInstruct;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  function button(label, cls, onClick) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function send(type, extra) {
    if (!current || !current.run) { return; }
    vscode.postMessage(Object.assign({ type: type, runId: current.run.runId }, extra || {}));
  }
  function assessmentLabel(a) {
    switch (a.kind) {
      case 'finished': return ['すべて完了', ''];
      case 'progressing': return ['進行中', ''];
      case 'haltedByUser': return ['一時停止中', ''];
      case 'planPending': return [a.planStatus === 'awaitingApproval' ? '計画の承認待ち' : 'Orchestratorが計画を作成中', a.planStatus === 'awaitingApproval' ? 'warn' : ''];
      case 'stalled': return ['人の対応待ち: ' + a.blockers.join(', '), 'warn'];
      case 'reopened': return ['再開済み（タスクの追加・再実行待ち）', ''];
    }
    return ['', ''];
  }

  function renderControls(board) {
    controls.replaceChildren();
    if (board.runs.length > 0) {
      const select = el('select');
      select.setAttribute('aria-label', '表示するrun');
      // 今のフォルダのrunが先に届く。他のフォルダのrunは後ろのグループにまとめる
      let otherGroup;
      board.runs.forEach(function (r) {
        const elsewhere = heldElsewhere.indexOf(r.runId) >= 0 ? '・別のウィンドウで実行中' : '';
        const o = el('option', undefined, r.label + '（' + r.status + elsewhere + '）');
        o.value = r.runId;
        o.title = r.workspaceRoot;
        if (board.run && board.run.runId === r.runId) { o.selected = true; }
        if (r.inCurrentFolder) { select.appendChild(o); return; }
        if (!otherGroup) {
          otherGroup = el('optgroup');
          otherGroup.label = '他のフォルダ';
          select.appendChild(otherGroup);
        }
        otherGroup.appendChild(o);
      });
      select.addEventListener('change', function () {
        vscode.postMessage({ type: 'selectRun', runId: select.value });
      });
      controls.appendChild(select);
    }
    const run = board.run;
    if (!run) { return; }
    const status = run.suspended && !run.finished ? ['中断中', 'warn'] : assessmentLabel(run.assessment);
    controls.appendChild(el('span', 'status ' + status[1], status[0] + ' / セッション' + run.activeSessions));
    if (leaseStatus && leaseStatus.heldByOther) {
      // 別ウィンドウが専有権を持つ。計画の変更・工程の開始・承認は送ってもcontroller側で拒否されるが、
      // ここでも案内と移す手段を出す（Issue #1628）
      const holder = leaseStatus.holderText ? '（' + leaseStatus.holderText + '）' : '';
      controls.appendChild(el('span', 'status warn', '別のウィンドウで実行中' + holder + ': 読み取り専用'));
      controls.appendChild(button('専有権をこのウィンドウへ移す', '', function () { send('transferLease'); }));
    }
    if (run.roadmap) {
      controls.appendChild(el('span', 'status', 'ロードマップ #' + run.roadmap.issueNumber + ' ' + run.roadmap.title));
      if (!run.finished) {
        controls.appendChild(button('ロードマップを読み直す', '', function () { send('syncRoadmap'); }));
      }
      const notices = run.roadmap.notices;
      if (notices.length > 0) {
        // 最新の1件を出し、直近の数件はツールチップで見せる
        const last = notices[notices.length - 1];
        const noticeEl = el('span', 'status' + (last.kind === 'warning' ? ' warn' : ''), 'ロードマップ: ' + last.body);
        noticeEl.title = notices.map(function (n) {
          const at = new Date(n.at);
          return (isNaN(at.getTime()) ? n.at : at.toLocaleString()) + ' ' + n.body;
        }).join(String.fromCharCode(10));
        controls.appendChild(noticeEl);
      }
    }
    controls.appendChild(button('名前を変更', '', function () { send('renameRun'); }));
    if (orchestratorStatus && !run.suspended) {
      // 世代番号と自動引き継ぎの発生を並べて出す（Issue #1553）
      const generation = orchestratorStatus !== 'notStarted' && run.orchestratorGeneration > 0 ? '（第' + run.orchestratorGeneration + '世代）' : '';
      controls.appendChild(el('span', 'status' + (orchestratorStatus === 'handingOff' ? ' warn' : ''), 'Orchestrator' + generation + ': ' + (ORCHESTRATOR_LABELS[orchestratorStatus] || orchestratorStatus)));
      const handoffs = run.orchestratorAutoHandoffs;
      if (handoffs && handoffs.count > 0) {
        const handoffEl = el('span', 'status', '自動引き継ぎ ' + handoffs.count + '回（直近は第' + handoffs.lastGeneration + '世代へ）');
        const at = new Date(handoffs.lastAt);
        handoffEl.title = 'コンテキストが少なくなったため、Orchestratorを自動で次の世代へ引き継ぎました。直近: ' + (isNaN(at.getTime()) ? handoffs.lastAt : at.toLocaleString());
        controls.appendChild(handoffEl);
      }
      controls.appendChild(button('Orchestratorを開く', '', function () { send('openOrchestrator', { renew: false }); }));
      if (orchestratorStatus !== 'notStarted') {
        controls.appendChild(button('開き直す', '', function () { send('openOrchestrator', { renew: true }); }));
      }
    }
    if (run.finished) { return; }
    if (run.suspended) {
      controls.appendChild(button('runを再開する', 'primary', function () { send('resumeRun'); }));
      controls.appendChild(button('runを終える', '', function () { send('finishRun'); }));
      return;
    }
    const parallel = el('input');
    parallel.type = 'number'; parallel.min = '1'; parallel.max = '8'; parallel.step = '1';
    parallel.value = String(run.maxParallel);
    parallel.setAttribute('aria-label', '並列上限');
    controls.appendChild(el('span', undefined, '並列'));
    controls.appendChild(parallel);
    controls.appendChild(button('適用', '', function () {
      send('setMaxParallel', { maxParallel: Number(parallel.value) });
    }));
    controls.appendChild(button(run.haltedByUser ? '再開' : '全体を一時停止', run.haltedByUser ? 'primary' : '', function () {
      send('setHalted', { halted: !run.haltedByUser });
    }));
    controls.appendChild(button('runを中断する', '', function () { send('suspendRun'); }));
    controls.appendChild(button('runを終える', '', function () { send('finishRun'); }));
  }

  function renderPlan(board) {
    planEl.replaceChildren();
    const run = board.run;
    if (!run || run.finished || run.suspended) { return; }
    if (run.planStatus === 'approved') {
      // 自動承認（Issue #1554）のときだけ、判定理由を短く残す
      if (run.planReview && run.planReview.autoApproved) {
        const box = el('div', 'plan-box');
        box.appendChild(el('span', undefined, 'Reflexが計画を妥当と判定し、自動で承認しました。'));
        box.appendChild(el('div', 'question-note', 'Reflexの判定: ' + run.planReview.summary));
        planEl.appendChild(box);
      }
      return;
    }
    const box = el('div', 'plan-box');
    if (run.planStatus === 'awaitingApproval') {
      box.appendChild(el('span', undefined, 'Orchestratorが計画を提案しました。「計画承認待ち」の列を確かめて承認してください。変更したいときはOrchestratorのチャットで伝えます。'));
      if (run.planReview) {
        box.appendChild(el('div', 'question-note', 'Reflexの判定: ' + run.planReview.summary));
      }
      box.appendChild(button('計画を承認', 'primary', function () { send('approvePlan'); }));
    } else {
      box.appendChild(el('span', undefined, 'Orchestratorが計画を作成中です。やりたいことはOrchestratorのチャットで伝えます。'));
    }
    planEl.appendChild(box);
  }

  function renderQuestion(card, q) {
    const box = el('div', 'question');
    const prefix = (q.awaitingOrchestrator ? '[オーケストレーターが判断中] ' : '') + (q.blocking ? '[回答待ちで停止中] ' : '');
    box.appendChild(el('div', 'question-text', prefix + q.question));
    box.appendChild(el('div', 'question-note', '理由: ' + q.reason));
    if (q.evidence) { box.appendChild(el('div', 'question-note', '材料: ' + q.evidence)); }
    if (q.reflexSummary) { box.appendChild(el('div', 'question-note', 'Reflex: ' + q.reflexSummary)); }
    function answer(text) {
      drafts.delete(q.questionId);
      send('answerQuestion', { taskId: card.taskId, questionId: q.questionId, answer: text });
    }
    if (q.options.length > 0) {
      const options = el('div', 'actions');
      q.options.forEach(function (o) {
        const recommended = o === q.recommended;
        options.appendChild(button(recommended ? o + '（推奨）' : o, recommended ? 'primary' : '', function () { answer(o); }));
      });
      box.appendChild(options);
    }
    const input = el('textarea');
    input.setAttribute('aria-label', '自由記述の回答');
    input.placeholder = q.options.length > 0 ? '選択肢以外で答える' : '回答を入力';
    input.value = drafts.get(q.questionId) || '';
    input.addEventListener('input', function () { drafts.set(q.questionId, input.value); });
    input.addEventListener('focus', function () { focusedQuestion = q.questionId; });
    input.addEventListener('blur', function () { focusedQuestion = undefined; });
    box.appendChild(input);
    if (focusedQuestion === q.questionId) {
      setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    }
    const submit = el('div', 'actions');
    submit.appendChild(button('回答を送る', '', function () {
      if (input.value.trim() !== '') { answer(input.value); }
    }));
    box.appendChild(submit);
    return box;
  }

  // 動作中の工程への指示（Issue #1627）。押して入力欄を出し、送るとinstruct_taskと同じ経路で届く
  function renderInstruct(card) {
    const box = el('div', 'question');
    if (!instructOpen.has(card.taskId)) {
      box.appendChild(button('指示を送る', '', function () {
        instructOpen.add(card.taskId);
        renderView();
      }));
      return box;
    }
    box.appendChild(el('div', 'question-text', '工程への指示'));
    const input = el('textarea');
    input.setAttribute('aria-label', '工程への指示');
    input.placeholder = '指示を入力';
    input.value = instructDrafts.get(card.taskId) || '';
    input.addEventListener('input', function () { instructDrafts.set(card.taskId, input.value); });
    input.addEventListener('focus', function () { focusedInstruct = card.taskId; });
    input.addEventListener('blur', function () { focusedInstruct = undefined; });
    box.appendChild(input);
    if (focusedInstruct === card.taskId) {
      setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    }
    const actions = el('div', 'actions');
    actions.appendChild(button('送る', 'primary', function () {
      if (input.value.trim() === '') { return; }
      send('instructTask', { taskId: card.taskId, instruction: input.value });
      instructDrafts.delete(card.taskId);
      instructOpen.delete(card.taskId);
      renderView();
    }));
    actions.appendChild(button('やめる', '', function () {
      instructDrafts.delete(card.taskId);
      instructOpen.delete(card.taskId);
      renderView();
    }));
    box.appendChild(actions);
    return box;
  }

  function renderGate(card, gate) {
    const box = el('div', 'gate');
    const title = gate.kind === 'reviewFindings' ? 'レビュー後の関門' : '「' + gate.stageLabel + '」の失敗の関門';
    const status = gate.judging ? '（Reflexが判定中）' : gate.awaitingOrchestrator ? '（オーケストレーターが判断中）' : '（判断待ち）';
    box.appendChild(el('div', 'question-text', title + status));
    box.appendChild(el('div', 'gate-detail', gate.detail));
    if (gate.reflexSummary) { box.appendChild(el('div', 'question-note', 'Reflex: ' + gate.reflexSummary)); }
    if (gate.choices.length > 0) {
      const actions = el('div', 'actions');
      gate.choices.forEach(function (c) {
        actions.appendChild(button(c.label, '', function () {
          send('resolveGate', { taskId: card.taskId, gateId: gate.gateId, choice: c.choice });
        }));
      });
      box.appendChild(actions);
    }
    return box;
  }

  function renderCard(card) {
    const warn = card.badges.some(function (b) { return b.tone === 'warn'; });
    const running = card.badges.some(function (b) { return b.tone === 'ok'; });
    const c = el('article', 'card' + (warn ? ' attention' : running ? ' running' : ''));
    const title = el('span', 'card-title');
    title.appendChild(el('span', 'task-id', card.taskId));
    title.appendChild(document.createTextNode(card.title));
    c.appendChild(title);
    if (card.summary) {
      // 長い概要は3行に畳み、クリックで全文を出す
      const summary = el('div', 'summary clamp' + (expandedSummaries.has(card.taskId) ? ' expanded' : ''), card.summary);
      summary.title = card.summary;
      summary.addEventListener('click', function () {
        if (summary.classList.toggle('expanded')) { expandedSummaries.add(card.taskId); } else { expandedSummaries.delete(card.taskId); }
      });
      c.appendChild(summary);
    }
    if (card.badges.length > 0) {
      const badges = el('div', 'badges');
      card.badges.forEach(function (b) { badges.appendChild(el('span', 'badge ' + b.tone, b.label)); });
      c.appendChild(badges);
    }
    const meta = el('div', 'meta');
    if (card.issueNumber !== undefined && card.issueNumber !== null) { meta.appendChild(el('span', undefined, 'Issue #' + card.issueNumber)); }
    if (card.attempts > 1) { meta.appendChild(el('span', undefined, card.attempts + '回目')); }
    if (card.reviewRounds) { meta.appendChild(el('span', undefined, '差し戻し ' + card.reviewRounds)); }
    if (card.dependsOn.length > 0) {
      const deps = el('span', undefined, '依存: ');
      card.dependsOn.forEach(function (d, i) {
        if (i > 0) { deps.appendChild(document.createTextNode(', ')); }
        deps.appendChild(el('span', 'dep' + (d.satisfied ? '' : ' unmet'), d.taskId));
      });
      meta.appendChild(deps);
    }
    if (card.pullRequest) {
      const url = card.pullRequest.url;
      const link = el('button', 'link', 'PR #' + card.pullRequest.number);
      link.type = 'button';
      link.addEventListener('click', function () { send('openPullRequest', { url: url }); });
      meta.appendChild(link);
    }
    if (meta.childNodes.length > 0) { c.appendChild(meta); }
    if (card.failure) { c.appendChild(el('div', 'failure', card.failure)); }
    if (card.pauseReason) { c.appendChild(el('div', 'paused', '一時停止の理由: ' + card.pauseReason)); }
    const actions = el('div', 'actions');
    if (card.canReveal) { actions.appendChild(button('セッションを開く', '', function () { send('revealStage', { taskId: card.taskId }); })); }
    if (card.canStop) { actions.appendChild(button('停止', '', function () { send('stopStage', { taskId: card.taskId }); })); }
    if (card.canRetry) { actions.appendChild(button('やり直す', 'primary', function () { send('retryStage', { taskId: card.taskId }); })); }
    if (actions.childNodes.length > 0) { c.appendChild(actions); }
    if (card.gate) { c.appendChild(renderGate(card, card.gate)); }
    if (card.lastGateDecision) { c.appendChild(el('div', 'summary', card.lastGateDecision)); }
    if (card.canInstruct) { c.appendChild(renderInstruct(card)); }
    card.questions.forEach(function (q) { c.appendChild(renderQuestion(card, q)); });
    return c;
  }

  function renderProgress(board) {
    progressEl.replaceChildren();
    if (!board.run) { return; }
    let total = 0;
    const bar = el('div', 'progress-bar');
    COLUMNS.forEach(function (col) {
      const count = (board.run.columns[col[0]] || []).length;
      total += count;
      if (count === 0) { return; }
      const seg = el('span', 'progress-seg col-' + col[0]);
      seg.style.flexGrow = String(count);
      seg.title = col[1] + ': ' + count;
      bar.appendChild(seg);
    });
    if (total === 0) { return; }
    const done = (board.run.columns.done || []).length;
    const label = el('span', 'progress-label', '完了 ');
    label.appendChild(el('strong', undefined, done + '/' + total));
    progressEl.appendChild(bar);
    progressEl.appendChild(label);
  }

  // 走査線はどちらの表示でも出すため、盤面の描画とは別に切り替える
  function renderAttention(board) {
    const attention = !!board.run && (board.run.planStatus === 'awaitingApproval' || COLUMNS.some(function (col) {
      return (board.run.columns[col[0]] || []).some(function (card) { return card.badges.some(function (b) { return b.tone === 'warn'; }); });
    }));
    document.body.classList.toggle('has-attention', attention);
  }

  function renderBoard(board) {
    boardEl.replaceChildren();
    if (!board.run) {
      boardEl.appendChild(el('div', 'empty', 'runがありません。コマンド「オーケストレータモードを開始」で始めます。'));
      return;
    }
    COLUMNS.forEach(function (col) {
      const cards = board.run.columns[col[0]] || [];
      const column = el('section', 'column col-' + col[0] + (cards.length === 0 ? ' is-empty' : ''));
      const head = el('div', 'column-head');
      head.appendChild(el('span', undefined, col[1]));
      head.appendChild(el('span', 'count', String(cards.length)));
      column.appendChild(head);
      const list = el('div', 'cards');
      if (cards.length === 0) { list.appendChild(el('div', 'empty', 'なし')); }
      cards.forEach(function (card) { list.appendChild(renderCard(card)); });
      column.appendChild(list);
      boardEl.appendChild(column);
    });
  }

  ${GRAPH_SVG_SOURCE}

  function saveViewState() {
    vscode.setState({
      viewMode: viewMode,
      selectedTask: selectedTask ? selectedTask.taskId : undefined,
      selectedTaskRunId: selectedTask ? selectedTask.runId : undefined,
      // ウィンドウを開き直したときに同じrunを出す（Issue #1775、restorePanel）
      runId: current && current.run ? current.run.runId : undefined,
    });
  }

  function findCard(run, taskId) {
    let found;
    COLUMNS.forEach(function (col) {
      (run.columns[col[0]] || []).forEach(function (card) { if (card.taskId === taskId) { found = card; } });
    });
    return found;
  }

  function isSelected(run, taskId) {
    return !!selectedTask && selectedTask.runId === run.runId && selectedTask.taskId === taskId;
  }

  function renderViewToggle() {
    toggleEl.replaceChildren();
    [['board', '列'], ['graph', 'グラフ']].forEach(function (m) {
      const b = button(m[1], '', function () {
        if (viewMode === m[0]) { return; }
        viewMode = m[0];
        saveViewState();
        renderView();
      });
      b.setAttribute('aria-pressed', viewMode === m[0] ? 'true' : 'false');
      toggleEl.appendChild(b);
    });
  }

  function buildGraphNode(run, card, pos) {
    // 状態の色は列表示のカード（renderCard）と同じ判断にする
    const warn = card.badges.some(function (b) { return b.tone === 'warn'; });
    const running = card.badges.some(function (b) { return b.tone === 'ok'; });
    const group = svgEl('g', {
      class: 'tr-node col-' + card.column + (warn ? ' attention' : running ? ' running' : '') + (isSelected(run, card.taskId) ? ' selected' : ''),
      transform: 'translate(' + pos.x + ',' + pos.y + ')',
      tabindex: 0,
      role: 'button',
      'data-task': card.taskId,
    });
    group.appendChild(svgEl('rect', { class: 'tr-node-rect', x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: 6 }));
    const body = svgEl('g', { 'clip-path': 'url(#' + NODE_CLIP_ID + ')' });
    // タイトルは外部由来。必ずtextContentへ代入する（SVGとして解釈させない）
    const title = svgEl('text', { class: 'tr-node-title', x: -NODE_W / 2 + 10, y: -6, 'data-fit': NODE_TEXT_MAX_WIDTH });
    title.textContent = card.taskId + ' ' + card.title;
    body.appendChild(title);
    const meta = svgEl('text', { class: 'tr-node-meta', x: -NODE_W / 2 + 10, y: 14, 'data-fit': NODE_TEXT_MAX_WIDTH });
    const labels = [COLUMN_LABELS[card.column]];
    if (card.badges.length > 0) { labels.push(card.badges[0].label); }
    if (card.questions.length > 0) { labels.push('質問' + card.questions.length + '件'); }
    meta.textContent = labels.join(' · ');
    body.appendChild(meta);
    group.appendChild(body);
    const tip = svgEl('title');
    tip.textContent = card.taskId + ' ' + card.title;
    group.appendChild(tip);
    function select() {
      selectedTask = { runId: run.runId, taskId: card.taskId };
      saveViewState();
      renderGraph(current, currentGraph);
    }
    group.addEventListener('click', select);
    group.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    return group;
  }

  function renderGraph(board, layout) {
    // 描き直しでノードの要素が入れ替わるとフォーカスが外れる。選択の操作や実行中の自動更新のたびに
    // キーボードでの移動位置が飛ばないよう、同じタスクのノードへ戻す
    const active = document.activeElement;
    const focusedNode = active && graphEl.contains(active) ? active.getAttribute('data-task') : null;
    graphEl.replaceChildren();
    graphDetailEl.replaceChildren();
    if (!board.run || !layout) {
      graphDetailEl.appendChild(el('p', 'empty', 'runがありません。コマンド「オーケストレータモードを開始」で始めます。'));
      return;
    }
    const run = board.run;
    const height = Math.max(1, layout.height);
    graphEl.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + height);
    graphEl.setAttribute('width', String(Math.max(1, layout.width)));
    graphEl.setAttribute('height', String(height));
    const defs = svgEl('defs');
    defs.appendChild(arrowMarker(ARROW_ID, 'tr-arrow-head'));
    // 文字の切り詰め（fitNodeText）が測れなかったときの下支え。矩形より少し内側で文字だけを切る
    const clip = svgEl('clipPath', { id: NODE_CLIP_ID });
    clip.appendChild(svgEl('rect', { x: -NODE_W / 2 + 4, y: -NODE_H / 2, width: NODE_W - 8, height: NODE_H }));
    defs.appendChild(clip);
    graphEl.appendChild(defs);

    const posById = {};
    layout.nodes.forEach(function (n) { posById[n.id] = n; });
    const edges = svgEl('g', { class: 'tr-edges' });
    layout.edges.forEach(function (edge) {
      const from = posById[edge.from];
      const to = posById[edge.to];
      if (!from || !to) { return; }
      const target = findCard(run, edge.to);
      const dep = target ? target.dependsOn.find(function (d) { return d.taskId === edge.from; }) : undefined;
      const unmet = dep !== undefined && !dep.satisfied;
      edges.appendChild(svgEl('path', {
        class: 'tr-edge' + (unmet ? ' unmet' : ''),
        d: edgePath(from.x, from.y + NODE_H / 2, to.x, to.y - NODE_H / 2),
        'marker-end': 'url(#' + ARROW_ID + ')',
      }));
    });
    graphEl.appendChild(edges);

    const nodes = svgEl('g', { class: 'tr-nodes' });
    layout.nodes.forEach(function (n) {
      const card = findCard(run, n.id);
      if (card) { nodes.appendChild(buildGraphNode(run, card, n)); }
    });
    graphEl.appendChild(nodes);
    // 実測での切り詰めはSVGへ入れたあと（getComputedTextLengthは描画中の要素でしか測れない）
    nodes.querySelectorAll('text[data-fit]').forEach(function (t) {
      fitNodeText(t, Number(t.getAttribute('data-fit')));
    });
    if (focusedNode !== null) {
      // タスクIDは外部由来なので、属性セレクタの文字列へ埋め込まずに値で比べる
      const again = Array.prototype.find.call(nodes.querySelectorAll('[data-task]'), function (n) { return n.getAttribute('data-task') === focusedNode; });
      if (again) { again.focus(); }
    }

    const selected = selectedTask && selectedTask.runId === run.runId ? findCard(run, selectedTask.taskId) : undefined;
    if (selected) {
      graphDetailEl.appendChild(renderCard(selected));
    } else {
      graphDetailEl.appendChild(el('p', 'empty', 'ノードを押すと、ここにカードの詳細と操作が出ます。'));
    }
  }

  // 段の折り返しに使う幅を拡張機能へ伝える（layoutGraphのmaxWidth）。非表示のあいだは測れないので送らない
  function reportViewport() {
    if (viewMode !== 'graph') { return; }
    const width = Math.floor(graphScrollEl.clientWidth) - 16;
    if (width <= 0 || width === reportedGraphWidth) { return; }
    reportedGraphWidth = width;
    vscode.postMessage({ type: 'viewport', width: width });
  }

  // 出していない方の表示は描かない。列とグラフの詳細に同じ質問の入力欄を2つ作ると、
  // 書きかけの回答と入力位置の持ち越し（drafts・focusedQuestion）がどちらへ効くか定まらない
  function renderView() {
    renderViewToggle();
    const isGraph = viewMode === 'graph';
    boardEl.hidden = isGraph;
    graphViewEl.hidden = !isGraph;
    if (!current) { return; }
    if (isGraph) {
      boardEl.replaceChildren();
      renderGraph(current, currentGraph);
      reportViewport();
    } else {
      graphEl.replaceChildren();
      graphDetailEl.replaceChildren();
      renderBoard(current);
    }
  }

  // ドラッグでのリサイズ中に幅を送り続けないよう、止まってから送る（ロードマップ実行のKanbanと同じ150ms）
  let viewportTimer;
  new ResizeObserver(function () {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(reportViewport, 150);
  }).observe(graphScrollEl);

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || message.type !== 'board') { return; }
    current = message.board;
    orchestratorStatus = message.orchestrator;
    currentGraph = message.graph;
    leaseStatus = message.lease;
    heldElsewhere = message.heldElsewhere || [];
    saveViewState();
    renderControls(current);
    renderProgress(current);
    renderPlan(current);
    renderAttention(current);
    renderView();
  });
  // 復元した表示を最初のboardより前に反映する（静的HTMLの列表示が一瞬出ないように）
  renderView();
  vscode.postMessage({ type: 'ready' });
})();
`;
