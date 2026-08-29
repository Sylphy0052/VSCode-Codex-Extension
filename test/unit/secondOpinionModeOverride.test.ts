/**
 * 入力欄のモード固定ボタンから起動したときの材料の作り方（Issue #972）。
 *
 * ここで固定するのは、押した入口が設定 `agent.secondOpinion.mode` を上書きすることと、
 * 指定しなければ従来どおり設定に従うことである。設定と反対のモードを指定する側を
 * 見ないと、`modeOverride ?? config.mode` を `config.mode` と書いても通ってしまう。
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
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';

class FakeSession implements TaskSession {
  readonly sessionId = 'mode-override-session';
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

/** 質問文の組み立てが呼ばれた回数を数えられるポート。 */
function port(generated: string): SecondOpinionPanelPort & { generateCalls: number } {
  const notes: SecondOpinionDisplay[] = [];
  const created = {
    parentSessionId: 'parent-a',
    cwd: '/repo',
    generateCalls: 0,
    lastAssistantResponse: () => '',
    conversationTranscript: () => '',
    note: (_id: string, display: SecondOpinionDisplay) => {
      notes.push(display);
    },
    setRunning: () => undefined,
    generateRequestText: async () => {
      created.generateCalls += 1;
      return { ok: true as const, text: generated };
    },
    isParentIdle: () => true,
    onParentStateChanged: () => ({ dispose: () => undefined }),
  };
  return created;
}

/** 追加資料のQuickPickが出たら「追加資料なし」を選ぶ。出た回数も数える。 */
function answerQuickPicks(): { artifactPicks: number } {
  const counts = { artifactPicks: 0 };
  __mock.showQuickPickAnswer = (items) => {
    const list = items as Array<{ artifactKind?: string }>;
    const artifact = list.find((item) => item.artifactKind === 'none');
    if (artifact !== undefined) {
      counts.artifactPicks += 1;
      return artifact;
    }
    return list[0];
  };
  return counts;
}

describe('入力欄のモード固定ボタン（Issue #972）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.showInputBoxAnswer = '設計判断について意見がほしい';
  });

  afterEach(() => {
    __mock.reset();
  });

  it('設定がdirectでも、askGptを指定すれば質問文の組み立てを親へ頼み、追加資料を選ばせない', async () => {
    __mock.setConfig('agent', {
      secondOpinion: { mode: 'direct', askGpt: { confirm: false } },
    });
    const counts = answerQuickPicks();
    const p = port('# 1. 目的\n\nモードの固定を確かめる');
    const host = new RecordingHost();

    await startSecondOpinion(
      p,
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
      undefined,
      'askGpt',
    );

    expect(p.generateCalls).toBe(1);
    // askGptでは追加資料を選ばせない（Issue #947 受入基準1）
    expect(counts.artifactPicks).toBe(0);
  });

  it('設定がaskGptでも、directを指定すれば追加資料を選ばせ、親へ組み立てを頼まない', async () => {
    __mock.setConfig('agent', {
      secondOpinion: { mode: 'askGpt', askGpt: { confirm: false } },
    });
    const counts = answerQuickPicks();
    const p = port('# 1. 目的\n\n使われないはず');
    const host = new RecordingHost();

    await startSecondOpinion(
      p,
      host,
      new SecondOpinionRegistry(),
      noopLog,
      unusedGit,
      () => ['high'],
      undefined,
      'direct',
    );

    expect(p.generateCalls).toBe(0);
    expect(counts.artifactPicks).toBe(1);
    expect(host.prompts[0]).toContain('設計判断について意見がほしい');
  });

  it('指定しなければ設定に従う（既定の入口の挙動は変えない）', async () => {
    __mock.setConfig('agent', {
      secondOpinion: { mode: 'askGpt', askGpt: { confirm: false } },
    });
    const counts = answerQuickPicks();
    const p = port('# 1. 目的\n\n設定に従った');
    const host = new RecordingHost();

    await startSecondOpinion(p, host, new SecondOpinionRegistry(), noopLog, unusedGit, () => [
      'high',
    ]);

    expect(p.generateCalls).toBe(1);
    expect(counts.artifactPicks).toBe(0);
  });
});
