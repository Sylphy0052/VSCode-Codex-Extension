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
.center { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar .seg button { white-space: nowrap; }
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
.launch-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 8px; }
.launch-grid label { display: grid; gap: 2px; }
.row.marked { box-shadow: inset 3px 0 var(--vscode-charts-blue, var(--vscode-focusBorder)); }
.mark { color: var(--vscode-charts-blue, var(--vscode-focusBorder)); font-weight: 700; text-align: center; }
.mark-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 10px; margin-bottom: 4px; background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.runs-pane { display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
.run-task { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.run-task.done { opacity: .55; }
.run-task .pill { margin-right: 4px; }
.issue-box { width: min(640px, 94vw); }
.history-box { width: min(720px, 94vw); display: grid; gap: 8px; }
.history-filter { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto auto; gap: 6px; }
.history-list { max-height: 50vh; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
/* フォーカスのあるペインを枠で示す。枠はペインの状態で描き、ペイン自身の標準の枠は消す */
.pane:focus { outline: none; }
.pane.pane-focused { box-shadow: inset 0 0 0 2px var(--vscode-focusBorder); }
.pane:focus-visible.pane-focused { box-shadow: inset 0 0 0 3px var(--vscode-focusBorder); }
button:focus-visible, .row:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* アクセスキーの表示（\`.\`で切り替え）。入力欄は::afterを描けないので囲みのlabelに出す */
.akeys [data-akey-badge]::after, .akeys [data-key-label]:not(:has(kbd)):not(input)::after { margin-left: 6px; padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; opacity: .8; }
.akeys [data-akey-badge]::after { content: attr(data-akey-badge); }
.akeys [data-key-label]:not(:has(kbd)):not(input)::after { content: attr(data-key-label); }
.palette-box { width: min(620px, 94vw); display: grid; gap: 6px; }
.palette-list { list-style: none; margin: 0; padding: 0; max-height: 55vh; overflow: auto; }
.palette-item { display: flex; justify-content: space-between; gap: 12px; padding: 3px 6px; border-radius: 3px; cursor: pointer; }
.palette-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.palette-item kbd { font-family: var(--vscode-editor-font-family, monospace); opacity: .8; }
/*
 * 段階8（Issue 2151）: カード表示・進み具合・密度。
 * 状態は色（--status）と形（アイコン・帯の模様）の両方で示す。色だけに頼らない:
 * 実行中=回る弧、停滞=三角＋帯が破線、入力待ち=円の感嘆符、要対応=「!」付きのバッジと太い帯。
 */
.session-row { --status: transparent; position: relative; transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease; animation: mc-enter .18s ease-out; }
.session-row::before { content: ""; position: absolute; top: 3px; bottom: 3px; left: 0; width: 3px; border-radius: 2px; background: var(--status); }
.session-row.status-running { --status: var(--vscode-charts-blue); }
.session-row.status-backgroundRunning { --status: var(--vscode-charts-orange); }
.session-row.status-approvalPending { --status: var(--vscode-charts-yellow); }
.session-row.status-handoffPending { --status: var(--vscode-charts-purple); }
.session-row.status-stalled { --status: var(--vscode-charts-red); }
.session-row.status-stalled::before { background: repeating-linear-gradient(180deg, var(--status) 0 4px, transparent 4px 7px); }
.session-row.attention::before { width: 5px; }
.row-facts { grid-column: 2 / 4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.grid .row-facts { grid-column: 1 / 3; }
.row-sub .badge { margin-left: 6px; }
.badge.attention { display: inline-block; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-charts-yellow) 28%, transparent); border: 1px solid var(--vscode-charts-yellow); line-height: 15px; }
.pane-title .badge { margin-left: 6px; letter-spacing: 0; }
.pill { display: inline-flex; align-items: center; gap: 3px; }
.pill .status-icon { width: 11px; height: 11px; stroke-width: 2; }
.status-icon .status-track { opacity: .3; }
.status-icon .status-fill { fill: currentColor; stroke: none; }
.status-icon.status-running, .status-icon.status-backgroundRunning { animation: mc-spin 1.1s linear infinite; transform-origin: 50% 50%; }
.session-row .pill { animation: mc-pop .25s ease-out; }
.row:not(.session-row) { transition: background-color .15s ease, border-color .15s ease; }
/* カード（グリッド）。帯は左端、カードの枠は状態の色を薄く混ぜる */
.grid .session-row { gap: 4px 8px; padding: 8px 10px 8px 12px; background: var(--vscode-editorWidget-background, transparent); border-color: color-mix(in srgb, var(--status) 45%, var(--vscode-panel-border)); }
.grid .session-row.status-idle { border-color: var(--vscode-panel-border); }
.grid .session-row.status-stalled { border-style: dashed; }
.grid .session-row .row-out { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
/* 上のカードの背景より後ろに置き、ホバーと選択の背景を一覧表示と同じく出す */
.grid .session-row:hover { background: var(--vscode-list-hoverBackground); }
.grid .session-row.selected { background: var(--vscode-list-inactiveSelectionBackground); border-color: var(--vscode-focusBorder); }
/* 工程バー（run） */
.run-progress { grid-column: 2 / 4; display: flex; gap: 2px; height: 6px; min-width: 0; margin-top: 2px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
/* 詳細は1列のgrid。行の列指定（2 / 4）を持ち込むと暗黙の列が増えて詳細全体が崩れる */
.detail .run-progress { grid-column: 1 / -1; height: 8px; }
.run-seg { flex: 1 1 0; min-width: 2px; }
.run-seg.done { background: var(--vscode-charts-green, var(--vscode-charts-blue)); }
.run-seg.active { box-shadow: inset 0 0 0 1px var(--vscode-charts-blue); }
.run-seg.warn { background: repeating-linear-gradient(135deg, var(--vscode-charts-yellow) 0 3px, transparent 3px 6px); box-shadow: inset 0 0 0 1px var(--vscode-charts-yellow); }
/* 空の状態の案内 */
.empty-guide p { margin: 0 0 6px; }
.empty-guide ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.empty-guide li { display: flex; align-items: center; gap: 8px; }
.empty kbd { min-width: 20px; padding: 0 5px; text-align: center; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-textCodeBlock-background, transparent); }
/* 密度: コンパクトでは余白を詰め、最後の発言と補足の行を隠す */
.mc.compact .row { padding-top: 2px; padding-bottom: 2px; }
.mc.compact .session-row .row-out, .mc.compact .session-row .row-facts { display: none; }
.mc.compact .grid { gap: 4px; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
.mc.compact .grid .session-row { padding: 4px 8px 4px 10px; }
.mc.compact .pane-title { padding-top: 4px; padding-bottom: 4px; }
.mc.compact .group-title { padding-top: 2px; padding-bottom: 2px; }
/* ハイコントラストでは塗りを消して枠と模様で示す */
body.vscode-high-contrast .badge.attention, body.vscode-high-contrast-light .badge.attention { background: transparent; border-color: var(--vscode-contrastBorder, var(--vscode-charts-yellow)); }
body.vscode-high-contrast .grid .session-row, body.vscode-high-contrast-light .grid .session-row { background: transparent; border-color: var(--vscode-contrastBorder, var(--vscode-panel-border)); }
body.vscode-high-contrast .run-progress, body.vscode-high-contrast-light .run-progress { background: transparent; outline: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); }
@keyframes mc-spin { to { transform: rotate(360deg); } }
@keyframes mc-enter { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
@keyframes mc-pop { from { opacity: .4; transform: scale(.92); } to { opacity: 1; transform: none; } }
/* 動きを減らす設定では、アニメーションと遷移をすべて止める（スピナーは弧の形だけが残る） */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;
