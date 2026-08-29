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
import type { HandoffDraft } from '../../src/secondOpinion/handoff';
import {
  approveSecondOpinionHandoff,
  continueSecondOpinion,
  draftSecondOpinionHandoff,
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
  /** `runLoop()` が返す本文。 */
  response = 'B案の弱点は…';
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
    this.finished?.('maxReached', { ...initialChatState, turnResultText: this.response });
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
  drafts: (HandoffDraft | undefined)[] = [];
  sent: string[] = [];
  /** 設定すると送信が失敗する（送れなかったときの後始末を試す）。 */
  sendFailure: Error | undefined;
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
  setHandoffDraft(draft: HandoffDraft | undefined): void {
    this.drafts.push(draft);
  }
  async sendApprovedInstruction(text: string): Promise<'sent' | 'queued'> {
    if (this.sendFailure !== undefined) {
      throw this.sendFailure;
    }
    this.sent.push(text);
    return 'sent';
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

describe('draftSecondOpinionHandoff（Issue #929 Handoff）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('読めた下書きを会話へ出し、承認できる状態へ進める', async () => {
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    session.response = [
      '```json',
      JSON.stringify({ userSummary: 'B案を勧める', mainInstruction: 'B案で実装すること' }),
      '```',
    ].join('\n');
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();

    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);

    // 送ったのは相談相手だけ。作業中のAIへは1ターンも送らない
    expect(session.prompts).toHaveLength(1);
    expect(port.sentToMain).toBe(0);
    expect(advisor.currentState()).toBe('handoffDrafted');
    expect(port.drafts).toEqual([
      { userSummary: 'B案を勧める', mainInstruction: 'B案で実装すること' },
    ]);
    expect(port.notes[1]?.display.status).toBe('completed');
    // 表示には「まだ送っていない」と出す（下書きを送信済みと読み違えさせない）
    expect(port.notes[1]?.display.detail).toContain('承認するまで送りません');
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('形式を読み取れない応答は下書きにしない', async () => {
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    session.response = 'B案がよいと思います。';
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();

    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);

    // 読めなければ承認へ進めない（承認できるのは読めた下書きだけ）
    expect(advisor.currentState()).toBe('consulting');
    expect(port.drafts).toEqual([]);
    expect(port.notes[1]?.display.status).toBe('failed');
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('追加で相談すると承認待ちの下書きを捨てる', async () => {
    __mock.showInputBoxAnswer = 'やはりC案は？';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    session.response = [
      '```json',
      JSON.stringify({ userSummary: '要約', mainInstruction: '指示' }),
      '```',
    ].join('\n');
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();
    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);
    expect(advisor.currentState()).toBe('handoffDrafted');

    await continueSecondOpinion(port, new SecondOpinionRegistry(), store, LOG);

    expect(advisor.currentState()).toBe('consulting');
    expect(port.drafts.at(-1)).toBeUndefined();
    store.closeFor(PARENT_ID, 'userEnded');
  });
});

