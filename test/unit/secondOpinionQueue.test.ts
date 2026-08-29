/**
 * 親セッションの実行中にセカンドオピニオンを押したときの振る舞い（Issue #949）。
 *
 * ここで固定するのは境界である。依頼先・依頼文・追加資料までは押した時点で確定させ、
 * `openTaskSession`（会話の要約と本体）だけを親が暇になるまで遅らせる。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __mock } from '../mocks/vscode';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { Logger } from '../../src/log';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';
import { SecondOpinionRegistry } from '../../src/secondOpinion/run';
import type { SecondOpinionDisplay } from '../../src/secondOpinion/display';
import {
  startSecondOpinion,
  stopSecondOpinion,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';
import { isIdleChatState } from '../../src/view/secondOpinionParent';

class FakeSession implements TaskSession {
  readonly sessionId = 'queue-session';
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
  open(): void {}
  decideApproval(): void {}
  reveal(): void {}
  setApprovalHandler(): void {}
  onStateChanged(): void {}
  onFinished(handler: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finished = handler;
  }
  runLoop(_plan: LoopPlan): void {
    this.finished?.('maxReached', { ...initialChatState, turnResultText: '意見です' });
  }
  async interrupt(): Promise<void> {}
  dispose(): void {}
}

class RecordingHost implements TaskSessionHost {
  readonly inputs: TaskSessionInput[] = [];

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.inputs.push(input);
    return new FakeSession();
  }
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, show: () => {} };

const unusedGit: GitCommandRunner = {
  run: async () => {
    throw new Error('追加資料なしではgitを使わない');
  },
};

/** 親の状態を外から動かせるポート。会話へ残した項目も控える。 */
class FakePort implements SecondOpinionPanelPort {
  readonly parentSessionId = 'parent-a';
  readonly cwd = '/repo';
  readonly notes: Array<{ id: string; display: SecondOpinionDisplay }> = [];
  readonly running: boolean[] = [];
  private state: Pick<ChatState, 'busy' | 'queued'>;
  private readonly listeners: Array<() => void> = [];

  constructor(state: Pick<ChatState, 'busy' | 'queued'>) {
    this.state = state;
  }

  lastAssistantResponse(): string {
    return '';
  }

  async generateRequestText(): Promise<never> {
    throw new Error('既定モードでは質問文の組み立ては呼ばれない');
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
  isParentIdle(): boolean {
    return isIdleChatState(this.state);
  }
  onParentStateChanged(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  }

  /** 画面の状態が変わったことにして、購読している側へ知らせる。 */
  update(state: Pick<ChatState, 'busy' | 'queued'>): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  /** 最後に会話へ残った項目のid。停止操作の宛先になる。 */
  get lastNoteId(): string | undefined {
    return this.notes[this.notes.length - 1]?.id;
  }
}

const BUSY: Pick<ChatState, 'busy' | 'queued'> = { busy: true, queued: [] };
const QUEUED: Pick<ChatState, 'busy' | 'queued'> = {
  busy: false,
  queued: [{ text: '次はこれを頼む', attachments: [] }],
};
const IDLE: Pick<ChatState, 'busy' | 'queued'> = { busy: false, queued: [] };

/** 依頼先は候補1件で選ばせない。effortは1つ、資料は「追加資料なし」を選ぶ。 */
function answerQuickPicks(): void {
  __mock.showQuickPickAnswer = (items) => {
    const list = items as Array<{ artifactKind?: string }>;
    return list.find((item) => item.artifactKind === 'none');
  };
}

/**
 * 条件が成り立つまで待つ。
 *
 * `startSecondOpinion` は待機へ入るまでに選択UIと入力欄を挟む（それぞれawaitが挟まる）ため、
 * マイクロタスクを決め打ちで数回吐き出す形にすると、実装側にawaitが1つ増えただけで
 * 「まだ開いていない」を誤って通してしまう。実際に待機へ入ったことを見てから確かめる。
 */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`条件が成り立ちませんでした: ${label}`);
}

/** 順番待ちの項目が会話へ出るまで待つ（＝待機区間に入ったところ）。 */
async function waitForQueued(port: FakePort): Promise<void> {
  await waitUntil(() => port.notes.length > 0, '順番待ちの項目');
}

