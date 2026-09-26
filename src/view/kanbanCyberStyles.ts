/**
 * Kanban画面のサイバー外装の土台（issue #1538）。
 *
 * 統括ページ（`sessionKanbanView.ts`）とオーケストレータモード（`taskRunKanbanView.ts`）の
 * 両方で使う。ネオン色・方眼・切り欠きの変数と、light・高コントラストテーマでの倒し方、
 * 背景の方眼だけを持ち、各画面の部品へ載せる規則は各画面の側に書く。
 * 規則はすべて `body.skin-cyber` の配下に置き、`plain` の見た目には触れない。
 *
 * 色の役割は会話画面と揃える（シアン=いま動いているもの、紫=補助、
 * マゼンタ=対応を待っているもの）。
 */
export const KANBAN_CYBER_BASE_STYLES = `
body.skin-cyber {
  --agent-neon-1: #4fe3ff;
  --agent-neon-2: #b388ff;
  --agent-neon-3: #ff5c8a;
  --agent-neon-edge: color-mix(in srgb, var(--agent-neon-1) 28%, var(--vscode-panel-border));
  --agent-neon-glow: color-mix(in srgb, var(--agent-neon-1) 45%, transparent);
  --agent-grid-line: color-mix(in srgb, var(--agent-neon-1) 7%, transparent);
  --agent-grid-step: 48px;
  --agent-panel-bg: color-mix(in srgb, var(--agent-neon-1) 4%, var(--vscode-editorWidget-background));
  /* パネル右上の切り欠き。0px にすると角が戻る（高コントラストテーマで使う） */
  --agent-notch: 12px;
  --agent-head-font: var(--vscode-editor-font-family, var(--vscode-font-family));
  --agent-head-tracking: .06em;
  --agent-scan-opacity: .5;
  /* 待機中カードの左のバー。他の種別は地の border-left をネオンで塗り直す */
  --agent-card-accent: color-mix(in srgb, var(--agent-neon-1) 35%, transparent);
}
/* lightテーマでは彩度と発光を落とす。白地では明るいネオンが本文より目立つ */
body.skin-cyber.vscode-light { --agent-neon-1: #0f7f9c; --agent-neon-2: #6b3fd4; --agent-neon-3: #c2185b; --agent-grid-line: color-mix(in srgb, var(--agent-neon-1) 5%, transparent); --agent-neon-glow: color-mix(in srgb, var(--agent-neon-1) 25%, transparent); --agent-panel-bg: color-mix(in srgb, var(--agent-neon-1) 2%, var(--vscode-editorWidget-background)); --agent-scan-opacity: .35; }
/*
 * 高コントラストテーマでは装飾を無効化する。規則を1つずつ名指しで消すと後から足した
 * 装飾が漏れるため、装飾が参照している変数を無色・無寸法へ倒す。
 */
body.skin-cyber.vscode-high-contrast, body.skin-cyber.vscode-high-contrast-light { --agent-neon-1: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); --agent-neon-2: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); --agent-neon-3: var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder)); --agent-neon-edge: var(--vscode-panel-border); --agent-neon-glow: transparent; --agent-grid-line: transparent; --agent-panel-bg: var(--vscode-editorWidget-background); --agent-notch: 0px; --agent-head-font: var(--vscode-font-family); --agent-head-tracking: normal; --agent-card-accent: transparent; }
/* 背景の方眼。1枚の背景画像で出すので要素は増えない */
body.skin-cyber { background-image: repeating-linear-gradient(to right, var(--agent-grid-line) 0 1px, transparent 1px var(--agent-grid-step)), repeating-linear-gradient(to bottom, var(--agent-grid-line) 0 1px, transparent 1px var(--agent-grid-step)); }
@keyframes agent-kanban-scanline { from { transform: translateY(0); } to { transform: translateY(100vh); } }
`;
