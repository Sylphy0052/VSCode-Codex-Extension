/**
 * セカンドオピニオンの実行時間に効く選択（Issue #944）。
 *
 * ここで固定するのは2つ。
 * - その場で選んだeffortが、実際に開くセッションへ渡ること（設定の候補は書き換えない）
 * - 会話が短いときは要約セッションを開かず、記録そのものを背景として渡すこと
 *   （要約は本体の前に直列で走るため、開いた回数がそのまま待ち時間になる）
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
import {
  startSecondOpinion,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';
import type { SecondOpinionDisplay } from '../../src/secondOpinion/display';

class FakeSession implements TaskSession {
  readonly sessionId = 'speed-session';
  disposeCalls = 0;
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
  dispose(): void {
    this.disposeCalls += 1;
  }
}

class RecordingHost implements TaskSessionHost {
  readonly inputs: TaskSessionInput[] = [];
  readonly prompts: string[] = [];

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.inputs.push(input);
    const session = new FakeSession();
    const original = session.runLoop.bind(session);
    session.runLoop = (plan: LoopPlan): void => {
      this.prompts.push(plan.initialPrompt);
      original(plan);
    };
    return session;
  }
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, show: () => {} };

const unusedGit: GitCommandRunner = {
  run: async () => {
    throw new Error('追加資料なしではgitを使わない');
  },
};

function port(transcript: string): SecondOpinionPanelPort {
  const notes: SecondOpinionDisplay[] = [];
  return {
    parentSessionId: 'parent-a',
    cwd: '/repo',
    lastAssistantResponse: () => '',
    conversationTranscript: () => transcript,
    note: (_id, display) => {
      notes.push(display);
    },
    setRunning: () => undefined,
    isBusy: () => false,
    generateRequestText: async () => {
      throw new Error('既定モードでは質問文の組み立ては呼ばれない');
    },
  };
}

/** 依頼先は1件で選ばせない。effortは指定した値、資料は「追加資料なし」を選ぶ。 */
function answerQuickPicks(effort: string): void {
  __mock.showQuickPickAnswer = (items) => {
    const list = items as Array<{ artifactKind?: string; effort?: string }>;
    const artifact = list.find((item) => item.artifactKind === 'none');
    if (artifact !== undefined) {
      return artifact;
    }
    return list.find((item) => item.effort === effort);
  };
}

describe('セカンドオピニオンの実行時の選択（Issue #944）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.showInputBoxAnswer = '設計判断について意見がほしい';
  });

  afterEach(() => {
    __mock.reset();
  });

  it('その場で選んだeffortでセッションを開く', async () => {
    answerQuickPicks('low');
    const host = new RecordingHost();
    await startSecondOpinion(
      port(''),
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['low', 'medium', 'high'],
    );
    expect(host.inputs).toHaveLength(1);
    expect(host.inputs[0]?.config.effort).toBe('low');
    // 権限とMCPの扱いは選択に関係なく固定
    expect(host.inputs[0]?.config.approvalMode).toBe('never');
    expect(host.inputs[0]?.disableMcpServers).toBe(true);
  });

  it('effortを選ばずに閉じたら何も起動しない', async () => {
    const shown: unknown[][] = [];
    __mock.showQuickPickAnswer = (items) => {
      shown.push([...items]);
      return undefined;
    };
    const host = new RecordingHost();
    const registry = new SecondOpinionRegistry();
    await startSecondOpinion(port(''), host, registry, noopLog, unusedGit, () => ['low', 'high']);
    // 最初に出るのがeffortの選択（依頼先は候補1件なので出ない）
    expect(shown).toHaveLength(1);
    expect(host.inputs).toHaveLength(0);
    expect(registry.isRunning('parent-a')).toBe(false);
  });

  it('選べるeffortが1つしか無ければ選ばせない', async () => {
    const shown: unknown[][] = [];
    __mock.showQuickPickAnswer = (items) => {
      shown.push([...items]);
      const list = items as Array<{ artifactKind?: string }>;
      return list.find((item) => item.artifactKind === 'none');
    };
    const host = new RecordingHost();
    await startSecondOpinion(
      port(''),
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    // 出たのは資料の選択だけ
    expect(shown).toHaveLength(1);
    expect(host.inputs[0]?.config.effort).toBe('high');
  });

  it('会話が短いときは要約セッションを開かず、記録そのものを背景に渡す', async () => {
    answerQuickPicks('high');
    const host = new RecordingHost();
    await startSecondOpinion(
      port('利用者: 直近の設計はこれで良いか\nCodex: 判断材料はこれ'),
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    // 開いたのは本体の1本だけ（要約セッションを開いていない）
    expect(host.inputs).toHaveLength(1);
    expect(host.prompts[0]).toContain('会話の記録そのもの');
    expect(host.prompts[0]).toContain('直近の設計はこれで良いか');
  });

  it('会話が長いときは要約セッションを開き、その要約を背景に渡す', async () => {
    answerQuickPicks('high');
    const host = new RecordingHost();
    await startSecondOpinion(
      port('あ'.repeat(5_000)),
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
    );
    // 要約セッション → 本体の2本
    expect(host.inputs).toHaveLength(2);
    expect(host.prompts[1]).toContain('別のセッションが記録から作った要約');
    // 要約セッションもMCPを載せない
    expect(host.inputs[0]?.disableMcpServers).toBe(true);
  });
});
