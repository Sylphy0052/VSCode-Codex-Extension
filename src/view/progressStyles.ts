import { reducedMotionStyles } from './reducedMotion';

/**
 * 進捗画面（issue #721、見た目の作り直しは issue #781）のスタイル。
 *
 * `chatStyles.ts` と同じくテンプレートリテラルの中身で、型検査もlintも効かない。
 * 色は必ず `var(--vscode-*)` を使い、テーマに追随させる。
 *
 * アイコンはインラインSVG（`progressScript.ts` の `icon()`）で、`fill` / `stroke` に
 * `currentColor` を使う。codiconのフォントは使わない: `.vscodeignore` が
 * `node_modules/**` を落とし `vsce package --no-dependencies` で固めるため、
 * webviewUriで参照しても配布物に入らず黙って壊れる。
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
    padding: 0 16px 32px;
    max-width: 900px;
  }
  h1 { font-size: 1.2em; margin: 0; }
  h2 {
    font-size: 1em;
    margin: 20px 0 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  ul { margin: 0; padding-left: 0; list-style: none; }
  li { padding: 2px 0; overflow-wrap: anywhere; }

  /* アイコン。行の文字と一緒に並ぶ大きさに固定する */
  .icon {
    flex: none;
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
  }

  /* ---- 空表示 ---- */
  #empty {
    color: var(--vscode-descriptionForeground);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 0;
    text-align: center;
  }
  #empty .icon { width: 32px; height: 32px; opacity: 0.5; }
  #empty .hint { font-size: 0.9em; }

  /* ---- サマリー（スクロールしても残す） ---- */
  #summary {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 12px 0 10px;
    /* 下の内容が透けると数字が読めなくなるため、必ず不透明な背景を敷く */
    background-color: var(--vscode-editor-background, var(--vscode-sideBar-background));
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  #summaryHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  #statusBadge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.85em;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  #statusBadge .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: currentColor;
  }
  #statusBadge.busy .dot { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  /* ---- KPIのタイル ---- */
  #kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 8px;
  }
  .kpi {
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    background-color: var(--vscode-editorWidget-background);
  }
  .kpi-value {
    display: block;
    font-size: 1.5em;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .kpi-label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  /* ---- 進捗バー ---- */
  #progressRow {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  #progressBar {
    flex: 1;
    height: 10px;
    border-radius: 5px;
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    overflow: hidden;
  }
  #progressFill {
    height: 100%;
    width: 0;
    background-color: var(--vscode-progressBar-background);
    transition: width 200ms ease-out;
  }
  #progressFill.done { background-color: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
  /* 応答中は動いていることを示す。減光設定では reducedMotionStyles() が止める */
  #progressFill.busy {
    background-image: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.25) 0 6px,
      rgba(255, 255, 255, 0) 6px 12px
    );
    background-size: 24px 24px;
    animation: stripes 1s linear infinite;
  }
  @keyframes stripes {
    from { background-position: 0 0; }
    to { background-position: 24px 0; }
  }
  #progressPercent {
    flex: none;
    min-width: 3.2em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }

  /* ---- チェックリスト ---- */
  .todo { display: flex; gap: 6px; align-items: baseline; }
  .todo .mark { flex: none; color: var(--vscode-descriptionForeground); }
  .todo.completed .mark { color: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
  .todo.completed .text {
    color: var(--vscode-descriptionForeground);
    text-decoration: line-through;
  }
  .todo.in_progress .mark,
  .todo.in_progress .text { color: var(--vscode-progressBar-background); }

  /* ---- ファイルパス ---- */
  .path {
    display: flex;
    gap: 5px;
    align-items: baseline;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .path .dir { color: var(--vscode-descriptionForeground); }
  .path .name { color: var(--vscode-foreground); }
  .path .count {
    flex: none;
    padding: 0 5px;
    border-radius: 8px;
    font-family: var(--vscode-font-family);
    font-size: 0.85em;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  /* 実行したコマンド。ファイルと違い分解しないが、等幅で出す点は揃える */
  .command {
    display: flex;
    gap: 5px;
    align-items: baseline;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }
  .more {
    margin-top: 4px;
    padding: 2px 8px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background-color: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
  }
  .more:hover { background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }

  /* ---- タイムライン ---- */
  #timeline {
    position: relative;
    padding-left: 18px;
  }
  /* ターンをつなぐ縦線。ノードの丸（padding-left:18px から -17px、幅8px）と中心を揃える */
  #timeline::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background-color: var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .turn { padding: 8px 0; }
  .turn > summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    position: relative;
    list-style: none;
  }
  /* 既定の三角マーカーを消す（ノードの丸と二重に出るため） */
  .turn > summary::-webkit-details-marker { display: none; }
  .turn > summary::before {
    content: '';
    position: absolute;
    left: -17px;
    top: 0.35em;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--vscode-editor-background, var(--vscode-sideBar-background));
    border: 2px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    box-sizing: border-box;
  }
  .turn.latest > summary::before {
    border-color: var(--vscode-progressBar-background);
    background-color: var(--vscode-progressBar-background);
  }
  .turn > summary .title { font-weight: 600; }
  .turn > summary .preview {
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
  }
  .turn .body { padding: 6px 0 2px; }
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
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .change { display: flex; gap: 5px; align-items: baseline; }
  .change .mark { flex: none; }
  .change.completed .mark { color: var(--vscode-charts-green, var(--vscode-progressBar-background)); }
  .change.started .mark { color: var(--vscode-progressBar-background); }
  .change.added .mark { color: var(--vscode-descriptionForeground); }
  .change.removed { color: var(--vscode-descriptionForeground); }
  .change.removed .text { text-decoration: line-through; }
${reducedMotionStyles()}
`;
}
