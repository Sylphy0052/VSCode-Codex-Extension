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
 * `start()` は実プロセスを起動するため、`claudeStreamSessionImportConfig.test.ts` と
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

describe('ClaudeStreamSession の会話要約（recap、issue #203）', () => {
  it('/recap をユーザー発言として書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    session.recap();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/recap' }] },
    });
  });

  it('control protocolの要求は送らない（専用のsubtypeが存在しないため）', () => {
    // recapはcompact/importConfigと同じくCLIへの「発言」しか送らない。control_requestを
    // 送ってしまうと `Unsupported control request subtype` を実測済みの経路
    // （streamSession.tsのrecapのJSDoc参照）へ逆戻りするため、書き込む内容が
    // user発言だけであることを固定する
    const { session, written } = createSessionWithFakeProc();
    session.recap();

    const parsed = JSON.parse(written[0]!.trim()) as { type: string };
    expect(parsed.type).not.toBe('control_request');
  });

  it('送信後はbusyになりturnFailedをリセットする（compact/importConfigと同じ扱い）', () => {
    const { session } = createSessionWithFakeProc();
    session.recap();

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
    expect(() => session.recap()).toThrow('セッションが起動していません');
  });
});
