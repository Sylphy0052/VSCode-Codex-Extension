import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatItem, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import { runSingleTurnTask, SingleTurnTimeoutError } from '../../src/orchestrator/planner';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import { partialSecondOpinionDisplay } from '../../src/secondOpinion/display';
import { DEFAULT_SECOND_OPINION_TIMEOUT_MS, runSecondOpinion } from '../../src/secondOpinion/run';

/** `package.json` の既定値と定数がずれていないかを見るために読む（`.json` はimportできない）。 */
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};

const agentMessage = (id: string, text: string): ChatItem => ({
  id,
  kind: 'agentMessage',
  text,
  detail: '',
  status: undefined,
  turnId: undefined,
  diffs: [],
});

/**
 * 打ち切っても途中の回答を残す（Issue #907）。
 *
 * ここで見張るのは「セカンドオピニオンでは部分出力が残ること」と「分解セッションでは
 * 残らないこと」の両方。後者を落とすと、途中までの壊れたYAMLを定義として読む経路ができる。
 *
 * `onFinished` を一度も呼ばないフェイクで、実時間の待ちを作らずに打ち切りを起こす
 * （`timeoutMs` を数ミリ秒にする）。
 */
class NeverFinishingSession implements TaskSession {
  readonly sessionId = 'never-finishing-session';
  openCalls = 0;
  disposeCalls = 0;
  interruptCalls = 0;
  private stateListener: ((state: ChatState) => void) | undefined;

  /** `agentMessage` を積んだ状態を1回流す。空配列なら状態変化を起こさない。 */
  constructor(private readonly agentMessages: readonly string[]) {}

  send(): void {}
  runLoop(_plan: LoopPlan): void {
    if (this.agentMessages.length === 0) {
      return;
    }
    this.stateListener?.({
      ...initialChatState,
      items: this.agentMessages.map((text, index) => agentMessage(`m${String(index)}`, text)),
    });
  }
  setPromptTransform(): void {}
  onFinished(_listener: (reason: LoopStopReason, state: ChatState) => void): void {}
  onStateChanged(listener: (state: ChatState) => void): void {
    this.stateListener = listener;
  }
  setApprovalHandler(): void {}
  onApprovalResolved(): void {}
  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
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
  }
  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeHost implements TaskSessionHost {
  sessions: NeverFinishingSession[] = [];
  constructor(private readonly agentMessages: readonly string[]) {}
  async openTaskSession(_input: TaskSessionInput): Promise<TaskSession> {
    const session = new NeverFinishingSession(this.agentMessages);
    this.sessions.push(session);
    return session;
  }
}

const SESSION_INPUT: TaskSessionInput = {
  cwd: '/repo',
  config: { model: 'gpt-5.6-sol', effort: 'high', approvalMode: 'never' },
  sandbox: 'read-only',
};

const CANDIDATE = { name: 'Sol (high)', model: 'gpt-5.6-sol', effort: 'high' };
const SNAPSHOT_CONTEXT = {
  kind: 'workspaceChanges' as const,
  snapshot: { baseCommit: 'abc1234', diff: '+const a = 1;', truncated: false },
};

