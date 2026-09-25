import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readChatSkinConfig } from '../config';
import type { Logger } from '../log';
import type { RoadmapRunController } from '../orchestrator/roadmapRunController';
import { MAX_USER_ANSWER_LENGTH, parseUserAnswer } from '../orchestrator/roadmapQuestionMcp';
import { isValidIssueNumber, type RoadmapRunMode } from '../orchestrator/roadmapRunState';
import { chatCsp } from './chatCsp';
import { skinBodyClass } from './skin';

/** 盤面を送る間隔。`sessionKanbanView.ts`と同じく、最初はすぐ送り以降はまとめる。 */
const POST_INTERVAL_MS = 250;

/**
 * ロードマップ実行（Issue #1465）のKanban。runのノードを5列（未着手 / 実行可能 / 進行中 /
 * 要対応 / 終了）に並べ、ノードごとの実行・一時停止・停止・セッションを開く操作と、
 * モード・並列上限・run全体の停止と再開を受け付ける。
 *
 * 盤面の組み立ては`roadmapKanbanModel.ts`、操作の判断は`RoadmapRunController`が持つ。
 * webviewは信頼境界の外側として扱い、届いた値は形を確かめてから使う。
 */
export class RoadmapKanbanViewManager implements vscode.Disposable {
  static readonly viewType = 'agent.roadmapRunKanban';
  private panel: vscode.WebviewPanel | undefined;
  private dirty = false;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPostAt = 0;
  private selectedRunId: string | undefined;

  constructor(
    private readonly controller: RoadmapRunController,
    private readonly log: Logger,
  ) {}

