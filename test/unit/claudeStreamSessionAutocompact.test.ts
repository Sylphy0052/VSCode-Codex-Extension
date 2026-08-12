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
 * `start()` は実プロセスを起動するため、`claudeStreamSessionRecap.test.ts` と同じ方針で
 * `proc` に書き込みを記録するだけのフェイクを直接差し込む。
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

describe('ClaudeStreamSession の自動圧縮窓サイズ設定（issue #201）', () => {
  it('空文字を渡すと引数無しの/autocompactを送る（現在値の問い合わせ）', () => {
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('');

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact' }] },
    });
  });

  it('空白だけの入力も問い合わせ扱いにする（trimしてから空判定する）', () => {
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('   ');

    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact' }] },
    });
  });

  it('値を渡すと/autocompact <値>を送る（変更）', () => {
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('300000');

    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact 300000' }] },
    });
  });

  it("'auto'をそのまま送る", () => {
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('auto');

    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact auto' }] },
    });
  });

  it('前後の空白を落としてから送る', () => {
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('  500k  ');

    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/autocompact 500k' }] },
    });
  });

  it('control protocolの要求は送らない（専用のsubtypeが存在しないため）', () => {
    // compact/recapと同じくCLIへの「発言」しか送らない。design.md §14.37の実測で
    // apply_flag_settingsは反映を確かめられないと分かっているため使わない
    const { session, written } = createSessionWithFakeProc();
    session.setAutocompactWindow('300000');

    const parsed = JSON.parse(written[0]!.trim()) as { type: string };
    expect(parsed.type).not.toBe('control_request');
  });

  it('送信後はbusyになりturnFailedをリセットする（compact/recapと同じ扱い）', () => {
    const { session } = createSessionWithFakeProc();
    session.setAutocompactWindow('auto');

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
    expect(() => session.setAutocompactWindow('300000')).toThrow('セッションが起動していません');
  });
});
