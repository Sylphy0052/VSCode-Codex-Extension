import type { McpServerView } from '../provider/mcpServers';

/**
 * Codexの `mcpServerStatus/list` / `config/read` からMCPサーバー一覧を組み立てる。
 *
 * 実測（codex-cli 0.147.0、`codex app-server generate-json-schema --out` のスキーマも参照）:
 *
 * - `mcpServerStatus/list`（`ListMcpServerStatusParams { cursor?, detail?, limit?, threadId? }`
 *   → `ListMcpServerStatusResponse { data: McpServerStatus[], nextCursor? }`）は
 *   スレッドを開始していなくても呼べる。呼ぶとその場で（未接続なら）接続を試み、
 *   成功すれば `serverInfo` とツール定義一式が入って返る。
 * - **無効化されたサーバーと、起動に失敗したサーバーは、この応答だけでは区別できない**。
 *   どちらも `serverInfo: null, tools: {}` になり、失敗理由を持つフィールドが
 *   `McpServerStatus` 型自体に無い（実測で確認）。
 * - 失敗理由は `mcpServer/startupStatus/updated` 通知にしか乗らないが、この通知は
 *   `thread/start` した後、そのスレッド向けにしか届かない（実測: スレッド無しで
 *   8秒アイドル観察してもゼロ件）。設定パネルは会話を開かずに使うため、この通知には
 *   依存できない。したがって「有効なのに接続できない」状態は理由なしで示す
 *   （`state: 'unavailable'`、`reason` は常に `undefined`）。
 * - 有効/無効そのものは `mcpServerStatus/list` の応答に無いため、`config/read` の
 *   `config.mcp_servers.<name>.enabled` と突き合わせる（実測: `enabled` を明示しない
 *   サーバーもこの応答では `enabled: true` に正規化されて返る）。
 */

interface StatusEntry {
  connected: boolean;
  toolCount: number;
  version: string | undefined;
}

/** `mcpServerStatus/list` の応答から、サーバー名ごとの接続状況を読む。 */
export function parseMcpServerStatusList(raw: unknown): Map<string, StatusEntry> {
  const map = new Map<string, StatusEntry>();
  const data = rec(raw)?.['data'];
  if (!Array.isArray(data)) {
    return map;
  }

  for (const entry of data) {
    const e = rec(entry);
    const name = str(e?.['name']);
    if (name === '') {
      continue;
    }
    const serverInfo = rec(e?.['serverInfo']);
    const tools = rec(e?.['tools']);
    map.set(name, {
      connected: serverInfo !== undefined,
      toolCount: tools === undefined ? 0 : Object.keys(tools).length,
      version: serverInfo === undefined ? undefined : strOrUndefined(serverInfo['version']),
    });
  }
  return map;
}

/** `config/read` の応答から、サーバー名ごとの有効/無効を読む。省略時は既定で有効。 */
export function parseConfigMcpServersEnabled(raw: unknown): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const mcpServers = rec(rec(rec(raw)?.['config'])?.['mcp_servers']);
  if (mcpServers === undefined) {
    return map;
  }
  for (const [name, value] of Object.entries(mcpServers)) {
    map.set(name, rec(value)?.['enabled'] !== false);
  }
  return map;
}

/**
 * 2つの応答を突き合わせ、画面に出す一覧を組み立てる。
 * 名前で名寄せし、表示は名前順に揃える（応答の並びはページングで前後しうるため）。
 */
export function mergeMcpServers(
  statusList: Map<string, StatusEntry>,
  enabledMap: Map<string, boolean>,
): McpServerView[] {
  const names = new Set([...statusList.keys(), ...enabledMap.keys()]);
  const servers: McpServerView[] = [];

  for (const name of names) {
    const enabled = enabledMap.get(name) ?? true;
    if (!enabled) {
      servers.push({ name, state: 'disabled', toolCount: 0, version: undefined, reason: undefined });
      continue;
    }

    const status = statusList.get(name);
    if (status?.connected) {
      servers.push({
        name,
        state: 'connected',
        toolCount: status.toolCount,
        version: status.version,
        reason: undefined,
      });
      continue;
    }

    // 有効なのに接続できていない。理由はこの経路では取れない（上のコメント参照）
    servers.push({ name, state: 'unavailable', toolCount: 0, version: undefined, reason: undefined });
  }

  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
