import { describe, expect, it } from 'vitest';
import { parseAction, parseTarget } from '../../src/view/sessionControlMessage';

describe('parseTarget', () => {
  it('3つの値が揃っていれば対象を返す', () => {
    expect(parseTarget({ windowId: '11111111-1111-4111-8111-111111111111', provider: 'codex', threadId: 't1' })).toEqual({
      windowId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      threadId: 't1',
    });
    expect(parseTarget({ windowId: '11111111-1111-4111-8111-111111111111', provider: 'claude', threadId: 't1', extra: 1 })).toEqual({
      windowId: '11111111-1111-4111-8111-111111111111',
      provider: 'claude',
      threadId: 't1',
    });
  });

  it.each([
    ['windowIdが無い', { provider: 'codex', threadId: 't' }],
    ['windowIdが文字列でない', { windowId: 1, provider: 'codex', threadId: 't' }],
    ['threadIdが無い', { windowId: 'w', provider: 'codex' }],
    ['threadIdが文字列でない', { windowId: 'w', provider: 'codex', threadId: null }],
    ['providerが未知', { windowId: 'w', provider: 'gemini', threadId: 't' }],
    ['providerが無い', { windowId: 'w', threadId: 't' }],
  ])('%sならundefined', (_name, message) => {
    expect(parseTarget(message)).toBeUndefined();
  });
});

