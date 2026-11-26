import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pruneStaleMcpConfigFiles,
  removeMcpConfigFile,
  writeMcpConfigFile,
} from '../../src/claude/mcpConfigFile';
import { startSessionMessagingHost } from '../../src/orchestrator/sessionMessagingHost';

const PREFIX = 'test-mcp';
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('mcpConfigFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-config-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('既存のディレクトリが緩い権限でも700へ締め、ファイルは600で書く', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);

    const path = writeMcpConfigFile(dir, PREFIX, { s: { type: 'http', url: 'http://x' } });

    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  it('pidの死んだプロセスの残骸だけを消し、生きているpid・別名のファイルは残す', () => {
    const dir = join(root, 'cfg');
    mkdirSync(dir);
    const dead = join(dir, `${PREFIX}-2147483646-0123456789abcdef.json`);
    const alive = join(dir, `${PREFIX}-${process.pid}-0123456789abcdef.json`);
    const otherPrefix = join(dir, `other-2147483646-0123456789abcdef.json`);
    const unrelated = join(dir, 'notes.txt');
    for (const file of [dead, alive, otherPrefix, unrelated]) writeFileSync(file, '{}');

    pruneStaleMcpConfigFiles(dir, PREFIX);

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(otherPrefix)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('ディレクトリが無くても掃除は例外を出さず、消えたファイルの削除も許す', () => {
    expect(() => pruneStaleMcpConfigFiles(join(root, 'none'), PREFIX)).not.toThrow();
    expect(() => removeMcpConfigFile(join(root, 'none.json'))).not.toThrow();
  });

  it('ディレクトリを作れないとき、書き込みは例外を投げる', () => {
    const blocker = join(root, 'file');
    writeFileSync(blocker, '');
    expect(() => writeMcpConfigFile(join(blocker, 'cfg'), PREFIX, {})).toThrow();
  });

  it('セッション間メッセージング: 設定ファイルを書けないときclaudeConfigPathはundefined（URL直接渡しへ戻る）', async () => {
    const blocker = join(root, 'file');
    writeFileSync(blocker, '');
    const errors: string[] = [];
    const host = await startSessionMessagingHost({
      windowId: '11111111-2222-3333-4444-555555555555',
      sessionBridge: () => undefined,
      configDir: join(blocker, 'cfg'),
      logPort: { error: (message: string) => errors.push(message) } as never,
    });
    try {
      const registration = host.register('claude');
      expect(registration.claudeConfigPath).toBeUndefined();
      expect(registration.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/u);
      expect(errors.some((message) => message.includes('MCP設定ファイルを書けませんでした'))).toBe(
        true,
      );
    } finally {
      await host.close();
    }
  });

  it('セッション間メッセージング: 書けるときはパスを返し、closeで消える', async () => {
    const dir = join(root, 'cfg');
    const host = await startSessionMessagingHost({
      windowId: '11111111-2222-3333-4444-555555555555',
      sessionBridge: () => undefined,
      configDir: dir,
    });
    const path = host.register('claude').claudeConfigPath;
    expect(path).toBeDefined();
    expect(existsSync(path as string)).toBe(true);
    await host.close();
    expect(existsSync(path as string)).toBe(false);
  });
});
