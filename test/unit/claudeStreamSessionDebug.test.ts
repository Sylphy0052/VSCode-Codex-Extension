import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

interface FakeProc {
  killed: boolean;
  stdin: { write: (line: string) => void; destroyed: boolean; writable: boolean };
}

/**
 * `start()` は実プロセスを起動するため、`claudeStreamSessionUsageCredits.test.ts` と
 * 同じ方針で `proc` に書き込みを記録するだけのフェイクを直接差し込む。
 */
function createSessionWithFakeProc(): {
  session: ClaudeStreamSession;
  written: string[];
} {
  const written: string[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    () => undefined,
  );
  const fakeProc: FakeProc = {
    killed: false,
    stdin: { write: (line) => written.push(line), destroyed: false, writable: true },
  };
  (session as unknown as { proc: FakeProc }).proc = fakeProc;
  return { session, written };
}

describe('ClaudeStreamSession の /debug 送信（sendDebugCommand、issue #205）', () => {
  it('/debug をユーザー発言として書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    session.sendDebugCommand();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/debug' }] },
    });
  });

  it('control protocolの要求は送らない（専用のsubtypeが存在しないため）', () => {
    // sendDebugCommandはcompact/importConfig/requestUsageCreditsと同じくCLIへの
    // 「発言」しか送らない。専用のcontrol requestは実測で存在しないと確認済み
    // （issue #205のコメント。`^(get|set|toggle)_[a-z_]*debug[a-z_]*$`に一致するsubtypeは無い）
    const { session, written } = createSessionWithFakeProc();
    session.sendDebugCommand();

    const parsed = JSON.parse(written[0]!.trim()) as { type: string };
    expect(parsed.type).not.toBe('control_request');
  });

  it('送信後はbusyになりturnFailedをリセットする（compact/importConfig等と同じ扱い）', () => {
    const { session } = createSessionWithFakeProc();
    session.sendDebugCommand();

    const state = session.getState();
    expect(state.busy).toBe(true);
    expect(state.turnFailed).toBe(false);
  });

  it('セッションが起動していない場合はエラーを投げ、何も書き込まない', () => {
    const session = new ClaudeStreamSession(
      () => 'claude',
      fakeLogger,
      () => undefined,
    );
    expect(() => session.sendDebugCommand()).toThrow('セッションが起動していません');
  });
});
