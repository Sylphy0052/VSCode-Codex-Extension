/**
 * Mission Control（Issue #2136）の見た目。
 *
 * 色はVS Codeのテーマ変数（`--vscode-*`）だけで決める。ピルの文字色は常に前景色にし、
 * 状態の色は枠と薄い背景にだけ使う（ライト・ダークのどちらでも文字が背景に沈まない）。
 * ハイコントラストでは背景の色を消し、`--vscode-contrastBorder`の枠で区切る。
 */
export const MISSION_CONTROL_STYLES = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
button, input, textarea, select { font: inherit; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.mc { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) minmax(260px, 38%); height: 100vh; }
.pane { min-width: 0; min-height: 0; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
.pane:last-child { border-right: 0; }
.pane-title { margin: 0; padding: 8px 10px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.rail-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 10px; color: inherit; background: none; border: 0; border-left: 2px solid transparent; text-align: left; cursor: pointer; }
.rail-item:hover { background: var(--vscode-list-hoverBackground); }
.rail-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
.rail-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: inherit; opacity: .8; font-variant-numeric: tabular-nums; }
.badge { min-width: 18px; padding: 0 5px; border-radius: 9px; text-align: center; font-size: 11px; font-weight: 700; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
.filters { display: grid; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
.seg { display: flex; gap: 2px; }
.seg button { flex: 1 1 0; padding: 2px 4px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 3px; cursor: pointer; }
.seg button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
.check { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--vscode-descriptionForeground); }
.center { display: grid; grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
.search { flex: 1 1 auto; min-width: 0; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }
.btn { padding: 3px 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 3px; cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-border, var(--vscode-button-background)); }
.btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.btn:disabled { opacity: .5; cursor: default; }
.btn kbd, .choice kbd { margin-right: 4px; opacity: .75; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.section { min-height: 0; overflow: auto; }
.section + .section { border-top: 1px solid var(--vscode-panel-border); }
.row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; padding: 5px 10px; border-left: 2px solid transparent; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-inactiveSelectionBackground); border-left-color: var(--vscode-focusBorder); }
.row.sent { opacity: .55; }
.row-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.row-sub { grid-column: 2 / 4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
.row-meta { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.group-title { position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; align-items: center; margin: 0; padding: 4px 10px; font-size: 12px; font-weight: 700; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; padding: 8px 10px; }
.grid .row { grid-template-columns: 18px minmax(0, 1fr); border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
.grid .row-meta, .grid .row-sub { grid-column: 1 / 3; }
.pill { --pill: var(--vscode-descriptionForeground); display: inline-block; padding: 0 7px; border: 1px solid var(--pill); border-radius: 9px; font-size: 11px; line-height: 16px; white-space: nowrap; color: var(--vscode-foreground); background: color-mix(in srgb, var(--pill) 18%, transparent); }
.pill.approvalPending { --pill: var(--vscode-charts-yellow); }
.pill.handoffPending { --pill: var(--vscode-charts-purple); }
.pill.running { --pill: var(--vscode-charts-blue); }
.pill.backgroundRunning { --pill: var(--vscode-charts-orange); }
.pill.idle { --pill: var(--vscode-descriptionForeground); }
.pill.error { --pill: var(--vscode-errorForeground); }
body.vscode-high-contrast .pill, body.vscode-high-contrast-light .pill { background: transparent; border-color: var(--vscode-contrastBorder, var(--pill)); }
body.vscode-high-contrast .row.selected, body.vscode-high-contrast-light .row.selected { outline: 1px dashed var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); }
.empty { padding: 10px; color: var(--vscode-descriptionForeground); }
.detail { padding: 10px; display: grid; gap: 10px; align-content: start; }
.detail h2 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.detail h3 { margin: 0 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.pre { margin: 0; padding: 6px 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 3px; max-height: 260px; overflow: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.choices { display: grid; gap: 4px; }
.choice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 6px; padding: 4px 8px; text-align: left; color: inherit; background: none; border: 1px solid var(--vscode-panel-border); border-radius: 3px; cursor: pointer; }
.choice:hover { background: var(--vscode-list-hoverBackground); }
.choice[aria-pressed="true"] { border-color: var(--vscode-focusBorder); background: var(--vscode-list-inactiveSelectionBackground); }
.choice-desc { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: 12px; }
.question { display: grid; gap: 6px; padding: 6px; border-left: 2px solid transparent; }
.question.active { border-left-color: var(--vscode-focusBorder); }
.text-input { width: 100%; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; resize: vertical; }
.error { color: var(--vscode-errorForeground); }
.notice { color: var(--vscode-descriptionForeground); }
.turn { border-left: 2px solid var(--vscode-panel-border); padding-left: 8px; }
.turn.user { border-left-color: var(--vscode-charts-blue); }
.turn-role { margin: 0; font-size: 11px; font-weight: 700; color: var(--vscode-descriptionForeground); }
.turn-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.help { position: fixed; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); }
.help-box { min-width: 280px; padding: 12px 16px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 6px; }
.help-box table { border-collapse: collapse; }
.help-box td { padding: 2px 10px 2px 0; }
.help-box kbd { font-family: var(--vscode-editor-font-family, monospace); }
.toast { position: fixed; right: 12px; bottom: 12px; padding: 6px 10px; border-radius: 4px; color: var(--vscode-notifications-foreground, var(--vscode-foreground)); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border)); }
.toast:empty { display: none; }
.pill.stalled { --pill: var(--vscode-charts-red); }
.row-out { grid-column: 2 / 4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-descriptionForeground); }
.grid .row-out { grid-column: 1 / 3; }
.composer { display: grid; gap: 4px; margin-top: 8px; }
.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
.launch-box { width: min(560px, 92vw); display: grid; gap: 8px; }
.launch-box label { display: grid; gap: 2px; }
.launch-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
`;
