import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import {
  ClaudeStreamSession,
  type ClaudeStreamOptions,
  type ResumeOutcome,
} from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { FileSystemPort, MemoryFileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import type { MemoryModeMemento } from '../../src/provider/inputModes';
import { STATE_POST_INTERVAL_MS } from '../../src/view/chatShared';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import { ClaudeSandboxProbe } from '../../src/claude/sandbox';
import { MESSAGING_MCP_SERVER_NAME } from '../../src/orchestrator/messaging';
import { buildWebGptMcpConfig, WEB_GPT_MCP_SERVER } from '../../src/webGpt/discussion';
import { terminateDescendants } from '../../src/orchestrator/resourceSampler';
import { claudePermissionModeForLevel } from '../../src/provider/approvalLevel';
import { selectSkill } from '../../src/reflex/skillSelect';
import { planGoalDraft } from '../../src/view/goalDraftFactory';
import { prepareWebGptDiscussion } from '../../src/view/webGptDiscussionCommand';
import { judgeHandoffBoundary } from '../../src/view/handoffBoundaryReflex';
import { probeSafeBoundary } from '../../src/view/handoffModelChoice';
import {
  approveSecondOpinionHandoff,
  continueSecondOpinion,
  draftSecondOpinionHandoff,
  endSecondOpinionConsult,
  startSecondOpinion,
  stopSecondOpinion,
  updateSecondOpinionMaterial,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';
import { __mock, ViewColumn, window as fakeWindow, type FakeWebviewPanel } from '../mocks/vscode';

// skillの選択はReflex判定で実プロセスを起動するため、判定そのものだけ差し替える
// ターン完了のたびに`refreshUsage()`が実CLI (`claude --print /usage`) を起動しないようにする。
// managerごとに使い捨ての`globalStorageDir`を渡すため、実物では間隔制御もロックも効かない。
vi.mock('../../src/claude/usageProbe', () => ({
  ClaudeUsageProbe: class {
    read(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
  },
}));

vi.mock('../../src/reflex/skillSelect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/reflex/skillSelect')>()),
  selectSkill: vi.fn(),
}));

// ゴールの下書きは実CLI（とgh）を起動するため、下書きの生成だけ差し替える
vi.mock('../../src/view/goalDraftFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/goalDraftFactory')>()),
  planGoalDraft: vi.fn(),
}));

// WebGPTの議論はChromeを起動して入力を求めるため、準備だけ差し替える
vi.mock('../../src/view/webGptDiscussionCommand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/webGptDiscussionCommand')>()),
  prepareWebGptDiscussion: vi.fn(),
}));

// セカンドオピニオンの本体はCodexセッションを起動するため、呼び出しの口だけ記録する
vi.mock('../../src/view/secondOpinionCommand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/secondOpinionCommand')>()),
  startSecondOpinion: vi.fn(),
  stopSecondOpinion: vi.fn(),
  continueSecondOpinion: vi.fn(),
  updateSecondOpinionMaterial: vi.fn(),
  draftSecondOpinionHandoff: vi.fn(),
  approveSecondOpinionHandoff: vi.fn(),
  endSecondOpinionConsult: vi.fn(),
}));

// 区切りの判定（Reflex）と分類器は実CLIを起動するため、判定の呼び出しだけ差し替える
vi.mock('../../src/view/handoffBoundaryReflex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/handoffBoundaryReflex')>()),
  judgeHandoffBoundary: vi.fn(),
}));
vi.mock('../../src/view/handoffModelChoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/view/handoffModelChoice')>()),
  probeSafeBoundary: vi.fn(),
}));

// 一時停止の後始末は実プロセスの子孫を止めるため、ここだけ差し替える
vi.mock('../../src/orchestrator/resourceSampler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orchestrator/resourceSampler')>()),
  terminateDescendants: vi.fn(),
}));

/**
 * `claudeChatView.ts`の行カバレッジの底上げ（Issue #1854）。
 *
 * 既存の`claudeChatViewManager.test.ts`・`claudeChatViewAutoReply.test.ts`が触れていない
 * webviewメッセージの振り分け、パネル・セッションの寿命管理、入力モードなどを、
 * 実クラスのまま実プロセスを起動せずに検証する。
 */

const logged: { info: string[]; warn: string[]; error: string[] } = {
  info: [],
  warn: [],
  error: [],
};

const fakeLogger: Logger = {
  info: (m: string) => void logged.info.push(m),
  warn: (m: string) => void logged.warn.push(m),
  error: (m: string) => void logged.error.push(m),
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

function fakeSettingsProvider(overrides?: Record<string, unknown>): SettingsProvider {
  const settings = {
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
    updateApprovalLevel: async () => true,
    confirmClaudeFullApproval: async () => true,
    ...overrides,
  };
  return settings as unknown as SettingsProvider;
}

function fakeStore(overrides?: Partial<ClaudeSessionStore>): ClaudeSessionStore {
  const names = new Map<string, string>();
  const store = {
    resolveTranscriptPath: async () => undefined,
    resolveCwd: async () => undefined,
    getName: (sessionId: string) => names.get(sessionId),
    rename: async (sessionId: string, name: string) => {
      names.set(sessionId, name);
    },
    ...overrides,
  };
  return store as unknown as ClaudeSessionStore;
}

function fakeMemoryFileSystem(overrides?: Partial<MemoryFileSystemPort>): MemoryFileSystemPort {
  return {
    readStrict: async () => undefined,
    resolveSymlinkTarget: async () => ({ kind: 'not-symlink' }),
    ...overrides,
  };
}

/** `afterEach`で消す使い捨てディレクトリ。 */
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeMemento(): MemoryModeMemento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function createManager(options?: {
  store?: ClaudeSessionStore;
  fileSystem?: FileSystemPort;
  memoryFs?: MemoryFileSystemPort;
  isTaskManagedThread?: (sessionId: string) => boolean;
  settings?: Record<string, unknown>;
  holdsRestoredTaskPanel?: (sessionId: string) => boolean;
  /** `null`なら置き場所を渡さない。省略時は使い捨てのディレクトリ。 */
  globalStorageDir?: string | null;
}): ClaudeChatViewManager {
  const manager = new ClaudeChatViewManager(
    () => 'claude',
    options?.fileSystem ?? fakeFileSystem,
    new FileMentionCatalog(fakeScanPort),
    '/fake/claude-home',
    options?.store ?? fakeStore(),
    fakeSettingsProvider(options?.settings),
    fakeLogger,
    () => undefined,
    () => undefined,
    options?.isTaskManagedThread ?? (() => false),
    options?.memoryFs ?? fakeMemoryFileSystem(),
    fakeMemento(),
    undefined,
    undefined,
    options?.globalStorageDir === null
      ? undefined
      : (options?.globalStorageDir ?? makeTempDir('claude-coverage-')),
  );
  if (options?.holdsRestoredTaskPanel !== undefined) {
    manager.holdsRestoredTaskPanel = options.holdsRestoredTaskPanel;
  }
  return manager;
}

/** 実プロセスは起動せず、起動引数と`ClaudeStreamSession`本体を控える。 */
function stubStartCapturing(): {
  calls: ClaudeStreamOptions[];
  sessions: ClaudeStreamSession[];
} {
  const calls: ClaudeStreamOptions[] = [];
  const sessions: ClaudeStreamSession[] = [];
  vi.spyOn(ClaudeStreamSession.prototype, 'start').mockImplementation(function (
    this: ClaudeStreamSession,
    options: ClaudeStreamOptions,
  ) {
    calls.push(options);
    sessions.push(this);
  });
  return { calls, sessions };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

const initLine = (sessionId: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;

type SentMessage = { type?: string; [key: string]: unknown };

function sentOf(panel: FakeWebviewPanel | undefined): SentMessage[] {
  return (panel?.webview.sent ?? []) as SentMessage[];
}

function sentOfType(panel: FakeWebviewPanel | undefined, type: string): SentMessage[] {
  return sentOf(panel).filter((m) => m.type === type);
}

async function openSession(manager: ClaudeChatViewManager): Promise<string> {
  const id = await manager.openNew('/workspace/root');
  // randomUUID()の形。undefinedや空文字を通さない
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return id as string;
}

beforeEach(() => {
  __mock.reset();
  __mock.setWorkspaceFolder('/workspace/root');
  vi.restoreAllMocks();
  vi.mocked(terminateDescendants).mockReset().mockResolvedValue(undefined);
  vi.mocked(selectSkill).mockReset();
  vi.mocked(planGoalDraft).mockReset();
  vi.mocked(prepareWebGptDiscussion).mockReset();
  vi.mocked(judgeHandoffBoundary).mockReset();
  vi.mocked(probeSafeBoundary).mockReset();
  for (const fn of [
    startSecondOpinion,
    stopSecondOpinion,
    continueSecondOpinion,
    updateSecondOpinionMaterial,
    draftSecondOpinionHandoff,
    approveSecondOpinionHandoff,
    endSecondOpinionConsult,
  ]) {
    vi.mocked(fn as (...args: unknown[]) => unknown).mockReset();
  }
  logged.info.length = 0;
  logged.warn.length = 0;
  logged.error.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('webviewメッセージの振り分け: セッションへ委ねる操作', () => {
  it('planMode / fastMode / autoHandoff系はセッションの対応するsetterへ値を渡す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const planMode = vi.spyOn(session, 'setPlanMode');
    const fastMode = vi.spyOn(session, 'setFastMode');
    const autoHandoff = vi.spyOn(session, 'setAutoHandoff');
    const autoApprove = vi.spyOn(session, 'setAutoHandoffAutoApprove');
    const autoReply = vi.spyOn(session, 'setAutoReply');

    await manager.simulateWebviewMessage(id, { type: 'planMode', on: true });
    await manager.simulateWebviewMessage(id, { type: 'fastMode', on: true });
    await manager.simulateWebviewMessage(id, { type: 'fastMode', on: false });
    await manager.simulateWebviewMessage(id, { type: 'autoHandoff', on: true });
    await manager.simulateWebviewMessage(id, { type: 'autoHandoff', on: false });
    await manager.simulateWebviewMessage(id, { type: 'autoHandoffAutoApprove', on: true });
    await manager.simulateWebviewMessage(id, { type: 'autoReply', on: true });

    expect(planMode).toHaveBeenCalledTimes(1);
    expect(planMode.mock.calls[0]?.[0]).toBe(true);
    expect(fastMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(autoHandoff.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(autoApprove.mock.calls.map((c) => c[0])).toEqual([true]);
    // 手動操作は自動返信を解除する（noteUserAction）ため途中にfalseが挟まる。最後のON要求で終わる
    expect(autoReply.mock.calls[autoReply.mock.calls.length - 1]?.[0]).toBe(true);
  });

  it('キューの操作（cancelQueued / sendQueued / flushQueue）は添字つきでセッションへ届く', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const cancel = vi.spyOn(session, 'cancelQueued').mockImplementation(() => undefined);
    const sendQueued = vi.spyOn(session, 'sendQueued').mockImplementation(() => undefined);
    const flushQueue = vi.spyOn(session, 'flushQueue').mockImplementation(() => undefined);

    await manager.simulateWebviewMessage(id, { type: 'cancelQueued', index: 2 });
    await manager.simulateWebviewMessage(id, { type: 'sendQueued', index: 1 });
    await manager.simulateWebviewMessage(id, { type: 'flushQueue' });
    // indexが数値でない要求は無視する
    await manager.simulateWebviewMessage(id, { type: 'cancelQueued', index: '2' });
    await manager.simulateWebviewMessage(id, { type: 'sendQueued', index: undefined });

    expect(cancel.mock.calls).toEqual([[2]]);
    expect(sendQueued.mock.calls).toEqual([[1]]);
    expect(flushQueue).toHaveBeenCalledTimes(1);
  });

  it('popLastQueuedForInputは取り出した本文だけをwebviewへ戻し、空なら何も送らない', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const pop = vi.spyOn(session, 'popLastQueuedForInput');
    const panel = __mock.lastCreatedPanel();

    pop.mockReturnValueOnce(undefined);
    await manager.simulateWebviewMessage(id, { type: 'popLastQueuedForInput' });
    expect(sentOfType(panel, 'restoreQueuedText')).toHaveLength(0);

    pop.mockReturnValueOnce({ text: '待たせていた指示' } as ReturnType<
      typeof session.popLastQueuedForInput
    >);
    await manager.simulateWebviewMessage(id, { type: 'popLastQueuedForInput' });
    expect(sentOfType(panel, 'restoreQueuedText')).toEqual([
      { type: 'restoreQueuedText', text: '待たせていた指示' },
    ]);
  });

  it('interruptはセッションを中断し、skillの判定待ちも取り消す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const interrupt = vi.spyOn(session, 'interrupt').mockImplementation(() => undefined);

    await manager.simulateWebviewMessage(id, { type: 'interrupt' });

    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('answerAskUserQuestionは型の合う回答だけをセッションへ渡す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const answer = vi.spyOn(session, 'answerAskUserQuestion').mockImplementation(() => undefined);
    const selections = { どちらにしますか: ['A'] };

    await manager.simulateWebviewMessage(id, {
      type: 'answerAskUserQuestion',
      requestId: 'req-1',
      answers: selections,
    });
    await manager.simulateWebviewMessage(id, {
      type: 'answerAskUserQuestion',
      requestId: { bad: true },
      answers: selections,
    });
    await manager.simulateWebviewMessage(id, {
      type: 'answerAskUserQuestion',
      requestId: 'req-2',
      answers: { どちらにしますか: [] },
    });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]).toEqual(['req-1', selections]);
  });

  it('approveは不正なdecision・requestIdを無視する', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    const decide = vi.spyOn(session, 'decide').mockImplementation(() => undefined);

    await manager.simulateWebviewMessage(id, {
      type: 'approve',
      requestId: 1,
      decision: 'nonsense',
    });
    await manager.simulateWebviewMessage(id, {
      type: 'approve',
      requestId: {},
      decision: 'accept',
    });
    expect(decide).not.toHaveBeenCalled();

    await manager.simulateWebviewMessage(id, { type: 'approve', requestId: 7, decision: 'accept' });
    expect(decide.mock.calls).toEqual([[7, 'accept']]);
  });

  it('不明なメッセージ・オブジェクトでない入力は黙って捨てる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'unknown-type' });
    await manager.simulateWebviewMessage(id, 'string-message');
    await manager.simulateWebviewMessage(id, null);

    expect(logged.error).toHaveLength(0);
    expect(__mock.messages.errors).toHaveLength(0);
  });

  it('見つからないsessionIdへのsimulateWebviewMessageは例外になる', async () => {
    const manager = createManager();
    await expect(manager.simulateWebviewMessage('missing', { type: 'ready' })).rejects.toThrow(
      /画面が見つからない/,
    );
  });
});

