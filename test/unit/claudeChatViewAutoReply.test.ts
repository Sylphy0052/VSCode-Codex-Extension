import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionStore } from '../../src/claude/sessionStore';
import { ClaudeStreamSession, type ClaudeStreamOptions } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import type { FileSystemPort, MemoryFileSystemPort } from '../../src/session/ports';
import { FileMentionCatalog, type FileScanPort } from '../../src/provider/fileMentions';
import { AutoReplyAgent, type AutoReplyTurnResult } from '../../src/chat/autoReplyAgent';
import type { MemoryModeMemento } from '../../src/provider/inputModes';
import { STATE_POST_INTERVAL_MS } from '../../src/view/chatShared';
import type { SettingsProvider } from '../../src/view/settingsProvider';
import { ClaudeChatViewManager } from '../../src/view/claudeChatView';
import { __mock } from '../mocks/vscode';

/**
 * 自動返信モード（Issue #1353）のview層の配線（Issue #1360）。
 *
 * 純粋ロジック（`autoReply.test.ts`）と返信役のセッション管理（`autoReplyAgent.test.ts`）は
 * 別に検証済みなので、ここでは`claudeChatView.ts`側の結線だけを見る。つまり
 * 「いつ返信役へ問い合わせるか」「返ってきた返事をどんなときに送らないか」「AskUserQuestionの
 * 自動回答が回数上限に数えられるか」の3点で、どれも異常系がずれると黙って壊れる箇所。
 */

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
  };
  return settings as unknown as SettingsProvider;
}

function fakeStore(): ClaudeSessionStore {
  const names = new Map<string, string>();
  const store = {
    resolveTranscriptPath: async () => undefined,
    resolveCwd: async () => undefined,
    getName: (sessionId: string) => names.get(sessionId),
    rename: async (sessionId: string, name: string) => {
      names.set(sessionId, name);
    },
  };
  return store as unknown as ClaudeSessionStore;
}

const fakeMemoryFileSystem: MemoryFileSystemPort = {
  readStrict: async () => undefined,
  resolveSymlinkTarget: async () => ({ kind: 'not-symlink' }),
};

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
    fakeMemoryFileSystem,
    fakeMemento(),
    undefined,
    undefined,
    mkdtempSync(join(tmpdir(), 'claude-auto-reply-')),
  );
}

/** 実プロセスは起動せず、`receive()`を直接叩けるようセッション本体を控える。 */
function stubStartCapturing(): ClaudeStreamSession[] {
  const sessions: ClaudeStreamSession[] = [];
  vi.spyOn(ClaudeStreamSession.prototype, 'start').mockImplementation(function (
    this: ClaudeStreamSession,
    _options: ClaudeStreamOptions,
  ) {
    sessions.push(this);
  });
  return sessions;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATE_POST_INTERVAL_MS);
}

