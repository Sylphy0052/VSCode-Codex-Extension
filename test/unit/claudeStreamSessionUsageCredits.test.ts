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

describe('ClaudeStreamSession の追加クレジット要求（requestUsageCredits、issue #204）', () => {
  it('/usage-credits をユーザー発言として書き込む', () => {
    const { session, written } = createSessionWithFakeProc();
    session.requestUsageCredits();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/usage-credits' }] },
    });
  });

  it('control protocolの要求は送らない（専用のsubtypeが存在しないため）', () => {
    // requestUsageCreditsはcompact/importConfig/recapと同じくCLIへの「発言」しか送らない。
    // 専用のcontrol requestは実測で存在しないと確認済み（issue #204のコメント、
    // control.tsのreadExtraUsageのJSDoc参照）
    const { session, written } = createSessionWithFakeProc();
    session.requestUsageCredits();

    const parsed = JSON.parse(written[0]!.trim()) as { type: string };
    expect(parsed.type).not.toBe('control_request');
  });

  it('送信後はbusyになりturnFailedをリセットする（compact/importConfig/recapと同じ扱い）', () => {
    const { session } = createSessionWithFakeProc();
    session.requestUsageCredits();

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
    expect(() => session.requestUsageCredits()).toThrow('セッションが起動していません');
  });
});

function controlResponseLine(requestId: string, response: unknown): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`;
}

describe('ClaudeStreamSession の追加クレジットの状態取得（issue #204）', () => {
  it('refreshSessionCostの応答（get_usage）からsessionCostとextraUsageを同時に読む', () => {
    // 専用のcontrol requestは無く、sessionCostと同じget_usageの応答に相乗りする
    // （streamSession.tsのhandleControlResponse参照）
    const { session, written } = createSessionWithFakeProc();
    session.refreshSessionCost();
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(
      controlResponseLine(requestId, {
        session: { total_cost_usd: 0.21, total_lines_added: 0, total_lines_removed: 0 },
        subscription_type: 'max',
        rate_limits: {
          extra_usage: {
            is_enabled: false,
            monthly_limit: 4000,
            used_credits: 0,
            utilization: 0,
            currency: 'USD',
            decimal_places: 2,
            disabled_reason: 'out_of_credits',
            spend_limit_reached: false,
          },
        },
      }),
    );

    const state = session.getState();
    expect(state.sessionCost?.totalCostUsd).toBe(0.21);
    expect(state.extraUsage).toEqual({
      isEnabled: false,
      monthlyLimit: 40,
      usedCredits: 0,
      utilization: 0,
      currency: 'USD',
      disabledReason: 'out_of_credits',
      spendLimitReached: false,
    });
  });

  it('rate_limits.extra_usageが無い応答でもsessionCostは読める（extraUsageはundefinedのまま）', () => {
    // 組織が対応しない・古いCLIを想定。無いことでsessionCostの読み取りを壊さない
    const { session, written } = createSessionWithFakeProc();
    session.refreshSessionCost();
    const requestId = (JSON.parse(written[0]!.trim()) as { request_id: string }).request_id;

    session.receive(
      controlResponseLine(requestId, {
        session: { total_cost_usd: 0.1, total_lines_added: 0, total_lines_removed: 0 },
      }),
    );

    const state = session.getState();
    expect(state.sessionCost?.totalCostUsd).toBe(0.1);
    expect(state.extraUsage).toBeUndefined();
  });
});
