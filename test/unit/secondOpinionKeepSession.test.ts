/**
 * 相談を続けるためにセッションを残す経路の所有権（Issue #929）。
 *
 * `keepSession` を指定すると `runSingleTurnTask` は閉じなくなるため、閉じる責任は
 * `runSecondOpinion` と、そこから受け取った呼び出し側へ移る。渡せなかったセッションが
 * 誰にも閉じられないまま残らないことをここで固める。
 */

import { describe, expect, it, vi } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import type { SecondOpinionCandidate } from '../../src/secondOpinion/candidates';
import { runSecondOpinion, type SecondOpinionRequest } from '../../src/secondOpinion/run';

const CANDIDATE: SecondOpinionCandidate = {
  name: 'GPT-5.6 sol',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

class FakeSession implements TaskSession {
  readonly sessionId = 'keep-session';
  disposeCalls = 0;
  interruptCalls = 0;
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(
    private readonly behavior: { hold?: boolean; fail?: boolean; response?: string } = {},
  ) {}

  send(): void {}
  setPromptTransform(): void {}
  onApprovalResolved(): void {}
  pauseLoop(): void {}
  resumeLoop(): void {}
  async checkMessagingToolVisible(): Promise<boolean> {
    return true;
  }
  stopLoop(): boolean {
    return true;
  }
  decideApproval(): void {}
  reveal(): void {}
  open(): void {}
  setApprovalHandler(): void {}
  onStateChanged(): void {}
  onFinished(handler: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finished = handler;
  }
  runLoop(_plan: LoopPlan): void {
    if (this.behavior.hold === true) {
      return;
    }
    if (this.behavior.fail === true) {
      this.finished?.('failed', initialChatState);
      return;
    }
    this.finished?.('maxReached', {
      ...initialChatState,
      turnResultText: this.behavior.response ?? '回答',
    });
  }
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeHost implements TaskSessionHost {
  sessions: FakeSession[] = [];
  constructor(private readonly behavior: ConstructorParameters<typeof FakeSession>[0] = {}) {}
  async openTaskSession(_input: TaskSessionInput): Promise<TaskSession> {
    const session = new FakeSession(this.behavior);
    this.sessions.push(session);
    return session;
  }
}

function requestFor(overrides: Partial<SecondOpinionRequest> = {}): SecondOpinionRequest {
  return {
    cwd: '/repo',
    candidate: CANDIDATE,
    request: 'この方針でよいか',
    artifact: { kind: 'none' },
    headless: true,
    ...overrides,
  };
}

describe('runSecondOpinion のセッション保持（Issue #929）', () => {
  it('既定ではこれまでどおり1ターンで閉じる', async () => {
    const host = new FakeHost();
    const result = await runSecondOpinion(host, requestFor());
    expect(result).toEqual({ ok: true, response: '回答' });
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('keepSession を指定すると閉じずにセッションを返す', async () => {
    const host = new FakeHost();
    const result = await runSecondOpinion(host, requestFor({ keepSession: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.session).toBe(host.sessions[0]);
    expect(host.sessions[0]?.disposeCalls).toBe(0);
    result.session?.dispose();
  });

  it('応答が空なら保持せず閉じる', async () => {
    const host = new FakeHost({ response: '   ' });
    const result = await runSecondOpinion(host, requestFor({ keepSession: true }));
    expect(result).toEqual({ ok: false, reason: 'セカンドオピニオンの応答が空でした' });
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('ターンが失敗したら保持せず閉じる', async () => {
    const host = new FakeHost({ fail: true });
    const result = await runSecondOpinion(host, requestFor({ keepSession: true }));
    expect(result.ok).toBe(false);
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('打ち切られたセッションは保持しない（どこまで進んだか分からないまま次を重ねない）', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost({ hold: true });
      const pending = runSecondOpinion(host, requestFor({ keepSession: true, timeoutMs: 1_000 }));
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await pending;
      // 途中の回答が無いので失敗として返る
      expect(result.ok).toBe(false);
      expect(host.sessions[0]?.interruptCalls).toBe(1);
      expect(host.sessions[0]?.disposeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('利用者が止めた場合も保持しない', async () => {
    const host = new FakeHost({ hold: true });
    const controller = new AbortController();
    const pending = runSecondOpinion(
      host,
      requestFor({ keepSession: true, signal: controller.signal }),
    );
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, cancelledByUser: true });
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });
});
