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
  MAX_SECOND_OPINION_CANDIDATES,
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

  it('空白だけのnameを捨てる（Issue #926 J）', () => {
    const parsed = normalizeSecondOpinionCandidates([
      { name: '   ', model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
    expect(parsed.warnings.some((warning) => warning.includes('name'))).toBe(true);
  });

  it('前後の空白を落とした値で格納し、重複も落とした後の値で判定する（Issue #926 J）', () => {
    const parsed = normalizeSecondOpinionCandidates([
      { name: '  Sol  ', model: '  gpt-5.6-sol  ', effort: ' high ' },
      { name: 'Sol', model: 'gpt-5.6-luna', effort: 'low' },
    ]);
    expect(parsed.candidates).toEqual([{ name: 'Sol', model: 'gpt-5.6-sol', effort: 'high' }]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('制御文字を含むnameを捨てる（Issue #926 J）', () => {
    const parsed = normalizeSecondOpinionCandidates([
      { name: 'Sol\nもう1行', model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(parsed.candidates).toEqual([...DEFAULT_SECOND_OPINION_CANDIDATES]);
    expect(parsed.warnings.some((warning) => warning.includes('制御文字'))).toBe(true);
  });

  it('長さ上限を超えるnameを捨てる（Issue #926 J）', () => {
    const parsed = normalizeSecondOpinionCandidates([
      { name: 'あ'.repeat(101), model: 'gpt-5.6-sol', effort: 'high' },
      { name: 'あ'.repeat(100), model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(parsed.candidates).toEqual([
      { name: 'あ'.repeat(100), model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('件数の上限を超えた分を捨てて理由を残す（Issue #926 J）', () => {
    const entries = Array.from({ length: MAX_SECOND_OPINION_CANDIDATES + 3 }, (_unused, index) => ({
      name: `候補${index + 1}`,
      model: 'gpt-5.6-sol',
      effort: 'high',
    }));
    const parsed = normalizeSecondOpinionCandidates(entries);
    expect(parsed.candidates).toHaveLength(MAX_SECOND_OPINION_CANDIDATES);
    expect(parsed.candidates.at(-1)?.name).toBe(`候補${MAX_SECOND_OPINION_CANDIDATES}`);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('壊れた要素は件数の上限に数えない（Issue #926 J）', () => {
    const entries = [
      42,
      ...Array.from({ length: MAX_SECOND_OPINION_CANDIDATES }, (_unused, index) => ({
        name: `候補${index + 1}`,
        model: 'gpt-5.6-sol',
        effort: 'high',
      })),
    ];
    const parsed = normalizeSecondOpinionCandidates(entries);
    expect(parsed.candidates).toHaveLength(MAX_SECOND_OPINION_CANDIDATES);
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe('buildSecondOpinionPrompt（Issue #894）', () => {
  it('独立したAdvisorであることと、スナップショットを正本として扱う指示を含む', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'この変更をレビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: {
          baseCommit: 'abc1234',
          diff: 'diff --git a/a.ts b/a.ts',
          truncated: false,
          untrackedFiles: [],
          untrackedOmissions: [],
          diffOmissions: [],
          diffPartials: [],
        },
      },
    });
    expect(prompt).toContain('独立した立場から意見を求められています');
    // 用途をコードレビューへ限定しない（Issue #926 P0）
    expect(prompt).toContain('求められるのはコードレビューに限りません');
    // 独立性は「セッション状態を継承しない」こと。回答は自動反映されない（Human Gate）
    expect(prompt).toContain('そのエージェントの内部の判断過程は渡されていません');
    expect(prompt).toContain('元の作業へ自動では反映されません');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('diff --git a/a.ts b/a.ts');
    expect(prompt).toContain('現在の作業ツリーは実行中に変更されている可能性がある');
    expect(prompt).toContain('この変更をレビューして');
  });

  it('差分を切り詰めたときは、その旨を本文に載せる', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: {
          baseCommit: 'abc1234',
          diff: 'diff',
          truncated: true,
          untrackedFiles: [],
          untrackedOmissions: [],
          diffOmissions: [],
          diffPartials: [],
        },
      },
    });
    expect(prompt).toContain('一部を省略しています');
  });

  it('差分にコードフェンスが含まれても囲みが壊れない', () => {
    const diff = '+```ts\n+const a = 1;\n+```';
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: {
          baseCommit: 'abc1234',
          diff,
          truncated: false,
          untrackedFiles: [],
          untrackedOmissions: [],
          diffOmissions: [],
          diffPartials: [],
        },
      },
    });
    expect(prompt).toContain('````diff');
    expect(prompt).toContain(diff);
  });

  it('レビュー対象なしなら依頼文だけを載せる', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: '設計の考え方を聞きたい',
      artifact: { kind: 'none' },
    });
    expect(prompt).toContain('設計の考え方を聞きたい');
    expect(prompt).not.toContain('レビュー対象');
  });

  it('追加資料が無いときは、探索せず材料だけで答えるよう指示する（Issue #944）', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: '設計の考え方を聞きたい',
      artifact: { kind: 'none' },
    });
    expect(prompt).toContain('リポジトリを探索する必要はありません');
    expect(prompt).toContain('何が足りないかを書いてください');
  });

  it('差分を渡すときも、読む範囲を判断に必要な分へ限らせる（Issue #944）', () => {
    const prompt = buildSecondOpinionPrompt({
      userRequest: 'レビューして',
      artifact: {
        kind: 'workspaceChanges',
        snapshot: {
          baseCommit: 'abc1234',
          diff: 'diff',
          truncated: false,
          untrackedFiles: [],
          untrackedOmissions: [],
          diffOmissions: [],
          diffPartials: [],
        },
      },
    });
    // ベース側を読む手段は残したうえで、全体の探索だけを止める。読ませる先は
    // 実workspaceではなくbundleの `base/` である（Issue #926 E）
    expect(prompt).toContain('`base/<パス>` を読んでください');
    expect(prompt).toContain('`changes.diff`');
    expect(prompt).not.toContain('git show');
    expect(prompt).toContain('リポジトリ全体の探索は行わないでください');
  });

  it('背景が要約か記録そのものかで、見出しと注意書きを書き分ける（Issue #944）', () => {
    const summarized = buildSecondOpinionPrompt({
      userRequest: '意見がほしい',
      artifact: { kind: 'none' },
      conversationSummary: 'これまでの経緯',
    });
    expect(summarized).toContain('別のセッションが記録から作った要約');
    expect(summarized).toContain('抜けや誤りがありえます');

    const transcript = buildSecondOpinionPrompt({
      userRequest: '意見がほしい',
      artifact: { kind: 'none' },
      conversationSummary: 'これまでの経緯',
      conversationBackgroundKind: 'transcript',
    });
    expect(transcript).toContain('会話の記録そのもの');
    // 圧縮していない材料に、圧縮による抜けの警告を付けない
    expect(transcript).not.toContain('抜けや誤りがありえます');
  });
});

describe('runSecondOpinion（Issue #894）', () => {
  const snapshotContext = {
    kind: 'workspaceChanges' as const,
    snapshot: {
      baseCommit: 'abc1234',
      diff: '+const a = 1;',
      truncated: false,
      untrackedFiles: [],
      untrackedOmissions: [],
      diffOmissions: [],
      diffPartials: [],
    },
  };

  it('読み取り専用・承認拒否・選んだ候補のmodel/effortでセッションを開く', async () => {
    const host = new FakeHost();
    const result = await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      artifact: snapshotContext,
      headless: true,
    });
    expect(result).toEqual({ ok: true, response: 'レビュー結果です' });
    expect(host.openCalls).toEqual([
      {
        cwd: '/repo',
        config: { model: 'gpt-5.6-sol', effort: 'high', approvalMode: 'never' },
        sandbox: 'read-only',
        // MCPサーバは1本も載せない（Issue #944）
        disableMcpServers: true,
      },
    ]);
  });

  it('送るのは固定指示・依頼文・スナップショットだけで、他の文脈は混ざらない', async () => {
    const host = new FakeHost();
    await runSecondOpinion(host, {
      cwd: '/repo',
      candidate: CANDIDATE,
      request: 'レビューして',
      artifact: snapshotContext,
      headless: true,
    });
    const prompt = host.sessions[0]?.runLoopCalls[0]?.initialPrompt ?? '';
    // 実際に送られた本文が、依頼文とスナップショットだけから組み立てた本文と
    // 一字一句一致する（＝親セッションの会話が入り込む余地がない）
    expect(prompt).toBe(
      buildSecondOpinionPrompt({ userRequest: 'レビューして', artifact: snapshotContext }),
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
      artifact: snapshotContext,
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
      artifact: snapshotContext,
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
      artifact: snapshotContext,
      headless: true,
    });
    expect(result.ok).toBe(false);
    expect(host.sessions[0]?.disposeCalls).toBe(1);
  });
});

