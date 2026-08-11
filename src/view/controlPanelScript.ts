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

  function mcpBadgeLabel(state) {
    if (state === 'connected') return '接続済み';
    if (state === 'disabled') return '無効';
    return '起動していません';
  }

  function renderMcpServer(cli, server) {
    const row = document.createElement('div');
    row.className = 'mcpServer';

    const head = document.createElement('div');
    head.className = 'mcpServer-head';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = server.state !== 'disabled';
    checkbox.addEventListener('change', () => {
      vscode.postMessage({
        type: 'toggleMcp',
        cli: cli,
        name: server.name,
        enabled: checkbox.checked,
      });
    });
    const name = document.createElement('span');
    name.className = 'mcpServer-name';
    name.textContent = server.name;
    label.appendChild(checkbox);
    label.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'mcpBadge mcpBadge-' + server.state;
    badge.textContent = mcpBadgeLabel(server.state);

    head.appendChild(label);
    head.appendChild(badge);
    row.appendChild(head);

    const bits = [];
    if (server.state === 'connected') {
      bits.push(server.toolCount + '個のツール');
      if (server.version) bits.push('v' + server.version);
    }
    if (server.state === 'unavailable') {
      bits.push(
        server.reason
          ? server.reason
          : '起動状況を確認できませんでした（無効化はされていません）',
      );
    }
    if (bits.length > 0) {
      const meta = document.createElement('div');
      meta.className = 'mcpServer-meta';
      meta.textContent = bits.join(' ・ ');
      row.appendChild(meta);
    }

    return row;
  }

  function renderMcp(cli, elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'mcpError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'MCPサーバー一覧を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    if (snapshot.servers.length === 0) {
      const p = document.createElement('p');
      p.className = 'mcpEmpty';
      p.textContent = 'MCPサーバーは設定されていません';
      container.appendChild(p);
      return;
    }

    for (const server of snapshot.servers) {
      container.appendChild(renderMcpServer(cli, server));
    }
  }

  function hookTrustLabel(trust) {
    if (trust === 'trusted') return '信頼済み';
    if (trust === 'untrusted') return '未信頼';
    if (trust === 'modified') return '変更あり(再信頼が必要)';
    if (trust === 'managed') return '管理者設定';
    return '';
  }

  function renderHook(hook) {
    const row = document.createElement('div');
    row.className = 'hookItem';

    const head = document.createElement('div');
    head.className = 'hookItem-head';

    const name = document.createElement('span');
    name.className = 'hookItem-name';
    name.textContent = hook.eventName + (hook.matcher ? ' (' + hook.matcher + ')' : '');
    head.appendChild(name);

    if (hook.trust && hook.trust !== 'unsupported') {
      const badge = document.createElement('span');
      badge.className = 'hookBadge hookBadge-' + hook.trust;
      badge.textContent = hookTrustLabel(hook.trust);
      head.appendChild(badge);
    }

    if (hook.enabled === false) {
      const disabledBadge = document.createElement('span');
      disabledBadge.className = 'hookBadge hookBadge-disabled';
      disabledBadge.textContent = '無効';
      head.appendChild(disabledBadge);
    }

    row.appendChild(head);

    if (hook.command) {
      const command = document.createElement('pre');
      command.className = 'hookItem-command';
      command.textContent = hook.command;
      row.appendChild(command);
    } else {
      const kind = document.createElement('div');
      kind.className = 'hookItem-meta';
      kind.textContent = '種別: ' + hook.handlerType;
      row.appendChild(kind);
    }

    const origin = document.createElement('div');
    origin.className = 'hookItem-meta';
    const originText = ['出どころ: ' + hook.origin];
    if (hook.originDetail) originText.push(hook.originDetail);
    if (hook.pluginId) originText.push('plugin: ' + hook.pluginId);
    origin.textContent = originText.join(' / ');
    row.appendChild(origin);

    if ((hook.trust === 'untrusted' || hook.trust === 'modified') && hook.trustHash) {
      const trustBtn = document.createElement('button');
      trustBtn.type = 'button';
      trustBtn.className = 'hookTrustButton';
      trustBtn.textContent = '信頼する';
      trustBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'trustHook', key: hook.key, hash: hook.trustHash });
      });
      row.appendChild(trustBtn);
    }

    return row;
  }

  function renderHooks(elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'hooksError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'hooks一覧を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    for (const warning of snapshot.warnings || []) {
      const w = document.createElement('p');
      w.className = 'hooksWarning';
      w.textContent = warning;
      container.appendChild(w);
    }

    if (snapshot.hooks.length === 0) {
      const p = document.createElement('p');
      p.className = 'hooksEmpty';
      p.textContent = 'hookは設定されていません';
      container.appendChild(p);
      return;
    }

    for (const hook of snapshot.hooks) {
      container.appendChild(renderHook(hook));
    }
  }

  function skillOriginLabel(origin) {
    if (origin === 'user') return 'ユーザー';
    if (origin === 'project') return 'プロジェクト';
    if (origin === 'plugin') return 'プラグイン';
    if (origin === 'system') return '同梱';
    if (origin === 'admin') return '管理者配布';
    return '不明';
  }

  function renderSkill(skill) {
    const row = document.createElement('div');
    row.className = 'skillItem';

    const head = document.createElement('div');
    head.className = 'skillItem-head';

    if (skill.toggleable) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = skill.enabled;
      checkbox.addEventListener('change', () => {
        vscode.postMessage({
          type: 'toggleSkill',
          path: skill.key,
          enabled: checkbox.checked,
        });
      });
      const name = document.createElement('span');
      name.className = 'skillItem-name';
      name.textContent = skill.name;
      label.appendChild(checkbox);
      label.appendChild(name);
      head.appendChild(label);
    } else {
      const name = document.createElement('span');
      name.className = 'skillItem-name';
      name.textContent = skill.name;
      head.appendChild(name);
      if (skill.enabled === false) {
        const disabledBadge = document.createElement('span');
        disabledBadge.className = 'skillBadge skillBadge-disabled';
        disabledBadge.textContent = '無効';
        head.appendChild(disabledBadge);
      }
    }

    const originBadge = document.createElement('span');
    originBadge.className = 'skillBadge skillBadge-' + skill.origin;
    originBadge.textContent = skillOriginLabel(skill.origin);
    head.appendChild(originBadge);

    row.appendChild(head);

    if (skill.description) {
      const desc = document.createElement('div');
      desc.className = 'skillItem-desc';
      desc.textContent = skill.description;
      row.appendChild(desc);
    }

    if (skill.originDetail) {
      const meta = document.createElement('div');
      meta.className = 'skillItem-meta';
      meta.textContent = skill.originDetail;
      row.appendChild(meta);
    }

    return row;
  }

  function renderSkills(elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'skillsError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'skills一覧を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    for (const warning of snapshot.warnings || []) {
      const w = document.createElement('p');
      w.className = 'skillsWarning';
      w.textContent = warning;
      container.appendChild(w);
    }

    if (snapshot.skills.length === 0) {
      const p = document.createElement('p');
      p.className = 'skillsEmpty';
      p.textContent = 'skillは設定されていません';
      container.appendChild(p);
      return;
    }

    for (const skill of snapshot.skills) {
      container.appendChild(renderSkill(skill));
    }
  }

  function renderAccount(elId, snapshot, renderActions) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'mcpError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'ログイン状態を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    const view = snapshot.account;
    const status = document.createElement('div');
    status.className = 'accountStatus';

    const badge = document.createElement('span');
    badge.className = 'mcpBadge ' + (view.loggedIn ? 'mcpBadge-connected' : 'mcpBadge-disabled');
    badge.textContent = view.loggedIn ? 'ログイン済み' : '未ログイン';
    status.appendChild(badge);

    const bits = [];
    if (view.method) bits.push(view.method);
    if (view.identity) bits.push(view.identity);
    if (view.plan) bits.push(view.plan);
    if (bits.length > 0) {
      const meta = document.createElement('span');
      meta.className = 'accountMeta';
      meta.textContent = bits.join(' ・ ');
      status.appendChild(meta);
    }
    container.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'accountActions';
    container.appendChild(actions);
    renderActions(actions, view);
  }

  function addAccountButton(actions, text, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    actions.appendChild(button);
    return button;
  }

  function addAccountNote(actions, text) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = text;
    actions.appendChild(note);
  }

  function renderCodexAccount(snapshot) {
    renderAccount('accountCodex', snapshot, function (actions, view) {
      if (view.loggedIn) {
        addAccountButton(actions, 'ログアウト', function () {
          vscode.postMessage({ type: 'logoutCodex' });
        });
        return;
      }
      addAccountButton(actions, 'APIキーでログイン', function () {
        vscode.postMessage({ type: 'loginCodexApiKey' });
      });
      addAccountButton(actions, 'ターミナルでChatGPTログインを開く', function () {
        vscode.postMessage({ type: 'openLoginTerminal', cli: 'codex' });
      });
      addAccountNote(
        actions,
        'ChatGPTアカウントでのログインはブラウザでの操作が必要なため、拡張機能内では完結できません。開いたターミナルに codex login が入力されるので、内容を確認してEnterを押してください（自動では実行しません）。',
      );
    });
  }

  function renderClaudeAccount(snapshot) {
    renderAccount('accountClaude', snapshot, function (actions, view) {
      if (view.loggedIn) {
        addAccountButton(actions, 'ログアウト', function () {
          vscode.postMessage({ type: 'logoutClaude' });
        });
        return;
      }
      addAccountButton(actions, 'ターミナルでログインを開く', function () {
        vscode.postMessage({ type: 'openLoginTerminal', cli: 'claude' });
      });
      addAccountNote(
        actions,
        'ログインはブラウザでの操作が必要なため、拡張機能内では完結できません。開いたターミナルに claude auth login が入力されるので、内容を確認してEnterを押してください（自動では実行しません）。APIキーでの非対話ログインの経路は見つかりませんでした。',
      );
    });
  }

  function apply(state) {
    applyUsage(state.usage);
    applyClaude(state.claude);
    renderCodexAccount(state.account);
    renderMcp('codex', 'mcpListCodex', state.mcpServers);
    renderHooks('hooksListCodex', state.hooks);
    renderSkills('skillsListCodex', state.skills);
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
    renderClaudeAccount(c.account);
    renderMcp('claude', 'mcpListClaude', c.mcpServers);
    renderHooks('hooksListClaude', c.hooks);
    renderSkills('skillsListClaude', c.skills);
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
