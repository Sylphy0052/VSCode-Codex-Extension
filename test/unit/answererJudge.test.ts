import { describe, expect, it, vi } from 'vitest';
import {
  formatAnswererVerdictLog,
  judgeQuestionAnswerer,
  judgeTurnEndAnswerer,
} from '../../src/reflex/answererJudge';
import type { ReflexJudgeDeps } from '../../src/reflex/reflexJudge';

// Issue #1819: 推奨案のある確認をオーケストレーターへ寄せる基準と、判定結果のログ

function depsReturning(text: string | undefined): {
  deps: ReflexJudgeDeps;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () =>
    text === undefined
      ? { ok: false as const, reason: 'timeout' as const }
      : { ok: true as const, text },
  );
  return { deps: { provider: 'claude', executable: 'claude', logWarn: () => undefined, run }, run };
}

const TURN_END_ORCHESTRATOR = JSON.stringify({
  answers: [{ id: 'q1', probs: { ユーザー: 0.1, オーケストレーター: 0.85, 問いなし: 0.05 } }],
});

describe('judgeTurnEndAnswerer', () => {
  it('推奨案のある方針の選択・承認はオーケストレーター側とする基準を判定へ渡す', async () => {
    const { deps, run } = depsReturning(TURN_END_ORCHESTRATOR);
    await judgeTurnEndAnswerer(
      deps,
      'A（推奨）: T31のreviewを始める / B / C。Aで進めてよいですか。',
      0.7,
    );
    const prompt = String(run.mock.calls[0]?.[1]);
    expect(prompt).toContain('推奨案の無い方針の選択・承認');
    expect(prompt).toContain('方針の選択や承認の形をとっていても「オーケストレーター」とする');
    expect(prompt).toContain('受入基準を下げる判断');
    expect(prompt).toContain('迷うときは「ユーザー」とする');
  });

  it('判定結果を経路・判定・確率の要約つきで1行ログへ出す', async () => {
    const { deps } = depsReturning(TURN_END_ORCHESTRATOR);
    const logInfo = vi.fn();
    const verdict = await judgeTurnEndAnswerer(deps, 'Aで進めてよいですか', 0.7, logInfo);
    expect(verdict.kind).toBe('orchestrator');
    expect(logInfo).toHaveBeenCalledTimes(1);
    const line = String(logInfo.mock.calls[0]?.[0]);
    expect(line).toContain('経路=turnEnd');
    expect(line).toContain('判定=orchestrator');
    expect(line).toContain('オーケストレーター 0.85');
    expect(line).toContain('問い=「Aで進めてよいですか」');
  });

  it('危険語を含む出力はReflexを呼ばずユーザーへ回し、その旨をログへ出す', async () => {
    const { deps, run } = depsReturning(TURN_END_ORCHESTRATOR);
    const logInfo = vi.fn();
    const verdict = await judgeTurnEndAnswerer(
      deps,
      'mainへforce pushしてよいですか',
      0.7,
      logInfo,
    );
    expect(verdict.kind).toBe('user');
    expect(run).not.toHaveBeenCalled();
    expect(String(logInfo.mock.calls[0]?.[0])).toContain('回答者判定を通さなかった');
  });
});

describe('judgeQuestionAnswerer', () => {
  it('判定に失敗したらユーザーへ回し、失敗をログへ出す', async () => {
    const { deps } = depsReturning(undefined);
    const logInfo = vi.fn();
    const verdict = await judgeQuestionAnswerer(
      deps,
      { source: 'stageSession', route: 'gate', question: '次の工程へ進めてよいか' },
      0.7,
      logInfo,
    );
    expect(verdict).toEqual({ kind: 'user', summary: undefined });
    const line = String(logInfo.mock.calls[0]?.[0]);
    expect(line).toContain('経路=gate');
    expect(line).toContain('判定=user');
    expect(line).toContain('判定に失敗');
  });
});

describe('formatAnswererVerdictLog', () => {
  it('問いは改行を除いて先頭だけを載せる', () => {
    const line = formatAnswererVerdictLog('askUser', `1行目\n${'あ'.repeat(200)}`, {
      kind: 'user',
      summary: 'ユーザー 0.80 / オーケストレーター 0.20',
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('経路=askUser 判定=user ユーザー 0.80 / オーケストレーター 0.20');
    expect(line.length).toBeLessThan(200);
  });
});
