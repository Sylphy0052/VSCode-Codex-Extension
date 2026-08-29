/**
 * 保持したAdvisorセッションの状態遷移と後始末（Issue #929）。
 *
 * 1ターンで閉じていたセカンドオピニオンを、回答の後も保持する形へ変える。閉じ忘れると
 * 常駐app-server側のスレッドが残るため、閉じる経路と、閉じた後の操作の扱いをここで固める。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { TaskSession } from '../../src/orchestrator/taskSession';
import {
  AdvisorSession,
  AdvisorSessionStore,
  DEFAULT_ADVISOR_IDLE_TIMEOUT_MS,
  type AdvisorMaterialWriter,
} from '../../src/secondOpinion/advisorSession';
import { materialUpdateAckToken } from '../../src/secondOpinion/prompt';
import type { ReviewBundle } from '../../src/secondOpinion/reviewBundle';
import type { SecondOpinionCandidate } from '../../src/secondOpinion/candidates';

const CANDIDATE: SecondOpinionCandidate = {
  name: 'GPT-5.6 sol',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

/**
 * `awaitSingleTurn` が使う口だけを持つ最小のフェイク。
 *
 * `runLoop()` で応答を即返す既定と、`hold: true` で応答を返さない（打ち切りを試す）
 * 動きを切り替える。
 */
class FakeSession implements TaskSession {
  readonly sessionId = 'advisor-session';
  disposeCalls = 0;
  interruptCalls = 0;
  prompts: string[] = [];
  /** 応答を返さずに待たせる。打ち切りの経路を試すために使う。 */
  hold = false;
  /** `runLoop()` が返す本文。 */
  response = '回答';
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

function createAdvisor(
  session: FakeSession,
  overrides: { idleTimeoutMs?: number; onClosed?: () => void } = {},
): AdvisorSession {
  return new AdvisorSession({
    session,
    parentSessionId: 'parent-1',
    candidate: CANDIDATE,
    timeoutMs: 60_000,
    ...(overrides.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: overrides.idleTimeoutMs }),
    ...(overrides.onClosed === undefined ? {} : { onClosed: overrides.onClosed }),
  });
}

describe('AdvisorSession の相談（Issue #929 Consult）', () => {
  it('追加の質問を同じセッションへ送り、回答を返す', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    const result = await advisor.ask('B案の懸念は？');
    expect(result).toEqual({ ok: true, response: '回答' });
    expect(session.prompts).toEqual(['B案の懸念は？']);
    // 相談を続けている間はセッションを閉じない（次の質問へ繋げるため）
    expect(session.disposeCalls).toBe(0);
    advisor.close('userEnded');
  });

  it('走っているターンがある間は次の質問を受け付けない', async () => {
    const session = new FakeSession();
    session.hold = true;
    const advisor = createAdvisor(session);
    const pending = advisor.ask('1つ目');
    const second = await advisor.ask('2つ目');
    expect(second).toEqual({
      ok: false,
      kind: 'busy',
      reason: 'この相談では別の問い合わせが実行中です',
    });
    // 送られたのは1本だけ（同じスレッドへ2本のターンを重ねない）
    expect(session.prompts).toEqual(['1つ目']);
    advisor.close('userEnded');
    await expect(pending).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
  });

  it('閉じた後の質問は closed を返す（黙って無視しない）', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    advisor.close('userEnded');
    const result = await advisor.ask('追加の質問');
    expect(result).toEqual({
      ok: false,
      kind: 'closed',
      reason: 'この相談は既に終了しています',
    });
    expect(session.prompts).toEqual([]);
  });

  it('追加の相談をすると下書きが無効になり consulting へ戻る', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    advisor.markHandoffDrafted();
    expect(advisor.currentState()).toBe('handoffDrafted');
    await advisor.ask('やはりC案は？');
    expect(advisor.currentState()).toBe('consulting');
    advisor.close('userEnded');
  });
});

describe('AdvisorSession の状態遷移（Issue #929）', () => {
  it('承認できるのは handoffDrafted からだけ', () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    expect(advisor.markApproved(1)).toBe(false);
    expect(advisor.currentState()).toBe('consulting');
    const revision = advisor.markHandoffDrafted();
    expect(revision).toBe(1);
    expect(advisor.markApproved(revision ?? 0)).toBe(true);
    expect(advisor.currentState()).toBe('approved');
    advisor.close('instructionSent');
    expect(advisor.markApproved(revision ?? 0)).toBe(false);
    expect(advisor.currentState()).toBe('closed');
  });

  it('古い世代の下書きは承認できない', () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    const first = advisor.markHandoffDrafted();
    // 承認の画面を開いたまま、新しい下書きを作った状況
    const second = advisor.markHandoffDrafted();
    expect(second).toBe((first ?? 0) + 1);
    // 状態は handoffDrafted のままだが、古い方は通らない
    expect(advisor.currentState()).toBe('handoffDrafted');
    expect(advisor.markApproved(first ?? 0)).toBe(false);
    expect(advisor.markApproved(second ?? 0)).toBe(true);
    advisor.close('instructionSent');
  });

  it('送信を待っている間は追加の相談を受け付けない', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    const revision = advisor.markHandoffDrafted();
    expect(advisor.markApproved(revision ?? 0)).toBe(true);
    // `approved` でいるのは送信待ちの間だけ。ここで `consulting` へ戻されると、
    // 送信に失敗したときの `revertApproval()` が効かなくなる
    const result = await advisor.ask('やはりC案は？');
    expect(result).toEqual({
      ok: false,
      kind: 'busy',
      reason: '承認した指示を送信中です',
    });
    expect(advisor.currentState()).toBe('approved');
    expect(session.prompts).toEqual([]);
    advisor.close('instructionSent');
  });

  it('閉じた後は下書きの記録も受け付けない', () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    advisor.close('userEnded');
    advisor.markHandoffDrafted();
    expect(advisor.currentState()).toBe('closed');
  });
});

