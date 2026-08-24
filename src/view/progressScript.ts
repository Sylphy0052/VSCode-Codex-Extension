/**
 * 進捗画面（issue #721）のWebviewで動くスクリプト。
 *
 * `workflowScript.ts` と同じ方針。テンプレートリテラルの中身なのでTypeScriptの型検査も
 * lintも効かない（`progressScript.test.ts` で構文だけ機械的に確かめる）。
 *
 * セキュリティ上の要点: 指示・応答・ファイルパス・コマンド・TODOの本文はすべて
 * エージェントの出力に由来する。文字列結合でHTMLへ埋め込まず、必ず
 * `document.createElement` で作ったノードの `.textContent` へ入れる。
 * `innerHTML` はこのファイルのどこにも登場しない。
 */
export function progressScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);

  const TODO_MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  const CHANGE_LABEL = { added: '追加', started: '着手', completed: '完了', removed: '取り下げ' };

  function node(tag, className, value) {
    const created = document.createElement(tag);
    if (className !== '') {
      created.className = className;
    }
    if (value !== undefined) {
      created.textContent = value;
    }
    return created;
  }

  function clear(target) {
    while (target.firstChild !== null) {
      target.removeChild(target.firstChild);
    }
  }

  function renderChecklist(todos) {
    const list = el('checklist');
    clear(list);
    for (const todo of todos) {
      const row = node('li', 'todo ' + todo.status, undefined);
      row.appendChild(node('span', 'mark', TODO_MARK[todo.status] || '[ ]'));
      const label = todo.status === 'in_progress' && todo.activeForm !== '' ? todo.activeForm : todo.content;
      row.appendChild(node('span', 'text', label));
      list.appendChild(row);
    }
    el('checklistSection').hidden = todos.length === 0;
  }

  function renderFiles(files) {
    const list = el('files');
    clear(list);
    for (const path of files) {
      list.appendChild(node('li', 'path', path));
    }
    el('filesSection').hidden = files.length === 0;
  }

  function renderDetail(parent, label, values, className) {
    if (values.length === 0) {
      return;
    }
    const block = node('div', 'detail', undefined);
    block.appendChild(node('span', 'label', label));
    const list = node('ul', '', undefined);
    for (const value of values) {
      list.appendChild(node('li', className, value));
    }
    block.appendChild(list);
    parent.appendChild(block);
  }

  function renderTurn(turn) {
    const article = node('div', 'turn', undefined);
    article.appendChild(node('div', 'meta', 'ターン ' + (turn.index + 1)));
    if (turn.instruction !== '') {
      article.appendChild(node('div', 'instruction', turn.instruction));
    }
    if (turn.response !== '') {
      article.appendChild(node('div', 'response', turn.response));
    }

    const changes = node('div', 'detail', undefined);
    if (turn.todoChanges.length > 0) {
      changes.appendChild(node('span', 'label', 'TODOの変化'));
      const list = node('ul', '', undefined);
      for (const change of turn.todoChanges) {
        const row = node('li', 'change ' + change.kind, undefined);
        row.appendChild(node('span', 'mark', CHANGE_LABEL[change.kind] || change.kind));
        row.appendChild(node('span', 'text', ' ' + change.content));
        list.appendChild(row);
      }
      changes.appendChild(list);
      article.appendChild(changes);
    }

    renderDetail(article, '変更したファイル', turn.editedFiles, 'path');
    renderDetail(article, '実行したコマンド', turn.commands, 'path');
    return article;
  }

  function renderTimeline(turns) {
    const timeline = el('timeline');
    clear(timeline);
    for (const turn of turns) {
      timeline.appendChild(renderTurn(turn));
    }
    el('timelineSection').hidden = turns.length === 0;
  }

  function summaryText(summary) {
    const parts = [];
    parts.push(summary.turnCount + 'ターン');
    parts.push('変更ファイル ' + summary.editedFiles.length + '件');
    parts.push('コマンド ' + summary.commandCount + '件');
    if (summary.todoTotal > 0) {
      parts.push('TODO ' + summary.todoCompleted + '/' + summary.todoTotal);
    } else {
      parts.push('TODOなし');
    }
    parts.push(summary.busy ? '応答中' : '待機中');
    return parts.join(' ・ ');
  }

  function render(view) {
    if (view === undefined || view === null) {
      el('empty').hidden = false;
      el('summary').hidden = true;
      el('checklistSection').hidden = true;
      el('filesSection').hidden = true;
      el('timelineSection').hidden = true;
      return;
    }
    el('empty').hidden = view.summary.turnCount > 0;
    el('summary').hidden = false;
    const line = el('summaryLine');
    clear(line);
    line.appendChild(node('span', view.summary.busy ? 'busy' : '', summaryText(view.summary)));
    const done = view.summary.todoTotal === 0 ? 0 : view.summary.todoCompleted / view.summary.todoTotal;
    el('progressFill').style.width = Math.round(done * 100) + '%';

    renderChecklist(view.checklist);
    renderFiles(view.summary.editedFiles);
    renderTimeline(view.turns);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message === undefined || message === null || message.type !== 'progress') {
      return;
    }
    render(message.view);
  });

  // HTMLを入れた直後の送信は取りこぼすため、こちらから受け取れることを伝えてから初期表示を貰う
  vscode.postMessage({ type: 'ready' });
`;
}