describe('approveSecondOpinionHandoff（Issue #929 Human Gate）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  /** 下書きができている状態まで進める。 */
  async function seedDraft(
    store: AdvisorSessionStore,
    port: FakePort,
    session: FakeSession,
  ): Promise<HandoffDraft> {
    session.response = [
      '```json',
      JSON.stringify({ userSummary: '要約', mainInstruction: 'B案で実装すること' }),
      '```',
    ].join('\n');
    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);
    const draft = port.drafts.at(-1);
    if (draft === undefined) {
      throw new Error('下書きができていない');
    }
    return draft;
  }

  it('承認したときにだけ送り、出所を頭に付ける', async () => {
    __mock.showInformationMessageAnswer = '送る';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();
    const draft = await seedDraft(store, port, session);

    await approveSecondOpinionHandoff(port, store, draft, LOG);

    expect(port.sent).toHaveLength(1);
    const sent = port.sent[0] ?? '';
    // 出所の断り書きは送信時に必ず付く（下書きからは消せない）
    expect(sent).toContain('独立したセカンドオピニオン');
    expect(sent).toContain('gpt-5.6-sol / high');
    expect(sent.endsWith('B案で実装すること')).toBe(true);
    // 送った後は相談を閉じる
    expect(advisor.closedReason()).toBe('instructionSent');
    expect(session.disposeCalls).toBe(1);
  });

  it('確認で「やめる」を選んだら何も送らない', async () => {
    __mock.showInformationMessageAnswer = undefined;
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();
    const draft = await seedDraft(store, port, session);

    await approveSecondOpinionHandoff(port, store, draft, LOG);

    expect(port.sent).toEqual([]);
    // 承認していないので相談は続けられる
    expect(advisor.closedReason()).toBeUndefined();
    expect(advisor.currentState()).toBe('handoffDrafted');
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('下書きが無ければ送らない', async () => {
    __mock.showInformationMessageAnswer = '送る';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    seedAdvisor(store, session);
    const port = new FakePort();

    await approveSecondOpinionHandoff(port, store, undefined, LOG);

    expect(port.sent).toEqual([]);
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('追加の相談で下書きが古くなっていたら送らない', async () => {
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();
    const draft = await seedDraft(store, port, session);
    // 追加で相談すると `consulting` へ戻る（相談の結論と下書きがずれる）
    __mock.showInputBoxAnswer = 'やはりC案は？';
    await continueSecondOpinion(port, new SecondOpinionRegistry(), store, LOG);
    expect(advisor.currentState()).toBe('consulting');

    __mock.showInformationMessageAnswer = '送る';
    await approveSecondOpinionHandoff(port, store, draft, LOG);

    expect(port.sent).toEqual([]);
    expect(advisor.closedReason()).toBeUndefined();
    store.closeFor(PARENT_ID, 'userEnded');
  });

  it('送信に失敗したら相談を閉じない（もう一度承認できる）', async () => {
    __mock.showInformationMessageAnswer = '送る';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    const advisor = seedAdvisor(store, session);
    const port = new FakePort();
    port.sendFailure = new Error('セッションが応答しません');
    const draft = await seedDraft(store, port, session);

    await approveSecondOpinionHandoff(port, store, draft, LOG);

    expect(port.sent).toEqual([]);
    expect(advisor.closedReason()).toBeUndefined();
    store.closeFor(PARENT_ID, 'userEnded');
  });
});

describe('承認前の編集（Issue #929）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('エディタで開くのは指示文だけで、直した本文が送られる', async () => {
    __mock.showInformationMessageAnswer = '送る';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    session.response = [
      '```json',
      JSON.stringify({ userSummary: '利用者向けの要約', mainInstruction: 'B案で実装すること' }),
      '```',
    ].join('\n');
    seedAdvisor(store, session);
    const port = new FakePort();
    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);
    const draft = port.drafts.at(-1);
    // 人が本文を直した状況を作る
    __mock.untitledDocumentEdit = 'B案で実装すること（ただしAPIは変えない）';

    await approveSecondOpinionHandoff(port, store, draft, LOG);

    // 開くのは指示文だけ。利用者向けの要約は送信の対象ではないので混ぜない
    expect(__mock.untitledDocumentContents).toEqual(['B案で実装すること']);
    expect(port.sent[0]?.endsWith('B案で実装すること（ただしAPIは変えない）')).toBe(true);
  });

  it('本文を空にして承認しても送らない', async () => {
    __mock.showInformationMessageAnswer = '送る';
    const store = new AdvisorSessionStore();
    const session = new FakeSession();
    const advisor = seedAdvisor(store, session);
    session.response = [
      '```json',
      JSON.stringify({ userSummary: '要約', mainInstruction: '指示' }),
      '```',
    ].join('\n');
    const port = new FakePort();
    await draftSecondOpinionHandoff(port, new SecondOpinionRegistry(), store, LOG);
    __mock.untitledDocumentEdit = '   \n  ';

    await approveSecondOpinionHandoff(port, store, port.drafts.at(-1), LOG);

    expect(port.sent).toEqual([]);
    expect(advisor.closedReason()).toBeUndefined();
    store.closeFor(PARENT_ID, 'userEnded');
  });
});
