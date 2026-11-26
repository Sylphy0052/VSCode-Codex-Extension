import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { HeadlessCliDeps, HeadlessOutcome } from '../../src/loop/headlessCli';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import { STATE_POST_INTERVAL_MS } from '../../src/view/chatShared';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import { __mock } from '../mocks/vscode';

/**
 * セッションの目的の1文要約（Issue #2172）の画面側の結線。要約役そのものは
 * `sessionPurpose.test.ts`で見るので、ここでは「ターン終了で呼ぶ」「発話が増えなければ
 * 呼ばない」「無効なら起動しない」「結果が一覧（`managedSessions`）へ載る」の4点だけを見る。
 */

const headlessCalls: Array<{ deps: HeadlessCliDeps; prompt: string }> = [];

vi.mock('../../src/loop/headlessCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/loop/headlessCli')>();
  return {
    ...actual,
    runHeadlessPromptDetailed: (
      deps: HeadlessCliDeps,
      prompt: string,
    ): Promise<HeadlessOutcome> => {
      headlessCalls.push({ deps, prompt });
      return Promise.resolve({ ok: true, text: 'ログイン画面の不具合を直す' });
    },
  };
});

// ターン完了のたびに`refreshUsage()`が実CLIを起動しないようにする
vi.mock('../../src/claude/usageProbe', () => ({
  ClaudeUsageProbe: class {
    read(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
  },
}));

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const fakeFileSystem: FileSystemPort = {
  readTextFile: async () => undefined,
  readFirstLine: async () => undefined,
  readTail: async () => undefined,
  mtimeMs: async () => undefined,
  listRollouts: async () => [],
  listJsonl: async () => [],
  listMarkdown: async () => [],
  readHead: async () => [],
  readBase64File: async () => undefined,
};

const fakeScanPort: FileScanPort = {
  scan: async () => [],
  readText: async () => undefined,
};

function fakeSettingsProvider(): SettingsProvider {
  return {
    claudeSnapshot: () => ({
      models: [],
      efforts: [],
      permissionModes: [],
      agents: [],
      model: '',
      effort: '',
      permissionMode: '',
      agent: '',
      defaults: { model: '', effort: '', permissionMode: '' },
    }),
    updateClaude: async () => true,
  } as unknown as SettingsProvider;
}

function fakeStore(): ClaudeSessionStore {
  return {
    resolveTranscriptPath: async () => undefined,
    resolveCwd: async () => undefined,
    getName: () => undefined,
    rename: async () => undefined,
  } as unknown as ClaudeSessionStore;
}

function createManager(): ClaudeChatViewManager {
  return new ClaudeChatViewManager(
    () => 'claude',
    fakeFileSystem,
    new FileMentionCatalog(fakeScanPort),
    '/fake/claude-home',
    fakeStore(),
    fakeSettingsProvider(),
    fakeLogger,
    () => undefined,
    () => undefined,
    () => false,
    undefined,
    undefined,
    mkdtempSync(join(tmpdir(), 'session-purpose-')),
  );
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

const initLine = (sessionId: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
const userLine = (uuid: string, text: string): string =>
  `${JSON.stringify({ type: 'user', uuid, message: { content: [{ type: 'text', text }] } })}\n`;
const assistantLine = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid,
    message: { id: uuid, content: [{ type: 'text', text }] },
  })}\n`;
const resultLine = (): string => `${JSON.stringify({ type: 'result' })}\n`;

async function openPanel(enabled: boolean): Promise<{
  manager: ClaudeChatViewManager;
  session: ClaudeStreamSession;
}> {
  __mock.setConfig('agent', { 'missionControl.sessionPurpose.enabled': enabled });
  const sessions: ClaudeStreamSession[] = [];
  vi.spyOn(ClaudeStreamSession.prototype, 'start').mockImplementation(function (
    this: ClaudeStreamSession,
    _options: ClaudeStreamOptions,
  ) {
    sessions.push(this);
  });
  const manager = createManager();
  const sessionId = (await manager.openNew('/workspace/root')) as string;
  const session = sessions[0]!;
  session.receive(initLine(sessionId));
  await flush();
  return { manager, session };
}

const purposeCalls = (): number =>
  headlessCalls.filter((call) => call.deps.kind === 'sessionPurpose').length;

describe('セッションの目的の1文要約の結線（Issue #2172）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    headlessCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ターン終了で要約し、一覧へ載せる。発話が増えないターンでは呼び直さない', async () => {
    const { manager, session } = await openPanel(true);

    session.receive(userLine('u1', 'ログイン画面の不具合を直して'));
    session.receive(assistantLine('a1', '直しました'));
    session.receive(resultLine());
    await flush();
    await flush();

    expect(purposeCalls()).toBe(1);
    expect(headlessCalls[0]?.prompt).toContain('ログイン画面の不具合を直して');
    expect(manager.managedSessions()[0]?.purpose).toBe('ログイン画面の不具合を直す');

    // 発話が増えないまま次のターンが終わっても呼ばない
    session.receive(assistantLine('a2', '追記です'));
    session.receive(resultLine());
    await flush();
    expect(purposeCalls()).toBe(1);

    // 発話が増えたら呼び直す
    session.receive(userLine('u2', 'テストも足して'));
    session.receive(assistantLine('a3', '足しました'));
    session.receive(resultLine());
    await flush();
    expect(purposeCalls()).toBe(2);
    manager.dispose();
  });

  it('無効にすると追加のCLIを起動しない', async () => {
    const { manager, session } = await openPanel(false);

    session.receive(userLine('u1', 'ログイン画面の不具合を直して'));
    session.receive(assistantLine('a1', '直しました'));
    session.receive(resultLine());
    await flush();

    expect(purposeCalls()).toBe(0);
    expect(manager.managedSessions()[0]?.purpose).toBeUndefined();
    manager.dispose();
  });
});