describe('AdvisorSession の後始末（Issue #929）', () => {
  it('close は冪等で、dispose は1回だけ呼ぶ', () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    advisor.close('userEnded');
    advisor.close('parentDisposed');
    expect(session.disposeCalls).toBe(1);
    // 最初に閉じた理由が残る（後から来た理由で上書きしない）
    expect(advisor.closedReason()).toBe('userEnded');
  });

  it('走っているターンは close で打ち切られる', async () => {
    const session = new FakeSession();
    session.hold = true;
    const advisor = createAdvisor(session);
    const pending = advisor.ask('長考する質問');
    advisor.close('parentDisposed');
    const result = await pending;
    expect(result).toMatchObject({ ok: false, kind: 'cancelled' });
    // `dispose()` は進行中のターンを止めないため、打ち切りを別に要求する（Issue #926 D）
    expect(session.interruptCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });

  it('dispose が投げても閉じた状態になり、onClosed が呼ばれる', () => {
    const session = new FakeSession();
    session.dispose = () => {
      throw new Error('dispose が失敗しました');
    };
    const closed: string[] = [];
    const advisor = createAdvisor(session, { onClosed: () => closed.push('closed') });
    expect(() => advisor.close('userEnded')).not.toThrow();
    expect(advisor.currentState()).toBe('closed');
    expect(closed).toEqual(['closed']);
  });
});

