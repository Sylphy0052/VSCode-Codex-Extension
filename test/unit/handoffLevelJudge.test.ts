import { describe, expect, it, vi } from 'vitest';
import {
  JUDGE_MODELS,
  buildJudgePrompt,
  judgeHandoffLevel,
  parseJudgement,
  type HandoffJudgeInput,
} from '../../src/view/handoffLevelJudge';

function input(over: Partial<HandoffJudgeInput> = {}): HandoffJudgeInput {
  return {
    recentUserMessages: [],
    turnFailed: false,
    cwd: '/home/me/work/app',
    gitBranch: 'main',
    turnEditedFiles: [],
    ...over,
  };
}

describe('buildJudgePrompt', () => {
  it('レベルの定義6件と出力形式の指定を含む', () => {
    const prompt = buildJudgePrompt(input());
    for (const level of [0, 1, 2, 3, 4, 5]) {
      expect(prompt).toContain(`- L${level}: `);
    }
    expect(prompt).toContain('"level"');
    expect(prompt).toContain('"reason"');
  });

  it('直前のターンの失敗を事実として渡す', () => {
    expect(buildJudgePrompt(input({ turnFailed: true }))).toContain(
      '直前のターンが失敗して終わったか: はい',
    );
    expect(buildJudgePrompt(input({ turnFailed: false }))).toContain(
      '直前のターンが失敗して終わったか: いいえ',
    );
  });

  it('ユーザー指示は末尾5件までで、長い指示は折り畳む', () => {
    const messages = ['1件目', '2件目', '3件目', '4件目', '5件目', '6件目'];
    const prompt = buildJudgePrompt(input({ recentUserMessages: messages }));
    expect(prompt).not.toContain('1件目');
    expect(prompt).toContain('6件目');

    const long = 'あ'.repeat(1000);
    const folded = buildJudgePrompt(input({ recentUserMessages: [long] }));
    expect(folded).toContain('…');
    expect(folded).not.toContain(long);
  });

  it('材料が無いときは「記録が無い」と明示する（空欄にしない）', () => {
    const prompt = buildJudgePrompt(input());
    expect(prompt).toContain('（記録が無い）');
    expect(prompt).toContain('これは「編集していない」という意味ではない');
  });
});

describe('parseJudgement', () => {
  it('素のJSONを読む', () => {
    expect(parseJudgement('{"level": 3, "reason": "調査が要る"}')).toEqual({
      level: 3,
      reason: '調査が要る',
    });
  });

  it('コードブロックや前後の文が付いていても読む', () => {
    const raw = '判定しました。\n```json\n{"level": 4, "reason": "設計判断"}\n```\n以上です。';
    expect(parseJudgement(raw)?.level).toBe(4);
  });

  it('reasonが無ければ既定の文言で埋める', () => {
    expect(parseJudgement('{"level": 0}')?.reason).toBe('理由の記載なし');
  });

  it('陰性対照: levelが範囲外・非整数・欠落なら判定しない', () => {
    expect(parseJudgement('{"level": 6, "reason": "x"}')).toBeUndefined();
    expect(parseJudgement('{"level": -1, "reason": "x"}')).toBeUndefined();
    expect(parseJudgement('{"level": 2.5, "reason": "x"}')).toBeUndefined();
    expect(parseJudgement('{"level": "3", "reason": "x"}')).toBeUndefined();
    expect(parseJudgement('{"reason": "x"}')).toBeUndefined();
  });

  it('陰性対照: JSONが無い・壊れているなら判定しない', () => {
    expect(parseJudgement('わかりません')).toBeUndefined();
    expect(parseJudgement('{"level": 3,}')).toBeUndefined();
    expect(parseJudgement('')).toBeUndefined();
  });
});

describe('judgeHandoffLevel', () => {
  it('会話しているCLIと、そのプロバイダの最下位ティアのモデルで起動する', async () => {
    const run = vi.fn().mockResolvedValue('{"level": 2, "reason": "通常の実装"}');
    const judgement = await judgeHandoffLevel(
      { provider: 'codex', executable: '/usr/bin/codex', run },
      input(),
    );
    expect(judgement).toEqual({ level: 2, reason: '通常の実装' });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      executable: '/usr/bin/codex',
      model: JUDGE_MODELS.codex,
    });
    expect(JUDGE_MODELS.claude).toBe('sonnet');
    expect(JUDGE_MODELS.codex).toBe('terra');
  });

  it('応答が得られなければundefinedを返し、警告を残す', async () => {
    const warnings: string[] = [];
    const judgement = await judgeHandoffLevel(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockResolvedValue(undefined),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(judgement).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('応答を読めなければundefinedを返し、警告を残す', async () => {
    const warnings: string[] = [];
    const judgement = await judgeHandoffLevel(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockResolvedValue('判定できませんでした'),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(judgement).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('例外が出ても投げ返さない', async () => {
    const warnings: string[] = [];
    const judgement = await judgeHandoffLevel(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(judgement).toBeUndefined();
    expect(warnings[0]).toContain('spawn ENOENT');
  });
});