describe('parseAction', () => {
  it.each(['open', 'interrupt', 'pauseLoop', 'resumeLoop', 'approvalDetail', 'handoffDetail'])(
    '引数の無い操作 %s',
    (action) => {
      expect(parseAction({ action })).toEqual({ kind: action });
    },
  );

  it('未知・欠落のactionはundefined', () => {
    expect(parseAction({ action: 'nope' })).toBeUndefined();
    expect(parseAction({})).toBeUndefined();
    expect(parseAction({ action: 1 })).toBeUndefined();
  });

  it('send', () => {
    expect(parseAction({ action: 'send', text: 'hi' })).toEqual({ kind: 'send', text: 'hi' });
    expect(parseAction({ action: 'send', text: '' })).toEqual({ kind: 'send', text: '' });
    expect(parseAction({ action: 'send' })).toBeUndefined();
    expect(parseAction({ action: 'send', text: 1 })).toBeUndefined();
  });

  it('recentTurns', () => {
    expect(parseAction({ action: 'recentTurns', limit: 5 })).toEqual({
      kind: 'recentTurns',
      limit: 5,
    });
    expect(parseAction({ action: 'recentTurns', limit: '5' })).toBeUndefined();
    expect(parseAction({ action: 'recentTurns' })).toBeUndefined();
  });

  it('sideQuestion', () => {
    expect(parseAction({ action: 'sideQuestion', text: 'q' })).toEqual({
      kind: 'sideQuestion',
      text: 'q',
    });
    expect(parseAction({ action: 'sideQuestion', text: 2 })).toBeUndefined();
  });

  it('sideQuestionResult', () => {
    expect(parseAction({ action: 'sideQuestionResult', sideQuestionId: 's1' })).toEqual({
      kind: 'sideQuestionResult',
      sideQuestionId: 's1',
    });
    expect(parseAction({ action: 'sideQuestionResult' })).toBeUndefined();
    expect(parseAction({ action: 'sideQuestionResult', sideQuestionId: 1 })).toBeUndefined();
  });

  it('approvalDecision', () => {
    expect(
      parseAction({ action: 'approvalDecision', approvalRequestId: 'a', decision: 'accept' }),
    ).toEqual({ kind: 'approvalDecision', approvalRequestId: 'a', decision: 'accept' });
    expect(
      parseAction({ action: 'approvalDecision', approvalRequestId: 'a', decision: 'decline' }),
    ).toEqual({ kind: 'approvalDecision', approvalRequestId: 'a', decision: 'decline' });
    expect(
      parseAction({ action: 'approvalDecision', approvalRequestId: 'a', decision: 'maybe' }),
    ).toBeUndefined();
    expect(
      parseAction({ action: 'approvalDecision', approvalRequestId: 1, decision: 'accept' }),
    ).toBeUndefined();
    expect(parseAction({ action: 'approvalDecision', decision: 'accept' })).toBeUndefined();
  });

  it('handoffDecision', () => {
    expect(
      parseAction({
        action: 'handoffDecision',
        handoffRequestId: 'h',
        decision: 'repick',
        model: 'm',
        effort: 'high',
      }),
    ).toEqual({
      kind: 'handoffDecision',
      handoffRequestId: 'h',
      decision: 'repick',
      model: 'm',
      effort: 'high',
    });
    // model / effortは文字列でなければundefined
    expect(
      parseAction({
        action: 'handoffDecision',
        handoffRequestId: 'h',
        decision: 'proceed',
        model: 1,
        effort: null,
      }),
    ).toEqual({
      kind: 'handoffDecision',
      handoffRequestId: 'h',
      decision: 'proceed',
      model: undefined,
      effort: undefined,
    });
    for (const decision of ['proceed', 'repick', 'reclassify', 'cancel']) {
      expect(
        parseAction({ action: 'handoffDecision', handoffRequestId: 'h', decision }),
      ).toMatchObject({ kind: 'handoffDecision', decision });
    }
    expect(
      parseAction({ action: 'handoffDecision', handoffRequestId: 'h', decision: 'x' }),
    ).toBeUndefined();
    expect(
      parseAction({ action: 'handoffDecision', handoffRequestId: 1, decision: 'cancel' }),
    ).toBeUndefined();
  });

  it('answerQuestion', () => {
    expect(
      parseAction({
        action: 'answerQuestion',
        pendingRequestId: 'p',
        answers: { q1: ['a', 1, 'b'], q2: 'notArray' },
      }),
    ).toEqual({ kind: 'answerQuestion', pendingRequestId: 'p', answers: { q1: ['a', 'b'] } });
    expect(parseAction({ action: 'answerQuestion', pendingRequestId: 'p', answers: {} })).toEqual({
      kind: 'answerQuestion',
      pendingRequestId: 'p',
      answers: {},
    });
    // answersが不正（配列・null・未指定）
    expect(
      parseAction({ action: 'answerQuestion', pendingRequestId: 'p', answers: [] }),
    ).toBeUndefined();
    expect(
      parseAction({ action: 'answerQuestion', pendingRequestId: 'p', answers: null }),
    ).toBeUndefined();
    expect(parseAction({ action: 'answerQuestion', pendingRequestId: 'p' })).toBeUndefined();
    // pendingRequestIdが不正
    expect(parseAction({ action: 'answerQuestion', answers: {} })).toBeUndefined();
  });

  it('answerPrompt', () => {
    expect(
      parseAction({
        action: 'answerPrompt',
        pendingRequestId: 'p',
        submission: { action: 'submit', values: { a: ['x'] } },
      }),
    ).toEqual({
      kind: 'answerPrompt',
      pendingRequestId: 'p',
      submission: { action: 'submit', values: { a: ['x'] } },
    });
    expect(
      parseAction({
        action: 'answerPrompt',
        pendingRequestId: 'p',
        submission: { action: 'bogus' },
      }),
    ).toBeUndefined();
    expect(
      parseAction({ action: 'answerPrompt', pendingRequestId: 'p', submission: 'x' }),
    ).toBeUndefined();
    expect(
      parseAction({ action: 'answerPrompt', submission: { action: 'cancel' } }),
    ).toBeUndefined();
  });

  it('answerTaskRunQuestion', () => {
    expect(parseAction({ action: 'answerTaskRunQuestion', pendingId: 'p', text: 'ans' })).toEqual({
      kind: 'answerTaskRunQuestion',
      pendingId: 'p',
      text: 'ans',
    });
    expect(parseAction({ action: 'answerTaskRunQuestion', text: 'ans' })).toBeUndefined();
    expect(parseAction({ action: 'answerTaskRunQuestion', pendingId: 'p' })).toBeUndefined();
    expect(
      parseAction({ action: 'answerTaskRunQuestion', pendingId: 1, text: 'a' }),
    ).toBeUndefined();
  });
});
