/**
 * チャット画面のWebviewで動くスクリプト。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。壊れると画面全体が黙って
 * 動かなくなるため、`chatScript.test.ts` で構文だけは機械的に確かめている。
 * 文字列リテラルに改行を書くときは `\\n` と二重にエスケープすること（`\n` は
 * テンプレートリテラルの時点で実際の改行に展開され、リテラルが分断される）。
 */
export function chatScript(agentLabel: string): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  /** この会話で自分が送った発言。古い順。入力欄の履歴に使う。 */
  let sentTexts = [];

  const KIND_LABEL = {
    userMessage: 'あなた',
    agentMessage: '${agentLabel}',
    reasoning: '思考',
    commandExecution: 'コマンド',
    fileChange: 'ファイル変更',
    mcpToolCall: 'ツール',
    webSearch: 'Web検索',
    plan: '計画',
  };

  const CLASS_OF = {
    userMessage: 'user',
    agentMessage: 'agent',
    reasoning: 'reasoning',
    commandExecution: 'tool',
    fileChange: 'tool',
    mcpToolCall: 'tool',
  };

  // 全体を作り直すと選択中のテキストが消えてコピーできないため、要素を使い回す
  const nodes = new Map();

  function createNode(item) {
    const wrap = document.createElement('div');
    wrap.className = 'item ' + (CLASS_OF[item.kind] || '');

    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    head.appendChild(label);

    const actions = document.createElement('span');
    actions.className = 'actions';

    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'コピー';
    copy.hidden = true;
    copy.addEventListener('click', () => {
      const text = node.body.textContent || '';
      navigator.clipboard.writeText(text).then(
        () => {
          copy.textContent = 'コピーしました';
          setTimeout(() => (copy.textContent = 'コピー'), 1200);
        },
        () => (copy.textContent = 'コピーできません'),
      );
    });
    actions.appendChild(copy);

    const fork = document.createElement('button');
    fork.className = 'secondary';
    fork.textContent = 'ここから分岐';
    fork.hidden = true;
    fork.addEventListener('click', () => {
      if (!node.forkTarget) return;
      fork.disabled = true;
      vscode.postMessage({ type: 'fork', turnId: node.forkTarget });
    });
    actions.appendChild(fork);

    head.appendChild(actions);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'body';
    wrap.appendChild(body);

    const node = { wrap, label, body, copy, fork, forkTarget: undefined };
    return node;
  }

  function updateNode(node, item, forkTarget) {
    const bits = [KIND_LABEL[item.kind] || item.kind];
    if (item.detail) bits.push(item.detail);
    if (item.status) bits.push(item.status);
    const label = bits.join(' ・ ');
    if (node.label.textContent !== label) node.label.textContent = label;

    const text = item.text || '';
    if (node.body.textContent !== text) node.body.textContent = text;
    node.body.hidden = text === '';
    node.copy.hidden = text === '';

    // 分岐は「この指示の手前まで」。押した指示からやり直せるようにする
    node.forkTarget = forkTarget;
    node.fork.hidden = !(item.kind === 'userMessage' && forkTarget);
  }

  function syncItems(items) {
    const log = el('log');
    const seen = new Set();
    let previousTurnId;

    for (const item of items) {
      seen.add(item.id);
      let node = nodes.get(item.id);
      if (!node) {
        node = createNode(item);
        nodes.set(item.id, node);
        log.appendChild(node.wrap);
      }
      updateNode(node, item, item.kind === 'userMessage' ? previousTurnId : undefined);
      if (item.kind === 'userMessage' && item.turnId) previousTurnId = item.turnId;
    }

    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.wrap.remove();
        nodes.delete(id);
      }
    }
  }

  function renderApproval(approval) {
    const wrap = document.createElement('div');
    wrap.className = 'approval';

    const title = document.createElement('h3');
    title.textContent = approval.title;
    wrap.appendChild(title);

    if (approval.detail) {
      const pre = document.createElement('pre');
      pre.textContent = approval.detail;
      wrap.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [label, decision, secondary] of [
      ['許可', 'accept', false],
      ['この会話では常に許可', 'acceptForSession', true],
      ['拒否', 'decline', true],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (secondary) button.className = 'secondary';
      button.addEventListener('click', () => {
        actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
        vscode.postMessage({ type: 'approve', requestId: approval.requestId, decision });
      });
      actions.appendChild(button);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function defaultLabel(value) {
    return value ? '既定: ' + value : '既定';
  }

  function fillSelect(select, values, current, defaultText, labelOf) {
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defaultText;
    select.appendChild(def);
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labelOf ? labelOf(v) : v;
      select.appendChild(o);
    }
    if (current !== '' && !values.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current + ' (一覧外)';
      select.appendChild(o);
    }
    select.value = current;
  }

  function applySettings(s) {
    if (!s) return;
    const nameOf = (slug) => {
      const m = s.models.find((x) => x.slug === slug);
      return m ? m.displayName : slug;
    };
    const d = s.defaults || {};
    fillSelect(
      el('model'),
      s.models.map((m) => m.slug),
      s.model,
      defaultLabel(d.model ? nameOf(d.model) : ''),
      nameOf,
    );
    fillSelect(el('reasoningEffort'), s.efforts, s.reasoningEffort, defaultLabel(d.reasoningEffort));
    const approvalDefault = el('approvalMode').querySelector('option[value=""]');
    if (approvalDefault) approvalDefault.textContent = defaultLabel(d.approvalMode);
    el('approvalMode').value = s.approvalMode;
  }

  for (const key of ['model', 'reasoningEffort', 'approvalMode']) {
    el(key).addEventListener('change', (e) => {
      vscode.postMessage({ type: 'config', key, value: e.target.value });
    });
  }

  function apply(state) {
    // リロード後にVSCodeがパネルを復元したとき、どのスレッドかを思い出すために保持する
    if (state.threadId) {
      vscode.setState({ threadId: state.threadId });
    }
    sentTexts = state.items
      .filter((i) => i.kind === 'userMessage' && i.text.trim() !== '')
      .map((i) => i.text);
    applySettings(state.settings);
    const log = el('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    syncItems(state.items);
    // 承認カードは一時的なので作り直してよい（会話本文の選択は壊れない）
    const approvals = el('approvals');
    approvals.replaceChildren();
    for (const approval of state.approvals) approvals.appendChild(renderApproval(approval));
    if (atBottom) log.scrollTop = log.scrollHeight;

    el('stop').hidden = !state.busy;
    el('send').disabled = state.busy;
    applyLoop(state.loop);
    const bits = [];
    if (state.busy) bits.push('応答中…');
    const usageText = formatUsage(state.usage);
    if (usageText !== '') bits.push(usageText);
    el('status').textContent = bits.join(' ・ ');
  }

  // ループが止まった理由の説明。止まったことに気付けるよう、次を始めるまで残す。
  const LOOP_STOP_LABEL = {
    done: '条件が成立しました',
    maxReached: '指定した回数を送り終えました',
    failed: '応答が失敗したため止めました',
    manual: '停止しました',
    interrupted: '手動の操作が入ったため止めました',
  };

  function applyLoop(loop) {
    el('loopStart').disabled = !!(loop && loop.running);
    const bar = el('loopBar');
    if (!loop || (!loop.running && !loop.stopReason)) {
      bar.hidden = true;
      el('loopStop').hidden = true;
      return;
    }

    bar.hidden = false;
    el('loopStop').hidden = !loop.running;
    const count = loop.iteration + '/' + loop.maxIterations + '回目';
    if (loop.running) {
      const bits = ['ループ ' + count];
      if (loop.condition) bits.push('条件: ' + loop.condition);
      el('loopProgress').textContent = bits.join(' ・ ');
      return;
    }
    el('loopProgress').textContent =
      'ループ終了（' + count + '）・' + (LOOP_STOP_LABEL[loop.stopReason] || loop.stopReason);
  }

  el('loopToggle').addEventListener('click', () => {
    const panel = el('loop');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) el('loopContinue').focus();
  });

  el('loopStart').addEventListener('click', () => {
    const plan = {
      initialPrompt: el('loopInitial').value,
      continuePrompt: el('loopContinue').value,
      maxIterations: el('loopMax').value,
      condition: el('loopCondition').value,
    };
    if (!plan.continuePrompt.trim()) {
      el('loopContinue').focus();
      return;
    }
    el('loop').hidden = true;
    vscode.postMessage({ type: 'loop/start', plan });
  });

  el('loopStop').addEventListener('click', () => vscode.postMessage({ type: 'loop/stop' }));

  // 使用量の表記。Codexは消費率、Claude Codeは制限の種類とリセットまでの時間で示す。
  function formatUsage(usage) {
    if (!usage) return '';
    if (usage.usedPercent !== undefined) return '使用量 ' + Math.round(usage.usedPercent) + '%';

    const bits = [];
    if (usage.limitLabel) bits.push(usage.limitLabel + '制限');
    if (usage.limited) bits.push('到達');
    const resets = formatResetsIn(usage.resetsAt);
    if (resets !== '') bits.push('リセット ' + resets);
    return bits.join(' ');
  }

  function formatResetsIn(resetsAtEpochSeconds) {
    if (typeof resetsAtEpochSeconds !== 'number') return '';
    const minutes = Math.round((resetsAtEpochSeconds * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return 'まもなく';
    if (minutes < 60) return minutes + '分後';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + '時間後';
    return Math.round(hours / 24) + '日後';
  }

  function send() {
    const input = el('input');
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    resetHistory();
    vscode.postMessage({ type: 'send', text });
  }

  // 入力欄の履歴。この会話の自分の発言を新しい順にたどる。
  // -1 は「履歴に入っていない（編集中）」状態。
  let historyIndex = -1;
  let draft = '';

  function resetHistory() {
    historyIndex = -1;
    draft = '';
  }

  function historyEntries() {
    return sentTexts.slice().reverse();
  }

  /** カーソルが1行目にあるか。複数行の編集を邪魔しないための判定。 */
  function atFirstLine(input) {
    return input.value.lastIndexOf('\\n', Math.max(0, input.selectionStart - 1)) === -1;
  }

  function atLastLine(input) {
    return input.value.indexOf('\\n', input.selectionStart) === -1;
  }

  function applyHistory(input, index) {
    historyIndex = index;
    const entries = historyEntries();
    input.value = index === -1 ? draft : entries[index];
    // 呼び出した直後に続きを書けるよう末尾へ置く
    input.selectionStart = input.selectionEnd = input.value.length;
  }

  function stepHistory(input, direction) {
    const entries = historyEntries();
    if (entries.length === 0) return false;

    if (direction < 0) {
      if (historyIndex === -1) draft = input.value;
      if (historyIndex + 1 >= entries.length) return false;
      applyHistory(input, historyIndex + 1);
      return true;
    }

    if (historyIndex === -1) return false;
    applyHistory(input, historyIndex - 1);
    return true;
  }

  el('send').addEventListener('click', send);
  el('stop').addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  // 応答中のEscで中断する。画面のどこにフォーカスがあっても効くようにする
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el('stop').hidden) return;
    e.preventDefault();
    vscode.postMessage({ type: 'interrupt' });
  });

  el('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
      return;
    }

    const input = e.target;
    if (e.key === 'ArrowUp' && !e.altKey && atFirstLine(input) && stepHistory(input, -1)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && atLastLine(input) && stepHistory(input, 1)) {
      e.preventDefault();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') apply(event.data.state);
  });

  vscode.postMessage({ type: 'ready' });
`;
}
