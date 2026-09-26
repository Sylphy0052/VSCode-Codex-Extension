import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import { MAX_USER_ANSWER_LENGTH, parseUserAnswer } from '../orchestrator/roadmapQuestionMcp';
import type { TaskRunController } from '../orchestrator/taskRunController';
import type { TaskRunOrchestratorStatus } from '../orchestrator/taskRunOrchestrator';
import { isTaskRunActive, isValidTaskId, TASK_RUN_TITLE_MAX_LENGTH } from '../orchestrator/taskRunState';
import { chatCsp } from './chatCsp';
import { KANBAN_CYBER_BASE_STYLES } from './kanbanCyberStyles';
import { skinBodyClass } from './skin';
import { TASK_RUN_KANBAN_COLUMNS, type TaskRunKanbanCard } from './taskRunKanbanModel';

/** 盤面を送る間隔。`roadmapKanbanView.ts`と同じく、最初はすぐ送り以降はまとめる。 */
const POST_INTERVAL_MS = 250;

/** Kanbanから使うOrchestratorの口。 */
export interface TaskRunKanbanOrchestratorPort {
  open(runId: string, renew: boolean): Promise<boolean>;
  status(runId: string): TaskRunOrchestratorStatus;
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
  /** 中断したrunを再開し、Orchestratorを新しい世代で開く（Issue #1560）。 */
  resumeRun(runId: string): Promise<{ ok: boolean; message: string }>;
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
  private lastPostAt = 0;
  private selectedRunId: string | undefined;

  constructor(private readonly deps: TaskRunKanbanViewDeps) {}

