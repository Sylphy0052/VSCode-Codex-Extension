/** mcp_statusの設定を保持して、追加用mcp_set_serversを組み立てる。 */
export function mergeDynamicMcpServer(
  payload: Record<string, unknown> | undefined,
  name: string,
  config: { command: string; args: string[] },
): { servers: Record<string, unknown>; connected: boolean } {
  const entries = payload?.['mcpServers'];
  if (!Array.isArray(entries)) throw new Error('既存MCP設定を取得できませんでした');
  const servers: Record<string, unknown> = Object.create(null);
  let connected = false;
  for (const raw of entries) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof raw.name !== 'string' ||
      typeof raw.scope !== 'string'
    ) {
      throw new Error('既存MCPの設定範囲が不明なため、追加を中断しました');
    }
    if (raw.scope === 'dynamic') {
      if (typeof raw.config !== 'object' || raw.config === null) {
        throw new Error('既存の動的MCP設定を保持できないため、追加を中断しました');
      }
      servers[raw.name] = raw.config;
    }
    if (raw.name === name) {
      if (
        raw.scope !== 'dynamic' ||
        raw.config?.command !== config.command ||
        JSON.stringify(raw.config?.args) !== JSON.stringify(config.args) ||
        (raw.config?.type !== undefined && raw.config.type !== 'stdio')
      ) {
        throw new Error(`同名のMCP「${name}」が別の設定で存在します`);
      }
      connected = raw.status === 'connected' && Array.isArray(raw.tools) && raw.tools.length > 0;
    }
  }
  // 同じ接続が既にある場合はenvなどの追加設定もそのまま残す。
  servers[name] ??= { type: 'stdio', ...config };
  return { servers, connected };
}
