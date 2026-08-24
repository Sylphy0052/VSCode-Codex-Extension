import { describe, expect, it } from 'vitest';
import {
  buildAskUserQuestionDenyResponse,
  buildAskUserQuestionResponse,
  describeAskUserQuestion,
  isAskUserQuestionSelections,
  readAskUserQuestions,
} from '../../src/claude/askUserQuestion';

function option(label: string): { label: string; description: string } {
  return { label, description: `${label}の説明` };
}

function question(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    question: 'どちらにしますか',
    header: '選択',
    options: [option('A'), option('B')],
    multiSelect: false,
    ...overrides,
  };
}

describe('readAskUserQuestions（issue #685、入力バリデーション）', () => {
  it('1〜4問・各2〜4選択肢なら読める', () => {
    expect(readAskUserQuestions([question()])).toEqual([
      {
        question: 'どちらにしますか',
        header: '選択',
        options: [option('A'), option('B')],
        multiSelect: false,
      },
    ]);
  });

  it('配列でなければundefined', () => {
    expect(readAskUserQuestions({})).toBeUndefined();
    expect(readAskUserQuestions(undefined)).toBeUndefined();
  });

  it('0問はundefined', () => {
    expect(readAskUserQuestions([])).toBeUndefined();
  });

  it('5問以上はundefined', () => {
    expect(
      readAskUserQuestions([question(), question(), question(), question(), question()]),
    ).toBeUndefined();
  });

  it('1選択肢はundefined', () => {
    expect(readAskUserQuestions([question({ options: [option('A')] })])).toBeUndefined();
  });

  it('5選択肢以上はundefined', () => {
    expect(
      readAskUserQuestions([
        question({ options: [option('A'), option('B'), option('C'), option('D'), option('E')] }),
      ]),
    ).toBeUndefined();
  });

  it('questionが空文字・非文字列はundefined', () => {
    expect(readAskUserQuestions([question({ question: '' })])).toBeUndefined();
    expect(readAskUserQuestions([question({ question: 42 })])).toBeUndefined();
  });

  it('headerが無ければ空文字で補う', () => {
    const [item] = readAskUserQuestions([question({ header: undefined })])!;
    expect(item!.header).toBe('');
  });

  it('multiSelectはtrue以外すべてfalse扱い', () => {
    const [item] = readAskUserQuestions([question({ multiSelect: 'yes' })])!;
    expect(item!.multiSelect).toBe(false);
  });
});

describe('describeAskUserQuestion（issue #685、承認カードの組み立て）', () => {
  it('不正な入力はundefined（呼び出し側で拒否側へ倒させる）', () => {
    expect(describeAskUserQuestion('r1', { questions: [] })).toBeUndefined();
  });

  it('1問ならheaderをそのまま件名にする', () => {
    const approval = describeAskUserQuestion('r1', { questions: [question()] });
    expect(approval).toMatchObject({
      requestId: 'r1',
      kind: 'askUserQuestion',
      detail: '選択',
    });
    expect(approval?.questions).toHaveLength(1);
  });

  it('複数問なら残り件数を添える', () => {
    const approval = describeAskUserQuestion('r1', {
      questions: [question(), question({ header: '2問目' })],
    });
    expect(approval?.detail).toBe('選択 ・他1問');
  });
});

describe('buildAskUserQuestionResponse（issue #685、multiSelectでの展開）', () => {
  it('multiSelect:falseの質問は選んだ値を1つの文字列にする', () => {
    const originalInput = { questions: [question({ multiSelect: false })] };
    const response = buildAskUserQuestionResponse(originalInput, { どちらにしますか: ['A'] });
    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: { questions: originalInput.questions, answers: { どちらにしますか: 'A' } },
    });
  });

  it('multiSelect:trueの質問は配列のまま渡す', () => {
    const originalInput = { questions: [question({ multiSelect: true })] };
    const response = buildAskUserQuestionResponse(originalInput, { どちらにしますか: ['A', 'B'] });
    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: originalInput.questions,
        answers: { どちらにしますか: ['A', 'B'] },
      },
    });
  });

  it('選択が空配列ならmultiSelect:falseの質問は空文字にする', () => {
    const originalInput = { questions: [question({ multiSelect: false })] };
    const response = buildAskUserQuestionResponse(originalInput, { どちらにしますか: [] });
    expect(response).toEqual({
      behavior: 'allow',
      updatedInput: { questions: originalInput.questions, answers: { どちらにしますか: '' } },
    });
  });
});

describe('buildAskUserQuestionDenyResponse', () => {
  it('拒否応答を返す', () => {
    expect(buildAskUserQuestionDenyResponse()).toEqual({
      behavior: 'deny',
      message: 'ユーザーが拒否しました',
    });
  });
});

describe('isAskUserQuestionSelections（issue #685、webviewからの入力検証）', () => {
  it('質問文→ラベル配列の形なら真', () => {
    expect(isAskUserQuestionSelections({ どちらにしますか: ['A'] })).toBe(true);
  });

  it('配列そのものは偽', () => {
    expect(isAskUserQuestionSelections(['A'])).toBe(false);
  });

  it('値が文字列配列でなければ偽', () => {
    expect(isAskUserQuestionSelections({ q: 'A' })).toBe(false);
    expect(isAskUserQuestionSelections({ q: [1] })).toBe(false);
  });

  it('null/undefinedは偽', () => {
    expect(isAskUserQuestionSelections(null)).toBe(false);
    expect(isAskUserQuestionSelections(undefined)).toBe(false);
  });

  it('空配列（未回答）は偽', () => {
    expect(isAskUserQuestionSelections({ どちらにしますか: [] })).toBe(false);
  });

  it('空オブジェクトは偽', () => {
    expect(isAskUserQuestionSelections({})).toBe(false);
  });
});