  show(runId?: string): void {
    if (runId !== undefined) {
      this.selectedRunId = runId;
    }
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        TaskRunKanbanViewManager.viewType,
        'オーケストレータモード',
        // 左の列にKanban、右の列にOrchestratorのチャットタブを並べる
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
      );
      this.panel.onDidDispose(() => {
        this.clearTimer();
        this.dirty = false;
        this.panel = undefined;
      });
      this.panel.onDidChangeViewState(() => {
        if (this.panel?.visible === true && this.dirty) {
          this.schedulePost();
        }
      });
      this.panel.webview.html = render(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
      // 初回の盤面はwebviewからの`ready`に対して送る
      return;
    }
    this.panel.reveal();
    this.schedulePost();
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
    if (this.panel === undefined) {
      return;
    }
    this.dirty = false;
    this.lastPostAt = Date.now();
    const board = this.deps.controller.board(this.selectedRunId, currentWorkspaceFolders());
    const orchestrator = board.run === undefined ? undefined : this.deps.orchestrator.status(board.run.runId);
    void this.panel.webview.postMessage({ type: 'board', board, orchestrator });
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'ready') {
      this.post();
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
        if (!(await controller.approvePlan(runId))) {
          void vscode.window.showWarningMessage('オーケストレータモード: 承認待ちの計画がありません');
        }
        return;
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
          await controller.setHalted(runId, message.halted);
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
      validateInput: (value) =>
        value.length > TASK_RUN_TITLE_MAX_LENGTH ? `${String(TASK_RUN_TITLE_MAX_LENGTH)}文字以内で入力してください` : undefined,
    });
    if (title === undefined) {
      return;
    }
    await this.deps.controller.setTitle(runId, title);
    this.schedulePost();
  }

  /**
   * 中断したrunを再開する。同じフォルダに動いているrunがあれば、確かめてからそちらを中断して入れ替える。
   * runの切り替えコマンド（Issue #1561）からも呼ぶ。
   */
  async resumeRun(runId: string): Promise<void> {
    const run = this.deps.controller.find(runId);
    if (run === undefined || run.finishedAt !== undefined || run.suspendedAt === undefined) {
      return;
    }
    const active = this.deps.controller.findActive(run.workspaceRoot);
    if (active !== undefined && active.runId !== runId) {
      const choice = await vscode.window.showWarningMessage(
        'このフォルダには動いているrunがあります。そのrunを中断して、このrunを再開しますか？',
        {
          modal: true,
          detail:
            '動いているrunの工程セッションとOrchestratorを止めます。中断したrunは後で「runを再開する」で続けられます。',
        },
        'そのrunを中断して再開する',
      );
      if (choice !== 'そのrunを中断して再開する') {
        return;
      }
      const suspended = await this.deps.suspendRun(active.runId);
      if (!suspended.ok) {
        warnIfRejected(suspended);
        return;
      }
    }
    warnIfRejected(await this.deps.resumeRun(runId));
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
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ORCHESTRATOR MODE</p><h1>オーケストレータモード</h1><p class="description">Orchestratorが計画したタスクを、工程（Issue計画 / Issue作成 / 実装 / レビュー / mergeとcleanup）ごとのセッションで並列に進めます。計画は「計画を承認」を押すまで始まりません。</p></div><div id="controls" class="controls"></div></header><section id="progress" class="progress" aria-label="工程ごとの件数"></section><section id="plan" class="plan"></section><section id="board" class="board" aria-label="タスクの状態"></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
main { padding: 24px; max-width: 1800px; margin: 0 auto; }
header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 2px 0 6px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0; } .description { color: var(--vscode-descriptionForeground); margin: 0; max-width: 720px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
.controls select, .controls input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; padding: 4px 6px; }
.controls input[type=number] { width: 56px; }
.btn { appearance: none; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.btn:focus-visible, .controls select:focus-visible, .controls input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.status { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 4px 10px; font-size: 12px; white-space: nowrap; } .status.warn { border-color: var(--vscode-charts-yellow); }
.plan { margin-bottom: 16px; } .plan:empty { display: none; }
.plan-box { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border: 1px solid var(--vscode-charts-yellow); border-radius: 8px; padding: 10px 14px; font-size: 13px; }
/* 7列を等分すると狭いパネルで1行数文字まで潰れるため、列に下限幅を持たせて横スクロールにする。空の列は細くする */
.board { display: flex; gap: 10px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.column { flex: 1 1 240px; min-width: 220px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 200px; overflow: hidden; }
.column.is-empty { flex: 0 0 104px; min-width: 104px; min-height: 0; } .column.is-empty .empty { padding: 8px 12px; }
.column-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; font-size: 13px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 8px; min-width: 0; }
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
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.link { appearance: none; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 12px; }
.question { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.question-text { font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
.question-note { color: var(--vscode-descriptionForeground); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.gate { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.gate-detail { color: var(--vscode-descriptionForeground); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow-y: auto; }
.question textarea { width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
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
  const ORCHESTRATOR_LABELS = { notStarted: '未起動', idle: '待機中', busy: '応答中' };
  const controls = document.getElementById('controls');
  const planEl = document.getElementById('plan');
  const boardEl = document.getElementById('board');
  const progressEl = document.getElementById('progress');
  let current;
  // 概要を展開したカード。盤面の再描画で畳まれないよう覚えておく
  const expandedSummaries = new Set();
  let orchestratorStatus;
  // 盤面は更新のたびに描き直すため、書きかけの回答は質問IDごとに持っておく
  const drafts = new Map();
  let focusedQuestion;

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
        const o = el('option', undefined, r.label + '（' + r.status + '）');
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
    controls.appendChild(button('名前を変更', '', function () { send('renameRun'); }));
    if (orchestratorStatus && !run.suspended) {
      controls.appendChild(el('span', 'status', 'Orchestrator: ' + (ORCHESTRATOR_LABELS[orchestratorStatus] || orchestratorStatus)));
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
    if (!run || run.finished || run.suspended || run.planStatus === 'approved') { return; }
    const box = el('div', 'plan-box');
    if (run.planStatus === 'awaitingApproval') {
      box.appendChild(el('span', undefined, 'Orchestratorが計画を提案しました。「計画承認待ち」の列を確かめて承認してください。変更したいときはOrchestratorのチャットで伝えます。'));
      box.appendChild(button('計画を承認', 'primary', function () { send('approvePlan'); }));
    } else {
      box.appendChild(el('span', undefined, 'Orchestratorが計画を作成中です。やりたいことはOrchestratorのチャットで伝えます。'));
    }
    planEl.appendChild(box);
  }

  function renderQuestion(card, q) {
    const box = el('div', 'question');
    box.appendChild(el('div', 'question-text', (q.blocking ? '[回答待ちで停止中] ' : '') + q.question));
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

  function renderGate(card, gate) {
    const box = el('div', 'gate');
    const title = gate.kind === 'reviewFindings' ? 'レビュー後の関門' : '「' + gate.stageLabel + '」の失敗の関門';
    box.appendChild(el('div', 'question-text', title + (gate.judging ? '（Reflexが判定中）' : '（判断待ち）')));
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
    const actions = el('div', 'actions');
    if (card.canReveal) { actions.appendChild(button('セッションを開く', '', function () { send('revealStage', { taskId: card.taskId }); })); }
    if (card.canStop) { actions.appendChild(button('停止', '', function () { send('stopStage', { taskId: card.taskId }); })); }
    if (card.canRetry) { actions.appendChild(button('やり直す', 'primary', function () { send('retryStage', { taskId: card.taskId }); })); }
    if (actions.childNodes.length > 0) { c.appendChild(actions); }
    if (card.gate) { c.appendChild(renderGate(card, card.gate)); }
    if (card.lastGateDecision) { c.appendChild(el('div', 'summary', card.lastGateDecision)); }
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

  function renderBoard(board) {
    boardEl.replaceChildren();
    const attention = !!board.run && (board.run.planStatus === 'awaitingApproval' || COLUMNS.some(function (col) {
      return (board.run.columns[col[0]] || []).some(function (card) { return card.badges.some(function (b) { return b.tone === 'warn'; }); });
    }));
    document.body.classList.toggle('has-attention', attention);
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

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || message.type !== 'board') { return; }
    current = message.board;
    orchestratorStatus = message.orchestrator;
    renderControls(current);
    renderProgress(current);
    renderPlan(current);
    renderBoard(current);
  });
  vscode.postMessage({ type: 'ready' });
})();
`;
