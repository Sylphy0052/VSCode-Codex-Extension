/**
 * 回答が返った時点で作業中のAIへ全文を渡す（Issue #1003）。
 *
 * ここで固定するのは「何を、いつ、どういう名乗りで渡すか」である。渡す中身は回答の全文で、
 * 下書きへ整形し直さない。名乗りは「人はまだ確認していない」であって「承認された指示」では
 * ない——後者を名乗ると受け取った側が重みを取り違える。
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
  autoSendResult,
  startSecondOpinion,
  type SecondOpinionPanelPort,
} from '../../src/view/secondOpinionCommand';
import type { SecondOpinionCandidate } from '../../src/secondOpinion/candidates';

/** 応答を1つ返して終わるセッション。返す本文と終わり方を差し替えられる。 */
class FakeSession implements TaskSession {
  readonly sessionId = 'auto-send-session';
  private finished: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(
    private readonly text: string,
    private readonly reason: LoopStopReason = 'maxReached',
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
  open(): void {}
  decideApproval(): void {}
  reveal(): void {}
  setApprovalHandler(): void {}
  onStateChanged(): void {}
  onFinished(handler: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finished = handler;
  }
  runLoop(_plan: LoopPlan): void {
    this.finished?.(this.reason, { ...initialChatState, turnResultText: this.text });
  }
  async interrupt(): Promise<void> {}
  dispose(): void {}
}

class FakeHost implements TaskSessionHost {
  readonly inputs: TaskSessionInput[] = [];

  constructor(
    private readonly text: string,
    private readonly reason: LoopStopReason = 'maxReached',
  ) {}

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.inputs.push(input);
    return new FakeSession(this.text, this.reason);
  }
}

const noopLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, show: () => {} };

const unusedGit: GitCommandRunner = {
  run: async () => {
    throw new Error('追加資料なしではgitを使わない');
  },
};

/** 送られた文面を控えるポート。親は常に暇で、待機は挟まない。 */
class FakePort implements SecondOpinionPanelPort {
  readonly parentSessionId = 'parent-auto-send';
  readonly cwd = '/repo';
  readonly notes: Array<{ id: string; display: SecondOpinionDisplay }> = [];
  readonly sent: string[] = [];
  /** 真にすると送信が失敗する（送れなかった経路の確認に使う）。 */
  failSend = false;

  lastAssistantResponse(): string {
    return '';
  }
  conversationTranscript(): string {
    return '';
  }
  note(id: string, display: SecondOpinionDisplay): void {
    this.notes.push({ id, display });
  }
  setRunning(): void {}
  isParentIdle(): boolean {
    return true;
  }
  onParentStateChanged(): { dispose(): void } {
    return { dispose: () => {} };
  }
  async sendApprovedInstruction(text: string): Promise<'sent' | 'queued'> {
    if (this.failSend) {
      throw new Error('送信できません');
    }
    this.sent.push(text);
    return 'sent';
  }
}

const CANDIDATE: SecondOpinionCandidate = {
  name: 'Sol (high)',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

/** 追加資料は「なし」を選ぶ。候補もeffortも1つで、選択UIは出ない。 */
function answerQuickPicks(): void {
  __mock.showQuickPickAnswer = (items) => {
    const list = items as Array<{ artifactKind?: string }>;
    return list.find((item) => item.artifactKind === 'none');
  };
}

async function run(port: FakePort, host: FakeHost): Promise<void> {
  await startSecondOpinion(port, host, new SecondOpinionRegistry(), noopLog, unusedGit, () => [
    'high',
  ]);
}

describe('回答の自動送信（Issue #1003）', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.setWorkspaceFolder('/repo');
    __mock.showInputBoxAnswer = 'この方針で進めてよいか';
    answerQuickPicks();
    // 要約セッションを開かせない（このテストが見たいのは本体の回答の行き先だけ）
    __mock.setConfig('agent', { 'secondOpinion.summary': { enabled: false } });
  });

  afterEach(() => {
    __mock.reset();
  });

  it('既定では回答の全文がそのまま作業中のAIへ渡る', async () => {
    const port = new FakePort();
    await run(port, new FakeHost('この案で進めてよい。ただし境界値を先に決めること'));

    expect(port.sent).toHaveLength(1);
    const text = port.sent[0] ?? '';
    // 回答は要約も整形もせず全文が入る
    expect(text).toContain('この案で進めてよい。ただし境界値を先に決めること');
    // 出所と、人がまだ読んでいないことを名乗る
    expect(text).toContain('独立したセカンドオピニオン');
    expect(text).toContain('利用者はまだ内容を確認しておらず、承認された指示ではありません');
    // 手動経路の名乗り（承認済み）を流用してはならない
    expect(text).not.toContain('利用者が確認・編集して承認した指示');
  });

  it('autoSendを切ると自動では送らない（従来の手動2ステップへ戻る）', async () => {
    __mock.setConfig('agent', {
      'secondOpinion.summary': { enabled: false },
      'secondOpinion.autoSend': false,
    });
    const port = new FakePort();
    await run(port, new FakeHost('意見です'));

    expect(port.sent).toEqual([]);
    // 回答そのものは会話へ出ている
    expect(port.notes.some((note) => note.display.text?.includes('意見です'))).toBe(true);
  });

  it('打ち切りでも送るが、打ち切りだと名乗る', async () => {
    const port = new FakePort();
    await autoSendResult(
      port,
      CANDIDATE,
      { ok: true, response: 'ここまでは言える', partialReason: '打ち切りました' },
      noopLog,
    );

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toContain('打ち切られており、途中までの内容です');
    expect(port.sent[0]).toContain('ここまでは言える');
  });

  it('最後まで返ってきた回答には打ち切りだと書かない', async () => {
    const port = new FakePort();
    await autoSendResult(port, CANDIDATE, { ok: true, response: '意見です' }, noopLog);

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).not.toContain('打ち切られており');
  });

  it('失敗した回答は送らない', async () => {
    const port = new FakePort();
    await autoSendResult(port, CANDIDATE, { ok: false, reason: '接続できません' }, noopLog);

    expect(port.sent).toEqual([]);
  });

  it('回答が空なら送らない', async () => {
    const port = new FakePort();
    await autoSendResult(port, CANDIDATE, { ok: true, response: '   ' }, noopLog);

    expect(port.sent).toEqual([]);
  });

  it('送れなくても回答は会話に残る', async () => {
    const port = new FakePort();
    port.failSend = true;
    await run(port, new FakeHost('意見です'));

    expect(port.sent).toEqual([]);
    expect(port.notes.some((note) => note.display.text?.includes('意見です'))).toBe(true);
  });
});
