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
`;
}
