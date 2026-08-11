/**
 * 設定パネルのWebviewで動くスクリプト。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。壊れるとパネルが黙って
 * 動かなくなるため、`controlPanelScript.test.ts` で構文だけは機械的に確かめている。
 */
export function controlPanelScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  let models = [];

  function defaultLabel(value) {
    return value ? '既定: ' + value : '既定 (CLI側に指定なし)';
  }

  function setDefaultLabel(select, value) {
    const opt = select.querySelector('option[value=""]');
    if (opt) opt.textContent = defaultLabel(value);
  }

  function fill(select, values, current, defaultText, labelOf) {
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
    // 設定値がカタログに無い場合でも失わないよう選択肢として補う
    if (current !== '' && !values.includes(current)) {
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current + ' (一覧外)';
      select.appendChild(o);
    }
    select.value = current;
  }

  function applyUsage(u) {
    const box = el('usage');
    if (!u) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    el('usageLabel').textContent = u.windowLabel;
    el('usagePercent').textContent = u.percent + '%';
    const fill = el('usageFill');
    fill.style.width = Math.min(100, u.percent) + '%';
    fill.className = 'fill' + (u.severity === 'normal' ? '' : ' ' + u.severity);
    const meta = [];
    if (u.resets) meta.push('リセット ' + u.resets);
    if (u.plan) meta.push(u.plan);
    if (u.credits) meta.push('クレジット ' + u.credits);
    if (u.capturedAt) meta.push(u.capturedAt + ' 時点');
    el('usageMeta').textContent = meta.join(' ・ ');
  }

  function apply(state) {
    applyUsage(state.usage);
    applyClaude(state.claude);
    models = state.models;
    const nameOf = (slug) => {
      const m = models.find((x) => x.slug === slug);
      return m ? m.displayName : slug;
    };
    const d = state.defaults || {};
    fill(
      el('model'),
      models.map((m) => m.slug),
      state.model,
      defaultLabel(d.model ? nameOf(d.model) : ''),
      nameOf,
    );
    fill(
      el('reasoningEffort'),
      state.efforts,
      state.reasoningEffort,
      defaultLabel(d.reasoningEffort),
    );
    setDefaultLabel(el('approvalMode'), d.approvalMode);
    setDefaultLabel(el('sandbox'), d.sandbox);
    el('approvalMode').value = state.approvalMode;
    el('sandbox').value = state.sandbox;

    el('profileNote').textContent = state.profile
      ? 'プロファイル「' + state.profile + '」の適用時は上の既定と異なる場合があります。'
      : '';

    const selected = models.find((m) => m.slug === state.model);
    el('modelHint').textContent = selected && selected.description ? selected.description : '';
    const effort = selected && selected.efforts.find((e) => e.effort === state.reasoningEffort);
    el('effortHint').textContent = effort && effort.description ? effort.description : '';
  }

  function applyClaude(c) {
    if (!c) return;
    const d = c.defaults || {};
    const nameOf = (slug) => {
      const m = c.models.find((x) => x.slug === slug);
      return m ? m.displayName : slug;
    };
    fill(
      el('claudeModel'),
      c.models.map((m) => m.slug),
      c.model,
      defaultLabel(d.model ? nameOf(d.model) : ''),
      nameOf,
    );
    fill(el('claudeEffort'), c.efforts, c.effort, defaultLabel(d.effort));
    fill(el('claudePermissionMode'), c.permissionModes, c.permissionMode, defaultLabel(d.permissionMode));
    fill(
      el('claudeAgent'),
      (c.agents || []).map((a) => a.name),
      c.agent,
      defaultLabel(d.agent),
    );

    const selected = c.models.find((m) => m.slug === c.model);
    el('claudeModelHint').textContent = selected && selected.description ? selected.description : '';
    // effortを持たないモデル（haikuなど）では選ばせない。黙って無効にせず理由を出す
    const noEffort = !!selected && selected.supportsEffort === false;
    el('claudeEffort').disabled = noEffort;
    el('claudeEffortHint').textContent = noEffort ? 'このモデルはeffortを選べません' : '';

    const selectedAgent = (c.agents || []).find((a) => a.name === c.agent);
    el('claudeAgentHint').textContent =
      selectedAgent && selectedAgent.description ? selectedAgent.description : '';
  }

  // タブは1クリックで切り替える。選んだ側はリロードしても残す。
  function selectProvider(provider) {
    const claude = provider === 'claude';
    el('panelCodex').hidden = claude;
    el('panelClaude').hidden = !claude;
    el('tabCodex').setAttribute('aria-selected', String(!claude));
    el('tabClaude').setAttribute('aria-selected', String(claude));
    vscode.setState({ provider });
  }

  el('tabCodex').addEventListener('click', () => selectProvider('codex'));
  el('tabClaude').addEventListener('click', () => selectProvider('claude'));

  for (const key of ['model', 'reasoningEffort', 'approvalMode', 'sandbox']) {
    el(key).addEventListener('change', (e) => {
      vscode.postMessage({ type: 'update', key, value: e.target.value });
    });
  }

  for (const [id, key] of [
    ['claudeModel', 'model'],
    ['claudeEffort', 'effort'],
    ['claudePermissionMode', 'permissionMode'],
    ['claudeAgent', 'agent'],
  ]) {
    el(id).addEventListener('change', (e) => {
      vscode.postMessage({ type: 'updateClaude', key, value: e.target.value });
    });
  }

  el('newSession').addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession', provider: 'codex' });
  });

  el('newClaudeSession').addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession', provider: 'claude' });
  });

  selectProvider((vscode.getState() || {}).provider === 'claude' ? 'claude' : 'codex');

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      apply(event.data.state);
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