  show(runId?: string): void {
    if (runId !== undefined) {
      this.selectedRunId = runId;
    }
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        RoadmapKanbanViewManager.viewType,
        'ロードマップ実行',
        vscode.ViewColumn.Beside,
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
    const board = this.controller.board(this.selectedRunId);
    void this.panel.webview.postMessage({ type: 'board', board });
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
      this.log.warn(`ロードマップ実行: 操作に失敗しました（${message.type as string}）: ${String(e)}`);
      void vscode.window.showErrorMessage('ロードマップ実行: 操作に失敗しました');
    });
  }

  private async handle(runId: string, message: Record<string, unknown>): Promise<void> {
    switch (message.type) {
      case 'setMode': {
        const mode = parseMode(message.mode);
        const maxParallel = message.maxParallel;
        if (mode === undefined || typeof maxParallel !== 'number') {
          return;
        }
        const result = await this.controller.setMode(runId, mode, maxParallel);
        if (!result.ok) {
          void vscode.window.showWarningMessage(`ロードマップ実行: ${result.message}`);
        }
        return;
      }
      case 'setHalted':
        if (typeof message.halted === 'boolean') {
          await this.controller.setHalted(runId, message.halted);
        }
        return;
      case 'openPullRequest':
        this.openPullRequest(message.url);
        return;
    }
    const issueNumber = message.issueNumber;
    if (typeof issueNumber !== 'number' || !isValidIssueNumber(issueNumber)) {
      return;
    }
    switch (message.type) {
      case 'runIssue':
        await this.runIssue(runId, issueNumber);
        return;
      case 'pauseIssue':
        await this.controller.pauseIssue(runId, issueNumber);
        return;
      case 'stopIssue':
        await this.stopIssue(runId, issueNumber);
        return;
      case 'answerQuestion':
        await this.answerQuestion(runId, issueNumber, message.questionId, message.answer);
        return;
      case 'revealIssue':
        if (!this.controller.revealIssue(runId, issueNumber)) {
          void vscode.window.showInformationMessage(
            `#${String(issueNumber)}のセッションは開いていません（再読み込みで閉じた場合は「再開」で開き直せます）`,
          );
        }
        return;
    }
  }

  /** 質問への回答。回答待ちでなくなっていれば（既に回答済み・実行回が終わった）知らせる。 */
  private async answerQuestion(
    runId: string,
    issueNumber: number,
    questionId: unknown,
    raw: unknown,
  ): Promise<void> {
    const answer = parseUserAnswer(raw);
    if (typeof questionId !== 'string' || answer === undefined) {
      void vscode.window.showWarningMessage(
        `ロードマップ実行: 回答は1〜${String(MAX_USER_ANSWER_LENGTH)}文字で入力してください`,
      );
      return;
    }
    if (!(await this.controller.answerQuestion(runId, issueNumber, questionId, answer))) {
      void vscode.window.showInformationMessage(
        `#${String(issueNumber)}の質問は回答待ちではありません（回答済み、または実行回が終わっています）`,
      );
    }
  }

  /** 依存が終わっていないノードは、確認のうえで上書きして始める。 */
  private async runIssue(runId: string, issueNumber: number): Promise<void> {
    const card = this.findCard(runId, issueNumber);
    if (card === undefined || !card.canRun) {
      return;
    }
    let override = false;
    if (card.needsOverride) {
      const unmet = card.dependsOn.filter((d) => !d.satisfied).map((d) => `#${String(d.issueNumber)}`);
      const choice = await vscode.window.showWarningMessage(
        `#${String(issueNumber)}の依存先（${unmet.join(', ')}）が終わっていません。依存を無視して始めますか？`,
        { modal: true },
        '依存を無視して始める',
      );
      if (choice !== '依存を無視して始める') {
        return;
      }
      override = true;
    }
    const outcome = await this.controller.startIssue(runId, issueNumber, override);
    if (!outcome.ok) {
      void vscode.window.showWarningMessage(`ロードマップ実行: ${outcome.message}`);
    }
  }

  private async stopIssue(runId: string, issueNumber: number): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `#${String(issueNumber)}を停止しますか？ worktreeとブランチは残り、後で再実行できます。`,
      { modal: true },
      '停止する',
    );
    if (choice === '停止する') {
      await this.controller.stopIssue(runId, issueNumber);
    }
  }

  private findCard(runId: string, issueNumber: number) {
    const board = this.controller.board(runId);
    if (board.run?.runId !== runId) {
      return undefined;
    }
    return Object.values(board.run.columns)
      .flat()
      .find((c) => c.issueNumber === issueNumber);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMode(value: unknown): RoadmapRunMode | undefined {
  return value === 'auto' || value === 'manual' ? value : undefined;
}

function render(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = chatCsp(webview.cspSource, nonce, { includeImgData: false });
  const skin = skinBodyClass(readChatSkinConfig());
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${styles}</style></head><body class="${skin}"><main><header><div><p class="eyebrow">ROADMAP RUN</p><h1>ロードマップ実行</h1><p class="description">ロードマップIssueの子Issueを依存順に実行します。自動実行では並列上限まで順に始め、ユーザー選択では「実行」を押したノードだけを始めます。PRを作ったノードはmerge待ちで止まります（mergeの自動化は未実装）。</p></div><div id="controls" class="controls"></div></header><section id="events" class="events" aria-live="polite"></section><section id="board" class="board" aria-label="ノードの状態"></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}

const styles = `
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
main { padding: 24px; max-width: 1600px; margin: 0 auto; }
header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 2px 0 6px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: .08em; margin: 0; } .description { color: var(--vscode-descriptionForeground); margin: 0; max-width: 720px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
.controls select, .controls input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; padding: 4px 6px; }
.controls input[type=number] { width: 56px; }
.btn { appearance: none; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.btn:focus-visible, .controls select:focus-visible, .controls input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.status { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 4px 10px; font-size: 12px; white-space: nowrap; } .status.warn { border-color: var(--vscode-charts-yellow); }
.events { display: grid; gap: 4px; margin-bottom: 16px; max-height: 120px; overflow-y: auto; font-size: 12px; }
.event { color: var(--vscode-descriptionForeground); } .event.warn { color: var(--vscode-charts-yellow); } .event time { margin-right: 8px; font-variant-numeric: tabular-nums; }
.board { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; align-items: start; }
.column { min-width: 0; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 10px; min-height: 200px; overflow: hidden; }
.column-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 700; } .count { margin-left: auto; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.cards { display: grid; gap: 9px; padding: 10px; min-width: 0; }
.card { min-width: 0; overflow: hidden; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; }
.card.attention { border-left: 4px solid var(--vscode-charts-yellow); } .card.running { border-left: 4px solid var(--vscode-charts-blue); }
.card-title { display: block; font-weight: 650; overflow-wrap: anywhere; }
.meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.badge { border: 1px solid var(--vscode-panel-border); border-radius: 999px; font-size: 11px; padding: 1px 7px; } .badge.warn { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); } .badge.ok { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
.dep.unmet { text-decoration: underline dotted; color: var(--vscode-charts-yellow); }
.failure { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.link { appearance: none; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); font: inherit; font-size: 12px; cursor: pointer; }
.empty { color: var(--vscode-descriptionForeground); font-size: 13px; padding: 16px 14px; }
.question { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; padding-top: 8px; font-size: 12px; }
.question-text { font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
.question-note { color: var(--vscode-descriptionForeground); margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.question textarea { width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
`;

// webview側のスクリプト。外部由来のテキストは`textContent`でだけ入れる（innerHTMLへ入れない）
const script = `
(function () {
  const vscode = acquireVsCodeApi();
  const COLUMNS = [['blocked', '未着手'], ['runnable', '実行可能'], ['running', '進行中'], ['attention', '要対応'], ['done', '終了']];
  const controls = document.getElementById('controls');
  const eventsEl = document.getElementById('events');
  const boardEl = document.getElementById('board');
  let current;
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
  function elapsed(card) {
    if (!card.startedAt) { return undefined; }
    const end = card.endedAt ? Date.parse(card.endedAt) : Date.now();
    const minutes = Math.max(0, Math.round((end - Date.parse(card.startedAt)) / 60000));
    return minutes < 60 ? minutes + '分' : Math.floor(minutes / 60) + '時間' + (minutes % 60) + '分';
  }
  function assessmentLabel(a) {
    switch (a.kind) {
      case 'finished': return ['すべて終了', ''];
      case 'progressing': return ['進行中', ''];
      case 'haltedByUser': return ['停止中', ''];
      case 'stalled': return ['人の対応待ち: ' + a.blockers.map(function (n) { return '#' + n; }).join(', '), 'warn'];
    }
    return ['', ''];
  }

  function renderControls(board) {
    controls.replaceChildren();
    if (board.runs.length > 0) {
      const select = el('select');
      select.setAttribute('aria-label', '表示するrun');
      board.runs.forEach(function (r) {
        const o = el('option', undefined, '#' + r.roadmapIssueNumber + ' ' + r.startedAt.slice(0, 16).replace('T', ' ') + (r.finished ? '（終了）' : ''));
        o.value = r.runId;
        o.title = r.workspaceRoot;
        if (board.run && board.run.runId === r.runId) { o.selected = true; }
        select.appendChild(o);
      });
      select.addEventListener('change', function () { vscode.postMessage({ type: 'selectRun', runId: select.value }); });
      controls.appendChild(select);
    }
    const run = board.run;
    if (!run) { return; }
    const status = assessmentLabel(run.assessment);
    controls.appendChild(el('span', 'status ' + status[1], status[0] + ' / セッション' + run.activeSessions));
    if (run.finished) { return; }
    const mode = el('select');
    mode.setAttribute('aria-label', 'モード');
    [['auto', '自動実行'], ['manual', 'ユーザー選択']].forEach(function (m) {
      const o = el('option', undefined, m[1]);
      o.value = m[0];
      if (run.mode === m[0]) { o.selected = true; }
      mode.appendChild(o);
    });
    const parallel = el('input');
    parallel.type = 'number'; parallel.min = '1'; parallel.max = '8'; parallel.step = '1';
    parallel.value = String(run.maxParallel);
    parallel.setAttribute('aria-label', '並列上限');
    controls.appendChild(mode);
    controls.appendChild(el('span', undefined, '並列'));
    controls.appendChild(parallel);
    controls.appendChild(button('適用', '', function () {
      send('setMode', { mode: mode.value, maxParallel: Number(parallel.value) });
    }));
    controls.appendChild(button(run.haltedByUser ? '再開' : '全体を停止', run.haltedByUser ? 'primary' : '', function () {
      send('setHalted', { halted: !run.haltedByUser });
    }));
  }

  function renderEvents(board) {
    eventsEl.replaceChildren();
    board.events.forEach(function (e) {
      const row = el('div', 'event ' + e.tone);
      row.appendChild(el('time', undefined, e.at.slice(11, 19)));
      row.appendChild(document.createTextNode(e.message));
      eventsEl.appendChild(row);
    });
  }

  function renderQuestion(card, q) {
    const box = el('div', 'question');
    box.appendChild(el('div', 'question-text', (q.blocking ? '[回答待ちで停止中] ' : '') + q.question));
    box.appendChild(el('div', 'question-note', '理由: ' + q.reason));
    if (q.evidence) { box.appendChild(el('div', 'question-note', '材料: ' + q.evidence)); }
    if (q.reflexSummary) { box.appendChild(el('div', 'question-note', 'Reflex: ' + q.reflexSummary)); }
    function answer(text) {
      drafts.delete(q.questionId);
      send('answerQuestion', { issueNumber: card.issueNumber, questionId: q.questionId, answer: text });
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
    const c = el('article', 'card ' + card.column);
    c.appendChild(el('span', 'card-title', '#' + card.issueNumber + ' ' + card.title));
    if (card.badges.length > 0) {
      const badges = el('div', 'badges');
      card.badges.forEach(function (b) { badges.appendChild(el('span', 'badge ' + b.tone, b.label)); });
      c.appendChild(badges);
    }
    const meta = el('div', 'meta');
    if (card.wave !== undefined && card.wave !== null) { meta.appendChild(el('span', undefined, 'wave ' + card.wave)); }
    if (card.dependsOn.length > 0) {
      const deps = el('span', undefined, '依存: ');
      card.dependsOn.forEach(function (d, i) {
        if (i > 0) { deps.appendChild(document.createTextNode(', ')); }
        deps.appendChild(el('span', 'dep' + (d.satisfied ? '' : ' unmet'), '#' + d.issueNumber));
      });
      meta.appendChild(deps);
    }
    const time = elapsed(card);
    if (time !== undefined) { meta.appendChild(el('span', undefined, time)); }
    if (card.pullRequest) {
      const pr = card.pullRequest;
      const link = el('button', 'link', 'PR #' + pr.number);
      link.type = 'button';
      link.title = pr.url;
      link.addEventListener('click', function () { send('openPullRequest', { url: pr.url }); });
      meta.appendChild(link);
    }
    if (meta.childNodes.length > 0) { c.appendChild(meta); }
    if (card.failure) { c.appendChild(el('div', 'failure', card.failure)); }
    const actions = el('div', 'actions');
    const target = { issueNumber: card.issueNumber };
    if (card.canRun) {
      actions.appendChild(button(card.needsOverride ? card.runLabel + '（依存を無視）' : card.runLabel, 'primary', function () { send('runIssue', target); }));
    }
    if (card.canPause) { actions.appendChild(button('一時停止', '', function () { send('pauseIssue', target); })); }
    if (card.canStop) { actions.appendChild(button('停止', '', function () { send('stopIssue', target); })); }
    if (card.canReveal) { actions.appendChild(button('セッションを開く', '', function () { send('revealIssue', target); })); }
    if (actions.childNodes.length > 0) { c.appendChild(actions); }
    card.questions.forEach(function (q) { c.appendChild(renderQuestion(card, q)); });
    return c;
  }

  function renderBoard(board) {
    boardEl.replaceChildren();
    if (!board.run) {
      boardEl.appendChild(el('p', 'empty', 'ロードマップの実行はまだありません。コマンド「Agent: ロードマップを実行」から始めてください。'));
      return;
    }
    const run = board.run;
    COLUMNS.forEach(function (col) {
      const cards = run.columns[col[0]];
      const column = el('section', 'column');
      const head = el('div', 'column-head');
      head.appendChild(el('span', undefined, col[1]));
      head.appendChild(el('span', 'count', String(cards.length)));
      column.appendChild(head);
      const list = el('div', 'cards');
      if (cards.length === 0) { list.appendChild(el('p', 'empty', 'なし')); }
      cards.forEach(function (card) { list.appendChild(renderCard(card)); });
      column.appendChild(list);
      boardEl.appendChild(column);
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || message.type !== 'board') { return; }
    current = message.board;
    renderControls(current);
    renderEvents(current);
    renderBoard(current);
  });
  vscode.postMessage({ type: 'ready' });
})();
`;
