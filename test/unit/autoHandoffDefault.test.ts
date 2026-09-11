import { beforeEach, describe, expect, it } from 'vitest';
import type { AppServerConnection } from '../../src/appserver/connection';
import { ChatSession } from '../../src/appserver/chatSession';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';
import { __mock } from '../mocks/vscode';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

function createChatSession(): ChatSession {
  const connection = {
    async ensureStarted() {
      return undefined;
    },
    async request() {
      return { result: {} };
    },
  } as unknown as AppServerConnection;
  return new ChatSession(connection, fakeLogger, () => undefined);
}

function createClaudeSession(): ClaudeStreamSession {
  return new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
  );
}

/**
 * 自動引き継ぎの初期値は `agent.autoHandoff.enabled`（Issue #1091）。設定を読むのは
 * セッションを作る時点で、`initialChatState` / `initialClaudeState` のような定数側では
 * 読まない（モジュール読み込み時に一度しか評価されないため）。
 */
describe('新規セッションの自動引き継ぎの初期値（Issue #1091）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('設定が未指定ならCodex・Claude CodeのどちらもONで始まる', () => {
    expect(createChatSession().getState().autoHandoff).toBe(true);
    expect(createClaudeSession().getState().autoHandoff).toBe(true);
  });

  it('設定をOFFにすると、どちらもOFFで始まる', () => {
    __mock.setConfig('agent', { 'autoHandoff.enabled': false });

    expect(createChatSession().getState().autoHandoff).toBe(false);
    expect(createClaudeSession().getState().autoHandoff).toBe(false);
  });

  it('セッション中のトグルはユーザー設定へ書き戻さない', () => {
    const session = createChatSession();
    session.setAutoHandoff(false);

    expect(session.getState().autoHandoff).toBe(false);
    // 同じ設定のまま次のセッションを作ると、また既定のONで始まる
    expect(createChatSession().getState().autoHandoff).toBe(true);
  });
});
