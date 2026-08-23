import { describe, expect, it } from 'vitest';
import {
  mergeMcpServers,
  parseConfigMcpServersEnabled,
  parseMcpServerStatusList,
} from '../../src/codex/mcpStatus';

/** 実際の `mcpServerStatus/list`（detail: 'full'）応答を模したもの（codex-cli 0.147.0で実測）。 */
const statusListResult = {
  data: [
    {
      name: 'codegraph',
      serverInfo: { name: 'codegraph', title: null, version: '1.5.0', description: null },
      tools: { codegraph_explore: { name: 'codegraph_explore' } },
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    },
    {
      name: 'mcpprobe-fail',
      serverInfo: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    },
    {
      name: 'playwright',
      serverInfo: { name: 'playwright', version: '0.1.0' },
      tools: {
        browser_click: { name: 'browser_click' },
        browser_navigate: { name: 'browser_navigate' },
      },
      resources: [],
      resourceTemplates: [],
      authStatus: 'bearerToken',
    },
  ],
  nextCursor: null,
};

/** 実際の `config/read` 応答の一部を模したもの（`config.mcp_servers`）。 */
const configReadResult = {
  config: {
    mcp_servers: {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'], enabled: true },
      playwright: { command: 'npx', args: [], enabled: false },
      // mcpprobe-fail は enabled を書いていない = 既定で有効
      'mcpprobe-fail': { command: '/nonexistent/binary-xyz', args: ['--foo'] },
    },
  },
};

describe('parseMcpServerStatusList', () => {
  it('接続済みサーバーのツール数とバージョンを読む', () => {
    const map = parseMcpServerStatusList(statusListResult);
    expect(map.get('codegraph')).toEqual({ connected: true, toolCount: 1, version: '1.5.0' });
    expect(map.get('playwright')).toEqual({ connected: true, toolCount: 2, version: '0.1.0' });
  });

  it('serverInfoがnullのサーバーは未接続として読む', () => {
    const map = parseMcpServerStatusList(statusListResult);
    expect(map.get('mcpprobe-fail')).toEqual({
      connected: false,
      toolCount: 0,
      version: undefined,
    });
  });

  it('想定外の形では空を返す', () => {
    expect(parseMcpServerStatusList(undefined).size).toBe(0);
    expect(parseMcpServerStatusList(null).size).toBe(0);
    expect(parseMcpServerStatusList({}).size).toBe(0);
    expect(parseMcpServerStatusList({ data: 'x' }).size).toBe(0);
  });

  it('名前を持たないエントリは読み飛ばす', () => {
    const map = parseMcpServerStatusList({ data: [{ tools: {} }, null] });
    expect(map.size).toBe(0);
  });
});

describe('parseConfigMcpServersEnabled', () => {
  it('明示されたenabledを読む', () => {
    const map = parseConfigMcpServersEnabled(configReadResult);
    expect(map.get('codegraph')).toBe(true);
    expect(map.get('playwright')).toBe(false);
  });

  it('enabledを省略したサーバーは既定で有効として読む', () => {
    const map = parseConfigMcpServersEnabled(configReadResult);
    expect(map.get('mcpprobe-fail')).toBe(true);
  });

  it('mcp_serversが無ければ空を返す', () => {
    expect(parseConfigMcpServersEnabled({ config: {} }).size).toBe(0);
    expect(parseConfigMcpServersEnabled(undefined).size).toBe(0);
  });
});

describe('mergeMcpServers', () => {
  it('接続済み・無効化・起動失敗を突き合わせて分類する', () => {
    const statusList = parseMcpServerStatusList(statusListResult);
    const enabledMap = parseConfigMcpServersEnabled(configReadResult);
    const servers = mergeMcpServers(statusList, enabledMap);

    expect(servers).toEqual([
      { name: 'codegraph', state: 'connected', toolCount: 1, version: '1.5.0', reason: undefined },
      {
        name: 'mcpprobe-fail',
        state: 'unavailable',
        toolCount: 0,
        version: undefined,
        reason: undefined,
      },
      {
        name: 'playwright',
        state: 'disabled',
        toolCount: 0,
        version: undefined,
        reason: undefined,
      },
    ]);
  });

  it('無効化を有効な接続情報より優先する', () => {
    // config側で無効なのに、たまたま古いstatusデータが接続済みを示していても無効表示にする
    const statusList = new Map([['x', { connected: true, toolCount: 3, version: '1.0' }]]);
    const enabledMap = new Map([['x', false]]);
    expect(mergeMcpServers(statusList, enabledMap)).toEqual([
      { name: 'x', state: 'disabled', toolCount: 0, version: undefined, reason: undefined },
    ]);
  });

  it('configに現れないサーバーは既定で有効として扱う', () => {
    const statusList = new Map([['x', { connected: true, toolCount: 1, version: undefined }]]);
    const servers = mergeMcpServers(statusList, new Map());
    expect(servers[0]?.state).toBe('connected');
  });

  it('名前順に並べる', () => {
    const statusList = new Map([
      ['zebra', { connected: true, toolCount: 0, version: undefined }],
      ['alpha', { connected: true, toolCount: 0, version: undefined }],
    ]);
    const servers = mergeMcpServers(statusList, new Map());
    expect(servers.map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });
});