describe('実行中に押したセカンドオピニオンは待たせる（Issue #949）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.showInputBoxAnswer = '設計判断について意見がほしい';
    answerQuickPicks();
  });

  afterEach(() => {
    __mock.reset();
  });

  it('親が暇なら待たずにセッションを開く', async () => {
    const host = new RecordingHost();
    const port = new FakePort(IDLE);
    await startSecondOpinion(port, host, new SecondOpinionRegistry(), noopLog, unusedGit, () => [
      'high',
    ]);
    expect(host.inputs).toHaveLength(1);
    // 順番待ちの表示は出ていない
    expect(port.notes.map((note) => note.display.detail).join('\n')).not.toContain('順番待ち');
  });

  it('応答中は依頼を確定させたうえでセッションを開かない', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const started = startSecondOpinion(
      port,
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    await waitForQueued(port);
    // 依頼文の入力までは終わり、会話には順番待ちとして残っている
    expect(port.notes).toHaveLength(1);
    expect(port.notes[0]?.display.detail).toContain('順番待ち');
    expect(port.notes[0]?.display.text).toContain('設計判断について意見がほしい');
    // セッションは1つも開いていない
    expect(host.inputs).toHaveLength(0);
    port.update(IDLE);
    await started;
    expect(host.inputs).toHaveLength(1);
  });

  it('busyが落ちても待機列が残っている間は開かない', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const started = startSecondOpinion(
      port,
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    await waitForQueued(port);
    // ターンは終わったが、人が積んだ指示がこの後すぐ送られる状態
    port.update(QUEUED);
    // 解除されていれば、この間にセッションが開く
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.inputs).toHaveLength(0);
    port.update(IDLE);
    await started;
    expect(host.inputs).toHaveLength(1);
  });

  it('idleになった後に状態変化が続いても、開くセッションは1本だけ', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const started = startSecondOpinion(
      port,
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    await waitForQueued(port);
    port.update(IDLE);
    port.update(IDLE);
    port.update(IDLE);
    await started;
    // 会話は短いので要約セッションは開かない（本体だけ）
    expect(host.inputs).toHaveLength(1);
    // 待機の購読は残らない
    expect(port.listenerCount).toBe(0);
  });

  it('待機中に止めたらセッションを1本も開かずに終わる', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const registry = new SecondOpinionRegistry();
    const started = startSecondOpinion(port, host, registry, noopLog, unusedGit, () => ['high']);
    await waitForQueued(port);
    const runId = port.lastNoteId;
    expect(runId).toBeDefined();
    stopSecondOpinion('parent-a', registry, runId as string, noopLog);
    await started;
    expect(host.inputs).toHaveLength(0);
    expect(port.notes[port.notes.length - 1]?.display.status).toBe('cancelled');
    expect(port.listenerCount).toBe(0);
    // 実行の登録は解かれ、次を起動できる
    expect(registry.isRunning('parent-a')).toBe(false);
  });

  it('止めた後にidleになってもセッションを開かない', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const registry = new SecondOpinionRegistry();
    const started = startSecondOpinion(port, host, registry, noopLog, unusedGit, () => ['high']);
    await waitForQueued(port);
    stopSecondOpinion('parent-a', registry, port.lastNoteId as string, noopLog);
    port.update(IDLE);
    await started;
    expect(host.inputs).toHaveLength(0);
  });

  it('待機中の2件目は現行どおり拒否する', async () => {
    const host = new RecordingHost();
    const port = new FakePort(BUSY);
    const registry = new SecondOpinionRegistry();
    const started = startSecondOpinion(port, host, registry, noopLog, unusedGit, () => ['high']);
    await waitForQueued(port);
    expect(registry.isRunning('parent-a')).toBe(true);
    const second = new FakePort(BUSY);
    await startSecondOpinion(second, host, registry, noopLog, unusedGit, () => ['high']);
    // 2件目は会話へ何も残さず、セッションも開かない
    expect(second.notes).toHaveLength(0);
    expect(host.inputs).toHaveLength(0);
    port.update(IDLE);
    await started;
    expect(host.inputs).toHaveLength(1);
  });
});