describe('webviewメッセージの振り分け: 拡張機能側のコマンド', () => {
  it.each([
    ['workflowMenu', 'agent.workflows.menu'],
    ['teamWorkflow', 'agent.workflows.team'],
    ['workflowView', 'agent.workflows.view'],
    ['sessionKanban', 'agent.sessionKanban'],
    ['forgeHub', 'agent.forgeHub'],
    ['orchestratorMode', 'agent.taskRun.start'],
    ['openProgress', 'agent.openProgress'],
  ])('%s は %s を実行する', async (type, command) => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type });

    expect(__mock.executedCommands).toContain(command);
  });

  it('localReviewは会話のthreadIdが決まってから初めてレビューを開始する', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'localReview' });
    expect(__mock.executedCommands).not.toContain('agent.localReview.start');

    sessions[0]?.receive(initLine(id));
    await manager.simulateWebviewMessage(id, { type: 'localReview' });
    expect(__mock.executedCommands).toContain('agent.localReview.start');
  });
});

describe('webviewメッセージの振り分け: 設定の切替', () => {
  it.each([
    ['toggleTurnSummary', 'turnSummary'],
    ['toggleProsCons', 'prosCons'],
    ['toggleEndSummary', 'endSummary'],
    ['toggleLoopEngineering', 'loopEngineering'],
    ['toggleLoopAdvisor', 'loopAdvisor'],
  ])('%s は設定を書き込み、結果を%sとしてwebviewへ返す', async (type, reply) => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type });
    await vi.waitFor(() => expect(sentOfType(panel, reply)).toHaveLength(1));

    const first = sentOfType(panel, reply)[0] as SentMessage;
    expect(typeof first['enabled']).toBe('boolean');

    // もう一度押すと反転して戻る（読み直した値が返る）
    await manager.simulateWebviewMessage(id, { type });
    await vi.waitFor(() => expect(sentOfType(panel, reply)).toHaveLength(2));
    const second = sentOfType(panel, reply)[1] as SentMessage;
    expect(second['enabled']).not.toBe(first['enabled']);
  });

  it('toggleLimitAutoResume / toggleReflexは設定を書いてもエラーにしない', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'toggleLimitAutoResume' });
    await manager.simulateWebviewMessage(id, { type: 'toggleReflex' });
    await flush();

    expect(__mock.messages.errors).toHaveLength(0);
    expect(logged.error).toHaveLength(0);
  });

  it('readyはwebviewへ設定・ゴール自動生成の可否を送り直す', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'ready' });
    await flush();

    expect(sentOfType(panel, 'loopAutoGoal')).toHaveLength(1);
    const states = sentOfType(panel, 'state') as { state?: { settings?: unknown } }[];
    expect(states.some((m) => m.state?.settings !== undefined)).toBe(true);
  });

  it('stateFullは差分ではなく全量のstateを即座に送る', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();
    const before = sentOfType(panel, 'state').length;

    await manager.simulateWebviewMessage(id, { type: 'stateFull' });

    const states = sentOfType(panel, 'state');
    expect(states.length).toBeGreaterThan(before);
    const last = states[states.length - 1] as { items?: { mode: string } };
    expect(last.items?.mode).toBe('full');
  });
});

describe('webviewメッセージの振り分け: 添付・ファイル・URL', () => {
  it('requestFilesはファイル候補をwebviewへ返す', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'requestFiles', query: 'src' });
    await vi.waitFor(() => expect(sentOfType(panel, 'files')).toHaveLength(1));
    expect(sentOfType(panel, 'files')[0]).toMatchObject({ query: 'src', files: [] });
  });

  it('attach→removeAttachmentで添付が増減し、そのたびに設定がwebviewへ届く', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

    await manager.simulateWebviewMessage(id, { type: 'attach', name: 'a.png', dataUrl });
    await flush();
    const attachmentsOf = (): unknown[] | undefined => {
      const states = sentOfType(panel, 'state') as { state?: { attachments?: unknown[] } }[];
      return states[states.length - 1]?.state?.attachments;
    };
    expect(attachmentsOf()).toHaveLength(1);
    const added = attachmentsOf()?.[0] as { id: string; name?: string; label?: string };
    expect(added.id).toBeTypeOf('string');

    await manager.simulateWebviewMessage(id, { type: 'removeAttachment', id: added.id });
    expect(attachmentsOf()).toHaveLength(0);
  });

  it('dropRejectedは警告を出すだけでセッションへは何も送らない', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const sendOrQueue = vi.spyOn(sessions[0] as ClaudeStreamSession, 'sendOrQueue');

    await manager.simulateWebviewMessage(id, { type: 'dropRejected', kind: 'tooLarge' });

    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  it('openUrlは開けるURLだけを外部ブラウザへ渡す', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'openUrl', url: 'https://example.com/a' });
    await vi.waitFor(() => expect(__mock.openedExternalUris).toContain('https://example.com/a'));
  });
});

/** `openTaskSession`へ渡す最小の入力。 */
const TASK_INPUT = {
  cwd: '/workspace/root/task-a',
  config: { model: '', effort: '', approvalMode: '' },
  sandbox: '',
};

const TRANSCRIPT_USER_LINE = JSON.stringify({
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: '過去の質問' },
});

describe('TaskSession（openTaskSessionが返す操作口）', () => {
  it('onStateChangedの購読者はセッションの状態変化のたびにstateを受け取る', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    const seen: (string | undefined)[] = [];
    task.onStateChanged((state) => seen.push(state.threadId));

    sessions[0]?.receive(initLine(task.sessionId));

    expect(seen).toContain(task.sessionId);
  });

  it('decideApprovalは承認を決め、onApprovalResolvedの購読者へ同じ通知を届ける', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    const decide = vi
      .spyOn(sessions[0] as ClaudeStreamSession, 'decide')
      .mockImplementation(() => undefined);
    const resolved: unknown[] = [];
    task.onApprovalResolved((e) => resolved.push(e));

    task.decideApproval?.('req-9', 'decline');

    expect(decide.mock.calls).toEqual([['req-9', 'decline']]);
    expect(resolved).toEqual([{ requestId: 'req-9', decision: 'decline' }]);
  });

  it('interrupt・compact・noteはセッションの対応する操作へ届く', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    const session = sessions[0] as ClaudeStreamSession;
    const interrupt = vi.spyOn(session, 'interrupt').mockImplementation(() => undefined);
    const compact = vi.spyOn(session, 'compact').mockImplementation(() => undefined);
    const note = vi.spyOn(session, 'noteLocalEvent').mockImplementation(() => undefined);

    await task.interrupt();
    await task.compact?.();
    task.note?.('n1', '経過メモ');

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(note.mock.calls).toEqual([['n1', '経過メモ']]);
  });

  it('processInfoはpidが決まるまでundefined、決まれば共有なしで返す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    expect(task.processInfo?.()).toBeUndefined();

    vi.spyOn(sessions[0] as ClaudeStreamSession, 'pid', 'get').mockReturnValue(4242);

    expect(task.processInfo?.()).toEqual({ pid: 4242, shared: false });
  });

  it('MCPを依頼していなければ、可視性を確かめずにtrueを返す', async () => {
    stubStartCapturing();
    const status = vi.spyOn(ClaudeStreamSession.prototype, 'checkMcpStatus');
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);

    await expect(task.checkMessagingToolVisible?.()).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it.each([
    ['connectedなら見える', [{ name: MESSAGING_MCP_SERVER_NAME, state: 'connected' }], true],
    ['failedなら見えない', [{ name: MESSAGING_MCP_SERVER_NAME, state: 'failed' }], false],
    ['一覧に無ければ見えない', [{ name: 'other', state: 'connected' }], false],
    ['一覧を取れなければ見えない', undefined, false],
  ])('MCPを依頼したとき、サーバが%s', async (_label, servers, expected) => {
    stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'checkMcpStatus').mockResolvedValue(
      servers as unknown as Awaited<ReturnType<ClaudeStreamSession['checkMcpStatus']>>,
    );
    const manager = createManager();
    const task = await manager.openTaskSession({
      ...TASK_INPUT,
      mcp: { url: 'http://127.0.0.1:1/x' },
    } as unknown as Parameters<ClaudeChatViewManager['openTaskSession']>[0]);

    await expect(task.checkMessagingToolVisible?.()).resolves.toBe(expected);
  });

  it('ループを開始して止めると、onFinishedの購読者へ停止理由が届く', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    vi.spyOn(sessions[0] as ClaudeStreamSession, 'sendOrQueue').mockReturnValue('sent');
    const finished: string[] = [];
    task.onFinished((reason) => finished.push(reason));

    task.runLoop({
      initialPrompt: '開始',
      continuePrompt: '続き',
      maxIterations: 3,
      condition: '',
    });
    task.stopLoop?.();

    expect(finished).toEqual(['taskStopped']);
  });

  it('openはタブを作り、revealは既存タブを前面へ出す。releaseForPauseはpidが無ければ子孫を止めずに閉じる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    task.open?.({ preserveFocus: true });
    const panel = __mock.lastCreatedPanel();
    expect(panel?.disposed).toBe(false);
    const before = panel?.revealCount ?? 0;
    task.reveal?.();
    expect(panel?.revealCount).toBeGreaterThan(before);

    await expect(task.releaseForPause?.()).resolves.toEqual({ memoryFreed: true });

    expect(terminateDescendants).not.toHaveBeenCalled();
    expect(panel?.disposed).toBe(true);
  });

  it('releaseForPauseはpidがあれば子孫を止め、止められなくても警告だけでタブを閉じる', async () => {
    stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'pid', 'get').mockReturnValue(777);
    vi.mocked(terminateDescendants).mockRejectedValueOnce(new Error('kill failed'));
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    task.open?.({ preserveFocus: true });
    const panel = __mock.lastCreatedPanel();

    await task.releaseForPause?.();

    expect(terminateDescendants).toHaveBeenCalledWith(777);
    expect(logged.warn.some((m) => m.includes('kill failed'))).toBe(true);
    expect(panel?.disposed).toBe(true);
  });
});

