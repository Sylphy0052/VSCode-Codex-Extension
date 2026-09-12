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

  /** `ok: true` を前提に中身を取り出す（失敗していたらテストをそこで落とす）。 */
  function overlayOf(raw: unknown): Record<string, unknown> {
    const result = buildDisabledMcpServersOverlay(raw);
    if (!result.ok) {
      throw new Error(`予期しない失敗: ${result.reason}`);
    }
    return result.overlay;
  }

  it('設定のサーバと組み込みのサーバを、すべて無効化した形で返す', () => {
    const overlay = overlayOf(configRead);
    expect(Object.keys(overlay).sort()).toEqual(['codegraph', 'codex_apps', 'playwright']);
    for (const value of Object.values(overlay)) {
      // `enabled: false` だけでは、定義の無いサーバで `thread/start` が失敗する
      expect(value).toEqual({ enabled: false, command: 'true' });
    }
  });

  it('空のオーバーレイは返さない（それでは1本も無効化できない）', () => {
    expect(Object.keys(overlayOf(configRead)).length).toBeGreaterThan(0);
  });

  it('mcp_serversが無いのは正常（利用者が1つも定義していない）。組み込みだけを無効化する', () => {
    expect(Object.keys(overlayOf({ config: {} }))).toEqual([...BUILTIN_MCP_SERVER_NAMES]);
  });

  it('config/read が読めない形ならオーバーレイを組み立てない（Issue #1112）', () => {
    // マージであって置換ではないため、名前を挙げられなかったサーバは接続されたままになる。
    // 組み込み分だけを無効化して続けると、利用者設定のMCPが生きたまま相談が始まる
    for (const raw of [
      undefined,
      null,
      'broken',
      { config: null },
      { config: { mcp_servers: 3 } },
    ]) {
      const result = buildDisabledMcpServersOverlay(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
