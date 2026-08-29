/**
 * 形式検証に落ちた質問文の組み立て直し（Issue #997）。
 *
 * ここで固定するのは、落ちたときに1回だけ理由付きで作り直すことと、上限まで落ちたら
 * 従来どおり失敗で終えることである。回数の上限を見ないと、無制限に回し直す実装でも通ってしまう。
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
import {
  ASK_GPT_MAX_ATTEMPTS,
  ASK_GPT_SECTION_HEADINGS,
  type RequestGenerationResult,
} from '../../src/secondOpinion/askGpt';
import { SecondOpinionRegistry } from '../../src/secondOpinion/run';
import type { SecondOpinionDisplay } from '../../src/secondOpinion/display';
import {
  startSecondOpinion,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';

class FakeSession implements TaskSession {
  readonly sessionId = 'askgpt-retry-session';
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

/** 8セクションを備えた、検証を通る質問文。 */
function validText(note: string): string {
  return [
    `# 質問: ${note}`,
    '',
    'この質問文だけで内容が分かるように書いてある。',
    '',
    ...ASK_GPT_SECTION_HEADINGS.map((heading) => `${heading}\n\n${note}\n`),
  ].join('\n');
}

/** 見出しが1つも無い、検証に落ちる質問文。 */
function invalidText(): string {
  return '# 質問: 形式に落ちる\n\n見出しを書き忘れた本文だけの質問文。';
}

/**
 * 生成結果を呼び出しごとに差し替えられるポート。渡された指示も記録する。
 */
function port(
  results: readonly RequestGenerationResult[],
): SecondOpinionPanelPort & { instructions: string[]; notes: SecondOpinionDisplay[] } {
  const instructions: string[] = [];
  const notes: SecondOpinionDisplay[] = [];
  return {
    parentSessionId: 'parent-a',
    cwd: '/repo',
    instructions,
    notes,
    lastAssistantResponse: () => '',
    conversationTranscript: () => '',
    note: (_id: string, display: SecondOpinionDisplay) => {
      notes.push(display);
    },
    setRunning: () => undefined,
    generateRequestText: async (instruction: string) => {
      instructions.push(instruction);
      const result = results[instructions.length - 1];
      if (result === undefined) {
        throw new Error(
          `生成を${instructions.length}回呼んだ（用意した結果は${results.length}件）`,
        );
      }
      return result;
    },
    isParentIdle: () => true,
    onParentStateChanged: () => ({ dispose: () => undefined }),
  };
}

async function run(p: SecondOpinionPanelPort, host: RecordingHost): Promise<void> {
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
}

describe('形式検証に落ちた質問文の組み立て直し（Issue #997）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.showInputBoxAnswer = '設計判断について意見がほしい';
    __mock.setConfig('agent', {
      secondOpinion: { mode: 'askGpt', askGpt: { confirm: false } },
    });
  });

  afterEach(() => {
    __mock.reset();
  });

  it('1回目が形式を満たせば、組み立て直しを行わない', async () => {
    const p = port([{ ok: true, text: validText('一発で通る') }]);
    const host = new RecordingHost();

    await run(p, host);

    expect(p.instructions).toHaveLength(1);
    expect(host.prompts).toHaveLength(1);
  });

  it('1回目が形式に落ちたら、理由を添えて1回だけ組み立て直し、通れば送信まで進む', async () => {
    const p = port([
      { ok: true, text: invalidText() },
      { ok: true, text: validText('作り直した') },
    ]);
    const host = new RecordingHost();

    await run(p, host);

    expect(p.instructions).toHaveLength(2);
    // 2回目の指示には、前回落ちた理由が入っている
    expect(p.instructions[1]).toContain('## 前回の出力について');
    expect(p.instructions[1]).toContain('## 2. 質問');
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]).toContain('作り直した');
  });

  it('上限まで落ちたら失敗で終え、生成を上限より多く呼ばない', async () => {
    const p = port([
      { ok: true, text: invalidText() },
      { ok: true, text: invalidText() },
    ]);
    const host = new RecordingHost();

    await run(p, host);

    expect(p.instructions).toHaveLength(ASK_GPT_MAX_ATTEMPTS);
    expect(host.prompts).toHaveLength(0);
  });

  it('生成そのものの失敗は組み立て直しの対象にしない', async () => {
    const p = port([{ ok: false, kind: 'timeout', reason: '時間内に返らなかった' }]);
    const host = new RecordingHost();

    await run(p, host);

    expect(p.instructions).toHaveLength(1);
    expect(host.prompts).toHaveLength(0);
  });
});
