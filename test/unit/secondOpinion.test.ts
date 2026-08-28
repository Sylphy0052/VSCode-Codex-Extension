import { describe, expect, it } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type {
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import type { GitCommandResult, GitCommandRunner } from '../../src/orchestrator/worktree';
import {
  DEFAULT_SECOND_OPINION_CANDIDATES,
  normalizeSecondOpinionCandidates,
  type SecondOpinionCandidate,
} from '../../src/secondOpinion/candidates';
import { buildSecondOpinionPrompt } from '../../src/secondOpinion/prompt';
import { runSecondOpinion, SecondOpinionRegistry } from '../../src/secondOpinion/run';
import { captureWorkspaceSnapshot } from '../../src/secondOpinion/snapshot';

const CANDIDATE: SecondOpinionCandidate = {
  name: 'Sol (high)',
  model: 'gpt-5.6-sol',
  effort: 'high',
};

/** 1ターンで応答を返すフェイク。`open()` が呼ばれたかを記録する（headlessの検証用）。 */
class FakeSession implements TaskSession {
  readonly sessionId = 'second-opinion-session';
  openCalls = 0;
  disposeCalls = 0;
  runLoopCalls: LoopPlan[] = [];
  private finishedListener: ((reason: LoopStopReason, state: ChatState) => void) | undefined;

  constructor(private readonly response: string) {}

  send(): void {}
  runLoop(plan: LoopPlan): void {
    this.runLoopCalls.push(plan);
    this.finishedListener?.('maxReached', { ...initialChatState, turnResultText: this.response });
  }
  setPromptTransform(): void {}
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finishedListener = listener;
  }
  onStateChanged(): void {}
  setApprovalHandler(): void {}
  onApprovalResolved(): void {}
  async interrupt(): Promise<void> {}
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
  openCalls: TaskSessionInput[] = [];
  sessions: FakeSession[] = [];
  constructor(private readonly response = 'レビュー結果です') {}
  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.openCalls.push(input);
    const session = new FakeSession(this.response);
    this.sessions.push(session);
    return session;
  }
}

/** 引数列に応じた応答を返すフェイクgit。 */
function fakeGit(responses: Record<string, GitCommandResult>): GitCommandRunner {
  return {
    async run(args: readonly string[]): Promise<GitCommandResult> {
      return (
        responses[args.join(' ')] ?? {
          code: 1,
          stdout: '',
          stderr: `unexpected: ${args.join(' ')}`,
        }
      );
    },
  };
}

const okResult = (stdout: string): GitCommandResult => ({ code: 0, stdout, stderr: '' });

