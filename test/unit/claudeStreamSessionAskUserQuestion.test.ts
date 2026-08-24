import { describe, expect, it } from 'vitest';
import { ClaudeStreamSession } from '../../src/claude/streamSession';
import type { ChatState } from '../../src/appserver/chatState';
import type { Logger } from '../../src/log';

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

interface FakeProc {
  killed: boolean;
  stdin: { write: (line: string) => void; destroyed: boolean; writable: boolean };
}

/**
 * `claudeStreamSessionSideQuestion.test.ts`と同じ方針で書き込みを記録するフェイクprocを
 * 差し込みつつ、`claudeStreamSessionApproval.test.ts`と同じく`states`（第2引数の
 * onStateChanged）で承認カードの積み下ろしを観測する。
 */
function createSessionWithFakeProc(): {
  session: ClaudeStreamSession;
  written: string[];
  states: ChatState[];
} {
  const written: string[] = [];
  const states: ChatState[] = [];
  const session = new ClaudeStreamSession(
    () => 'claude',
    fakeLogger,
    (state) => states.push(state),
  );
  const fakeProc: FakeProc = {
    killed: false,
    stdin: { write: (line) => written.push(line), destroyed: false, writable: true },
  };
  (session as unknown as { proc: FakeProc }).proc = fakeProc;
  return { session, written, states };
}

const QUESTIONS = [
  {
    question: 'どちらにしますか',
    header: '選択',
    options: [
      { label: 'A', description: 'Aの説明' },
      { label: 'B', description: 'Bの説明' },
    ],
    multiSelect: false,
  },
];

function canUseToolLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: { questions: QUESTIONS },
    },
  })}\n`;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ClaudeStreamSession の AskUserQuestion 対応（issue #685）', () => {
  it('can_use_tool（AskUserQuestion）は questions 入りの承認カードを積む', async () => {
    const { session, states } = createSessionWithFakeProc();

    session.receive(canUseToolLine('r1'));
    await flushMicrotasks();

    const last = states[states.length - 1];
    expect(last?.approvals).toHaveLength(1);
    expect(last?.approvals[0]).toMatchObject({ requestId: 'r1', kind: 'askUserQuestion' });
    expect(last?.approvals[0]?.questions).toEqual(QUESTIONS);
  });

  it('answerAskUserQuestion は updatedInput.answers を含む allow 応答を書き込み、承認カードを消す', async () => {
    const { session, written, states } = createSessionWithFakeProc();
    session.receive(canUseToolLine('r1'));
    await flushMicrotasks();

    session.answerAskUserQuestion('r1', { どちらにしますか: ['A'] });

    expect(states[states.length - 1]?.approvals).toHaveLength(0);
    const response = JSON.parse(written[written.length - 1]!.trim());
    expect(response).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: {
          behavior: 'allow',
          updatedInput: { questions: QUESTIONS, answers: { どちらにしますか: 'A' } },
        },
      },
    });
  });

  it('decide("accept") を askUserQuestion 種別に対して呼んでも常に拒否応答になる', async () => {
    const { session, written, states } = createSessionWithFakeProc();
    session.receive(canUseToolLine('r1'));
    await flushMicrotasks();

    session.decide('r1', 'accept');

    expect(states[states.length - 1]?.approvals).toHaveLength(0);
    const response = JSON.parse(written[written.length - 1]!.trim());
    expect(response.response.response).toEqual({
      behavior: 'deny',
      message: 'ユーザーが拒否しました',
    });
  });

  it('answerAskUserQuestion は該当requestIdが無ければ何もしない', () => {
    const { session, written } = createSessionWithFakeProc();
    session.answerAskUserQuestion('does-not-exist', { q: ['A'] });
    expect(written).toHaveLength(0);
  });
});
