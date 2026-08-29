/**
 * セカンドオピニオンと単発ターンの後始末（Issue #926 B / C）。
 *
 * どちらも「例外が出た経路で後始末が漏れ、次回以降が壊れる」という形の穴で、正常系の
 * テストでは踏めない。ここでは投げるスタブを渡して、`registry` にidが残らないこと・
 * セッションが必ず `dispose()` されること・タイマーが残らないことを固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __mock } from '../mocks/vscode';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type { Logger } from '../../src/log';
import { runSingleTurnTask } from '../../src/orchestrator/planner';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import { SecondOpinionRegistry } from '../../src/secondOpinion/run';
import {
  startSecondOpinion,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';
import type { GitCommandRunner } from '../../src/orchestrator/worktree';

const SAFE_INPUT: TaskSessionInput = {
  cwd: '/repo',
  config: { model: 'gpt-5.6-sol', effort: 'high', approvalMode: 'never' },
  sandbox: 'read-only',
};

/**
 * `TaskSession` の最小フェイク。どの操作で投げるかをテストごとに指定する。
 */
class FakeSession implements TaskSession {
  readonly sessionId = 'cleanup-session';
  openCalls = 0;
  disposeCalls = 0;
  interruptCalls = 0;
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(
    private readonly throwOn: {
      open?: boolean;
      setApprovalHandler?: boolean;
      runLoop?: boolean;
    } = {},
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
  open(): void {
    this.openCalls += 1;
    if (this.throwOn.open === true) {
      throw new Error('open が失敗しました');
    }
  }
  setApprovalHandler(): void {
    if (this.throwOn.setApprovalHandler === true) {
      throw new Error('setApprovalHandler が失敗しました');
    }
  }
  onStateChanged(): void {}
  onFinished(handler: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finished = handler;
  }
  runLoop(_plan: LoopPlan): void {
    if (this.throwOn.runLoop === true) {
      throw new Error('runLoop が同期で失敗しました');
    }
    this.finished?.('maxReached', { ...initialChatState, turnResultText: '応答' });
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
  constructor(private readonly throwOn: ConstructorParameters<typeof FakeSession>[0] = {}) {}
  async openTaskSession(_input: TaskSessionInput): Promise<TaskSession> {
    const session = new FakeSession(this.throwOn);
    this.sessions.push(session);
    return session;
  }
}

describe('runSingleTurnTask の後始末（Issue #926 C）', () => {
  it('open() が投げてもセッションは dispose される', async () => {
    const host = new FakeHost({ open: true });
    await expect(
      runSingleTurnTask(host, 'codex', SAFE_INPUT, 'prompt', { openPanel: true }),
    ).rejects.toThrow('open が失敗しました');
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('setApprovalHandler が投げてもセッションは dispose される', async () => {
    const host = new FakeHost({ setApprovalHandler: true });
    await expect(runSingleTurnTask(host, 'codex', SAFE_INPUT, 'prompt')).rejects.toThrow(
      'setApprovalHandler が失敗しました',
    );
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('onSessionOpened が投げてもセッションは dispose される', async () => {
    const host = new FakeHost();
    await expect(
      runSingleTurnTask(host, 'codex', SAFE_INPUT, 'prompt', {
        onSessionOpened: () => {
          throw new Error('onSessionOpened が失敗しました');
        },
      }),
    ).rejects.toThrow('onSessionOpened が失敗しました');
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('disposeSession: false ならこれまでどおり dispose しない', async () => {
    const host = new FakeHost({ open: true });
    await expect(
      runSingleTurnTask(host, 'codex', SAFE_INPUT, 'prompt', {
        openPanel: true,
        disposeSession: false,
      }),
    ).rejects.toThrow('open が失敗しました');
    expect(host.sessions[0]?.disposeCalls).toBe(0);
  });

  it('runLoop() が同期で投げたらタイマーが解除され、後から interrupt() が呼ばれない', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost({ runLoop: true });
      await expect(
        runSingleTurnTask(host, 'codex', SAFE_INPUT, 'prompt', { timeoutMs: 1_000 }),
      ).rejects.toThrow('runLoop が同期で失敗しました');
      expect(host.sessions[0]?.disposeCalls).toBe(1);
      // 解除されていなければ、ここでタイマーが発火して dispose 済みのセッションを叩く
      await vi.advanceTimersByTimeAsync(5_000);
      expect(host.sessions[0]?.interruptCalls).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** `note()` だけが投げるポート。破棄済みパネルへ書き込む経路の再現。 */
function throwingPort(overrides: Partial<SecondOpinionPanelPort> = {}): SecondOpinionPanelPort {
  return {
    parentSessionId: 'parent-a',
    cwd: '/repo',
    lastAssistantResponse: () => '直近の応答',
    conversationTranscript: () => '',
    note: () => {
      throw new Error('パネルは破棄済みです');
    },
    setRunning: () => {},
    generateRequestText: async () => {
      throw new Error('既定モードでは質問文の組み立ては呼ばれない');
    },
    // 親は暇（Issue #949 の待機には入らない）
    isParentIdle: () => true,
    onParentStateChanged: () => ({ dispose: () => {} }),
    ...overrides,
  };
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, show: () => {} };

/** 差分は使わないので、gitは呼ばれない前提（`none` を選ばせる）。 */
const unusedGit: GitCommandRunner = {
  run: async () => {
    throw new Error('git は呼ばれないはず');
  },
};

describe('startSecondOpinion の実行中フラグ（Issue #926 B）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    // 候補は既定の1件なので依頼先の選択UIは出ない。effortは既定（先頭）、対象は
    // 「追加資料なし」、依頼文はそのまま通す
    __mock.showQuickPickAnswer = (items) => {
      const list = items as Array<{ artifactKind?: string; effort?: string }>;
      return list.find((item) => item.artifactKind === 'none') ?? list[0];
    };
    __mock.showInputBoxAnswer = '設計判断について意見がほしい';
  });

  afterEach(() => {
    __mock.reset();
  });

  it('note() が投げても registry にidが残らず、次回また起動できる', async () => {
    const registry = new SecondOpinionRegistry();
    const host = new FakeHost();

    await expect(
      startSecondOpinion(throwingPort(), host, registry, noopLog, unusedGit),
    ).rejects.toThrow('パネルは破棄済みです');

    expect(registry.isRunning('parent-a')).toBe(false);
    expect(registry.begin('parent-a', 'run-next', () => {})).toBe(true);
  });

  it('finally の setRunning() が投げても registry の解除は済んでいる', async () => {
    const registry = new SecondOpinionRegistry();
    const host = new FakeHost();
    const port = throwingPort({
      note: () => {},
      setRunning: (running) => {
        if (!running) {
          throw new Error('パネルは破棄済みです');
        }
      },
    });

    await startSecondOpinion(port, host, registry, noopLog, unusedGit);

    expect(registry.isRunning('parent-a')).toBe(false);
  });
});