describe('SecondOpinionRegistry（Issue #894 / #940）', () => {
  const noopCancel = (): void => {};

  it('同じ親セッションからの重複起動を止め、終了後は再び開始できる', () => {
    const registry = new SecondOpinionRegistry();
    expect(registry.begin('parent-a', 'run-1', noopCancel)).toBe(true);
    expect(registry.begin('parent-a', 'run-2', noopCancel)).toBe(false);
    // 別の親セッションは止めない（グローバル1本制限は設けない）
    expect(registry.begin('parent-b', 'run-3', noopCancel)).toBe(true);
    registry.end('parent-a', 'run-1');
    expect(registry.isRunning('parent-a')).toBe(false);
    expect(registry.begin('parent-a', 'run-4', noopCancel)).toBe(true);
  });

  it('cancel() は runId が一致する実行だけを止め、登録は消さない（Issue #940）', () => {
    const cancelled: string[] = [];
    const registry = new SecondOpinionRegistry();
    registry.begin('parent-a', 'run-1', () => cancelled.push('run-1'));

    // 別の実行のidでは止まらない（会話に残る古い項目から遅れて届く停止操作）
    expect(registry.cancel('parent-a', 'run-0')).toBe(false);
    // 走っていない親セッションでも何も起きない
    expect(registry.cancel('parent-b', 'run-1')).toBe(false);
    expect(cancelled).toEqual([]);

    expect(registry.cancel('parent-a', 'run-1')).toBe(true);
    expect(cancelled).toEqual(['run-1']);
    // 決着は実行側が付ける。停止を要求しただけでは解放しない
    expect(registry.isRunning('parent-a')).toBe(true);
  });

  it('古い実行の end() は、後から始まった実行の登録を消さない（Issue #940）', () => {
    const registry = new SecondOpinionRegistry();
    registry.begin('parent-a', 'run-1', noopCancel);
    registry.end('parent-a', 'run-1');
    registry.begin('parent-a', 'run-2', noopCancel);

    // 止めた実行の後始末が遅れて届く経路
    registry.end('parent-a', 'run-1');
    expect(registry.isRunning('parent-a')).toBe(true);
    // 新しい実行は自分のidでだけ解放できる
    registry.end('parent-a', 'run-2');
    expect(registry.isRunning('parent-a')).toBe(false);
  });
});

