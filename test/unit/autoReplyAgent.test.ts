/**
 * 自動返信モード（Issue #1353）の「返信役」セッション管理（`src/chat/autoReplyAgent.ts`）。
 *
 * `AdvisorSession`のテスト（`test/unit/secondOpinionAdvisorSession.test.ts`）と同じ
 * `FakeSession`（`awaitSingleTurn`が使う口だけを持つ最小のフェイク）を使い、`AutoReplyAgent`
 * 固有の性質（初回だけセッションを開く・周をまたいで保持する・`close()`の冪等性・
 * `autoReplyAgentCloseReasonFor`のマッピング）を確認する。
 */

import { describe, expect, it, vi } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { TaskSession, TaskSessionHost, TaskSessionInput } from '../../src/orchestrator/taskSession';
import {
  AutoReplyAgent,
  autoReplyAgentCloseReasonFor,
  type AutoReplyAgentCloseReason,
} from '../../src/chat/autoReplyAgent';
import type { AutoReplyStopReason } from '../../src/chat/autoReply';

/** `secondOpinionAdvisorSession.test.ts`と同じ最小フェイク。応答を即返す既定と、待たせる`hold`。 */
class FakeSession implements TaskSession {
  readonly sessionId = 'auto-reply-session';
  disposeCalls = 0;
  interruptCalls = 0;
  prompts: string[] = [];
  hold = false;
  response = '続けてください';
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  send(): void {}
  setPromptTransform(): void {}
  onApprovalResolved(): void {}
  compact(): Promise<void> {
    return Promise.resolve();
  }
  note(): void {}
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
  runLoop(plan: LoopPlan): void {
    this.prompts.push(plan.initialPrompt);
    if (this.hold) {
      return;
    }
    this.finished?.('maxReached', { ...initialChatState, turnResultText: this.response });
  }
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeHost implements TaskSessionHost {
  openCalls: TaskSessionInput[] = [];
  session = new FakeSession();

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.openCalls.push(input);
    return this.session;
  }
}

function createAgent(host: FakeHost, overrides: { idleTimeoutMs?: number } = {}): AutoReplyAgent {
  return new AutoReplyAgent({
    host,
    cwd: '/workspace',
    model: 'auto',
    timeoutMs: 60_000,
    originalRequest: 'ログイン機能を実装して',
    ...(overrides.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: overrides.idleTimeoutMs }),
  });
}

describe('AutoReplyAgent の初回起動と往復', () => {
  it('初回はセッションを開き、役割文と材料をまとめて送る', async () => {
    const host = new FakeHost();
    const agent = createAgent(host);
    const result = await agent.reply('実装が終わりました');
    expect(result).toEqual({ ok: true, response: '続けてください' });
    expect(host.openCalls).toHaveLength(1);
    expect(host.session.prompts).toHaveLength(1);
    expect(host.session.prompts[0]).toContain('ログイン機能を実装して');
    expect(host.session.prompts[0]).toContain('実装が終わりました');
    // 読み取り専用・承認拒否で開く（Issue本文の緩和策）
    expect(host.openCalls[0]?.sandbox).toBe('read-only');
    expect(host.openCalls[0]?.config.approvalMode).toBe('never');
    // 周をまたいで保持するため、この時点ではまだ閉じない
    expect(host.session.disposeCalls).toBe(0);
    agent.close('userDisabled');
  });

  it('2回目以降は同じセッションへターン分の材料だけを送る', async () => {
    const host = new FakeHost();
    const agent = createAgent(host);
    await agent.reply('1周目の出力');
    await agent.reply('2周目の出力');
    expect(host.openCalls).toHaveLength(1);
    expect(host.session.prompts).toHaveLength(2);
    expect(host.session.prompts[1]).toContain('2周目の出力');
    expect(host.session.prompts[1]).not.toContain('ログイン機能を実装して');
    agent.close('userDisabled');
  });

  it('走っているターンがある間は次の問い合わせを受け付けない', async () => {
    const host = new FakeHost();
    host.session.hold = true;
    const agent = createAgent(host);
    const pending = agent.reply('1つ目');
    const second = await agent.reply('2つ目');
    expect(second).toEqual({
      ok: false,
      kind: 'failed',
      reason: '返信役は別の問い合わせを実行中です',
    });
    agent.close('userDisabled');
    await pending;
  });

  it('閉じた後の問い合わせはfailedを返す', async () => {
    const host = new FakeHost();
    const agent = createAgent(host);
    agent.close('userDisabled');
    const result = await agent.reply('もう遅い');
    expect(result).toEqual({
      ok: false,
      kind: 'failed',
      reason: 'この返信役は既に終了しています',
    });
    expect(host.openCalls).toHaveLength(0);
  });

  it('応答が空文字ならfailedを返す', async () => {
    const host = new FakeHost();
    host.session.response = '   ';
    const agent = createAgent(host);
    const result = await agent.reply('出力');
    expect(result).toEqual({ ok: false, kind: 'failed', reason: '返信役の応答が空でした' });
    agent.close('userDisabled');
  });
});

describe('AutoReplyAgent の後始末', () => {
  it('close()は冪等で、最初の理由だけが残る', async () => {
    const host = new FakeHost();
    const agent = createAgent(host);
    await agent.reply('出力');
    agent.close('idleTimeout');
    agent.close('tabClosed');
    expect(agent.isClosed()).toBe(true);
    expect(agent.closedReason()).toBe('idleTimeout');
    // 2回目のclose()ではdispose()を呼び直さない
    expect(host.session.disposeCalls).toBe(1);
  });

  it('close()はセッションを破棄する', async () => {
    const host = new FakeHost();
    const agent = createAgent(host);
    await agent.reply('出力');
    agent.close('userDisabled');
    expect(host.session.disposeCalls).toBe(1);
  });

  it('無操作が続くとidleTimeoutで自動的に閉じる', () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const agent = createAgent(host, { idleTimeoutMs: 1000 });
      expect(agent.isClosed()).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(agent.isClosed()).toBe(true);
      expect(agent.closedReason()).toBe('idleTimeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('onClosedコールバックは閉じたときに1度だけ呼ばれる', () => {
    const host = new FakeHost();
    const onClosed = vi.fn();
    const agent = new AutoReplyAgent({
      host,
      cwd: '/workspace',
      model: 'auto',
      timeoutMs: 60_000,
      originalRequest: '依頼文',
      onClosed,
    });
    agent.close('stopMarker');
    agent.close('failed');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(agent, 'stopMarker');
  });
});

describe('autoReplyAgentCloseReasonFor', () => {
  it('直接対応する理由はそのまま写す', () => {
    expect(autoReplyAgentCloseReasonFor('stopMarker')).toBe('stopMarker');
    expect(autoReplyAgentCloseReasonFor('idleTimeout')).toBe('idleTimeout');
    expect(autoReplyAgentCloseReasonFor('tabClosed')).toBe('tabClosed');
  });

  it('返信役自体の失敗はfailedへまとめる', () => {
    expect(autoReplyAgentCloseReasonFor('advisorFailed')).toBe('failed');
  });

  it('それ以外（回数上限・停滞・利用者操作・ループ開始）はuserDisabledへまとめる', () => {
    const rest: AutoReplyStopReason[] = ['maxTurns', 'stalled', 'turnFailed', 'userAction', 'loopStarted'];
    for (const reason of rest) {
      const closeReason: AutoReplyAgentCloseReason = autoReplyAgentCloseReasonFor(reason);
      expect(closeReason).toBe('userDisabled');
    }
  });
});