describe('openTaskSessionの再開とsandbox', () => {
  it('記録が見つからない会話は再開できず例外になる', async () => {
    stubStartCapturing();
    const manager = createManager();

    await expect(
      manager.openTaskSession({ ...TASK_INPUT, resume: { sessionId: 'gone' } }),
    ).rejects.toThrow('再開する会話の記録が見つかりません');
  });

  it('別のタブで開かれている会話は再開できず例外になる', async () => {
    stubStartCapturing();
    const manager = createManager({
      store: fakeStore({ resolveTranscriptPath: async () => '/t/x.jsonl' }),
    });
    const id = await openSession(manager);

    await expect(
      manager.openTaskSession({ ...TASK_INPUT, resume: { sessionId: id } }),
    ).rejects.toThrow('別のタブで開かれています');
  });

  it('再開はtranscriptから過去のやり取りを復元し、同じ会話を-rで開き直す', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager({
      store: fakeStore({ resolveTranscriptPath: async () => '/t/resume.jsonl' }),
      fileSystem: { ...fakeFileSystem, readTextFile: async () => `${TRANSCRIPT_USER_LINE}\n` },
    });

    const task = await manager.openTaskSession({
      ...TASK_INPUT,
      resume: { sessionId: 'resume-1' },
    });

    expect(task.sessionId).toBe('resume-1');
    expect(calls[0]?.target).toEqual({ kind: 'resume', sessionId: 'resume-1' });
    expect(calls[0]?.initialItems?.map((i) => i.kind)).toContain('userMessage');
  });

  it('sandboxが使えない環境ではsandbox無しで起動し、理由を警告に残す', async () => {
    const { calls } = stubStartCapturing();
    vi.spyOn(ClaudeSandboxProbe.prototype, 'check').mockResolvedValue({
      ok: false,
      reason: 'bwrapが無い',
    });
    const manager = createManager();

    await manager.openTaskSession({ ...TASK_INPUT, cliSandbox: 'workspace-write' });

    expect(calls[0]?.config.additionalArgs ?? []).toEqual([]);
    expect(logged.warn.some((m) => m.includes('bwrapが無い'))).toBe(true);
  });

  it('作業ディレクトリのせいでsandboxを付けられないときもsandbox無しで起動する', async () => {
    const { calls } = stubStartCapturing();
    vi.spyOn(ClaudeSandboxProbe.prototype, 'check').mockResolvedValue({
      ok: true,
      environment: { weakerNested: false },
    });
    vi.spyOn(ClaudeSandboxProbe.prototype, 'checkCwd').mockResolvedValue({
      ok: false,
      reason: '読み取り拒否のディレクトリがある',
    });
    const manager = createManager();

    await manager.openTaskSession({ ...TASK_INPUT, cliSandbox: 'read-only' });

    expect(calls[0]?.config.additionalArgs ?? []).toEqual([]);
    expect(logged.warn.some((m) => m.includes('読み取り拒否'))).toBe(true);
  });

  it('sandboxが使えるときは起動引数へ--settingsと--append-system-promptを渡す', async () => {
    const { calls } = stubStartCapturing();
    vi.spyOn(ClaudeSandboxProbe.prototype, 'check').mockResolvedValue({
      ok: true,
      environment: { weakerNested: true },
    });
    vi.spyOn(ClaudeSandboxProbe.prototype, 'checkCwd').mockResolvedValue({ ok: true });
    const manager = createManager();

    await manager.openTaskSession({ ...TASK_INPUT, cliSandbox: 'workspace-write' });

    const args = calls[0]?.config.additionalArgs ?? [];
    expect(args[0]).toBe('--settings');
    expect(args).toContain('--append-system-prompt');
    expect(args[1]).toContain('enableWeakerNestedSandbox');
  });
});

describe('パネルの復元・名前変更・クリア', () => {
  const newPanel = (): FakeWebviewPanel =>
    fakeWindow.createWebviewPanel('claude.chat', 'x', ViewColumn.Active, {});

  it('threadIdを持たない復元パネルは操作できないので閉じる', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager();
    const panel = newPanel();

    await manager.restorePanel(panel as never, undefined);

    expect(panel.disposed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('既に開いている会話の二重復元は、後から来たパネルを閉じる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = newPanel();

    await manager.restorePanel(panel as never, { threadId: id });

    expect(panel.disposed).toBe(true);
  });

  it('タスク管理下で預かる設定が無い会話は、汎用復元せずパネルを閉じる', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager({
      isTaskManagedThread: () => true,
      holdsRestoredTaskPanel: () => false,
    });
    const panel = newPanel();

    await manager.restorePanel(panel as never, { threadId: 'managed-1' });

    expect(panel.disposed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('作業フォルダを特定できない復元は、エラーを出してパネルを閉じる', async () => {
    const { calls } = stubStartCapturing();
    __mock.clearWorkspaceFolder();
    const manager = createManager();
    const panel = newPanel();

    await manager.restorePanel(panel as never, { threadId: 'lost-cwd' });

    expect(panel.disposed).toBe(true);
    expect(__mock.messages.errors).toContain('作業ディレクトリを特定できませんでした');
    expect(calls).toHaveLength(0);
  });

  it('復元したパネルは、transcriptと付けた名前を引き継いで同じ会話を再開する', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager({
      store: fakeStore({
        resolveTranscriptPath: async () => '/t/restore.jsonl',
        resolveCwd: async () => '/workspace/restored',
        getName: () => '付けた名前',
      }),
      fileSystem: { ...fakeFileSystem, readTextFile: async () => `${TRANSCRIPT_USER_LINE}\n` },
    });
    const panel = newPanel();

    await manager.restorePanel(panel as never, { threadId: 'restored-1' });

    expect(calls[0]?.cwd).toBe('/workspace/restored');
    expect(calls[0]?.target).toEqual({ kind: 'resume', sessionId: 'restored-1' });
    expect(calls[0]?.initialName).toBe('付けた名前');
    expect(calls[0]?.initialItems?.map((i) => i.kind)).toContain('userMessage');
  });

  it('預かる設定のタスク会話は、CLIを起動せずtranscriptを表示専用で出す', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager({
      store: fakeStore({ resolveTranscriptPath: async () => '/t/held.jsonl' }),
      fileSystem: { ...fakeFileSystem, readTextFile: async () => `${TRANSCRIPT_USER_LINE}\n` },
      isTaskManagedThread: () => true,
      holdsRestoredTaskPanel: () => true,
    });
    const panel = newPanel();

    await manager.restorePanel(panel as never, { threadId: 'held-1' });
    await flush();

    expect(panel.disposed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(sentOfType(panel, 'state').length).toBeGreaterThan(0);
  });

  it('名前変更は、アクティブな会話が無ければ案内だけ出す', async () => {
    const manager = createManager();

    await manager.renameActive();

    expect(__mock.messages.infos).toContain('名前を変更するClaude Code画面を開いてください');
  });

  it('名前変更は、保存したあとセッションへ反映する', async () => {
    const { sessions } = stubStartCapturing();
    const rename = vi.fn(async () => undefined);
    const manager = createManager({ store: fakeStore({ rename }) });
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));
    __mock.showInputBoxAnswer = '  新しい名前  ';
    const setName = vi.spyOn(sessions[0] as ClaudeStreamSession, 'setName');

    await manager.renameActive();

    expect(rename.mock.calls).toEqual([[id, '新しい名前']]);
    expect(setName.mock.calls).toEqual([['新しい名前']]);
  });

  it('名前の保存に失敗したときは、画面へ反映せずエラーを出す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager({
      store: fakeStore({
        rename: async () => {
          throw new Error('disk full');
        },
      }),
    });
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));
    __mock.showInputBoxAnswer = '新しい名前';
    const setName = vi.spyOn(sessions[0] as ClaudeStreamSession, 'setName');

    await manager.renameActive();

    expect(setName).not.toHaveBeenCalled();
    expect(__mock.messages.errors.some((m) => m.includes('disk full'))).toBe(true);
  });

  it('クリアは、アクティブな会話が無ければ案内だけ出す', async () => {
    const manager = createManager();

    await manager.clearActive();

    expect(__mock.messages.infos).toContain('クリアするClaude Code画面を開いてください');
  });

  it('クリアは今のタブを閉じ、同じ作業フォルダで新しい会話を開く', async () => {
    const { calls } = stubStartCapturing();
    const manager = createManager();
    await openSession(manager);
    const first = __mock.lastCreatedPanel();

    await manager.clearActive();

    expect(first?.disposed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cwd).toBe('/workspace/root');
    expect(__mock.lastCreatedPanel()).not.toBe(first);
  });

  it('応答の途中のクリアは、確認を断ると何も変えない', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));
    vi.spyOn(sessions[0] as ClaudeStreamSession, 'getState').mockReturnValue({
      ...(sessions[0] as ClaudeStreamSession).getState(),
      busy: true,
    });
    __mock.showWarningMessageAnswer = undefined;
    const first = __mock.lastCreatedPanel();

    await manager.clearActive();

    expect(first?.disposed).toBe(false);
    expect(__mock.messages.warnings.some((m) => m.includes('応答の途中です'))).toBe(true);
  });

  it('タスクが動かしている画面はクリアできない', async () => {
    stubStartCapturing();
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);
    task.open?.({ preserveFocus: false });

    await manager.clearActive();

    expect(__mock.messages.warnings).toContain('タスクが動かしている画面はクリアできません');
  });
});

describe('使っていないタブのCLI休止', () => {
  const IDLE_MS = 30 * 60_000;

  it('使っていない状態が続くとCLIを休止し、pid付きでログへ残す', async () => {
    const { sessions } = stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'idleForSuspend', 'get').mockReturnValue(true);
    vi.spyOn(ClaudeStreamSession.prototype, 'pid', 'get').mockReturnValue(55);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(true);
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]?.[0].cwd).toBe('/workspace/root');
    expect(logged.info.some((m) => m.includes('[idle shutdown]') && m.includes('pid 55'))).toBe(
      true,
    );
  });

  it('休止に失敗したら警告だけ残して続ける', async () => {
    const { sessions } = stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'idleForSuspend', 'get').mockReturnValue(true);
    vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockRejectedValue(new Error('busy'));
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(logged.warn.some((m) => m.includes('CLIを終了できませんでした: busy'))).toBe(true);
  });

  it('待っている間に使い始めたら休止しない', async () => {
    const { sessions } = stubStartCapturing();
    const idle = vi
      .spyOn(ClaudeStreamSession.prototype, 'idleForSuspend', 'get')
      .mockReturnValue(true);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(true);
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);

    idle.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(suspend).not.toHaveBeenCalled();
  });

  it('設定が0分なら予約しない', async () => {
    const { sessions } = stubStartCapturing();
    __mock.setConfig('agent', { claude: { idleShutdownMinutes: 0 } });
    vi.spyOn(ClaudeStreamSession.prototype, 'idleForSuspend', 'get').mockReturnValue(true);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(true);
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);

    expect(suspend).not.toHaveBeenCalled();
  });

  it('使い始めると予約を取り消す', async () => {
    const { sessions } = stubStartCapturing();
    const idle = vi
      .spyOn(ClaudeStreamSession.prototype, 'idleForSuspend', 'get')
      .mockReturnValue(true);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(true);
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));
    await vi.advanceTimersByTimeAsync(1000);

    idle.mockReturnValue(false);
    sessions[0]?.receive(initLine(id));
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);

    expect(suspend).not.toHaveBeenCalled();
  });
});

