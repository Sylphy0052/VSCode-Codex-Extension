import { describe, expect, it } from 'vitest';
import { readAutoHandoffReflexConfig } from '../../src/config';
import {
  DEFAULT_HANDOFF_REFLEX_BOUNDARY_THRESHOLD,
  DEFAULT_HANDOFF_REFLEX_READING_THRESHOLD,
  DEFAULT_HANDOFF_REFLEX_SUGGEST_THRESHOLD,
  applyHandoffReflexThresholds,
  judgeHandoffBoundary,
  type HandoffReflexSettings,
} from '../../src/view/handoffBoundaryReflex';
import { decideAutoHandoff, decideOldTabAfterHandoff } from '../../src/view/handoff';
import { __mock } from '../mocks/vscode';
import { REFLEX_TIMEOUT, reflexAnswers, reflexStub } from '../helpers/reflexStub';

const settings: HandoffReflexSettings = {
  enabled: true,
  suggestThreshold: 0.6,
  readingThreshold: 0.5,
  boundaryThreshold: 0.6,
};

describe('applyHandoffReflexThresholds（Issue #1710）', () => {
  it('閾値ちょうどは真、わずかに下は偽（3問とも）', () => {
    expect(
      applyHandoffReflexThresholds(
        { suggested: 0.6, reading: 0.5, stage: { 区切り: 0.6 } },
        settings,
      ),
    ).toEqual({ handoffSuggested: true, readingAnswer: true, switchSafe: false });
    expect(
      applyHandoffReflexThresholds(
        { suggested: 0.59, reading: 0.49, stage: { 区切り: 0.6 } },
        settings,
      ),
    ).toEqual({ handoffSuggested: false, readingAnswer: false, switchSafe: true });
    expect(
      applyHandoffReflexThresholds({ suggested: 0, reading: 0, stage: { 区切り: 0.59 } }, settings)
        .switchSafe,
    ).toBe(false);
  });

  it('読む回答なら区切りが確実でもswitchSafeは偽', () => {
    const reading = applyHandoffReflexThresholds(
      { suggested: 0, reading: 0.9, stage: { 区切り: 1 } },
      settings,
    );
    expect(reading.readingAnswer).toBe(true);
    expect(reading.switchSafe).toBe(false);
  });

  it('stageに区切りのキーが無ければswitchSafeは偽', () => {
    const reading = applyHandoffReflexThresholds(
      { suggested: 0, reading: 0, stage: { 途中: 1 } },
      settings,
    );
    expect(reading.switchSafe).toBe(false);
  });
});

describe('judgeHandoffBoundary（Issue #1710）', () => {
  const material = { userMessage: '実装して', assistantMessage: '終わった' };

  it('3問が揃えば確率を返す', async () => {
    const stub = reflexStub(
      reflexAnswers({ p: 0.9 }, { p: 0.1 }, { probs: { 区切り: 0.8, 判断待ち: 0.1, 途中: 0.1 } }),
    );
    const verdict = await judgeHandoffBoundary(stub.deps, material);
    expect(verdict?.suggested).toBeGreaterThan(0.5);
    expect(verdict?.reading).toBeLessThan(0.5);
    expect(verdict?.stage['区切り']).toBeGreaterThan(0.5);
  });

  it('答えの数が足りない（形が合わない）ときはundefined', async () => {
    const stub = reflexStub(reflexAnswers({ p: 0.9 }, { p: 0.1 }));
    expect(await judgeHandoffBoundary(stub.deps, material)).toBeUndefined();
  });

  it('答えの種類が質問と違うときはundefined', async () => {
    const stub = reflexStub(reflexAnswers({ p: 0.9 }, { p: 0.1 }, { p: 0.5 }));
    expect(await judgeHandoffBoundary(stub.deps, material)).toBeUndefined();
  });

  it('呼び出しが失敗してanswersがundefinedのときはundefined', async () => {
    const stub = reflexStub(REFLEX_TIMEOUT);
    expect(await judgeHandoffBoundary(stub.deps, material)).toBeUndefined();
  });
});