describe('runSingleTurnTask の打ち切り（Issue #907）', () => {
  it('partialOnTimeout を指定しなければ、途中の回答は捨てる（分解セッションの従来どおり）', async () => {
    const host = new FakeHost(['途中まで書いたYAML']);

    const error = await runSingleTurnTask(host, 'codex', SESSION_INPUT, 'やって', {
      timeoutMs: 5,
      openPanel: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SingleTurnTimeoutError);
    expect((error as SingleTurnTimeoutError).partialText).toBeUndefined();
  });

  it('partialOnTimeout を指定すると、打ち切り時点の最後のagentMessageを載せる', async () => {
    const host = new FakeHost(['前半の指摘', '後半の指摘']);

    const error = await runSingleTurnTask(host, 'codex', SESSION_INPUT, 'レビューして', {
      timeoutMs: 5,
      openPanel: false,
      partialOnTimeout: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SingleTurnTimeoutError);
    expect((error as SingleTurnTimeoutError).partialText).toBe('後半の指摘');
  });

  it('agentMessageが1件も出ていなければ、partialOnTimeout でも載せない', async () => {
    const host = new FakeHost([]);

    const error = await runSingleTurnTask(host, 'codex', SESSION_INPUT, 'レビューして', {
      timeoutMs: 5,
      openPanel: false,
      partialOnTimeout: true,
    }).catch((e: unknown) => e);

    expect((error as SingleTurnTimeoutError).partialText).toBeUndefined();
  });

  it('打ち切っても interrupt() と dispose() は呼ぶ（CLIプロセスを残さない）', async () => {
    const host = new FakeHost(['途中まで']);

    await runSingleTurnTask(host, 'codex', SESSION_INPUT, 'レビューして', {
      timeoutMs: 5,
      openPanel: false,
      partialOnTimeout: true,
    }).catch(() => undefined);

    expect(host.sessions[0]?.interruptCalls).toBe(1);
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('打ち切りの文言に、停止の完了を保証しない旨が入る（Issue #926 D）', async () => {
    const host = new FakeHost([]);

    const error = await runSingleTurnTask(host, 'codex', SESSION_INPUT, 'やって', {
      timeoutMs: 5,
      openPanel: false,
      label: 'セカンドオピニオン',
    }).catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      'セカンドオピニオンのターンが5ミリ秒以内に完了しなかったため打ち切りました（停止を要求しましたが、相手側で処理が続いている可能性があります）',
    );
  });
});

describe('runSecondOpinion の打ち切り（Issue #907）', () => {
  const request = {
    cwd: '/repo',
    candidate: CANDIDATE,
    request: 'レビューして',
    artifact: SNAPSHOT_CONTEXT,
    headless: true,
    timeoutMs: 5,
  };

  it('途中まで出ていれば、失敗ではなく「打ち切り時点までの回答」として返す', async () => {
    const host = new FakeHost(['ここまでの指摘']);

    const result = await runSecondOpinion(host, request);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, response: 'ここまでの指摘' });
    if (result.ok) {
      expect(result.partialReason).toContain('打ち切りました');
    }
  });

  it('途中まででも出ていなければ、従来どおり失敗として理由だけを返す', async () => {
    const host = new FakeHost([]);

    const result = await runSecondOpinion(host, request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('打ち切りました');
    }
  });

  it('部分出力の本文はログへ出さない（分量だけ）', async () => {
    const host = new FakeHost(['ここだけの秘密 sk-live-xxxx']);
    const infos: string[] = [];

    await runSecondOpinion(host, request, {
      info: (m: string) => infos.push(m),
      warn: () => undefined,
      error: () => undefined,
    } as never);

    expect(infos.join('\n')).not.toContain('ここだけの秘密');
    expect(infos.join('\n')).toContain('responseChars=');
  });
});

describe('打ち切り時の表示（Issue #907）', () => {
  it('全文が返ったときと見分けがつく（途中までである旨と理由が出る）', () => {
    const display = partialSecondOpinionDisplay(
      CANDIDATE,
      'workspaceChanges',
      'レビューして',
      'ここまでの指摘',
      'セカンドオピニオンのターンが900000ミリ秒以内に完了しなかったため打ち切りました',
    );

    expect(display.status).toBe('completed');
    expect(display.text).toContain('回答（打ち切り時点まで）');
    expect(display.text).toContain('ここまでの指摘');
    expect(display.detail).toContain('打ち切りました');
    expect(display.detail).toContain('ここまでの回答を残しています');
  });
});

describe('既定のタイムアウト（Issue #907）', () => {
  it('15分で、package.json の既定と一致する', () => {
    expect(DEFAULT_SECOND_OPINION_TIMEOUT_MS).toBe(15 * 60_000);
    expect(
      manifest.contributes.configuration.properties['agent.secondOpinion.timeoutMs']?.default,
    ).toBe(DEFAULT_SECOND_OPINION_TIMEOUT_MS);
  });
});