describe('AdvisorSession の無操作上限（Issue #929）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('無操作が続くと閉じる', () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session, { idleTimeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(advisor.currentState()).toBe('closed');
    expect(advisor.closedReason()).toBe('idleTimeout');
    expect(session.disposeCalls).toBe(1);
  });

  it('質問のたびに上限が延びる', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session, { idleTimeoutMs: 1_000 });
    vi.advanceTimersByTime(900);
    await advisor.ask('追加の質問');
    vi.advanceTimersByTime(900);
    expect(advisor.currentState()).toBe('consulting');
    vi.advanceTimersByTime(200);
    expect(advisor.currentState()).toBe('closed');
  });

  it('既定の上限は30分', () => {
    expect(DEFAULT_ADVISOR_IDLE_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe('AdvisorSessionStore（Issue #929）', () => {
  it('同じ親で新しく持たせると古いセッションを閉じる', () => {
    const store = new AdvisorSessionStore();
    const oldSession = new FakeSession();
    const newSession = new FakeSession();
    const older = createAdvisor(oldSession, { onClosed: () => store.remove(older) });
    const newer = createAdvisor(newSession, { onClosed: () => store.remove(newer) });
    store.set(older);
    store.set(newer);
    expect(oldSession.disposeCalls).toBe(1);
    expect(older.closedReason()).toBe('replaced');
    // 古いセッションの後始末が、いま登録した新しいセッションを消していないこと
    expect(store.get('parent-1')).toBe(newer);
  });

  it('remove は同じインスタンスのときだけ外す', () => {
    const store = new AdvisorSessionStore();
    const kept = createAdvisor(new FakeSession());
    const other = createAdvisor(new FakeSession());
    store.set(kept);
    store.remove(other);
    expect(store.get('parent-1')).toBe(kept);
    store.remove(kept);
    expect(store.get('parent-1')).toBeUndefined();
    kept.close('userEnded');
    other.close('userEnded');
  });

  it('closeAll で保持しているセッションを全部閉じる', () => {
    const store = new AdvisorSessionStore();
    const first = new FakeSession();
    const second = new FakeSession();
    store.set(createAdvisor(first));
    store.set(
      new AdvisorSession({
        session: second,
        parentSessionId: 'parent-2',
        candidate: CANDIDATE,
        timeoutMs: 60_000,
      }),
    );
    store.closeAll('shutdown');
    expect(first.disposeCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
    expect(store.get('parent-1')).toBeUndefined();
    expect(store.get('parent-2')).toBeUndefined();
  });
});

/**
 * 材料を書き出したことにするフェイク。実際のファイルは触らない。
 *
 * `hold` の間は書き出しを終わらせず、書き出し中に別の操作が来る経路を試せるようにする。
 */
class FakeMaterialWriter {
  revisions: number[] = [];
  hold = false;
  failWith: string | undefined;
  private release: (() => void) | undefined;

  readonly write: AdvisorMaterialWriter = async (_bundleDir, revision) => {
    this.revisions.push(revision);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.failWith !== undefined) {
      throw new Error(this.failWith);
    }
    return `updates/${revision}`;
  };

  /** `hold` で止めていた書き出しを終わらせる。 */
  finish(): void {
    this.release?.();
    this.release = undefined;
  }
}

function createFakeBundle(): ReviewBundle & { disposeCalls: number } {
  const bundle = {
    dir: '/fake/review-bundle-x',
    disposeCalls: 0,
    async dispose(): Promise<void> {
      bundle.disposeCalls += 1;
    },
  };
  return bundle;
}

function createAdvisorWithMaterial(
  session: FakeSession,
  writer: FakeMaterialWriter,
  bundle: ReviewBundle,
): AdvisorSession {
  return new AdvisorSession({
    session,
    parentSessionId: 'parent-1',
    candidate: CANDIDATE,
    timeoutMs: 60_000,
    bundle,
    writeMaterial: writer.write,
  });
}

describe('AdvisorSession の材料の更新（Issue #975）', () => {
  it('更新の合図が返れば世代が進み、以後のターンの先頭へ正本が付く', async () => {
    const session = new FakeSession();
    session.response = materialUpdateAckToken(2);
    const writer = new FakeMaterialWriter();
    const bundle = createFakeBundle();
    const advisor = createAdvisorWithMaterial(session, writer, bundle);

    const result = await advisor.updateMaterial();

    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(advisor.currentMaterialRevision()).toBe(2);
    expect(writer.revisions).toEqual([2]);
    // 更新の通知そのものには正本のヘッダを付けない（その本文が正本を伝えている）
    expect(session.prompts[0]?.startsWith('現在の正本は')).toBe(false);
    expect(session.prompts[0]).toContain('updates/2');

    session.response = '回答';
    await advisor.ask('直したので見てほしい');
    // 更新の通知は会話が伸びると履歴の奥へ流れるため、以後は毎ターンの先頭で正本を名指しする
    expect(session.prompts[1]).toContain('現在の正本は第2世代');
    advisor.close('userEnded');
  });

  it('合図が返らなければ世代を進めず、同じ番号へ書き直さない', async () => {
    const session = new FakeSession();
    session.response = '了解しました';
    const writer = new FakeMaterialWriter();
    const advisor = createAdvisorWithMaterial(session, writer, createFakeBundle());

    const first = await advisor.updateMaterial();
    expect(first).toMatchObject({ ok: false, kind: 'failed' });
    expect(advisor.currentMaterialRevision()).toBe(1);

    // 番号は使い切り。Advisorが既に読んだかもしれないパスへ別の内容を上書きしない
    session.response = materialUpdateAckToken(3);
    const second = await advisor.updateMaterial();
    expect(second).toMatchObject({ ok: true, revision: 3 });
    expect(writer.revisions).toEqual([2, 3]);
    advisor.close('userEnded');
  });

  it('書き出している間に閉じられたら通知せず、材料は書き出しの完了後に消す', async () => {
    const session = new FakeSession();
    session.response = materialUpdateAckToken(2);
    const writer = new FakeMaterialWriter();
    writer.hold = true;
    const bundle = createFakeBundle();
    const advisor = createAdvisorWithMaterial(session, writer, bundle);

    const pending = advisor.updateMaterial();
    advisor.close('userEnded');
    // 書き出しの最中に消すと、走っている書き出しがディレクトリを作り直してしまう
    expect(bundle.disposeCalls).toBe(0);

    writer.finish();
    await expect(pending).resolves.toMatchObject({ ok: false, kind: 'closed' });
    // 閉じた相談へ通知は送らない
    expect(session.prompts).toEqual([]);
    expect(bundle.disposeCalls).toBe(1);
  });

  it('材料を書き出せない相談では unsupported を返す', async () => {
    const session = new FakeSession();
    const advisor = createAdvisor(session);
    expect(advisor.canUpdateMaterial()).toBe(false);
    const result = await advisor.updateMaterial();
    expect(result).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(session.prompts).toEqual([]);
    advisor.close('userEnded');
  });

  it('書き出しに失敗したら通知を送らず、世代も進めない', async () => {
    const session = new FakeSession();
    const writer = new FakeMaterialWriter();
    writer.failWith = 'ディスクがいっぱいです';
    const advisor = createAdvisorWithMaterial(session, writer, createFakeBundle());

    const result = await advisor.updateMaterial();

    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect(session.prompts).toEqual([]);
    expect(advisor.currentMaterialRevision()).toBe(1);
    advisor.close('userEnded');
  });
});
