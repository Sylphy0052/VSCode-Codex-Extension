import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MCP_SERVER_NAMES,
  buildDisabledMcpServersOverlay,
} from '../../src/codex/mcpDisable';

/**
 * `thread/start` へ渡すMCP無効化オーバーレイ（Issue #944）。
 *
 * 実測（codex-cli 0.148.0）で分かっているのは次の3点で、この検査はそれを形として固定する。
 * - `mcp_servers: {}` では何も無効化されない（マージであって置換ではない）
 * - `config.toml` 由来のサーバは名前ごとに `enabled: false` を渡せば接続されなくなる
 * - `codex_apps` は `config/read` に現れず、`command` を添えないと `invalid transport` で
 *   `thread/start` 自体が失敗する
 */
describe('buildDisabledMcpServersOverlay', () => {
  const configRead = {
    config: {
      mcp_servers: {
        playwright: { command: 'npx', enabled: true },
        codegraph: { command: 'codegraph', enabled: true },
      },
    },
  };

  it('設定のサーバと組み込みのサーバを、すべて無効化した形で返す', () => {
    const overlay = buildDisabledMcpServersOverlay(configRead);
    expect(Object.keys(overlay).sort()).toEqual(['codegraph', 'codex_apps', 'playwright']);
    for (const value of Object.values(overlay)) {
      // `enabled: false` だけでは、定義の無いサーバで `thread/start` が失敗する
      expect(value).toEqual({ enabled: false, command: 'true' });
    }
  });

  it('空のオーバーレイは返さない（それでは1本も無効化できない）', () => {
    expect(Object.keys(buildDisabledMcpServersOverlay(configRead)).length).toBeGreaterThan(0);
  });

  it('config/read が読めない形でも、組み込みのサーバは無効化する', () => {
    for (const raw of [
      undefined,
      null,
      'broken',
      { config: null },
      { config: { mcp_servers: 3 } },
    ]) {
      expect(Object.keys(buildDisabledMcpServersOverlay(raw))).toEqual([
        ...BUILTIN_MCP_SERVER_NAMES,
      ]);
    }
  });
});
