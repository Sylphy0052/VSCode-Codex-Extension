/**
 * 設定パネルのWebviewで動くスクリプト。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。壊れるとパネルが黙って
 * 動かなくなるため、`controlPanelScript.test.ts` で構文だけは機械的に確かめている。
 */
export function controlPanelScript(approvalLevelMetaJson: string): string {
  return `
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  let models = [];

  // 承認レベル（3段階）の表示名・説明・プロバイダごとの実効値。拡張機能側の
  // src/provider/approvalLevel.ts が唯一の定義元で、ここへは組み立て済みの値が入る
  const APPROVAL_LEVEL_META = ${approvalLevelMetaJson};

  /**
   * 承認レベルのセレクタと補足を現在の設定に合わせる。
   *
   * どのレベルとも一致しない設定（詳細で個別に指定した状態）のときだけ「カスタム」を
   * 選択肢へ足す。選ばせるためではなく、いまの状態を正しく見せるために出す。
   */
  function applyApprovalLevel(selectId, hintId, provider, level) {
    const select = el(selectId);
    const custom = select.querySelector('option[value=""]');
    if (level) {
      if (custom) custom.remove();
      select.value = level;
    } else {
      if (!custom) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'カスタム（詳細で個別に指定）';
        select.insertBefore(opt, select.firstChild);
      }
      select.value = '';
    }
    const meta = level ? APPROVAL_LEVEL_META[level] : undefined;
    el(hintId).textContent = meta
      ? meta.description + '（' + meta.effective[provider] + '）'
      : '承認の詳細で個別に指定されています';
  }

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

  // 折りたたまれたセクションの見出しに出す集計（issue #740）。
  // 何をどう数えるかはホスト側（controlPanelSummaries.ts）が済ませており、ここは
  // 受け取った文字列を置くだけ。まだ読み込んでいないセクションは載ってこないので、
  // 「読んでいないのに0件」と出ることはない
  function applySectionSummaries(summaries) {
    // 集計を出すセクションはHTML側のid="count-*"で決まる。ここを母数にすれば、
    // 集計が消えた（未読込へ戻った）セクションを消し忘れることが無い
    const targets = document.querySelectorAll('.sectionCount');
    for (const target of targets) {
      const sectionId = target.id.slice('count-'.length);
      const summary = summaries && summaries[sectionId];
      target.textContent = summary ? summary : '';
    }
  }

  // 帯（異常のまとめ、issue #741）を押したときの飛び先。applyAlertが最後に受け取った値を持つ
  let alertSectionId = '';
  // 折りたたまれたセクションの中にしか出ていない異常のまとめ（issue #741）。
  // 何を出すか・どれを優先するかの判定はホスト側（controlPanelAlerts.ts）が済ませており、
  // ここは受け取った1件を描くだけ。押すと該当セクションを開いてそこまで運ぶ
  function applyAlert(alert) {
    const banner = el('alertBanner');
    if (!banner) return;
    if (!alert) {
      banner.hidden = true;
      banner.className = '';
      banner.textContent = '';
      // 異常が消えたら飛び先も捨てる（帯は隠れているので押せないが、状態を残さない）
      alertSectionId = '';
      return;
    }
    banner.hidden = false;
    banner.className = alert.severity;
    banner.textContent = alert.message;
    alertSectionId = alert.sectionId;
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

  function formatProvides(provides) {
    if (!provides) return '';
    const parts = [];
    const labelOf = { skills: 'skills', agents: 'agents', hooks: 'hooks', mcpServers: 'MCPサーバー' };
    for (const key of ['skills', 'agents', 'hooks', 'mcpServers']) {
      const value = provides[key];
      parts.push(labelOf[key] + ': ' + (value === undefined || value === null ? '不明' : value + '件'));
    }
    return parts.join(' ・ ');
  }

  function renderPlugin(cli, plugin) {
    const row = document.createElement('div');
    row.className = 'pluginItem';

    const head = document.createElement('div');
    head.className = 'pluginItem-head';

    if (plugin.toggleable) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = plugin.enabled;
      checkbox.addEventListener('change', () => {
        vscode.postMessage({
          type: 'togglePlugin',
          cli: cli,
          id: plugin.key,
          scope: plugin.scope,
          enabled: checkbox.checked,
        });
      });
      const name = document.createElement('span');
      name.className = 'pluginItem-name';
      name.textContent = plugin.name;
      label.appendChild(checkbox);
      label.appendChild(name);
      head.appendChild(label);
    } else {
      const name = document.createElement('span');
      name.className = 'pluginItem-name';
      name.textContent = plugin.name;
      head.appendChild(name);
      const badge = document.createElement('span');
      badge.className = 'pluginBadge pluginBadge-' + (plugin.enabled ? 'enabled' : 'disabled');
      badge.textContent = plugin.enabled ? '有効' : '無効';
      head.appendChild(badge);
    }

    row.appendChild(head);

    if (plugin.description) {
      const desc = document.createElement('div');
      desc.className = 'pluginItem-desc';
      desc.textContent = plugin.description;
      row.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'pluginItem-meta';
    const metaBits = ['出どころ: ' + plugin.origin];
    if (plugin.version) metaBits.push('v' + plugin.version);
    meta.textContent = metaBits.join(' ・ ');
    row.appendChild(meta);

    const provides = document.createElement('div');
    provides.className = 'pluginItem-meta';
    provides.textContent = '提供するもの ・ ' + formatProvides(plugin.provides);
    row.appendChild(provides);

    if (plugin.removable) {
      const actions = document.createElement('div');
      actions.className = 'pluginItem-actions';
      const uninstallBtn = document.createElement('button');
      uninstallBtn.type = 'button';
      uninstallBtn.textContent = 'アンインストール';
      uninstallBtn.addEventListener('click', () => {
        vscode.postMessage({
          type: 'uninstallPlugin',
          cli: cli,
          id: plugin.key,
          scope: plugin.scope,
          name: plugin.name,
        });
      });
      actions.appendChild(uninstallBtn);
      row.appendChild(actions);
    }

    return row;
  }

  function renderPlugins(elId, cli, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'pluginsError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'plugin一覧を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    if (snapshot.installable) {
      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = 'pluginInstallButton';
      installBtn.textContent = 'plugin名を指定してインストール…';
      installBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'installPlugin', cli: cli });
      });
      container.appendChild(installBtn);
    }

    for (const warning of snapshot.warnings || []) {
      const w = document.createElement('p');
      w.className = 'pluginsWarning';
      w.textContent = warning;
      container.appendChild(w);
    }

    if (snapshot.plugins.length === 0) {
      const p = document.createElement('p');
      p.className = 'pluginsEmpty';
      p.textContent = 'pluginは導入されていません';
      container.appendChild(p);
      return;
    }

    for (const plugin of snapshot.plugins) {
      container.appendChild(renderPlugin(cli, plugin));
    }
  }

  function renderApp(app) {
    const row = document.createElement('div');
    row.className = 'appItem';

    const head = document.createElement('div');
    head.className = 'appItem-head';

    const name = document.createElement('span');
    name.className = 'appItem-name';
    name.textContent = app.name;
    head.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'appBadge appBadge-' + (app.enabled ? 'enabled' : 'disabled');
    badge.textContent = app.enabled ? '有効' : '無効';
    head.appendChild(badge);

    row.appendChild(head);

    if (app.description) {
      const desc = document.createElement('div');
      desc.className = 'appItem-desc';
      desc.textContent = app.description;
      row.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'appItem-meta';
    meta.textContent = app.callable ? '呼び出し可能' : '呼び出し不可';
    row.appendChild(meta);

    return row;
  }

  function renderApps(elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'appsError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'app一覧を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    if (snapshot.apps.length === 0) {
      const p = document.createElement('p');
      p.className = 'appsEmpty';
      p.textContent = 'appは導入されていません';
      container.appendChild(p);
      return;
    }

    for (const app of snapshot.apps) {
      container.appendChild(renderApp(app));
    }
  }

  // 他エージェントからの設定インポート（issue #36、design.md TP-57）。
  // チェックボックスで選んだ項目のkeyだけをホストへ送る。実際に送る生データ（CLIの
  // 応答そのもの）はホスト側（SettingsProvider）に留めており、webviewは持たない
  let importSelectedKeys = new Set();

  function importDetailKindLabel(kind) {
    const labels = {
      skills: 'skills',
      hooks: 'hooks',
      mcpServers: 'MCPサーバー',
      plugins: 'plugins',
      subagents: 'サブエージェント',
      commands: 'スラッシュコマンド',
      sessions: 'セッション',
      memory: 'メモリ',
    };
    return labels[kind] || kind;
  }

  function formatImportDetail(detail) {
    let text = importDetailKindLabel(detail.kind) + '(' + detail.count + '件)';
    if (detail.sampleNames.length === 0) return text;
    let names = detail.sampleNames.join('、');
    if (detail.moreCount > 0) names += ' ほか' + detail.moreCount + '件';
    return text + ': ' + names;
  }

  function importScopeLabel(scope) {
    return scope === 'home' ? 'ユーザー' : 'プロジェクト';
  }

  function renderImportItem(item, updateButton) {
    const row = document.createElement('div');
    row.className = 'importItem';

    const head = document.createElement('div');
    head.className = 'importItem-head';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = importSelectedKeys.has(item.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        importSelectedKeys.add(item.key);
      } else {
        importSelectedKeys.delete(item.key);
      }
      updateButton();
    });
    const name = document.createElement('span');
    name.className = 'importItem-name';
    name.textContent = item.label;
    label.appendChild(checkbox);
    label.appendChild(name);
    head.appendChild(label);

    const scopeBadge = document.createElement('span');
    scopeBadge.className = 'importBadge importBadge-' + item.scope;
    scopeBadge.textContent = importScopeLabel(item.scope);
    head.appendChild(scopeBadge);

    row.appendChild(head);

    if (item.description) {
      const desc = document.createElement('div');
      desc.className = 'importItem-desc';
      desc.textContent = item.description;
      row.appendChild(desc);
    }

    if (item.cwd) {
      const cwd = document.createElement('div');
      cwd.className = 'importItem-meta';
      cwd.textContent = 'プロジェクト: ' + item.cwd;
      row.appendChild(cwd);
    }

    for (const detail of item.details) {
      const meta = document.createElement('div');
      meta.className = 'importItem-meta';
      meta.textContent = formatImportDetail(detail);
      row.appendChild(meta);
    }

    return row;
  }

  function renderImport(elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'importError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'インポート候補を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    // 一覧が更新されて消えた項目の選択は捨てる
    const currentKeys = new Set(snapshot.items.map((item) => item.key));
    importSelectedKeys.forEach((key) => {
      if (!currentKeys.has(key)) importSelectedKeys.delete(key);
    });

    if (snapshot.items.length === 0) {
      const p = document.createElement('p');
      p.className = 'importEmpty';
      p.textContent = 'インポートできる項目は見つかりませんでした';
      container.appendChild(p);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'importRunButton';
    button.textContent = '選択した項目をインポート';
    const updateButton = () => {
      button.disabled = importSelectedKeys.size === 0;
    };

    for (const item of snapshot.items) {
      container.appendChild(renderImportItem(item, updateButton));
    }

    updateButton();
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'runCodexImport', keys: Array.from(importSelectedKeys) });
    });
    container.appendChild(button);
  }

  function renderImportHistoryEntry(entry) {
    const row = document.createElement('div');
    row.className = 'importHistoryItem';

    const head = document.createElement('div');
    head.className = 'importHistoryItem-head';
    const when = document.createElement('span');
    when.className = 'importHistoryItem-time';
    when.textContent = entry.completedAt || '(時刻不明)';
    head.appendChild(when);
    if (entry.providerId) {
      const provider = document.createElement('span');
      provider.className = 'importHistoryItem-provider';
      provider.textContent = entry.providerId;
      head.appendChild(provider);
    }
    row.appendChild(head);

    for (const result of entry.results) {
      const line = document.createElement('div');
      line.className = 'importHistoryItem-meta';
      line.textContent = result.label + ' ・ 成功' + result.successCount + '件 / 失敗' + result.failureCount + '件';
      row.appendChild(line);
      for (const message of result.failureMessages) {
        const failure = document.createElement('div');
        failure.className = 'importHistoryItem-failure';
        failure.textContent = message;
        row.appendChild(failure);
      }
    }

    return row;
  }

  function renderImportHistory(elId, snapshot) {
    const container = el(elId);
    container.replaceChildren();

    if (!snapshot || snapshot.ok !== true) {
      const p = document.createElement('p');
      p.className = 'importError';
      const reason = snapshot && snapshot.reason ? snapshot.reason : '不明なエラー';
      p.textContent = 'インポート履歴を取得できませんでした: ' + reason;
      container.appendChild(p);
      return;
    }

    if (snapshot.entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'importHistoryEmpty';
      p.textContent = 'インポートの実行履歴はありません';
      container.appendChild(p);
      return;
    }

    for (const entry of snapshot.entries) {
      container.appendChild(renderImportHistoryEntry(entry));
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
    // 取得中のセクションはホストがstate.loadingSectionsで知らせてくる（issue #225
    // レビュー指摘1）。複数セクションをすばやく開いたときに、別セクションの応答で
    // 「取得できませんでした」へ誤って上書きされないよう、取得中は読み込み中の表示を
    // 保つ
    const loadingSections = state.loadingSections || [];
    applyAlert(state.alert);
    applySectionSummaries(state.sectionSummaries);
    applyUsage(state.usage);
    applyClaude(state.claude, loadingSections);
    renderSection('codexAccount', loadingSections, () => renderCodexAccount(state.account));
    renderSection('codexMcp', loadingSections, () => renderMcp('codex', 'mcpListCodex', state.mcpServers));
    renderSection('codexHooks', loadingSections, () => renderHooks('hooksListCodex', state.hooks));
    renderSection('codexSkills', loadingSections, () => renderSkills('skillsListCodex', state.skills));
    renderSection('codexPlugins', loadingSections, () =>
      renderPlugins('pluginsListCodex', 'codex', state.plugins),
    );
    renderSection('codexApps', loadingSections, () => renderApps('appsListCodex', state.apps));
    renderSection('codexImport', loadingSections, () => {
      renderImport('importListCodex', state.importCandidates);
      renderImportHistory('importHistoryListCodex', state.importHistory);
    });
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
    applyApprovalLevel('approvalLevel', 'approvalLevelHint', 'codex', state.approvalLevel);

    el('profileNote').textContent = state.profile
      ? 'プロファイル「' + state.profile + '」の適用時は上の既定と異なる場合があります。'
      : '';

    const selected = models.find((m) => m.slug === state.model);
    el('modelHint').textContent = selected && selected.description ? selected.description : '';
    const effort = selected && selected.efforts.find((e) => e.effort === state.reasoningEffort);
    el('effortHint').textContent = effort && effort.description ? effort.description : '';
  }

  function applyClaude(c, loadingSections) {
    if (!c) return;
    renderSection('claudeAccount', loadingSections, () => renderClaudeAccount(c.account));
    renderSection('claudeMcp', loadingSections, () => renderMcp('claude', 'mcpListClaude', c.mcpServers));
    renderSection('claudeHooks', loadingSections, () => renderHooks('hooksListClaude', c.hooks));
    renderSection('claudeSkills', loadingSections, () => renderSkills('skillsListClaude', c.skills));
    renderSection('claudePlugins', loadingSections, () =>
      renderPlugins('pluginsListClaude', 'claude', c.plugins),
    );
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
    applyApprovalLevel('claudeApprovalLevel', 'claudeApprovalLevelHint', 'claude', c.approvalLevel);
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

  // セクションを開いたときの読み込み中の表示（issue #225）。応答が届くまでの間、
  // そのセクションの一覧部分だけを差し替える（見出しや説明文はそのまま残す）
  function renderLoading(elId) {
    const container = el(elId);
    container.replaceChildren();
    const p = document.createElement('p');
    p.className = 'sectionLoading';
    p.textContent = '読み込み中…';
    container.appendChild(p);
  }

  // 取得中のセクションは読み込み中のまま留め、無関係な応答で「取得できませんでした」に
  // 化けさせない（issue #225 レビュー指摘1）。取得中でなければ渡された描画関数をそのまま呼ぶ。
  // SECTION_CONTAINERSはこの関数より後で定義されるが、実際に呼ばれるのはmessageイベント
  // 経由（スクリプト全体の実行が終わった後）なので、参照時には初期化済みになっている
  function renderSection(sectionId, loadingSections, renderFn) {
    if (loadingSections.includes(sectionId)) {
      for (const containerId of SECTION_CONTAINERS[sectionId]) {
        renderLoading(containerId);
      }
      return;
    }
    renderFn();
  }

  // セクションの開閉状態は vscode.setState へ保存する（issue #225）。プロバイダの
  // 選択状態と同じstateオブジェクトを使う。setStateは丸ごと置き換えのため、
  // 保存のたびに両方をまとめて書く（片方だけ書くと、もう片方が消える）
  const persisted = vscode.getState() || {};
  let currentProvider = persisted.provider === 'claude' ? 'claude' : 'codex';
  const openSections =
    persisted.openSections && typeof persisted.openSections === 'object'
      ? Object.assign({}, persisted.openSections)
      : {};

  function saveState() {
    vscode.setState({ provider: currentProvider, openSections: openSections });
  }

  // タブは1クリックで切り替える。選んだ側はリロードしても残す。
  function selectProvider(provider) {
    currentProvider = provider;
    const claude = provider === 'claude';
    el('panelCodex').hidden = claude;
    el('panelClaude').hidden = !claude;
    el('tabCodex').setAttribute('aria-selected', String(!claude));
    el('tabClaude').setAttribute('aria-selected', String(claude));
    saveState();
  }

  el('tabCodex').addEventListener('click', () => selectProvider('codex'));
  el('tabClaude').addEventListener('click', () => selectProvider('claude'));

  for (const key of ['model', 'reasoningEffort', 'approvalMode', 'sandbox']) {
    el(key).addEventListener('change', (e) => {
      vscode.postMessage({ type: 'update', key, value: e.target.value });
    });
  }

  // 承認レベルは1つ選ぶと複数の設定項目へ展開される。空文字（カスタム）は選ばせない
  for (const [id, provider] of [
    ['approvalLevel', 'codex'],
    ['claudeApprovalLevel', 'claude'],
  ]) {
    el(id).addEventListener('change', (e) => {
      if (!e.target.value) return;
      vscode.postMessage({ type: 'updateApprovalLevel', provider, level: e.target.value });
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

  el('reloadClaudeSkills').addEventListener('click', () => {
    vscode.postMessage({ type: 'reloadClaudeSkills' });
  });

  // セクションごとの遅延取得（issue #225）。展開したときだけ拡張機能ホストへ
  // 識別子を送り、応答（stateメッセージ）が届くまでは読み込み中の表示を出す。
  // 一度取得した結果はホスト側（SettingsProvider）が保持するため、閉じて開き直す
  // だけではCLIを起動し直さない（取り直したいときはrefresh相当の既存操作を使う）
  const SECTION_CONTAINERS = {
    codexAccount: ['accountCodex'],
    codexMcp: ['mcpListCodex'],
    codexHooks: ['hooksListCodex'],
    codexSkills: ['skillsListCodex'],
    codexPlugins: ['pluginsListCodex'],
    codexApps: ['appsListCodex'],
    codexImport: ['importListCodex', 'importHistoryListCodex'],
    claudeAccount: ['accountClaude'],
    claudeMcp: ['mcpListClaude'],
    claudeHooks: ['hooksListClaude'],
    claudeSkills: ['skillsListClaude'],
    claudePlugins: ['pluginsListClaude'],
  };

  for (const sectionId of Object.keys(SECTION_CONTAINERS)) {
    const details = el('section-' + sectionId);
    // SECTION_CONTAINERSとHTML側のid="section-*"がずれていると要素が見つからない
    // （issue #225 レビュー指摘3）。nullチェック無しでaddEventListenerを呼ぶと
    // ここで例外が飛び、以降のループ・プロバイダ選択・messageリスナー登録・
    // readyの送信が一切実行されずパネル全体が黙って動かなくなる。1セクション欠けても
    // 残りは初期化できるよう、警告を出して次のセクションへ進む
    if (!details) {
      console.error('設定パネルの初期化: section-' + sectionId + ' が見つかりません');
      continue;
    }
    details.addEventListener('toggle', () => {
      openSections[sectionId] = details.open;
      saveState();
      if (details.open) {
        for (const containerId of SECTION_CONTAINERS[sectionId]) {
          renderLoading(containerId);
        }
        vscode.postMessage({ type: 'toggleSection', id: sectionId });
      }
    });
    // 前回開いていたセクションを復元する。プロパティへの代入でもtoggleイベントは
    // 発火するため、上の読み込み中の表示・ホストへの要求は自然に行われる
    if (openSections[sectionId]) {
      details.open = true;
    }
  }

  selectProvider(currentProvider);

  // ホストからの「このセクションを開け」の要求（issue #227）。webview→ホストの
  // toggleSectionとは逆向き（ホスト→webview）で、Codex画面のインポートボタンから
  // 「設定パネルを表示し、対象セクションを展開する」経路を作るために使う。
  // プロバイダのタブを切り替えたうえで対象のdetailsをopen=trueにするだけで、
  // 既存のtoggleイベント（上のループ）がtoggleSectionの送信・読み込み中表示を
  // 引き続き担う（新しく取得ロジックを重複させない）
  function openRequestedSection(sectionId) {
    const details = el('section-' + sectionId);
    if (!details) {
      console.error('設定パネル: openSectionで指定されたsection-' + sectionId + ' が見つかりません');
      return;
    }
    selectProvider(sectionId.indexOf('claude') === 0 ? 'claude' : 'codex');
    details.open = true;
    // 開いただけでは画面外のことがある（issue #741）。パネルは縦に長い
    details.scrollIntoView({ block: 'nearest' });
  }

  // 異常のまとめ（issue #741）を押したら、その異常があるセクションまで運ぶ。
  // 開く処理はホストからのopenSectionと同じ関数を通す（取得の要求・読み込み中の表示は
  // 既存のtoggleイベントが引き続き担う）
  const alertBanner = el('alertBanner');
  if (alertBanner) {
    alertBanner.addEventListener('click', () => {
      if (alertSectionId) openRequestedSection(alertSectionId);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      apply(event.data.state);
    }
    if (event.data && event.data.type === 'openSection') {
      openRequestedSection(event.data.id);
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
}
