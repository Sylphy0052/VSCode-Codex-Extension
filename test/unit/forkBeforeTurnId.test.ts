import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../src/codex/types';
import type { Logger } from '../../src/log';
import type { FileSystemPort } from '../../src/session/ports';
import type { SessionStore } from '../../src/session/sessionStore';
import { ConversationViewManager } from '../../src/view/conversationView';
import { __mock } from '../mocks/vscode';

/**
 * 分岐点を `beforeTurnId`（そのターンとそれ以降を除外する指定）へ切り替えた（Issue #1161）。
 *
 * 以前は「直前のユーザー発言の turnId」を `lastTurnId`（引き継ぐ最後のターン＝含める指定）
 * として送っていたため、同じターンへ割り込んで送った指示から分岐すると実行中のターン自身を
 * 指してCLIに拒否され、完了後は消したかった指示が分岐先に残っていた。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const SESSION: SessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'codex',
  cwd: '/workspace/root',
} as unknown as SessionSummary;

/** ターン3件のロールアウト。`turn_context` がターンの境界を作る。 */
const ROLLOUT = [
  { type: 'turn_context', payload: { turn_id: 'turn-1' } },
  { type: 'event_msg', payload: { type: 'user_message', message: '1つ目' } },
  { type: 'turn_context', payload: { turn_id: 'turn-2' } },
  { type: 'event_msg', payload: { type: 'user_message', message: '2つ目' } },
  { type: 'turn_context', payload: { turn_id: 'turn-3' } },
  { type: 'event_msg', payload: { type: 'user_message', message: '3つ目' } },
]
  .map((e, i) => JSON.stringify({ ...e, timestamp: `2026-09-13T00:00:0${i}.000Z` }))
  .join('\n');

function conversationFs(): FileSystemPort {
  return {
    readTextFile: async () => ROLLOUT,
    readFirstLine: async () => undefined,
    readTail: async () => undefined,
    mtimeMs: async () => undefined,
    listRollouts: async () => [],
    listJsonl: async () => [],
    listMarkdown: async () => [],
    readHead: async () => [],
    readBase64File: async () => undefined,
  };
}

function conversationStore(): SessionStore {
  return {
    resolveRolloutPath: async () => '/fake/rollout.jsonl',
  } as unknown as SessionStore;
}

describe('会話閲覧画面の分岐点（Issue #1161）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/workspace/root');
  });

  async function renderHtml(): Promise<string> {
    const manager = new ConversationViewManager(
      conversationFs(),
      conversationStore(),
      fakeLogger,
      async () => true,
    );
    await manager.open(SESSION);
    const panel = __mock.createdPanels[__mock.createdPanels.length - 1];
    if (panel === undefined) {
      throw new Error('パネルが作られていない');
    }
    return (panel as unknown as { webview: { html: string } }).webview.html;
  }

  it('分岐ボタンはそのターン自身のidを渡す（手前のターンのidではない）', async () => {
    const html = await renderHtml();

    // 2つ目・3つ目のターンには、自分自身のidを持つボタンが出る
    expect(html).toContain('data-turn="turn-2"');
    expect(html).toContain('data-turn="turn-3"');
  });

  it('会話の最初のターンにはボタンを出さない（除外すると何も残らないため）', async () => {
    const html = await renderHtml();

    expect(html).not.toContain('data-turn="turn-1"');
  });
});

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// `vi.mock`はホイストされるため、この静的importは差し替え後の`spawn`を使う
import { AppServerClient } from '../../src/codex/appServerClient';
import { createFakeChildProcess as fakeChildProcess } from '../helpers/fakeChildProcess';

/** 送信済みの行から、指定メソッドの要求を取り出す。 */
function sentRequest(writes: readonly string[], method: string): { id: number; params: unknown } {
  const line = writes.find((w) => w.includes(`"method":"${method}"`));
  if (line === undefined) {
    throw new Error(`${method}要求が送信されていません`);
  }
  return JSON.parse(line) as { id: number; params: unknown };
}

function respond(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

describe('AppServerClient.forkThread（Issue #1161）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('thread/forkへbeforeTurnIdを送る（lastTurnIdは送らない）', async () => {
    const fake = fakeChildProcess();
    spawnMock.mockReturnValueOnce(fake.proc);
    const client = new AppServerClient(() => 'codex', fakeLogger, 30_000);

    const pending = client.forkThread(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    await vi.advanceTimersByTimeAsync(0);

    fake.emitStdout(respond(sentRequest(fake.writes, 'initialize').id, {}));
    await vi.advanceTimersByTimeAsync(0);

    const fork = sentRequest(fake.writes, 'thread/fork');
    expect(fork.params).toEqual({
      threadId: '11111111-1111-1111-1111-111111111111',
      beforeTurnId: '22222222-2222-2222-2222-222222222222',
    });

    fake.emitStdout(respond(fork.id, { thread: { id: '33333333-3333-3333-3333-333333333333' } }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({
      ok: true,
      threadId: '33333333-3333-3333-3333-333333333333',
    });
  });

  it('UUID形式でないターンidは送らない（引数注入の防止は従来どおり）', async () => {
    const client = new AppServerClient(() => 'codex', fakeLogger, 30_000);

    await expect(
      client.forkThread('11111111-1111-1111-1111-111111111111', '--dangerous'),
    ).resolves.toEqual({ ok: false, error: '不正なidです' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
