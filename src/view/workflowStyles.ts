/**
 * ワークフローViewのスタイル（design.md §16.8）。
 *
 * `--vscode-*` 変数だけを使い、ライト/ダークの双方で読めるようにする。状態の区別は
 * 色だけに頼らず記号（`workflowScript.ts` がSVGで組み立てる）も添える。
 */
export function workflowStyles(): string {
  return `
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    padding: 10px 14px 20px;
  }
  h1, h2 { font-weight: 600; }
  h1 { font-size: 1.1em; margin: 0; }
  h2 { font-size: 0.95em; margin: 16px 0 6px; color: var(--vscode-descriptionForeground); }

  button {
    padding: 3px 10px;
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
  }
  button:hover { background-color: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-foreground);
    background-color: var(--vscode-button-secondaryBackground, transparent);
    border-color: var(--vscode-widget-border, transparent);
  }
  button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  button.danger { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  select {
    padding: 2px 4px;
    color: var(--vscode-dropdown-foreground);
    background-color: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-family: inherit;
  }

  /* ---- 最上段: 全体の進捗 ---- */
  #header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  #header .title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  #header .counts { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  #header .elapsed { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  #header .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  #progressBar {
    margin-top: 8px;
    height: 8px;
    border-radius: 4px;
    background-color: var(--vscode-progressBar-background, var(--vscode-editorWidget-border));
    opacity: 0.35;
  }
  #progressBar .fill {
    height: 100%;
    border-radius: 4px;
    opacity: 1;
    background-color: var(--vscode-charts-blue);
    transition: width 0.2s ease;
  }
  /* 承認待ち・失敗が1件でもあれば最上段で目立たせる（design.md §16.8） */
  #banner {
    margin-top: 8px;
    padding: 6px 10px;
    border-radius: 3px;
    border: 1px solid;
    font-size: 0.9em;
  }
  #banner.approval {
    border-color: var(--vscode-charts-yellow);
    color: var(--vscode-charts-yellow);
    background-color: color-mix(in srgb, var(--vscode-charts-yellow) 12%, transparent);
  }
  #banner.failed {
    border-color: var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
  }
  #banner.draft {
    border-color: var(--vscode-charts-blue);
    color: var(--vscode-charts-blue);
    background-color: color-mix(in srgb, var(--vscode-charts-blue) 12%, transparent);
  }
  /* 統合できていない(blocked)タスクがある（design.md §16.8「全体の進捗」・Issue #104） */
  #banner.blocked {
    border-color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
    background-color: color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 12%, transparent);
  }

  /* ---- 依存グラフ ---- */
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
  .graph-tools { display: flex; align-items: center; gap: 6px; }
  .graph-tools .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .graph-tools .zoom-label {
    min-width: 5.5em;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
  /* 縮小しても収まらない場合の逃げ道として、縦横どちらもスクロールできるようにする
     （高さは中身なりなので、通常は縦のスクロールバーは出ない） */
  #graphWrap { overflow: auto; padding: 8px 0; }
  #graph { display: block; }
  .wf-node-rect {
    fill: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    stroke: var(--vscode-widget-border, var(--vscode-descriptionForeground));
    stroke-width: 1.5;
    cursor: pointer;
  }
  .wf-node.state-pending .wf-node-rect { stroke: var(--vscode-descriptionForeground); }
  .wf-node.state-running .wf-node-rect { stroke: var(--vscode-charts-blue); stroke-width: 2.5; }
  .wf-node.state-waitingApproval .wf-node-rect { stroke: var(--vscode-charts-yellow); stroke-width: 2.5; }
  .wf-node.state-done .wf-node-rect {
    stroke: var(--vscode-charts-green);
    fill: color-mix(in srgb, var(--vscode-charts-green) 16%, var(--vscode-editorWidget-background));
  }
  .wf-node.state-failed .wf-node-rect { stroke: var(--vscode-errorForeground); stroke-width: 2; }
  .wf-node.state-skipped .wf-node-rect {
    stroke: var(--vscode-descriptionForeground);
    stroke-dasharray: 4 3;
  }
  /* waitingReply / merging / blocked（design.md §16.8「依存グラフ」の表・Issue #104） */
  .wf-node.state-waitingReply .wf-node-rect { stroke: var(--vscode-charts-yellow); stroke-width: 2.5; stroke-dasharray: 2 2; }
  .wf-node.state-merging .wf-node-rect {
    stroke: var(--vscode-charts-green);
    fill: color-mix(in srgb, var(--vscode-charts-green) 16%, var(--vscode-editorWidget-background));
  }
  .wf-node.state-blocked .wf-node-rect { stroke: var(--vscode-charts-yellow); stroke-width: 2.5; stroke-dasharray: 6 3; }
  .wf-node text { fill: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .wf-node .wf-id { font-weight: 600; font-size: 12px; }
  .wf-node .wf-meta { font-size: 10px; fill: var(--vscode-descriptionForeground); }
  .wf-node .wf-summary { font-size: 10px; fill: var(--vscode-descriptionForeground); }
  .wf-node.selected .wf-node-rect { stroke-width: 3; }

  .wf-mark-running {
    stroke: var(--vscode-charts-blue);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-dasharray: 3 4;
    transform-origin: center;
    animation: wf-spin 1.4s linear infinite;
  }
  @keyframes wf-spin { to { transform: rotate(360deg); } }
  .wf-mark-done { stroke: var(--vscode-charts-green); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .wf-mark-failed { stroke: var(--vscode-errorForeground); fill: none; stroke-width: 2; stroke-linecap: round; }
  .wf-mark-waiting { fill: var(--vscode-charts-yellow); }
  .wf-mark-skipped { stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; stroke-dasharray: 3 2; }
  /* waitingReply（吹き出し）・merging/blocked（合流の記号。design.md §16.8・Issue #104） */
  .wf-mark-reply { fill: none; stroke: var(--vscode-charts-yellow); stroke-width: 1.6; stroke-linejoin: round; }
  .wf-mark-merging { stroke: var(--vscode-charts-green); fill: none; stroke-width: 2; stroke-linecap: round; }
  .wf-mark-blocked { stroke: var(--vscode-charts-yellow); fill: none; stroke-width: 2; stroke-linecap: round; }
  .wf-mark-blocked-x { stroke: var(--vscode-errorForeground); stroke-width: 1.6; stroke-linecap: round; }
  .wf-merge-resolution-badge { fill: var(--vscode-charts-yellow); font-size: 9px; font-weight: 600; }

  .wf-edge { stroke: var(--vscode-descriptionForeground); stroke-width: 1.5; fill: none; }
  .wf-edge.dim { opacity: 0.35; }
  /* ノードを選んでいるあいだの強調（Issue #282）。関係する辺だけ濃く太く、
     それ以外は下げる。dimは依存元がまだ完了していないことを表す別の軸なので残す */
  .wf-edge.related { stroke: var(--vscode-charts-blue); stroke-width: 2.5; opacity: 1; }
  .wf-edge.faded { opacity: 0.12; }
  .wf-arrow-head { fill: var(--vscode-descriptionForeground); }
  .wf-arrow-head.related { fill: var(--vscode-charts-blue); }

  /* ---- タスク一覧 ---- */
  table#taskTable { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  #taskTable th, #taskTable td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
    vertical-align: top;
  }
  #taskTable th { color: var(--vscode-descriptionForeground); font-weight: 500; }
  #taskTable tr.task-row { cursor: pointer; }
  #taskTable tr.task-row:hover { background-color: var(--vscode-list-hoverBackground); }
  #taskTable .ops { display: flex; gap: 4px; flex-wrap: wrap; }
  #taskTable .state-badge { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }

  /* 状態のバッジ（Issue #280）。色はグラフのノード枠（.wf-node.state-*）と同じ配色を使い、
     図と一覧で同じ状態が同じ色に見えるようにする。文字は色だけに頼らず常に併記する */
  .state-pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.92em;
    white-space: nowrap;
    border: 1px solid transparent;
    background-color: color-mix(in srgb, var(--wf-state-color) 22%, var(--vscode-editor-background));
    border-color: color-mix(in srgb, var(--wf-state-color) 55%, transparent);
    color: var(--vscode-foreground);
    --wf-state-color: var(--vscode-descriptionForeground);
  }
  .state-pill.state-running { --wf-state-color: var(--vscode-charts-blue); }
  .state-pill.state-waitingApproval,
  .state-pill.state-waitingReply,
  .state-pill.state-blocked { --wf-state-color: var(--vscode-charts-yellow); }
  .state-pill.state-done,
  .state-pill.state-merging { --wf-state-color: var(--vscode-charts-green); }
  .state-pill.state-failed { --wf-state-color: var(--vscode-errorForeground); }
  #taskTable .summary-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #taskTable .hint, #integrationInfo .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }

  /* ---- 統合の状況（design.md §16.8「そのほか」・§16.17。Issue #104） ---- */
  #integrationInfo { display: flex; flex-direction: column; gap: 2px; font-size: 0.92em; }

  tr.approval-row td {
    background-color: color-mix(in srgb, var(--vscode-charts-yellow) 8%, transparent);
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .approval-box { padding: 4px 2px; }
  .approval-box .detail {
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    margin: 4px 0;
    max-height: 160px;
    overflow: auto;
  }

  /* ---- 展開後のプロンプト（design.md §16.4 案1「見せる」、Issue #67） ---- */
  tr.prompt-row td {
    background-color: color-mix(in srgb, var(--vscode-charts-blue) 6%, transparent);
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .prompt-box { padding: 4px 2px; }
  .prompt-box .detail {
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    margin: 4px 0;
    max-height: 320px;
    overflow: auto;
  }

  /* ---- 警告欄 ---- */
  #warnings { display: flex; flex-direction: column; gap: 4px; }
  .warning-item {
    padding: 4px 8px;
    border-left: 3px solid var(--vscode-charts-yellow);
    background-color: color-mix(in srgb, var(--vscode-charts-yellow) 8%, transparent);
    font-size: 0.88em;
  }
  .warning-item.allowOverride { border-left-color: var(--vscode-errorForeground); }
  .warning-item.plannerSecurity { border-left-color: var(--vscode-errorForeground); }
  .warning-item.permissionEscalation { border-left-color: var(--vscode-errorForeground); }
  /* タスク間メッセージング経由の権限差の警告（design.md §16.21、Issue #132）。
     permissionEscalationと同じ重大度として同じ色にする（経路が違うだけでリスクの質は同じ）。 */
  .warning-item.messagingPermissionEscalation { border-left-color: var(--vscode-errorForeground); }

  #empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
`;
}