describe('休止からの再開の結果', () => {
  const failed = (text: string): ResumeOutcome => ({
    kind: 'failed',
    reason: 'transcriptが無い',
    text,
    attachments: [],
  });
  const resumeListenerOf = (session: ClaudeStreamSession | undefined) =>
    (session as unknown as { resumeListener: (o: ResumeOutcome) => void }).resumeListener;

  it('再開できたときは何も尋ねない', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    await openSession(manager);

    resumeListenerOf(sessions[0])({ kind: 'resumed', mcpServers: [] });
    await flush();

    expect(__mock.messages.warnings).toEqual([]);
  });

  it('再開に失敗して新しい会話を断ると、何も開かない', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    await openSession(manager);
    __mock.showWarningMessageAnswer = undefined;

    resumeListenerOf(sessions[0])(failed('送り直す指示'));
    await flush();

    expect(__mock.messages.warnings.some((m) => m.includes('transcriptが無い'))).toBe(true);
    expect(sessions).toHaveLength(1);
  });

  it('再開に失敗して新しい会話を選ぶと、開いた会話へ元の指示を送り直す', async () => {
    const { sessions } = stubStartCapturing();
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    sendOrQueue.mockReturnValue('sent');
    const manager = createManager();
    await openSession(manager);

    resumeListenerOf(sessions[0])(failed('送り直す指示'));

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(sendOrQueue.mock.calls[0]?.[0]).toBe('送り直す指示');
    expect(sessions).toHaveLength(2);
    expect(sendOrQueue.mock.instances[0]).toBe(sessions[1]);
  });

  it('送り直す指示が空なら、新しい会話を開くだけで何も送らない', async () => {
    const { sessions } = stubStartCapturing();
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    const manager = createManager();
    await openSession(manager);

    resumeListenerOf(sessions[0])(failed(''));

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe('設定の変更とapprovalLevel', () => {
  const stubSetters = () => ({
    model: vi.spyOn(ClaudeStreamSession.prototype, 'setModel').mockImplementation(() => undefined),
    effort: vi
      .spyOn(ClaudeStreamSession.prototype, 'setEffort')
      .mockImplementation(() => undefined),
    mode: vi
      .spyOn(ClaudeStreamSession.prototype, 'setPermissionMode')
      .mockImplementation(() => undefined),
  });

  it('modelとreasoningEffortの変更は、実行中のセッションへ流す', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'config', key: 'model', value: 'opus' });
    await manager.simulateWebviewMessage(id, {
      type: 'config',
      key: 'reasoningEffort',
      value: 'high',
    });
    await flush();

    expect(setters.model.mock.calls).toEqual([['opus']]);
    expect(setters.effort.mock.calls).toEqual([['high']]);
  });

  it('既定へ戻す（空文字）操作はセッションへ送らず、次のセッションから効くと記録する', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'config', key: 'model', value: '' });
    await flush();

    expect(setters.model).not.toHaveBeenCalled();
    expect(logged.info.some((m) => m.includes('model を既定へ戻しました'))).toBe(true);
  });

  it('approvalModeはこのタブのセッションへだけ流し、全体の設定は書き換えない（Issue #1888）', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const updateClaude = vi.fn(async () => true);
    const confirmClaudeFullApproval = vi.fn(async () => false);
    const manager = createManager({ settings: { updateClaude, confirmClaudeFullApproval } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, {
      type: 'config',
      key: 'approvalMode',
      value: 'acceptEdits',
    });
    await flush();
    expect(updateClaude).not.toHaveBeenCalled();
    expect(setters.mode.mock.calls).toEqual([['acceptEdits']]);

    // 全承認は同意を取り消したら何も変えない
    await manager.simulateWebviewMessage(id, {
      type: 'config',
      key: 'approvalMode',
      value: 'bypassPermissions',
    });
    await flush();
    expect(confirmClaudeFullApproval).toHaveBeenCalledTimes(1);
    expect(setters.mode).toHaveBeenCalledTimes(1);
  });

  it('agentはセッション中に切り替えられないので、次のセッションから効くと記録する', async () => {
    stubStartCapturing();
    const updateClaude = vi.fn(async () => true);
    const manager = createManager({ settings: { updateClaude } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'config', key: 'agent', value: 'reviewer' });
    await flush();

    expect(updateClaude.mock.calls).toEqual([['agent', 'reviewer']]);
    expect(logged.info.some((m) => m.includes('agent を reviewer に変えました'))).toBe(true);
  });

  it('許可していないキーと文字列でない値は、何も変えない', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const updateClaude = vi.fn(async () => true);
    const manager = createManager({ settings: { updateClaude } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'config', key: 'bogus', value: 'x' });
    await manager.simulateWebviewMessage(id, { type: 'config', key: 'model', value: 3 });
    await flush();

    expect(logged.warn.some((m) => m.includes('変更を許可していないキーです: bogus'))).toBe(true);
    expect(updateClaude).not.toHaveBeenCalled();
    expect(setters.model).not.toHaveBeenCalled();
  });

  it('approvalLevelはこのタブのセッションへだけ流し、全体の設定は書き換えない（Issue #1888）', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const updateApprovalLevel = vi.fn(async () => true);
    const manager = createManager({ settings: { updateApprovalLevel } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'auto' });
    await flush();

    expect(updateApprovalLevel).not.toHaveBeenCalled();
    expect(setters.mode.mock.calls).toEqual([[claudePermissionModeForLevel('auto')]]);
  });

  it('全承認は実行中に上げられないため、CLIを休止させて全承認の起動引数で再開させる', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const suspend = vi
      .spyOn(ClaudeStreamSession.prototype, 'suspend')
      .mockImplementation(async () => true);
    // startを差し替えているためプロセスは無い。動いているものとして扱う
    vi.spyOn(ClaudeStreamSession.prototype, 'hasProcess', 'get').mockReturnValue(true);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(setters.mode).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledTimes(1);
    const relaunch = suspend.mock.calls[0]![0];
    expect(relaunch.config().permissionMode).toBe(claudePermissionModeForLevel('full'));
  });

  it('全承認の同意が取り消されたときはセッションへ流さない', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend');
    const confirmClaudeFullApproval = vi.fn(async () => false);
    const manager = createManager({ settings: { confirmClaudeFullApproval } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(confirmClaudeFullApproval).toHaveBeenCalledTimes(1);
    expect(setters.mode).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  // 以下、タブの承認方法はクリアで開き直した会話の起動引数（`calls[1].config`）から読む。
  // クリアはタブの値を持ち越すため、その時点のタブの値がそのまま出る（Issue #1890）

  it('全承認へ上げるための休止ができなければ、タブの値を戻して警告する（Issue #1890）', async () => {
    const { calls } = stubStartCapturing();
    const setters = stubSetters();
    vi.spyOn(ClaudeStreamSession.prototype, 'hasProcess', 'get').mockReturnValue(true);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(false);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(setters.mode).not.toHaveBeenCalled();
    expect(
      __mock.messages.warnings.some((m) => m.includes('作業中のため全承認にできませんでした')),
    ).toBe(true);
    await manager.clearActive();
    expect(calls[1]?.config.permissionMode).toBe(calls[0]?.config.permissionMode);
    expect(calls[1]?.config.permissionMode).not.toBe('bypassPermissions');
  });

  it('タスクの設定で起動したタブは全承認にせず警告する（Issue #1890）', async () => {
    stubStartCapturing();
    const setters = stubSetters();
    vi.spyOn(ClaudeStreamSession.prototype, 'hasProcess', 'get').mockReturnValue(true);
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend').mockResolvedValue(true);
    const manager = createManager();
    const task = await manager.openTaskSession(TASK_INPUT);

    await manager.simulateWebviewMessage(task.sessionId, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(__mock.messages.warnings).toContain(
      'タスクの設定で起動したタブは全承認にできません。承認方法は変えていません。',
    );
    expect(suspend).not.toHaveBeenCalled();
    expect(setters.mode).not.toHaveBeenCalled();
  });

  it('CLIが落ちているときの全承認は、警告も休止もせずタブの値だけ変える（Issue #1890）', async () => {
    // startを差し替えているためプロセスは無い（`hasProcess`は`false`）
    const { calls } = stubStartCapturing();
    const setters = stubSetters();
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend');
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(suspend).not.toHaveBeenCalled();
    expect(setters.mode).not.toHaveBeenCalled();
    expect(__mock.messages.warnings).toEqual([]);
    await manager.clearActive();
    expect(calls[1]?.config.permissionMode).toBe('bypassPermissions');
  });

  it('休止中に全承認を選ぶと、次の送信の再開で効くことを知らせる（Issue #1890）', async () => {
    const { sessions } = stubStartCapturing();
    const setters = stubSetters();
    const suspend = vi.spyOn(ClaudeStreamSession.prototype, 'suspend');
    const manager = createManager();
    const id = await openSession(manager);
    vi.spyOn(sessions[0] as ClaudeStreamSession, 'getState').mockReturnValue({
      ...(sessions[0] as ClaudeStreamSession).getState(),
      processSuspension: 'suspended',
    });

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'full' });
    await flush();

    expect(suspend).not.toHaveBeenCalled();
    expect(setters.mode).not.toHaveBeenCalled();
    expect(
      __mock.messages.infos.some((m) => m.includes('次の送信で全承認として起動し直します')),
    ).toBe(true);
  });

  it('休止中に全承認以外を選んでも知らせない（Issue #1890）', async () => {
    const { sessions } = stubStartCapturing();
    stubSetters();
    const manager = createManager();
    const id = await openSession(manager);
    vi.spyOn(sessions[0] as ClaudeStreamSession, 'getState').mockReturnValue({
      ...(sessions[0] as ClaudeStreamSession).getState(),
      processSuspension: 'suspended',
    });

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'auto' });
    await flush();

    expect(__mock.messages.infos).toEqual([]);
  });

  it('承認方法を既定へ戻すと、今の会話へ効かないことを画面でも知らせる（Issue #1890）', async () => {
    const { calls } = stubStartCapturing();
    const setters = stubSetters();
    const manager = createManager();
    const id = await openSession(manager);
    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'auto' });
    await flush();

    await manager.simulateWebviewMessage(id, { type: 'config', key: 'approvalMode', value: '' });
    await flush();

    expect(setters.mode).toHaveBeenCalledTimes(1);
    expect(
      __mock.messages.infos.some((m) =>
        m.includes('承認方法を既定へ戻しました。今動いているClaude Codeには効かず'),
      ),
    ).toBe(true);
    await manager.clearActive();
    expect(calls[1]?.config.permissionMode).toBe('');
  });

  it('webviewから来た未知の承認方法は捨て、タブの値を変えない（Issue #1890）', async () => {
    const { calls } = stubStartCapturing();
    const setters = stubSetters();
    const confirmClaudeFullApproval = vi.fn(async () => true);
    const manager = createManager({ settings: { confirmClaudeFullApproval } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, {
      type: 'config',
      key: 'approvalMode',
      value: 'bogus',
    });
    await flush();

    expect(setters.mode).not.toHaveBeenCalled();
    expect(confirmClaudeFullApproval).not.toHaveBeenCalled();
    await manager.clearActive();
    expect(calls[1]?.config.permissionMode).toBe(calls[0]?.config.permissionMode);
  });

  it('会話のクリアで開き直した会話は、タブで選んだ承認方法で起動する（Issue #1890）', async () => {
    const { calls } = stubStartCapturing();
    stubSetters();
    const manager = createManager();
    const id = await openSession(manager);
    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'auto' });
    await flush();

    await manager.clearActive();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.config.permissionMode).toBe(claudePermissionModeForLevel('auto'));
  });

  it('再開に失敗して新しい会話で送り直すときは、タブで選んだ承認方法で起動する（Issue #1890）', async () => {
    const { calls, sessions } = stubStartCapturing();
    stubSetters();
    vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
    const manager = createManager();
    const id = await openSession(manager);
    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'auto' });
    await flush();

    (sessions[0] as unknown as { resumeListener: (o: ResumeOutcome) => void }).resumeListener({
      kind: 'failed',
      reason: 'transcriptが無い',
      text: '送り直す',
      attachments: [],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.config.permissionMode).toBe(claudePermissionModeForLevel('auto'));
  });

  it('不正なapprovalLevelは保存せず警告する', async () => {
    stubStartCapturing();
    const updateApprovalLevel = vi.fn(async () => true);
    const manager = createManager({ settings: { updateApprovalLevel } });
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'approvalLevel', level: 'bogus' });
    await flush();

    expect(updateApprovalLevel).not.toHaveBeenCalled();
    expect(logged.warn.some((m) => m.includes('承認レベルの変更要求が不正です: bogus'))).toBe(true);
  });
});

