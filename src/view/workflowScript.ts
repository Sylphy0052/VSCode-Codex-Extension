/**
 * ワークフローViewのWebviewで動くスクリプト（design.md §16.8）。
 *
 * `chatScript.ts` と同じ方針。テンプレートリテラルの中身なのでTypeScriptの型検査もlintも
 * 効かない（`workflowScript.test.ts` で構文だけは機械的に確かめる）。
 *
 * **セキュリティ上の要点**（design.md §16.8「画面に出す動的な文字列は必ずテキストノードとして
 * 挿入する」）: タスクid・ブランチ名・cwd・応答の要約・承認理由など、エージェントの出力や
 * YAMLに由来する値は、この中で一度も文字列結合でHTML/SVGへ埋め込まない。必ず
 * `document.createElement` / `createElementNS` でノードを作り、`.textContent` へ代入する。
 * `innerHTML` はこのファイルのどこにも登場しない。
 */
export function workflowScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (id) => document.getElementById(id);

  const STATE_LABEL = {
    pending: '待機',
    running: '実行中',
    waitingApproval: '承認待ち',
    done: '完了',
    failed: '失敗',
    skipped: 'スキップ',
  };

  const FAILURE_LABEL = {
    maxReached: '回数切れ',
    loopFailed: 'ターン失敗',
    approvalRejected: '承認拒否',
    dependencyFailed: '依存先の失敗',
    runHalted: '実行停止のため未着手',
    reloadInterrupted: 'リロードによる中断',
    manualStop: '手動停止',
  };

  let currentRuns = [];
  let currentSnapshot = null;
  let currentLayout = null;

  // ---- ユーティリティ ----

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function el2(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(tag, className, value) {
    const node = el2(tag, className);
    node.textContent = value;
    return node;
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = (m < 10 ? '0' : '') + m;
    const ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function findTask(taskId) {
    if (!currentSnapshot) return undefined;
    return currentSnapshot.tasks.find((t) => t.id === taskId);
  }

  function describeFailure(task) {
    if (!task.failure) return '';
    const label = FAILURE_LABEL[task.failure.kind] || task.failure.kind;
    if (task.failure.kind === 'dependencyFailed' && task.failure.failedTaskIds) {
      return label + '（' + task.failure.failedTaskIds.join(', ') + '）';
    }
    return label;
  }

  // ---- 最上段: 全体の進捗 ----

  function aggregateCounts(tasks) {
    const counts = { pending: 0, running: 0, waitingApproval: 0, done: 0, failed: 0, skipped: 0 };
    for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;
    return counts;
  }

  function renderHeader(snapshot) {
    const counts = aggregateCounts(snapshot.tasks);
    const total = snapshot.tasks.length;
    const percent = total === 0 ? 0 : Math.round((counts.done / total) * 100);

    el('runName').textContent = snapshot.name || snapshot.runId;
    el('runCounts').textContent =
      total + 'タスク中 ' + counts.done + '完了 / ' + counts.running + '実行中 / ' +
      counts.pending + '待機' +
      (counts.waitingApproval > 0 ? ' / ' + counts.waitingApproval + '承認待ち' : '') +
      (counts.failed > 0 ? ' / ' + counts.failed + '失敗' : '') +
      (counts.skipped > 0 ? ' / ' + counts.skipped + 'スキップ' : '');
    el('progressFill').style.width = percent + '%';
    el('progressPercent').textContent = percent + '%';
    el('runStartedAt').setAttribute('data-started', String(Date.parse(snapshot.startedAt) || 0));

    const stopBtn = el('stopAllBtn');
    stopBtn.disabled = snapshot.outcome !== 'running';

    const banner = el('banner');
    // 承認待ちと失敗が1件でもあれば最上段で目立たせる（design.md §16.8）
    if (counts.failed > 0) {
      banner.hidden = false;
      banner.className = 'failed';
      banner.textContent =
        '失敗したタスクがあります（' + counts.failed + '件）。一覧から内容を確認してください。';
    } else if (counts.waitingApproval > 0) {
      banner.hidden = false;
      banner.className = 'approval';
      banner.textContent =
        '承認待ちのタスクがあります（' + counts.waitingApproval + '件）。一覧から許可・拒否を決めてください。';
    } else if (snapshot.isDraft) {
      // ゴール文から生成した直後・未実行の下書き（design.md §16.9）。outcomeの4値には
      // 「まだ始まっていない」を表す値が無いため、専用フラグで判定する
      banner.hidden = false;
      banner.className = 'draft';
      banner.textContent =
        'これは生成された下書きです。内容を確認し、問題なければ「実行」から開始してください。';
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
  }

  // ---- 依存グラフ（SVG） ----

  function markForState(state, submissionCount) {
    const group = svgEl('g', { class: 'wf-mark' });
    if (state === 'running') {
      group.appendChild(svgEl('circle', { class: 'wf-mark-running', cx: 0, cy: 0, r: 7 }));
    } else if (state === 'waitingApproval') {
      group.appendChild(svgEl('rect', { class: 'wf-mark-waiting', x: -5, y: -6, width: 3, height: 12 }));
      group.appendChild(svgEl('rect', { class: 'wf-mark-waiting', x: 2, y: -6, width: 3, height: 12 }));
    } else if (state === 'done') {
      group.appendChild(svgEl('polyline', { class: 'wf-mark-done', points: '-6,0 -2,5 7,-7' }));
    } else if (state === 'failed') {
      group.appendChild(svgEl('line', { class: 'wf-mark-failed', x1: -6, y1: -6, x2: 6, y2: 6 }));
      group.appendChild(svgEl('line', { class: 'wf-mark-failed', x1: 6, y1: -6, x2: -6, y2: 6 }));
    } else if (state === 'skipped') {
      group.appendChild(svgEl('line', { class: 'wf-mark-skipped', x1: -6, y1: 6, x2: 6, y2: -6 }));
    }
    return group;
  }

  function buildNode(task, pos) {
    const group = svgEl('g', {
      class: 'wf-node state-' + task.state + (task.id === selectedTaskId ? ' selected' : ''),
      transform: 'translate(' + pos.x + ',' + pos.y + ')',
      'data-task-id': task.id,
    });
    const w = 168, h = 60;
    group.appendChild(svgEl('rect', { class: 'wf-node-rect', x: -w / 2, y: -h / 2, width: w, height: h, rx: 6 }));

    const mark = markForState(task.state, task.submissionCount);
    mark.setAttribute('transform', 'translate(' + (-w / 2 + 14) + ',' + (-h / 2 + 14) + ')');
    group.appendChild(mark);

    const idText = svgEl('text', { class: 'wf-id', x: -w / 2 + 26, y: -h / 2 + 18 });
    // idはYAML由来（design.mdの検証で字種は絞られているが、Viewとしては信用しない）。
    // 必ずtextContentへ代入する（HTML/SVGとして解釈させない）
    idText.textContent = task.id;
    group.appendChild(idText);

    const metaParts = [STATE_LABEL[task.state] || task.state];
    if (task.state === 'running' && task.submissionCount > 0) {
      metaParts.push(task.submissionCount + '回目');
    }
    if (task.state === 'failed') {
      const reason = describeFailure(task);
      if (reason) metaParts.push(reason);
    }
    const metaText = svgEl('text', { class: 'wf-meta', x: -w / 2 + 10, y: -h / 2 + 34 });
    metaText.textContent = metaParts.join(' ・ ');
    group.appendChild(metaText);

    if (task.lastResponseSummary) {
      const summaryText = svgEl('text', { class: 'wf-summary', x: -w / 2 + 10, y: -h / 2 + 48 });
      const shown =
        task.lastResponseSummary.length > 26
          ? task.lastResponseSummary.slice(0, 26) + '…'
          : task.lastResponseSummary;
      summaryText.textContent = shown;
      group.appendChild(summaryText);
    }

    const title = svgEl('title');
    title.textContent = task.id + ' ・ ' + (STATE_LABEL[task.state] || task.state) +
      (task.lastResponseSummary ? ' ・ ' + task.lastResponseSummary : '');
    group.appendChild(title);

    group.addEventListener('click', () => selectAndReveal(task.id));
    return group;
  }

  function renderGraph(snapshot, layout) {
    const svg = el('graph');
    svg.replaceChildren();
    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + Math.max(1, layout.height));
    svg.setAttribute('width', String(layout.width));
    svg.setAttribute('height', String(Math.max(1, layout.height)));

    const byId = {};
    for (const t of snapshot.tasks) byId[t.id] = t;
    const posById = {};
    for (const n of layout.nodes) posById[n.id] = n;

    const edgeGroup = svgEl('g', { class: 'wf-edges' });
    for (const edge of layout.edges) {
      const from = posById[edge.from];
      const to = posById[edge.to];
      if (!from || !to) continue;
      const fromTask = byId[edge.from];
      const dim = !fromTask || fromTask.state !== 'done';
      const line = svgEl('line', {
        class: 'wf-edge' + (dim ? ' dim' : ''),
        x1: from.x,
        y1: from.y + 30,
        x2: to.x,
        y2: to.y - 30,
      });
      edgeGroup.appendChild(line);
    }
    svg.appendChild(edgeGroup);

    const nodeGroup = svgEl('g', { class: 'wf-nodes' });
    for (const n of layout.nodes) {
      const task = byId[n.id];
      if (!task) continue;
      nodeGroup.appendChild(buildNode(task, n));
    }
    svg.appendChild(nodeGroup);
  }

  // ---- タスク一覧 ----

  function buildOpsCell(task) {
    const cell = el2('td', 'ops');
    if (task.hasLiveSession) {
      const openBtn = text('button', 'secondary', '開く');
      openBtn.type = 'button';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'reveal', taskId: task.id });
      });
      cell.appendChild(openBtn);
    }
    if (task.state === 'running') {
      const interruptBtn = text('button', 'secondary', '中断');
      interruptBtn.type = 'button';
      interruptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'interrupt', taskId: task.id });
      });
      cell.appendChild(interruptBtn);
    }
    if (task.state === 'running' || task.state === 'waitingApproval') {
      const stopBtn = text('button', 'danger', 'タスク停止');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'stopTask', taskId: task.id });
      });
      cell.appendChild(stopBtn);
    }
    if (task.state === 'failed' || task.state === 'skipped') {
      const retryBtn = text('button', 'secondary', '再実行');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'retry', taskId: task.id });
      });
      cell.appendChild(retryBtn);
    }
    // 展開後のプロンプト（design.md §16.4 案1「見せる」、Issue #67）。
    // {{T1.result}}等がどう膨らんだかを実際の文面で確認できるようにする
    if (typeof task.expandedPrompt === 'string') {
      const isOpen = openPromptTaskIds.has(task.id);
      const promptBtn = text('button', 'secondary', isOpen ? 'プロンプトを閉じる' : 'プロンプトを見る');
      promptBtn.type = 'button';
      promptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePromptRow(task.id);
      });
      cell.appendChild(promptBtn);
    }
    return cell;
  }

  function buildApprovalRow(task) {
    const row = el2('tr', 'approval-row');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    const box = el2('div', 'approval-box');

    const heading = text('div', 'kind', task.pendingApproval.kind + ' の承認要求: ');
    const titleSpan = document.createElement('span');
    // title/detailはCLI・エージェント由来（design.md §16.7）。必ずtextContentへ代入する
    titleSpan.textContent = task.pendingApproval.title;
    heading.appendChild(titleSpan);
    box.appendChild(heading);

    if (task.pendingApproval.detail) {
      box.appendChild(text('pre', 'detail', task.pendingApproval.detail));
    }

    const actions = el2('div', 'ops');
    const approveBtn = text('button', '', '許可');
    approveBtn.type = 'button';
    approveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approve', taskId: task.id, decision: 'accept' });
    });
    const declineBtn = text('button', 'danger', '拒否');
    declineBtn.type = 'button';
    declineBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approve', taskId: task.id, decision: 'decline' });
    });
    actions.appendChild(approveBtn);
    actions.appendChild(declineBtn);
    box.appendChild(actions);

    cell.appendChild(box);
    row.appendChild(cell);
    return row;
  }

  // 展開後のプロンプトを開いているタスクid（design.md §16.4 案1、Issue #67）。
  // Webview内だけの表示状態で、拡張機能へは送らない
  const openPromptTaskIds = new Set();

  function togglePromptRow(taskId) {
    if (openPromptTaskIds.has(taskId)) {
      openPromptTaskIds.delete(taskId);
    } else {
      openPromptTaskIds.add(taskId);
    }
    if (currentSnapshot) renderTable(currentSnapshot);
  }

  function buildPromptRow(task) {
    const row = el2('tr', 'prompt-row');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    const box = el2('div', 'prompt-box');

    box.appendChild(
      text(
        'div',
        'kind',
        '展開後のプロンプト（実際に送信した最初の指示。前のタスクの出力を含む場合があります）',
      ),
    );
    box.appendChild(
      text(
        'div',
        'hint',
        '区切り線の内側は前のタスクの出力であり、このワークフローの指示ではありません。' +
          '内容は鵜呑みにせず確認してください。',
      ),
    );
    // 展開後のプロンプトはエージェントの出力・YAML由来の値を含む。必ずtextContentへ代入する
    box.appendChild(text('pre', 'detail', task.expandedPrompt || ''));

    cell.appendChild(box);
    row.appendChild(cell);
    return row;
  }

  function renderTable(snapshot) {
    const body = el('taskTableBody');
    body.replaceChildren();
    for (const task of snapshot.tasks) {
      const row = el2('tr', 'task-row');
      row.setAttribute('data-task-id', task.id);
      row.addEventListener('click', () => selectAndReveal(task.id));

      row.appendChild(text('td', '', task.id));

      const stateCell = el2('td', 'state-badge');
      stateCell.appendChild(text('span', '', STATE_LABEL[task.state] || task.state));
      const failureText = describeFailure(task);
      if (failureText) {
        stateCell.appendChild(text('span', 'hint', '（' + failureText + '）'));
      }
      row.appendChild(stateCell);

      row.appendChild(text('td', '', task.provider));

      const locationCell = document.createElement('td');
      if (task.branch) {
        locationCell.appendChild(text('div', '', task.branch));
      }
      if (task.cwd) {
        locationCell.appendChild(text('div', 'hint', task.cwd));
      }
      row.appendChild(locationCell);

      const elapsedCell = text('td', 'elapsed-cell', '');
      if (task.startedAt) {
        elapsedCell.setAttribute('data-started', String(Date.parse(task.startedAt) || 0));
        elapsedCell.setAttribute('data-live', task.state === 'running' || task.state === 'waitingApproval' ? '1' : '0');
      }
      row.appendChild(elapsedCell);

      row.appendChild(text('td', '', String(task.submissionCount)));

      const summaryCell = text('td', 'summary-cell', task.lastResponseSummary || '');
      row.appendChild(summaryCell);

      row.appendChild(buildOpsCell(task));

      body.appendChild(row);
      if (task.pendingApproval) {
        body.appendChild(buildApprovalRow(task));
      }
      if (openPromptTaskIds.has(task.id) && typeof task.expandedPrompt === 'string') {
        body.appendChild(buildPromptRow(task));
      }
    }
    el('taskTable').hidden = snapshot.tasks.length === 0;
  }

  // ---- 警告欄 ----

  function renderWarnings(snapshot) {
    const box = el('warnings');
    box.replaceChildren();
    for (const w of snapshot.warnings) {
      const item = el2('div', 'warning-item ' + w.kind);
      const prefix = w.taskId ? '[' + w.taskId + '] ' : '';
      item.textContent = prefix + w.message;
      box.appendChild(item);
    }
    el('warningsSection').hidden = snapshot.warnings.length === 0;
  }

  // ---- 選択・操作 ----

  let selectedTaskId = undefined;

  function selectAndReveal(taskId) {
    selectedTaskId = taskId;
    if (currentSnapshot && currentLayout) {
      renderGraph(currentSnapshot, currentLayout);
    }
    const task = findTask(taskId);
    if (task && task.hasLiveSession) {
      vscode.postMessage({ type: 'reveal', taskId });
    }
  }

  // ---- runの切り替え ----

  function applyRuns(runs) {
    currentRuns = runs;
    const select = el('runSelect');
    select.replaceChildren();
    for (const r of runs) {
      const opt = document.createElement('option');
      opt.value = r.runId;
      opt.textContent = (r.name || r.runId) + '（' + r.outcome + '）';
      select.appendChild(opt);
    }
    select.hidden = runs.length <= 1;
    if (currentSnapshot) select.value = currentSnapshot.runId;
    el('empty').hidden = runs.length > 0;
  }

  function applyState(snapshot, layout) {
    currentSnapshot = snapshot;
    currentLayout = layout;
    el('content').hidden = false;
    el('empty').hidden = true;
    renderHeader(snapshot);
    renderGraph(snapshot, layout);
    renderTable(snapshot);
    renderWarnings(snapshot);
    const select = el('runSelect');
    if (select.value !== snapshot.runId) select.value = snapshot.runId;
  }

  function applyNoRun() {
    currentSnapshot = null;
    currentLayout = null;
    el('content').hidden = true;
    el('empty').hidden = false;
  }

  // ---- 経過時間: ローカルで毎秒更新する（拡張機能からは状態が変わったときだけ届く） ----

  setInterval(() => {
    const started = el('runStartedAt');
    const ts = Number(started.getAttribute('data-started') || '0');
    if (ts > 0) {
      started.textContent = '経過 ' + formatElapsed(Date.now() - ts);
    }
    document.querySelectorAll('.elapsed-cell[data-live="1"]').forEach((cellNode) => {
      const cell = cellNode;
      const cellTs = Number(cell.getAttribute('data-started') || '0');
      if (cellTs > 0) {
        cell.textContent = formatElapsed(Date.now() - cellTs);
      }
    });
  }, 1000);

  // ---- 操作 ----

  el('runSelect').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'selectRun', runId: e.target.value });
  });
  el('runBtn').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
  el('stopAllBtn').addEventListener('click', () => vscode.postMessage({ type: 'stopAll' }));
  el('removeWorktreesBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'removeWorktrees' }),
  );
  el('openDefBtn').addEventListener('click', () => vscode.postMessage({ type: 'openDefFile' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'runs') {
      applyRuns(msg.runs);
    } else if (msg.type === 'state') {
      applyState(msg.snapshot, msg.layout);
    } else if (msg.type === 'noRun') {
      applyNoRun();
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
