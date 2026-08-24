/**
 * 進捗画面（issue #721）のスタイル。
 *
 * `chatStyles.ts` と同じくテンプレートリテラルの中身で、型検査もlintも効かない。
 * 色は必ず `var(--vscode-*)` を使い、テーマに追随させる。
 */
export function progressStyles(): string {
  return `
  /*
   * hidden属性を常に効かせる。display指定のある要素はhiddenより詳細度が高く、
   * 隠したつもりの領域が出しっぱなしになるため一律に打ち消す（chatStyles.tsと同じ）。
   */
  [hidden] { display: none !important; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 16px 32px;
    max-width: 900px;
  }
  h1 { font-size: 1.2em; margin: 0 0 4px; }
  h2 {
    font-size: 1em;
    margin: 20px 0 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  #empty { color: var(--vscode-descriptionForeground); }
  #progressBar {
    height: 6px;
    margin-top: 8px;
    border-radius: 3px;
    background-color: var(--vscode-editorWidget-background);
    overflow: hidden;
  }
  #progressFill {
    height: 100%;
    width: 0;
    background-color: var(--vscode-progressBar-background);
  }
  ul { margin: 0; padding-left: 0; list-style: none; }
  li { padding: 2px 0; overflow-wrap: anywhere; }
  .todo { display: flex; gap: 6px; align-items: baseline; }
  .todo .mark { flex: none; width: 1.2em; color: var(--vscode-descriptionForeground); }
  .todo.completed .text {
    color: var(--vscode-descriptionForeground);
    text-decoration: line-through;
  }
  .todo.in_progress .text { color: var(--vscode-progressBar-background); }
  .path { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .turn {
    padding: 10px 0 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .turn .instruction {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 6px 8px;
    border-left: 2px solid var(--vscode-textLink-foreground);
    background-color: var(--vscode-textBlockQuote-background);
  }
  .turn .response {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-top: 6px;
    color: var(--vscode-descriptionForeground);
  }
  .turn .detail { margin-top: 6px; }
  .turn .detail .label {
    display: block;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .change.completed { color: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
  .change.removed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .busy { color: var(--vscode-progressBar-background); }
`;
}