describe('ループの開始と停止', () => {
  it('継続指示か回数が足りない計画は、エラーを出して始めない', async () => {
    stubStartCapturing();
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, {
      type: 'loop/start',
      plan: { initialPrompt: '開始', continuePrompt: '', maxIterations: 3 },
    });

    expect(__mock.messages.errors).toContain('ループの継続指示と最大回数を入力してください');
    expect(sendOrQueue).not.toHaveBeenCalled();
  });

  it('正しい計画は1回目の指示を送ってループを始め、停止で次を送らなくなる', async () => {
    const { sessions } = stubStartCapturing();
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    sendOrQueue.mockReturnValue('sent');
    const manager = createManager();
    const id = await openSession(manager);
    sessions[0]?.receive(initLine(id));

    await manager.simulateWebviewMessage(id, {
      type: 'loop/start',
      plan: { initialPrompt: '開始する', continuePrompt: '続ける', maxIterations: 2 },
    });

    expect(logged.info).toContain('ループ開始: 最大2回');
    expect(sendOrQueue).toHaveBeenCalledTimes(1);
    expect(sendOrQueue.mock.calls[0]?.[0]).toContain('開始する');

    await manager.simulateWebviewMessage(id, { type: 'loop/stop' });
    await flush();
    expect(sendOrQueue).toHaveBeenCalledTimes(1);
  });
});

describe('Reflexのskill選択を通る送信', () => {
  const enableSkillSelect = (): void => {
    __mock.setConfig('agent', { chat: { reflex: { enabled: true } } });
    Object.assign(fakeWindow, { setStatusBarMessage: vi.fn() });
  };

  const stubSend = () => {
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    sendOrQueue.mockReturnValue('sent');
    return sendOrQueue;
  };

  it('合うskillが選ばれたら、/skill名を前に付けて送り、判定を会話へ残す', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    const note = vi
      .spyOn(ClaudeStreamSession.prototype, 'noteLocalEvent')
      .mockImplementation(() => undefined);
    vi.spyOn(ClaudeStreamSession.prototype, 'prepareSkillSelection').mockResolvedValue([]);
    vi.mocked(selectSkill).mockResolvedValue({
      kind: 'selected',
      skill: { name: 'review', description: '' },
      probability: 0.9,
    });
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'send', text: 'レビューして' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(sendOrQueue.mock.calls[0]?.[0]).toBe('/review レビューして');
    expect(note.mock.calls[0]?.[1]).toContain('review');
  });

  it('合うskillが無ければ、元の本文のまま送る', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    vi.spyOn(ClaudeStreamSession.prototype, 'prepareSkillSelection').mockResolvedValue([]);
    vi.mocked(selectSkill).mockResolvedValue({ kind: 'none' });
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'send', text: '普通の依頼' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(sendOrQueue.mock.calls[0]?.[0]).toBe('普通の依頼');
  });

  it('skill一覧を取れなければ判定せず、元の本文のまま送る', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    vi.spyOn(ClaudeStreamSession.prototype, 'prepareSkillSelection').mockResolvedValue(undefined);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'send', text: '依頼' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(selectSkill).not.toHaveBeenCalled();
    expect(sendOrQueue.mock.calls[0]?.[0]).toBe('依頼');
  });

  it('判定が失敗しても警告して、元の本文のまま送る', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    vi.spyOn(ClaudeStreamSession.prototype, 'prepareSkillSelection').mockResolvedValue([]);
    vi.mocked(selectSkill).mockRejectedValue(new Error('timeout'));
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'send', text: '依頼' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(logged.warn.some((m) => m.includes('skill選択に失敗しました: timeout'))).toBe(true);
    expect(sendOrQueue.mock.calls[0]?.[0]).toBe('依頼');
  });

  it('/で始まる発言は判定にかけない', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'send', text: '/review これ' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(selectSkill).not.toHaveBeenCalled();
  });

  it('判定中に中断したら送らず、本文を入力欄へ戻す', async () => {
    stubStartCapturing();
    enableSkillSelect();
    const sendOrQueue = stubSend();
    vi.spyOn(ClaudeStreamSession.prototype, 'interrupt').mockImplementation(() => undefined);
    vi.spyOn(ClaudeStreamSession.prototype, 'prepareSkillSelection').mockResolvedValue([]);
    let finishJudging: (r: { kind: 'none' }) => void = () => undefined;
    vi.mocked(selectSkill).mockReturnValue(
      new Promise((resolve) => {
        finishJudging = resolve;
      }),
    );
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'send', text: '取り消す依頼' });
    await vi.waitFor(() => expect(selectSkill).toHaveBeenCalledTimes(1));
    await manager.simulateWebviewMessage(id, { type: 'interrupt' });
    finishJudging({ kind: 'none' });

    await vi.waitFor(() =>
      expect(sentOfType(panel, 'restoreQueuedText').map((m) => m['text'])).toEqual([
        '取り消す依頼',
      ]),
    );
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe('webviewメッセージの振り分け: エディタ・出力・診断', () => {
  /** モックの`activeTextEditor`はgetterのため、このテストの間だけ差し替えて元へ戻す。 */
  const withActiveEditor = async (editor: unknown, run: () => Promise<void>): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(fakeWindow, 'activeTextEditor');
    Object.defineProperty(fakeWindow, 'activeTextEditor', { value: editor, configurable: true });
    try {
      await run();
    } finally {
      if (original !== undefined) {
        Object.defineProperty(fakeWindow, 'activeTextEditor', original);
      }
    }
  };

  it('insertCodeはアクティブなエディタの選択範囲を本文で置き換え、エディタが無ければ知らせる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await withActiveEditor(undefined, async () => {
      await manager.simulateWebviewMessage(id, { type: 'insertCode', code: 'const a = 1;' });
      await vi.waitFor(() =>
        expect(__mock.messages.infos).toContain('挿入先のエディタが開かれていません'),
      );
    });

    const selection = { start: 0, end: 3 };
    const replace = vi.fn();
    const edit = vi.fn(async (callback: (builder: { replace: typeof replace }) => void) => {
      callback({ replace });
      return true;
    });
    await withActiveEditor({ selections: [selection], edit }, async () => {
      await manager.simulateWebviewMessage(id, { type: 'insertCode', code: 'const b = 2;' });
      await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    });
    expect(replace).toHaveBeenCalledWith(selection, 'const b = 2;');
  });

  it('openCodeFileは本文を保存前のタブとして開く。codeが文字列でなければ無視する', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'openCodeFile', code: 42 });
    await manager.simulateWebviewMessage(id, {
      type: 'openCodeFile',
      code: 'fn main() {}',
      lang: 'rs',
    });

    await vi.waitFor(() => expect(__mock.untitledDocumentContents).toEqual(['fn main() {}']));
    expect(__mock.openedTextDocumentPaths).toEqual(['untitled:1']);
  });

  it('openItemOutputは退避した全文をタブで開き、読めなければ警告する', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const load = vi.spyOn(sessions[0] as ClaudeStreamSession, 'loadOffloadedOutput');

    load.mockResolvedValueOnce('退避された出力の全文');
    await manager.simulateWebviewMessage(id, { type: 'openItemOutput', itemId: 'item-1' });
    await vi.waitFor(() =>
      expect(__mock.untitledDocumentContents).toEqual(['退避された出力の全文']),
    );
    expect(load).toHaveBeenCalledWith('item-1');

    load.mockResolvedValueOnce(undefined);
    await manager.simulateWebviewMessage(id, { type: 'openItemOutput', itemId: 'item-2' });
    await vi.waitFor(() =>
      expect(
        __mock.messages.warnings.some((m) => m.includes('ツール出力の全文を読めませんでした')),
      ).toBe(true),
    );

    // itemIdが文字列でなければ読みにいかない
    await manager.simulateWebviewMessage(id, { type: 'openItemOutput', itemId: 3 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('exportTranscriptは会話が空なら取り出せない旨を知らせる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'exportTranscript' });

    await vi.waitFor(() =>
      expect(__mock.messages.infos).toContain('会話がまだ無いため取り出せません'),
    );
  });

  it('差分の操作は、存在しない項目なら何も開かず警告も出さない', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, {
      type: 'openDiffFile',
      itemId: 'none',
      diffIndex: 0,
    });
    await manager.simulateWebviewMessage(id, {
      type: 'openDiffEditor',
      itemId: 'none',
      diffIndex: 0,
    });
    await manager.simulateWebviewMessage(id, { type: 'revertDiff', itemId: 'none', diffIndex: 0 });
    await flush();

    expect(__mock.openedTextDocumentPaths).toEqual([]);
    expect(__mock.messages.warnings).toEqual([]);
    expect(__mock.executedCommands).not.toContain('vscode.diff');
    expect(__mock.executedCommands).not.toContain('agent.localReview.registerDiff');
  });

  describe('確認を伴う操作', () => {
    it('compactは確認が通ったときだけセッションを圧縮し、失敗はエラーとして知らせる', async () => {
      const { sessions } = stubStartCapturing();
      const manager = createManager();
      const id = await openSession(manager);
      const compact = vi.spyOn(sessions[0] as ClaudeStreamSession, 'compact');
      compact.mockImplementation(() => undefined);

      __mock.showWarningMessageAnswer = undefined;
      await manager.simulateWebviewMessage(id, { type: 'compact' });
      await flush();
      expect(compact).not.toHaveBeenCalled();

      __mock.showWarningMessageAnswer = '圧縮する';
      await manager.simulateWebviewMessage(id, { type: 'compact' });
      await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));

      compact.mockImplementation(() => {
        throw new Error('圧縮できない');
      });
      await manager.simulateWebviewMessage(id, { type: 'compact' });
      await vi.waitFor(() => expect(__mock.messages.errors).toContain('Claude Code: 圧縮できない'));
      expect(logged.error).toContain('Claude Code画面: 圧縮できない');
    });

    it('debugCommandは確認が通ったときだけ/debugを送り、失敗はエラーとして知らせる', async () => {
      const { sessions } = stubStartCapturing();
      const manager = createManager();
      const id = await openSession(manager);
      const send = vi.spyOn(sessions[0] as ClaudeStreamSession, 'sendDebugCommand');
      send.mockImplementation(() => undefined);

      __mock.showWarningMessageAnswer = undefined;
      await manager.simulateWebviewMessage(id, { type: 'debugCommand' });
      await flush();
      expect(send).not.toHaveBeenCalled();

      __mock.showWarningMessageAnswer = '送る';
      await manager.simulateWebviewMessage(id, { type: 'debugCommand' });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      send.mockImplementation(() => {
        throw new Error('送れない');
      });
      await manager.simulateWebviewMessage(id, { type: 'debugCommand' });
      await vi.waitFor(() => expect(__mock.messages.errors).toContain('Claude Code: 送れない'));
    });

    it('stopBackgroundTaskは確認が通ったときだけタスクを止める。表示名が無ければidを見せる', async () => {
      const { sessions } = stubStartCapturing();
      const manager = createManager();
      const id = await openSession(manager);
      const stop = vi.spyOn(sessions[0] as ClaudeStreamSession, 'stopBackgroundTask');
      stop.mockImplementation(() => undefined);

      __mock.showWarningMessageAnswer = undefined;
      await manager.simulateWebviewMessage(id, {
        type: 'stopBackgroundTask',
        id: 'bg-1',
        command: 'npm run dev',
      });
      await flush();
      expect(stop).not.toHaveBeenCalled();
      expect(__mock.messages.warnings).toContain(
        'バックグラウンドで実行中のタスクを停止します: npm run dev',
      );

      __mock.showWarningMessageAnswer = '停止する';
      await manager.simulateWebviewMessage(id, { type: 'stopBackgroundTask', id: 'bg-2' });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('bg-2'));
      expect(__mock.messages.warnings).toContain(
        'バックグラウンドで実行中のタスクを停止します: bg-2',
      );

      stop.mockImplementation(() => {
        throw new Error('止められない');
      });
      await manager.simulateWebviewMessage(id, { type: 'stopBackgroundTask', id: 'bg-3' });
      await vi.waitFor(() => expect(__mock.messages.errors).toContain('Claude Code: 止められない'));
    });

    it('recapとautocompactWindowの失敗はエラーとして知らせる', async () => {
      const { sessions } = stubStartCapturing();
      const manager = createManager();
      const id = await openSession(manager);
      const session = sessions[0] as ClaudeStreamSession;
      const recap = vi.spyOn(session, 'recap').mockImplementation(() => {
        throw new Error('要約できない');
      });
      const window = vi.spyOn(session, 'setAutocompactWindow').mockImplementation(() => {
        throw new Error('窓を変えられない');
      });

      await manager.simulateWebviewMessage(id, { type: 'recap' });
      await manager.simulateWebviewMessage(id, { type: 'autocompactWindow', window: '200k' });

      expect(recap).toHaveBeenCalledTimes(1);
      expect(window).toHaveBeenCalledWith('200k');
      expect(__mock.messages.errors).toEqual([
        'Claude Code: 要約できない',
        'Claude Code: 窓を変えられない',
      ]);
    });
  });
});

