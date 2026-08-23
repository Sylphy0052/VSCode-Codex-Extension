/**
 * MCPサーバーの一覧・状態表示（TP-50、issue #27）で共有する型。
 *
 * CodexとClaude Codeでプロトコルの形はまったく違うが（`src/codex/mcpStatus.ts` /
 * `src/claude/control.ts` を参照）、画面へ渡す最終形はここへ揃える。
 * 設定パネル（`src/view/controlPanelScript.ts`）はこの形だけを見ればよい。
 */

/**
 * - `connected`: 有効で、接続できている
 * - `disabled`: 利用者が無効にしている（CLI側の設定）
 * - `unavailable`: 有効なのに接続できていない（起動失敗・応答待ちなど）
 */
export type McpServerState = 'connected' | 'disabled' | 'unavailable';

export interface McpServerView {
  name: string;
  state: McpServerState;
  /** 接続できているときのツール数。それ以外は 0。 */
  toolCount: number;
  version: string | undefined;
  /**
   * 失敗理由など、CLIから読み取れた場合だけ入る人が読める説明。
   *
   * Claude Codeの `mcp_status` は失敗理由をそのまま返すため埋まる。Codexの
   * `mcpServerStatus/list` にはこの情報が無く、失敗と無効化を区別できないため
   * 常に `undefined`（`src/codex/mcpStatus.ts` の実測コメントを参照）。
   */
  reason: string | undefined;
}

/**
 * 一覧を取得できたかどうかを型で分ける。
 *
 * 空配列（0件）と「取得に失敗した」を区別しないと、CLIが古い・app-serverが
 * 起動しないといった状況で「MCPサーバーは設定されていません」と誤って出してしまう
 * （design.md の「黙って何も起きない状態を作らない」に反する）。
 */
export type McpServersSnapshot =
  { ok: true; servers: McpServerView[] } | { ok: false; reason: string };

/** CLIの実際のサーバー名だけを許すごく単純な形。既存名を配線するだけなので緩め。 */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * 設定の書き込み先（keyPathやCLI引数）へそのまま埋め込む前の防御。
 *
 * サーバー名は一覧から選んだ既存の値しか渡らない想定だが、万一壊れた値が来ても
 * 設定ファイルの構造を壊す文字列（`.` を使ったキー注入など）を書き込まないための
 * ホワイトリスト。
 */
export function isValidMcpServerName(name: unknown): name is string {
  return typeof name === 'string' && MCP_SERVER_NAME_PATTERN.test(name);
}
