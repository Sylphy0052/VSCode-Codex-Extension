import { describe, expect, it } from 'vitest';
import { isValidMcpServerName } from '../../src/provider/mcpServers';

describe('isValidMcpServerName', () => {
  it('実在の形のサーバー名を許可する', () => {
    expect(isValidMcpServerName('codegraph')).toBe(true);
    expect(isValidMcpServerName('playwright-mcp')).toBe(true);
    expect(isValidMcpServerName('my.server_01')).toBe(true);
  });

  it('設定のキーパスを壊しうる値を拒否する', () => {
    expect(isValidMcpServerName('')).toBe(false);
    expect(isValidMcpServerName('a b')).toBe(false);
    expect(isValidMcpServerName('.hidden')).toBe(false);
    expect(isValidMcpServerName('a/b')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isValidMcpServerName(undefined)).toBe(false);
    expect(isValidMcpServerName(123)).toBe(false);
    expect(isValidMcpServerName(null)).toBe(false);
  });
});