describe('ゴールの下書き（loop/planGoal）', () => {
  it('本文が空なら下書きを作らず、要求のidを添えて入力を促す', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'loop/planGoal', id: 7, text: '   ' });

    await vi.waitFor(() => expect(sentOfType(panel, 'loop/goalDraft')).toHaveLength(1));
    expect(sentOfType(panel, 'loop/goalDraft')[0]).toEqual({
      type: 'loop/goalDraft',
      id: 7,
      ok: false,
      message: '目的と受入基準を入力してください',
    });
    expect(planGoalDraft).not.toHaveBeenCalled();
  });

  it('下書きが作れたら、作業ディレクトリと本文を渡して結果を返す。確認が既定なので自動開始しない', async () => {
    stubStartCapturing();
    const goal = { objective: '目的', acceptance: ['基準'] };
    vi.mocked(planGoalDraft).mockResolvedValue({
      ok: true,
      goal: goal as never,
      provenance: 'user' as never,
    });
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'loop/planGoal', id: 8, text: ' 直したい ' });

    await vi.waitFor(() => expect(sentOfType(panel, 'loop/goalDraft')).toHaveLength(1));
    expect(sentOfType(panel, 'loop/goalDraft')[0]).toEqual({
      type: 'loop/goalDraft',
      id: 8,
      ok: true,
      goal,
      provenance: 'user',
      start: false,
    });
    expect(vi.mocked(planGoalDraft).mock.calls[0]?.[0]).toBe('/workspace/root');
    expect(vi.mocked(planGoalDraft).mock.calls[0]?.[1]).toBe('直したい');
    expect(vi.mocked(planGoalDraft).mock.calls[0]?.[2]).toBe('claude');
  });

  it('下書きの生成が例外で終わっても、失敗の応答を1回返して警告に残す', async () => {
    stubStartCapturing();
    vi.mocked(planGoalDraft).mockRejectedValue(new Error('gh落ち'));
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'loop/planGoal', id: 9, text: '直したい' });

    await vi.waitFor(() => expect(sentOfType(panel, 'loop/goalDraft')).toHaveLength(1));
    expect(sentOfType(panel, 'loop/goalDraft')[0]).toMatchObject({
      id: 9,
      ok: false,
      message: 'ゴールの下書きの生成に失敗しました',
    });
    expect(logged.warn).toContain('ゴールの下書きの生成に失敗しました: gh落ち');
  });
});

describe('WebGPTとの議論（現在の会話から開始）', () => {
  const request = {
    endpoint: 'http://127.0.0.1:9222',
    topic: 'キャッシュの置き場所',
    urls: [] as string[],
    maxSends: 2,
  };

  it('会話が開かれていなければ、開始できない理由を知らせる', async () => {
    const manager = createManager();

    await manager.discussWithWebGpt();

    expect(__mock.messages.errors).toEqual([
      'WebGPTとの議論を開始できませんでした: 議論するClaude Codeの会話を開いてください',
    ]);
    expect(prepareWebGptDiscussion).not.toHaveBeenCalled();
  });

  it('入力を取り消したら、MCPへの接続も送信もしない', async () => {
    const { sessions } = stubStartCapturing();
    const ensure = vi.spyOn(ClaudeStreamSession.prototype, 'ensureMcpServer');
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    vi.mocked(prepareWebGptDiscussion).mockResolvedValue(undefined);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'webGptDiscussion' });

    await vi.waitFor(() => expect(prepareWebGptDiscussion).toHaveBeenCalledWith(true));
    expect(sessions).toHaveLength(1);
    expect(ensure).not.toHaveBeenCalled();
    expect(sendOrQueue).not.toHaveBeenCalled();
    expect(__mock.messages.errors).toEqual([]);
  });

  it('応答中の会話では始めず、完了後にやり直すよう知らせる', async () => {
    const { sessions } = stubStartCapturing();
    const ensure = vi.spyOn(ClaudeStreamSession.prototype, 'ensureMcpServer');
    const manager = createManager();
    const id = await openSession(manager);
    const session = sessions[0] as ClaudeStreamSession;
    vi.spyOn(session, 'getState').mockReturnValue({ ...session.getState(), busy: true });

    await manager.simulateWebviewMessage(id, { type: 'webGptDiscussion' });

    await vi.waitFor(() =>
      expect(__mock.messages.errors).toEqual([
        'WebGPTとの議論を開始できませんでした: Claude Codeの応答と送信待ちの完了後に、もう一度開始してください',
      ]),
    );
    expect(prepareWebGptDiscussion).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('Reflexが無効なら、PlaywrightのMCPを接続して議題を含む指示をそのまま送る', async () => {
    stubStartCapturing();
    const ensure = vi
      .spyOn(ClaudeStreamSession.prototype, 'ensureMcpServer')
      .mockResolvedValue(undefined);
    const sendOrQueue = vi
      .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
      .mockReturnValue('sent');
    vi.mocked(prepareWebGptDiscussion).mockResolvedValue(request);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'webGptDiscussion' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[0]).toBe(WEB_GPT_MCP_SERVER);
    expect(ensure.mock.calls[0]?.[1]).toEqual(buildWebGptMcpConfig(request.endpoint));
    expect(sendOrQueue.mock.calls[0]?.[0]).toContain('キャッシュの置き場所');
    expect(__mock.messages.errors).toEqual([]);
  });

  it('Reflexが有効なら、完了判定つきのループとして議論を始める', async () => {
    stubStartCapturing();
    __mock.setConfig('agent', { chat: { reflex: { enabled: true } } });
    vi.spyOn(ClaudeStreamSession.prototype, 'ensureMcpServer').mockResolvedValue(undefined);
    const sendOrQueue = vi
      .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
      .mockReturnValue('sent');
    vi.mocked(prepareWebGptDiscussion).mockResolvedValue(request);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'webGptDiscussion' });

    await vi.waitFor(() => expect(sendOrQueue).toHaveBeenCalledTimes(1));
    expect(sendOrQueue.mock.calls[0]?.[0]).toContain('キャッシュの置き場所');
  });

  it('MCPの接続に失敗したら、何も送らず理由を知らせる', async () => {
    stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'ensureMcpServer').mockRejectedValue(
      new Error('npxが無い'),
    );
    const sendOrQueue = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue');
    vi.mocked(prepareWebGptDiscussion).mockResolvedValue(request);
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'webGptDiscussion' });

    await vi.waitFor(() =>
      expect(__mock.messages.errors).toEqual(['WebGPTとの議論を開始できませんでした: npxが無い']),
    );
    expect(sendOrQueue).not.toHaveBeenCalled();
  });
});

