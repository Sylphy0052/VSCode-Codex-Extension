import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import type { Logger } from '../../src/log';
import type { SessionMessagingHost } from '../../src/orchestrator/sessionMessagingHost';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { FileSystemPort } from '../../src/session/ports';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import type { SettingsProvider } from '../../src/view/settingsProvider';

vi.mock('../../src/claude/usageProbe', () => ({
  ClaudeUsageProbe: class {
    read(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
  },
}));

/**
 * `registerSessionMessaging`は`taskManaged`の会話にはメッセージング用MCPを登録しない
 * （runner.tsがrun用のサーバを持たせているため）。それ以外は登録して宛先を束縛する。
 */

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const fileSystem = {
  readTextFile: async () => undefined,
  readFirstLine: async () => undefined,
  readTail: async () => undefined,
  mtimeMs: async () => undefined,
  listRollouts: async () => [],
  listJsonl: async () => [],
  listMarkdown: async () => [],
  readHead: async () => [],
  readBase64File: async () => undefined,
} as FileSystemPort;

const scanPort: FileScanPort = { scan: async () => [], readText: async () => undefined };

function createManager(): ClaudeChatViewManager {
  return new ClaudeChatViewManager(
    () => 'claude',
    fileSystem,
    new FileMentionCatalog(scanPort),
    '/fake/claude-home',
    {} as unknown as ClaudeSessionStore,
    {} as unknown as SettingsProvider,
    logger,
    () => undefined,
    () => undefined,
    () => false,
    undefined,
    undefined,
    mkdtempSync(join(tmpdir(), 'claude-session-messaging-')),
  );
}

type Registrar = { registerSessionMessaging(entry: unknown, sessionId: string): void };

function fakeHost() {
  const bind = vi.fn();
  const dispose = vi.fn();
  const register = vi.fn(() => ({ url: 'http://127.0.0.1:1/mcp/x', bind, dispose }));
  return { host: { register } as unknown as SessionMessagingHost, register, bind, dispose };
}

describe('ClaudeChatView.registerSessionMessaging', () => {
  it('taskManagedの会話には登録しない', () => {
    const manager = createManager();
    const { host, register, bind } = fakeHost();
    manager.setSessionMessaging(host);

    (manager as unknown as Registrar).registerSessionMessaging({ taskManaged: true }, 'sid-1');

    expect(register).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('taskManagedでない会話は登録して、セッションidを束縛する', () => {
    const manager = createManager();
    const { host, register, bind } = fakeHost();
    manager.setSessionMessaging(host);

    (manager as unknown as Registrar).registerSessionMessaging({ taskManaged: false }, 'sid-1');

    expect(register).toHaveBeenCalledWith('claude', expect.any(Object));
    expect(bind).toHaveBeenCalledWith('sid-1');
  });

  it('同じ会話へ二度割り当てると、古い登録を失効させる', () => {
    const manager = createManager();
    const { host, dispose } = fakeHost();
    manager.setSessionMessaging(host);
    const entry = { taskManaged: false };

    (manager as unknown as Registrar).registerSessionMessaging(entry, 'sid-1');
    expect(dispose).not.toHaveBeenCalled();
    (manager as unknown as Registrar).registerSessionMessaging(entry, 'sid-2');

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
