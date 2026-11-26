import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_DATA_URL_CHARS, MAX_ATTACHMENTS } from '../../src/provider/attachments';
import {
  MAX_CANDIDATE_QUERY_CHARS,
  parseAction,
  parseTarget,
  toReplyPayload,
  toSessionControlAction,
} from '../../src/view/sessionControlMessage';

describe('parseTarget', () => {
  it('3つの値が揃っていれば対象を返す', () => {
    expect(
      parseTarget({
        windowId: '11111111-1111-4111-8111-111111111111',
        provider: 'codex',
        threadId: 't1',
      }),
    ).toEqual({
      windowId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      threadId: 't1',
    });
    expect(
      parseTarget({
        windowId: '11111111-1111-4111-8111-111111111111',
        provider: 'claude',
        threadId: 't1',
        extra: 1,
      }),
    ).toEqual({
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

// Issue #2158: Composerの添付・補完・送信キュー
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('parseAction: 添付・補完・送信キュー（Issue #2158）', () => {
  it('sendWithAttachmentsは本文と1枚以上の画像を要る', () => {
    expect(
      parseAction({
        action: 'sendWithAttachments',
        text: 'see',
        attachments: [{ name: 'a.png', dataUrl: PNG }],
      }),
    ).toEqual({
      kind: 'sendWithAttachments',
      text: 'see',
      attachments: [{ name: 'a.png', dataUrl: PNG }],
    });
    expect(
      parseAction({ action: 'sendWithAttachments', text: 'x', attachments: [] }),
    ).toBeUndefined();
    expect(parseAction({ action: 'sendWithAttachments', text: 'x' })).toBeUndefined();
    expect(
      parseAction({ action: 'sendWithAttachments', attachments: [{ name: 'a', dataUrl: PNG }] }),
    ).toBeUndefined();
  });

  it('画像の形・長さ・枚数が合わなければ断る', () => {
    const one = (item: unknown) =>
      parseAction({ action: 'sendWithAttachments', text: '', attachments: [item] });
    expect(one({ name: 'a', dataUrl: 'file:///etc/passwd' })).toBeUndefined();
    expect(one({ name: 1, dataUrl: PNG })).toBeUndefined();
    expect(one({ name: 'x'.repeat(256), dataUrl: PNG })).toBeUndefined();
    expect(
      one({ name: 'a', dataUrl: `data:${'x'.repeat(MAX_ATTACHMENT_DATA_URL_CHARS)}` }),
    ).toBeUndefined();
    expect(one(null)).toBeUndefined();
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ name: 'a', dataUrl: PNG }));
    expect(
      parseAction({ action: 'sendWithAttachments', text: '', attachments: many }),
    ).toBeUndefined();
  });

  it('fileCandidatesは絞り込みの文字列を上限まで受ける', () => {
    expect(parseAction({ action: 'fileCandidates', query: 'src/' })).toEqual({
      kind: 'fileCandidates',
      query: 'src/',
    });
    expect(parseAction({ action: 'fileCandidates', query: '' })).toEqual({
      kind: 'fileCandidates',
      query: '',
    });
    expect(
      parseAction({ action: 'fileCandidates', query: 'x'.repeat(MAX_CANDIDATE_QUERY_CHARS + 1) }),
    ).toBeUndefined();
    expect(parseAction({ action: 'fileCandidates' })).toBeUndefined();
  });

  it('commandCandidates・queuedMessagesは引数が無い', () => {
    expect(parseAction({ action: 'commandCandidates' })).toEqual({ kind: 'commandCandidates' });
    expect(parseAction({ action: 'queuedMessages' })).toEqual({ kind: 'queuedMessages' });
  });

  it('cancelQueuedは0以上の整数の位置と項目idを要る', () => {
    expect(parseAction({ action: 'cancelQueued', index: 0, queuedId: 'a' })).toEqual({
      kind: 'cancelQueued',
      index: 0,
      queuedId: 'a',
    });
    expect(parseAction({ action: 'cancelQueued', index: -1, queuedId: 'a' })).toBeUndefined();
    expect(parseAction({ action: 'cancelQueued', index: 1.5, queuedId: 'a' })).toBeUndefined();
    expect(parseAction({ action: 'cancelQueued', index: '0', queuedId: 'a' })).toBeUndefined();
    expect(parseAction({ action: 'cancelQueued', index: 0 })).toBeUndefined();
    expect(parseAction({ action: 'cancelQueued', index: 0, queuedId: '' })).toBeUndefined();
    expect(parseAction({ action: 'cancelQueued', index: 0, text: 'a' })).toBeUndefined();
  });
});

describe('toSessionControlAction: session-hubの要求の検証（Issue #2158）', () => {
  it('追加した種別は検証を通る', () => {
    const attachments = [{ name: 'a.png', dataUrl: PNG }];
    expect(toSessionControlAction({ kind: 'sendWithAttachments', text: 't', attachments })).toEqual(
      { kind: 'sendWithAttachments', text: 't', attachments },
    );
    expect(toSessionControlAction({ kind: 'fileCandidates', query: 'a' })).toEqual({
      kind: 'fileCandidates',
      query: 'a',
    });
    expect(toSessionControlAction({ kind: 'commandCandidates' })).toEqual({
      kind: 'commandCandidates',
    });
    expect(toSessionControlAction({ kind: 'queuedMessages' })).toEqual({ kind: 'queuedMessages' });
    expect(toSessionControlAction({ kind: 'cancelQueued', index: 2, queuedId: 'b' })).toEqual({
      kind: 'cancelQueued',
      index: 2,
      queuedId: 'b',
    });
  });

  it('必要な項目が欠けた要求は断る', () => {
    expect(toSessionControlAction({ kind: 'sendWithAttachments', text: 't' })).toBeUndefined();
    expect(
      toSessionControlAction({
        kind: 'sendWithAttachments',
        attachments: [{ name: 'a', dataUrl: PNG }],
      }),
    ).toBeUndefined();
    expect(toSessionControlAction({ kind: 'fileCandidates' })).toBeUndefined();
    expect(toSessionControlAction({ kind: 'cancelQueued', queuedId: 'b' })).toBeUndefined();
    expect(
      toSessionControlAction({ kind: 'cancelQueued', index: -1, queuedId: 'b' }),
    ).toBeUndefined();
  });

  it('未知の種別は断る', () => {
    expect(toSessionControlAction({ kind: 'deleteEverything' as never })).toBeUndefined();
    expect(toSessionControlAction({ kind: 'attachments' as never })).toBeUndefined();
  });
});

describe('選んだセッションへの操作（Issue #2160）', () => {
  it('parseAction: 6操作を受け付け、名前は前後の空白を落とす', () => {
    expect(parseAction({ action: 'rename', name: '  新しい名前 ' })).toEqual({
      kind: 'rename',
      name: '新しい名前',
    });
    for (const action of ['fork', 'pin', 'unpin', 'clear', 'handoff'] as const) {
      expect(parseAction({ action })).toEqual({ kind: action });
    }
    expect(parseAction({ action: 'rewindPreview', messageId: 'm-1' })).toEqual({
      kind: 'rewindPreview',
      messageId: 'm-1',
    });
    expect(parseAction({ action: 'rewind', messageId: 'm-1' })).toEqual({
      kind: 'rewind',
      messageId: 'm-1',
    });
  });

  it('parseAction: 空・長すぎる・改行入りの名前と、idの無い巻き戻しは断る', () => {
    expect(parseAction({ action: 'rename', name: '   ' })).toBeUndefined();
    expect(parseAction({ action: 'rename', name: 'a'.repeat(201) })).toBeUndefined();
    expect(parseAction({ action: 'rename', name: 'a\nb' })).toBeUndefined();
    expect(parseAction({ action: 'rename' })).toBeUndefined();
    expect(parseAction({ action: 'rewind' })).toBeUndefined();
    expect(parseAction({ action: 'rewind', messageId: '' })).toBeUndefined();
    expect(parseAction({ action: 'rewindPreview', messageId: 'a\nb' })).toBeUndefined();
    expect(parseAction({ action: 'rewind', messageId: 3 })).toBeUndefined();
  });

  it('toSessionControlAction: session-hubの要求も同じ規則で確かめる', () => {
    expect(toSessionControlAction({ kind: 'rename', name: 'n' })).toEqual({
      kind: 'rename',
      name: 'n',
    });
    expect(toSessionControlAction({ kind: 'clear' })).toEqual({ kind: 'clear' });
    expect(toSessionControlAction({ kind: 'handoff' })).toEqual({ kind: 'handoff' });
    expect(toSessionControlAction({ kind: 'rewind', messageId: 'm' })).toEqual({
      kind: 'rewind',
      messageId: 'm',
    });
    expect(toSessionControlAction({ kind: 'rename' })).toBeUndefined();
    expect(toSessionControlAction({ kind: 'rewindPreview' })).toBeUndefined();
  });

  it('toReplyPayload: 巻き戻しで戻るファイルを応答へ載せる', () => {
    expect(toReplyPayload({ ok: true, rewindFiles: ['a.ts'] })).toEqual({ rewindFiles: ['a.ts'] });
    expect(toReplyPayload({ ok: true, rewindFiles: [] })).toEqual({ rewindFiles: [] });
  });
});

describe('toReplyPayload（Issue #2158）', () => {
  it('候補・送信キューを応答へ載せる', () => {
    expect(toReplyPayload({ ok: true, files: ['a.ts'] })).toEqual({ files: ['a.ts'] });
    const commands = [{ name: 'init', description: 'd', argumentHint: '' }];
    expect(toReplyPayload({ ok: true, commands })).toEqual({ commands });
    const queued = [{ id: 'q1', text: 'q', truncated: false, attachments: 1 }];
    expect(toReplyPayload({ ok: true, queued })).toEqual({ queued });
    expect(toReplyPayload({ ok: true })).toBeUndefined();
  });
});