describe('引き継ぎの失敗系と後始末', () => {
  const TRANSCRIPT = '/home/user/.claude/x.jsonl';

  const handoffStore = (): ClaudeSessionStore =>
    fakeStore({ resolveTranscriptPath: async () => TRANSCRIPT });

  const assistantTextLine = (uuid: string, text: string): string =>
    `${JSON.stringify({
      type: 'assistant',
      uuid,
      message: { id: uuid, content: [{ type: 'text', text }] },
    })}\n`;

  beforeEach(() => {
    // 引き継ぎ先のレベル判定は実CLIを起動するため切る。確認ダイアログも既定の自動承認に任せる
    __mock.setConfig('agent', { 'autoHandoff.router': false });
  });

  it('ポインタの置き場所が渡されていなければ、新しいタブを開かずに警告する', async () => {
    stubStartCapturing();
    const manager = createManager({ store: handoffStore(), globalStorageDir: null });
    await openSession(manager);

    await manager.handoffToNewSession();

    expect(logged.warn).toContain(
      '引き継ぎのポインタファイルの置き場所が渡されていないため引き継げません',
    );
    expect(__mock.createdPanels).toHaveLength(1);
    // 手動操作でも、この失敗には専用のダイアログを出さない（ログだけ）
    expect(__mock.messages.errors).toEqual([]);
  });

  it('ポインタを書けなければエラーとして知らせ、新しいタブを開かない', async () => {
    stubStartCapturing();
    const blocker = join(makeTempDir('claude-handoff-blocker-'), 'file');
    writeFileSync(blocker, 'x');
    // ディレクトリを作るべき場所が通常ファイルのため、書き出しが失敗する
    const manager = createManager({
      store: handoffStore(),
      globalStorageDir: join(blocker, 'sub'),
    });
    await openSession(manager);

    await manager.handoffToNewSession();

    expect(__mock.createdPanels).toHaveLength(1);
    expect(__mock.messages.errors).toHaveLength(1);
    expect(__mock.messages.errors[0]).toMatch(/^Claude Code: /u);
    expect(logged.error[0]).toMatch(/^Claude Code画面: /u);
  });

  it('transcriptの解決が例外になっても、例外で止まった旨を知らせて次の引き継ぎを受け付ける', async () => {
    stubStartCapturing();
    const resolve = vi.fn().mockRejectedValueOnce(new Error('disk error'));
    resolve.mockResolvedValue(undefined);
    const manager = createManager({
      store: fakeStore({ resolveTranscriptPath: resolve }),
    });
    await openSession(manager);

    await manager.handoffToNewSession();

    expect(logged.warn).toContain('引き継ぎが例外で止まりました: disk error');
    expect(__mock.messages.errors).toContain('引き継ぎが例外で止まりました: disk error');

    // 準備中の印は後始末されているので、同じタブから再度引き継げる（今度はtranscript無しで失敗する）
    const retry = manager.handoffToNewSession();
    await vi.runAllTimersAsync();
    await retry;
    expect(__mock.messages.errors).toContain(
      '引き継ぎ元セッションのtranscriptが見つかりませんでした',
    );
  });

  it('準備中にもう一度押すと、待つよう知らせるだけで二重には始めない', async () => {
    stubStartCapturing();
    vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
    let release: (path: string) => void = () => undefined;
    const store = fakeStore({
      resolveTranscriptPath: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const manager = createManager({ store });
    await openSession(manager);

    const first = manager.handoffToNewSession();
    await manager.handoffToNewSession();
    expect(__mock.messages.infos).toContain('引き継ぎを準備しています。終わるまでお待ちください');

    release(TRANSCRIPT);
    await first;
    // 新しいタブは1枚だけ増える
    expect(__mock.createdPanels).toHaveLength(2);
  });

  it('引き継ぎ先のタブを開けなければ、旧タブを残して失敗を知らせる', async () => {
    stubStartCapturing();
    const manager = createManager({ store: handoffStore() });
    await openSession(manager);
    const open = vi.spyOn(manager, 'openNew').mockResolvedValue(undefined);

    await manager.handoffToNewSession();

    expect(open).toHaveBeenCalled();
    expect(logged.warn).toContain('引き継ぎ先セッションを開けませんでした');
    expect(logged.warn).toContain(
      '引き継ぎ先のセッションを開けませんでした。旧タブはそのまま残ります',
    );
    expect(__mock.messages.errors).toEqual([
      '引き継ぎ先のセッションを開けませんでした。旧タブはそのまま残ります',
    ]);
    expect(__mock.createdPanels[0]?.disposed).toBe(false);
  });

  it('開いたタブが一覧に無ければ、その旨を警告して失敗として扱う', async () => {
    stubStartCapturing();
    const manager = createManager({ store: handoffStore() });
    await openSession(manager);
    vi.spyOn(manager, 'openNew').mockResolvedValue('ghost-session');

    await manager.handoffToNewSession();

    expect(logged.warn).toContain(
      '引き継ぎ先セッション(ghost-session)がパネル一覧に見つかりませんでした',
    );
    expect(__mock.messages.errors).toEqual([
      '引き継ぎ先のセッションを開けませんでした。旧タブはそのまま残ります',
    ]);
  });

  it('初回プロンプトを送れなければ新タブを閉じ、ポインタだけの本文でもう一度試す', async () => {
    stubStartCapturing();
    const sendOrQueue = vi
      .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
      .mockImplementation(() => {
        throw new Error('stdin closed');
      });
    const manager = createManager({ store: handoffStore() });
    await openSession(manager);

    await manager.handoffToNewSession();

    expect(sendOrQueue.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(logged.warn).toContain('引き継ぎ先へ初回プロンプトを送れませんでした: stdin closed');
    // 試行ごとに開いた新タブは閉じられ、旧タブだけが残る
    expect(__mock.createdPanels.length).toBe(1 + sendOrQueue.mock.calls.length);
    expect(__mock.createdPanels.slice(1).every((p) => p.disposed)).toBe(true);
    expect(__mock.createdPanels[0]?.disposed).toBe(false);
    expect(__mock.messages.errors).toEqual([
      '引き継ぎ先のセッションを開けませんでした。旧タブはそのまま残ります',
    ]);
  });

  describe('引き継ぎに成功したとき', () => {
    /** 手動で引き継ぎ、新旧のセッションと、送った初回プロンプトの受領idを返す。 */
    async function handOff(): Promise<{
      manager: ClaudeChatViewManager;
      oldId: string;
      sessions: ClaudeStreamSession[];
      sendOrQueue: ReturnType<typeof vi.spyOn>;
      acceptanceId: string;
      rename: ReturnType<typeof vi.fn>;
    }> {
      const { sessions } = stubStartCapturing();
      const sendOrQueue = vi
        .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
        .mockReturnValue('sent');
      const rename = vi.fn(async () => undefined);
      const manager = createManager({
        store: fakeStore({ resolveTranscriptPath: async () => TRANSCRIPT, rename }),
      });
      const oldId = await openSession(manager);
      sessions[0]?.receive(initLine(oldId));
      await manager.simulateWebviewMessage(oldId, { type: 'autoHandoff', on: true });
      await manager.simulateWebviewMessage(oldId, { type: 'autoHandoffAutoApprove', on: false });
      await manager.simulateWebviewMessage(oldId, { type: 'autoReply', on: true });

      await manager.handoffToNewSession();

      expect(sessions).toHaveLength(2);
      const sent = String(sendOrQueue.mock.calls[0]?.[0]);
      const acceptanceId = /HANDOFF_ACCEPTED (\S+)\s*$/u.exec(sent)?.[1] ?? '';
      expect(acceptanceId).not.toBe('');
      return { manager, oldId, sessions, sendOrQueue, acceptanceId, rename };
    }

    it('自動引き継ぎと自動返信の設定を新セッションへ持ち越し、旧セッションの自動返信は止める', async () => {
      const { oldId, sessions, rename } = await handOff();

      expect(sessions[1]?.getState().autoHandoff).toBe(true);
      expect(sessions[1]?.getState().autoReply).toBe(true);
      expect(sessions[0]?.getState().autoReply).toBe(false);
      // 新タブへ名前を付け、保存先にも同じ名前を書く
      expect(rename).toHaveBeenCalledTimes(1);
      const [newId, name] = rename.mock.calls[0] as unknown as [string, string];
      expect(newId).not.toBe(oldId);
      expect(name).not.toBe('');
    });

    it('新セッションが受領行を返したら、旧セッションを止めてタブを閉じる', async () => {
      const { oldId, sessions, acceptanceId } = await handOff();
      const interrupt = vi.spyOn(sessions[0] as ClaudeStreamSession, 'interrupt');
      const oldPanel = __mock.createdPanels[0];

      sessions[1]?.receive(
        initLine('new-session') +
          assistantTextLine('m1', `3点を整理した\nHANDOFF_ACCEPTED ${acceptanceId}`),
      );

      await vi.waitFor(() => expect(oldPanel?.disposed).toBe(true));
      expect(interrupt).toHaveBeenCalled();
      expect(logged.info).toContain(
        '引き継ぎ元のセッションを停止してタブを閉じます（履歴は残ります）',
      );
      expect(oldId).not.toBe('');
    });

    it('closeOldTabを切っていれば確認し、停止を選ぶと旧タブを閉じる', async () => {
      __mock.setConfig('agent', {
        'autoHandoff.router': false,
        'autoHandoff.closeOldTab': false,
      });
      const { sessions, acceptanceId } = await handOff();
      const interrupt = vi.spyOn(sessions[0] as ClaudeStreamSession, 'interrupt');
      const oldPanel = __mock.createdPanels[0];

      sessions[1]?.receive(
        initLine('new-session') + assistantTextLine('m1', `HANDOFF_ACCEPTED ${acceptanceId}`),
      );

      await vi.waitFor(() => expect(oldPanel?.disposed).toBe(true));
      expect(__mock.messages.infos).toContain(
        '新しいセッションへの引き継ぎが終わりました。引き継ぎ元のセッションを停止しますか？',
      );
      expect(interrupt).toHaveBeenCalled();
    });

    it('停止の確認を閉じたら旧タブを残し、その理由をログに残す', async () => {
      __mock.setConfig('agent', {
        'autoHandoff.router': false,
        'autoHandoff.closeOldTab': false,
      });
      const { sessions, acceptanceId } = await handOff();
      __mock.showInformationMessageAnswer = undefined;
      const oldPanel = __mock.createdPanels[0];

      sessions[1]?.receive(
        initLine('new-session') + assistantTextLine('m1', `HANDOFF_ACCEPTED ${acceptanceId}`),
      );

      await vi.waitFor(() =>
        expect(logged.info.some((m) => m.includes('reason=userDismissed'))).toBe(true),
      );
      expect(oldPanel?.disposed).toBe(false);
    });

    it('新セッションが何も返さないまま待ち時間が過ぎたら、旧タブを残す', async () => {
      const { sessions } = await handOff();
      const oldPanel = __mock.createdPanels[0];

      await vi.advanceTimersByTimeAsync(300_000);

      await vi.waitFor(() =>
        expect(logged.info.some((m) => m.includes('reason=noResponse'))).toBe(true),
      );
      expect(oldPanel?.disposed).toBe(false);
      expect(sessions[0]?.getState().autoReply).toBe(false);
    });

    it('応答はあっても受領行が無いままターンが終わったら、旧タブを残す', async () => {
      const { sessions } = await handOff();
      const oldPanel = __mock.createdPanels[0];

      sessions[1]?.receive(
        initLine('new-session') +
          assistantTextLine('m1', '3点を整理した') +
          `${JSON.stringify({ type: 'result' })}\n`,
      );

      await vi.waitFor(() =>
        expect(logged.info.some((m) => m.includes('reason=notAccepted'))).toBe(true),
      );
      expect(oldPanel?.disposed).toBe(false);
    });
  });
});

describe('セカンドオピニオンの経路', () => {
  const assistantLine = (uuid: string, text: string): string =>
    `${JSON.stringify({
      type: 'assistant',
      uuid,
      message: { id: uuid, content: [{ type: 'text', text }] },
    })}\n`;

  const portOf = (fn: unknown): SecondOpinionPanelPort =>
    (fn as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as SecondOpinionPanelPort;

  it('依頼先が注入されていなければ、起動せずにエラーで知らせる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'secondOpinion' });

    expect(__mock.messages.errors).toEqual(['セカンドオピニオンの依頼先（Codex）を利用できません']);
    expect(startSecondOpinion).not.toHaveBeenCalled();
  });

  it('依頼先があれば、この会話用の口と依頼先を渡して起動する', async () => {
    stubStartCapturing();
    const manager = createManager();
    const host = { name: 'host' } as never;
    manager.setSecondOpinionHost(host);
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'secondOpinion' });

    await vi.waitFor(() => expect(startSecondOpinion).toHaveBeenCalledTimes(1));
    const args = vi.mocked(startSecondOpinion).mock.calls[0] as unknown[];
    expect((args[0] as SecondOpinionPanelPort).cwd).toBe('/workspace/root');
    expect(args[1]).toBe(host);
    expect(__mock.messages.errors).toEqual([]);
  });

  it('追加の相談・材料の更新・指示の下書きは、同じ会話の口を付けて委ねる', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'secondOpinionContinue' });
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionUpdateMaterial' });
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionDraft' });

    for (const fn of [
      continueSecondOpinion,
      updateSecondOpinionMaterial,
      draftSecondOpinionHandoff,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(portOf(fn).cwd).toBe('/workspace/root');
    }
    expect(portOf(continueSecondOpinion).parentSessionId).toBe(
      portOf(draftSecondOpinionHandoff).parentSessionId,
    );
  });

  it('終了と項目からの停止は、相談の鍵と項目idを渡す', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);

    await manager.simulateWebviewMessage(id, { type: 'secondOpinionContinue' });
    const key = portOf(continueSecondOpinion).parentSessionId;
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionEnd' });
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionStop', itemId: 'so-1' });
    // itemIdが文字列でなければ止めない
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionStop', itemId: 5 });

    expect(vi.mocked(endSecondOpinionConsult).mock.calls[0]?.[0]).toBe(key);
    expect(vi.mocked(endSecondOpinionConsult).mock.calls[0]?.[2]).toBe('userEnded');
    expect(stopSecondOpinion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stopSecondOpinion).mock.calls[0]?.[0]).toBe(key);
    expect(vi.mocked(stopSecondOpinion).mock.calls[0]?.[2]).toBe('so-1');
  });

  it('承認は、口が保持した下書きそのものを渡す。下書きが無ければundefined', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();

    await manager.simulateWebviewMessage(id, { type: 'secondOpinionApprove' });
    expect(vi.mocked(approveSecondOpinionHandoff).mock.calls[0]?.[2]).toBeUndefined();

    await manager.simulateWebviewMessage(id, { type: 'secondOpinionDraft' });
    const port = portOf(draftSecondOpinionHandoff);
    const draft = { text: '直して' } as never;
    port.setHandoffDraft?.(draft);
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionApprove' });

    expect(vi.mocked(approveSecondOpinionHandoff).mock.calls[1]?.[2]).toBe(draft);
    // webviewへは真偽値だけを渡し、指示文は往復させない
    expect(sentOfType(panel, 'secondOpinionHandoff')).toEqual([
      { type: 'secondOpinionHandoff', hasDraft: true },
    ]);
    port.setHandoffDraft?.(undefined);
    expect(sentOfType(panel, 'secondOpinionHandoff')[1]).toEqual({
      type: 'secondOpinionHandoff',
      hasDraft: false,
    });
  });

  it('口は、直近の応答・会話の記録・実行中表示・ボタン表示をこの会話から返す', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionContinue' });
    const port = portOf(continueSecondOpinion);
    expect(port.lastAssistantResponse()).toBe('');

    sessions[0]?.receive(initLine('so-session') + assistantLine('a1', '最初の応答'));
    sessions[0]?.receive(assistantLine('a2', '最後の応答'));

    expect(port.lastAssistantResponse()).toBe('最後の応答');
    expect(port.conversationTranscript()).toContain('最後の応答');
    port.setRunning(true);
    port.setAdvisorItem?.('item-1', { canUpdateMaterial: true });
    port.setAdvisorItem?.(undefined);
    expect(sentOfType(panel, 'secondOpinionRunning')).toEqual([
      { type: 'secondOpinionRunning', running: true },
    ]);
    expect(sentOfType(panel, 'secondOpinionAdvisor')).toEqual([
      { type: 'secondOpinionAdvisor', itemId: 'item-1', canUpdateMaterial: true },
      { type: 'secondOpinionAdvisor', itemId: undefined, canUpdateMaterial: false },
    ]);
  });

  it('口のnoteは会話へ項目を残し、承認された指示は作業中のAIへ送る', async () => {
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionContinue' });
    const port = portOf(continueSecondOpinion);
    sessions[0]?.receive(initLine('so-session'));
    const sendOrQueue = vi
      .spyOn(ClaudeStreamSession.prototype, 'sendOrQueue')
      .mockReturnValue('queued' as never);

    port.note('so-note', { status: 'completed', text: '評価', detail: '詳細' });
    const outcome = await port.sendApprovedInstruction?.('この方針で直して');

    expect(outcome).toBe('queued');
    expect(sendOrQueue).toHaveBeenCalledWith('この方針で直して', []);
    const items = sessions[0]?.getState().items ?? [];
    expect(items.some((item) => item.id === 'so-note')).toBe(true);
  });

  it('タブを閉じると、相談相手を親の破棄として閉じる。閉じた後は破棄済みと答える', async () => {
    stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const panel = __mock.lastCreatedPanel();
    await manager.simulateWebviewMessage(id, { type: 'secondOpinionContinue' });
    const port = portOf(continueSecondOpinion);
    expect(port.isParentDisposed?.()).toBe(false);

    panel?.dispose();

    expect(port.isParentDisposed?.()).toBe(true);
    expect(endSecondOpinionConsult).toHaveBeenCalledWith(
      port.parentSessionId,
      expect.anything(),
      'parentDisposed',
    );
  });
});

