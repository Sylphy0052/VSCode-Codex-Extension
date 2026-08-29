/**
 * 会話から相談を続ける導線（Issue #929 Consult）。
 *
 * 確かめるのは「作業中のAIへ何も送らない」こと、そして実行中の管理を1ターン目と同じ
 * `SecondOpinionRegistry` に通していること。相談相手のセッションは `AdvisorSession` 側の
 * テストで見ているので、ここは導線の配線だけを見る。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { __mock } from '../mocks/vscode';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { Logger } from '../../src/log';
import type { TaskSession } from '../../src/orchestrator/taskSession';
import { AdvisorSession, AdvisorSessionStore } from '../../src/secondOpinion/advisorSession';
import type { SecondOpinionCandidate } from '../../src/secondOpinion/candidates';
import type { SecondOpinionDisplay } from '../../src/secondOpinion/display';
import { SecondOpinionRegistry } from '../../src/secondOpinion/run';
import {
  continueSecondOpinion,
  endSecondOpinionConsult,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';

const CANDIDATE: SecondOpinionCandidate = {
  name: 'GPT-5.6 sol',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

const PARENT_ID = 'parent-1';

class FakeSession implements TaskSession {
  readonly sessionId = 'advisor-session';
  disposeCalls = 0;
  prompts: string[] = [];
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

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
  runLoop(plan: LoopPlan): void {
    this.prompts.push(plan.initialPrompt);
    this.finished?.('maxReached', { ...initialChatState, turnResultText: 'B案の弱点は…' });
  }
  async interrupt(): Promise<void> {}
  dispose(): void {
    this.disposeCalls += 1;
  }
}

/** 会話へ差し込まれたものと、ボタンの切り替えだけを記録する。 */
class FakePort implements SecondOpinionPanelPort {
  readonly parentSessionId = PARENT_ID;
  readonly cwd = undefined;
  notes: { id: string; display: SecondOpinionDisplay }[] = [];
  running: boolean[] = [];
  advisorItems: (string | undefined)[] = [];
  /** メインセッションへ送った回数。ここが0のままであることが受入基準（1ターンも送らない）。 */
  sentToMain = 0;

  lastAssistantResponse(): string {
    return '';
  }
  conversationTranscript(): string {
    return '';
  }
  note(id: string, display: SecondOpinionDisplay): void {
    this.notes.push({ id, display });
  }
  setRunning(running: boolean): void {
    this.running.push(running);
  }
  setAdvisorItem(itemId: string | undefined): void {
    this.advisorItems.push(itemId);
  }
  isParentDisposed(): boolean {
    return false;
  }
  isParentIdle(): boolean {
    return true;
  }
  onParentStateChanged(): { dispose(): void } {
    return { dispose: () => {} };
  }
  async generateRequestText(): Promise<never> {
    throw new Error('使わない');
  }
}

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  show: () => {},
  dispose: () => {},
} as unknown as Logger;

function seedAdvisor(store: AdvisorSessionStore, session: FakeSession): AdvisorSession {
  const advisor = new AdvisorSession({
    session,
    parentSessionId: PARENT_ID,
    candidate: CANDIDATE,
    timeoutMs: 60_000,
  });
  store.set(advisor);
  return advisor;
}

describe('continueSecondOpinion（Issue #929）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('入力した質問を相談相手だけへ送り、結果を会話へ残す', async () => {
    __mock.showInputBoxAnswer = 'B案の弱点は？';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    seedAdvisor(store, session);
    const port = new FakePort();
    const registry = new SecondOpinionRegistry();

    await continueSecondOpinion(port, registry, store, LOG);

    // 送り先は相談相手のセッションだけ（作業中のAIへは1ターンも送らない）
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain('B案の弱点は？');
    expect(port.sentToMain).toBe(0);
    // 実行中の表示と、結果の項目が同じidで2回書かれる
    expect(port.notes).toHaveLength(2);
    expect(port.notes[0]?.id).toBe(port.notes[1]?.id);
    expect(port.notes[1]?.display.status).toBe('completed');
    expect(port.running).toEqual([true, false]);
    // 終わった後は実行中フラグが残らない（次の相談を始められる）
    expect(registry.isRunning(PARENT_ID)).toBe(false);
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('入力をキャンセルしたら何も送らない', async () => {
    __mock.showInputBoxAnswer = undefined;
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    seedAdvisor(store, session);
    const port = new FakePort();
    const registry = new SecondOpinionRegistry();

    await continueSecondOpinion(port, registry, store, LOG);

    expect(session.prompts).toEqual([]);
    expect(port.notes).toEqual([]);
    expect(registry.isRunning(PARENT_ID)).toBe(false);
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('相談相手がいなければ知らせ、ボタンを消す', async () => {
    __mock.showInputBoxAnswer = '追加の質問';
    const store = new AdvisorSessionStore();
    const port = new FakePort();

    await continueSecondOpinion(port, new SecondOpinionRegistry(), store, LOG);

    expect(port.notes).toEqual([]);
    expect(port.advisorItems).toEqual([undefined]);
  });

  it('同じ会話で別の実行が走っている間は始めない', async () => {
    __mock.showInputBoxAnswer = '追加の質問';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    seedAdvisor(store, session);
    const port = new FakePort();
    const registry = new SecondOpinionRegistry();
    registry.begin(PARENT_ID, 'secondOpinion:other', () => {});

    await continueSecondOpinion(port, registry, store, LOG);

    expect(session.prompts).toEqual([]);
    expect(port.notes).toEqual([]);
    registry.end(PARENT_ID, 'secondOpinion:other');
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('相談を終了するとセッションを閉じる（二重に押しても投げない）', () => {
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    seedAdvisor(store, session);

    endSecondOpinionConsult(PARENT_ID, store, 'userEnded');
    endSecondOpinionConsult(PARENT_ID, store, 'userEnded');

    expect(session.disposeCalls).toBe(1);
  });
});