describe('decideAutoHandoff: Reflexの入力（Issue #1710）', () => {
  const base = {
    enabled: true,
    busy: false,
    alreadyStarted: false,
    compacted: false,
    thresholdPercent: 15,
    softThresholdPercent: 40,
    remainingPercent: 90,
    boundaryGatePassed: true,
  } as const;

  it('readingAnswerが真の提案にはkeepOldTabが付く', () => {
    expect(
      decideAutoHandoff({ ...base, handoffSuggested: true, readingAnswer: true }),
    ).toMatchObject({
      kind: 'assistantSuggested',
      keepOldTab: true,
    });
  });

  it('readingAnswerが偽ならkeepOldTabは付かない', () => {
    const trigger = decideAutoHandoff({ ...base, handoffSuggested: true, readingAnswer: false });
    expect(trigger).toMatchObject({ kind: 'assistantSuggested' });
    expect(trigger).not.toHaveProperty('keepOldTab');
  });

  it('質問で終わり提案が無ければ止まる（awaitingUserAnswer真）', () => {
    expect(
      decideAutoHandoff({
        ...base,
        awaitingUserAnswer: true,
        safeBoundary: true,
        remainingPercent: 30,
      }),
    ).toBeUndefined();
  });

  it('質問で終わっても提案があれば（awaitingUserAnswer偽）発火する', () => {
    expect(
      decideAutoHandoff({ ...base, awaitingUserAnswer: false, handoffSuggested: true }),
    ).toMatchObject({ kind: 'assistantSuggested' });
  });
});

describe('decideOldTabAfterHandoff: keepForReadingの優先順位（Issue #1710）', () => {
  const ok = { outcome: { succeeded: true } as const, oldDisposed: false, oldBusy: false };

  it('closeOldTabが真でもkeepForReadingならreadingAnswerで残す', () => {
    expect(decideOldTabAfterHandoff({ ...ok, closeOldTab: true, keepForReading: true })).toEqual({
      action: 'keep',
      reason: 'readingAnswer',
    });
  });

  it('closeOldTabが偽でもkeepForReadingが優先され、確認ダイアログにしない', () => {
    expect(decideOldTabAfterHandoff({ ...ok, closeOldTab: false, keepForReading: true })).toEqual({
      action: 'keep',
      reason: 'readingAnswer',
    });
  });

  it('旧タブが破棄済みならdisposedが優先される', () => {
    expect(
      decideOldTabAfterHandoff({
        ...ok,
        oldDisposed: true,
        closeOldTab: true,
        keepForReading: true,
      }),
    ).toEqual({ action: 'keep', reason: 'disposed' });
  });

  it('引き継ぎ先が応答しなければその理由が優先される', () => {
    expect(
      decideOldTabAfterHandoff({
        ...ok,
        outcome: { succeeded: false, reason: 'noResponse' },
        closeOldTab: true,
        keepForReading: true,
      }),
    ).toEqual({ action: 'keep', reason: 'noResponse' });
  });

  it('keepForReadingが偽ならcloseOldTabに従う', () => {
    expect(decideOldTabAfterHandoff({ ...ok, closeOldTab: true, keepForReading: false })).toEqual({
      action: 'close',
    });
  });
});

describe('readAutoHandoffReflexConfig（Issue #1710）', () => {
  it('未設定なら既定値', () => {
    __mock.setConfig('agent', {});
    expect(readAutoHandoffReflexConfig(true)).toEqual({
      enabled: true,
      suggestThreshold: DEFAULT_HANDOFF_REFLEX_SUGGEST_THRESHOLD,
      readingThreshold: DEFAULT_HANDOFF_REFLEX_READING_THRESHOLD,
      boundaryThreshold: DEFAULT_HANDOFF_REFLEX_BOUNDARY_THRESHOLD,
    });
  });

  it.each([
    ['1超', 1.5],
    ['負', -0.1],
    ['文字列', '0.3'],
    ['NaN', Number.NaN],
    ['null', null],
  ])('範囲外・非数値（%s）は既定値へ戻す', (_label, value) => {
    __mock.setConfig('agent', {
      'autoHandoff.reflex.suggestThreshold': value,
      'autoHandoff.reflex.readingThreshold': value,
      'autoHandoff.reflex.boundaryThreshold': value,
    });
    expect(readAutoHandoffReflexConfig(true)).toMatchObject({
      suggestThreshold: DEFAULT_HANDOFF_REFLEX_SUGGEST_THRESHOLD,
      readingThreshold: DEFAULT_HANDOFF_REFLEX_READING_THRESHOLD,
      boundaryThreshold: DEFAULT_HANDOFF_REFLEX_BOUNDARY_THRESHOLD,
    });
  });

  it('0と1は範囲内としてそのまま使う', () => {
    __mock.setConfig('agent', {
      'autoHandoff.reflex.suggestThreshold': 0,
      'autoHandoff.reflex.readingThreshold': 1,
    });
    expect(readAutoHandoffReflexConfig(false)).toMatchObject({
      enabled: false,
      suggestThreshold: 0,
      readingThreshold: 1,
    });
  });
});