const initLine = (sessionId: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`;
const resultLine = (): string => `${JSON.stringify({ type: 'result' })}\n`;
const assistantTextLine = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid,
    message: { id: uuid, content: [{ type: 'text', text }] },
  })}\n`;

const QUESTIONS = [
  {
    question: 'どちらにしますか',
    header: '選択',
    options: [
      { label: 'A', description: 'Aの説明' },
      { label: 'B', description: 'Bの説明' },
    ],
    multiSelect: false,
  },
];

/** AskUserQuestionの承認カードを1枚積むための`can_use_tool`要求。 */
const askUserQuestionLine = (requestId: string): string =>
  `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: { questions: QUESTIONS },
    },
  })}\n`;

const ok = (response: string): AutoReplyTurnResult => ({ ok: true, response });

/** 返信役の返事を任意のタイミングで確定させる。待っている間の割り込みを試すのに使う。 */
function deferredReply(): {
  resolve: (result: AutoReplyTurnResult) => void;
  spy: ReturnType<typeof vi.spyOn>;
} {
  let resolve: (result: AutoReplyTurnResult) => void = () => undefined;
  const pending = new Promise<AutoReplyTurnResult>((r) => {
    resolve = r;
  });
  const spy = vi.spyOn(AutoReplyAgent.prototype, 'reply').mockReturnValue(pending);
  return { resolve, spy };
}

/**
 * 自動返信がONの会話を1つ開き、ターン完了の直前まで進める。
 *
 * 設定`agent.chat.autoReply.enabled`をONにしてあるため、開いた時点でモードはON
 * （`claudeChatView.ts`の`buildEntry`）。以降のテストはここから`receive`で状況を作る。
 */
async function openAutoReplyPanel(maxTurns = 10): Promise<{
  manager: ClaudeChatViewManager;
  session: ClaudeStreamSession;
  sessionId: string;
}> {
  __mock.setConfig('agent', {
    'chat.autoReply.enabled': true,
    'chat.autoReply.maxTurns': maxTurns,
    'chat.autoReply.timeoutSeconds': 60,
    // 返信役の配線だけを見る。Reflex判定（Issue #1435）は実際のCLIを起動するため切る
    'chat.autoReply.reflex.enabled': false,
  });
  const sessions = stubStartCapturing();
  const manager = createManager();
  const sessionId = (await manager.openNew('/workspace/root')) as string;
  const session = sessions[0]!;
  session.receive(initLine(sessionId));
  await flush();
  return { manager, session, sessionId };
}

describe('Claude Code画面の自動返信モードの配線（Issue #1360）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('発火の契機', () => {
    it('ターンの完了で1回だけ返信役へ問い合わせ、同じturnCompletionSeqのまま状態が動いても問い直さない', async () => {
      const reply = vi.spyOn(AutoReplyAgent.prototype, 'reply').mockResolvedValue(ok('続けて'));
      const send = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
      const { manager, session } = await openAutoReplyPanel();

      session.receive(assistantTextLine('a1', '作業を1つ終えました'));
      session.receive(resultLine());
      await flush();

      expect(reply).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith('続けて', []);

      // ターンをまたがない状態変化（発言が1件増えただけ）では`turnFinished`が立たない
      session.receive(assistantTextLine('a2', 'まだ続きがあります'));
      await flush();

      expect(reply).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      manager.dispose();
    });

    it('ターンが失敗して終わったときは問い合わせずモードをOFFにする', async () => {
      const reply = vi.spyOn(AutoReplyAgent.prototype, 'reply').mockResolvedValue(ok('続けて'));
      const { manager, session } = await openAutoReplyPanel();

      session.receive(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution' })}\n`);
      await flush();

      // 失敗として積まれていることを先に確かめる。ここが崩れると、モードがOFFなのは
      // 「ターンが失敗したから」ではなくなり、このテストが黙って別のことを見てしまう
      expect(session.getState().turnFailed).toBe(true);
      expect(reply).not.toHaveBeenCalled();
      expect(session.getState().autoReply).toBe(false);
      manager.dispose();
    });
  });

  describe('待っている間に前提が崩れたとき（届いた返事を送らない）', () => {
    it('返事を待つ間にモードをOFFにされたら送らない', async () => {
      const { resolve, spy } = deferredReply();
      const send = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
      const { manager, session, sessionId } = await openAutoReplyPanel();

      session.receive(assistantTextLine('a1', '作業を1つ終えました'));
      session.receive(resultLine());
      await flush();
      expect(spy).toHaveBeenCalledTimes(1);

      await manager.simulateWebviewMessage(sessionId, { type: 'autoReply', on: false });
      resolve(ok('続けて'));
      await flush();

      expect(send).not.toHaveBeenCalled();
      manager.dispose();
    });

    it('返事を待つ間にタブを閉じられたら送らず、返信役も閉じる', async () => {
      const { resolve, spy } = deferredReply();
      const close = vi.spyOn(AutoReplyAgent.prototype, 'close');
      const send = vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
      const { manager, session } = await openAutoReplyPanel();

      session.receive(assistantTextLine('a1', '作業を1つ終えました'));
      session.receive(resultLine());
      await flush();
      expect(spy).toHaveBeenCalledTimes(1);

      __mock.lastCreatedPanel()?.dispose();
      resolve(ok('続けて'));
      await flush();

      expect(send).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith('tabClosed');
      manager.dispose();
    });
  });

  describe('AskUserQuestionの自動回答', () => {
    it('返信役が選んだ答えをカードへ返し、その1回を回数上限に数える', async () => {
      vi.spyOn(AutoReplyAgent.prototype, 'reply').mockResolvedValue(
        ok(JSON.stringify({ どちらにしますか: ['A'] })),
      );
      const answer = vi
        .spyOn(ClaudeStreamSession.prototype, 'answerAskUserQuestion')
        .mockImplementation(() => undefined);
      const { manager, session } = await openAutoReplyPanel(1);

      session.receive(askUserQuestionLine('r1'));
      await flush();

      expect(answer).toHaveBeenCalledWith('r1', { どちらにしますか: ['A'] });
      // 回数上限（maxTurns=1）へ到達するので、この1回でモードが終わる
      expect(session.getState().autoReply).toBe(false);
      manager.dispose();
    });

    it('検証に通らない返事はカードを残し、状態が動いても同じ要求を問い直さない', async () => {
      const reply = vi
        .spyOn(AutoReplyAgent.prototype, 'reply')
        .mockResolvedValue(ok('どちらがよいか判断できません'));
      const answer = vi
        .spyOn(ClaudeStreamSession.prototype, 'answerAskUserQuestion')
        .mockImplementation(() => undefined);
      const { manager, session } = await openAutoReplyPanel();

      session.receive(askUserQuestionLine('r1'));
      await flush();

      expect(reply).toHaveBeenCalledTimes(1);
      expect(answer).not.toHaveBeenCalled();
      expect(session.getState().approvals).toHaveLength(1);

      session.receive(assistantTextLine('a1', '回答を待っています'));
      await flush();

      expect(reply).toHaveBeenCalledTimes(1);
      expect(session.getState().approvals).toHaveLength(1);
      manager.dispose();
    });
  });

  describe('タブを閉じたときの後始末', () => {
    it('往復が終わっていても、タブを閉じれば返信役を閉じる', async () => {
      vi.spyOn(AutoReplyAgent.prototype, 'reply').mockResolvedValue(ok('続けて'));
      vi.spyOn(ClaudeStreamSession.prototype, 'sendOrQueue').mockReturnValue('sent');
      const close = vi.spyOn(AutoReplyAgent.prototype, 'close');
      const { manager, session } = await openAutoReplyPanel();

      session.receive(assistantTextLine('a1', '作業を1つ終えました'));
      session.receive(resultLine());
      await flush();
      expect(close).not.toHaveBeenCalled();

      __mock.lastCreatedPanel()?.dispose();

      expect(close).toHaveBeenCalledWith('tabClosed');
      manager.dispose();
    });
  });
});
