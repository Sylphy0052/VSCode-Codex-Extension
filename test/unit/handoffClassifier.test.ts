import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_MODELS,
  buildClassifierPrompt,
  classifyHandoff,
  parseAssessment,
  type HandoffClassifierInput,
} from '../../src/view/handoffClassifier';

function input(over: Partial<HandoffClassifierInput> = {}): HandoffClassifierInput {
  return {
    recentUserMessages: [],
    turnFailed: false,
    cwd: '/home/me/work/app',
    gitBranch: 'main',
    turnEditedFiles: [],
    ...over,
  };
}

const VALID =
  '{"task_type": "implementation", "difficulty": 1, "scope": 1, "ambiguity": 0, "risk": 0, "autonomy": 1, "confidence": 0.93, "reasons": ["仕様が明確", "複数ファイル変更"]}';

describe('buildClassifierPrompt', () => {
  it('5つの軸とtask_typeの一覧、出力形式を含み、モデル・effortを選ばせない', () => {
    const prompt = buildClassifierPrompt(input());
    for (const axis of ['difficulty', 'scope', 'ambiguity', 'risk', 'autonomy']) {
      expect(prompt).toContain(`- ${axis}:`);
    }
    expect(prompt).toContain('security_review');
    expect(prompt).toContain('"task_type"');
    expect(prompt).toContain('モデルやeffortも選ばないでください');
  });

  it('直前のターンの失敗を事実として渡す', () => {
    expect(buildClassifierPrompt(input({ turnFailed: true }))).toContain(
      '直前のターンが失敗して終わったか: はい',
    );
  });

  it('ユーザー指示は末尾5件までで、長い指示は折り畳む', () => {
    const messages = ['1件目', '2件目', '3件目', '4件目', '5件目', '6件目'];
    const prompt = buildClassifierPrompt(input({ recentUserMessages: messages }));
    expect(prompt).not.toContain('1件目');
    expect(prompt).toContain('6件目');

    const long = 'あ'.repeat(1000);
    const folded = buildClassifierPrompt(input({ recentUserMessages: [long] }));
    expect(folded).toContain('…');
    expect(folded).not.toContain(long);
  });

  it('材料が無いときは「記録が無い」と明示する（空欄にしない）', () => {
    const prompt = buildClassifierPrompt(input());
    expect(prompt).toContain('（記録が無い）');
    expect(prompt).toContain('これは「編集していない」という意味ではない');
  });
});

describe('parseAssessment', () => {
  it('素のJSONを読む', () => {
    expect(parseAssessment(VALID)).toEqual({
      taskType: 'implementation',
      difficulty: 1,
      scope: 1,
      ambiguity: 0,
      risk: 0,
      autonomy: 1,
      confidence: 0.93,
      reasons: ['仕様が明確', '複数ファイル変更'],
      // switch_safeが無いJSONは「切り替えてよいと言っていない」ので false（Issue #1090）
      switchSafe: false,
      switchReason: '',
    });
  });

  it('コードブロックや前後の文が付いていても読む', () => {
    const raw = `分類しました。\n\`\`\`json\n${VALID}\n\`\`\`\n以上です。`;
    expect(parseAssessment(raw)?.taskType).toBe('implementation');
  });

  it('confidenceとreasonsは欠けていても読み、範囲外は丸める', () => {
    const raw =
      '{"task_type": "bugfix", "difficulty": 0, "scope": 0, "ambiguity": 0, "risk": 0, "autonomy": 0}';
    expect(parseAssessment(raw)).toMatchObject({ confidence: 0, reasons: [] });

    const over =
      '{"task_type": "bugfix", "difficulty": 0, "scope": 0, "ambiguity": 0, "risk": 0, "autonomy": 0, "confidence": 7, "reasons": ["x", 1, null]}';
    expect(parseAssessment(over)).toMatchObject({ confidence: 1, reasons: ['x'] });
  });

  it('陰性対照: 軸が1つでも欠ける・範囲外・非整数なら分類しない', () => {
    const missing =
      '{"task_type": "bugfix", "difficulty": 0, "scope": 0, "ambiguity": 0, "risk": 0}';
    expect(parseAssessment(missing)).toBeUndefined();
    expect(parseAssessment(VALID.replace('"difficulty": 1', '"difficulty": 3'))).toBeUndefined();
    expect(parseAssessment(VALID.replace('"scope": 1', '"scope": 1.5'))).toBeUndefined();
    expect(parseAssessment(VALID.replace('"risk": 0', '"risk": "0"'))).toBeUndefined();
  });

  it('陰性対照: task_typeが一覧に無ければ分類しない', () => {
    expect(
      parseAssessment(VALID.replace('"implementation"', '"world_domination"')),
    ).toBeUndefined();
  });

  it('陰性対照: JSONが無い・壊れているなら分類しない', () => {
    expect(parseAssessment('わかりません')).toBeUndefined();
    expect(parseAssessment('{"task_type": "bugfix",}')).toBeUndefined();
    expect(parseAssessment('')).toBeUndefined();
  });
});

describe('classifyHandoff', () => {
  it('会話しているCLIと、そのプロバイダの最下位ティアのモデルで起動する', async () => {
    const run = vi.fn().mockResolvedValue(VALID);
    const assessment = await classifyHandoff(
      { provider: 'codex', executable: '/usr/bin/codex', run },
      input(),
    );
    expect(assessment?.taskType).toBe('implementation');
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      executable: '/usr/bin/codex',
      model: CLASSIFIER_MODELS.codex,
    });
    expect(CLASSIFIER_MODELS.claude).toBe('sonnet');
    expect(CLASSIFIER_MODELS.codex).toBe('terra');
  });

  it('応答が得られなければundefinedを返し、警告を残す', async () => {
    const warnings: string[] = [];
    const assessment = await classifyHandoff(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockResolvedValue(undefined),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(assessment).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('応答を読めなければundefinedを返し、警告を残す', async () => {
    const warnings: string[] = [];
    const assessment = await classifyHandoff(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockResolvedValue('分類できませんでした'),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(assessment).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('例外が出ても投げ返さない', async () => {
    const warnings: string[] = [];
    const assessment = await classifyHandoff(
      {
        provider: 'claude',
        executable: 'claude',
        run: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
        logWarn: (m) => warnings.push(m),
      },
      input(),
    );
    expect(assessment).toBeUndefined();
    expect(warnings[0]).toContain('spawn ENOENT');
  });
});

describe('switch_safe（Issue #1090）', () => {
  it('プロンプトに切り替え可否の判定を含める', () => {
    const prompt = buildClassifierPrompt(input());
    expect(prompt).toContain('switch_safe');
    expect(prompt).toContain('switch_reason');
    expect(prompt).toContain('新しいセッションがtranscriptと引き継ぎメモから続きを始められるか');
  });

  it('switch_safe と switch_reason を読む', () => {
    const raw = VALID.replace(/\}$/, ', "switch_safe": true, "switch_reason": "PRがマージされた"}');
    expect(parseAssessment(raw)).toMatchObject({
      switchSafe: true,
      switchReason: 'PRがマージされた',
    });
  });

  it('switch_safe が真偽値でなければ false（切り替えない側へ倒す）', () => {
    const raw = VALID.replace(/\}$/, ', "switch_safe": "yes"}');
    expect(parseAssessment(raw)).toMatchObject({ switchSafe: false, switchReason: '' });
  });
});
