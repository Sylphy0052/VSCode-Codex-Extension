import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '../../src/appserver/chatState';
import type { PendingPrompt } from '../../src/appserver/prompts';
import {
  AnsweredPendingIds,
  buildChatPendingItems,
  parsePendingItems,
  parsePromptSubmission,
  PendingFirstSeen,
  validateAskUserQuestionAnswers,
} from '../../src/view/pendingItem';
import { deriveSessionActivityState } from '../../src/view/sessionActivity';

const askApproval: PendingApproval = {
  requestId: 'r1',
  kind: 'askUserQuestion',
  title: '質問',
  detail: '',
  itemId: undefined,
  questions: [
    {
      question: 'どれにする?',
      header: '方針',
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: false,
    },
  ],
};

const prompt: PendingPrompt = {
  requestId: 7,
  kind: 'userInput',
  title: '入力を求められています',
  source: '',
  message: '',
  blocking: true,
  fields: [
    {
      id: 'q',
      label: 'Q',
      description: '名前は?',
      options: [],
      multiple: false,
      allowOther: true,
      secret: false,
      input: 'text',
      required: false,
      defaultValue: '',
      integer: false,
      minimum: undefined,
      maximum: undefined,
    },
  ],
  errors: {},
  url: undefined,
};

const context = {
  windowId: 'w',
  threadId: 't',
  provider: 'codex' as const,
  cwd: '/repo',
  handoffPending: false,
};

describe('PendingItem（Issue #2135）', () => {
  it('Codexの問い合わせだけでも承認待ちになる', () => {
    expect(
      deriveSessionActivityState({
        busy: true,
        approvals: [],
        backgroundTerminals: [],
        prompts: [prompt],
      }),
    ).toBe('approvalPending');
  });

  it('承認・AskUserQuestion・問い合わせを1つの形へそろえ、idは安定する', () => {
    const seen = new PendingFirstSeen(() => 100);
    const items = buildChatPendingItems(
      { approvals: [askApproval], prompts: [prompt] },
      context,
      seen,
    );
    expect(items.map((i) => [i.id, i.kind, i.answer, i.payload.summary])).toEqual([
      ['codex:t:askUserQuestion:r1', 'askUserQuestion', 'choices', 'どれにする?'],
      ['codex:t:codexPrompt:7', 'codexPrompt', 'text', '名前は?'],
    ]);
    expect(items.every((i) => i.createdAt === 100 && i.session.windowId === 'w')).toBe(true);
  });

  it('他ウィンドウの壊れた要素・知らない種類を落とす', () => {
    const good = buildChatPendingItems(
      { approvals: [], prompts: [prompt] },
      context,
      new PendingFirstSeen(),
    )[0];
    expect(parsePendingItems([good, { ...good, kind: 'unknown' }, null, { id: 1 }])).toEqual([
      good,
    ]);
    expect(parsePendingItems('x')).toEqual([]);
  });

  it('AskUserQuestionの回答は質問と突き合わせる', () => {
    const questions = askApproval.questions ?? [];
    expect(validateAskUserQuestionAnswers(questions, { 'どれにする?': ['A'] })).toEqual({
      'どれにする?': ['A'],
    });
    expect(typeof validateAskUserQuestionAnswers(questions, {})).toBe('string');
    expect(typeof validateAskUserQuestionAnswers(questions, { 'どれにする?': ['A', 'B'] })).toBe(
      'string',
    );
    expect(
      typeof validateAskUserQuestionAnswers(questions, { 'どれにする?': ['A'], 別: ['x'] }),
    ).toBe('string');
  });

  it('フォームの回答は形だけ確かめ、__proto__でも値を失わない', () => {
    expect(parsePromptSubmission({ action: 'x' })).toBeUndefined();
    const parsed = parsePromptSubmission(
      JSON.parse('{"action":"submit","values":{"__proto__":["v"]}}'),
    );
    expect(parsed?.action).toBe('submit');
    expect(Object.entries(parsed?.values ?? {})).toEqual([['__proto__', ['v']]]);
  });

  it('回答済みのidを覚え、上限を超えたら古いものから忘れる', () => {
    const answered = new AnsweredPendingIds(2);
    answered.add('a');
    answered.add('b');
    answered.add('c');
    expect([answered.has('a'), answered.has('b'), answered.has('c')]).toEqual([false, true, true]);
  });
});
