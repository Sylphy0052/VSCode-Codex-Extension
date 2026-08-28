/**
 * スレッド1本ぶんのMCPサーバを全て無効化する `thread/start` オーバーレイの組み立て（Issue #944）。
 *
 * セカンドオピニオンとその要約は、渡した材料を読んで答えるだけの単発ターンで、MCPのツールを
 * 一切使わない。それでも既定では利用者の `config.toml` のサーバとCodex組み込みの `codex_apps`
 * が接続され、ツール定義がそのままターンへ載る。起動待ちとツール定義の分だけ遅くなる。
 *
 * 実測（codex-cli 0.148.0。`codex app-server` へ直接JSON-RPCを送って確認）:
 *
 * - 何も指定しないと4サーバ・計224ツールが接続される
 *   （playwright 24 / codegraph 1 / agentic-imagegen 16 / `codex_apps` 183）。
 * - `config.mcp_servers` は**マージ**であって置換ではない。`{}` を渡しても何も変わらない。
 * - サーバ名ごとに `enabled: false` を渡すと、`config.toml` 由来のサーバは接続されなくなる
 *   （`mcpServerStatus/list` で `serverInfo: null` / `tools: {}`）。
 * - `codex_apps` は `config.toml` に定義が無いため、`enabled` だけを渡すと
 *   `invalid transport` で `thread/start` 自体が失敗する。ダミーの `command` を添えると
 *   他と同じく無効化できる。`config/read` の `mcp_servers` にも現れないため、名前を明示的に足す。
 *
 * `vscode` には依存しない。`config/read` の生の応答を受け取り、オーバーレイを返すだけ。
 */

/**
 * `config/read` に現れないが既定で接続される、Codex組み込みのサーバ名。
 *
 * 現状は `codex_apps` の1つだけだが、同種のものが増えたときにここへ足せば済むよう配列で持つ。
 */
export const BUILTIN_MCP_SERVER_NAMES: readonly string[] = ['codex_apps'];

/**
 * 無効化のために添えるダミーのコマンド。
 *
 * `enabled: false` なので起動されることはない。`config.toml` に定義が無いサーバ
 * （`codex_apps`）でも設定として妥当な形にするためだけに置く。
 */
const DISABLED_TRANSPORT_COMMAND = 'true';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `config/read` の応答から、全てのMCPサーバを無効化するオーバーレイを組み立てる。
 *
 * 応答が読めない形でも、組み込みのサーバ分だけは無効化したオーバーレイを返す
 * （`config/read` に失敗したからといって、ツール224本を積んだまま走らせる理由は無い）。
 */
export function buildDisabledMcpServersOverlay(configReadResult: unknown): Record<string, unknown> {
  const configured = record(record(record(configReadResult)?.['config'])?.['mcp_servers']);
  const names = new Set<string>([...BUILTIN_MCP_SERVER_NAMES]);
  for (const name of Object.keys(configured ?? {})) {
    names.add(name);
  }
  const overlay: Record<string, unknown> = {};
  for (const name of names) {
    overlay[name] = { enabled: false, command: DISABLED_TRANSPORT_COMMAND };
  }
  return overlay;
}
