import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/appserver/chatSession';
import type { AppServerConnectionPort } from '../../src/appserver/connection';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

const fakeConnection = {
  async ensureStarted() {
    return undefined;
  },
  async request() {
    return { result: {} };
  },
} as unknown as AppServerConnectionPort;

function createClaudeSession(initialAutoHandoff?: boolean): ClaudeStreamSession {
  return new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    initialAutoHandoff,
  );
}

/**
 * 自動引き継ぎの初期値（Issue #1091）。値の出どころはユーザー設定
 * （`agent.autoHandoff.enabled`）だが、セッション層は `vscode` をimportしない
 * （CONTRIBUTING.mdの「レイヤの制約」）ため、設定を読むのはview層で、ここは値を
 * 受け取るだけ。設定そのものの既定は `config.test.ts` で確かめる。
 */
describe('セッションの自動引き継ぎの初期値（Issue #1091）', () => {
  it('渡された初期値でCodex・Claude Codeのどちらも始まる', () => {
    expect(
      new ChatSession(fakeConnection, fakeLogger, () => undefined, true).getState().autoHandoff,
    ).toBe(true);
    expect(createClaudeSession(true).getState().autoHandoff).toBe(true);
  });

  it('初期値を渡さないときはOFF（設定を知らない層のため、既定はONにしない）', () => {
    expect(
      new ChatSession(fakeConnection, fakeLogger, () => undefined).getState().autoHandoff,
    ).toBe(false);
    expect(createClaudeSession().getState().autoHandoff).toBe(false);
  });

  it('セッション中のトグルはそのセッションの中だけで効く', () => {
    const session = new ChatSession(fakeConnection, fakeLogger, () => undefined, true);
    session.setAutoHandoff(false);

    expect(session.getState().autoHandoff).toBe(false);
    // 同じ初期値で作り直した別セッションは影響を受けない（設定へ書き戻していない）
    expect(
      new ChatSession(fakeConnection, fakeLogger, () => undefined, true).getState().autoHandoff,
    ).toBe(true);
  });
});
