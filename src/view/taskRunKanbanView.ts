import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import { MAX_USER_ANSWER_LENGTH, parseUserAnswer } from '../orchestrator/roadmapQuestionMcp';
import type { TaskRunController } from '../orchestrator/taskRunController';
import type { TaskRunOrchestratorStatus } from '../orchestrator/taskRunOrchestrator';
import { isValidTaskId } from '../orchestrator/taskRunState';
import { chatCsp } from './chatCsp';
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
  log: Logger;
}

/**
 * オーケストレータモード（Issue #1505）のKanban。タスクを工程別の列に並べ、計画の承認、
 * 並列上限、run全体の一時停止と再開、工程の停止・やり直し、質問への回答を受け付ける。
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
    const board = this.deps.controller.board(this.selectedRunId);
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
        this.selectedRunId = message.runId;
        this.schedulePost();
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

  private findCard(runId: string, taskId: string): TaskRunKanbanCard | undefined {
    const board = this.deps.controller.board(runId);
    if (board.run?.runId !== runId) {
      return undefined;
    }
    return TASK_RUN_KANBAN_COLUMNS.flatMap((col) => board.run?.columns[col] ?? []).find(
      (c) => c.taskId === taskId,
    );
  }

  private async openOrchestrator(runId: string, renew: boolean): Promise<void> {
    const opened = await this.deps.orchestrator.open(runId, renew);
    if (!opened) {
      void vscode.window.showWarningMessage(
        'オーケストレータモード: Orchestratorを開けませんでした。詳細は出力パネルを確認してください',
      );
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function render(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });
  const skin = skinBodyClass(readChatSkinConfig());
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ORCHESTRATOR MODE</p><h1>オーケストレータモード</h1><p class="description">Orchestratorが計画したタスクを、工程（Issue計画 / Issue作成 / 実装 / レビュー / mergeとcleanup）ごとのセッションで並列に進めます。計画は「計画を承認」を押すまで始まりません。</p></div><div id="controls" class="controls"></div></header><section id="plan" class="plan"></section><section id="board" class="board" aria-label="タスクの状態"></section></main><script nonce="${nonce}">${script}</script></body></html>`;
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
.board { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; align-items: start; }
.column { min-width: 0; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 200px; overflow: hidden; }
.column-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; font-size: 13px; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 8px; min-width: 0; }
.card { min-width: 0; overflow: hidden; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; }
.card.attention { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); }
.card-title { display: block; font-weight: 650; overflow-wrap: anywhere; }
.summary { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
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
.question textarea { width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
`;

// webview側のスクリプト。外部由来のテキストはtextContentでだけ入れる（innerHTMLへ入れない）
const script = `
(function () {
  const vscode = acquireVsCodeApi();
  const COLUMNS = [['planApproval', '計画承認待ち'], ['issuePlan', 'Issue計画'], ['issueCreate', 'Issue作成'], ['implement', '実装'], ['review', 'レビュー'], ['mergeCleanup', 'mergeとcleanup'], ['done', '完了']];
  const ORCHESTRATOR_LABELS = { notStarted: '未起動', idle: '待機中', busy: '応答中' };
  const ENGINE_LABELS = { codex: 'Codex', claude: 'Claude' };
  const controls = document.getElementById('controls');
  const planEl = document.getElementById('plan');
  const boardEl = document.getElementById('board');
  let current;
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
      board.runs.forEach(function (r) {
        const o = el('option', undefined, r.startedAt.slice(0, 16).replace('T', ' ') + ' ' + (ENGINE_LABELS[r.engine] || r.engine) + (r.finished ? '（終了）' : ''));
        o.value = r.runId;
        o.title = r.workspaceRoot;
        if (board.run && board.run.runId === r.runId) { o.selected = true; }
        select.appendChild(o);
      });
      select.addEventListener('change', function () {
        vscode.postMessage({ type: 'selectRun', runId: select.value });
      });
      controls.appendChild(select);
    }
    const run = board.run;
    if (!run) { return; }
    const status = assessmentLabel(run.assessment);
    controls.appendChild(el('span', 'status ' + status[1], status[0] + ' / セッション' + run.activeSessions));
    if (orchestratorStatus) {
      controls.appendChild(el('span', 'status', 'Orchestrator: ' + (ORCHESTRATOR_LABELS[orchestratorStatus] || orchestratorStatus)));
      controls.appendChild(button('Orchestratorを開く', '', function () { send('openOrchestrator', { renew: false }); }));
      if (orchestratorStatus !== 'notStarted') {
        controls.appendChild(button('開き直す', '', function () { send('openOrchestrator', { renew: true }); }));
      }
    }
    if (run.finished) { return; }
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
  }

  function renderPlan(board) {
    planEl.replaceChildren();
    const run = board.run;
    if (!run || run.finished || run.planStatus === 'approved') { return; }
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

  function renderCard(card) {
    const warn = card.badges.some(function (b) { return b.tone === 'warn'; });
    const running = card.badges.some(function (b) { return b.tone === 'ok'; });
    const c = el('article', 'card' + (warn ? ' attention' : running ? ' running' : ''));
    c.appendChild(el('span', 'card-title', card.taskId + ' ' + card.title));
    if (card.summary) { c.appendChild(el('div', 'summary', card.summary)); }
    if (card.badges.length > 0) {
      const badges = el('div', 'badges');
      card.badges.forEach(function (b) { badges.appendChild(el('span', 'badge ' + b.tone, b.label)); });
      c.appendChild(badges);
    }
    const meta = el('div', 'meta');
    if (card.issueNumber !== undefined && card.issueNumber !== null) { meta.appendChild(el('span', undefined, 'Issue #' + card.issueNumber)); }
    if (card.attempts > 1) { meta.appendChild(el('span', undefined, card.attempts + '回目')); }
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
    card.questions.forEach(function (q) { c.appendChild(renderQuestion(card, q)); });
    return c;
  }

  function renderBoard(board) {
    boardEl.replaceChildren();
    if (!board.run) {
      boardEl.appendChild(el('div', 'empty', 'runがありません。コマンド「オーケストレータモードを開始」で始めます。'));
      return;
    }
    COLUMNS.forEach(function (col) {
      const cards = board.run.columns[col[0]] || [];
      const column = el('section', 'column');
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
    renderPlan(current);
    renderBoard(current);
  });
  vscode.postMessage({ type: 'ready' });
})();
`;
