/**
 * 設定パネルのスタイル。
 *
 * チャット画面と同じく、`hidden` がdisplay指定に負けないよう打ち消し規則を持つ。
 */
export function controlPanelStyles(): string {
  return `
  /* hidden属性を常に効かせる（display指定に負けないように） */
  [hidden] { display: none !important; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px 12px 12px;
  }
  .row { margin-bottom: 12px; }
  label {
    display: block;
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  select {
    width: 100%;
    padding: 3px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .hint {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    min-height: 1em;
  }
  .usage {
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .usage-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
  }
  .usage-head .percent { font-weight: 600; }
  .bar {
    height: 4px;
    border-radius: 2px;
    background-color: var(--vscode-progressBar-background, var(--vscode-editorWidget-border));
    opacity: 0.35;
  }
  .bar .fill {
    height: 100%;
    border-radius: 2px;
    opacity: 1;
    background-color: var(--vscode-charts-blue);
  }
  .bar .fill.warning { background-color: var(--vscode-charts-yellow); }
  .bar .fill.critical { background-color: var(--vscode-charts-red); }
  button {
    width: 100%;
    padding: 5px 8px;
    margin-top: 2px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .tabs button {
    width: auto;
    flex: 1;
    margin-top: 0;
    padding: 4px 8px;
    color: var(--vscode-foreground);
    background-color: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    opacity: 0.7;
  }
  .tabs button:hover { background-color: var(--vscode-toolbar-hoverBackground, transparent); }
  .tabs button[aria-selected='true'] {
    opacity: 1;
    font-weight: 600;
    border-bottom-color: var(--vscode-focusBorder);
  }
  .note {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-widget-border, transparent);
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    line-height: 1.5;
  }
  .sectionTitle {
    margin: 16px 0 8px;
    padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border, transparent);
    font-size: 0.9em;
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .mcpList { display: flex; flex-direction: column; gap: 6px; }
  .mcpEmpty, .mcpError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .mcpError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .mcpServer {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px;
  }
  .mcpServer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mcpServer-name { font-weight: 600; }
  .mcpServer-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .mcpBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .mcpBadge-connected {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .mcpBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .mcpBadge-unavailable {
    color: var(--vscode-charts-red);
    border: 1px solid var(--vscode-charts-red);
  }
  .hooksList { display: flex; flex-direction: column; gap: 6px; }
  .hooksEmpty, .hooksError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .hooksError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .hooksWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .hookItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px;
  }
  .hookItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hookItem-name { font-weight: 600; }
  .hookItem-command {
    margin: 4px 0 0;
    padding: 4px 6px;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    background-color: var(--vscode-textCodeBlock-background, transparent);
    border-radius: 2px;
  }
  .hookItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    word-break: break-all;
  }
  .hookTrustButton {
    width: auto;
    margin-top: 6px;
    padding: 3px 10px;
  }
  .hookBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .hookBadge-trusted {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .hookBadge-untrusted, .hookBadge-modified {
    color: var(--vscode-charts-red);
    border: 1px solid var(--vscode-charts-red);
  }
  .hookBadge-managed, .hookBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .skillsList { display: flex; flex-direction: column; gap: 6px; }
  .skillsEmpty, .skillsError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .skillsError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .skillsWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .skillItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px;
  }
  .skillItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .skillItem-name { font-weight: 600; }
  .skillItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .skillItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .skillBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .skillBadge-user {
    color: var(--vscode-charts-blue);
    border: 1px solid var(--vscode-charts-blue);
  }
  .skillBadge-project {
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    border: 1px solid var(--vscode-charts-orange, var(--vscode-charts-yellow));
  }
  .skillBadge-plugin {
    color: var(--vscode-charts-purple, var(--vscode-charts-blue));
    border: 1px solid var(--vscode-charts-purple, var(--vscode-charts-blue));
  }
  .skillBadge-system, .skillBadge-admin, .skillBadge-unknown, .skillBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .accountBox { display: flex; flex-direction: column; gap: 6px; }
  .accountStatus {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .accountMeta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .accountActions .note { border-top: none; padding-top: 0; margin-top: 6px; }
  .pluginsList, .appsList { display: flex; flex-direction: column; gap: 6px; }
  .pluginsEmpty, .pluginsError, .appsEmpty, .appsError {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .pluginsError, .appsError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .pluginsWarning {
    color: var(--vscode-charts-yellow, var(--vscode-descriptionForeground));
    font-size: 0.85em;
  }
  .pluginItem, .appItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px;
  }
  .pluginItem-head, .appItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pluginItem-name, .appItem-name { font-weight: 600; }
  .pluginItem-desc, .appItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .pluginItem-meta, .appItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .pluginBadge, .appBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .pluginBadge-enabled, .appBadge-enabled {
    color: var(--vscode-charts-green);
    border: 1px solid var(--vscode-charts-green);
  }
  .pluginBadge-disabled, .appBadge-disabled {
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, var(--vscode-descriptionForeground));
  }
  .pluginItem-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .pluginItem-actions button, .pluginInstallButton {
    width: auto;
    padding: 3px 10px;
  }
  .sectionSubTitle {
    margin: 12px 0 6px;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  .importList, .importHistoryList { display: flex; flex-direction: column; gap: 6px; }
  .importEmpty, .importError, .importHistoryEmpty {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .importError { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
  .importItem, .importHistoryItem {
    padding: 6px 8px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 3px;
  }
  .importItem-head, .importHistoryItem-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .importItem-name { font-weight: 600; }
  .importItem-desc {
    margin-top: 4px;
    color: var(--vscode-foreground);
    font-size: 0.85em;
    line-height: 1.4;
    word-break: break-all;
  }
  .importItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    word-break: break-all;
  }
  .importBadge {
    font-size: 0.8em;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .importBadge-home {
    color: var(--vscode-charts-blue);
    border: 1px solid var(--vscode-charts-blue);
  }
  .importBadge-project {
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    border: 1px solid var(--vscode-charts-orange, var(--vscode-charts-yellow));
  }
  .importRunButton {
    width: auto;
    margin-top: 4px;
    padding: 5px 10px;
  }
  .importHistoryItem-time { font-weight: 600; }
  .importHistoryItem-provider {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
  .importHistoryItem-meta {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .importHistoryItem-failure {
    margin-top: 2px;
    color: var(--vscode-errorForeground, var(--vscode-charts-red));
    font-size: 0.8em;
    word-break: break-all;
  }
`;
}
