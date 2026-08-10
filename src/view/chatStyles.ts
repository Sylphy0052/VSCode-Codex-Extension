/**
 * チャット画面のスタイル。
 *
 * テンプレートリテラルの中身なので型検査もlintも効かない。`hidden` を付けたのに
 * display指定に負けて出しっぱなしになる事故が続いたため、`webviewStyles.test.ts`
 * で打ち消し規則の有無と構文を確かめている。
 */
export function chatStyles(): string {
  return `
  html, body { height: 100%; margin: 0; }
  /*
   * hidden属性を常に効かせる。display指定のある要素は hidden より詳細度が高く、
   * 隠したつもりの領域が出しっぱなしになる事故が続いたため、ここで一律に打ち消す。
   */
  [hidden] { display: none !important; }
  body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  #log { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .item { margin-bottom: 12px; }
  .item .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 8px 10px;
    border-radius: 4px;
  }
  .user .body {
    background-color: var(--vscode-textBlockQuote-background);
    border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .agent .body { padding-left: 0; }
  .tool .body {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    background-color: var(--vscode-textCodeBlock-background);
    max-height: 240px;
    overflow: auto;
  }
  .reasoning .body { color: var(--vscode-descriptionForeground); font-style: italic; }
  .approval {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 4px;
    background-color: var(--vscode-inputValidation-warningBackground, transparent);
  }
  .approval h3 { margin: 0 0 6px; font-size: 1em; }
  .approval pre {
    margin: 0 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    padding: 4px 10px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background-color: var(--vscode-button-secondaryBackground);
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  #composer {
    position: relative;
    display: flex;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  textarea {
    flex: 1;
    min-height: 54px;
    max-height: 200px;
    resize: vertical;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #approvals { padding: 0 16px; }
  #commands {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 100%;
    max-height: 240px;
    overflow-y: auto;
    margin-bottom: 4px;
    padding: 4px 0;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background-color: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 10;
  }
  #commands .row {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 3px 10px;
    cursor: pointer;
  }
  #commands .row.active {
    background-color: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-list-activeSelectionForeground);
  }
  #commands .name { font-weight: 600; white-space: nowrap; }
  #commands .desc {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  #commands .row.active .desc { color: inherit; }
  #queue {
    margin: 0 16px 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    background-color: var(--vscode-editorWidget-background);
    font-size: 0.9em;
  }
  #queue .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--vscode-descriptionForeground);
  }
  #queue ol { margin: 0; padding-left: 1.4em; }
  #queue li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 2px 0;
  }
  #queue li span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #status { padding: 0 16px 6px; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .item .head .actions { display: flex; gap: 6px; flex: none; }
  .item .head .actions button { padding: 1px 8px; font-size: 0.85em; }
  /* 本文は選択してコピーできるようにする */
  .body { user-select: text; cursor: text; }
  #settings {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 0 16px 12px;
  }
  #settings label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #settings select {
    padding: 2px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #settings select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #loop {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  #loop label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #loop textarea { flex: none; min-height: 40px; }
  #loop input {
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #loop input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #loop .line { display: flex; gap: 12px; align-items: flex-end; }
  #loop .line label.grow { flex: 1; }
  #loop .line input[type='number'] { width: 72px; }
  #loopBar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
`;
}