describe('captureWorkspaceSnapshot（Issue #894）', () => {
  it('HEADと差分を1回だけ読み、その内容で固定する', async () => {
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff --no-ext-diff --no-textconv abc1234 --': okResult('+const a = 1;\n'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result).toEqual({
      ok: true,
      material: { fullDiff: '+const a = 1;\n', changedPaths: [] },
      snapshot: {
        baseCommit: 'abc1234',
        diff: '+const a = 1;\n',
        truncated: false,
        untrackedFiles: [],
        untrackedOmissions: [],
        diffOmissions: [],
        diffPartials: [],
      },
    });
  });

  it('rev-parse の後にHEADが動いても、baseCommitと差分が同じ地点を指す（Issue #926 A）', async () => {
    // `git diff HEAD` は `HEAD` を解決し直すため、2コマンドの間にコミットが入ると
    // 「baseCommit: abc1234」と「新しいHEAD基準の差分」という食い違った組み合わせになる。
    // 解決済みハッシュを渡していれば、HEADが動いた後の差分は引かれない
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff --no-ext-diff --no-textconv abc1234 --': okResult('+固定した地点の差分\n'),
      // 実行中にコミットが入り、HEADが別の地点へ動いた状態
      'diff HEAD': okResult('+動いた後の差分\n'),
      'diff --no-ext-diff --no-textconv HEAD --': okResult('+動いた後の差分\n'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result).toEqual({
      ok: true,
      material: { fullDiff: '+固定した地点の差分\n', changedPaths: [] },
      snapshot: {
        baseCommit: 'abc1234',
        diff: '+固定した地点の差分\n',
        truncated: false,
        untrackedFiles: [],
        untrackedOmissions: [],
        diffOmissions: [],
        diffPartials: [],
      },
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
      'diff --no-ext-diff --no-textconv abc1234 --': okResult('\n'),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result.ok).toBe(false);
  });

  it('上限を超える差分はhunkの境界で切り、落としたものを返す（Issue #926 H）', async () => {
    const big =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n' +
      '@@ -1,1 +1,1 @@\n+aaaaaaaaaa\n' +
      '@@ -2,1 +2,1 @@\n+bbbbbbbbbb\n';
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff --no-ext-diff --no-textconv abc1234 --': okResult(big),
    });
    // 1つ目のhunkだけが入る予算
    const result = await captureWorkspaceSnapshot('/repo', git, { maxDiffBytes: 90 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.truncated).toBe(true);
    // hunkの途中では切れていない
    expect(result.snapshot.diff).toContain('@@ -1,1 +1,1 @@\n+aaaaaaaaaa\n');
    expect(result.snapshot.diff).not.toContain('bbbbbbbbbb');
    expect(result.snapshot.diffPartials).toEqual([
      { path: 'a.ts', omittedHunks: 1, totalHunks: 2 },
    ]);
    // 材料側（bundleへ書く分）は切らない
    expect(result.material.fullDiff).toBe(big);
  });

  it('上限以下なら差分に手を入れない（Issue #926 H 受入基準）', async () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n+a\n';
    const git = fakeGit({
      'rev-parse --is-inside-work-tree': okResult('true\n'),
      'rev-parse HEAD': okResult('abc1234\n'),
      'diff --no-ext-diff --no-textconv abc1234 --': okResult(diff),
    });
    const result = await captureWorkspaceSnapshot('/repo', git);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.diff).toBe(diff);
    expect(result.snapshot.truncated).toBe(false);
    expect(result.snapshot.diffOmissions).toEqual([]);
    expect(result.snapshot.diffPartials).toEqual([]);
  });
});