describe('normalizeSecondOpinionCandidates（Issue #894）', () => {
  it('未設定なら既定の候補を返す', () => {
    const parsed = normalizeSecondOpinionCandidates(undefined);
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
    expect(parsed.warnings).toEqual([]);
  });

  it('配列でなければ既定へ丸め、理由を残す', () => {
    const parsed = normalizeSecondOpinionCandidates('gpt-5.6-sol');
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('空配列は既定へ丸める（候補ゼロで起動不能にしない）', () => {
    const parsed = normalizeSecondOpinionCandidates([]);
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
  });

  it('壊れた要素だけを捨て、正しい要素は残す', () => {
    const parsed = normalizeSecondOpinionCandidates([
      { name: 'Sol', model: 'gpt-5.6-sol', effort: 'high' },
      { name: '注入', model: 'gpt-5.6-sol --dangerous', effort: 'high' },
      { name: 'effortが不正', model: 'gpt-5.6-terra', effort: 'HIGH; rm -rf /' },
      { name: 'nameだけ', model: '', effort: 'high' },
      { name: 'Sol', model: 'gpt-5.6-luna', effort: 'low' },
    ]);
    expect(parsed.candidates).toEqual([{ name: 'Sol', model: 'gpt-5.6-sol', effort: 'high' }]);
    expect(parsed.warnings).toHaveLength(4);
  });

  it('全部壊れていれば既定へ丸める', () => {
    const parsed = normalizeSecondOpinionCandidates([{ model: 'x' }, 42]);
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
  });
});

describe('buildSecondOpinionPrompt（Issue #894）', () => {
  it('独立レビューであることと、スナップショットを正本として扱う指示を含む', () => {
    const prompt = buildSecondOpinionPrompt({
      request: 'この変更をレビューして',
      context: {
        kind: 'workspaceSnapshot',
        snapshot: { baseCommit: 'abc1234', diff: 'diff --git a/a.ts b/a.ts', truncated: false },
      },
    });
    expect(prompt).toContain('独立したレビュアー');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('diff --git a/a.ts b/a.ts');
    expect(prompt).toContain('現在の作業ツリーはレビュー中に変更されている可能性がある');
    expect(prompt).toContain('この変更をレビューして');
  });

  it('差分を切り詰めたときは、その旨を本文に載せる', () => {
    const prompt = buildSecondOpinionPrompt({
      request: 'レビューして',
      context: {
        kind: 'workspaceSnapshot',
        snapshot: { baseCommit: 'abc1234', diff: 'diff', truncated: true },
      },
    });
    expect(prompt).toContain('末尾を省略しています');
  });

  it('差分にコードフェンスが含まれても囲みが壊れない', () => {
    const diff = '+```ts\n+const a = 1;\n+```';
    const prompt = buildSecondOpinionPrompt({
      request: 'レビューして',
      context: {
        kind: 'workspaceSnapshot',
        snapshot: { baseCommit: 'abc1234', diff, truncated: false },
      },
    });
    expect(prompt).toContain('````diff');
    expect(prompt).toContain(diff);
  });

  it('レビュー対象なしなら依頼文だけを載せる', () => {
    const prompt = buildSecondOpinionPrompt({
      request: '設計の考え方を聞きたい',
      context: { kind: 'none' },
    });
    expect(prompt).toContain('設計の考え方を聞きたい');
    expect(prompt).not.toContain('レビュー対象');
  });
});

describe('runSecondOpinion（Issue #894）', () => {
  const snapshotContext = {
    kind: 'workspaceSnapshot' as const,
    snapshot: { baseCommit: 'abc1234', diff: '+const a = 1;', truncated: false },
  };

  it('読み取り専用・承認拒否・選んだ候補のmodel/effortでセッションを開く', async () => {
    const host = new FakeHost();
    const result = await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      context: snapshotContext,
      headless: true,
    });
    expect(result).toEqual({ ok: true, response: 'レビュー結果です' });
    expect(host.openCalls).toEqual([
      {
        cwd: '/repo',
        config: { model: 'gpt-5.6-sol', effort: 'high', approvalMode: 'never' },
        sandbox: 'read-only',
      },
    ]);
  });

  it('送るのは固定指示・依頼文・スナップショットだけで、他の文脈は混ざらない', async () => {
    const host = new FakeHost();
    await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      context: snapshotContext,
      headless: true,
    });
    const prompt = host.sessions[0]?.runLoopCalls[0]?.initialPrompt ?? '';
    // 実際に送られた本文が、依頼文とスナップショットだけから組み立てた本文と
    // 一字一句一致する（＝親セッションの会話が入り込む余地がない）
    expect(prompt).toBe(
      buildSecondOpinionPrompt({ request: 'レビューして', context: snapshotContext }),
    );
    // ループの合図（LOOP_DONE）等の付加も無い。1ターンで完結する
    expect(host.sessions[0]?.runLoopCalls[0]?.condition).toBe('');
    expect(host.sessions[0]?.runLoopCalls[0]?.maxIterations).toBe(1);
  });

  it('headlessならタブを開かない', async () => {
    const host = new FakeHost();
    await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      context: snapshotContext,
      headless: true,
    });
    expect(host.sessions[0]?.openCalls).toBe(0);
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });

  it('headlessでなければタブを開く', async () => {
    const host = new FakeHost();
    await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      context: snapshotContext,
      headless: false,
    });
    expect(host.sessions[0]?.openCalls).toBe(1);
  });

  it('応答が空なら理由付きで失敗を返す', async () => {
    const host = new FakeHost('   ');
    const result = await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      context: snapshotContext,
      headless: true,
    });
    expect(result.ok).toBe(false);
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });
});

describe('SecondOpinionRegistry（Issue #894）', () => {
  it('同じ親セッションからの重複起動を止め、終了後は再び開始できる', () => {
    const registry = new SecondOpinionRegistry();
    expect(registry.begin('parent-a')).toBe(true);
    expect(registry.begin('parent-a')).toBe(false);
    // 別の親セッションは止めない（グローバル1本制限は設けない）
    expect(registry.begin('parent-b')).toBe(true);
    registry.end('parent-a');
    expect(registry.isRunning('parent-a')).toBe(false);
    expect(registry.begin('parent-a')).toBe(true);
  });
});

describe('captureWorkspaceSnapshot（Issue #894）', () => {
  it('HEADと差分を1回だけ読み、その内容で固定する', async () => {
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff HEAD': okResult('+const a = 1;\n'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result).toEqual({
      ok: true,
      snapshot: { baseCommit: 'abc1234', diff: '+const a = 1;\n', truncated: false },
    });
  });

  it('gitの作業ツリーでなければ理由を返す', async () => {
    const git = fakeGit({ 'rev-parse --is-inside-work-tree': okResult('false\n') });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result.ok).toBe(false);
  });

  it('未コミットの変更が無ければ理由を返す', async () => {
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff HEAD': okResult('\n'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result.ok).toBe(false);
  });

  it('上限を超える差分は切り詰め、切り詰めたことを示す', async () => {
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff HEAD': okResult('x'.repeat(50)),
    });
    const result = await captureWorkspaceSnapshot('/repo', git, 10);
    expect(result).toEqual({
      ok: true,
      snapshot: { baseCommit: 'abc1234', diff: 'x'.repeat(10), truncated: true },
    });
  });
});
