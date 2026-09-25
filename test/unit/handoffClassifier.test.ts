import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_TIMEOUT_MS,
  buildClassifierPrompt,
  classifyHandoff,
  parseAssessment,
  type HandoffClassifierInput,
} from '../../src/view/handoffClassifier';
import { REFLEX_MODELS } from '../../src/reflex/reflexCli';

function input(over: Partial<HandoffClassifierInput> = {}): HandoffClassifierInput {
  return {
    recentUserMessages: [],
    recentAssistantMessages: [],
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

  it('直前のアシスタント応答を節として載せ、末尾2件までで長い応答は折り畳む（Issue #1097）', () => {
    const prompt = buildClassifierPrompt(
      input({ recentAssistantMessages: ['1件目', '2件目', '3件目'] }),
    );
    expect(prompt).toContain('### 直前のアシスタントの応答（古い順）');
    expect(prompt).not.toContain('1件目');
    expect(prompt).toContain('2件目');
    expect(prompt).toContain('3件目');

    const long = `${'い'.repeat(1000)}次は新チャットへ引き継ぐ`;
    const folded = buildClassifierPrompt(input({ recentAssistantMessages: [long] }));
    expect(folded).toContain('（中略）');
    expect(folded).not.toContain(long);
    // 宣言は応答の末尾に出る。先頭から切ると判定材料そのものが落ちる
    expect(folded).toContain('次は新チャットへ引き継ぐ');
  });

  it('アシスタントの宣言があればそれを分類の対象にすると指示する（Issue #1097）', () => {
    expect(buildClassifierPrompt(input())).toContain(
      'アシスタントの応答が次に取り掛かる作業を宣言していれば',
    );
  });

  it('引き継ぎの提案があったかを判定させる（Issue #1097）', () => {
    const prompt = buildClassifierPrompt(input());
    expect(prompt).toContain('## 引き継ぎを提案しているか（handoff_suggested）');
    expect(prompt).toContain('"handoff_suggested"');
    expect(prompt).toContain('"handoff_suggest_reason"');
  });

  it('ユーザーの回答待ちかを判定させる（Issue #1191）', () => {
    const prompt = buildClassifierPrompt(input());
    expect(prompt).toContain('## ユーザーの回答を待っているか（awaiting_user_answer）');
    expect(prompt).toContain('"awaiting_user_answer"');
    expect(prompt).toContain('"awaiting_user_answer_reason"');
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
      // handoff_suggestedも同じ。無ければ「提案は無かった」（Issue #1097）
      handoffSuggested: false,
      handoffSuggestReason: '',
      // awaiting_user_answerも同じ（Issue #1191）。無ければ「回答待ちではない」
      awaitingUserAnswer: false,
      awaitingUserAnswerReason: '',
    });
  });

  it('awaiting_user_answer と根拠を読む（Issue #1191）', () => {
    const raw = VALID.replace(
      '}',
      ', "awaiting_user_answer": true, "awaiting_user_answer_reason": "実装してよいかを尋ねて終わっている"}',
    );
    expect(parseAssessment(raw)).toMatchObject({
      awaitingUserAnswer: true,
      awaitingUserAnswerReason: '実装してよいかを尋ねて終わっている',
    });
  });

  it('陰性対照: awaiting_user_answer が真偽値でなければ回答待ちではない扱い（Issue #1191）', () => {
    const raw = VALID.replace('}', ', "awaiting_user_answer": "true"}');
    expect(parseAssessment(raw)).toMatchObject({ awaitingUserAnswer: false });
  });

  it('handoff_suggested と根拠を読む（Issue #1097）', () => {
    const raw = VALID.replace(
      '}',
      ', "handoff_suggested": true, "handoff_suggest_reason": "別セッションでの実装を勧めている"}',
    );
    expect(parseAssessment(raw)).toMatchObject({
      handoffSuggested: true,
      handoffSuggestReason: '別セッションでの実装を勧めている',
    });
  });

  it('陰性対照: handoff_suggested が真偽値でなければ提案は無かった扱い（Issue #1097）', () => {
    const raw = VALID.replace('}', ', "handoff_suggested": "true"}');
    expect(parseAssessment(raw)).toMatchObject({ handoffSuggested: false });
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
    const run = vi.fn().mockResolvedValue({ ok: true, text: VALID });
    const assessment = await classifyHandoff(
      { provider: 'codex', executable: '/usr/bin/codex', run },
      input(),
    );
    expect(assessment?.taskType).toBe('implementation');
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      executable: '/usr/bin/codex',
      model: REFLEX_MODELS.codex,
    });
    expect(REFLEX_MODELS.claude).toBe('sonnet');
    expect(REFLEX_MODELS.codex).toBe('gpt-6-luna');
  });

  it('既定のタイムアウトは120秒で、設定された値はそのまま渡す（Issue #1097）', async () => {
    expect(CLASSIFIER_TIMEOUT_MS).toBe(120_000);

    const run = vi.fn().mockResolvedValue({ ok: true, text: VALID });
    await classifyHandoff({ provider: 'codex', executable: 'codex', run }, input());
    expect(run.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 120_000 });

    const explicit = vi.fn().mockResolvedValue({ ok: true, text: VALID });
    await classifyHandoff(
      { provider: 'codex', executable: 'codex', timeoutMs: 45_000, run: explicit },
      input(),
    );
    expect(explicit.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 45_000 });
  });

  it('時間切れ・起動失敗・JSON不正を言い分ける（Issue #1097）', async () => {
    const collect = async (
      value: unknown,
    ): Promise<{ warnings: string[]; assessment: unknown }> => {
      const warnings: string[] = [];
      const assessment = await classifyHandoff(
        {
          provider: 'claude',
          executable: 'claude',
          run: vi.fn().mockResolvedValue(value),
          logWarn: (m) => warnings.push(m),
        },
        input(),
      );
      return { warnings, assessment };
    };

    const timedOut = await collect({ ok: false, reason: 'timeout' });
    expect(timedOut.assessment).toBeUndefined();
    expect(timedOut.warnings[0]).toContain('時間切れ');
    expect(timedOut.warnings[0]).toContain('120000ms');

    const failed = await collect({ ok: false, reason: 'process-error' });
    expect(failed.assessment).toBeUndefined();
    expect(failed.warnings[0]).toContain('実行できませんでした');

    const broken = await collect({ ok: true, text: '分類できませんでした' });
    expect(broken.assessment).toBeUndefined();
    expect(broken.warnings[0]).toContain('JSONとして不正');

    // 3つが同じ文言にならないこと（ログから切り分けられる）
    const messages = [timedOut.warnings[0], failed.warnings[0], broken.warnings[0]];
    expect(new Set(messages).size).toBe(3);
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