describe('自動引き継ぎ: 区切り待ちの契機（Reflex・分類器）', () => {
  const userLine = (uuid: string, text: string): string =>
    `${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
  const assistantLine = (uuid: string, text: string): string =>
    `${JSON.stringify({
      type: 'assistant',
      uuid,
      message: { id: uuid, content: [{ type: 'text', text }] },
    })}\n`;
  const resultLine = `${JSON.stringify({ type: 'result' })}\n`;

  const verdict = (overrides?: { suggested?: number; reading?: number; boundary?: number }) => ({
    suggested: overrides?.suggested ?? 0.1,
    reading: overrides?.reading ?? 0.1,
    stage: { 区切り: overrides?.boundary ?? 0.9, 判断待ち: 0.05, 途中: 0.05 },
  });

  const assessment = {
    taskType: 'implementation',
    difficulty: 0,
    scope: 0,
    ambiguity: 0,
    risk: 0,
    autonomy: 0,
    confidence: 0.8,
    reasons: [],
    switchSafe: true,
    switchReason: '区切り',
    handoffSuggested: false,
    handoffSuggestReason: '',
    awaitingUserAnswer: false,
  };

  const probeOf = (overrides?: Record<string, unknown>) =>
    ({
      assessment,
      switchSafe: true,
      switchReason: '区切り',
      handoffSuggested: false,
      handoffSuggestReason: '',
      awaitingUserAnswer: false,
      awaitingUserAnswerReason: '',
      profileChanged: false,
      profileDiffers: false,
      profile: { model: 'm', effort: 'e' },
      ...overrides,
    }) as never;

  /** 自動引き継ぎをONにしたセッションで、1ターンを完了させる。引き継ぎの発火だけ記録する。 */
  async function finishedTurn(options: {
    reflex: boolean;
    router?: boolean;
    assistantText?: string;
    userText?: string;
    config?: Record<string, unknown>;
  }): Promise<{
    requestHandoff: ReturnType<typeof vi.fn>;
    manager: ClaudeChatViewManager;
    sessions: ClaudeStreamSession[];
    id: string;
  }> {
    __mock.setConfig('agent', {
      'chat.reflex.enabled': options.reflex,
      'autoHandoff.router': options.router ?? false,
      ...options.config,
    });
    const { sessions } = stubStartCapturing();
    const manager = createManager();
    const id = await openSession(manager);
    const requestHandoff = vi.fn().mockResolvedValue(undefined);
    (manager as unknown as { requestHandoff: unknown }).requestHandoff = requestHandoff;
    await manager.simulateWebviewMessage(id, { type: 'autoHandoff', on: true });
    sessions[0]?.receive(
      initLine('s1') +
        userLine('u1', options.userText ?? '機能を作って') +
        assistantLine('a1', options.assistantText ?? '作りました') +
        resultLine,
    );
    await flush();
    return { requestHandoff, manager, sessions, id };
  }

  it('Reflexが引き継ぎの提案と区切りを返せば、assistantSuggestedで発火する', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict({ suggested: 0.9 }));

    const { requestHandoff } = await finishedTurn({ reflex: true });

    await vi.waitFor(() => expect(requestHandoff).toHaveBeenCalledTimes(1));
    expect(requestHandoff.mock.calls[0]?.[1]).toMatchObject({ kind: 'assistantSuggested' });
    const material = vi.mocked(judgeHandoffBoundary).mock.calls[0]?.[1];
    expect(material).toEqual({ userMessage: '機能を作って', assistantMessage: '作りました' });
  });

  it('Reflexが提案も区切りも返さなければ発火しない', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict({ boundary: 0.1 }));

    const { requestHandoff } = await finishedTurn({ reflex: true });

    await vi.waitFor(() => expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('Reflexの判定が失敗（undefined）なら発火しない', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(undefined);

    const { requestHandoff } = await finishedTurn({ reflex: true });

    await vi.waitFor(() => expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('Reflexの判定が例外で終わっても、警告だけ残して発火しない', async () => {
    vi.mocked(judgeHandoffBoundary).mockRejectedValue(new Error('cli落ち'));

    const { requestHandoff } = await finishedTurn({ reflex: true });

    await vi.waitFor(() => expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('同じ材料で次の状態更新が来ても、Reflexの判定は1回しか起動しない', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict({ boundary: 0.1 }));
    const { sessions } = await finishedTurn({ reflex: true });
    await vi.waitFor(() => expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1));

    sessions[0]?.receive(resultLine);
    await flush();

    expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1);
  });

  it('モデル切替の契機がONで分類器も有効なら、Reflexと分類器を並列に呼ぶ', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict());
    vi.mocked(probeSafeBoundary).mockResolvedValue(
      probeOf({ profileDiffers: true, profileChanged: true }),
    );

    const { requestHandoff } = await finishedTurn({ reflex: true, router: true });

    await vi.waitFor(() => expect(requestHandoff).toHaveBeenCalledTimes(1));
    expect(probeSafeBoundary).toHaveBeenCalledTimes(1);
    expect(requestHandoff.mock.calls[0]?.[1]).toMatchObject({ kind: 'profileChanged' });
    expect(requestHandoff.mock.calls[0]?.[2]).toBe(assessment);
  });

  it('Reflexでも質問で終わった応答は、引き継ぎの提案でなければ返答待ちとして止める', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict({ suggested: 0.1 }));

    const { requestHandoff } = await finishedTurn({
      reflex: true,
      assistantText: 'どちらの案にしますか？',
    });

    await vi.waitFor(() => expect(judgeHandoffBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('Reflexが無効で分類器も無効なら、判定を起動せず発火しない', async () => {
    const { requestHandoff } = await finishedTurn({ reflex: false, router: false });

    await flush();
    expect(judgeHandoffBoundary).not.toHaveBeenCalled();
    expect(probeSafeBoundary).not.toHaveBeenCalled();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('分類器だけが有効なら、分類器が引き継ぎを提案したときに発火する', async () => {
    vi.mocked(probeSafeBoundary).mockResolvedValue(
      probeOf({ handoffSuggested: true, handoffSuggestReason: '節目' }),
    );

    const { requestHandoff } = await finishedTurn({ reflex: false, router: true });

    await vi.waitFor(() => expect(requestHandoff).toHaveBeenCalledTimes(1));
    expect(requestHandoff.mock.calls[0]?.[1]).toMatchObject({ kind: 'assistantSuggested' });
    expect(probeSafeBoundary).toHaveBeenCalledTimes(1);
  });

  it('分類器が分類できなかった（undefined）ときは発火しない', async () => {
    vi.mocked(probeSafeBoundary).mockResolvedValue(undefined);

    const { requestHandoff } = await finishedTurn({ reflex: false, router: true });

    await vi.waitFor(() => expect(probeSafeBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('分類器が回答待ちと見立てたら、提案があっても発火しない', async () => {
    vi.mocked(probeSafeBoundary).mockResolvedValue(
      probeOf({ handoffSuggested: true, awaitingUserAnswer: true }),
    );

    const { requestHandoff } = await finishedTurn({ reflex: false, router: true });

    await vi.waitFor(() => expect(probeSafeBoundary).toHaveBeenCalledTimes(1));
    await flush();
    expect(requestHandoff).not.toHaveBeenCalled();
  });

  it('区切り待ちの契機が全部OFFなら、判定を起動しない', async () => {
    vi.mocked(judgeHandoffBoundary).mockResolvedValue(verdict({ suggested: 0.9 }));

    const { requestHandoff } = await finishedTurn({
      reflex: true,
      config: {
        'autoHandoff.onProfileChange': false,
        'autoHandoff.onAssistantSuggestion': false,
        'autoHandoff.onMilestone': false,
      },
    });

    await flush();
    expect(judgeHandoffBoundary).not.toHaveBeenCalled();
    expect(requestHandoff).not.toHaveBeenCalled();
  });
});
