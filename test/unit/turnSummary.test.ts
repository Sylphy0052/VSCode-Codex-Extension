import { describe, expect, it } from 'vitest';
import {
  appendTurnSummaryInstruction,
  DEFAULT_TURN_SUMMARY_INSTRUCTION,
} from '../../src/view/turnSummary';

const enabled = { enabled: true, instruction: DEFAULT_TURN_SUMMARY_INSTRUCTION };

describe('appendTurnSummaryInstruction', () => {
  it('無効なら本文を一字一句変えない（既定の挙動）', () => {
    const text = 'ここを直して\n\n';
    expect(
      appendTurnSummaryInstruction(text, {
        enabled: false,
        instruction: DEFAULT_TURN_SUMMARY_INSTRUCTION,
      }),
    ).toBe(text);
  });

  it('有効なら本文と指示文を空行で区切って連結する', () => {
    expect(appendTurnSummaryInstruction('ここを直して', enabled)).toBe(
      `ここを直して\n\n${DEFAULT_TURN_SUMMARY_INSTRUCTION}`,
    );
  });

  it('本文の末尾の空白・改行は落としてから連結する（空行が増えない）', () => {
    expect(appendTurnSummaryInstruction('- 一つ目\n- 二つ目\n\n  ', enabled)).toBe(
      `- 一つ目\n- 二つ目\n\n${DEFAULT_TURN_SUMMARY_INSTRUCTION}`,
    );
  });

  it('指示文が空文字なら連結しない（無効化と同じ扱い）', () => {
    expect(appendTurnSummaryInstruction('ここを直して', { enabled: true, instruction: '' })).toBe(
      'ここを直して',
    );
    expect(
      appendTurnSummaryInstruction('ここを直して', { enabled: true, instruction: '   \n' }),
    ).toBe('ここを直して');
  });

  it('本文が空なら連結しない（画像だけを送る場合に指示文だけが本文になるのを避ける）', () => {
    expect(appendTurnSummaryInstruction('', enabled)).toBe('');
    expect(appendTurnSummaryInstruction('  \n ', enabled)).toBe('  \n ');
  });

  it('指示文の前後の空白は落として連結する', () => {
    expect(
      appendTurnSummaryInstruction('やって', { enabled: true, instruction: '  要約も出して  ' }),
    ).toBe('やって\n\n要約も出して');
  });
});
