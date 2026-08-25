import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { ApprovalDecision } from '../../src/appserver/approvals';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  McpElicitationHandler,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import {
  WAITING_REPLY_POLL_INTERVAL_MS,
  WorkflowRunner,
  type WorkflowFilePort,
  type WorkflowRunnerForgeDeps,
  type WorkflowRunnerMessagingDeps,
} from '../../src/orchestrator/runner';
import type {
  CliAvailabilityPort,
  CliCommandRunner,
  FinalMergeConfig,
  ForgeFileSystemPort,
  ForgeHostConfig,
  PullRequestLayerConfig,
} from '../../src/orchestrator/forge';
import { deserializeManifest, integrationPath } from '../../src/orchestrator/pseudoWorktree';
import { MAX_WORKTREE_REMOVAL_ATTEMPTS } from '../../src/orchestrator/runState';
import {
  ORCHESTRATOR_CONNECTION_ID,
  DEFAULT_MAX_ASK_USER_PER_RUN,
} from '../../src/orchestrator/orchestratorSession';
import type { RoadmapFileSystemPort } from '../../src/orchestrator/roadmap';
import { formatPathList } from '../../src/orchestrator/runnerWorkingDirectory';
import type {
  PseudoWorktreeDirEntry,
  PseudoWorktreeFileStat,
  PseudoWorktreeFileSystemPort,
} from '../../src/orchestrator/pseudoWorktree';
import type {
  DispatchErrorLogPort,
  HttpMcpTransportHandle,
  OrchestratorControlPort,
  OrchestratorControlResult,
  TaskMessagingHub,
} from '../../src/orchestrator/messaging';
import { ORCHESTRATOR_CONTROL_TOOLS } from '../../src/orchestrator/messaging';
import {
  WorkflowRunStore,
  type PersistedRun,
  type WorkflowRunMemento,
} from '../../src/orchestrator/runStore';
import {
  DEFAULT_BRANCH_NAMING,
  WorktreeCreationQueue,
  type BranchNaming,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';
import { MAX_WORKFLOW_FILE_BYTES, type Provider } from '../../src/orchestrator/workflow';
import type { Logger } from '../../src/log';

/**
 * `runner.ts` の結線を検証するテスト群。
 *
 * `TaskSessionHost` / `TaskSession` はフェイクに差し替え、実際のCodex/Claudeプロセスや
 * `codex app-server` へは一切繋がない。git操作も同様にフェイクの `GitCommandRunner` で
 * 完結させ、実ファイルシステムへは触れない。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

/** 既定でaskになる危険パターンの例（design.md §16.7）。承認関連のテストで使い回す。 */
const DANGEROUS_COMMAND = ['git', 'push', '--force', 'origin', 'main'].join(' ');

class FakeTaskSession implements TaskSession {
  readonly sessionId: string;
  runLoopCalls: LoopPlan[] = [];
  promptTransform: ((text: string) => string) | undefined;
  approvalHandler: ApprovalHandler | undefined;
  mcpElicitationHandler: McpElicitationHandler | undefined;
  disposed = false;
  interruptCount = 0;
  private readonly stateListeners: Array<(state: ChatState) => void> = [];
  private readonly finishedListeners: Array<(reason: LoopStopReason, state: ChatState) => void> =
    [];
  private readonly approvalResolvedListeners: Array<(outcome: ApprovalOutcome) => void> = [];

  constructor(
    readonly cwd: string,
    idSeed: number,
  ) {
    this.sessionId = `session-${idSeed}`;
  }

  /**
   * テスト用。設定すると`runLoop()`が投げる（ループを走らせられなかった経路の再現）。
   */
  failRunLoop: Error | undefined;
  runLoop(plan: LoopPlan): void {
    if (this.failRunLoop !== undefined) {
      throw this.failRunLoop;
    }
    this.runLoopCalls.push(plan);
  }
  /** `TaskSession.send`（design.md §16.23）。ループを介さない1回きりの送信。 */
  sentTexts: string[] = [];
  send(text: string): void {
    this.sentTexts.push(text);
  }
  setPromptTransform(transform: (text: string) => string): void {
    this.promptTransform = transform;
  }
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finishedListeners.push(listener);
  }
  onStateChanged(listener: (state: ChatState) => void): void {
    this.stateListeners.push(listener);
  }
  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
  setMcpElicitationHandler(handler: McpElicitationHandler): void {
    this.mcpElicitationHandler = handler;
  }
  onApprovalResolved(listener: (outcome: ApprovalOutcome) => void): void {
    this.approvalResolvedListeners.push(listener);
  }
  interrupt(): Promise<void> {
    this.interruptCount += 1;
    return Promise.resolve();
  }
  pauseLoopCount = 0;
  pauseLoop(): void {
    this.pauseLoopCount += 1;
  }
  resumeLoopCount = 0;
  resumeLoop(): void {
    this.resumeLoopCount += 1;
  }
  /** テストごとに差し替え可能。既定は`true`（見える）。design.md §16.21の可視性確認用。 */
  messagingToolVisible = true;
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(this.messagingToolVisible);
  }
  stopLoopCount = 0;
  /**
   * テスト用。既定は`true`（実際に走っていたループを止められた）。`false`にすると、
   * `LoopController.stop()`が既に止まっているループへの呼び出しへ返す`false`
   * （「見つかったが、ループは既に終わっていた」。issue #514 medium指摘）を再現できる
   */
  stopLoopReturns = true;
  stopLoop(): boolean {
    this.stopLoopCount += 1;
    return this.stopLoopReturns;
  }
  decideApprovalCalls: Array<{ requestId: number | string; decision: ApprovalDecision }> = [];
  decideApproval(requestId: number | string, decision: ApprovalDecision): void {
    this.decideApprovalCalls.push({ requestId, decision });
  }
  revealCount = 0;
  reveal(): void {
    this.revealCount += 1;
  }
  /** テスト用。設定すると`open()`が投げる（タブを開けなかった経路の再現）。 */
  failOpen: Error | undefined;
  /**
   * テスト用。設定すると`open()`が`onFinished`を**同期的に**発火する（`open()`の中で
   * ループを回し切ってしまうhost実装の再現。Issue #412のレビュー指摘12）。1回だけ発火する。
   */
  openFinishReason: LoopStopReason | undefined;
  openCount = 0;
  open(): void {
    this.openCount += 1;
    if (this.failOpen !== undefined) {
      throw this.failOpen;
    }
    const reason = this.openFinishReason;
    this.openFinishReason = undefined;
    if (reason !== undefined) {
      this.finish(reason, { ...initialChatState });
    }
  }
  /**
   * テスト用。設定すると`dispose()`が`onFinished`を**同期的に**発火する
   * （`chatView.ts`の`teardown`が`entry.loop.stop('manual')`を呼ぶ実挙動の再現。
   * Issue #412のレビュー指摘D）。1回だけ発火する。
   */
  disposeFinishReason: LoopStopReason | undefined;
  /**
   * テスト用。設定すると`dispose()`が投げる（タブの片付けや`stdin.end()`・プロセスkillが
   * 失敗するhost実装の再現。Issue #374「1つの解放が失敗しても残りを解放する」と
   * Issue #434のレビュー指摘の検証用）。`disposed`は立てずに投げるので、失敗した
   * セッションと解放できたセッションを区別できる。フラグは1回で消えるので、
   * 2度目の`dispose()`は成功する。
   */
  failDispose: Error | undefined;
  dispose(): void {
    if (this.failDispose !== undefined) {
      const err = this.failDispose;
      this.failDispose = undefined;
      throw err;
    }
    this.disposed = true;
    const reason = this.disposeFinishReason;
    this.disposeFinishReason = undefined;
    if (reason !== undefined) {
      this.finish(reason, { ...initialChatState });
    }
  }

  // ---- テスト用の操作 ----
  emitState(state: ChatState): void {
    for (const l of this.stateListeners) {
      l(state);
    }
  }
  finish(reason: LoopStopReason, state: ChatState): void {
    for (const l of this.finishedListeners) {
      l(reason, state);
    }
  }
  async requestApproval(
    approval: Parameters<ApprovalHandler>[0],
    rawParams: Record<string, unknown> = {},
  ) {
    if (this.approvalHandler === undefined) {
      throw new Error('approvalHandlerが設定されていません');
    }
    return this.approvalHandler(approval, rawParams);
  }
  resolveApproval(requestId: number | string, decision: ApprovalDecision): void {
    for (const l of this.approvalResolvedListeners) {
      l({ requestId, decision });
    }
  }
}

class FakeHost implements TaskSessionHost {
  /**
   * タスク用に開いたセッションだけを並べる。オーケストレーターセッション
   * （design.md §16.23。`role: 'orchestrator'`）は`orchestratorSessions`へ分ける。
   * 混ぜると「タスクの何番目のセッションか」を見ている既存のテストが、runごとに1つ増える
   * オーケストレーターのぶんだけずれてしまうため。
   */
  sessions: FakeTaskSession[] = [];
  orchestratorSessions: FakeTaskSession[] = [];
  openInputs: TaskSessionInput[] = [];
  private counter = 0;
  /** 次の`openTaskSession`呼び出しだけ失敗させる（例: app-serverが落ちている等の再現）。 */
  private pendingRejection: Error | undefined;
  /**
   * 新しく開くセッションの`checkMessagingToolVisible`の既定値（design.md §16.21）。
   * セッションが実際に作られる前（`runner.start`を呼ぶ前）にしか効かない設定なので、
   * `openTaskSession`呼び出しの前に設定すること。
   */
  defaultMessagingToolVisible = true;

  rejectNext(error: Error): void {
    this.pendingRejection = error;
  }

  /**
   * 次に開くタスクセッションへ適用する設定（衝突解決セッションだけを壊すために使う）。
   * 1回適用したら消える。
   */
  configureNext: ((session: FakeTaskSession) => void) | undefined;

  /** オーケストレーターセッション（design.md §16.23）の生成だけを失敗させる。 */
  rejectOrchestrator: Error | undefined;

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    if (input.role === 'orchestrator') {
      if (this.rejectOrchestrator !== undefined) {
        throw this.rejectOrchestrator;
      }
    } else if (this.pendingRejection !== undefined) {
      // `rejectNext`はタスクの起動失敗を再現するためのもの。オーケストレーターの生成が
      // 先に走るため、役割で分けないとそちらが身代わりに失敗してしまう
      const error = this.pendingRejection;
      this.pendingRejection = undefined;
      throw error;
    }
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
    session.messagingToolVisible = this.defaultMessagingToolVisible;
    if (this.configureNext !== undefined && input.role !== 'orchestrator') {
      const configure = this.configureNext;
      this.configureNext = undefined;
      configure(session);
    }
    if (input.role === 'orchestrator') {
      this.orchestratorSessions.push(session);
      return session;
    }
    this.openInputs.push(input);
    this.sessions.push(session);
    return session;
  }

  /** cwdの末尾セグメント（taskId）で引く。worktreePathの末尾がtaskIdになるため。 */
  byTaskId(taskId: string): FakeTaskSession {
    const found = this.sessions.find((s) => s.cwd.endsWith(`/${taskId}`) || s.cwd === taskId);
    if (found === undefined) {
      throw new Error(`taskId=${taskId}のセッションが見つかりません`);
    }
    return found;
  }
}

/** `git` の呼び出しを全てフェイクで完結させる。実ファイルシステムへは一切触れない。 */
interface FakeGitHandle extends GitCommandRunner {
  /** 呼ばれたgitコマンドの履歴。`worktree remove` が実際に呼ばれたかの確認等に使う。 */
  calls: Array<{ args: string[]; cwd: string }>;
  /**
   * 衝突解決セッションのテスト用。`conflictOnce: true` で発生させた衝突を「解決してコミット
   * 済み」の状態にする（`git diff --diff-filter=U`を空にし、`MERGE_HEAD`も無しにする）。
   * 衝突解決セッション役の`FakeTaskSession`が`finish('done', ...)`する前に呼ぶ。
   */
  resolveConflict(): void;
}

/**
 * `worktree add` を失敗させたい場合だけ `failWorktreeAdd: true` を渡す。既定では
 * 1回目の`worktree add`呼び出し（`start()`が作る統合worktree）から失敗させる。
 * タスク自身のworktree作成（2回目以降）だけを失敗させたいときは
 * `failWorktreeAddFromCall: 2` を併せて渡す（1回目＝統合worktreeは成功させる）。
 * `failMerge: true` は `git merge --no-ff` を常に（衝突ではない）失敗させる。
 * `conflictOnce: true` は最初の1回の `git merge --no-ff` だけを衝突として扱う
 * （2回目以降は成功。衝突解決セッションが解決した後の再マージを模す）。衝突中は
 * `git diff --diff-filter=U` / `git rev-parse MERGE_HEAD` も実物同様に振る舞う
 * （`resolveConflict()`を呼ぶまで未解決のまま）。
 */
function fakeGit(options?: {
  failWorktreeAdd?: boolean;
  failWorktreeAddFromCall?: number;
  failMerge?: boolean;
  conflictOnce?: boolean;
  /**
   * `true`なら`conflictOnce`が消費されず（`conflictPending`を戻さず）、`resolveConflict()`で
   * 未解決状態だけ晴らせば次の`merge --no-ff`でも再び衝突する（Issue #413 PR5の
   * 「再マージ後にもう一度タイムアウトする」シナリオの再現用。同一taskIdの警告が
   * 直近1件へ丸められることを確かめるには、同じタスクで衝突→承認待ちタイムアウトを
   * 2回起こせる必要がある）。
   */
  conflictEveryMerge?: boolean;
  /** `git remote get-url origin` の応答（design.md §16.18のforgeテスト用）。未指定ならremote無し。 */
  originRemoteUrl?: string;
  /** `git rev-parse --abbrev-ref HEAD` の応答。既定は `main`。 */
  headBranch?: string;
  /** `git push` を常に失敗させる。 */
  failPush?: boolean;
  /**
   * `git merge --abort` を常に失敗させる（未解決の衝突は残ったまま）。停止・巻き戻しが
   * 効かず統合worktreeに`MERGE_HEAD`が残ったまま次のタスクがマージへ来る状況の再現用
   * （Issue #412のレビュー指摘1）。
   */
  failMergeAbort?: boolean;
  /** `git`の作業ツリーでないワークスペースを模す（design.md §16.20の疑似worktreeテスト用）。 */
  notGitRepo?: boolean;
}): FakeGitHandle {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  let conflictPending = options?.conflictOnce === true;
  let unresolvedConflict = false;
  let worktreeAddCallCount = 0;
  return {
    calls,
    resolveConflict() {
      unresolvedConflict = false;
    },
    async run(args, cwd) {
      calls.push({ args: [...args], cwd });
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return options?.notGitRepo
          ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
          : { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return { code: 0, stdout: `${options?.headBranch ?? 'main'}\n`, stderr: '' };
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return options?.originRemoteUrl !== undefined
          ? { code: 0, stdout: `${options.originRemoteUrl}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: "error: No such remote 'origin'" };
      }
      if (args[0] === 'push') {
        return options?.failPush
          ? { code: 1, stdout: '', stderr: 'fatal: fake push failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
        // マージ進行中（未解決の衝突が残っている）間だけ見つかる
        return unresolvedConflict
          ? { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        // ブランチはまだ存在しない（worktree作成前提）
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreeAddCallCount += 1;
        const from = options?.failWorktreeAddFromCall ?? 1;
        if (options?.failWorktreeAdd && worktreeAddCallCount >= from) {
          return { code: 128, stdout: '', stderr: 'fatal: fake worktree add failure' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        if (conflictPending) {
          if (options?.conflictEveryMerge !== true) {
            conflictPending = false;
          }
          unresolvedConflict = true;
          return { code: 1, stdout: '', stderr: 'CONFLICT (content): fake conflict' };
        }
        if (options?.failMerge) {
          return { code: 1, stdout: '', stderr: 'fatal: fake merge failure' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
        if (options?.failMergeAbort) {
          // 巻き戻しに失敗＝未解決の衝突は残り続ける
          return { code: 1, stdout: '', stderr: 'fatal: fake merge --abort failure' };
        }
        unresolvedConflict = false;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return unresolvedConflict
          ? { code: 0, stdout: 'CONFLICT.txt\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add' && args[1] === '-A') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'commit') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'log') {
        // マージ済みタスクidの逆算・リロード時の再判定は既定では「見つからない」扱い
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` };
    },
  };
}

const identityFs: WorktreeFileSystemPort = {
  realpath: async (target) => target,
  readTextFile: async () => '.agents/worktrees/\n',
  isSymbolicLink: async () => false,
  pathExists: async () => true,
};

/** `gh` CLIの呼び出しをフェイクで完結させる（design.md §16.18のforgeテスト用）。 */
interface FakeForgeCli extends CliCommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }>;
}

function fakeForgeCli(options?: {
  authenticated?: boolean;
  failCreate?: boolean;
  failMerge?: boolean;
  failReady?: boolean;
  prUrl?: string;
  /** `waitForCiChecks`のCLI呼び出し自体を失敗させる（design.md §16.36、Issue #556）。 */
  failCiStatus?: boolean;
  /** GitHubのCI状態フェイク応答（`statusCheckRollup`の中身）。既定は空配列（CI未設定）。 */
  ciStatusCheckRollup?: unknown[];
  /** GitLabのCI状態フェイク応答（`head_pipeline`の中身）。既定は`null`（CI未設定）。 */
  ciHeadPipeline?: unknown;
  /** `updatePullRequestBranch`のCLI呼び出しを失敗させる。 */
  failUpdateBranch?: boolean;
  /**
   * design.md §16.36（Issue #556）の回帰テスト用。最初の`pr merge`/`mr merge`だけ
   * 「baseの最新でない」を示すエラーで失敗させ、`updatePullRequestBranch`を挟んだ
   * 再試行では成功させる。
   */
  failMergeNotUpToDateOnce?: boolean;
  /** design.md §16.30（Issue #339）のレビューコメント取得フェイク応答。既定は0件。 */
  reviewComments?: {
    github?: { reviews?: unknown[]; comments?: unknown[] };
    gitlabNotes?: unknown[];
  };
  /** レビューコメント取得のCLI呼び出し自体を失敗させる。 */
  failReviewComments?: boolean;
  /** `createIssue`（design.md §16.31、roadmap W6、Issue #596）のCLI呼び出しを失敗させる。 */
  failIssueCreate?: boolean;
  /** `createIssue`が返すURL。既定は`https://github.com/acme/repo/issues/1`。 */
  issueUrl?: string;
}): FakeForgeCli {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  return {
    calls,
    async run(command, args, cwd) {
      calls.push({ command, args: [...args], cwd });
      if (args[0] === 'auth' && args[1] === 'status') {
        return options?.authenticated === false
          ? { code: 1, stdout: '', stderr: 'not logged in' }
          : { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return options?.failCreate
          ? { code: 1, stdout: '', stderr: 'fake pr create failure' }
          : {
              code: 0,
              stdout: `${options?.prUrl ?? 'https://github.com/acme/repo/pull/1'}\n`,
              stderr: '',
            };
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        // design.md §16.36（Issue #556）: 「baseの最新でない」拒否からの取り込み直しの
        // 回帰テスト用。1回目のマージだけ拒否し、`updatePullRequestBranch`を挟んだ
        // 2回目の再試行では成功させる
        if (options?.failMergeNotUpToDateOnce === true) {
          const priorMergeCalls = calls.filter(
            (c) => c.args[0] === 'pr' && c.args[1] === 'merge',
          ).length;
          if (priorMergeCalls <= 1) {
            return {
              code: 1,
              stdout: '',
              stderr:
                'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)',
            };
          }
        }
        return options?.failMerge
          ? { code: 1, stdout: '', stderr: 'fake pr merge failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // `markPullRequestReady`（GitHub）が呼ぶ`gh pr ready <number>`のフェイク応答
      if (args[0] === 'pr' && args[1] === 'ready') {
        return options?.failReady
          ? { code: 1, stdout: '', stderr: 'fake pr ready failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // GitLab（`glab`）側の配線。`buildCreatePullRequestArgs`（forge.ts）はMR作成に
      // `glab api projects/:id/merge_requests`を使い、`web_url`を含むJSONを返す想定
      if (args[0] === 'api' && args[1] === 'projects/:id/merge_requests') {
        return options?.failCreate
          ? { code: 1, stdout: '', stderr: 'fake mr create failure' }
          : {
              code: 0,
              stdout: `${JSON.stringify({
                web_url:
                  options?.prUrl ?? 'https://gitlab.example.com/acme/repo/-/merge_requests/1',
              })}\n`,
              stderr: '',
            };
      }
      // `markPullRequestReady`（GitLab）が呼ぶ`glab mr update <number> --ready`のフェイク応答
      if (args[0] === 'mr' && args[1] === 'update') {
        return options?.failReady
          ? { code: 1, stdout: '', stderr: 'fake mr update failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // `runFinalMerge`（GitLab）が呼ぶ`glab mr merge --remove-source-branch`のフェイク応答
      if (args[0] === 'mr' && args[1] === 'merge') {
        return options?.failMerge
          ? { code: 1, stdout: '', stderr: 'fake mr merge failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // `waitForCiChecks`（GitHub）が呼ぶ`gh pr view <number> --json=statusCheckRollup`の
      // フェイク応答（design.md §16.36、Issue #556）。既定はCI未設定（`statusCheckRollup: []`）
      // として即マージへ進ませ、既存のfinalMerge系テストの前提（CIを待たず即マージする）を
      // 崩さない。CIの完了待ちそのものを確かめるテストは`ciConclusion`オプションで上書きする
      // `fetchReviewComments`（GitHub）が呼ぶ`gh pr view <number> --json=reviews,comments`の
      // フェイク応答（design.md §16.30、Issue #339）。CI状態取得（`--json=statusCheckRollup`）
      // とは第3引数の`--json=`の中身で区別する
      if (args[0] === 'pr' && args[1] === 'view' && args[3] === '--json=reviews,comments') {
        return options?.failReviewComments
          ? { code: 1, stdout: '', stderr: 'fake pr view (reviews) failure' }
          : {
              code: 0,
              stdout: JSON.stringify({
                reviews: options?.reviewComments?.github?.reviews ?? [],
                comments: options?.reviewComments?.github?.comments ?? [],
              }),
              stderr: '',
            };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return options?.failCiStatus
          ? { code: 1, stdout: '', stderr: 'fake pr view failure' }
          : {
              code: 0,
              stdout: JSON.stringify({ statusCheckRollup: options?.ciStatusCheckRollup ?? [] }),
              stderr: '',
            };
      }
      // `updatePullRequestBranch`（GitHub）が呼ぶ`gh pr update-branch <number>`のフェイク応答
      if (args[0] === 'pr' && args[1] === 'update-branch') {
        return options?.failUpdateBranch
          ? { code: 1, stdout: '', stderr: 'fake pr update-branch failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // `fetchReviewComments`（GitLab）が呼ぶ
      // `glab api projects/:id/merge_requests/<iid>/notes`のフェイク応答（design.md §16.30、
      // Issue #339）。CI状態取得（末尾に`/notes`が付かない）とはパスの形で区別する
      if (
        args[0] === 'api' &&
        args[1] !== undefined &&
        args[1].startsWith('projects/:id/merge_requests/') &&
        args[1].endsWith('/notes')
      ) {
        return options?.failReviewComments
          ? { code: 1, stdout: '', stderr: 'fake mr notes failure' }
          : {
              code: 0,
              stdout: JSON.stringify(options?.reviewComments?.gitlabNotes ?? []),
              stderr: '',
            };
      }
      // `waitForCiChecks`（GitLab）が呼ぶ`glab api projects/:id/merge_requests/<iid>`の
      // フェイク応答。MR作成（`projects/:id/merge_requests`、末尾に番号が付かない）・
      // レビューコメント取得（末尾に`/notes`が付く。上のブロック）とはパスの形で区別する
      if (
        args[0] === 'api' &&
        args[1] !== undefined &&
        args[1] !== 'projects/:id/merge_requests' &&
        args[1].startsWith('projects/:id/merge_requests/') &&
        !args[1].endsWith('/notes')
      ) {
        return options?.failCiStatus
          ? { code: 1, stdout: '', stderr: 'fake mr view failure' }
          : {
              code: 0,
              stdout: JSON.stringify({ head_pipeline: options?.ciHeadPipeline ?? null }),
              stderr: '',
            };
      }
      // `updatePullRequestBranch`（GitLab）が呼ぶ`glab mr rebase <iid>`のフェイク応答
      if (args[0] === 'mr' && args[1] === 'rebase') {
        return options?.failUpdateBranch
          ? { code: 1, stdout: '', stderr: 'fake mr rebase failure' }
          : { code: 0, stdout: '', stderr: '' };
      }
      // `createIssue`（GitHub）が呼ぶ`gh issue create`のフェイク応答（design.md §16.31、
      // roadmap W6、Issue #596）
      if (args[0] === 'issue' && args[1] === 'create') {
        return options?.failIssueCreate
          ? { code: 1, stdout: '', stderr: 'fake issue create failure' }
          : {
              code: 0,
              stdout: `${options?.issueUrl ?? 'https://github.com/acme/repo/issues/1'}\n`,
              stderr: '',
            };
      }
      // `createIssue`（GitLab）が呼ぶ`glab api projects/:id/issues`のフェイク応答
      if (args[0] === 'api' && args[1] === 'projects/:id/issues') {
        return options?.failIssueCreate
          ? { code: 1, stdout: '', stderr: 'fake issue create failure' }
          : {
              code: 0,
              stdout: `${JSON.stringify({
                web_url: options?.issueUrl ?? 'https://gitlab.example.com/acme/repo/-/issues/1',
              })}\n`,
              stderr: '',
            };
      }
      return { code: 1, stdout: '', stderr: `unhandled: ${command} ${args.join(' ')}` };
    },
  };
}

const fakeForgeCliAvailability: CliAvailabilityPort = { isOnPath: async () => true };
const fakeForgeFs: ForgeFileSystemPort = {
  writeTempFile: async () => '/tmp/fake-forge-body.md',
  removeTempFile: async () => undefined,
};

/**
 * 疑似worktree（design.md §16.20）のためのメモリ上のフェイクファイルシステム。
 * `pseudoWorktree.test.ts`は実ファイルシステム（`node:fs/promises` + `mkdtemp`）で
 * 完結させているが、`runner.ts`のテストは「実ファイルシステムへは一切触れない」方針
 * （ファイル冒頭のdocstring参照）に揃えるため、ここではメモリ上のフェイクにする。
 */
class FakePseudoFs implements PseudoWorktreeFileSystemPort {
  readonly files = new Map<string, PseudoWorktreeFileStat>();
  readonly dirs = new Set<string>();
  /** マニフェストの永続化（Issue #380）用。テキストファイルはサイズ・更新時刻を持たないため別管理。 */
  readonly textFiles = new Map<string, string>();
  /**
   * Issue #364の回帰テスト用。`nodePseudoWorktreeFileSystem`の`mkdir`/`copyFile`/`removeFile`は
   * 他のポートメソッドと違いEACCES/ENOSPC等をそのままthrowする実装のため、そのふるまいを
   * フェイクでも再現できるようにする（既定はthrowしない。既存テストへの影響を避けるため）。
   */
  failWith: Error | undefined;

  constructor(seedFiles: Record<string, PseudoWorktreeFileStat> = {}) {
    for (const [p, meta] of Object.entries(seedFiles)) {
      this.setFile(p, meta);
    }
  }

  private ensureDirsFor(target: string): void {
    let cur = path.dirname(target);
    let prev = target;
    while (cur !== prev) {
      this.dirs.add(cur);
      prev = cur;
      cur = path.dirname(cur);
    }
  }

  setFile(target: string, meta: PseudoWorktreeFileStat): void {
    this.files.set(target, meta);
    this.ensureDirsFor(target);
  }

  async readdir(target: string): Promise<readonly PseudoWorktreeDirEntry[]> {
    const entries: PseudoWorktreeDirEntry[] = [];
    for (const p of this.files.keys()) {
      if (path.dirname(p) === target) {
        entries.push({ name: path.basename(p), isDirectory: false, isSymbolicLink: false });
      }
    }
    for (const d of this.dirs) {
      if (path.dirname(d) === target) {
        entries.push({ name: path.basename(d), isDirectory: true, isSymbolicLink: false });
      }
    }
    return entries;
  }
  async statFile(target: string): Promise<PseudoWorktreeFileStat | undefined> {
    return this.files.get(target);
  }
  async isSymbolicLink(): Promise<boolean> {
    return false;
  }
  async directoryExists(target: string): Promise<boolean> {
    return this.dirs.has(target);
  }
  async realpath(target: string): Promise<string | undefined> {
    return target;
  }
  async mkdir(target: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.dirs.add(target);
    this.ensureDirsFor(target);
  }
  async copyFile(from: string, to: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const meta = this.files.get(from);
    if (meta !== undefined) {
      this.setFile(to, meta);
    }
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    // 実ファイルシステムの`rename(2)`と同じく、`to`が既存でも置き換える。
    // Issue #485で`PseudoWorktreeFileSystemPort.rename`が必須になったため、
    // このフェイクも持つ（オプショナルだった当時に実装しなかった理由は
    // 「別作業がこのクラスを押さえていて触れなかった」だけで、技術的な理由は無い）
    const meta = this.files.get(from);
    if (meta !== undefined) {
      this.files.delete(from);
      this.setFile(to, meta);
    }
    const text = this.textFiles.get(from);
    if (text !== undefined) {
      this.textFiles.delete(from);
      this.textFiles.set(to, text);
      this.ensureDirsFor(to);
    }
  }
  async removeFile(target: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.files.delete(target);
    // マニフェスト等（`writeTextFile`で書いたもの）も同じ`target`パスに対する
    // `removeFile`で消える想定（実ファイルシステムでは拡張子・書き込み手段を問わず
    // 同じパスのファイルは1つ）。ここを漏らすと、`removeRunDirIfEmpty`が
    // 非再帰の`removeEmptyDir`へ変わった後（Issue #438のレビュー指摘・medium2）に
    // 「本来消えているはずのテキストファイルが残る」という、このフェイク固有の
    // 見せかけの不整合が生まれる。
    this.textFiles.delete(target);
  }
  async readTextFile(target: string): Promise<string | undefined> {
    return this.textFiles.get(target);
  }
  async writeTextFile(target: string, content: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.textFiles.set(target, content);
    this.ensureDirsFor(target);
  }
  async removeDirRecursive(target: string): Promise<void> {
    const prefix = `${target}${path.sep}`;
    for (const p of [...this.files.keys()]) {
      if (p === target || p.startsWith(prefix)) {
        this.files.delete(p);
      }
    }
    for (const p of [...this.textFiles.keys()]) {
      if (p === target || p.startsWith(prefix)) {
        this.textFiles.delete(p);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === target || d.startsWith(prefix)) {
        this.dirs.delete(d);
      }
    }
  }
  async removeEmptyDir(target: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const hasChildren =
      [...this.files.keys()].some((p) => path.dirname(p) === target) ||
      [...this.dirs].some((d) => path.dirname(d) === target);
    if (hasChildren) {
      return;
    }
    this.dirs.delete(target);
  }
}

function fakeForgeDeps(
  cli: FakeForgeCli,
  config?: {
    host?: ForgeHostConfig;
    pullRequest?: PullRequestLayerConfig;
    finalMerge?: FinalMergeConfig;
    branchNaming?: BranchNaming;
    draftPullRequest?: boolean;
    createTaskIssue?: boolean;
    reviewTaskPullRequest?: boolean;
  },
  cliAvailability: CliAvailabilityPort = fakeForgeCliAvailability,
): WorkflowRunnerForgeDeps {
  return {
    cli,
    cliAvailability,
    fs: fakeForgeFs,
    readConfig: () => ({
      host: config?.host ?? 'auto',
      pullRequest: config?.pullRequest ?? 'per-task',
      finalMerge: config?.finalMerge ?? 'auto',
      // 既定は`wf`/`false`。branchNaming・draftPullRequestを明示するテストだけ上書きする
      branchNaming: config?.branchNaming ?? DEFAULT_BRANCH_NAMING,
      draftPullRequest: config?.draftPullRequest ?? false,
      // 既定は両方`false`（design.md §16.31、roadmap W6、Issue #596）。明示するテストだけ上書きする
      createTaskIssue: config?.createTaskIssue ?? false,
      reviewTaskPullRequest: config?.reviewTaskPullRequest ?? false,
    }),
  };
}

/** `messaging.ts`の`startHttpMcpTransport`のフェイク。実HTTPは張らず、呼び出しだけ記録する。 */
interface FakeMessagingState {
  hub: TaskMessagingHub | undefined;
  handle:
    | (HttpMcpTransportHandle & { registeredTasks: string[]; closed: boolean; closeCount: number })
    | undefined;
  /** `startTransport`へ実際に渡された`logPort`（Issue #375、配線の検証用）。 */
  logPort: DispatchErrorLogPort | undefined;
  /**
   * `startTransport`が呼ばれた回数と、そのたびに渡された`hub`の履歴（Issue #475）。
   * `ensureMessaging`の冪等性（既に生きていれば二重に呼ばない）と、hubの再利用
   * （closeMessaging後の再構築で同じインスタンスを渡す）を検証するために使う。
   */
  startCallCount: number;
  hubHistory: TaskMessagingHub[];
  /**
   * `blockStart: true`のとき、保留中の`startTransport`呼び出しを1件だけ解決させる
   * （呼び出し順のFIFO）。保留が無ければ何もしない。
   */
  releaseStart: () => void;
}

/**
 * `TaskSessionInput.cwd`が指定タスクのディレクトリかどうかを、再実行の枝番
 * （`resolveWorkingDirectory`が付ける`-retry0`等のサフィックス、Issue #475のテストで
 * 「再実行後の最新の入力」を取り違えないために使う）まで含めて判定する。
 */
function cwdEndsWithTask(cwd: string, taskId: string): boolean {
  return new RegExp(`/${taskId}(-retry\\d+)?$`).test(cwd);
}

function fakeMessagingDeps(options?: {
  failStart?: boolean;
  failClose?: boolean;
  /**
   * 2回目以降の`startTransport`呼び出しを、`state.releaseStart()`が呼ばれるまで個別に
   * 保留する（Issue #475）。**1回目（`start()`が最初に立てる呼び出し）は保留しない** ——
   * `start()`自身がこの呼び出しの完了を`await`するため、1回目まで保留すると
   * `runner.start()`自体が返らずテストがデッドロックする。`ensureMessaging`の同時起動
   * ガード（`live.messagingSetupInFlight`）は run終了後の再構築（2回目以降）でしか
   * 起きないため、これで検証したい範囲はちょうど賄える。
   */
  blockStart?: boolean;
}): {
  deps: WorkflowRunnerMessagingDeps;
  state: FakeMessagingState;
} {
  const pendingReleases: Array<() => void> = [];
  const state: FakeMessagingState = {
    hub: undefined,
    handle: undefined,
    logPort: undefined,
    startCallCount: 0,
    hubHistory: [],
    releaseStart: () => {
      const release = pendingReleases.shift();
      release?.();
    },
  };
  const deps: WorkflowRunnerMessagingDeps = {
    startTransport: async (hub, logPort) => {
      state.startCallCount += 1;
      state.hubHistory.push(hub);
      if (options?.blockStart === true && state.startCallCount > 1) {
        await new Promise<void>((resolve) => {
          pendingReleases.push(resolve);
        });
      }
      state.hub = hub;
      state.logPort = logPort;
      if (options?.failStart) {
        throw new Error('fake transport start failure');
      }
      const registeredTasks: string[] = [];
      const handle: HttpMcpTransportHandle & {
        registeredTasks: string[];
        closed: boolean;
        closeCount: number;
      } = {
        transport: { onConnection: () => undefined },
        baseUrl: 'http://127.0.0.1:0',
        registeredTasks,
        closed: false,
        // 二重解放の検知用（Issue #374）。閉じた回数を数える
        closeCount: 0,
        registerTask(taskId: string): string {
          registeredTasks.push(taskId);
          return `http://127.0.0.1:0/mcp/${taskId}`;
        },
        close(): Promise<void> {
          handle.closed = true;
          handle.closeCount += 1;
          if (options?.failClose === true) {
            throw new Error('fake transport close failure');
          }
          return Promise.resolve();
        },
      };
      state.handle = handle;
      return handle;
    },
  };
  return { deps, state };
}

function fakeMemento(): WorkflowRunMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

/**
 * `memento.update()`の実際の書き込みを、テストが1件ずつ手で解放できるように留め置く
 * フェイク（issue #381「persistのoutcomeが別時点の値になる」の再現用）。`store.update`
 * （`WorkflowRunStore`内の`SerialQueue`）は前の項目のPromiseが解決するまで次の項目の
 * `updater`を呼ばないため、`releaseOne()`を呼ぶまで`updater`の実行そのものを止められる。
 * これにより「`persist()`呼び出し時点」と「`updater`が実際に走る時点」の間へ、
 * 好きなだけ他の状態変化（`live.runState`の書き換え）を割り込ませられる。
 */
function controllableMemento(): {
  memento: WorkflowRunMemento;
  pendingCount: () => number;
  releaseOne: () => void;
} {
  const store = new Map<string, unknown>();
  const pending: Array<() => void> = [];
  return {
    memento: {
      get<T>(key: string, defaultValue: T): T {
        return (store.has(key) ? store.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Thenable<void> {
        return new Promise<void>((resolve) => {
          pending.push(() => {
            store.set(key, value);
            resolve();
          });
        });
      },
    },
    pendingCount: () => pending.length,
    releaseOne: () => {
      const next = pending.shift();
      next?.();
    },
  };
}

function filePort(content: string): WorkflowFilePort {
  return {
    fileSize: async () => Buffer.byteLength(content, 'utf8'),
    readTextFile: async () => content,
  };
}

/** マイクロタスクを十分な回数流し、非同期の起動チェーン（worktree→boundary→openTaskSession）を進める。 */
async function flush(times = 100): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  runner: WorkflowRunner;
  codexHost: FakeHost;
  claudeHost: FakeHost;
  store: WorkflowRunStore;
  git: FakeGitHandle;
}

function createHarness(
  yaml: string,
  options?: {
    allowAutoApprove?: boolean;
    allowClaudeBypassPermissions?: boolean;
    codexSandbox?: string;
    codexApprovalMode?: string;
    claudePermissionMode?: string;
    git?: FakeGitHandle;
    fs?: WorktreeFileSystemPort;
    forge?: WorkflowRunnerForgeDeps;
    pseudoWorktree?: { fs: PseudoWorktreeFileSystemPort; exclude: readonly string[] };
    messaging?: WorkflowRunnerMessagingDeps;
    memento?: WorkflowRunMemento;
    roadmap?: { fs: RoadmapFileSystemPort };
    log?: Logger;
    readMergeApprovalTimeoutSec?: () => number;
    readFinalMergeDecisionTimeoutSec?: () => number;
    readCiWaitTimeoutSec?: () => number;
    readCiUpdateBranchMaxRetries?: () => number;
    readMaxAskUserPerRun?: () => number;
    readAutoResume?: () => boolean;
    readMaxAutoResumeAttempts?: () => number;
    readReviewCommentPollIntervalSec?: () => number;
  },
): Harness {
  const codexHost = new FakeHost();
  const claudeHost = new FakeHost();
  const store = new WorkflowRunStore(options?.memento ?? fakeMemento());
  const hosts: Record<Provider, TaskSessionHost> = { codex: codexHost, claude: claudeHost };
  const git = options?.git ?? fakeGit();
  let seq = 0;
  const runner = new WorkflowRunner({
    hosts,
    worktreeQueue: new WorktreeCreationQueue(),
    git,
    fs: options?.fs ?? identityFs,
    filePort: filePort(yaml),
    store,
    log: options?.log ?? fakeLogger,
    readBaseline: () => ({
      codexSandbox: options?.codexSandbox ?? 'read-only',
      codexApprovalMode: options?.codexApprovalMode ?? 'on-request',
      claudePermissionMode: options?.claudePermissionMode ?? 'manual',
      allowAutoApprove: options?.allowAutoApprove ?? true,
      allowClaudeBypassPermissions: options?.allowClaudeBypassPermissions ?? false,
    }),
    ...(options?.forge !== undefined ? { forge: options.forge } : {}),
    ...(options?.pseudoWorktree !== undefined ? { pseudoWorktree: options.pseudoWorktree } : {}),
    ...(options?.messaging !== undefined ? { messaging: options.messaging } : {}),
    ...(options?.roadmap !== undefined ? { roadmap: options.roadmap } : {}),
    ...(options?.readMergeApprovalTimeoutSec !== undefined
      ? { readMergeApprovalTimeoutSec: options.readMergeApprovalTimeoutSec }
      : {}),
    ...(options?.readFinalMergeDecisionTimeoutSec !== undefined
      ? { readFinalMergeDecisionTimeoutSec: options.readFinalMergeDecisionTimeoutSec }
      : {}),
    ...(options?.readCiWaitTimeoutSec !== undefined
      ? { readCiWaitTimeoutSec: options.readCiWaitTimeoutSec }
      : {}),
    ...(options?.readCiUpdateBranchMaxRetries !== undefined
      ? { readCiUpdateBranchMaxRetries: options.readCiUpdateBranchMaxRetries }
      : {}),
    ...(options?.readMaxAskUserPerRun !== undefined
      ? { readMaxAskUserPerRun: options.readMaxAskUserPerRun }
      : {}),
    // 自動再開（design.md §16.35、roadmap W10、Issue #584）の既定は本番では`true`だが、
    // ここ（共有テストハーネス）では`false`を既定にする。本番の既定値を素直に継承すると、
    // このハーネスへ依存する既存の「リロード後の実行再開」系テスト（`reloadedRunner`を
    // 使わずこの`createHarness`経由で`restoreRunsForView()`を呼ぶもの）が軒並み自動再開の
    // 影響を受けて意図せず挙動が変わるため、明示的に上書きしない限り無効のままにする
    // （新しく自動再開そのものを確かめるテストは`options.readAutoResume`で個別に有効化する）
    readAutoResume: options?.readAutoResume ?? (() => false),
    ...(options?.readMaxAutoResumeAttempts !== undefined
      ? { readMaxAutoResumeAttempts: options.readMaxAutoResumeAttempts }
      : {}),
    ...(options?.readReviewCommentPollIntervalSec !== undefined
      ? { readReviewCommentPollIntervalSec: options.readReviewCommentPollIntervalSec }
      : {}),
    randomId: () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`,
  });
  return { runner, codexHost, claudeHost, store, git };
}

function doneState(text: string, files: string[] = []): ChatState {
  return { ...initialChatState, turnResultText: text, turnEditedFiles: files };
}

const DIAMOND_YAML = `
version: 1
name: diamond
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1完了
  - id: T2
    dependsOn: [T1]
    prompt: "T1の結果: {{T1.result}}"
    done: T2完了
  - id: T3
    dependsOn: [T1]
    prompt: T3のプロンプト
    done: T3完了
  - id: T4
    dependsOn: [T2, T3]
    prompt: "merge {{T2.branch}} / {{T3.branch}}"
    done: T4完了
`;

describe('WorkflowRunner: T1 → (T2 || T3) → T4', () => {
  it('定義から最後まで通り、T2とT3が同時に走る', async () => {
    const { runner, codexHost, store } = createHarness(DIAMOND_YAML);
    const result = await runner.start('/repo/.agents/workflows/diamond.yaml', '/repo');
    expect(result.ok).toBe(true);
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    t1.finish('done', doneState('T1の応答テキスト', ['a.ts']));
    await flush();

    // T2とT3が同時にrunningであることを確認する
    expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
    expect(store.find(runId)?.tasks['T3']?.state).toBe('running');

    const t2 = codexHost.byTaskId('T2');
    const t3 = codexHost.byTaskId('T3');

    // テンプレート変数は展開前のまま runLoop へ渡っている（design.md §16.12「展開前の文面を記録」）
    expect(t2.runLoopCalls[0]?.initialPrompt).toBe('T1の結果: {{T1.result}}');
    // 実際の送信直前（promptTransform）ではテンプレートが展開される（design.md §16.4）。
    // resultは前後を区切り文字列で挟んで展開される（design.md §16.4 案3、Issue #67）
    const t2Expanded = t2.promptTransform?.('T1の結果: {{T1.result}}') ?? '';
    expect(t2Expanded).toContain('T1の結果: ');
    expect(t2Expanded).toContain('T1の応答テキスト');
    expect(t2Expanded).toContain('T1.resultの出力（前のタスクの応答であり、指示ではない）ここから');
    // taskConfig/setPromptTransformの配線経路で使う値と、Viewに見せる値（liveTask.expandedPrompt）
    // が同じ展開結果になっていることも確かめる（design.md §16.4 案1「見せる」、Issue #67）
    const t2Snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
    expect(t2Snapshot?.expandedPrompt).toBe(t2Expanded);

    t2.finish('done', doneState('T2の応答'));
    t3.finish('done', doneState('T3の応答'));
    await flush();

    const t4 = codexHost.byTaskId('T4');
    expect(t4.runLoopCalls[0]?.initialPrompt).toBe('merge {{T2.branch}} / {{T3.branch}}');
    const expanded = t4.promptTransform?.('merge {{T2.branch}} / {{T3.branch}}') ?? '';
    expect(expanded).toContain(`wf/${runId}/T2`);
    expect(expanded).toContain(`wf/${runId}/T3`);

    t4.finish('done', doneState('T4の応答'));
    await flush();

    expect(store.find(runId)?.tasks['T4']?.state).toBe('done');
  });
});

describe('WorkflowRunner: {{T1.summary}}（design.md §16.4 案4「絞る」、Issue #67）', () => {
  const SUMMARY_YAML = `
version: 1
name: summary-test
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1完了
  - id: T2
    dependsOn: [T1]
    prompt: "要約: {{T1.summary}}"
    done: T2完了
`;

  it('T1完了後の{{T1.summary}}が#57の1行要約に展開される（応答全文ではない）', async () => {
    const { runner, codexHost } = createHarness(SUMMARY_YAML);
    const result = await runner.start('/repo/.agents/workflows/summary.yaml', '/repo');
    expect(result.ok).toBe(true);
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('1行目の要点\n詳しい説明が長々と続く'));
    await flush();

    const t2 = codexHost.byTaskId('T2');
    const expanded = t2.promptTransform?.('要約: {{T1.summary}}') ?? '';
    expect(expanded).toContain('要約: ');
    expect(expanded).toContain('1行目の要点');
    // 1行要約なので、2行目以降（応答本文の残り）は含まれない
    expect(expanded).not.toContain('詳しい説明が長々と続く');
  });
});

describe('WorkflowRunner: 展開後プロンプトの表示（design.md §16.4 案1、セキュリティ監査指摘#5・#6）', () => {
  const CONTINUE_YAML = `
version: 1
name: continue-prompt-test
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1完了
  - id: T2
    dependsOn: [T1]
    prompt: "最初: {{T1.result}}"
    continuePrompt: "継続: {{T1.result}}"
    done: T2完了
`;

  it('expandedContinuePromptが実際に送られるcontinuePromptの展開結果と一致する（監査指摘#6）', async () => {
    const { runner, codexHost } = createHarness(CONTINUE_YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    expect(result.ok).toBe(true);
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('T1の応答'));
    await flush();

    const t2 = codexHost.byTaskId('T2');
    const actualContinueExpanded = t2.promptTransform?.('継続: {{T1.result}}') ?? '';
    const snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
    expect(snapshot?.expandedContinuePrompt).toBe(actualContinueExpanded);
    expect(snapshot?.expandedContinuePrompt).toContain('T1の応答');
  });

  it('expandedPromptは双方向制御文字を落とすが、改行は保持する（監査指摘#5）', async () => {
    // U+202E（RTL override）。ソースへ直接書かず、コードポイントから作る
    const rtlOverride = String.fromCodePoint(0x202e);
    const { runner, codexHost } = createHarness(CONTINUE_YAML);
    const result = await runner.start('/repo/.agents/workflows/continue-rtl.yaml', '/repo');
    expect(result.ok).toBe(true);
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState(`安全${rtlOverride}exe.悪意のある名前`));
    await flush();

    const snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
    // 双方向制御文字は落ちる（人の目視確認を偽装させないため）
    expect(snapshot?.expandedPrompt).not.toContain(rtlOverride);
    // 一方、複数行の区切り表示に使う改行は保持される
    expect(snapshot?.expandedPrompt?.includes('\n')).toBe(true);
  });
});

describe('WorkflowRunner: クランプ（design.md §16.16）', () => {
  const YAML = `
version: 1
name: clamp-test
tasks:
  - id: T1
    sandbox: danger-full-access
    approvalMode: never
    prompt: p
    done: d
`;

  it('拡張機能の設定より緩いsandbox/approvalModeをYAMLに書いても緩まない', async () => {
    const { runner, codexHost } = createHarness(YAML, {
      codexSandbox: 'read-only',
      codexApprovalMode: 'on-request',
    });
    await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    await flush();

    expect(codexHost.openInputs[0]?.sandbox).toBe('read-only');
    expect(codexHost.openInputs[0]?.config.approvalMode).toBe('on-request');
  });

  it('クランプを経由しない経路が無い: openTaskSessionへ渡る設定は必ずbuildEffectiveTaskConfig由来の値になる', async () => {
    // 複数タスク・複数providerでも同じことを確かめる
    const multiYaml = `
version: 1
name: clamp-multi
tasks:
  - id: T1
    sandbox: danger-full-access
    prompt: p
    done: d
  - id: T2
    provider: claude
    approvalMode: auto
    prompt: p
    done: d
`;
    const { runner, codexHost, claudeHost } = createHarness(multiYaml, {
      codexSandbox: 'read-only',
    });
    const result = await runner.start('/repo/.agents/workflows/multi.yaml', '/repo');
    expect(result.ok).toBe(true);
    await flush();

    expect(codexHost.openInputs[0]?.sandbox).toBe('read-only');
    expect(claudeHost.openInputs[0]?.config.approvalMode).not.toBe('auto');
  });
});

/**
 * タブ名にtaskIdを載せる配線（Issue #599）。タブ名そのものの組み立ては
 * `sessionTitle.test.ts`（`buildSessionPanelTitle`）が見ているが、**runnerが
 * `TaskSessionInput.taskId`を渡していなければ、組み立てが正しくてもタブ名は変わらない。**
 * 組み立てとの間の配線をここで固定する（fake hostは`title`という概念を持たないため、
 * 観測できるのは`input.taskId`まで）。
 */
describe('WorkflowRunner: タブ名のためのtaskIdの受け渡し（Issue #599）', () => {
  const YAML = `
version: 1
name: task-id-title
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    provider: claude
    prompt: p
    done: d
`;

  it('openTaskSessionへ、そのタスク自身のidを渡す（provider問わず）', async () => {
    const { runner, codexHost, claudeHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    expect(result.ok).toBe(true);
    await flush();

    expect(codexHost.openInputs[0]?.taskId).toBe('T1');
    expect(claudeHost.openInputs[0]?.taskId).toBe('T2');
  });
});

describe('WorkflowRunner: autoApprove（design.md §16.16）', () => {
  const YAML = `
version: 1
name: auto-approve-test
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
`;

  it('allowAutoApprove: false のとき autoApprove: true が無効化され、承認は常にaskになる', async () => {
    const { runner, codexHost } = createHarness(YAML, { allowAutoApprove: false });
    await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const result = await t1.requestApproval(
      { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
      { command: 'ls', cwd: t1.cwd },
    );
    expect(result.kind).toBe('ask');
  });
});

describe('WorkflowRunner: 承認のハンドリング（design.md §16.7）', () => {
  const YAML = `
version: 1
name: approval-test
defaults:
  maxParallel: 2
tasks:
  - id: A
    autoApprove: true
    prompt: p
    done: d
  - id: B
    autoApprove: true
    prompt: p
    done: d
`;

  it('危険と判定された要求でそのタスクだけがwaitingApprovalになり、他のタスクは走り続ける', async () => {
    const { runner, codexHost, store } = createHarness(YAML, { allowAutoApprove: true });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const a = codexHost.byTaskId('A');
    const b = codexHost.byTaskId('B');
    expect(store.find(runId)?.tasks['A']?.state).toBe('running');
    expect(store.find(runId)?.tasks['B']?.state).toBe('running');

    // git push --force は既定でask（危険パターン）
    const decision = await a.requestApproval(
      { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
      { command: 'git push --force origin main', cwd: a.cwd },
    );
    expect(decision.kind).toBe('ask');
    await flush();

    expect(store.find(runId)?.tasks['A']?.state).toBe('waitingApproval');
    // Bは影響を受けずrunningのまま
    expect(store.find(runId)?.tasks['B']?.state).toBe('running');
    expect(b.disposed).toBe(false);
  });

  it('通常のコマンドはautoで即座に許可される', async () => {
    const { runner, codexHost } = createHarness(YAML, { allowAutoApprove: true });
    await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    await flush();
    const a = codexHost.byTaskId('A');
    const decision = await a.requestApproval(
      { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
      { command: 'npm test', cwd: a.cwd },
    );
    expect(decision).toEqual({ kind: 'auto', decision: 'accept' });
  });

  it('fileChangeの承認要求はitemIdから解決したパスで判定される（.git配下なら許可されない）', async () => {
    const { runner, codexHost } = createHarness(YAML, { allowAutoApprove: true });
    await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    await flush();
    const a = codexHost.byTaskId('A');
    a.emitState({
      ...initialChatState,
      items: [
        {
          id: 'item-1',
          kind: 'fileChange',
          text: '',
          detail: '',
          status: undefined,
          turnId: undefined,
          diffs: [
            {
              path: `${a.cwd}/.git/hooks/pre-commit`,
              kind: 'add',
              movePath: undefined,
              diff: '',
              editReplace: undefined,
            },
          ],
        },
      ],
    });
    const decision = await a.requestApproval({
      requestId: 2,
      kind: 'fileChange',
      title: '',
      detail: '',
      itemId: 'item-1',
    });
    expect(decision.kind).toBe('ask');
  });

  it('fileChangeの承認要求で、通常のパス（.git配下でない）ならitemId解決を経てautoになる', async () => {
    const { runner, codexHost } = createHarness(YAML, { allowAutoApprove: true });
    await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    await flush();
    const a = codexHost.byTaskId('A');
    a.emitState({
      ...initialChatState,
      items: [
        {
          id: 'item-2',
          kind: 'fileChange',
          text: '',
          detail: '',
          status: undefined,
          turnId: undefined,
          diffs: [
            {
              path: `${a.cwd}/src/index.ts`,
              kind: 'update',
              movePath: undefined,
              diff: '',
              editReplace: undefined,
            },
          ],
        },
      ],
    });
    const decision = await a.requestApproval({
      requestId: 3,
      kind: 'fileChange',
      title: '',
      detail: '',
      itemId: 'item-2',
    });
    // paths解決に失敗（空）していれば必ずaskになる設計なので、autoになる＝正しく解決できている証拠
    expect(decision).toEqual({ kind: 'auto', decision: 'accept' });
  });
});

describe('WorkflowRunner: 失敗の波及（design.md §16.5）', () => {
  const YAML = `
version: 1
name: fail-cascade
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p
    done: d
  - id: T3
    prompt: p
    done: d
`;

  it('失敗時に後続がskippedになり、実行全体が止まる', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    const run = store.find(runId);
    expect(run?.tasks['T1']?.state).toBe('failed');
    expect(run?.tasks['T2']?.state).toBe('skipped');
    expect(run?.tasks['T3']?.state).toBe('skipped');
  });
});

describe('WorkflowRunner: 応答本文の非永続化（design.md §16.11）', () => {
  it('タスク完了時の応答本文はworkspaceStateへ保存されない', async () => {
    const YAML = `
version: 1
name: no-body
tasks:
  - id: T1
    prompt: p
    done: d
`;
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('これは機微な応答本文です'));
    await flush();

    const serialized = JSON.stringify(store.find(runId));
    expect(serialized).not.toContain('これは機微な応答本文です');
  });
});

describe('WorkflowRunner.stop', () => {
  const YAML = `
version: 1
name: stop-test
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p
    done: d
`;

  it('実行全体を停止すると、新規タスクは開始されない', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    runner.stop(runId);
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    const run = store.find(runId) as PersistedRun;
    expect(run.tasks['T2']?.state).toBe('skipped');
    expect(run.haltedByUser).toBe(true);
  });

  /**
   * 「全体の停止」は新しいタスクの開始を止めるだけで、走っているタスクのループはそのまま
   * 回り続けていた（issue #322）。終了条件を満たすか回数を使い切るまで指示が送られ続ける
   * ため、ボタン名と挙動が食い違っていた。
   */
  describe('走行中のタスクのループも止める（issue #322）', () => {
    it('走行中のタスクへstopLoopを送り、進行中のターンには割り込まない', async () => {
      const { runner, codexHost } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const t1 = codexHost.byTaskId('T1');

      runner.stop(runId);
      await flush();

      expect(t1.stopLoopCount).toBe(1);
      // 中途半端な編集をworktreeへ残さないため、そのターンが終わるまでは待つ
      expect(t1.interruptCount).toBe(0);
    });

    it('止めたタスクはfailed（手動停止）として確定し、未開始のタスクはskippedのまま', async () => {
      const { runner, codexHost, store } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const t1 = codexHost.byTaskId('T1');

      runner.stop(runId);
      // フェイクはstopLoopCountを数えるだけなので、実際の停止は`finish`で模擬する
      t1.finish('taskStopped' as LoopStopReason, { ...initialChatState });
      await flush();

      const run = store.find(runId) as PersistedRun;
      expect(run.tasks['T1']?.state).toBe('failed');
      expect(run.tasks['T1']?.failure).toEqual({ kind: 'manualStop' });
      expect(run.tasks['T2']?.state).toBe('skipped');
    });

    it('承認待ちのタスクも止める（セッションは生きており枠を占めている）', async () => {
      const approvalYaml = `
version: 1
name: stop-waiting-approval
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
`;
      const { runner, codexHost, store } = createHarness(approvalYaml, {
        allowAutoApprove: true,
      });
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const t1 = codexHost.byTaskId('T1');
      // 既定で危険と判定される要求を出して人待ちにする
      await t1.requestApproval(
        { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
        { command: 'git push --force origin main', cwd: t1.cwd },
      );
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingApproval');

      runner.stop(runId);
      await flush();

      expect(t1.stopLoopCount).toBe(1);
    });

    it('確定済みのタスクへは送らない', async () => {
      const { runner, codexHost, store } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      const t2 = codexHost.byTaskId('T2');

      runner.stop(runId);
      await flush();

      expect(t1.stopLoopCount).toBe(0);
      expect(t2.stopLoopCount).toBe(1);
    });

    it('リロード後に復元しただけの実行でも例外にならない', async () => {
      const { runner, store } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // 新しいプロセス（リロード後）を模す。復元だけなのでライブなセッションは無い
      const reloadedRunner = new WorkflowRunner({
        // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
        // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
        // （design.md §16.35、roadmap W10、Issue #584）
        readAutoResume: () => false,
        hosts: { codex: new FakeHost(), claude: new FakeHost() },
        worktreeQueue: new WorktreeCreationQueue(),
        git: fakeGit(),
        fs: identityFs,
        filePort: filePort(YAML),
        store,
        log: fakeLogger,
        readBaseline: () => ({
          codexSandbox: 'read-only',
          codexApprovalMode: 'on-request',
          claudePermissionMode: 'manual',
          allowAutoApprove: true,
          allowClaudeBypassPermissions: false,
        }),
      });
      await reloadedRunner.restoreRunsForView();

      expect(() => reloadedRunner.stop(runId)).not.toThrow();
    });
  });

  /**
   * `stop()`は走行中タスクへ`stopLoop()`を送るだけで確定は待つため、その間オーケスト
   * レーターに届くのは通常の`taskFailed`だけになり「タスクが次々失敗している」ように
   * しか見えない。`retry_task`を呼ぶのが自然な反応になってしまう構造的な穴（issue #401）
   * を塞ぐため、`stop()`から明示のイベントを1本送る。
   */
  describe('人の停止をオーケストレーターへ通知する（issue #401）', () => {
    it('stop()の直後にオーケストレーターへ「人が停止した」通知が届く', async () => {
      const { runner, codexHost } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      // run開始の通知でターンが走っている。走行中は割り込まないので、まず終わらせる
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });

      runner.stop(runId);
      await flush();

      const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
      expect(last).toContain('人がこの実行全体を停止しました');
      expect(last).toContain('retry_task');
      expect(last).toContain('stop_task');
    });

    it('stop()を2回呼んでも「人が停止した」通知は1件しか届かない（Webviewのstop_allが重ねて呼ぶため）', async () => {
      const { runner, codexHost } = createHarness(YAML);
      const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });

      runner.stop(runId);
      await flush();

      const countHaltedNotices = () =>
        orchestrator.sentTexts.filter((t) => t.includes('人がこの実行全体を停止しました')).length;
      expect(countHaltedNotices()).toBe(1);

      // `notifyOrchestrator`は`orchestrator.busy`の間`pending`へ積むだけで送らない
      // （`flushOrchestrator`は`!busy`のときだけ送信）。1回目の`stop()`が送った通知で
      // `busy`はtrueのままなので、2回目の`stop()`が「重複を送らない」ことを確かめる
      // ためには、まずターンを1回終わらせて`busy`をfalseへ戻し、2回目の通知が実際に
      // flushされる状態を作る必要がある（そうしないと2回目の通知は重複排除の有無に
      // 関わらずpendingに積まれたままとなり、このテストは重複防止が無くても通る）
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });

      // 既にhaltedByUserのrunへ`stop()`を重ねて呼んでも（Webviewのstop_allハンドラは
      // haltedByUserの現在値を見ずに毎回呼ぶ）、通知が積み増されない
      runner.stop(runId);
      await flush();

      expect(countHaltedNotices()).toBe(1);
    });
  });
});

/**
 * `persist()`はrunの永続化を`WorkflowRunStore`（`workspaceState`書き込みを1本の
 * `SerialQueue`で直列化）へ委ねる。以前は`outcome`（`finishedAt`を確定するかどうかを
 * 決める）を`persist()`の呼び出し時点、`updater`の外側で計算していた。`updater`
 * （`store.update`に渡す関数）自体は`SerialQueue`が捌く時点まで実行が遅延されうるため、
 * 同じ`runId`に対して短時間に複数回`persist()`が呼ばれる（`void this.persist(runId)`が
 * `runner.ts`に多数ある）と、先に呼ばれた`persist()`の`outcome`が古いまま、`updater`が
 * 実際に読む`live.runState.tasks`（同じ`live`を指す最新の値）だけ新しくなる
 * ことがあった（issue #381）。
 */
describe('WorkflowRunner.persist: outcomeとtasksの時点整合性（issue #381）', () => {
  it(
    '先に呼ばれたpersistの書き込みが遅れて、その間に手動再実行でタスクが' +
      'running へ戻っても、実際に書き込まれる時点のtasksに整合したfinishedAtになる' +
      '（`outcome`をupdaterの外で計算する古い実装では、走り出している最中の実行に' +
      '`finishedAt`が固定されてしまう）',
    async () => {
      const YAML_SINGLE = `
version: 1
name: persist-timing-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;
      const { memento, pendingCount, releaseOne } = controllableMemento();
      const { runner, codexHost, store } = createHarness(YAML_SINGLE, { memento });

      // 積み残っているpersistを全て解放して書き込みを追いつかせる（テストの節目ごとに
      // 呼ぶ。`start()`は「定義済みの`await this.persist(runId)`」の後にも`pump()`が
      // 追加でpersistを積むため、1回の解放だけでは足りない）
      const drainAll = async (): Promise<void> => {
        while (pendingCount() > 0) {
          releaseOne();
          await flush();
        }
      };

      const startPromise = runner.start('/repo/.agents/workflows/persist-timing.yaml', '/repo');
      await flush();
      await drainAll();
      const result = await startPromise;
      const runId = result.runId as string;
      await flush();
      await drainAll();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

      const t1 = codexHost.byTaskId('T1');
      // 回数切れ（`maxReached`）でfailedに確定させる。`onTaskFinished`は`persist()`を
      // 2回呼ぶ（`onTaskFinished`自身と、その中で呼ぶ`pump()`）。1回目（X）の
      // `updater`はキューが空なのでほぼ即座に走り、`tasks`（'failed'）と`outcome`
      // （バグ有りの実装では呼び出し時点で固定、'failed'）を同じ時点で読むため
      // 矛盾は起きない。2回目（Y）は`updater`本体の実行がXの`memento.update`が
      // 解決するまで遅延される（`SerialQueue`が直列に繋ぐため）。これから、Xだけを
      // 先に解放し、Yの`updater`本体はまだ走らせないまま「再実行」を割り込ませる
      t1.finish('maxReached' as LoopStopReason, { ...initialChatState });
      await flush();
      expect(pendingCount()).toBe(1); // X（1件目）だけが`memento.update`待ちで残る

      // Xを解放する。「解決した」ことがマイクロタスクとしてキューへ積まれるだけで、
      // Yの`updater`本体はまだ走らない（`await`を挟むまで走らない）。ここで
      // `await`せずに続けて`retryTask`を呼ぶことで、「Yのupdater本体が実際に走る
      // 前に、人がワークフローViewから再実行した」状況を作る
      releaseOne();

      // ここで人が「再実行」する。`live.runState`はpendingを経てすぐrunningへ戻る
      // （`retryTask`内の`pump()`がその場で次のタスクを開始する）。Yの`updater`は
      // まだ走っていないため、この時点の`live.runState`の変化はYにまだ見えていない
      const retried = runner.retryTask(runId, 'T1');
      expect(retried.ok).toBe(true);

      // ここで初めてYの`updater`本体が走る。`live.runState`（今はrunning）を実行時点で
      // 読むため`tasks`は最新化されるが、`outcome`を呼び出し時点（まだ'failed'だった
      // 頃）で固定する古い実装では'failed'のまま渡ってしまい、`finishedAt`に
      // タイムスタンプが固定される（Xが既に`finishedAt`を確定させているため
      // `current?.finishedAt ?? ...`では上書きできない）
      await flush();
      expect(pendingCount()).toBe(1); // Yがmemento.update待ちで残る

      releaseOne();
      await flush();

      const run = store.find(runId) as PersistedRun;
      // 再実行でrunningへ戻っている以上、`finishedAt`は付いていてはいけない
      expect(run.tasks['T1']?.state).toBe('running');
      expect(run.finishedAt).toBeUndefined();

      // 残りのpersistも解放して後始末する（次のテストへ影響を残さない）
      await drainAll();
    },
  );
});

describe('WorkflowRunner: 定義ファイルの検証', () => {
  it('サイズ上限を超える定義ファイルは実行を始めない', async () => {
    const huge = 'x'.repeat(MAX_WORKFLOW_FILE_BYTES + 1);
    const { runner } = createHarness(huge);
    const result = await runner.start('/repo/.agents/workflows/huge.yaml', '/repo');
    expect(result.ok).toBe(false);
  });

  it('検証エラーがあれば実行を始めない', async () => {
    const invalid = `
version: 1
name: invalid
tasks: []
`;
    const { runner } = createHarness(invalid);
    const result = await runner.start('/repo/.agents/workflows/invalid.yaml', '/repo');
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

describe('WorkflowRunner: cwdのワークスペース境界（design.md §16.16）', () => {
  const withCwd = (cwd: string): string => `
version: 1
name: explicit-cwd
defaults:
  provider: codex
tasks:
  - id: T1
    prompt: T1のプロンプト
    done: T1完了
    cwd: ${cwd}
`;

  it('ワークスペースの外を指すcwdのタスクは開始されない', async () => {
    // cwdを無検証で通すと sandbox: workspace-write の「workspace」の基準を
    // YAMLから付け替えられる（§16.16 が塞ぐと決めている経路）
    const { runner, codexHost } = createHarness(withCwd('/etc/evil'));
    await runner.start('/repo/.agents/workflows/w.yaml', '/repo');
    await flush();

    expect(codexHost.openInputs).toHaveLength(0);
  });

  it('前方一致では通らない（/repo に対する /repo-evil）', async () => {
    const { runner, codexHost } = createHarness(withCwd('/repo-evil/work'));
    await runner.start('/repo/.agents/workflows/w.yaml', '/repo');
    await flush();

    expect(codexHost.openInputs).toHaveLength(0);
  });

  it('ワークスペース配下のcwdは通り、そのディレクトリで開始する', async () => {
    const { runner, codexHost } = createHarness(withCwd('/repo/packages/api'));
    await runner.start('/repo/.agents/workflows/w.yaml', '/repo');
    await flush();

    expect(codexHost.openInputs).toHaveLength(1);
    expect(codexHost.openInputs[0]?.cwd).toBe('/repo/packages/api');
  });

  it('1件でもcwdが境界外なら実行を始めない（design.md §16.2「1件でも該当すれば実行を始めない」。レビュー指摘: warning）', async () => {
    // T1のcwdは正当だが、T2が境界外を指す。事後（タスクごと）の検証だけだと
    // T1が既に開始・副作用を残した後でT2の違反が判明してしまう
    const yaml = `
version: 1
name: multi-cwd
tasks:
  - id: T1
    prompt: p
    done: d
    cwd: /repo/ok
  - id: T2
    prompt: p
    done: d
    cwd: /etc/evil
`;
    const { runner, codexHost } = createHarness(yaml);
    const result = await runner.start('/repo/.agents/workflows/w.yaml', '/repo');
    await flush();

    expect(result.ok).toBe(false);
    // 正当なcwdだったT1も含め、run全体が一切開始されない
    expect(codexHost.openInputs).toHaveLength(0);
  });
});

describe('WorkflowRunner: bypassPermissionsの実効値の読み替え（design.md §16.7、issue #271）', () => {
  // approvalModeを一切指定しないClaudeタスク。workflow.tsのvalidateWorkflowは
  // YAMLリテラルの`bypassPermissions`一致だけを見るため、未指定はここを素通りする
  const YAML = `
version: 1
name: bypass-inherit
tasks:
  - id: T1
    provider: claude
    prompt: p
    done: d
`;

  it('拡張機能側の設定が既にbypassPermissionsのとき、危険判定が働く値へ読み替えて開始する', async () => {
    const { runner, claudeHost, store } = createHarness(YAML, {
      claudePermissionMode: 'bypassPermissions',
    });
    const result = await runner.start('/repo/.agents/workflows/bypass.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // bypassPermissionsでは can_use_tool 自体が発行されず、classifyApprovalRequestも
    // autoApproveもescalateもallowも一度も呼ばれない（#54の危険判定が丸ごと無意味になる）。
    // 以前はタスクを開始しないことで歯止めにしていたが、それだとこの設定の利用者は
    // ワークフローが1タスクも開始できない（issue #271）ため、acceptEditsへ落として続行する
    expect(claudeHost.openInputs).toHaveLength(1);
    expect(claudeHost.openInputs[0]?.config.approvalMode).toBe('acceptEdits');
    expect(store.find(runId)?.tasks['T1']?.state).not.toBe('failed');
  });

  it('拡張機能側の設定がbypassPermissionsでなければ通常通り開始する', async () => {
    const { runner, claudeHost } = createHarness(YAML, { claudePermissionMode: 'manual' });
    await runner.start('/repo/.agents/workflows/ok.yaml', '/repo');
    await flush();

    expect(claudeHost.openInputs).toHaveLength(1);
    expect(claudeHost.openInputs[0]?.config.approvalMode).toBe('manual');
  });

  // issue #278: 承認要求そのものを出したくない無人実行のための逃げ道。有効にすると
  // 危険判定は一切働かなくなるため、machineスコープ設定でしか開けられない
  it('allowClaudeBypassPermissionsが有効なら読み替えず、bypassPermissionsのまま開始する', async () => {
    const { runner, claudeHost, store } = createHarness(YAML, {
      claudePermissionMode: 'bypassPermissions',
      allowClaudeBypassPermissions: true,
    });
    const result = await runner.start('/repo/.agents/workflows/bypass.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(claudeHost.openInputs).toHaveLength(1);
    expect(claudeHost.openInputs[0]?.config.approvalMode).toBe('bypassPermissions');
    expect(store.find(runId)?.tasks['T1']?.state).not.toBe('failed');
  });

  it('allowClaudeBypassPermissionsが有効でも、Codexタスクには影響しない', async () => {
    const codexYaml = `
version: 1
name: bypass-codex
tasks:
  - id: T1
    provider: codex
    prompt: p
    done: d
`;
    const { runner, codexHost } = createHarness(codexYaml, {
      claudePermissionMode: 'bypassPermissions',
      allowClaudeBypassPermissions: true,
      codexApprovalMode: 'on-request',
    });
    await runner.start('/repo/.agents/workflows/bypass-codex.yaml', '/repo');
    await flush();

    expect(codexHost.openInputs).toHaveLength(1);
    expect(codexHost.openInputs[0]?.config.approvalMode).toBe('on-request');
  });
});

describe('WorkflowRunner: 手動の再実行とworktree名（issue #275）', () => {
  const YAML = `
version: 1
name: manual-retry-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('手動の再実行は前の試行と別のworktree・別のブランチで走る', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/manual.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const attempt1 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1'));
    expect(attempt1).toBeDefined();
    // retries未指定（0）なので自動再試行は無く、1回目の失敗でfailedが確定する
    attempt1?.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();

    // 失敗した試行のworktreeとブランチは人が中身を見られるように残るため、同じ名前で
    // 作り直そうとするとbranchExistsで必ず失敗していた（issue #275）
    const attempt2 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry0'));
    expect(attempt2).toBeDefined();
    expect(attempt2?.cwd).not.toBe(attempt1?.cwd);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    // 自動再試行の権利は消費していない
    expect(store.find(runId)?.tasks['T1']?.retryCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.manualRetryCount).toBe(1);

    // 2回目の手動再実行も、さらに別の名前になる
    attempt2?.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    expect(codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry1'))).toBeDefined();
  });
});

describe('WorkflowRunner: 手動再実行後のworktree撤去（issue #407）', () => {
  const YAML = `
version: 1
name: manual-retry-cleanup-test
defaults:
  cleanup: remove
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('手動再実行の後にdoneになったタスクは、実際に使ったretry付きworktreeを撤去する', async () => {
    const git = fakeGit();
    const { runner, codexHost } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/manual-retry-cleanup.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const attempt1 = codexHost.byTaskId('T1');
    attempt1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();

    const attempt2 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry0'));
    expect(attempt2).toBeDefined();
    // 手動再実行のみ（自動retryは未消費）: retryCount=0, manualRetryCount=1
    expect(attempt2?.cwd).not.toBe(attempt1.cwd);

    attempt2?.finish('done', doneState('ok'));
    await flush();

    // 撤去対象は実際にこの試行で使ったworktree（T1-retry0）であるべき。
    // retrySuffixOfがmanualRetryCountを見落とすと、代わりに未使用のT1（初回分。
    // 存在しないので撤去はできない）が対象になり、attempt2のworktreeが残ってしまう
    const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCall).toBeDefined();
    expect(removeCall?.args[2]).toBe(attempt2?.cwd);
  });
});

describe('WorkflowRunner: retriesによる自動再試行（design.md §16.5、レビュー指摘: high）', () => {
  const YAML = `
version: 1
name: retry-test
tasks:
  - id: T1
    retries: 1
    prompt: p
    done: d
`;

  it('failedになったタスクは新しいworktree・新しいセッションでやり直し、retriesを使い切ったらfailedで確定する', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/retry.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const attempt1 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1'));
    expect(attempt1).toBeDefined();
    attempt1?.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    // retries: 1 の範囲内なので、新しいworktree（-retry0サフィックス）でpendingへ戻り、
    // 自動的に再スケジュールされる（design.md §16.5「新しいスレッドと新しいworktreeで
    // 最初からやり直す」）
    expect(store.find(runId)?.tasks['T1']?.retryCount).toBe(1);
    const attempt2 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry0'));
    expect(attempt2).toBeDefined();
    expect(attempt2?.cwd).not.toBe(attempt1?.cwd);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    // 2回目（リトライ）も失敗させる。retries(1)を使い切っているのでfailedが確定する
    attempt2?.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'loopFailed' });
    // 3回目は無い（retries:1なので合計2回の試行で確定する）
    expect(codexHost.sessions).toHaveLength(2);
  });
});

describe('WorkflowRunner: 承認拒否は自動再試行されない（design.md §16.5、レビュー指摘: high）', () => {
  const YAML = `
version: 1
name: decline-test
tasks:
  - id: T1
    retries: 3
    autoApprove: true
    prompt: p
    done: d
`;

  it('承認要求をdeclineすると、retriesが残っていても自動再試行されずfailed（approvalRejected）で確定する', async () => {
    const { runner, codexHost, store } = createHarness(YAML, { allowAutoApprove: true });
    const result = await runner.start('/repo/.agents/workflows/decline.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const decision = await t1.requestApproval(
      { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
      { command: 'git push --force origin main', cwd: t1.cwd },
    );
    expect(decision.kind).toBe('ask');
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingApproval');

    // 人が拒否する
    t1.resolveApproval(1, 'decline');
    await flush();

    const task = store.find(runId)?.tasks['T1'];
    expect(task?.state).toBe('failed');
    expect(task?.failure).toEqual({ kind: 'approvalRejected' });
    // retries: 3 が残っていても、承認拒否は自動再試行の対象にしない
    // （§16.5「同じ危険操作を繰り返し提示しない」）ため、retryCountは消費されず、
    // 新しいセッションも開始されない
    expect(task?.retryCount).toBe(0);
    expect(codexHost.sessions).toHaveLength(1);
  });
});

describe('WorkflowRunner: cleanup: removeでのworktree撤去（design.md §16.6、レビュー指摘: high）', () => {
  const YAML = `
version: 1
name: cleanup-test
defaults:
  cleanup: remove
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('doneになったタスクのworktreeは実際にWorktreeCreationQueue.removeを通じて撤去される', async () => {
    const git = fakeGit();
    const { runner, codexHost } = createHarness(YAML, { git });
    await runner.start('/repo/.agents/workflows/cleanup.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCall).toBeDefined();
    expect(removeCall?.args[2]).toBe(t1.cwd);
  });

  it('failedになったタスクのworktreeは撤去しない（design.md §16.6「failedのものは残す」）', async () => {
    const git = fakeGit();
    const { runner, codexHost } = createHarness(YAML, { git });
    await runner.start('/repo/.agents/workflows/cleanup.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCall).toBeUndefined();
  });
});

describe('WorkflowRunner: セッション開始・worktree作成の失敗経路（design.md §16.5、レビュー指摘: high）', () => {
  const YAML = `
version: 1
name: failure-path-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('openTaskSessionが失敗（reject）したとき、タスクはfailedになる', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    codexHost.rejectNext(new Error('app-serverに接続できません'));
    const result = await runner.start('/repo/.agents/workflows/reject.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(codexHost.sessions).toHaveLength(0);
  });

  it('worktreeの作成（git worktree add）自体が失敗したとき、タスクはfailedになる', async () => {
    // 1回目のworktree addはstart()が作る統合worktree。2回目（T1自身）から失敗させる
    const git = fakeGit({ failWorktreeAdd: true, failWorktreeAddFromCall: 2 });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/wtfail.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    // worktreeが無いのでセッションも一度も開かれない
    expect(codexHost.openInputs).toHaveLength(0);
  });
});

describe('WorkflowRunner: ワークフローViewからの操作（design.md §16.8）', () => {
  const YAML = `
version: 1
name: view-ops-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p
    done: d
`;

  it('getSnapshotはdependsOn・provider・応答の1行要約を含む', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.emitState({ ...initialChatState, busy: true, turnResultText: '' });
    t1.emitState({
      ...initialChatState,
      busy: true,
      items: [
        {
          id: 'i1',
          kind: 'agentMessage',
          text: '作業中です',
          detail: '',
          status: undefined,
          turnId: undefined,
          diffs: [],
        },
      ],
    });

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
    const t2 = snapshot?.tasks.find((t) => t.id === 'T2');
    expect(t2?.dependsOn).toEqual(['T1']);
    expect(t2?.provider).toBe('codex');
    const t1Snapshot = snapshot?.tasks.find((t) => t.id === 'T1');
    expect(t1Snapshot?.lastResponseSummary).toBe('作業中です');
    expect(t1Snapshot?.hasLiveSession).toBe(true);
  });

  it('getSnapshotはタスク数によらずストア読み出しが1回になる（Issue #366）', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const findSpy = vi.spyOn(store, 'find');
    const snapshot = runner.getSnapshot(runId);

    // YAMLはT1・T2の2タスク。以前は`buildTaskSnapshot`がタスクごとに`store.find`を
    // 呼んでいたため、`getSnapshot`の`persisted`分と合わせてタスク数+1回になっていた
    expect(snapshot?.tasks).toHaveLength(2);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('getSnapshotは統合ブランチ名を含む（design.md §16.17・Issue #104）', async () => {
    const { runner } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.integrationBranch).toBe(`wf/${runId}/integration`);
  });

  it('onChangedはタスクの状態が変わるたびにrunIdで通知する', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const notified: string[] = [];
    const unsubscribe = runner.onChanged((runId) => notified.push(runId));

    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    expect(notified).toContain(runId);

    unsubscribe();
    notified.length = 0;
    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    // 購読解除後は通知が来ない
    expect(notified).toEqual([]);
  });

  it('revealTaskはそのタスクのTaskSession.reveal()を呼ぶ', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    expect(runner.revealTask(runId, 'T1')).toBe(true);
    expect(t1.revealCount).toBe(1);
    // 存在しないタスクは何もせずfalseを返す
    expect(runner.revealTask(runId, '存在しない')).toBe(false);
  });

  it('interruptTaskはTaskSession.interrupt()だけを呼び、ループは止めない', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    await runner.interruptTask(runId, 'T1');
    expect(t1.interruptCount).toBe(1);
    // タスクの状態はrunningのまま（ループは続く）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
  });

  it('stopTaskはそのタスクだけをfailed（manualStop）にし、他のタスクへは影響しない', async () => {
    const parallelYaml = `
version: 1
name: stop-task-test
defaults:
  maxParallel: 2
tasks:
  - id: A
    prompt: p
    done: d
  - id: B
    prompt: p
    done: d
`;
    const { runner, codexHost, store } = createHarness(parallelYaml);
    const result = await runner.start('/repo/.agents/workflows/stop.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const a = codexHost.byTaskId('A');
    const b = codexHost.byTaskId('B');
    runner.stopTask(runId, 'A');
    // TaskSession.stopLoop() はLoopController.stop('taskStopped')相当。
    // フェイクはstopLoopCountを記録するだけなので、実際の遷移は`finish`で模擬する
    expect(a.stopLoopCount).toBe(1);
    a.finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    const taskA = store.find(runId)?.tasks['A'];
    expect(taskA?.state).toBe('failed');
    expect(taskA?.failure).toEqual({ kind: 'manualStop' });
    // Bはstopの対象外なので走り続ける
    expect(store.find(runId)?.tasks['B']?.state).toBe('running');
    expect(b.disposed).toBe(false);
    expect(a.disposed).toBe(true);
  });

  it('retryTaskはfailedタスクを依存が満たされていればpendingへ戻し、新しいセッションで再開する', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    // 新しいセッションが作られている（元のセッションとは別物）
    expect(codexHost.sessions).toHaveLength(2);

    // 依存未達（T2はT1が未完了）なので再実行できない
    expect(runner.retryTask(runId, 'T2')).toEqual({ ok: false });
  });

  it('allowを持つタスクの再実行はallowConfirmed無しでは始まらない（design.md §16.7、レビュー指摘: high）', async () => {
    const allowRetryYaml = `
version: 1
name: allow-retry-test
tasks:
  - id: T1
    allow:
      - "npm test"
    prompt: p
    done: d
`;
    const { runner, codexHost, store } = createHarness(allowRetryYaml);
    const result = await runner.start('/repo/.agents/workflows/allow-retry.yaml', '/repo', {
      allowConfirmed: true,
    });
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');

    // 確認無しでは再実行が始まらない
    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: false, needsAllowConfirmation: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(codexHost.sessions).toHaveLength(1);

    // allowConfirmed: true を付ければ再実行できる
    expect(runner.retryTask(runId, 'T1', { allowConfirmed: true })).toEqual({ ok: true });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    expect(codexHost.sessions).toHaveLength(2);
  });

  it('decideApprovalはpendingApprovalのrequestIdでTaskSession.decideApprovalを呼ぶ', async () => {
    const singleYaml = `
version: 1
name: decide-approval-test
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
`;
    const { runner, codexHost } = createHarness(singleYaml, { allowAutoApprove: true });
    const result = await runner.start('/repo/.agents/workflows/decide.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const decision = await t1.requestApproval(
      { requestId: 42, kind: 'command', title: '危険な操作', detail: '詳細', itemId: undefined },
      { command: DANGEROUS_COMMAND, cwd: t1.cwd },
    );
    expect(decision.kind).toBe('ask');
    await flush();

    const snapshot = runner.getSnapshot(runId);
    const t1Snapshot = snapshot?.tasks.find((t) => t.id === 'T1');
    expect(t1Snapshot?.pendingApproval).toEqual({
      requestId: 42,
      kind: 'command',
      title: '危険な操作',
      detail: '詳細',
    });

    expect(runner.decideApproval(runId, 'T1', 'accept')).toBe(true);
    expect(t1.decideApprovalCalls).toEqual([{ requestId: 42, decision: 'accept' }]);
  });

  it('pendingApprovalのtitle/detailは双方向制御文字を無害化してから保持する（レビュー指摘: medium 3）', async () => {
    const singleYaml = `
version: 1
name: decide-approval-sanitize-test
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
`;
    const { runner, codexHost } = createHarness(singleYaml, { allowAutoApprove: true });
    const result = await runner.start('/repo/.agents/workflows/decide-sanitize.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const rtlOverride = '\u202E';
    const spoofedTitle = 'safe' + rtlOverride + 'gnp.exe';
    const spoofedDetail = 'detail' + rtlOverride + 'line';
    await t1.requestApproval(
      {
        requestId: 1,
        kind: 'command',
        title: spoofedTitle,
        detail: spoofedDetail,
        itemId: undefined,
      },
      { command: DANGEROUS_COMMAND, cwd: t1.cwd },
    );
    await flush();

    const snapshot = runner.getSnapshot(runId);
    const t1Snapshot = snapshot?.tasks.find((t) => t.id === 'T1');
    expect(t1Snapshot?.pendingApproval?.title).not.toContain(rtlOverride);
    expect(t1Snapshot?.pendingApproval?.detail).not.toContain(rtlOverride);
    expect(t1Snapshot?.pendingApproval?.title).toBe('safegnp.exe');
    expect(t1Snapshot?.pendingApproval?.detail).toBe('detailline');
  });

  it('allowを含むタスクがあるワークフローはallowConfirmed無しでは開始せずneedsAllowConfirmationを返す', async () => {
    const allowYaml = `
version: 1
name: allow-confirm-test
tasks:
  - id: T1
    allow:
      - "npm test"
    prompt: p
    done: d
`;
    const { runner, codexHost } = createHarness(allowYaml);
    const first = await runner.start('/repo/.agents/workflows/allow.yaml', '/repo');
    expect(first.ok).toBe(false);
    expect(first.needsAllowConfirmation).toBe(true);
    expect(first.allowTaskIds).toEqual(['T1']);
    expect(codexHost.sessions).toHaveLength(0);

    const second = await runner.start('/repo/.agents/workflows/allow.yaml', '/repo', {
      allowConfirmed: true,
    });
    expect(second.ok).toBe(true);
    await flush();
    expect(codexHost.sessions).toHaveLength(1);

    const snapshot = runner.getSnapshot(second.runId as string);
    expect(snapshot?.warnings.some((w) => w.kind === 'allowOverride' && w.taskId === 'T1')).toBe(
      true,
    );
  });

  it('上流より緩い下流がresultを参照するワークフローはViewの警告欄にpermissionEscalationが出る（design.md §16.4 案2、Issue #67）', async () => {
    const escalationYaml = `
version: 1
name: escalation-test
tasks:
  - id: T1
    sandbox: read-only
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    sandbox: workspace-write
    prompt: "{{T1.result}}"
    done: d2
`;
    const { runner } = createHarness(escalationYaml);
    const result = await runner.start('/repo/.agents/workflows/escalation.yaml', '/repo');
    expect(result.ok).toBe(true);
    await flush();

    const snapshot = runner.getSnapshot(result.runId as string);
    const warning = snapshot?.warnings.find((w) => w.kind === 'permissionEscalation');
    expect(warning?.taskId).toBe('T2');
    expect(warning?.message).toContain('sandbox');
  });

  it('読み込み時点では判定できない（下流のsandbox未指定）ケースでも、実効値ベースの第二段の警告が出る（セキュリティ監査指摘#2）', async () => {
    // T1はsandboxを明示（read-only）、T2は明示しない（拡張機能側の設定=workspace-writeへ
    // 委ねる）ワークフロー。読み込み時のfindPermissionEscalationWarnings（純粋関数）は
    // T2.sandboxがundefinedなので判定を諦めるが、実行時にはT2の実効sandboxが
    // baseline（workspace-write）に決まり、T1（read-only）より緩いことが分かる
    const undefinedSandboxYaml = `
version: 1
name: escalation-effective-test
tasks:
  - id: T1
    sandbox: read-only
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: "{{T1.result}}"
    done: d2
`;
    const { runner, codexHost } = createHarness(undefinedSandboxYaml, {
      codexSandbox: 'workspace-write',
    });
    const result = await runner.start('/repo/.agents/workflows/escalation-effective.yaml', '/repo');
    expect(result.ok).toBe(true);
    const runId = result.runId as string;
    await flush();

    // 読み込み時点（開始直後、T1はまだ完了していない）では、この経路の警告は出ない
    // （T2.sandboxが未指定なのでvalidateWorkflow由来のderivePermissionEscalationWarningsは
    // 判定できない）
    expect(runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'permissionEscalation')).toBe(
      false,
    );

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('T1の応答テキスト'));
    await flush();

    // T2が開始した時点で、実効値ベースの第二段の警告（checkEffectivePermissionEscalation）が
    // live.warningsへ積まれる
    const snapshot = runner.getSnapshot(runId);
    const warning = snapshot?.warnings.find((w) => w.kind === 'permissionEscalation');
    expect(warning?.taskId).toBe('T2');
    expect(warning?.message).toContain('sandbox');
    expect(warning?.message).toContain('実効権限');
  });

  it('removeWorktreesはdone/failed/skippedタスクのworktreeを撤去する', async () => {
    // design.md §16.17でcleanupの既定は`after-merge`に変わり、doneになった時点で
    // 自動的に撤去されるようになった。ここでは「自動撤去が起きていない状態から
    // removeWorktrees()で撤去する」という本来のテスト意図を保つため、明示的に
    // `cleanup: keep`にする
    const keepYaml = `
version: 1
name: view-ops-test-keep
defaults:
  cleanup: keep
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p
    done: d
`;
    const git = fakeGit();
    const { runner, codexHost } = createHarness(keepYaml, { git });
    const result = await runner.start('/repo/.agents/workflows/remove.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const before = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(before).toHaveLength(0); // cleanup: keep なので自動では撤去されない

    const outcome = await runner.removeWorktrees(runId);
    expect(outcome.removed).toContain('T1');
    const after = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(after).toHaveLength(1);
  });

  it('既定のcleanup（after-merge）で自動撤去済みのworktreeへ「worktreeを撤去」を押しても、失敗として報告しない（Issue #252修正）', async () => {
    // 自動撤去（`shouldRemoveWorktree`）でディレクトリが既に消えている状態を、
    // `pathExists`が常にfalseを返すfsで再現する。修正前は`git status --porcelain`が
    // 不在のcwdに対して`spawn git ENOENT`を返し、gitErrorとして`failed`に積まれていた
    const missingFs: WorktreeFileSystemPort = {
      realpath: async (target) => target,
      readTextFile: async () => '.agents/worktrees/\n',
      isSymbolicLink: async () => false,
      pathExists: async () => false,
    };
    const singleTaskYaml = `
version: 1
name: view-ops-test-already-gone
tasks:
  - id: T1
    prompt: p
    done: d
`;
    const git = fakeGit();
    const { runner, codexHost } = createHarness(singleTaskYaml, { git, fs: missingFs });
    const result = await runner.start('/repo/.agents/workflows/remove.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // 撤去の呼び出し中にgitが使われたかだけを見る（タスクの完了までにマージ経路が
    // 呼ぶ `git status` と混ざらないよう、ここまでの呼び出しは対象から外す）
    const callsBeforeRemove = git.calls.length;
    const outcome = await runner.removeWorktrees(runId);
    expect(outcome.failed).toEqual([]);
    expect(outcome.removed).toContain('T1');
    // cwdが無いと分かった時点で返すため、`git status` / `git worktree remove` は
    // どちらも呼ばれない
    const callsDuringRemove = git.calls.slice(callsBeforeRemove);
    expect(
      callsDuringRemove.some(
        (c) => c.args[0] === 'status' || (c.args[0] === 'worktree' && c.args[1] === 'remove'),
      ),
    ).toBe(false);
  });

  it('removeWorktreesは再試行したタスクの、retryなし（初回）と過去の再試行分もすべて撤去する（Issue #298）', async () => {
    // 以前は`retrySuffixOf`が返す現在の試行1件（この場合`-retry1`）しか撤去しておらず、
    // 過去の試行（初回の`T1`、1回目の再試行`T1-retry0`）が残ったままだった
    const keepYaml = `
version: 1
name: view-ops-test-retry-cleanup
defaults:
  cleanup: keep
tasks:
  - id: T1
    prompt: p
    done: d
`;
    const git = fakeGit();
    const { runner, codexHost, store } = createHarness(keepYaml, { git });
    const result = await runner.start('/repo/.agents/workflows/retry-cleanup.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const attempt1 = codexHost.byTaskId('T1');
    attempt1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    const attempt2 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry0'));
    attempt2?.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    const attempt3 = codexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry1'));
    attempt3?.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T1']?.manualRetryCount).toBe(2);

    const outcome = await runner.removeWorktrees(runId);
    expect(outcome.removed).toEqual(['T1']);
    expect(outcome.failed).toEqual([]);

    const removeCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    const removedPaths = removeCalls.map((c) => c.args[2]);
    expect(removedPaths.some((p) => p !== undefined && p.endsWith('/T1'))).toBe(true);
    expect(removedPaths.some((p) => p !== undefined && p.endsWith('/T1-retry0'))).toBe(true);
    expect(removedPaths.some((p) => p !== undefined && p.endsWith('/T1-retry1'))).toBe(true);
    expect(removeCalls).toHaveLength(3);
  });
});

describe('WorkflowRunner: リロード後の実行再開（design.md §16.11）', () => {
  const YAML = `
version: 1
name: reload-resume-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('restoreRunsForViewはworkspaceStateから実行を復元し、再実行できる状態にする', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/reload.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    codexHost.byTaskId('T1'); // 開始できていることの確認

    // 新しいプロセス（リロード後）を模す。同じstoreを使い回すが、ライブな状態は空
    const newCodexHost = new FakeHost();
    const newHosts: Record<Provider, TaskSessionHost> = {
      codex: newCodexHost,
      claude: newCodexHost,
    };
    const reloadedRunner = new WorkflowRunner({
      // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
      // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
      // （design.md §16.35、roadmap W10、Issue #584）
      readAutoResume: () => false,
      hosts: newHosts,
      worktreeQueue: new WorktreeCreationQueue(),
      git: fakeGit(),
      fs: identityFs,
      filePort: filePort(YAML),
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });

    await reloadedRunner.restoreRunsForView();

    // リロード直後は中断扱い（failed）で復元され、Viewから見える
    const snapshot = reloadedRunner.getSnapshot(runId);
    expect(snapshot?.tasks[0]?.state).toBe('failed');
    expect(snapshot?.tasks[0]?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(snapshot?.tasks[0]?.hasLiveSession).toBe(false);

    // 「再実行」で新しいセッションから続けられる
    expect(reloadedRunner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    expect(newCodexHost.sessions).toHaveLength(1);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
  });

  it(
    'allowを含むワークフローをリロード後に復元しても、allowOverride警告が消えず、' +
      '再実行にはallow確認が要る（design.md §16.7、レビュー指摘: high）',
    async () => {
      const allowYaml = `
version: 1
name: reload-allow-test
tasks:
  - id: T1
    allow:
      - "npm test"
    prompt: p
    done: d
`;
      const { runner, codexHost, store } = createHarness(allowYaml);
      const result = await runner.start('/repo/.agents/workflows/reload-allow.yaml', '/repo', {
        allowConfirmed: true,
      });
      const runId = result.runId as string;
      await flush();
      codexHost.byTaskId('T1');

      // start()の時点ではallowOverride警告が出ている（従来どおり）
      expect(runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'allowOverride')).toBe(
        true,
      );

      // 新しいプロセス（リロード後）を模す
      const newCodexHost = new FakeHost();
      const reloadedRunner = new WorkflowRunner({
        // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
        // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
        // （design.md §16.35、roadmap W10、Issue #584）
        readAutoResume: () => false,
        hosts: { codex: newCodexHost, claude: newCodexHost },
        worktreeQueue: new WorktreeCreationQueue(),
        git: fakeGit(),
        fs: identityFs,
        filePort: filePort(allowYaml),
        store,
        log: fakeLogger,
        readBaseline: () => ({
          codexSandbox: 'read-only',
          codexApprovalMode: 'on-request',
          claudePermissionMode: 'manual',
          allowAutoApprove: true,
          allowClaudeBypassPermissions: false,
        }),
      });
      await reloadedRunner.restoreRunsForView();

      // 復元後もallowOverride警告が消えない（修正前は`live.warnings: []`初期化のため消えていた）
      const snapshot = reloadedRunner.getSnapshot(runId);
      const allowWarning = snapshot?.warnings.find((w) => w.kind === 'allowOverride');
      expect(allowWarning).toBeDefined();
      expect(allowWarning?.taskId).toBe('T1');
      expect(allowWarning?.message).toContain('npm test');

      // 再実行はallow確認を経由しないと始まらない
      expect(reloadedRunner.retryTask(runId, 'T1')).toEqual({
        ok: false,
        needsAllowConfirmation: true,
      });
      await flush();
      expect(newCodexHost.sessions).toHaveLength(0);

      // 確認すれば再実行できる
      expect(reloadedRunner.retryTask(runId, 'T1', { allowConfirmed: true })).toEqual({
        ok: true,
      });
      await flush();
      expect(newCodexHost.sessions).toHaveLength(1);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    },
  );

  it('定義ファイルが大きすぎるrunは復元をあきらめる（design.md §16.2の上限。レビュー指摘: medium 2）', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/oversize.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const oversizeFilePort: WorkflowFilePort = {
      fileSize: async () => MAX_WORKFLOW_FILE_BYTES + 1,
      readTextFile: async () => YAML,
    };
    const reloadedRunner = new WorkflowRunner({
      // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
      // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
      // （design.md §16.35、roadmap W10、Issue #584）
      readAutoResume: () => false,
      hosts: { codex: new FakeHost(), claude: new FakeHost() },
      worktreeQueue: new WorktreeCreationQueue(),
      git: fakeGit(),
      fs: identityFs,
      filePort: oversizeFilePort,
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });

    await expect(reloadedRunner.restoreRunsForView()).resolves.toBeUndefined();
    // 上限超過のため復元をあきらめる（readTextFileが呼ばれる前にfileSizeで弾く）
    expect(reloadedRunner.getSnapshot(runId)).toBeUndefined();
  });

  it('定義ファイルが読めないrunは復元をあきらめる（クラッシュしない）', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/gone.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const brokenFilePort: WorkflowFilePort = {
      fileSize: async () => undefined,
      readTextFile: async () => undefined,
    };
    const reloadedRunner = new WorkflowRunner({
      // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
      // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
      // （design.md §16.35、roadmap W10、Issue #584）
      readAutoResume: () => false,
      hosts: { codex: new FakeHost(), claude: new FakeHost() },
      worktreeQueue: new WorktreeCreationQueue(),
      git: fakeGit(),
      fs: identityFs,
      filePort: brokenFilePort,
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });

    await expect(reloadedRunner.restoreRunsForView()).resolves.toBeUndefined();
    expect(reloadedRunner.getSnapshot(runId)).toBeUndefined();
  });
});

describe('WorkflowRunner: マージ（design.md §16.17）', () => {
  const YAML = `
version: 1
name: merge-test
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
  - id: T3
    dependsOn: [T1]
    prompt: p3
    done: d3
  - id: T4
    dependsOn: [T2, T3]
    prompt: p4
    done: d4
`;

  // `WorkflowRunner.prototype`へ張ったスパイを必ず外す。テストが落ちた瞬間に
  // `mockRestore()`まで到達せず、後続のテスト（`cleanupWorktreeIfNeeded`が呼ばれない
  // ことを確かめる`interrupted`のテスト等）が道連れで落ちるのを防ぐ
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('マージが成功するとdoneになり、worktreeがafter-mergeで撤去される（design.md §16.17既定）', async () => {
    const git = fakeGit();
    const { runner, codexHost, store } = createHarness(YAML);
    // createHarnessは既定のfakeGit()を使うため、明示的にgitを渡し直す必要は無いが
    // 撤去呼び出しを確認したいのでharnessと同じgitインスタンスを使う
    void git;
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
  });

  /**
   * `cleanupWorktreeIfNeeded`はテストが`prototype`をスパイして撤去の有無を確かめる前提で
   * ラッパーを残してある（`runnerInternals.ts`のJSDoc参照）。Issue #147の分割で
   * マージ成功経路（`attemptMerge`）と衝突解決完了経路（`onMergeResolutionFinished`）
   * だけがラッパーを迂回してモジュール関数を直接呼んでいたため、この2経路をスパイで
   * 検証しようとすると呼び出し回数が実際より少なく見え、撤去の有無を確かめられなかった。
   * 以下2件は経路ごとに迂回の再発を検知する（迂回すると回数が1つ減って落ちる）。
   */
  function spyOnCleanupWorktree(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(
      WorkflowRunner.prototype as unknown as {
        cleanupWorktreeIfNeeded: (...args: unknown[]) => void;
      },
      'cleanupWorktreeIfNeeded',
    );
  }

  it('マージ成功経路のworktree撤去もWorkflowRunnerのラッパーを通る（PR #157のレビュー指摘）', async () => {
    const cleanupSpy = spyOnCleanupWorktree();
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // 2回の内訳: タスク完了時（`onTaskFinished`）と、マージ成功時（`attemptMerge`）。
    // 後者がモジュール関数を直接呼ぶ形へ戻ると1回に減る
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });

  it('衝突解決完了経路のworktree撤去もWorkflowRunnerのラッパーを通る（PR #157のレビュー指摘）', async () => {
    const cleanupSpy = spyOnCleanupWorktree();
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    git.resolveConflict();
    codexHost.sessions.at(-1)?.finish('done', doneState('衝突を解決しました'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // 2回の内訳: タスク完了時（`onTaskFinished`）と、衝突解決の完了時
    // （`onMergeResolutionFinished`）。後者がモジュール関数を直接呼ぶ形へ戻ると1回に減る
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });

  it('未コミットの変更があるタスクが完了すると、終了条件にコミット要件が自動で足される', async () => {
    const { runner, codexHost } = createHarness(YAML);
    await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    // isolation: worktree（既定）のタスクは、終了条件へ「コミットしてあること」が
    // 自動で足される（design.md §16.17「タスク完了時のコミット」1.）
    expect(t1.runLoopCalls[0]?.condition).toContain('d1');
    expect(t1.runLoopCalls[0]?.condition).toContain('コミット');
  });

  it('マージが衝突すると衝突解決セッションが自動で開始され、解決すればdoneになる', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // T1は衝突したのでまだmergingのまま（衝突解決セッションが開いているはず）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    // 衝突解決セッションはT1自身のworktreeとは別（統合worktree）で開かれる。
    // 直近に開かれたセッションがそれのはず
    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession).toBeDefined();
    expect(resolutionSession?.cwd.endsWith('_integration')).toBe(true);
    expect(resolutionSession?.runLoopCalls[0]?.initialPrompt).toContain('T1');

    // 解決してコミットした（git上も未解決パスが消えた）とみなして完了を宣言する
    git.resolveConflict();
    resolutionSession?.finish('done', doneState('衝突を解決しました'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
  });

  /**
   * 「全体の停止」は衝突解決セッションを止め対象から漏らしていた（issue #381。issue #322の
   * 「停止ボタンを押しても指示が送られ続ける」が衝突解決セッションについてだけ残っていた）。
   * `stop()`が`live.mergeResolutions`にも`stopLoop()`を送ること自体は#381のまま守る。
   *
   * 停止の後始末で`git merge --abort`はしない（issue #434）。統合worktreeで人が解いた
   * 未コミットの解決結果を破棄してしまい、復旧手段が無いため。タブへの直接介入
   * （`manual`/`interrupted`）と同じ非破壊の経路へ合流するが、**タスク自身は`merging`の
   * まま残さず`blocked`にする**（Issue #443、案A）。`merging`のまま残すと`getRunOutcome`が
   * `running`を返し続け、runが終了確定せず「再マージ」の対象にもならない行き止まりに
   * なるため。
   */
  it('全体の停止は衝突解決セッションにもstopLoopを送り、解決作業は巻き戻さずblockedにする（issue #381・#434・#443）', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // T1は衝突したのでまだmergingのまま、衝突解決セッションが開いている
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession).toBeDefined();

    runner.stop(runId);
    await flush();

    // 修正前は`live.tasks`しか走査しないため0のまま（このテストがそれを検知する）
    expect(resolutionSession?.stopLoopCount).toBe(1);
    expect(store.find(runId)?.haltedByUser).toBe(true);

    // `stopLoop()`は衝突解決セッションでも`LoopStopReason: 'taskStopped'`でonFinishedを呼ぶ。
    // `onMergeResolutionFinished`は'taskStopped'を'manual'/'interrupted'と同じ非破壊の
    // 経路として扱う（issue #434）
    resolutionSession?.finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    // マージの巻き戻し（`git merge --abort`）は呼ばれない。統合worktreeは`MERGE_HEAD`と
    // 未解決パスを抱えたまま残り、人が解いた内容が保たれる
    const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
    expect(abortCall).toBeUndefined();
    // タスク自身は`blocked`へ確定する（Issue #443・案A）。巻き戻していないため、Viewが
    // その事実を伝えられるよう`mergeInterrupted`警告を積む
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    const warnings = runner.getSnapshot(runId)?.warnings ?? [];
    expect(warnings.some((w) => w.kind === 'mergeInterrupted' && w.taskId === 'T1')).toBe(true);
    // 衝突解決セッションは片付けられ、統合worktreeの占有だけが解放されている
    expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.mergeResolutionActive).toBe(
      false,
    );
    // `blocked`になった以上、runは`running`を返し続けない（他タスクはT1がmergingでは
    // 開始できないため`pending`のまま`skipped`に倒れており、run全体は`blocked`で終了確定する）
    expect(runner.getSnapshot(runId)?.outcome).toBe('blocked');
    // 依存する後続（T2・T3・T4）は`runHalted`のまま、`mergeBlocked`には上書きされない
    // （`runner.stop()`が`haltedByUser`を先に立てているため`skipRemainingPending`は
    // このシナリオでは既に`stop()`側で走っており、この特定のテストは呼び出し順序を
    // 区別できない。順序依存そのものの検証は下の「stop()を経由しない直接介入」テストが
    // 担う。ここでは単に、`taskStopped`経路でも最終的な状態が正しいことを確かめる）
    expect(store.find(runId)?.tasks['T2']?.failure).toEqual({ kind: 'runHalted' });
    expect(store.find(runId)?.tasks['T3']?.failure).toEqual({ kind: 'runHalted' });
    expect(store.find(runId)?.tasks['T4']?.failure).toEqual({ kind: 'runHalted' });
  });

  /**
   * `stopTask`（タスク単位の「タスク停止」。design.md §16.8）が衝突解決セッションへ届かない
   * 欠陥の回帰テスト（issue #514）。issue #381は`stop()`（全体停止）側だけを直しており、
   * `stopTask`には同じ手当てが漏れていた。
   *
   * 修正前の`stopTask`は`live.tasks`しか見ないため、`live.mergeResolutions`にしか
   * 無い衝突解決セッションの`stopLoop()`は一度も呼ばれない。かつ戻り値が`void`だった
   * ため、呼び出し元（`runnerOrchestrator.ts`）は無条件で成功を返していた。
   */
  it('stopTaskはmergingタスクの衝突解決セッションへstopLoopを届け、trueを返す（issue #514）', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // T1は衝突したのでまだmergingのまま、衝突解決セッションが開いている
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession).toBeDefined();

    const stopped = runner.stopTask(runId, 'T1');

    // `live.tasks`側のT1（既に`onTaskFinished`でdispose済み）ではなく、
    // `live.mergeResolutions`側の解決セッションへ届いたことを確認する
    expect(resolutionSession?.stopLoopCount).toBe(1);
    expect(stopped).toBe(true);

    resolutionSession?.finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    // `onMergeResolutionFinished`の`taskStopped`経路（issue #434・#443）へそのまま合流し、
    // `git merge --abort`を呼ばず`blocked`へ確定する
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
  });

  /**
   * 「`merging`単体への`stopTask`がrun全体を止める」副作用の回帰テスト（issue #514）。
   *
   * 修正前は`stopTask`が衝突解決セッションへ送る`stopLoop()`も
   * `WorkflowRunner.stop()`（全体停止）と同じ`LoopStopReason: 'taskStopped'`しか
   * 伝えられず、`finishMergeResolution`はどちらの経路から来たかを区別できなかった
   * （`entry.timedOutByApprovalTimeout`と同じ理由。`MergeResolutionEntry.stoppedByStopTask`
   * のJSDoc参照）。そのため`stopTask(runId, 'T1')`を呼んだだけで
   * `applyLoopStopReason('manual')`（`live.runState`の`haltedByUser`を立て、`pending`を
   * 全て`skipped`（理由:`runHalted`）にする`skipRemainingPending`を伴う）が呼ばれていた。
   *
   * **`maxParallel: 1`にして、T1に依存しない独立タスクT5をあえて`pending`のまま
   * 残す。** こうすると、修正前の実装なら`applyLoopStopReason`の`skipRemainingPending`が
   * T5を無条件に`skipped`（`runHalted`）へ倒してしまい、以後T5は永久に開始されない。
   * 対して修正後は`markMergeBlocked`だけが呼ばれ、T5はT1の依存先ではないため触られず
   * `pending`のまま残る。そして、T1が`merging`から`blocked`へ抜けたことで
   * `maxParallel`の枠が1つ空き、`pump()`がT5を拾って`running`へ進める。
   * 「T5がpendingのまま`skipped`にならず、かつ実際に開始される」ことは、
   * 「run全体は止まっていない」ことの直接証拠になる（`haltedByUser`が立っていれば
   * `pump()`は新しいタスクを一切開始しない）。
   *
   * あわせて、`haltedByUser`が立たないこと、T1に依存するT2/T3が`runHalted`（全体停止
   * 起因）ではなく`mergeBlocked`（T1の衝突起因）で`skipped`になることも確認する
   * （`markMergeBlocked`が本来カスケードする理由と一致することの確認）。
   */
  it('stopTaskはmergingタスクだけを止め、依存しない他のタスクのスケジューリングを止めない（issue #514）', async () => {
    const INDEPENDENT_BRANCH_YAML = `
version: 1
name: merge-independent-branch-test
defaults:
  provider: codex
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
  - id: T3
    dependsOn: [T1]
    prompt: p3
    done: d3
  - id: T4
    dependsOn: [T2, T3]
    prompt: p4
    done: d4
  - id: T5
    prompt: p5
    done: d5
`;
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(INDEPENDENT_BRANCH_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge-independent.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // `maxParallel: 1`のため、定義順で先に来るT1だけが走り始め、T5は依存が無くても
    // 枠が空くまで`pending`のまま
    const t1 = codexHost.byTaskId('T1');
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    expect(store.find(runId)?.tasks['T5']?.state).toBe('pending');

    t1.finish('done', doneState('ok'));
    await flush();

    // T1は衝突したのでまだmergingのまま、衝突解決セッションが開いている
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession).toBeDefined();
    // T1がmergingの間は枠を占有したままなので、T5はまだ始まらない
    expect(store.find(runId)?.tasks['T5']?.state).toBe('pending');

    const stopped = runner.stopTask(runId, 'T1');
    expect(stopped).toBe(true);
    expect(resolutionSession?.stopLoopCount).toBe(1);

    resolutionSession?.finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    // T1自身は従来どおり`blocked`へ確定する（issue #443・案A、Issue #514で壊してはならない
    // 不変条件）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // **run全体は止まっていない。** stopTaskは`merging`のT1単体を狙った操作であり、
    // `WorkflowRunner.stop()`（全体停止）とは違って`haltedByUser`を立てない
    expect(store.find(runId)?.haltedByUser).toBe(false);

    // T1に依存しないT5は`skipped`(`runHalted`)へ倒れず、`pending`のまま生き残ったうえで、
    // T1がblockedへ抜けて空いた枠を使って実際に開始される
    // （修正前はここで`skipped`になり、二度と`running`にならなかった）
    expect(store.find(runId)?.tasks['T5']?.state).toBe('running');
    expect(codexHost.byTaskId('T5')).toBeDefined();

    // T1に依存するT2/T3は、全体停止（`runHalted`）起因ではなく、T1の衝突（`mergeBlocked`）
    // 起因で`skipped`になる。修正前は`applyLoopStopReason('manual')`が先に走るため
    // `runHalted`になっていた（このテストが無ければ気づけない区別）
    expect(store.find(runId)?.tasks['T2']?.failure).toEqual({
      kind: 'mergeBlocked',
      blockedTaskIds: ['T1'],
    });
    expect(store.find(runId)?.tasks['T3']?.failure).toEqual({
      kind: 'mergeBlocked',
      blockedTaskIds: ['T1'],
    });
  });

  it('stopTaskは対象のセッションが見つからない場合falseを返す（issue #514）', async () => {
    const { runner } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // T2はT1に依存しており、まだ`pending`。`live.tasks`にも`live.mergeResolutions`にも
    // エントリが無いため、送り先が見つからずfalseを返す
    expect(runner.stopTask(runId, 'T2')).toBe(false);
    // 存在しないrunId・taskIdも同様にfalse（無条件successへ戻らないことの確認）
    expect(runner.stopTask('存在しないrun', 'T1')).toBe(false);
    expect(runner.stopTask(runId, '存在しないtask')).toBe(false);
  });

  it(
    '衝突解決中はgetSnapshotのmergeResolutionActiveが立ち、revealTaskは衝突解決セッションを開く' +
      '（design.md §16.17「コンフリクト」5.・Issue #104）',
    async () => {
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost } = createHarness(YAML, { git });
      const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      // 通常のタスクセッションはこの時点でまだreveal可能（hasLiveSession）だが、
      // 衝突解決中はそちらではなく衝突解決セッションを開くべき
      t1.finish('done', doneState('ok'));
      await flush();

      const snapshot = runner.getSnapshot(runId);
      const t1Snapshot = snapshot?.tasks.find((t) => t.id === 'T1');
      expect(t1Snapshot?.mergeResolutionActive).toBe(true);

      const resolutionSession = codexHost.sessions.at(-1);
      expect(runner.revealTask(runId, 'T1')).toBe(true);
      expect(resolutionSession?.revealCount).toBe(1);
      // 元のタスクセッション（T1自身のworktree）のrevealは呼ばれない
      expect(t1.revealCount).toBe(0);

      // 解決が終われば通常のreveal対象（liveTaskの側）に戻り、mergeResolutionActiveも消える
      git.resolveConflict();
      resolutionSession?.finish('done', doneState('衝突を解決しました'));
      await flush();
      const afterSnapshot = runner.getSnapshot(runId);
      expect(afterSnapshot?.tasks.find((t) => t.id === 'T1')?.mergeResolutionActive).toBe(false);
    },
  );

  it('衝突解決セッションのタブ名は対象タスクのidを含む（Issue #413 PR4）', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost } = createHarness(YAML, { git });
    await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // タブ名そのものはhost実装（chatView.ts/claudeChatView.ts）側の責務だが、そこへ渡す
    // 入力（`mergeResolutionTaskId`）はrunner.ts側が組み立てる。従来は渡していなかった
    // ため、タブ名が固定文字列（'Codex'/LABEL）になり見分けが付かなかった
    const resolutionInput = codexHost.openInputs.at(-1);
    expect(resolutionInput?.mergeResolutionTaskId).toBe('T1');
  });

  it('承認待ちの解決セッションはmaxParallelの枠から外れ、他の独立したタスクが開始できる（Issue #413 PR4）', async () => {
    const APPROVAL_YAML = `
version: 1
name: merge-approval-test
defaults:
  provider: codex
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(APPROVAL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge-approval.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // T1は衝突したのでmergingのまま。maxParallel:1の枠を占めるため、T2（独立タスク）は
    // まだ開始できない
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('pending');
    expect(
      runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.mergeResolutionWaitingApproval,
    ).toBe(false);

    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession).toBeDefined();

    // 承認カードが出て、解決セッションが人待ちになった
    resolutionSession?.emitState({
      ...initialChatState,
      approvals: [{ requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined }],
    });
    await flush();

    expect(
      runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.mergeResolutionWaitingApproval,
    ).toBe(true);
    // 枠が明け渡され、T2が開始できるようになる
    expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
    // getRunOutcomeの判定は変わらない（mergingは引き続き`running`扱いのまま。衝突解決中の
    // runが「終了した」と誤判定されて統合PR/MRの作成が走ってしまわないことの確認）
    expect(runner.getSnapshot(runId)?.outcome).toBe('running');

    // 承認が解決した（承認カードが消えた）
    resolutionSession?.emitState({ ...initialChatState, approvals: [] });
    await flush();

    expect(
      runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.mergeResolutionWaitingApproval,
    ).toBe(false);
    // 除外集合から抜けて枠の勘定に戻る。T1自身は引き続きmergingのまま、T2は既に開始済み
    // （途中で止めない）ため走り続ける
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
  });

  it(
    '衝突解決セッションがdoneを宣言してもgit上は未解決のままなら信用せずblockedにする' +
      '（design.md §16.17「宣言だけを信じずgit statusでも確かめる」）',
    async () => {
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost, store } = createHarness(YAML, { git });
      const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      const resolutionSession = codexHost.sessions.at(-1);
      // git.resolveConflict()を呼ばず、宣言だけdoneにする
      resolutionSession?.finish('done', doneState('解決したつもり'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      // マージは巻き戻されている
      const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
      expect(abortCall).toBeDefined();
    },
  );

  it('衝突解決セッションが回数切れ（maxReached）になるとblockedになり、マージが巻き戻される', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.finish('maxReached', { ...initialChatState });
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
    expect(abortCall).toBeDefined();
  });

  it(
    'blockedは依存する後続だけをskipped(mergeBlocked)にし、独立した枝は走り続ける' +
      '（design.md §16.3「blockedは実行全体を止めない」）',
    async () => {
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost, store } = createHarness(YAML, { git });
      const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();
      // T1のマージが衝突 → 衝突解決セッションが回数切れでblockedになる
      const resolutionSession = codexHost.sessions.at(-1);
      resolutionSession?.finish('maxReached', { ...initialChatState });
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      // T2・T3はT1に依存しているため開始されない（skipped, mergeBlocked）
      expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
      expect(store.find(runId)?.tasks['T2']?.failure).toEqual({
        kind: 'mergeBlocked',
        blockedTaskIds: ['T1'],
      });
      expect(store.find(runId)?.tasks['T3']?.state).toBe('skipped');
      // 実行全体は停止していない（haltedByUserがfalseのまま）
      expect(store.find(runId)?.haltedByUser).toBe(false);
    },
  );

  it('マージがその他の理由（gitエラー等）で失敗するとfailedになり、依存する後続がskippedになる', async () => {
    const git = fakeGit({ failMerge: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'mergeFailed' });
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
  });

  it('retryMergeはblockedのタスクを再マージし、成功すればdoneになり依存先が再開できる', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.finish('maxReached', { ...initialChatState });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');

    // 人が統合worktreeを手で直し（ここではfakeGitを解決済みにする）、再マージを指示する
    git.resolveConflict();
    const retried = runner.retryMerge(runId, 'T1');
    expect(retried).toBe(true);
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // mergeBlockedで止まっていたT2がpendingへ戻り、次に開始される
    expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
  });

  /**
   * Issue #432-2: `retryMerge`は再開の起点として`live.finished`を戻す（design.md §16.5参照）。
   * 一度`blocked`でrunが終了しoutcomeが確定した後、`retryMerge`で再開して最終的に
   * 全タスクがdoneになると、`pump()`の終了ブロックが2周目を走る。`notifyOrchestratorRunFinished`
   * はrunにつき1度だけ送るべきで、2周目で重ねて送ってはいけない。
   */
  it('blockedで終了→再マージ成功→再度終了、でnotifyOrchestratorRunFinishedが2回送られる（再開通知の追加により。Issue #491）', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.finish('maxReached', { ...initialChatState });
    await flush();
    // 1周目: blockedで終了する
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // オーケストレーターへの通知はターン中は`pending`に溜まり、ターンが終わって
    // （`busy: true → false`）初めて`session.send`へ渡る。実CLIの応答を模して
    // 明示的にターンを終わらせないと`sentTexts`から観測できない
    const flushOrchestratorTurn = (): void => {
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession | undefined;
      if (orchestrator === undefined) {
        return;
      }
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });
    };
    const countRunFinishedNotices = (): number => {
      const orchestrator = codexHost.orchestratorSessions[0];
      const joined = orchestrator?.sentTexts.join('\n') ?? '';
      return (joined.match(/ワークフローの実行が終了しました/g) ?? []).length;
    };
    flushOrchestratorTurn();
    expect(countRunFinishedNotices()).toBe(1);

    // 人が統合worktreeを手で直し、再マージを指示する。以降は依存先も含めて最後まで走らせる
    git.resolveConflict();
    expect(runner.retryMerge(runId, 'T1')).toBe(true);
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');

    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    codexHost.byTaskId('T3').finish('done', doneState('ok'));
    await flush();
    codexHost.byTaskId('T4').finish('done', doneState('ok'));
    await flush();
    flushOrchestratorTurn();

    // 2周目: 今度はsucceededで終了する
    expect(store.find(runId)?.tasks['T4']?.state).toBe('done');
    expect(store.find(runId)?.haltedByUser).toBe(false);
    // 再開を挟んだ2度目の終了は「同じ終了」ではないので、もう1度送られる（Issue #491。
    // 理由は`runner.test.ts`の「run終了処理の回数」describeにある`retryTask`のテスト参照）
    expect(countRunFinishedNotices()).toBe(2);
  });

  /**
   * 停止中の「再マージ」は、そのタスクのマージだけを走らせる（Issue #412のレビュー指摘B）。
   *
   * `retryMergeState`が`haltedByUser`を解除してしまうと、マージ成功→`markMergeSucceeded`が
   * 依存先の`skipped`（`mergeBlocked`）を`pending`へ戻した瞬間に`nextTasksToStart`の停止判定が
   * 外れ、ユーザーが停止したrunの後続タスクが新しいセッションを開いて走り出す（「再マージ
   * 1件」の操作でワークフロー全体が再開してしまう）。解除しなくてもマージ自体は走ることを
   * 同時に確かめる（`decideAfterLeaseWait`が見るのは順番待ちの**間の**差分だけのため）。
   */
  it('停止中の再マージはそのタスクのマージだけを走らせ、停止したrunの後続は再開しない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    codexHost.sessions.at(-1)?.finish('maxReached', { ...initialChatState });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');

    // ユーザーが実行全体を停止する
    runner.stop(runId);
    await flush();
    expect(store.find(runId)?.haltedByUser).toBe(true);
    const sessionCountAtStop = codexHost.sessions.length;

    // 人が統合worktreeを手で直してから「再マージ」を押す
    git.resolveConflict();
    expect(runner.retryMerge(runId, 'T1')).toBe(true);
    await flush();

    // 停止中でも、そのタスクのマージは走り切る
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(git.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff')).toHaveLength(
      2,
    );

    // 停止は解除されないので、後続は新しいセッションを開かない
    expect(store.find(runId)?.haltedByUser).toBe(true);
    // `markMergeSucceeded`は停止中（`haltedByUser`）を見て、`mergeBlocked`だった後続を
    // `pending`へ戻さず`skipped`（`mergeBlockedWhileHalted`。Issue #527で`runHalted`から
    // 分離した）のままにする（Issue #432-1）。`pending`に戻すと誰にも開始されず
    // `getRunOutcome`が`running`を返し続けてrunが終わらなくなる。`skipped`のままなら
    // `retryTask`が受理して人が拾い直せる。
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
    expect(store.find(runId)?.tasks['T2']?.failure).toEqual({
      kind: 'mergeBlockedWhileHalted',
      blockedTaskIds: ['T1'],
    });
    expect(store.find(runId)?.tasks['T3']?.state).toBe('skipped');
    expect(store.find(runId)?.tasks['T3']?.failure).toEqual({
      kind: 'mergeBlockedWhileHalted',
      blockedTaskIds: ['T1'],
    });
    expect(codexHost.sessions).toHaveLength(sessionCountAtStop);
  });

  it('isolation: sharedのタスクはマージ対象のブランチを持たないため、mergingを経ずそのままdoneになる', async () => {
    const sharedYaml = `
version: 1
name: shared-test
tasks:
  - id: T1
    isolation: shared
    prompt: p
    done: d
`;
    const git = fakeGit();
    const { runner, codexHost, store } = createHarness(sharedYaml, { git });
    const result = await runner.start('/repo/.agents/workflows/shared.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // isolation: sharedのタスクはcwdがrepoRoot直下（'/repo'）になり、taskIdでは終わらないため
    // byTaskIdでは引けない
    expect(codexHost.sessions).toHaveLength(1);
    const t1 = codexHost.sessions[0] as FakeTaskSession;
    expect(t1.cwd).toBe('/repo');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // マージ関連のgit呼び出し（merge, commit）が一切発生していない
    expect(git.calls.some((c) => c.args[0] === 'merge')).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'commit')).toBe(false);
  });

  it('統合worktreeの作成自体が失敗すると、start()はエラーで返す', async () => {
    const git = fakeGit({ failWorktreeAdd: true });
    const { runner } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge.yaml', '/repo');
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.message.includes('統合worktree'))).toBe(true);
  });
});

describe('WorkflowRunner: PR/MRの作成（design.md §16.18、Issue #105）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: forge-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it(
    'design.mdが定める順序（タスクブランチをpush→統合ブランチをpush→PR/MRを作る→' +
      'マージして統合ブランチをpush）でPR/MRを作る',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli();
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
      });
      const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      // pushはタスクブランチ→統合ブランチ→(マージ後に)統合ブランチ、の順で呼ばれる
      const pushCalls = git.calls.filter((c) => c.args[0] === 'push');
      expect(pushCalls.length).toBeGreaterThanOrEqual(2);
      // PR作成はpushの後、マージ（統合worktreeでの`git merge --no-ff`）の前に呼ばれる
      const createCallIndex = cli.calls.findIndex(
        (c) => c.args[0] === 'pr' && c.args[1] === 'create',
      );
      const mergeCallIndex = git.calls.findIndex(
        (c) => c.args[0] === 'merge' && c.args[1] === '--no-ff',
      );
      expect(createCallIndex).toBeGreaterThanOrEqual(0);
      expect(mergeCallIndex).toBeGreaterThan(createCallIndex);
      const createCall = cli.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
      expect(createCall?.args.some((a) => a.startsWith('--base=wf/'))).toBe(true);
    },
  );

  it('gh/glabの前提（認証）が欠けていれば、警告のうえPR/MRを飛ばしローカルのマージだけ進める', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli({ authenticated: false });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // ローカルの統合ブランチへのマージ自体は進む
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // PR/MRは作られない
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
    // 警告が出る
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeSkipped')).toBe(true);
  });

  it('originのremoteが無ければ、警告のうえPR/MRを飛ばしローカルのマージだけ進める', async () => {
    const git = fakeGit();
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeSkipped')).toBe(true);
  });

  it('agent.workflows.forgeがnoneならPR/MRを作らない（前提チェックも行わない）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { host: 'none' }),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(cli.calls).toHaveLength(0);
    // host: 'none' は既定に丸めた設定違反ではないため、forgeSkipped警告も出さない
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeSkipped')).toBe(false);
  });

  it('全タスクがdoneになったら統合→mainのPR/MRを作り、finalMerge: autoならmainへマージする', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // タスク層のPRに続き、統合層のPR（gh pr create）も作られている
    const createCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(createCalls.length).toBe(2);
    const integrationCreate = createCalls[1];
    expect(integrationCreate?.args.some((a) => a === '--base=main')).toBe(true);
    // finalMerge: auto（既定）なので最終マージまで実行する
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(true);
    void result;
  });

  it('CIチェックの完了を待ってから最終マージする（design.md §16.36、Issue #556）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({
      ciStatusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // `gh pr view <統合PR番号> --json=statusCheckRollup`（CI確認）が
    // `gh pr merge`より前に呼ばれている
    const viewIndex = cli.calls.findIndex((c) => c.args[0] === 'pr' && c.args[1] === 'view');
    const mergeIndex = cli.calls.findIndex((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(mergeIndex).toBeGreaterThan(viewIndex);
  });

  it('CIが赤ならmainへマージせず、理由付きの警告を残してfinalMergeOutcomeがfailedになる（design.md §16.36）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({
      ciStatusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // CIが赤のためマージコマンド自体を呼ばない
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBe('failed');
    expect(snapshot?.warnings.some((w) => w.message.includes('最終マージに失敗しました'))).toBe(
      true,
    );
  });

  it('マージが「baseの最新でない」ことで拒否されたら取り込み直して再試行し、成功すればmergedになる（design.md §16.36）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({
      ciStatusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      failMergeNotUpToDateOnce: true,
    });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const mergeCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
    const updateBranchCalls = cli.calls.filter(
      (c) => c.args[0] === 'pr' && c.args[1] === 'update-branch',
    );
    expect(mergeCalls.length).toBe(2);
    expect(updateBranchCalls.length).toBe(1);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBe('merged');
  });

  describe('全体の停止（haltedByUser）はCI待ちの区間も守る（design.md §16.36、セキュリティ監査の指摘。2026-08-23）', () => {
    /**
     * `FakeForgeCli`の呼び出しに副作用（`onCall`）を差し込むための薄いラッパー。
     * `waitForCiChecks`がCI状態を実際に取得している最中に人が「全体の停止」を押した、
     * という状況を`runner.stop()`の呼び出しとして模すために使う。`calls`は元のフェイクの
     * ものをそのまま共有する（ラッパー自身は呼び出しを記録しない）。
     */
    function wrapCliWithSideEffect(
      base: FakeForgeCli,
      onCall: (command: string, args: readonly string[]) => void,
    ): FakeForgeCli {
      return {
        calls: base.calls,
        async run(command, args, cwd) {
          const result = await base.run(command, args, cwd);
          onCall(command, args);
          return result;
        },
      };
    }

    it('finalMerge: autoでも、統合PR/MR作成の完了時点で既に「全体の停止」が押されていれば最終マージを試みない（旧: auto経路はperformFinalMergeの前にhaltedByUserを見ていなかった。兄弟の穴）', async () => {
      // レビュー指摘（2026-08-23）: `pr view`/`pr merge`が呼ばれないことだけを見る形では、
      // `performFinalMerge`入口のガード（`runner.ts`）と`runFinalMergeWithCiGate`へ渡す
      // `isCancelled`（`forge.ts`）が同じ`haltedByUser`を見るため、入口のガード**だけ**を
      // 消してもこのテストは通過したまま赤くならない（2重の防御の片方がもう片方をマスクする。
      // design.md §16.25の確認事項6）。`isCancelled`はCIゲート（`runFinalMergeWithCiGate`）の
      // 内側でしか働かないため、それより手前で起きる副作用を観測点にすれば入口ガードだけを
      // 検証できる。`draftPullRequest: true`にすると、`performFinalMerge`は入口ガードの直後・
      // `runFinalMergeWithCiGate`を呼ぶよりも前に統合PR/MRのready化（`gh pr ready <number>`）を
      // 行う（design.md §16.18）。入口ガードが効いていれば`pr ready`は一度も呼ばれない。
      // 入口ガードだけを消すと（`isCancelled`はまだ効かない箇所のため）`pr ready`が呼ばれて
      // しまい、このテストが赤くなる
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const cli = fakeForgeCli({
        ciStatusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { draftPullRequest: true }),
      });
      const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // T1が終わってfinalizeForge（`finalMerge: auto`の経路）が走る前に、人が
      // 「全体の停止」を押した、という状況を模す
      runner.stop(runId);
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // `pr ready`は、pullRequest: per-task（既定）のタスク層自身のPRready化
      // （`runnerMerge.ts`の`buildMarkTaskPullRequestReady`。T1の統合ブランチへの取り込み時に
      // 呼ばれ、`haltedByUser`とは無関係な既存の挙動）で1回はどうしても呼ばれてしまう。
      // 入口ガードが効いていれば、統合PR/MRぶんの2回目の`pr ready`（`performFinalMerge`）は
      // 呼ばれないため、合計はちょうど1回にとどまる。入口ガードだけを消すと2回になり赤くなる
      const readyCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'ready');
      expect(readyCalls).toHaveLength(1);
      // CIの完了待ち・マージコマンドのいずれも一度も呼ばれない（統合PR/MRの作成自体・
      // レビューコメントのポーリング開始（design.md §16.30、Issue #339）は
      // `haltedByUser`と無関係に走る既存/新規の仕様のため、ここでは確認しない。
      // `--json=statusCheckRollup`（CI状態）を`--json=reviews,comments`
      // （レビューコメント）と区別して、CI待ちだけを狙って確認する
      expect(
        cli.calls.some(
          (c) =>
            c.args[0] === 'pr' && c.args[1] === 'view' && c.args[3] === '--json=statusCheckRollup',
        ),
      ).toBe(false);
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.finalMergeOutcome).toBe('failed');
      expect(
        snapshot?.warnings.some((w) =>
          w.message.includes('人が停止したため最終マージを中止しました'),
        ),
      ).toBe(true);
    });

    it('CI待ちの最中に「全体の停止」を押すと、その後CIが緑だと分かってもpr mergeは一度も呼ばれない', async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const baseCli = fakeForgeCli({
        ciStatusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
      const ref: { runner?: WorkflowRunner; runId?: string } = {};
      const cli = wrapCliWithSideEffect(baseCli, (command, args) => {
        if (
          command === 'gh' &&
          args[0] === 'pr' &&
          args[1] === 'view' &&
          ref.runner !== undefined &&
          ref.runId !== undefined
        ) {
          // CI状態（`gh pr view --json=statusCheckRollup`）を実際に取得している最中に
          // 人が「全体の停止」を押した、という状況を模す
          ref.runner.stop(ref.runId);
        }
      });
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
      });
      const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
      ref.runner = runner;
      ref.runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // CI状態そのものは取得している（`isCancelled`は`pr view`を呼ぶ前に確認するため、
      // 呼び出しの直後に停止しても取得自体は妨げない）。CIが緑と分かった直後の
      // 停止確認（マージ直前のチェックポイント）でマージへ進まない、という点を確かめる
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'view')).toBe(true);
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      const snapshot = runner.getSnapshot(ref.runId as string);
      expect(snapshot?.finalMergeOutcome).toBe('failed');
      expect(
        snapshot?.warnings.some((w) =>
          w.message.includes('人が停止したため最終マージを中止しました'),
        ),
      ).toBe(true);
    });
  });

  it('finalMerge: pr-onlyなら統合PR/MRは作るがmainへはマージしない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'pr-only' }),
    });
    await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(true);
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
  });

  it('統合PR/MRの作成に失敗していれば、finalMerge: autoでもmainへはマージしない（design.md §16.18）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ failCreate: true });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { pullRequest: 'integration' }),
    });
    await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
  });

  it('pullRequest: noneならタスク層・統合層のいずれもPR/MRを作らない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { pullRequest: 'none' }),
    });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(cli.calls.some((c) => c.args[0] === 'pr')).toBe(false);
  });

  it('WorkflowRunnerDeps.forgeが渡されていなければPR/MRを一切作らない（既存の呼び出しはそのまま動く）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeSkipped')).toBe(false);
  });

  it(
    '最終マージには統合PR/MRの番号（live.integrationPullRequest.number）を明示的に渡す' +
      '（design.md §16.18・Issue #404の回帰）',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/77' });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { pullRequest: 'integration' }),
      });
      const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      const mergeCall = cli.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
      expect(mergeCall?.args).toEqual(['pr', 'merge', '77', '--merge']);
    },
  );

  it(
    '統合PR/MRのURLから番号を取り出せなければ最終マージを飛ばし、' +
      '「番号が不明」を含む警告を残す（design.md §16.18・Issue #404の回帰）',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      // 末尾が10進数にならないURLにして`parsePullRequestNumberFromUrl`が失敗する経路を通す
      const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/not-a-number' });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { pullRequest: 'integration' }),
      });
      const result = await runner.start('/repo/.agents/workflows/forge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      // 番号が不明なので`runFinalMerge`自体がCLIを呼ばない
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      const snapshot = runner.getSnapshot(runId);
      const warning = snapshot?.warnings.find((w) => w.kind === 'forgeFailed');
      expect(warning?.message).toContain('番号が不明');
    },
  );
});

describe('WorkflowRunner: レビューコメントの取り込み（design.md §16.30、roadmap W5、Issue #339）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: review-comment-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    '統合PR/MRにレビューコメントが付くと、警告欄へ全文で記録され' +
      'オーケストレーターへも通知される（本番の呼び出し経路: finalizeForge→' +
      'startReviewCommentPoll→setIntervalの発火→pollReviewComments）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({
        reviewComments: {
          github: {
            comments: [
              {
                databaseId: 55,
                author: { login: 'reviewer1' },
                body: 'ここを直してください',
                createdAt: '2026-08-23T00:00:00Z',
              },
            ],
          },
        },
      });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
        readReviewCommentPollIntervalSec: () => 60,
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      // `startReviewCommentPoll`は立てた直後にも1度取得する（次の周期まで待たせない）ため、
      // タイマーを進めなくても最初の1件はここまでで届く
      const snapshot = runner.getSnapshot(runId);
      const warning = snapshot?.warnings.find((w) => w.kind === 'reviewCommentImported');
      expect(warning?.message).toContain('reviewer1');
      expect(warning?.message).toContain('ここを直してください');

      // オーケストレーターへも`reviewComment`イベントとして届く（`taskMessage`/
      // `taskQuestion`と同じ`<workflow-event>`の囲い。design.md §16.23・§16.24）
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });
      const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
      expect(last).toContain('kind="reviewComment"');
      expect(last).toContain('reviewer1');
      expect(last).toContain('ここを直してください');
    },
  );

  it('同じコメントは2周目のポーリングで重複して取り込まない（idで重複排除）', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli({
      reviewComments: {
        github: {
          comments: [
            {
              databaseId: 1,
              author: { login: 'reviewer1' },
              body: '直して',
              createdAt: '2026-08-23T00:00:00Z',
            },
          ],
        },
      },
    });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
      readReviewCommentPollIntervalSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(
      runner.getSnapshot(runId)?.warnings.filter((w) => w.kind === 'reviewCommentImported'),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    // 同じコメント（同じid）は2周目でも増えない
    expect(
      runner.getSnapshot(runId)?.warnings.filter((w) => w.kind === 'reviewCommentImported'),
    ).toHaveLength(1);
  });

  it('agent.workflows.reviewCommentPollIntervalSecが0ならレビューコメントを取得しない', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli({
      reviewComments: {
        github: {
          comments: [{ databaseId: 1, author: { login: 'reviewer1' }, body: '直して' }],
        },
      },
    });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
      readReviewCommentPollIntervalSec: () => 0,
    });
    const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(cli.calls.some((c) => c.args[3] === '--json=reviews,comments')).toBe(false);
    expect(
      runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'reviewCommentImported'),
    ).toBe(false);
  });

  it(
    'レビューコメント取得のCLI呼び出しが失敗しても、警告を出すだけでrunを止めない' +
      '（design.md §16.18「前提が欠けている場合」と同じ、runを止めない方針）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({ failReviewComments: true });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
        readReviewCommentPollIntervalSec: () => 60,
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.outcome).toBe('succeeded');
      expect(snapshot?.warnings.some((w) => w.kind === 'reviewCommentImported')).toBe(false);
    },
  );

  it(
    '最終マージが確定した後（finalMerge: auto）は、レビューコメント取得CLIの' +
      'ポーリングが止まる（3度目のレビューblocking指摘の回帰: 以前は`performFinalMerge`' +
      '完了後もタイマーが動き続け、VSCodeを閉じるまでAPIを叩き続けていた。本番の呼び出し' +
      '経路: performFinalMergeがfinalMergeOutcomeを確定させる1点でcloseReviewCommentPoll' +
      'を直接呼ぶ）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({
        reviewComments: {
          github: {
            comments: [{ databaseId: 1, author: { login: 'reviewer1' }, body: '対応済みです' }],
          },
        },
      });
      // `readReviewCommentPollIntervalSec`を敢えて指定せず、既定値
      // （`DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC` = 600秒）で計測する
      // （コーディネーターの実測と同じ条件）
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // finalMerge: auto（既定）なので、ここまでで最終マージは確定している
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBe('merged');
      const pollCall = (c: { args: readonly string[] }) => c.args[3] === '--json=reviews,comments';
      const before = cli.calls.filter(pollCall).length;
      // `startReviewCommentPoll`は立てた直後にも1度取得するため、この時点で最低1回は
      // 呼ばれている
      expect(before).toBeGreaterThanOrEqual(1);

      // 既定の間隔（600秒）× 10周期ぶんタイマーを進める（コーディネーターの実測と同じ条件）
      await vi.advanceTimersByTimeAsync(600_000 * 10);
      await flush();

      const after = cli.calls.filter(pollCall).length;
      // 最終マージ確定後はポーリングのタイマー自体が閉じているため、10周期進めても
      // 呼び出し回数は増えない（以前は`before`から`+10`まで増え続けていた）
      expect(after).toBe(before);
      expect(store.find(runId)?.finalMergeOutcome).toBe('merged');
    },
  );

  it(
    'finalMerge: pr-onlyでrunがsucceededで終わった後も、レビューコメント取得CLIの' +
      'ポーリングは意図的に生きたまま（`finalMergeOutcome`が確定しないため）で、' +
      '呼び出し回数はタイマーを進めるほど増え続ける（design.md §16.30' +
      "「finalMerge: 'pr-only'ではポーリングを閉じない」の意図をテストで固定する。" +
      "これが将来'閉じる'方向に変わったらこのテストが気づく）",
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({
        reviewComments: {
          github: {
            comments: [{ databaseId: 1, author: { login: 'reviewer1' }, body: '対応済みです' }],
          },
        },
      });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { finalMerge: 'pr-only' }),
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // finalMerge: pr-onlyはperformFinalMergeを一切通らないため、runがsucceededで
      // 終わった後もfinalMergeOutcomeは確定しない
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBeUndefined();
      const pollCall = (c: { args: readonly string[] }) => c.args[3] === '--json=reviews,comments';
      const before = cli.calls.filter(pollCall).length;
      expect(before).toBeGreaterThanOrEqual(1);

      // 既定の間隔（600秒）× 10周期ぶんタイマーを進める
      await vi.advanceTimersByTimeAsync(600_000 * 10);
      await flush();

      const after = cli.calls.filter(pollCall).length;
      // finalMergeOutcomeが確定しないため閉じ口（performFinalMerge・
      // closeMessagingIfFinalMergeSettled）のどれにも到達せず、ポーリングは開いたまま
      // 呼び出し回数が増え続ける（意図的な挙動。design.md参照）
      expect(after).toBeGreaterThan(before);
      expect(store.find(runId)?.finalMergeOutcome).toBeUndefined();
    },
  );

  it(
    '最終マージが確定済み（finalMerge: auto。既にmainへマージ済み）の後にレビューコメントが' +
      '届いても、add_taskは理由付きで拒否される（2度目のレビューblocking指摘の回帰:' +
      '追加したタスクの成果が統合ブランチには積まれるのにmainへは二度と届かない、という' +
      '乖離を黙って許してはならない。本番の呼び出し経路: finalizeForgeが' +
      'performFinalMergeまで完了しlive.finalMergeOutcomeが確定した後、' +
      'planChangeFinishedReasonがreviewCommentPollの生死とは別にfinalMergeOutcomeを見て拒否する）',
    async () => {
      vi.useFakeTimers();
      const { deps: messaging, state } = fakeMessagingDeps();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({
        reviewComments: {
          github: {
            comments: [
              { databaseId: 1, author: { login: 'reviewer1' }, body: '追加対応してください' },
            ],
          },
        },
      });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
        messaging,
        readReviewCommentPollIntervalSec: () => 60,
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // runは既に終了扱い（統合PR/MR作成・最終マージまで完了）。レビューコメント自体は
      // 届いて警告欄へ記録されるが、最終マージが確定した時点でポーリングは既に閉じている
      // （`performFinalMerge`が`closeReviewCommentPoll`を直接呼ぶ。design.md §16.30
      // 「レビューコメントのポーリングを最終マージ確定の1点で閉じる」参照）
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBe('merged');
      expect(
        runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'reviewCommentImported'),
      ).toBe(true);

      const port = state.hub?.orchestratorControl;
      if (port === undefined) {
        throw new Error('制御ツールが配線されていません');
      }
      const addResult = port.addTask({ id: 'T2', prompt: 'p2', done: 'd2', dependsOn: [] });

      // 最終マージ確定後は拒否し、理由をオーケストレーターへ返す（黙って乖離させない）。
      // ポーリングが既に閉じているため、ここでは`planChangeFinishedReason`の基本経路
      // （`runFinishedReason`と同じ「run終了」の理由）で拒否される。`live.finalMergeOutcome`
      // ベースの専用の理由文は、ポーリングを閉じ損なう経路が万一残っていた場合の多層防御
      // であり、その経路は下の回帰テスト（`finalMergeOutcome`の判定を`if (false)`へ戻す）
      // で別途確かめる
      expect(addResult.accepted).toBe(false);
      if (addResult.accepted) {
        throw new Error('unreachable');
      }
      expect(addResult.reason).toContain('終了しています');

      // 拒否されたのでrunは走行中へ戻らず、T2も一切作られない
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');
      expect(store.find(runId)?.tasks['T2']).toBeUndefined();

      // 統合PR/MRは1回しか作られておらず、mainへのマージも1回のまま
      const integrationCreateCalls = cli.calls.filter(
        (c) =>
          c.args[0] === 'pr' &&
          c.args[1] === 'create' &&
          c.args.some((a) => a.startsWith('--base=main')),
      );
      expect(integrationCreateCalls).toHaveLength(1);
      const finalMergeCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
      expect(finalMergeCalls).toHaveLength(1);
    },
  );

  it(
    '最終マージがまだ確定していない間（finalMerge: orchestrator、判断待ち）にレビュー' +
      'コメントが届いた場合はadd_taskが通り、追加したタスクは実際にスケジュールされて' +
      '完走し、その後の最終マージ確定（decideFinalMerge(merge)）でT2の成果を含めて' +
      'mainへ1回だけマージされる（Issue #339 blocking指摘の回帰: 「gateの先」＝通知だけで' +
      '終わらせず、成果が実際にmainへ届くところまで確かめる）',
    async () => {
      vi.useFakeTimers();
      const { deps: messaging, state } = fakeMessagingDeps();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli({
        reviewComments: {
          github: {
            comments: [
              { databaseId: 1, author: { login: 'reviewer1' }, body: '追加対応してください' },
            ],
          },
        },
      });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
        messaging,
        readReviewCommentPollIntervalSec: () => 60,
      });
      const result = await runner.start('/repo/.agents/workflows/review.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // 統合PR/MRは作られているが、最終マージの判断はまだ付いていない
      // （finalMerge: orchestrator。design.md §16.26）。この判断待ちの間だけMCPサーバーも
      // レビューコメントのポーリングも生きている
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBeUndefined();
      expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });
      expect(
        runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'reviewCommentImported'),
      ).toBe(true);

      const port = state.hub?.orchestratorControl;
      if (port === undefined) {
        throw new Error('制御ツールが配線されていません');
      }
      const addResult = port.addTask({ id: 'T2', prompt: 'p2', done: 'd2', dependsOn: [] });
      expect(addResult.accepted).toBe(true);

      // 追加直後、runは走行中へ戻る（`getRunOutcome`はpendingが1件でもあれば'running'を
      // 返す。design.md §16.30「レビューコメントを受けた計画変更」）
      expect(runner.getSnapshot(runId)?.outcome).toBe('running');

      await flush();
      const t2 = codexHost.byTaskId('T2');
      t2.finish('done', doneState('ok2'));
      await flush();

      expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');
      // T2が加わった後も最終マージの判断はまだ付いていない
      // （finalizeForgeの冪等ガードで2回目の統合PR/MR作成・判断待ち開始は起きない）
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBeUndefined();
      expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });

      // 統合PR/MRの作成は1回のまま（`finalizeForge`の冪等ガード）
      const integrationCreateCalls = cli.calls.filter(
        (c) =>
          c.args[0] === 'pr' &&
          c.args[1] === 'create' &&
          c.args.some((a) => a.startsWith('--base=main')),
      );
      expect(integrationCreateCalls).toHaveLength(1);

      // T1・T2それぞれの統合ブランチへの取り込み（タスク層マージ）が実際に走っている
      // ことを確認する。これがT2の成果が統合ブランチへ入っている証跡
      const taskMergeCalls = git.calls.filter(
        (c) =>
          c.args[0] === 'merge' && c.args.some((a) => typeof a === 'string' && a.includes('-m')),
      );
      const t1Merged = taskMergeCalls.some((c) =>
        c.args.some((a) => typeof a === 'string' && a.includes('T1')),
      );
      const t2Merged = taskMergeCalls.some((c) =>
        c.args.some((a) => typeof a === 'string' && a.includes('T2')),
      );
      expect(t1Merged).toBe(true);
      expect(t2Merged).toBe(true);

      // ここで初めて最終マージを確定する。T2の成果を含む統合ブランチがmainへ1回だけ
      // マージされることを確かめる（「gateの先」まで進めた検証）
      const accepted = runner.decideFinalMerge(runId, 'merge', 'レビュー対応も含めて確認済み');
      await flush();

      expect(accepted).toBe(true);
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBe('merged');
      const finalMergeCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
      expect(finalMergeCalls).toHaveLength(1);

      // 適用した内容が警告欄へ全文で残る（W4と同じ経路、design.md §16.29）
      const added = runner
        .getSnapshot(runId)
        ?.warnings.find((w) => w.kind === 'orchestratorTaskAdded');
      expect(added?.message).toContain('T2');

      // 判断が確定したのでMCPサーバー・レビューコメントのポーリングは閉じる
      expect(state.handle?.closed).toBe(true);
    },
  );
});

describe('WorkflowRunner: タスクのtypeがコミットメッセージへ反映される（design.md §16.6）', () => {
  it('typeを指定したタスクは、マージコミットのメッセージが<type>(<taskId>): merge task (...)になる', async () => {
    const YAML = `
version: 1
name: type-test
tasks:
  - id: T1
    type: fix
    prompt: p1
    done: d1
`;
    const git = fakeGit();
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/type.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const mergeCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
    expect(mergeCall?.args).toContain(`fix(T1): merge task (run ${runId})`);
  });

  it('typeを省略したタスクは、既定のchoreがマージコミットのメッセージに使われる', async () => {
    const YAML = `
version: 1
name: type-default-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;
    const git = fakeGit();
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/type-default.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const mergeCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
    expect(mergeCall?.args).toContain(`chore(T1): merge task (run ${runId})`);
  });
});

describe('WorkflowRunner: ブランチ命名（agent.workflows.branchNaming、design.md §16.6）', () => {
  it('branchNaming: conventional かつタスクにissueがあれば、GitLab運用規約形式のブランチでworktreeが作られる', async () => {
    const YAML = `
version: 1
name: branch-naming-test
tasks:
  - id: T1
    type: fix
    issue: 42
    prompt: p1
    done: d1
`;
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(YAML, {
      git,
      forge: fakeForgeDeps(cli, { branchNaming: 'conventional' }),
    });
    const result = await runner.start('/repo/.agents/workflows/branch-naming.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // 統合worktree（1回目のworktree add）は常にwf形式。タスクworktree（T1、2回目）が
    // conventional形式（fix/42/t1-<runId先頭8文字>）になっているかを見る
    const taskWorktreeAdd = git.calls.find(
      (c) =>
        c.args[0] === 'worktree' &&
        c.args[1] === 'add' &&
        typeof c.args[3] === 'string' &&
        c.args[3].startsWith('fix/42/'),
    );
    expect(taskWorktreeAdd).toBeDefined();
  });

  it('branchNaming: conventional でもissueが無いタスクは、従来どおりwf形式のブランチになる（後方互換）', async () => {
    const YAML = `
version: 1
name: branch-naming-fallback-test
tasks:
  - id: T1
    type: fix
    prompt: p1
    done: d1
`;
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(YAML, {
      git,
      forge: fakeForgeDeps(cli, { branchNaming: 'conventional' }),
    });
    const result = await runner.start(
      '/repo/.agents/workflows/branch-naming-fallback.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const taskWorktreeAdd = git.calls.find(
      (c) =>
        c.args[0] === 'worktree' &&
        c.args[1] === 'add' &&
        typeof c.args[3] === 'string' &&
        c.args[3].startsWith(`wf/${runId}/T1`),
    );
    expect(taskWorktreeAdd).toBeDefined();
  });

  it('branchNaming: wf（既定）のときは、issueがあってもwf形式のブランチのまま（既定挙動は変えない）', async () => {
    const YAML = `
version: 1
name: branch-naming-default-test
tasks:
  - id: T1
    type: fix
    issue: 42
    prompt: p1
    done: d1
`;
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(YAML, {
      git,
      forge: fakeForgeDeps(cli, { branchNaming: 'wf' }),
    });
    const result = await runner.start(
      '/repo/.agents/workflows/branch-naming-default.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const taskWorktreeAdd = git.calls.find(
      (c) =>
        c.args[0] === 'worktree' &&
        c.args[1] === 'add' &&
        typeof c.args[3] === 'string' &&
        c.args[3].startsWith(`wf/${runId}/T1`),
    );
    expect(taskWorktreeAdd).toBeDefined();
  });
});

describe('WorkflowRunner: Draft PR/MR（agent.workflows.draftPullRequest、design.md §16.18）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: draft-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it('draftPullRequest: falseのとき（既定）--draftを付けず、readyへの切替も呼ばない（既存挙動そのまま）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { draftPullRequest: false }),
    });
    await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const createCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(createCalls.length).toBe(2); // タスク層＋統合層
    expect(createCalls.every((c) => !c.args.includes('--draft'))).toBe(true);
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'ready')).toBe(false);
  });

  it(
    'draftPullRequest: trueのとき、タスク層PR/MRは--draft付きで作られ、' +
      '統合ブランチへのマージ後にreadyへ切り替わる',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
      const cli = fakeForgeCli();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { draftPullRequest: true, finalMerge: 'pr-only' }),
      });
      await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      const createCallIndex = cli.calls.findIndex(
        (c) =>
          c.args[0] === 'pr' &&
          c.args[1] === 'create' &&
          c.args.some((a) => a.startsWith('--base=wf/')),
      );
      const taskCreateCall = cli.calls[createCallIndex];
      expect(taskCreateCall?.args).toContain('--draft');

      // 統合ブランチへのローカルマージ（`git merge --no-ff`）自体は起きている
      expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff')).toBe(true);
      // readyへの切替（`gh pr ready 1`）はPR/MR作成より後、cliの呼び出し順で見て後ろに来る
      // （マージとの厳密な前後関係はrunTaskPullRequestFlowの型で強制済み・forge.test.tsで
      // 検証済みのため、ここではwiring自体が動いていること＝ready呼び出しの発生を見る）
      const readyCallIndex = cli.calls.findIndex(
        (c) => c.args[0] === 'pr' && c.args[1] === 'ready',
      );
      expect(readyCallIndex).toBeGreaterThan(createCallIndex);
    },
  );

  it(
    'GitLabホスト経由でも、draftPullRequest: trueのときタスク層MRは--field=draft=true付きで' +
      '作られ、統合ブランチへのマージ後にreadyへ切り替わる（レビュー指摘: 既存のDraft配線' +
      'テストがgit@github.com:...のGitHubパスだけだったため追加）',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@gitlab.example.com:acme/repo.git' });
      const cli = fakeForgeCli();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { draftPullRequest: true, finalMerge: 'pr-only' }),
      });
      await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      const createCallIndex = cli.calls.findIndex(
        (c) =>
          c.args[0] === 'api' &&
          c.args[1] === 'projects/:id/merge_requests' &&
          c.args.some((a) => a.startsWith('--field=source_branch=wf/')),
      );
      const taskCreateCall = cli.calls[createCallIndex];
      expect(taskCreateCall?.args).toContain('--field=draft=true');

      // 統合ブランチへのローカルマージ（`git merge --no-ff`）自体は起きている
      expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff')).toBe(true);
      // readyへの切替（`glab mr update <n> --ready`）はMR作成より後
      const readyCallIndex = cli.calls.findIndex(
        (c) => c.args[0] === 'mr' && c.args[1] === 'update' && c.args.includes('--ready'),
      );
      expect(readyCallIndex).toBeGreaterThan(createCallIndex);
    },
  );

  it('draftPullRequest: trueのとき、統合層PR/MRも--draft付きで作られ、最終マージの直前にreadyへ切り替わる', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { draftPullRequest: true }),
    });
    await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const createCalls = cli.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    const integrationCreateCall = createCalls.find((c) => c.args.some((a) => a === '--base=main'));
    expect(integrationCreateCall?.args).toContain('--draft');

    // 統合層は「最終マージの直前にready化」という、タスク層（マージの後）と逆の順序になる
    const readyCallIndices = cli.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.args[0] === 'pr' && c.args[1] === 'ready')
      .map(({ i }) => i);
    const finalMergeCallIndex = cli.calls.findIndex(
      (c) => c.args[0] === 'pr' && c.args[1] === 'merge',
    );
    expect(readyCallIndices.length).toBe(2); // タスク層＋統合層
    expect(finalMergeCallIndex).toBeGreaterThan(
      readyCallIndices[readyCallIndices.length - 1] ?? -1,
    );
  });

  it('readyへの切替に失敗しても、ワークフロー自体は止めず警告として残す（design.mdの「ワークフロー自体は止めない」方針）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ failReady: true });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { draftPullRequest: true, finalMerge: 'pr-only' }),
    });
    const result = await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // ready化の失敗はワークフローを止めない：タスク自体はdoneのまま
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeFailed')).toBe(true);
  });

  it('PR/MRのURLから番号を取り出せないときは、ready化を飛ばして警告を残す', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    // 番号を含まないURLにして`parsePullRequestNumberFromUrl`が失敗する経路を通す
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/not-a-number' });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { draftPullRequest: true, finalMerge: 'pr-only' }),
    });
    const result = await runner.start('/repo/.agents/workflows/draft.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'ready')).toBe(false);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'forgeFailed')).toBe(true);
  });
});

describe('WorkflowRunner: PR/MRの結果の保持・露出・永続化（design.md §16.11・§16.18、Issue #118）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: forge-result-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it('タスクPR/MRの番号・URLをスナップショットへ露出する（番号はURLから導く）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/42' });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const snapshot = runner.getSnapshot(runId);
    const task = snapshot?.tasks.find((t) => t.id === 'T1');
    expect(task?.pullRequestNumber).toBe(42);
    expect(task?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
  });

  /**
   * `fakeForgeDeps`の`fs`は本文を捨てるので、本文そのものを確かめたいときだけ差し替える。
   * `--body-file`へ渡す一時ファイルの中身＝PR/MRの本文（design.md §16.18）。
   */
  function captureForgeBodies(deps: WorkflowRunnerForgeDeps): {
    deps: WorkflowRunnerForgeDeps;
    bodies: string[];
  } {
    const bodies: string[] = [];
    return {
      bodies,
      deps: {
        ...deps,
        fs: {
          async writeTempFile(content: string): Promise<string> {
            bodies.push(content);
            return '/tmp/fake-forge-body.md';
          },
          async removeTempFile(): Promise<void> {
            return undefined;
          },
        },
      },
    };
  }

  const ISSUE_TASK_YAML = `
version: 1
name: forge-closes-test
tasks:
  - id: T1
    prompt: p1
    done: d1
    issue: 12
`;

  it('issueを持つタスクのPR/MR本文にCloses #<N>を出す（Issue #137）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/42' });
    const captured = captureForgeBodies(fakeForgeDeps(cli));
    const { runner, codexHost } = createHarness(ISSUE_TASK_YAML, {
      git,
      forge: captured.deps,
    });
    await runner.start('/repo/.agents/workflows/forge-closes.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(captured.bodies.some((body) => body.includes('Closes #12'))).toBe(true);
  });

  it('issueを持たないタスクのPR/MR本文にはCloses行を出さない（Issue #137）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/42' });
    const captured = captureForgeBodies(fakeForgeDeps(cli));
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: captured.deps,
    });
    await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(captured.bodies.length).toBeGreaterThan(0);
    expect(captured.bodies.some((body) => body.includes('Closes #'))).toBe(false);
  });

  it('タスクPR/MRの番号・URLを永続化する（応答本文は含まない）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/42' });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const persistedTask = store.find(runId)?.tasks['T1'];
    expect(persistedTask?.pullRequestNumber).toBe(42);
    expect(persistedTask?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
    // 応答本文（doneStateのturnResultText）は永続化データへ混ざらない
    const serialized = JSON.stringify(store.list());
    expect(serialized).not.toContain('turnResultText');
  });

  it('統合PR/MRの番号・URLと、finalMerge: auto成功時のfinalMergeOutcome（merged）をスナップショットへ露出する', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/1' });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.integrationPullRequestNumber).toBe(1);
    expect(snapshot?.integrationPullRequestUrl).toBe('https://github.com/acme/repo/pull/1');
    expect(snapshot?.finalMergeOutcome).toBe('merged');
    // 永続化にも反映されている
    expect(store.find(runId)?.integrationPullRequestNumber).toBe(1);
    expect(store.find(runId)?.finalMergeOutcome).toBe('merged');
  });

  it('finalMerge: pr-onlyのときはfinalMergeOutcomeがundefinedのまま（最終マージを試みていない）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'pr-only' }),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.integrationPullRequestNumber).toBeDefined();
    expect(snapshot?.finalMergeOutcome).toBeUndefined();
  });

  it('最終マージに失敗すればfinalMergeOutcomeがfailedになる', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ failMerge: true });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBe('failed');
  });

  it(
    'PR/MRの前提が欠けていれば、タスク・統合いずれのPR/MRの番号・URLも露出しない' +
      '（受入基準「PR/MRが作られなかったrunでは...作られなかったことが分かるようにする」）',
    async () => {
      const git = fakeGit(); // originのremoteが無い
      const cli = fakeForgeCli();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli),
      });
      const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      const snapshot = runner.getSnapshot(runId);
      const task = snapshot?.tasks.find((t) => t.id === 'T1');
      expect(task?.pullRequestNumber).toBeUndefined();
      expect(task?.pullRequestUrl).toBeUndefined();
      expect(snapshot?.integrationPullRequestNumber).toBeUndefined();
      expect(snapshot?.integrationPullRequestUrl).toBeUndefined();
      expect(snapshot?.finalMergeOutcome).toBeUndefined();
    },
  );

  it('リロード後もPR/MRへのリンクが残る（永続化された値からのフォールバック。受入基準）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli({ prUrl: 'https://github.com/acme/repo/pull/9' });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    const result = await runner.start('/repo/.agents/workflows/forge-result.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // 同じstoreを共有する新しいWorkflowRunnerインスタンス（ウィンドウのリロードを模す）
    const reloadedHost = new FakeHost();
    const reloadedRunner = new WorkflowRunner({
      // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
      // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
      // （design.md §16.35、roadmap W10、Issue #584）
      readAutoResume: () => false,
      hosts: { codex: reloadedHost, claude: reloadedHost },
      worktreeQueue: new WorktreeCreationQueue(),
      git,
      fs: identityFs,
      filePort: filePort(SINGLE_TASK_YAML),
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });
    await reloadedRunner.restoreRunsForView();

    const snapshot = reloadedRunner.getSnapshot(runId);
    const task = snapshot?.tasks.find((t) => t.id === 'T1');
    // リロード直後はこのウィンドウでまだセッションを開いていない（hasLiveSession: false）が、
    // PR/MRのリンクは永続化された値から出る
    expect(task?.hasLiveSession).toBe(false);
    expect(task?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/9');
    expect(snapshot?.integrationPullRequestUrl).toBe('https://github.com/acme/repo/pull/9');
  });
});

describe('WorkflowRunner: タスクのIssue起票（design.md §16.31、roadmap W6、Issue #596）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: task-issue-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  /**
   * `fakeForgeDeps`の`fs`は本文を捨てるので、本文そのものを確かめたいときだけ差し替える
   * （`WorkflowRunner: PR/MRの結果の保持...`describeの同名関数と同じ実装）。
   */
  function captureForgeBodies(deps: WorkflowRunnerForgeDeps): {
    deps: WorkflowRunnerForgeDeps;
    bodies: string[];
  } {
    const bodies: string[] = [];
    return {
      bodies,
      deps: {
        ...deps,
        fs: {
          async writeTempFile(content: string): Promise<string> {
            bodies.push(content);
            return '/tmp/fake-forge-body.md';
          },
          async removeTempFile(): Promise<void> {
            return undefined;
          },
        },
      },
    };
  }

  it('既定（createTaskIssue: false）ではIssueを起票しない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    await runner.start('/repo/.agents/workflows/task-issue.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(cli.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create')).toBe(false);
  });

  it('createTaskIssue: trueなら、タスク開始時にIssueを起票しPR本文から参照する', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli({ issueUrl: 'https://github.com/acme/repo/issues/99' });
    const captured = captureForgeBodies(fakeForgeDeps(cli, { createTaskIssue: true }));
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: captured.deps,
    });
    await runner.start('/repo/.agents/workflows/task-issue.yaml', '/repo');
    await flush();

    // Issueの起票はタスク開始時（セッションを開く前後）に行われる。ここでは開始済み
    // （セッションが立ち上がっている）ことをもって「タスク開始後」を確認する
    expect(cli.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create')).toBe(true);
    const createCall = cli.calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
    expect(createCall?.args.some((a) => a === '--title=T1: p1')).toBe(true);

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // Issueの番号（URLから取り出した99）がPR本文から参照される
    expect(captured.bodies.some((body) => body.includes('#99'))).toBe(true);
  });

  it('pullRequest: integration（per-task以外）ではcreateTaskIssue: trueでも起票しない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { createTaskIssue: true, pullRequest: 'integration' }),
    });
    await runner.start('/repo/.agents/workflows/task-issue.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(cli.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create')).toBe(false);
  });

  it('YAML側で既にissueが指定されているタスクは、createTaskIssue: trueでも起票しない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const YAML_WITH_ISSUE = `
version: 1
name: task-issue-existing-test
tasks:
  - id: T1
    prompt: p1
    done: d1
    issue: 12
`;
    const { runner, codexHost } = createHarness(YAML_WITH_ISSUE, {
      git,
      forge: fakeForgeDeps(cli, { createTaskIssue: true }),
    });
    await runner.start('/repo/.agents/workflows/task-issue-existing.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(cli.calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create')).toBe(false);
  });

  it('Issueの起票が失敗しても、runは止めず警告を出すだけでタスクは完了する', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli({ failIssueCreate: true });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { createTaskIssue: true }),
    });
    const result = await runner.start('/repo/.agents/workflows/task-issue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'taskIssueFailed')).toBe(true);
    // PR/MR自体は通常どおり作られる（Issueが起票できなくてもPR/MR作成は止めない）
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(true);
  });

  /**
   * `maybeCreateTaskIssue`の呼び出し位置は、`prepareTaskLaunch`内のbypassPermissions
   * 最終防御（`if (task.provider === 'claude' && effective.config.approvalMode ===
   * 'bypassPermissions' && !baseline.allowClaudeBypassPermissions) { throw ... }`）より
   * **後**でなければならない（レビュー指摘）。先に呼ぶと、「危険判定が働かない設定なので
   * 開始できません」と拒否したタスクについても、外部ホストへIssueだけが起票されたまま
   * 残ってしまう。
   *
   * この不変条件は、実行時の呼び出し順序としては直接検証できない。`buildEffectiveTaskConfig`
   * （唯一のクランプ入口、design.md §16.16）が`bypassPermissions`を必ず`acceptEdits`へ
   * 読み替える（`baseline.allowClaudeBypassPermissions`が有効なときを除くが、その場合は
   * throw自体の条件`!baseline.allowClaudeBypassPermissions`を満たさずthrowが起きない）ため、
   * このthrow分岐は現在の唯一の正規経路（`buildEffectiveTaskConfig`経由）からは到達し得ない
   * 多層防御であり、単体テストの中で実際にthrowを起こす前提を作れない
   * （`taskConfig.ts`のコメント「通常この分岐へは入らない」のとおり）。
   *
   * そのため、ソースの並び順そのもの（`maybeCreateTaskIssue(`の呼び出しが、throwの本文
   * （実効approvalModeがbypassPermissionsのため、のエラーメッセージ）より後に現れること）
   * を機械的に固定する。呼び出し位置を元（`resolveWorkingDirectory`の直後）へ戻すと、
   * このテストは失敗する（§16.25 #8で実測済み。最終報告に貼る）。
   */
  it('maybeCreateTaskIssueの呼び出しは、bypassPermissionsの最終防御より後のソース位置にある', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/orchestrator/runner.ts'),
      'utf8',
    );
    const throwIndex = source.indexOf(
      '実効approvalModeがbypassPermissionsのため、このタスクは開始できません',
    );
    const callIndex = source.indexOf('await this.maybeCreateTaskIssue(');
    expect(throwIndex).toBeGreaterThan(0);
    expect(callIndex).toBeGreaterThan(0);
    expect(callIndex).toBeGreaterThan(throwIndex);
  });
});

describe('WorkflowRunner: タスクPR/MRのレビュー段（design.md §16.31、roadmap W6、Issue #596）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: task-review-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it('既定（reviewTaskPullRequest: false）ではレビューセッションを開かない', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli),
    });
    await runner.start('/repo/.agents/workflows/task-review.yaml', '/repo');
    await flush();
    // タスク本体のセッションが1つ開いた時点
    const openCountBeforeFinish = codexHost.openInputs.length;

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // タスク本体のセッション以外に、レビュー用の追加セッションは開かれない
    expect(codexHost.openInputs.length).toBe(openCountBeforeFinish);
  });

  it('reviewTaskPullRequest: trueなら、PR/MR作成後・マージ前に読み取り専用セッションでレビューする', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { reviewTaskPullRequest: true }),
    });
    const result = await runner.start('/repo/.agents/workflows/task-review.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    // タスク本体のセッションが1つ開いた時点
    const openCountBeforeFinish = codexHost.openInputs.length;

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // レビュー用の読み取り専用セッションが1つ追加で開かれている
    // （`buildPlannerSessionInput`と同じ形。design.md §16.28と同じ「起動設定で読み取り
    // 専用を担保する」方式）
    expect(codexHost.openInputs.length).toBe(openCountBeforeFinish + 1);
    const reviewInput = codexHost.openInputs[codexHost.openInputs.length - 1];
    expect(reviewInput?.sandbox).toBe('read-only');

    // レビューセッションは`sendSingleTurn`で1ターンの応答を待っている状態なので、
    // ここで応答を返して完了させる（指摘なし＝空配列）
    const reviewSession = codexHost.sessions[codexHost.sessions.length - 1];
    reviewSession?.finish('done', doneState('[]'));
    await flush();

    // レビューを挟んでもタスクは最終的に完了する（マージを止めない）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
  });
});

describe('WorkflowRunner.cleanupIntegration（design.md §16.8「そのほか」・§16.17、Issue #118）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: cleanup-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it('runが終わっていれば、統合worktreeと終わったタスクのworktreeをまとめて撤去する', async () => {
    const git = fakeGit();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/cleanup.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const cleanup = await runner.cleanupIntegration(runId);
    expect(cleanup.integrationApplicable).toBe(true);
    expect(cleanup.integrationRemoved).toBe(true);
    expect(cleanup.integrationFailedMessage).toBeUndefined();
    expect(cleanup.tasksRemoved).toContain('T1');

    const removeCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCalls.some((c) => c.args[2]?.includes('_integration'))).toBe(true);
    // ブランチ自体は消さない（design.md §16.17「ブランチは消さない」）。
    // `git worktree remove`はworktreeの参照を外すだけで`branch -d`を呼ばない
    expect(git.calls.some((c) => c.args[0] === 'branch')).toBe(false);
  });

  it('runが実行中の間は統合worktreeを撤去しない（blockedタスクの再マージが使い続けるため）', async () => {
    const YAML2 = `
version: 1
name: cleanup-running
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;
    const git = fakeGit();
    const { runner, codexHost } = createHarness(YAML2, { git });
    const result = await runner.start('/repo/.agents/workflows/cleanup2.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    // T2はT1完了後に走り始めるが、まだ終わっていない（runは`running`のまま）

    const cleanup = await runner.cleanupIntegration(runId);
    expect(cleanup.integrationRemoved).toBe(false);
    expect(cleanup.integrationFailedMessage).toBe(
      'runが実行中のため統合worktreeは撤去しませんでした',
    );
  });

  it('未コミットの変更が残っている統合worktreeは撤去せず失敗として返す（既存の方針。design.md §16.17）', async () => {
    const git = fakeGit();
    const originalRun = git.run.bind(git);
    const dirtyGit: FakeGitHandle = {
      ...git,
      run: async (args, cwd) => {
        if (args[0] === 'status' && args[1] === '--porcelain' && cwd.includes('_integration')) {
          return { code: 0, stdout: ' M some-file.txt\n', stderr: '' };
        }
        return originalRun(args, cwd);
      },
    };
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, { git: dirtyGit });
    const result = await runner.start('/repo/.agents/workflows/cleanup3.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const cleanup = await runner.cleanupIntegration(runId);
    expect(cleanup.integrationRemoved).toBe(false);
    expect(cleanup.integrationFailedMessage).toContain('未コミットの変更');
  });

  it('onProgressにタスク分＋統合worktree1件分の進捗を順に報告する（Issue #298）', async () => {
    const git = fakeGit();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/cleanup-progress.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const progressUpdates: Array<{ done: number; total: number; label: string }> = [];
    const cleanup = await runner.cleanupIntegration(runId, (p) => progressUpdates.push(p));

    expect(cleanup.integrationRemoved).toBe(true);
    // タスク（T1）1件＋統合worktree1件で合計2件、doneが1→2と単調に増える
    expect(progressUpdates).toHaveLength(2);
    expect(progressUpdates[0]).toMatchObject({ done: 1, total: 2 });
    expect(progressUpdates[1]).toMatchObject({ done: 2, total: 2 });
  });
});

describe('WorkflowRunner: 疑似worktree（design.md §16.20、Issue #105）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: pseudo-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  it(
    'decideWorkingDirectoryのgit外フォールバックから疑似worktreeを使い、' +
      'runの終了時にワークスペースへ反映する',
    async () => {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
      const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
        git,
        pseudoWorktree: { fs, exclude: [] },
      });
      const result = await runner.start('/repo/.agents/workflows/pseudo.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
      expect(t1.cwd).toBe(cloneDir);
      // ワークスペースの内容が複製されている
      expect(fs.files.get(path.join(cloneDir, 'a.txt'))).toEqual({ size: 10, mtimeMs: 100 });

      // タスクがファイルを1件変更し、1件追加したとする
      fs.setFile(path.join(cloneDir, 'a.txt'), { size: 20, mtimeMs: 200 });
      fs.setFile(path.join(cloneDir, 'b.txt'), { size: 5, mtimeMs: 50 });
      t1.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      // runの終了時にワークスペースへ反映される
      expect(fs.files.get('/repo/a.txt')).toEqual({ size: 20, mtimeMs: 200 });
      expect(fs.files.get('/repo/b.txt')).toEqual({ size: 5, mtimeMs: 50 });
    },
  );

  it('worktree-strictはgit外では実行を開始しない挙動を保つ', async () => {
    const git = fakeGit({ notGitRepo: true });
    const fs = new FakePseudoFs();
    const yaml = `
version: 1
name: strict-test
tasks:
  - id: T1
    isolation: worktree-strict
    prompt: p
    done: d
`;
    const { runner } = createHarness(yaml, { git, pseudoWorktree: { fs, exclude: [] } });
    const result = await runner.start('/repo/.agents/workflows/strict.yaml', '/repo');
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.message.includes('worktree-strict'))).toBe(true);
  });

  it('実行中にワークスペース側が変更されていれば、反映せず警告を残す（design.md「人の編集を上書きしない」）', async () => {
    const git = fakeGit({ notGitRepo: true });
    const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      pseudoWorktree: { fs, exclude: [] },
    });
    const result = await runner.start('/repo/.agents/workflows/pseudo.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
    fs.setFile(path.join(cloneDir, 'a.txt'), { size: 20, mtimeMs: 200 });
    // 人がワークスペース側を実行中に直接編集した、を模す
    fs.setFile('/repo/a.txt', { size: 999, mtimeMs: 999 });

    t1.finish('done', doneState('ok'));
    await flush();

    // タスク自体の統合は成功する（done）。反映だけが中止される
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(fs.files.get('/repo/a.txt')).toEqual({ size: 999, mtimeMs: 999 });
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'pseudoWorktreeReflectBlocked')).toBe(true);
  });

  it('同じパスへ複数タスクが競合すると、3-way mergeができないため衝突としてblockedになる', async () => {
    const git = fakeGit({ notGitRepo: true });
    const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
    const yaml = `
version: 1
name: pseudo-conflict-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
    const { runner, codexHost, store } = createHarness(yaml, {
      git,
      pseudoWorktree: { fs, exclude: [] },
    });
    const result = await runner.start('/repo/.agents/workflows/pseudo-conflict.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
    const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T2');
    fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 20, mtimeMs: 200 });
    fs.setFile(path.join(cloneDir2, 'a.txt'), { size: 30, mtimeMs: 300 });

    t1.finish('done', doneState('ok'));
    await flush();
    t2.finish('done', doneState('ok'));
    await flush();

    // 先に統合したT1はdone、後から同じパスを統合しようとしたT2はblocked
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'pseudoWorktreeConflict')).toBe(true);

    // removeWorktreesはblockedのタスクの複製を残す（Issue #298）。gitと違いブランチが
    // 無く、削除すると衝突として弾かれた未統合の差分を復元する手段が無くなるため
    const outcome = await runner.removeWorktrees(runId);
    expect(outcome.removed).toEqual(['T1']);
    expect(outcome.failed).toEqual([]);
    expect(fs.dirs.has(cloneDir1)).toBe(false);
    expect(fs.dirs.has(cloneDir2)).toBe(true);
    expect(fs.files.get(path.join(cloneDir2, 'a.txt'))).toEqual({ size: 30, mtimeMs: 300 });
  });

  it('cleanupIntegrationは疑似worktreeでも統合先（_integration）を撤去する（runが終わっていれば。Issue #298）', async () => {
    const git = fakeGit({ notGitRepo: true });
    const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      pseudoWorktree: { fs, exclude: [] },
    });
    const result = await runner.start('/repo/.agents/workflows/pseudo-cleanup.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const integrationDir = integrationPath('/repo', runId);
    expect(fs.dirs.has(integrationDir)).toBe(true);

    const cleanup = await runner.cleanupIntegration(runId);
    expect(cleanup.integrationApplicable).toBe(true);
    expect(cleanup.integrationRemoved).toBe(true);
    expect(cleanup.integrationFailedMessage).toBeUndefined();
    expect(cleanup.tasksRemoved).toEqual(['T1']);
    expect(fs.dirs.has(integrationDir)).toBe(false);
  });

  it('cleanupIntegrationはrunが実行中の間、疑似worktreeの統合先を撤去しない（Issue #298）', async () => {
    const git = fakeGit({ notGitRepo: true });
    const fs = new FakePseudoFs();
    const yaml = `
version: 1
name: pseudo-cleanup-running
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;
    const { runner, codexHost } = createHarness(yaml, {
      git,
      pseudoWorktree: { fs, exclude: [] },
    });
    const result = await runner.start(
      '/repo/.agents/workflows/pseudo-cleanup-running.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();
    // T2はT1完了後に走り始めるが、まだ終わっていない（runは`running`のまま）

    const integrationDir = integrationPath('/repo', runId);
    const cleanup = await runner.cleanupIntegration(runId);
    expect(cleanup.integrationApplicable).toBe(true);
    expect(cleanup.integrationRemoved).toBe(false);
    expect(cleanup.integrationFailedMessage).toBe(
      'runが実行中のため統合worktreeは撤去しませんでした',
    );
    expect(fs.dirs.has(integrationDir)).toBe(true);
  });

  it('WorkflowRunnerDeps.pseudoWorktreeが渡されていなければ、従来どおりワークスペース直下を共有する（後方互換）', async () => {
    const git = fakeGit({ notGitRepo: true });
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/pseudo.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.sessions[0] as FakeTaskSession;
    expect(t1.cwd).toBe('/repo');
    t1.finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
  });

  it(
    '疑似worktreeの統合先へのファイルシステム操作が失敗（EACCES等）しても未ハンドルrejectにならず、' +
      'タスクをmergingのまま残さずfailedへ確定させる（Issue #364）',
    async () => {
      const rejectionListener = vi.fn();
      process.on('unhandledRejection', rejectionListener);
      try {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-integrate-fail.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        const t1 = codexHost.byTaskId('T1');
        const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        // 統合先へコピーする対象を1件作っておく。統合（`applyDiffToIntegration`の
        // `fs.mkdir`/`fs.copyFile`）がここでEACCES相当のエラーを投げるようにする
        fs.setFile(path.join(cloneDir, 'b.txt'), { size: 5, mtimeMs: 50 });
        fs.failWith = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

        t1.finish('done', doneState('ok'));
        await flush();

        // `merging`のまま残らず、`failed`として確定する
        expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
      } finally {
        process.off('unhandledRejection', rejectionListener);
      }
      // `void integratePseudoWorktree(...)`（呼び出し元）から見て未ハンドルrejectが
      // 発生していない
      expect(rejectionListener).not.toHaveBeenCalled();
    },
  );

  it(
    'run終了時のワークスペースへの反映（reflectPseudoWorktree）がファイルシステムエラーで失敗しても、' +
      '未ハンドルrejectにならず警告として記録する（Issue #364）',
    async () => {
      const rejectionListener = vi.fn();
      process.on('unhandledRejection', rejectionListener);
      try {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-reflect-fail.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        const t1 = codexHost.byTaskId('T1');
        const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir, 'a.txt'), { size: 20, mtimeMs: 200 });

        // 統合（integratePseudoWorktree）自体は正常に終わらせ、run終了時の反映
        // （reflectPseudoWorktree → reflectIntegrationToWorkspace）だけを失敗させたいため、
        // タスク完了直後（統合の直後・反映の直前）でfailWithを立てる
        const originalCopyFile = fs.copyFile.bind(fs);
        let copyCount = 0;
        fs.copyFile = async (from: string, to: string): Promise<void> => {
          copyCount += 1;
          // 1回目は統合先（_integration）へのコピー（integratePseudoWorktree経由）、
          // 2回目以降がワークスペースへの反映（reflectPseudoWorktree経由）
          if (copyCount >= 2) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
          }
          await originalCopyFile(from, to);
        };

        t1.finish('done', doneState('ok'));
        await flush();

        // 統合（マージ）自体はdoneのまま確定する。失敗したのは反映だけ
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        // ワークスペース側は反映されずに元のまま（反映がエラーで中断したため）
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 10, mtimeMs: 100 });
        const snapshot = runner.getSnapshot(runId);
        expect(snapshot?.warnings.some((w) => w.kind === 'pseudoWorktreeReflectBlocked')).toBe(
          true,
        );
      } finally {
        process.off('unhandledRejection', rejectionListener);
      }
      expect(rejectionListener).not.toHaveBeenCalled();
    },
  );

  it(
    'run終了時の反映が失敗したときの警告はsanitizeForLogを通す' +
      '（live.warningsはワークフローViewにも出るため、Issue #433）',
    async () => {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        pseudoWorktree: { fs, exclude: [] },
      });
      const result = await runner.start(
        '/repo/.agents/workflows/pseudo-reflect-sanitize.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
      fs.setFile(path.join(cloneDir, 'a.txt'), { size: 20, mtimeMs: 200 });

      // 反映（2回目以降のcopyFile）だけを、OSユーザー名を含む絶対パスと双方向制御文字を
      // 持つエラーで失敗させる（Node.jsのfsエラーはこの形でパスを埋め込む）
      const originalCopyFile = fs.copyFile.bind(fs);
      let copyCount = 0;
      fs.copyFile = async (from: string, to: string): Promise<void> => {
        copyCount += 1;
        if (copyCount >= 2) {
          throw new Error("EACCES: permission denied, open '/home/victim/repo/a.txt'\u202E");
        }
        await originalCopyFile(from, to);
      };

      t1.finish('done', doneState('ok'));
      await flush();

      const snapshot = runner.getSnapshot(runId);
      const warning = snapshot?.warnings.find((w) => w.kind === 'pseudoWorktreeReflectBlocked');
      expect(warning).toBeDefined();
      expect(warning?.message).toContain('/home/***/repo/a.txt');
      expect(warning?.message).not.toContain('victim');
      expect(warning?.message).not.toContain('\u202E');
    },
  );

  it(
    '除外設定に一致して反映をスキップしたパスは、成功時でも警告として人に見せる' +
      '（黙って捨てない、Issue #433）',
    async () => {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
      // `exclude`は起動時に固定される一方、マニフェストは`exclude`と無関係に復元されうる
      // （`loadPersistedManifest`。Issue #380）。その設定ドリフトを、同じ配列を実行中に
      // 変えることで再現する（`live.pseudo.exclude`はこの配列と同一参照）
      const exclude: string[] = [];
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        pseudoWorktree: { fs, exclude },
      });
      const result = await runner.start(
        '/repo/.agents/workflows/pseudo-reflect-skip.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      // タスクがワークスペースに無いファイルを追加する（反映時に`added`として扱われる）
      const cloneDir = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
      fs.setFile(path.join(cloneDir, 'node_modules', 'x.js'), { size: 5, mtimeMs: 200 });

      // 統合先へのコピー（＝統合の完了）の直後、反映が始まる前に除外設定を変える
      const originalCopyFile = fs.copyFile.bind(fs);
      fs.copyFile = async (from: string, to: string): Promise<void> => {
        await originalCopyFile(from, to);
        if (to.includes('_integration') && !exclude.includes('node_modules')) {
          exclude.push('node_modules');
        }
      };

      codexHost.byTaskId('T1').finish('done', doneState('ok'));
      await flush();

      // 反映そのものは成功扱い（中断していない）
      expect(fs.files.has(path.join('/repo', 'node_modules', 'x.js'))).toBe(false);
      const snapshot = runner.getSnapshot(runId);
      const warning = snapshot?.warnings.find((w) => w.kind === 'pseudoWorktreeReflectBlocked');
      expect(warning).toBeDefined();
      expect(warning?.message).toContain('node_modules/x.js');
      expect(warning?.message).toContain('除外設定');
    },
  );

  it('persist（実行状態の永続化）がmemento.updateの失敗時に未ハンドルrejectにならず、ログへ記録する（Issue #364）', async () => {
    const rejectionListener = vi.fn();
    process.on('unhandledRejection', rejectionListener);
    const errorLog = vi.fn();
    try {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs();
      const failingMemento: WorkflowRunMemento = {
        get<T>(key: string, defaultValue: T): T {
          return defaultValue;
        },
        update(): Thenable<void> {
          return Promise.reject(new Error('workspaceStateへの書き込みに失敗しました'));
        },
      };
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        pseudoWorktree: { fs, exclude: [] },
        memento: failingMemento,
        log: { ...fakeLogger, error: errorLog },
      });
      const result = await runner.start('/repo/.agents/workflows/persist-fail.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // runは（永続化に失敗しても）そのまま完了として扱われる。永続化の失敗はログへ落ちる
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('done');
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('実行状態の永続化に失敗しました'),
      );
      // Issue #379: ログだけでなく`live.warnings`（Viewの警告欄）へも記録される
      const warning = runner.getSnapshot(runId)?.warnings.find((w) => w.kind === 'persistFailed');
      expect(warning).toBeDefined();
      expect(warning?.taskId).toBeUndefined();
      expect(warning?.message).toContain('実行状態の永続化に失敗しました');
    } finally {
      process.off('unhandledRejection', rejectionListener);
    }
    expect(rejectionListener).not.toHaveBeenCalled();
  });

  it('persistが繰り返し失敗しても、persistFailed警告は直近1件へ丸められ無制限に増えない（Issue #379）', async () => {
    const rejectionListener = vi.fn();
    process.on('unhandledRejection', rejectionListener);
    try {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs();
      let updateCount = 0;
      const failingMemento: WorkflowRunMemento = {
        get<T>(key: string, defaultValue: T): T {
          return defaultValue;
        },
        update(): Thenable<void> {
          updateCount += 1;
          return Promise.reject(
            new Error(`workspaceStateへの書き込みに失敗しました(${updateCount})`),
          );
        },
      };
      const TWO_TASK_YAML = `
version: 1
name: persist-fail-repeat-test
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
      const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
        git,
        pseudoWorktree: { fs, exclude: [] },
        memento: failingMemento,
        log: fakeLogger,
      });
      const result = await runner.start(
        '/repo/.agents/workflows/persist-fail-repeat.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();
      const t2 = codexHost.byTaskId('T2');
      t2.finish('done', doneState('ok'));
      await flush();

      // 複数回失敗しているはず（startとタスク完了のたびにpersistが呼ばれる）
      expect(updateCount).toBeGreaterThan(1);

      const warnings = runner
        .getSnapshot(runId)
        ?.warnings.filter((w) => w.kind === 'persistFailed');
      // 直近1件へ丸められるため、複数回失敗しても件数は増えない
      expect(warnings).toHaveLength(1);
      // 警告が出た事実自体は失われず、最新の失敗内容が残っている
      expect(warnings?.[0]?.message).toContain(`(${updateCount})`);
    } finally {
      process.off('unhandledRejection', rejectionListener);
    }
    expect(rejectionListener).not.toHaveBeenCalled();
  });

  it(
    'マニフェストの永続化はintegrateと同じSerialQueue項目内で行われ、' +
      '後段の書き込み同士の順序も保証される（レビュー指摘: risk、Issue #380の追加指摘）',
    async () => {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
      const yaml = `
version: 1
name: pseudo-persist-order-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
      const { runner, codexHost, store } = createHarness(yaml, {
        git,
        pseudoWorktree: { fs, exclude: [] },
      });
      const result = await runner.start(
        '/repo/.agents/workflows/pseudo-persist-order.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      const t2 = codexHost.byTaskId('T2');
      const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
      const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T2');
      fs.setFile(path.join(cloneDir1, 'x.txt'), { size: 1, mtimeMs: 1 });
      fs.setFile(path.join(cloneDir2, 'y.txt'), { size: 2, mtimeMs: 2 });

      // T1のマニフェスト永続化（manifest.jsonへのwriteTextFile）だけをわざと遅らせる。
      // 永続化がqueue.integrateの外（直列化されない箇所）で行われていれば、後から完了する
      // T2の速い書き込みがT1の遅い書き込みより先に完了し、最終的にT1の（T2を含まない）
      // 内容で上書きされる（Issue #380が防ごうとした事象の再発）
      const manifestPath = path.join('/repo', '.agents', 'worktrees', runId, 'manifest.json');
      const originalWriteTextFile = fs.writeTextFile.bind(fs);
      let delayedOnce = false;
      fs.writeTextFile = async (target: string, content: string): Promise<void> => {
        if (target === manifestPath && !delayedOnce) {
          delayedOnce = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await originalWriteTextFile(target, content);
      };

      t1.finish('done', doneState('ok'));
      t2.finish('done', doneState('ok'));
      // T1側の遅延（実時間）が解消されるまで待つ。flush()はマイクロタスクを消化するだけで
      // 実時間の経過は待たないため、ここだけは実際の待機が要る
      await new Promise((resolve) => setTimeout(resolve, 100));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      expect(store.find(runId)?.tasks['T2']?.state).toBe('done');

      // 直列化により、後（enqueue順で2番目）のT2の永続化はT1の永続化完了後にしか
      // 始まらないため、最終的な内容にはT1・T2両方の記録が残る
      const finalManifest = deserializeManifest(fs.textFiles.get(manifestPath) ?? '');
      expect(finalManifest.get('x.txt')).toEqual({ taskId: 'T1', kind: 'added' });
      expect(finalManifest.get('y.txt')).toEqual({ taskId: 'T2', kind: 'added' });
    },
  );

  describe('疑似worktreeの再試行（Issue #396）', () => {
    const RETRY_SINGLE_TASK_YAML = `
version: 1
name: pseudo-retry-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

    it(
      '手動再実行は前回と別ディレクトリへ複製し、決定的に失敗しない' +
        '（以前は複製先が前回と同じパスになり、cloneWorkspaceのalreadyExistsで' +
        '再試行そのものが即failedになっていた）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(RETRY_SINGLE_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start('/repo/.agents/workflows/pseudo-retry.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const attempt1 = codexHost.byTaskId('T1');
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        expect(attempt1.cwd).toBe(cloneDir1);
        attempt1.finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        // 修正前はこの時点で（新しいセッションが開始される前に）resolveWorkingDirectoryが
        // 同じパスへの複製を試みて例外を投げ、即座に'failed'で確定していた
        expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
        await flush();

        const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T1-retry0');
        const attempt2 = codexHost.sessions.find((s) => s.cwd === cloneDir2);
        expect(attempt2).toBeDefined();
        // 新しい複製先にもワークスペースの内容が複製されている（別ディレクトリとして
        // 成立していることの確認）
        expect(fs.files.get(path.join(cloneDir2, 'a.txt'))).toEqual({ size: 10, mtimeMs: 100 });

        attempt2?.finish('done', doneState('ok'));
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      },
    );

    it('自動再試行（retries: 1）でも、疑似worktreeが前回と別ディレクトリを使って成功する', async () => {
      const git = fakeGit({ notGitRepo: true });
      const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
      const yaml = `
version: 1
name: pseudo-auto-retry-test
tasks:
  - id: T1
    retries: 1
    prompt: p1
    done: d1
`;
      const { runner, codexHost, store } = createHarness(yaml, {
        git,
        pseudoWorktree: { fs, exclude: [] },
      });
      const result = await runner.start('/repo/.agents/workflows/pseudo-auto-retry.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const attempt1 = codexHost.byTaskId('T1');
      attempt1.finish('failed', { ...initialChatState, turnFailed: true });
      await flush();

      // 自動再試行が同じ経路で即死すると、retryCountだけが1に進み'loopFailed'で
      // 確定してしまう（修正前の症状）。修正後は新しいディレクトリで実際にセッションが
      // 開始される
      expect(store.find(runId)?.tasks['T1']?.retryCount).toBe(1);
      const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T1-retry0');
      const attempt2 = codexHost.sessions.find((s) => s.cwd === cloneDir2);
      expect(attempt2).toBeDefined();

      attempt2?.finish('done', doneState('ok'));
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    });

    it(
      'removeWorktreesは疑似worktreeでも再試行したタスクの全試行分（初回+全retry）を撤去する' +
        '（Issue #396、git側のremoveGitTaskWorktreeと対になる撤去）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(RETRY_SINGLE_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-retry-cleanup.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        const dir0 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        const dir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1-retry0');
        const dir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T1-retry1');

        const attempt1 = codexHost.byTaskId('T1');
        attempt1.finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
        await flush();
        const attempt2 = codexHost.sessions.find((s) => s.cwd === dir1);
        attempt2?.finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
        await flush();
        const attempt3 = codexHost.sessions.find((s) => s.cwd === dir2);
        attempt3?.finish('done', doneState('ok'));
        await flush();

        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T1']?.manualRetryCount).toBe(2);

        // 撤去前は全試行分の複製ディレクトリが残っている
        expect(fs.dirs.has(dir0)).toBe(true);
        expect(fs.dirs.has(dir1)).toBe(true);
        expect(fs.dirs.has(dir2)).toBe(true);

        const outcome = await runner.removeWorktrees(runId);
        expect(outcome.removed).toEqual(['T1']);
        expect(outcome.failed).toEqual([]);

        // 全試行分（接尾辞付きも含め）が残らず撤去されている
        expect(fs.dirs.has(dir0)).toBe(false);
        expect(fs.dirs.has(dir1)).toBe(false);
        expect(fs.dirs.has(dir2)).toBe(false);
      },
    );
  });

  describe('リロード復元後のマニフェスト（Issue #380）', () => {
    // T1は疑似worktree（統合が要る）、T2は明示cwd（統合を経由しない）にして、リロード後の
    // 再実行（retryTask）が疑似worktreeの複製先の衝突（T2の再クローンが以前の複製と
    // ぶつかる。Issue #380の範囲外の別の制約）を踏まないようにする
    const TWO_TASK_YAML = `
version: 1
name: pseudo-reload-test
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    cwd: /repo/T2
    prompt: p2
    done: d2
`;

    it(
      'リロード復元後も、復元前に統合済みだった成果がワークスペースへ届く' +
        '（受入基準: マニフェストが永続化され復元される）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start('/repo/.agents/workflows/pseudo-reload.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        // T1だけ先に完了・統合させる（統合先へのマニフェストがこの時点で永続化される）。
        // T2はまだ`running`のまま（リロード＝プロセス再起動を、走行中のタスクがある
        // 途中で迎えた状況を再現する）
        const t1 = codexHost.byTaskId('T1');
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 20, mtimeMs: 200 });
        t1.finish('done', doneState('ok'));
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        // まだリロード前なので、runは終わっておらずワークスペースへの反映はまだ起きない
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 10, mtimeMs: 100 });

        // 新しいプロセス（リロード後）を模す。同じstore・同じ疑似worktreeのfs
        // （＝同じディスク）を使い回すが、ライブな状態（`IntegrationQueue`のインスタンス・
        // メモリ上のマニフェスト）は失われる
        const newCodexHost = new FakeHost();
        const reloadedRunner = new WorkflowRunner({
          // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
          // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
          // （design.md §16.35、roadmap W10、Issue #584）
          readAutoResume: () => false,
          hosts: { codex: newCodexHost, claude: newCodexHost },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit({ notGitRepo: true }),
          fs: identityFs,
          filePort: filePort(TWO_TASK_YAML),
          store,
          pseudoWorktree: { fs, exclude: [] },
          log: fakeLogger,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        // リロードで中断扱いになったT2を再実行し、runを最後まで進める
        expect(reloadedRunner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        const t2 = newCodexHost.byTaskId('T2');
        t2.finish('done', doneState('ok'));
        await flush();

        // T1（リロード前に統合済み）の成果がワークスペースへ届く。マニフェストが
        // 復元されていなければ（空マニフェストのままなら）a.txtは反映されない
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 20, mtimeMs: 200 });
        const snapshot = reloadedRunner.getSnapshot(runId);
        expect(snapshot?.warnings.some((w) => w.kind === 'pseudoWorktreeReflectBlocked')).toBe(
          false,
        );
      },
    );

    it(
      '永続化されたマニフェストが壊れていて復元できない場合、' +
        '黙って0件成功にせず反映を止めて警告を出す（受入基準）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-reload-corrupt.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        const t1 = codexHost.byTaskId('T1');
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 20, mtimeMs: 200 });
        t1.finish('done', doneState('ok'));
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');

        // 永続化されたマニフェストのファイルが壊れている状況を再現する（ディスク破損等）
        const manifestPath = path.join('/repo', '.agents', 'worktrees', runId, 'manifest.json');
        fs.textFiles.set(manifestPath, 'not valid json{{{');

        const newCodexHost = new FakeHost();
        const reloadedRunner = new WorkflowRunner({
          // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
          // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
          // （design.md §16.35、roadmap W10、Issue #584）
          readAutoResume: () => false,
          hosts: { codex: newCodexHost, claude: newCodexHost },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit({ notGitRepo: true }),
          fs: identityFs,
          filePort: filePort(TWO_TASK_YAML),
          store,
          pseudoWorktree: { fs, exclude: [] },
          log: fakeLogger,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        expect(reloadedRunner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        const t2 = newCodexHost.byTaskId('T2');
        t2.finish('done', doneState('ok'));
        await flush();

        // 反映が止まり、ワークスペース側はリロード前のまま（0件成功に見えていない）
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 10, mtimeMs: 100 });
        const snapshot = reloadedRunner.getSnapshot(runId);
        const warning = snapshot?.warnings.find((w) => w.kind === 'pseudoWorktreeReflectBlocked');
        expect(warning).toBeDefined();
        expect(warning?.message).toContain('復元できなかった');
      },
    );

    /**
     * Issue #438の回帰テスト。統合worktree撤去（`cleanupIntegration`）が`_integration`しか
     * 消さず`manifest.json`を残すと、撤去後のリロードで`resolvePseudoState`が実体の無い
     * `_integration`を指す古いマニフェストを読み戻し、そのrunを再実行した際の
     * `reflectPseudoWorktree`が`kind:'deleted'`のエントリを使ってワークスペース側の
     * ファイルを再び削除してしまう（撤去後にユーザーが復元したファイルまで消える）。
     *
     * `removePseudoIntegration`（`_integration`と`manifest.json`をまとめて撤去）に
     * 直したことで、撤去後の再実行では空のマニフェストしか読み戻らず、この経路が
     * 塞がれていることを確かめる。
     */
    it(
      '統合worktree撤去後にリロードして再実行しても、幽霊マニフェストでワークスペースの' +
        'ファイルが再削除されない（受入基準、Issue #438）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start('/repo/.agents/workflows/pseudo-ghost.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        // T1: 複製先のa.txtを削除した状態で完了させる（統合先への差分がkind:'deleted'になる）
        const t1 = codexHost.byTaskId('T1');
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.files.delete(path.join(cloneDir1, 'a.txt'));
        t1.finish('done', doneState('ok'));
        await flush();

        // T2は明示cwdで失敗させ、runを終わらせる（reflectPseudoWorktreeが1回走る。
        // 疑似worktreeの反映はrunの結果を問わず行われる）
        const t2 = codexHost.byTaskId('T2');
        t2.finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        // 1回目の反映（正当な削除）。ここでa.txtが消えるのは、T1が実際に消した結果を
        // 反映しているだけで、Issue #438が問題にしている経路ではない
        expect(fs.files.has('/repo/a.txt')).toBe(false);

        // ユーザーが統合worktreeを撤去する
        const cleanup = await runner.cleanupIntegration(runId);
        expect(cleanup.integrationRemoved).toBe(true);

        // 撤去後、ユーザーが手動でa.txtを復元した（例: 別の作業・バックアップからの復旧）
        fs.setFile('/repo/a.txt', { size: 10, mtimeMs: 100 });

        // リロード（新しいプロセスを模す。同じstore・同じディスクを使い回す）
        const newCodexHost = new FakeHost();
        const reloadedRunner = new WorkflowRunner({
          // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
          // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
          // （design.md §16.35、roadmap W10、Issue #584）
          readAutoResume: () => false,
          hosts: { codex: newCodexHost, claude: newCodexHost },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit({ notGitRepo: true }),
          fs: identityFs,
          filePort: filePort(TWO_TASK_YAML),
          store,
          pseudoWorktree: { fs, exclude: [] },
          log: fakeLogger,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        // そのrunで再実行する（失敗していたT2をretry）
        expect(reloadedRunner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        const t2b = newCodexHost.byTaskId('T2');
        t2b.finish('done', doneState('ok'));
        await flush();

        // 幽霊マニフェスト（撤去し忘れたmanifest.json）が読み戻されていれば、ここで
        // 復元したa.txtが再び削除される。修正後は消えていないことを確認する
        expect(fs.files.has('/repo/a.txt')).toBe(true);
      },
    );
  });
});

describe('WorkflowRunner: タスク間メッセージング（design.md §16.21、Issue #105）', () => {
  const TWO_TASK_YAML = `
version: 1
name: messaging-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  it('runごとにMCPサーバを起動し、タスクの開始時に接続用URLを発行してTaskSessionInputへ渡す', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
    await flush();

    // オーケストレーター（design.md §16.23）にも専用の接続を1本発行する
    expect(state.handle?.registeredTasks.sort()).toEqual(['-orchestrator-', 'T1', 'T2']);
    const t1Input = codexHost.openInputs.find((i) => i.cwd.endsWith('/T1'));
    const t2Input = codexHost.openInputs.find((i) => i.cwd.endsWith('/T2'));
    expect(t1Input?.mcp?.url).toContain('/mcp/');
    expect(t2Input?.mcp?.url).toContain('/mcp/');
    expect(t1Input?.mcp?.url).not.toBe(t2Input?.mcp?.url);
  });

  it(
    'MCPサーバの起動時に、this.deps.logを包んだlogPortがstartTransportへ渡される' +
      '（Issue #375。以前はこの配線自体が無く、dispatch例外が記録されなかった）',
    async () => {
      const errorLog = vi.fn();
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, {
        messaging: deps,
        log: { ...fakeLogger, error: errorLog },
      });
      await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      await flush();

      expect(state.logPort).toBeDefined();
      state.logPort?.error('dispatch経由のテストメッセージ');
      expect(errorLog).toHaveBeenCalledWith('dispatch経由のテストメッセージ');
    },
  );

  it(
    'send_messageで受け付けたメッセージは、宛先タスクの次の送信の先頭へ添えられる' +
      '（Issue #547: 宛先はオーケストレーターに固定されるため、実タスクへの配送は' +
      'オーケストレーターからの送信で再現する）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(TWO_TASK_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      await flush();

      const t2 = codexHost.byTaskId('T2');
      const result = state.hub?.sendMessage({
        from: ORCHESTRATOR_CONNECTION_ID,
        to: 'T2',
        body: 'hi T2',
        expectReply: false,
      });
      expect(result?.accepted).toBe(true);

      const composed = t2.promptTransform?.('続けてください') ?? '';
      expect(composed).toContain(ORCHESTRATOR_CONNECTION_ID);
      expect(composed).toContain('hi T2');
      expect(composed).toContain('続けてください');
      // 一度取り出したメッセージは再度は添えられない（配送済みとして消費される）
      const secondSend = t2.promptTransform?.('もう一度') ?? '';
      expect(secondSend).toBe('もう一度');
    },
  );

  it('MCPサーバの起動に失敗しても、通信なしでワークフローが最後まで走る（design.md「runは止めない」）', async () => {
    const { deps } = fakeMessagingDeps({ failStart: true });
    const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    expect(t1.cwd).toBeDefined();
    t1.finish('done', doneState('ok'));
    t2.finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
  });

  it('WorkflowRunnerDeps.messagingが渡されていなければ、mcpは付かず通常どおり走る（後方互換）', async () => {
    const { runner, codexHost, store } = createHarness(TWO_TASK_YAML);
    const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(codexHost.openInputs.every((i) => i.mcp === undefined)).toBe(true);
    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    t1.finish('done', doneState('ok'));
    t2.finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
  });

  it('runの終了時にMCPサーバを閉じる', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
    await flush();

    expect(state.handle?.closed).toBe(false);
    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    t1.finish('done', doneState('ok'));
    t2.finish('done', doneState('ok'));
    await flush();

    expect(state.handle?.closed).toBe(true);
  });

  it('list_tasksは同じrunのタスクid・状態・直近の応答の1行要約を返す', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
    await flush();
    void codexHost;

    const listed = state.hub?.listTasks() ?? [];
    expect(listed.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
    expect(listed.every((t) => t.state === 'running')).toBe(true);
  });

  it(
    'expectReply: trueで送ると送信元がwaitingReplyへ遷移し、ループを実際に一時停止する' +
      '（design.md §16.21「自分のターンを終えたあと...次の指示を受け取らない」）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      const before = state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '状況はどうですか',
        expectReply: true,
      });
      await flush();

      expect(before?.accepted).toBe(true);
      expect(t1.pauseLoopCount).toBe(1);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');
    },
  );

  it(
    'waitingReply中のタスクへメッセージが届くとrunningへ戻り、実際にループを再開する' +
      '（design.md §16.21「返信が届いたらrunningへ戻し...次の指示を送る」）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '状況は?',
        expectReply: true,
      });
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

      // 返信はオーケストレーターから届く（Issue #547: T2からT1への直接送信は無くなった）
      state.hub?.sendMessage({
        from: ORCHESTRATOR_CONNECTION_ID,
        to: 'T1',
        body: '順調です',
        expectReply: false,
      });
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      expect(t1.resumeLoopCount).toBe(1);
      // 返信の本文は次の送信（setPromptTransform経由のcomposeNextPrompt）へ添えられる
      const composed = t1.promptTransform?.('続けてください') ?? '';
      expect(composed).toContain('順調です');
    },
  );

  it(
    'waitingReply中にターン失敗を観測するとfailedへ確定し、セッションも解放される' +
      '（Issue #362。isUnsettledにwaitingReplyを含めないと、applyLoopStopReasonが' +
      'markFailedへ到達せずタスクがwaitingReplyのまま残り、maxParallelの枠を占有し続ける）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '状況は?',
        expectReply: true,
      });
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

      // waitingReply中に、返信を待たずにターン自体が失敗した経路。ここではフェイクの
      // セッションから`reason='failed'`を直接流し、runner側の配線
      // （applyLoopStopReason→markFailed）を検証する。この`failed`を生む
      // loopControllerの`observe()`側（`turnFailed`を見て`stop('failed')`を呼ぶ）は
      // test/unit/loopController.test.ts が別途カバーしている
      t1.finish('failed', { ...initialChatState, turnFailed: true });
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
      expect(t1.disposed).toBe(true);
    },
  );

  it(
    'MCPツールがタスクから見えなければ警告を出すが、runは止めずに最後まで走る' +
      '（design.md §16.21「ツールの可視性の確認」・受入基準）',
    async () => {
      const { deps } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      codexHost.defaultMessagingToolVisible = false;
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const snapshot = runner.getSnapshot(runId);
      expect(
        snapshot?.warnings.some((w) => w.kind === 'messagingUnavailable' && w.taskId === 'T1'),
      ).toBe(true);
      expect(
        snapshot?.warnings.some((w) => w.kind === 'messagingUnavailable' && w.taskId === 'T2'),
      ).toBe(true);

      const t1 = codexHost.byTaskId('T1');
      const t2 = codexHost.byTaskId('T2');
      t1.finish('done', doneState('ok'));
      t2.finish('done', doneState('ok'));
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
      expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    },
  );

  describe('run再開時のメッセージング再構築（Issue #475）', () => {
    /**
     * `TWO_TASK_YAML`はT1・T2が依存無しで独立に走る（`maxParallel: 2`）。両方を
     * `failed`にしてから`retryTask`を呼ぶとき、**片方だけを再実行しても実際には
     * 走り出さない**点に注意（`scheduler.ts`の`isRunHalted`は`haltedByUser`に加えて
     * 「1件でも`failed`が残っていれば」runを止めたままにする。`retryTask`は対象の1件だけを
     * `pending`へ戻すため、もう一方がまだ`failed`のままだと`nextTasksToStart`は何も返さない）。
     * そのため以下のテストは両方を`retryTask`してから初めてpump()が両方を同時に開始する。
     * これは実際の障害経路（再マージ成功で複数の`pending`が一斉に`pump()`される）と同じ形の
     * 「複数タスクが同一tickで同時に起動する」状況を、素の`retryTask`だけで自然に再現できる。
     */
    async function failBothTasks(codexHost: FakeHost): Promise<void> {
      codexHost.byTaskId('T1').finish('failed', { ...initialChatState, turnFailed: true });
      codexHost.byTaskId('T2').finish('failed', { ...initialChatState, turnFailed: true });
      await flush();
    }

    it(
      'run終了後にretryTaskで再開すると、hubを再利用してtransportを立て直し、' +
        'タスク間のメッセージ送受信が実際に機能する',
      async () => {
        const { deps, state } = fakeMessagingDeps();
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
        const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const hub1 = state.hub;
        const handle1 = state.handle;
        expect(state.startCallCount).toBe(1);

        // 両タスクとも失敗させ、runを終了させる（run終了時にMCPサーバは閉じる）
        await failBothTasks(codexHost);
        expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('failed');
        expect(handle1?.closed).toBe(true);

        // 「再実行」（retryTask）で両方を再開する。修正前は`live.messaging`が`undefined`の
        // ままで、`TaskSessionInput`にmcpキー自体が乗らなかった（Issue #475の受入基準）。
        // T1を先に呼んだ時点ではT2がまだ`failed`のため実際には走り出さず、T2を呼んだ瞬間に
        // pump()が両方を同時に開始する（このdescribeの冒頭コメント参照）
        expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
        expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();

        // hubは作り直さず再利用する（MAX_MESSAGES_PER_RUNのカウンタを引き継ぐため）。
        // T1・T2が同一tickで同時に起動しても、`startTransport`が呼ばれるのは1回だけ
        // （`messagingSetupInFlight`による同時起動ガード）
        expect(state.startCallCount).toBe(2);
        expect(state.hub).toBe(hub1);
        expect(state.handle).not.toBe(handle1);
        expect(state.handle?.closed).toBe(false);

        const t1Inputs = codexHost.openInputs.filter((i) => cwdEndsWithTask(i.cwd, 'T1'));
        const t2Inputs = codexHost.openInputs.filter((i) => cwdEndsWithTask(i.cwd, 'T2'));
        const rebuiltT1Input = t1Inputs[t1Inputs.length - 1];
        const rebuiltT2Input = t2Inputs[t2Inputs.length - 1];
        expect(rebuiltT1Input?.mcp?.url).toContain('/mcp/');
        expect(rebuiltT2Input?.mcp?.url).toContain('/mcp/');

        // 実際にメッセージがやり取りできることを確かめる（Issue #547: 宛先はオーケストレーター
        // に固定されるため、実タスクへの配送はオーケストレーターからの送信で再現する）
        const t2 = codexHost.byTaskId('T2');
        const sendResult = state.hub?.sendMessage({
          from: ORCHESTRATOR_CONNECTION_ID,
          to: 'T2',
          body: '再開後のテストメッセージ',
          expectReply: false,
        });
        expect(sendResult?.accepted).toBe(true);
        const composed = t2.promptTransform?.('続けてください') ?? '';
        expect(composed).toContain('再開後のテストメッセージ');
      },
    );

    it('run全体で500件のメッセージ数カウンタは、再開をまたいでも作り直されずリセットされない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // 送受信できる状態で何件か送っておき、カウンタを進める（宛先はオーケストレーター固定。
      // Issue #547）
      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: 'a',
        expectReply: false,
      });
      state.hub?.sendMessage({
        from: 'T2',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: 'b',
        expectReply: false,
      });
      const totalBeforeClose = state.hub?.snapshotStore().totalSent;
      expect(totalBeforeClose).toBe(2);

      await failBothTasks(codexHost);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');

      expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
      expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
      await flush();

      // 再構築自体が起きていることを先に確かめる。ここを確認しないと、
      // 「再開そのものがメッセージングを立て直さない」壊れ方（Issue #475の実害そのもの）
      // でも`totalSent`が変わらないため見かけ上パスしてしまう
      // （レビュー指摘: テストが弱い。修正前コードではここが1のままで落ちる）
      expect(state.startCallCount).toBe(2);
      // hubを作り直していれば`totalSent`は0へ戻ってしまう。再利用していれば引き継がれる
      expect(state.hub?.snapshotStore().totalSent).toBe(totalBeforeClose);
    });

    it('ensureMessagingは冪等で、既に生きているメッセージングを二重に立てない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      await flush();

      // T1・T2・オーケストレーターの3セッションが同じrunで開くが、
      // `startTransport`（MCPサーバの起動）自体は1回しか呼ばれない
      expect(state.startCallCount).toBe(1);
    });

    it(
      '再マージ成功で複数のpendingタスクが一斉に再開しても、' +
        'MCPサーバとタイマーを二重に立てない（messagingSetupInFlightによる同時起動ガード。' +
        'startTransportの解決を人為的に遅らせ、同時起動の窓を決定的に作って検証する）',
      async () => {
        const { deps, state } = fakeMessagingDeps({ blockStart: true });
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
        const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
        const runId = result.runId as string;
        await flush();
        expect(state.startCallCount).toBe(1);

        await failBothTasks(codexHost);
        expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('failed');

        // T1とT2を同時に再開する（このdescribeの冒頭コメントのとおり、T2を呼んだ瞬間に
        // pump()が両方を同一tickで開始する）
        expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
        expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();

        // `startTransport`は呼ばれたが、`blockStart`により保留中で1件だけ解放できる状態の
        // はず（同時に起動した2件のうち、実際に呼んだのは1回だけ。もう一方は
        // `messagingSetupInFlight`を待っただけで`startTransport`自体を呼んでいない）
        expect(state.startCallCount).toBe(2);
        state.releaseStart();
        await flush();

        expect(state.handle?.closed).toBe(false);
        const t1Inputs = codexHost.openInputs.filter((i) => cwdEndsWithTask(i.cwd, 'T1'));
        const t2Inputs = codexHost.openInputs.filter((i) => cwdEndsWithTask(i.cwd, 'T2'));
        expect(t1Inputs[t1Inputs.length - 1]?.mcp?.url).toContain('/mcp/');
        expect(t2Inputs[t2Inputs.length - 1]?.mcp?.url).toContain('/mcp/');
      },
    );

    it(
      'ウィンドウのリロード後に復元した実行をretryTaskで再開すると、' +
        '新しいセッションへ有効なメッセージングURLが渡る（design.md §16.11 + Issue #475）',
      async () => {
        const SINGLE_TASK_YAML = `
version: 1
name: reload-messaging-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;
        const { deps: deps1 } = fakeMessagingDeps();
        const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, { messaging: deps1 });
        const result = await runner.start('/repo/.agents/workflows/reload-messaging.yaml', '/repo');
        const runId = result.runId as string;
        await flush();
        codexHost.byTaskId('T1');

        // 新しいプロセス（リロード後）を模す。同じstoreを使い回すが、ライブな状態は空
        const { deps: deps2, state: state2 } = fakeMessagingDeps();
        const newCodexHost = new FakeHost();
        const reloadedRunner = new WorkflowRunner({
          // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
          // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
          // （design.md §16.35、roadmap W10、Issue #584）
          readAutoResume: () => false,
          hosts: { codex: newCodexHost, claude: newCodexHost },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit(),
          fs: identityFs,
          filePort: filePort(SINGLE_TASK_YAML),
          store,
          log: fakeLogger,
          messaging: deps2,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        // 復元直後は中断扱い（failed）。このプロセスではまだメッセージングのhubを
        // 一度も作っていない（`rebuildLiveRun`は`messagingHub: undefined`のまま復元する）
        const snapshot = reloadedRunner.getSnapshot(runId);
        expect(snapshot?.tasks.find((t) => t.id === 'T1')?.failure).toEqual({
          kind: 'reloadInterrupted',
        });

        expect(reloadedRunner.retryTask(runId, 'T1')).toEqual({ ok: true });
        await flush();

        expect(state2.startCallCount).toBe(1);
        const rebuiltInput = newCodexHost.openInputs.find((i) => cwdEndsWithTask(i.cwd, 'T1'));
        expect(rebuiltInput?.mcp?.url).toContain('/mcp/');
        expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      },
    );
  });

  describe('待ちぼうけの検出（design.md §16.21「待ちぼうけを検出する経路」）', () => {
    // 経路1（全員waitingReplyかつ未配送0件）はここでは再現しない: `onMessageAccepted`は
    // 「宛先がwaitingReplyなら配送を機にrunningへ戻す」という設計どおりの配送ベース再開を
    // 持つため、2〜3タスクの単純な相互待ちは経路1へ到達する前に配送そのもので解けてしまう
    // （これは意図した挙動。design.md「返信が届いたらrunningへ戻し...」）。経路1の判定
    // 関数（`detectAllWaitingStalemate`）自体はmessaging.test.tsで境界値まで確認済みで、
    // `checkWaitingReplyStalls`が実際に解除・警告・resumeLoopまで行う配線は下の経路2
    // （同じ`releaseStalledWaitingReplies`を通る）で確認できる。
    afterEach(() => {
      vi.useRealTimers();
    });

    it('replyTimeoutSecを超えたwaitingReplyは、相手が起きていなくても再開する', async () => {
      vi.useFakeTimers();
      const { deps, state } = fakeMessagingDeps();
      const readReplyTimeoutSec = () => 10;
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, {
        messaging: { ...deps, readReplyTimeoutSec },
      });
      const result = await runner.start('/repo/.agents/workflows/messaging.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      // T2は無反応のまま。T1だけがexpectReply:trueで待つ（経路1は未配送0件では成立しない
      // ケース: T2は`running`のまま止まらないため、経路2（時間切れ）だけが解く。宛先は
      // オーケストレーター固定。Issue #547）
      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: 'a',
        expectReply: true,
      });
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

      await vi.advanceTimersByTimeAsync(10_000 + WAITING_REPLY_POLL_INTERVAL_MS);
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      expect(t1.resumeLoopCount).toBe(1);
      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.warnings.some((w) => w.kind === 'messagingStalled')).toBe(true);
    });
  });

  describe(
    '中継の不変条件・実際の送信文面の表示' +
      '（design.md §16.21・§16.34、Issue #132・Issue #547・Issue #562）',
    () => {
      // T1はsandbox: read-only、T2はsandbox: workspace-write。dependsOnで結ばない
      // （メッセージは依存関係を問わず送れることを再現するため）
      const SANDBOX_DIFF_YAML = `
version: 1
name: messaging-escalation-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    sandbox: read-only
    prompt: p1
    done: d1
  - id: T2
    sandbox: workspace-write
    prompt: p2
    done: d2
`;

      it(
        '実タスクへ配送されるメッセージの`from`は常にオーケストレーターになる' +
          '（W9（Issue #547）の中継の不変条件。タスク同士は直接送り合えず、実タスクが' +
          '受け取るのは必ずオーケストレーターが中継した1本になる。この不変条件が成り立つ' +
          '限り、配送されたメッセージから元の送信元タスクを引くことはできない——' +
          '`messagingPermissionEscalation`（Issue #132）が構造上不発火になり、' +
          'Issue #562で削除したのはこれが理由である。復活させるなら、まずこの不変条件を' +
          '変える（`StoredMessage`とは別に由来を追跡する）必要がある。' +
          'design.md §16.34「影響範囲」参照）',
        async () => {
          const { deps, state } = fakeMessagingDeps();
          const { runner, codexHost } = createHarness(SANDBOX_DIFF_YAML, {
            messaging: deps,
            codexSandbox: 'workspace-write',
          });
          const result = await runner.start(
            '/repo/.agents/workflows/messaging-escalation.yaml',
            '/repo',
          );
          const runId = result.runId as string;
          await flush();

          // タスクからタスクへは直接送れない（中継が唯一の経路）
          const direct = state.hub?.sendMessage({
            from: 'T1',
            to: 'T2',
            body: '直接送ります',
            expectReply: false,
          });
          expect(direct?.accepted).toBe(false);

          // T1（read-only）の情報をオーケストレーターがT2（workspace-write）へ中継する形
          state.hub?.sendMessage({
            from: 'T1',
            to: ORCHESTRATOR_CONNECTION_ID,
            body: '調査結果です',
            expectReply: false,
          });
          const relayed = state.hub?.sendMessage({
            from: ORCHESTRATOR_CONNECTION_ID,
            to: 'T2',
            body: '調査結果です',
            expectReply: false,
          });
          expect(relayed?.accepted).toBe(true);

          const delivered = state.hub?.takeDeliverableMessages('T2') ?? [];
          expect(delivered.length).toBe(1);
          expect(delivered.every((m) => m.from === ORCHESTRATOR_CONNECTION_ID)).toBe(true);

          // 中継後も`{{T1.result}}`経由の警告（permissionEscalation、Issue #67）とは
          // 別経路のままで、ここでは出ない（この2つを混同しないための対照）
          const t2 = codexHost.byTaskId('T2');
          t2.promptTransform?.('続けてください');
          const snapshot = runner.getSnapshot(runId);
          expect(snapshot?.warnings.some((w) => w.kind === 'permissionEscalation')).toBe(false);
        },
      );

      it('lastSentPromptは実際にCLIへ送った本文（メッセージの合成後）と一致する', async () => {
        const { deps, state } = fakeMessagingDeps();
        const { runner, codexHost } = createHarness(SANDBOX_DIFF_YAML, { messaging: deps });
        const result = await runner.start(
          '/repo/.agents/workflows/messaging-last-sent.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        // メッセージが無い最初の送信では、実際に送った本文と展開後プロンプトが一致する
        const t2 = codexHost.byTaskId('T2');
        const firstSent = t2.promptTransform?.('p2') ?? '';
        let snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
        expect(snapshot?.lastSentPrompt).toBe(firstSent);
        expect(snapshot?.lastSentPrompt).toBe(snapshot?.expandedPrompt);

        // メッセージが配送されると、expandedPromptは変わらないがlastSentPromptには
        // メッセージの内容が現れる（design.md §16.21、Issue #132「4. 人が目視確認できる
        // ようにする」。expandedPromptはcomposeNextPromptを経由しないため確認できなかった）。
        // 宛先はオーケストレーター固定（Issue #547）なので、実タスクへの配送は
        // オーケストレーターからの送信で再現する
        state.hub?.sendMessage({
          from: ORCHESTRATOR_CONNECTION_ID,
          to: 'T2',
          body: '追加の指示です',
          expectReply: false,
        });
        const secondSent = t2.promptTransform?.('続けてください') ?? '';
        snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
        expect(snapshot?.lastSentPrompt).toBe(secondSent);
        expect(snapshot?.lastSentPrompt).toContain('追加の指示です');
        expect(snapshot?.lastSentPrompt).toContain(
          `<task-message from="${ORCHESTRATOR_CONNECTION_ID}">`,
        );
      });

      it(
        'lastSentPromptは双方向制御文字を落とすが改行は保持する' +
          '（表示専用の無害化、監査指摘#5と同じ扱い）',
        async () => {
          const rtlOverride = String.fromCodePoint(0x202e);
          const { deps, state } = fakeMessagingDeps();
          const { runner, codexHost } = createHarness(SANDBOX_DIFF_YAML, { messaging: deps });
          const result = await runner.start('/repo/.agents/workflows/messaging-rtl.yaml', '/repo');
          const runId = result.runId as string;
          await flush();

          const t2 = codexHost.byTaskId('T2');
          state.hub?.sendMessage({
            from: ORCHESTRATOR_CONNECTION_ID,
            to: 'T2',
            body: `1行目\n安全${rtlOverride}exe.悪意のある名前`,
            expectReply: false,
          });
          t2.promptTransform?.('続けてください');

          const snapshot = runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2');
          expect(snapshot?.lastSentPrompt).not.toContain(rtlOverride);
          expect(snapshot?.lastSentPrompt?.includes('\n')).toBe(true);
        },
      );
    },
  );
});

/**
 * design.md §16.34、Issue #547: タスク間の直接メッセージングを廃し、オーケストレーターの
 * 中継にする。上の「タスク間メッセージング（design.md §16.21）」describeが積んできた
 * 大半のケース（配送・waitingReply遷移・待ちぼうけ検出そのもの等）は変えていないので、
 * ここでは変更点（宛先の固定・タスク→オーケストレーターの配送経路・その配送が
 * `detectAllWaitingStalemate`を壊さないこと）だけを、実際の`hub.sendMessage`を通す
 * 経路で確認する。
 */
describe('WorkflowRunner: 直接メッセージングを廃しオーケストレーター中継にする（design.md §16.34、Issue #547）', () => {
  const TWO_TASK_YAML = `
version: 1
name: relay-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  it('タスクからタスクidを直接指定した送信は拒否され、理由にオーケストレーター宛の案内が入る', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
    await flush();

    const result = state.hub?.sendMessage({
      from: 'T1',
      to: 'T2',
      body: 'hi T2',
      expectReply: false,
    });
    expect(result?.accepted).toBe(false);
    expect(result?.reason).toContain(ORCHESTRATOR_CONNECTION_ID);
  });

  it('タスクからオーケストレーター宛の送信は受け付けられ、通知が届く', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
    // run開始の通知でターンが走っている。まず終わらせて次の通知がflushされる状態にする
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });

    const result = state.hub?.sendMessage({
      from: 'T1',
      to: ORCHESTRATOR_CONNECTION_ID,
      body: '状況を共有します',
      expectReply: false,
    });
    expect(result?.accepted).toBe(true);
    await flush();

    // notifyOrchestratorはbusyの間pendingに積むだけなので、ここでも1回ターンを終わらせる
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });
    const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
    expect(last).toContain('T1');
    expect(last).toContain('状況を共有します');
  });

  it(
    'オーケストレーター宛の配送は、hub内部の未配送キューも同時に消費する' +
      '（Issue #547でもっとも壊れやすい箇所。ここを消費し忘れると、以後' +
      '`totalUndeliveredCount()`が0へ戻らず、待ちぼうけ検出の経路1' +
      '「全員waitingReplyかつ未配送0件」が二度と成立しなくなる。design.md §16.25の' +
      '「状態を実際に進めてから観測する」に沿い、pull用のキューが実際に空になった' +
      'ことをhub側から直接観測する）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
      await flush();

      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '状況を共有します',
        expectReply: false,
      });
      await flush();

      expect(state.hub?.totalUndeliveredCount()).toBe(0);
    },
  );

  it(
    'expectReply:trueでオーケストレーターへ送るとwaitingReplyへ遷移し、' +
      'オーケストレーターからの送り返しで実際にループが再開する' +
      '（中継を挟んでもwaitingReplyの仕組みは変わらない）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      const sendResult = state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '状況はどうですか',
        expectReply: true,
      });
      await flush();

      expect(sendResult?.accepted).toBe(true);
      expect(t1.pauseLoopCount).toBe(1);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

      // オーケストレーター自身の`send_message`（from: ORCHESTRATOR_CONNECTION_ID）は
      // これまでどおり実タスクidを直接宛先にできる
      const reply = state.hub?.sendMessage({
        from: ORCHESTRATOR_CONNECTION_ID,
        to: 'T1',
        body: '順調です、続けてください',
        expectReply: false,
      });
      await flush();

      expect(reply?.accepted).toBe(true);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      expect(t1.resumeLoopCount).toBe(1);
      const composed = t1.promptTransform?.('続けてください') ?? '';
      expect(composed).toContain('順調です、続けてください');
    },
  );

  it('オーケストレーターが自分自身へ送ろうとすると拒否される（自己送信の禁止は変わらない）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
    await flush();

    const result = state.hub?.sendMessage({
      from: ORCHESTRATOR_CONNECTION_ID,
      to: ORCHESTRATOR_CONNECTION_ID,
      body: 'x',
      expectReply: false,
    });
    expect(result?.accepted).toBe(false);
  });

  it('オーケストレーターから同じrunに存在しない宛先への送信は拒否される（従来どおり）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/relay.yaml', '/repo');
    await flush();

    const result = state.hub?.sendMessage({
      from: ORCHESTRATOR_CONNECTION_ID,
      to: 'T9',
      body: 'x',
      expectReply: false,
    });
    expect(result?.accepted).toBe(false);
  });
});

/**
 * Issue #432-2: run終了時の後始末（`pump()`の終了ブロック）はrunにつき1度だけ行う。
 *
 * `live.finished`は`retryMerge`/`retryTask`/`continueTask`が再開の起点として
 * `false`へ戻す（design.md §16.5参照）。この3経路のいずれで再開しても、run全体が
 * 再び終了状態へ確定した時点で`notifyOrchestratorRunFinished`を重ねて送ってはいけない。
 */
/**
 * design.md §16.32、Issue #571: タスク側ツール`ask_orchestrator`。
 *
 * 配送・waitingReplyへの遷移・待ちぼうけ検出は`send_message`（design.md §16.21・§16.34）と
 * 完全に共有する経路で、ここでは`ask_orchestrator`固有の差分だけを確認する:
 * `StoredMessage.kind: 'question'`がオーケストレーターへの通知種別を`taskQuestion`へ
 * 変えること、`blocking: true`（`expectReply: true`）でも既存のwaitingReply・待ちぼうけ
 * 検出（`detectAllWaitingStalemate`・タイムアウト）がそのまま機能すること、答えが来ないまま
 * 解放されたタスクがその後`maxIterations`を使い切ると通常どおり`failed`で確定すること
 * （返事待ちで枠を占有し続けない）。ツール呼び出し自体（`ask_orchestrator`→
 * `hub.sendMessage({kind: 'question'})`への変換）は`test/unit/messaging.test.ts`の
 * `MessagingMcpServer`レベルのテストが確認済みなので、ここでは既存の慣例どおり
 * `state.hub.sendMessage(...)`を直接呼んで実行層の配線を確認する。
 */
describe('WorkflowRunner: ask_orchestrator（design.md §16.32、Issue #571）', () => {
  const ASK_YAML = `
version: 1
name: ask-orchestrator-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    continuePrompt: つづき
    maxIterations: 2
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  it(
    '問い（kind: question）はtaskMessageではなくtaskQuestionとしてオーケストレーターへ届く' +
      '（「問い」という意味づけ、design.md §16.32）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(ASK_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/ask.yaml', '/repo');
      await flush();

      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      // run開始の通知でターンが走っている。まず終わらせる
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });

      const result = state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: 'この方針で進めてよいですか',
        expectReply: false,
        kind: 'question',
      });
      expect(result?.accepted).toBe(true);
      await flush();

      // notifyOrchestratorはbusyの間pendingに積むだけなので、もう一度ターンを終わらせる
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });
      const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
      expect(last).toContain('kind="taskQuestion"');
      expect(last).not.toContain('kind="taskMessage"');
      expect(last).toContain('この方針で進めてよいですか');
    },
  );

  it(
    'blocking: true（expectReply: true）で送るとwaitingReplyへ遷移し、' +
      '既存のsend_messageで答えると再開する（新しい返信専用ツールは無い）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(ASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/ask.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      state.hub?.sendMessage({
        from: 'T1',
        to: ORCHESTRATOR_CONNECTION_ID,
        body: '進めてよいですか',
        expectReply: true,
        kind: 'question',
      });
      await flush();

      expect(t1.pauseLoopCount).toBe(1);
      expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

      state.hub?.sendMessage({
        from: ORCHESTRATOR_CONNECTION_ID,
        to: 'T1',
        body: '進めてください',
        expectReply: false,
      });
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      expect(t1.resumeLoopCount).toBe(1);
    },
  );

  it(
    '答えが来ないままreplyTimeoutSecを超えても待ちぼうけ検出で解放される' +
      '（design.md §16.21「待ちぼうけを検出する経路」を壊していないことの固定。' +
      'blocking: trueが増えても既存の検出は変わらない）',
    async () => {
      vi.useFakeTimers();
      try {
        const { deps, state } = fakeMessagingDeps();
        const readReplyTimeoutSec = () => 10;
        const { runner, codexHost, store } = createHarness(ASK_YAML, {
          messaging: { ...deps, readReplyTimeoutSec },
        });
        const result = await runner.start('/repo/.agents/workflows/ask.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const t1 = codexHost.byTaskId('T1');
        // T2は無反応のまま走り続ける。問いは`kind: 'question'`
        state.hub?.sendMessage({
          from: 'T1',
          to: ORCHESTRATOR_CONNECTION_ID,
          body: '進めてよいですか',
          expectReply: true,
          kind: 'question',
        });
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

        await vi.advanceTimersByTimeAsync(10_000 + WAITING_REPLY_POLL_INTERVAL_MS);
        await flush();

        expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
        expect(t1.resumeLoopCount).toBe(1);
        const snapshot = runner.getSnapshot(runId);
        expect(snapshot?.warnings.some((w) => w.kind === 'messagingStalled')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    '答えが来ないまま待ちぼうけ検出で解放された後、maxIterationsを使い切ると失敗として確定する' +
      '（受入基準「答えが来ないままmaxIterationsに達したらタスクが失敗として確定する' +
      '（返事待ちで枠を占有し続けない）」。RED実測はrunnerMessaging.tsのJSDoc・報告に記録）',
    async () => {
      vi.useFakeTimers();
      try {
        const { deps, state } = fakeMessagingDeps();
        const readReplyTimeoutSec = () => 10;
        const { runner, codexHost, store } = createHarness(ASK_YAML, {
          messaging: { ...deps, readReplyTimeoutSec },
        });
        const result = await runner.start('/repo/.agents/workflows/ask.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const t1 = codexHost.byTaskId('T1');
        state.hub?.sendMessage({
          from: 'T1',
          to: ORCHESTRATOR_CONNECTION_ID,
          body: '進めてよいですか',
          expectReply: true,
          kind: 'question',
        });
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingReply');

        // 誰も答えないまま時間切れで解放される（待ちぼうけ検出の経路2）
        await vi.advanceTimersByTimeAsync(10_000 + WAITING_REPLY_POLL_INTERVAL_MS);
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

        // 解放後も答えが来ないまま、このタスクのmaxIterations（2）を使い切って
        // ループが回数切れになった経路（LoopController自体はtest/unit/loopController.test.ts
        // が別途カバーする。ここでは`waitingReply`からの解放後もmaxIterationsの管理が
        // 生きていて、占有し続けず失敗に確定することだけを確認する）
        t1.finish('maxReached', { ...initialChatState });
        await flush();

        expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
        // 回数切れだけはセッションを残す（issue #284と同じ扱い）。「占有し続けない」とは
        // waitingReplyのまま並列枠を塞ぎ続けないことで、ここではT1がfailedへ確定して
        // 枠を明け渡したこと自体を確認する（T2はT1に依存しないため走り続けてよい）
        expect(t1.disposed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('WorkflowRunner: run終了処理の回数（Issue #432-2、Issue #491で上書き）', () => {
  /**
   * オーケストレーターへの通知はターン中は`pending`に溜まり、ターンが終わって
   * （`busy: true → false`）初めて`session.send`へ渡る（`onOrchestratorStateChanged`）。
   * テストでは実CLIの応答を模して明示的にターンを終わらせないと、送信済みの本文を
   * `sentTexts`から観測できない。
   */
  const flushOrchestratorTurn = (codexHost: FakeHost): void => {
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession | undefined;
    if (orchestrator === undefined) {
      return;
    }
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });
  };

  const countRunFinishedNotices = (codexHost: FakeHost): number => {
    const orchestrator = codexHost.orchestratorSessions[0];
    const joined = orchestrator?.sentTexts.join('\n') ?? '';
    return (joined.match(/ワークフローの実行が終了しました/g) ?? []).length;
  };

  /** 再開通知（`notifyOrchestratorRunResumed`、design.md §16.43、Issue #491）の件数。 */
  const countRunResumedNotices = (codexHost: FakeHost): number => {
    const orchestrator = codexHost.orchestratorSessions[0];
    const joined = orchestrator?.sentTexts.join('\n') ?? '';
    return (joined.match(/終了していた実行が人の操作で再開されました/g) ?? []).length;
  };

  it('通常の1回で終わるrunでは、従来どおりnotifyOrchestratorRunFinishedが1回だけ送られる（誤検知防止）', async () => {
    const YAML = `
version: 1
name: single-shot-test
tasks:
  - id: T1
    prompt: p
    done: d
`;
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/single.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    flushOrchestratorTurn(codexHost);

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(countRunFinishedNotices(codexHost)).toBe(1);
  });

  /**
   * **Issue #432-2 の受入基準をIssue #491が上書きした。**元は「runにつき1度だけ」で、
   * 2周目の`notifyOrchestratorRunFinished`は送られなかった。
   *
   * #432-2 が避けたかったのは**唐突な2度目の終了通知**である。当時は再開を伝える経路が
   * 無く、オーケストレーターから見ると「終了しました」と言われたきり黙っていたところへ
   * もう一度「終了しました」だけが届く形だった。再開通知（`runResumed`、design.md
   * §16.43）が入ったことでその前提が変わり、「終了→再開→終了」という筋の通った並びに
   * なる。**2度目の終了を伝えないほうが、走っているのか終わったのか分からない状態を残す。**
   *
   * 一律に2回へ増えたわけではない。**再開を挟まないrunは従来どおり1回**であることを、
   * この describe の先頭の「通常の1回で終わるrunでは、従来どおり…（誤検知防止）」が
   * 固定している。あちらを一緒に2へ変えてはいけない。
   */
  it('retryTask経由では、失敗で終了→再実行成功→再度終了、で2回送られる（再開通知の追加により。Issue #491）', async () => {
    const YAML = `
version: 1
name: retry-task-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/retry-task.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 1周目: T1が失敗し、T2はskippedになってrunはfailedで終わる
    codexHost.byTaskId('T1').finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    flushOrchestratorTurn(codexHost);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
    expect(countRunFinishedNotices(codexHost)).toBe(1);

    // 人がT1を再実行し、依存先T2も含めて最後まで走らせる
    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    flushOrchestratorTurn(codexHost);

    // 2周目: 今度はsucceededで終わる
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    // 再開を挟んだ2度目の終了は「同じ終了」ではないので、もう1度送られる（Issue #491）
    expect(countRunFinishedNotices(codexHost)).toBe(2);
    // 再開自体も伝わっている。これが無いと2度目の「終了しました」が唐突に届く形になり、
    // #432-2 が絞った当時の状況へ戻る
    expect(countRunResumedNotices(codexHost)).toBe(1);
  });

  it('continueTask経由では、回数切れで終了→続けて成功→再度終了、で2回送られる（再開通知の追加により。Issue #491）', async () => {
    const YAML = `
version: 1
name: continue-task-test
tasks:
  - id: T1
    prompt: p
    continuePrompt: つづき
    maxIterations: 3
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue-task.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 1周目: T1が回数切れでfailed（maxReached）になり、T2はskippedでrunはfailedで終わる
    const t1 = codexHost.byTaskId('T1');
    t1.finish('maxReached', { ...initialChatState });
    await flush();
    flushOrchestratorTurn(codexHost);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
    expect(countRunFinishedNotices(codexHost)).toBe(1);

    // 人が「続ける」を選び、同じセッションのまま最後まで走らせる
    expect(runner.continueTask(runId, 'T1')).toBe(true);
    await flush();
    t1.finish('done', doneState('ok'));
    await flush();
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    flushOrchestratorTurn(codexHost);

    // 2周目: 今度はsucceededで終わる
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    // Issue #491。上の`retryTask`のテストと同じ理由
    expect(countRunFinishedNotices(codexHost)).toBe(2);
    expect(countRunResumedNotices(codexHost)).toBe(1);
  });

  it('まだ終わっていないrunの再実行では、再開通知を送らない（Issue #491）', async () => {
    // T1とT2に依存関係を持たせない。T1が失敗してもT2が走り続けるため、runは`running`の
    // ままになる。この状態の`retryTask`はオーケストレーターにとって「終わったものが
    // 動き出した」ではないので、再開通知は要らない——送ると、終わっていないrunについて
    // 「終了していた実行が再開されました」と伝えることになり、状態の認識を壊す
    const YAML = `
version: 1
name: resume-notice-scope-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    prompt: p2
    done: d2
`;
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/scope.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('failed', { ...initialChatState, turnFailed: true });
    await flush();
    flushOrchestratorTurn(codexHost);
    // T2がまだ走っているのでrunは終わっていない（終了通知も出ていない）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.finishedAt).toBeUndefined();
    expect(countRunFinishedNotices(codexHost)).toBe(0);

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    flushOrchestratorTurn(codexHost);

    expect(countRunResumedNotices(codexHost)).toBe(0);
  });

  /**
   * Issue #511: `reflectIntegrationToWorkspace`が比較に使う`live.pseudo.baseline`は、
   * 従来`resolvePseudoState`が実行開始時／復元時に一度取ったスナップショットのまま
   * 固定で、1周目の反映後も更新されなかった。1周目の反映が1件でも成功していれば
   * ワークスペースは`baseline`から意図的に変化しているため、2周目は必ず
   * `workspaceChanged`の誤検知になり、再開後に新たに統合された内容がワークスペースへ
   * 反映されなかった（PR #509はこの誤検知に対する暫定対応として2周目以降の反映自体を
   * 行わないようにし、代わりに`pseudoWorktreeReflectSkipped`という警告だけを出す形に
   * していたが、内容が失われること自体は直っていなかった）。
   *
   * この修正で`reflectPseudoWorktree`は反映に成功する（`partialApply`を含む）たびに
   * `baseline`を反映後のワークスペースの実際の状態へ更新するため、`pseudoWorktreeReflectSkipped`
   * とその送出分岐は不要になり削除した。以下の2テストは受入基準どおり、
   * (1) 1周目の反映成功（実際のディスクの変化を伴う）で古いままの`baseline`に
   * 取り残されず、2周目に新たに`done`になったタスクの内容もワークスペースへ届くこと、
   * (2) 1周目の反映成功後から2周目の反映までの間に人が編集した場合、その編集は
   * 3周目以降も一貫して検知され続けること（＝拒否時に`baseline`が人の編集で
   * 上書きされていないこと）、を確かめる。
   *
   * **両テストとも、`runnerWorkingDirectory.ts`の`baseline`更新1行
   * （`live.pseudo.baseline = await updateSnapshotForAppliedPaths(...)`）を
   * 無効化した場合と、workspaceChangedで拒否したときも含めて常に更新するよう変えた
   * 場合の両方でREDになることを実測済み（PR本文参照。docs/design.md §16.25の
   * 確認事項参照）。**
   */
  describe('疑似worktreeのbaseline更新（design.md §16.20、Issue #511）', () => {
    const PSEUDO_RETRY_YAML = `
version: 1
name: pseudo-retry-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;

    it(
      '1周目の反映成功（実ファイル変更あり）でbaselineを更新し、' +
        '2周目に新たにdoneになったタスクの統合内容もワークスペースへ届く',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(PSEUDO_RETRY_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start('/repo/.agents/workflows/pseudo-retry.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        // 1周目: T1がa.txtを変更して成功し（実際にディスクへ書き込みが起きる）、
        // T2は失敗してrunはfailedで終わる。run終了時の反映でT1の変更（200/200）が
        // ワークスペースへ届く。この時点でbaselineが更新されていないと、2周目は
        // ワークスペースが「意図的に変化した」ことを人の編集と誤検知してしまう
        // （このPRが直している本題）
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 200, mtimeMs: 200 });
        codexHost.byTaskId('T1').finish('done', doneState('ok'));
        await flush();
        codexHost.byTaskId('T2').finish('failed', { ...initialChatState, turnFailed: true });
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('failed');
        // 1周目の反映が実際に成功し、a.txtがワークスペースへ届いていることを確認
        // （このテストの前提。ここが揃っていないと2周目の検証が成立しない）
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 200, mtimeMs: 200 });

        // 人がT2を再実行し、最後まで走らせる（ワークスペースは1周目の反映後から
        // 一切人の手で編集しない＝2周目が拒否されてはいけないケース）。T2は
        // b.txt（T1が触っていない別ファイル）を新規作成する。同じa.txtを触ると
        // 「別タスクが既に統合済みのパスへ書く」という別の正当な衝突判定
        // （`planIntegration`、3-way mergeをしないための仕様）に当たってしまい、
        // baseline更新の検証にならないため
        expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        // 再実行後の複製先は`T2`ではなく`T2-retry0`（`retrySuffixOf`。design.md §16.5）
        const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T2-retry0');
        fs.setFile(path.join(cloneDir2, 'b.txt'), { size: 999, mtimeMs: 999 });
        codexHost.byTaskId('T2').finish('done', doneState('ok'));
        await flush();

        // 2周目: succeededで終わる。今度も反映が実際に行われ、b.txtの内容が
        // ワークスペースへ届く。baselineが1周目の反映成功後に更新されていないと
        // （＝1周目の`a.txt`の変更`200/200`が古いままの初期値`10/100`と比較されると）、
        // 2周目の比較は必ず`workspaceChanged`の誤検知になり、この反映は届かない
        expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 200, mtimeMs: 200 });
        expect(fs.files.get('/repo/b.txt')).toEqual({ size: 999, mtimeMs: 999 });
        const snapshot = runner.getSnapshot(runId);
        expect(
          snapshot?.warnings.some(
            (w) => w.kind === 'pseudoWorktreeReflectBlocked' || w.kind === 'pseudoWorktreeConflict',
          ),
        ).toBe(false);
      },
    );

    it(
      '1周目の反映成功後から2周目の反映までの間に人が編集した場合、その編集は' +
        '3周目以降も一貫して検知され続ける（拒否時にbaselineが人の編集で上書きされない）',
      async () => {
        const YAML = `
version: 1
name: pseudo-retry-3round-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
  - id: T3
    dependsOn: [T2]
    prompt: p3
    done: d3
`;
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-retry-3round.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        // 1周目: T1がa.txtを変更して成功し、T2は失敗する（T3は依存未達でskipped）。
        // run終了時の反映で、T1の変更（200/200）がワークスペースへ届き、
        // baselineもその状態へ更新される
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 200, mtimeMs: 200 });
        codexHost.byTaskId('T1').finish('done', doneState('ok'));
        await flush();
        codexHost.byTaskId('T2').finish('failed', { ...initialChatState, turnFailed: true });
        await flush();
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('failed');
        expect(store.find(runId)?.tasks['T3']?.state).toBe('skipped');
        // 1周目の反映が実際に成功し、a.txtがワークスペースへ届いていることを確認
        // （このテストの前提。ここが揃っていないと以降の検証が成立しない）
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 200, mtimeMs: 200 });

        // 1周目の反映が終わった後、人がワークスペースを直接編集する（エージェントの
        // 複製先ではなく、ワークスペース本体を書き換える点が「人の編集」の模擬として
        // 重要）。以降このテストでは、この編集をもう二度と`fs.setFile`で上書きしない
        fs.setFile('/repo/a.txt', { size: 300, mtimeMs: 300 });

        // 2周目: 人がT2を再実行する（T3もskippedからpendingへ復元される）。T2は
        // b.txt（T1が触っていない別ファイル）を新規作成し、統合キューへ新しい内容が
        // 積まれるようにする。T1と同じa.txtを触ると「別タスクが既に統合済みのパスへ
        // 書く」という別の正当な衝突判定（`planIntegration`、3-way mergeをしないための
        // 仕様）に当たってしまい、baseline更新の検証にならないため。
        // T3を失敗させて2周目もrunをfailedで終える（3周目でさらにT3を再実行するため）
        expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        // 再実行後の複製先は`T2`ではなく`T2-retry0`（`retrySuffixOf`。design.md §16.5）
        const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T2-retry0');
        fs.setFile(path.join(cloneDir2, 'b.txt'), { size: 400, mtimeMs: 400 });
        codexHost.byTaskId('T2').finish('done', doneState('ok'));
        await flush();
        codexHost.byTaskId('T3').finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        // 2周目: T2はdone、T3はfailedで終わる。人の編集（300/300）はbaseline
        // （200/200）と食い違うため、2周目の反映はworkspaceChangedとして拒否され、
        // T2の統合内容（b.txt）はワークスペースへ届かない
        expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T3']?.state).toBe('failed');
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 300, mtimeMs: 300 });
        expect(fs.files.has('/repo/b.txt')).toBe(false);
        const afterRound2 = runner.getSnapshot(runId);
        const blockedAfterRound2 = afterRound2?.warnings.filter(
          (w) => w.kind === 'pseudoWorktreeReflectBlocked',
        );
        expect(blockedAfterRound2).toHaveLength(1);
        expect(blockedAfterRound2?.[0]?.message).toContain('実行中にワークスペースが変更された');
        expect(blockedAfterRound2?.[0]?.message).toContain('a.txt');

        // 3周目: 人がT3を再実行する。ワークスペースは2周目の拒否から一切変更していない
        // （＝人の編集300/300がそのまま残っている）。もし2周目の拒否時にbaselineが
        // （誤って）人の編集へ更新されてしまっていたら、3周目の比較は「変化なし」と
        // 誤判定し、a.txt（T1が統合済みの版）・b.txt・c.txtがそのまま人の編集を
        // 上書きしてしまう。T3もc.txt（別ファイル）を新規作成する
        expect(runner.retryTask(runId, 'T3')).toEqual({ ok: true });
        await flush();
        // 再実行後の複製先は`T3`ではなく`T3-retry0`（`retrySuffixOf`。design.md §16.5）
        const cloneDir3 = path.join('/repo', '.agents', 'worktrees', runId, 'T3-retry0');
        fs.setFile(path.join(cloneDir3, 'c.txt'), { size: 500, mtimeMs: 500 });
        codexHost.byTaskId('T3').finish('done', doneState('ok'));
        await flush();

        // 3周目もsucceededで終わる。人の編集（300/300）はbaselineが2周目の拒否で
        // 上書きされていない限り、baseline（200/200）とのままの比較で今も検知され、
        // 反映は3周目も引き続きworkspaceChangedとして拒否される
        expect(store.find(runId)?.tasks['T3']?.state).toBe('done');
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 300, mtimeMs: 300 });
        expect(fs.files.has('/repo/b.txt')).toBe(false);
        expect(fs.files.has('/repo/c.txt')).toBe(false);
        const afterRound3 = runner.getSnapshot(runId);
        const blockedAfterRound3 = afterRound3?.warnings.filter(
          (w) => w.kind === 'pseudoWorktreeReflectBlocked',
        );
        expect(blockedAfterRound3).toHaveLength(2);
        expect(blockedAfterRound3?.[1]?.message).toContain('実行中にワークスペースが変更された');
        expect(blockedAfterRound3?.[1]?.message).toContain('a.txt');
      },
    );

    it(
      '反映が一部だけ成功（partialApply）したとき、適用できたパスだけbaselineが更新され、' +
        '2周目の反映がその分を誤ってworkspaceChangedと判定しない（監査指摘、runnerレベル）',
      async () => {
        const git = fakeGit({ notGitRepo: true });
        const fs = new FakePseudoFs({ '/repo/a.txt': { size: 10, mtimeMs: 100 } });
        const { runner, codexHost, store } = createHarness(PSEUDO_RETRY_YAML, {
          git,
          pseudoWorktree: { fs, exclude: [] },
        });
        const result = await runner.start(
          '/repo/.agents/workflows/pseudo-partial-apply.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        // T1がa.txt（既存ファイルの変更）とb.txt（新規ファイル）の2件を統合する。
        // 統合（integratePseudoWorktree、_integrationへのコピー）は2件とも正常に
        // 終わらせ、run終了時の反映（ワークスペース本体へのコピー）だけa.txtは成功・
        // b.txtは失敗させる。反映先のパス（ワークスペース直下の`/repo/b.txt`）そのもので
        // 判定する。統合先（`_integration`）へのコピーやT1完了直後にクローンされる
        // T2の複製先へのコピー（`cloneWorkspace`）など、他のコピー呼び出し回数に
        // 依存しないため、それらの回数が変わっても壊れない
        const cloneDir1 = path.join('/repo', '.agents', 'worktrees', runId, 'T1');
        fs.setFile(path.join(cloneDir1, 'a.txt'), { size: 20, mtimeMs: 200 });
        fs.setFile(path.join(cloneDir1, 'b.txt'), { size: 30, mtimeMs: 300 });
        // Issue #485で`rename`が必須になり、反映は「一時ファイルへ`copyFile`してから
        // `rename`で確定」の一本になった。そのため`copyFile`の`to`は一時ファイル名
        // （`.pwt-reflect-<hex>.tmp`）で、反映先のパスそのものではない。**反映先で
        // 判定する**というこのテストの意図は`rename`側へ移す（`rename`の`to`が
        // 確定後のパスである）
        const originalRename = fs.rename.bind(fs);
        let injectFailure = true;
        fs.rename = async (from: string, to: string): Promise<void> => {
          if (injectFailure && to === '/repo/b.txt') {
            throw Object.assign(new Error('ENOSPC: no space left on device'), {
              code: 'ENOSPC',
            });
          }
          await originalRename(from, to);
        };

        codexHost.byTaskId('T1').finish('done', doneState('ok'));
        await flush();
        codexHost.byTaskId('T2').finish('failed', { ...initialChatState, turnFailed: true });
        await flush();

        // マージ（統合）自体はdoneのまま確定する。失敗したのは反映（ワークスペースへの
        // コピー）の一部だけ
        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('failed');
        // a.txtは反映に成功し、b.txtは反映に失敗して元のまま（存在しない）
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 20, mtimeMs: 200 });
        expect(fs.files.has('/repo/b.txt')).toBe(false);
        const afterRound1 = runner.getSnapshot(runId);
        const blockedAfterRound1 = afterRound1?.warnings.filter(
          (w) => w.kind === 'pseudoWorktreeReflectBlocked',
        );
        expect(blockedAfterRound1).toHaveLength(1);
        expect(blockedAfterRound1?.[0]?.message).toContain('適用済み');
        expect(blockedAfterRound1?.[0]?.message).toContain('a.txt');
        expect(blockedAfterRound1?.[0]?.message).toContain('未適用');
        expect(blockedAfterRound1?.[0]?.message).toContain('b.txt');

        // 以降の反映は正常に成功させたいので、注入した失敗を止める
        injectFailure = false;

        // 2周目: 人がT2を再実行する。T2はc.txt（別ファイル）を新規作成する。
        // このとき1周目でpartialApplyとして適用済みだったa.txtのbaselineが
        // `updateSnapshotForAppliedPaths`で正しく更新されていれば、2周目の反映開始時の
        // 比較でa.txt（既に20/200で書き込み済み）は「変化なし」と判定され
        // workspaceChangedにはならない。もしbaseline更新が働いていなければ、
        // a.txtは古いbaseline（10/100）との差分として誤検知され、2周目の反映全体が
        // 拒否されてb.txt・c.txtとも届かない
        expect(runner.retryTask(runId, 'T2')).toEqual({ ok: true });
        await flush();
        const cloneDir2 = path.join('/repo', '.agents', 'worktrees', runId, 'T2-retry0');
        fs.setFile(path.join(cloneDir2, 'c.txt'), { size: 999, mtimeMs: 999 });
        codexHost.byTaskId('T2').finish('done', doneState('ok'));
        await flush();

        // 2周目は成功し、1周目に取りこぼしたb.txtも改めて適用され、T2のc.txtも届く
        expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
        expect(fs.files.get('/repo/a.txt')).toEqual({ size: 20, mtimeMs: 200 });
        expect(fs.files.get('/repo/b.txt')).toEqual({ size: 30, mtimeMs: 300 });
        expect(fs.files.get('/repo/c.txt')).toEqual({ size: 999, mtimeMs: 999 });
        const afterRound2 = runner.getSnapshot(runId);
        const blockedAfterRound2 = afterRound2?.warnings.filter(
          (w) => w.kind === 'pseudoWorktreeReflectBlocked',
        );
        // 2周目で新たな`pseudoWorktreeReflectBlocked`は増えない
        // （1周目のpartialApply分1件のみ）
        expect(blockedAfterRound2).toHaveLength(1);
      },
    );
  });
});

describe('WorkflowRunner: マージのリロード後再判定（design.md §16.11）', () => {
  const YAML = `
version: 1
name: merge-reload-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  function makeReloadedRunner(
    store: WorkflowRunStore,
    git: FakeGitHandle,
    host: FakeHost,
  ): WorkflowRunner {
    return new WorkflowRunner({
      hosts: { codex: host, claude: host },
      worktreeQueue: new WorktreeCreationQueue(),
      git,
      fs: identityFs,
      filePort: filePort(YAML),
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });
  }

  it('永続化されたmergingタスクは、マージコミットが統合ブランチの履歴に見つかればdoneとして復元される', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000101';
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/reload-merging.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      tasks: {
        T1: {
          state: 'merging',
          sessionId: 'session-1',
          cwd: `/repo/.agents/worktrees/${runId}/T1`,
          branch: `wf/${runId}/T1`,
          submissionCount: 1,
          retryCount: 0,
          manualRetryCount: 0,
          failure: undefined,
          pullRequestNumber: undefined,
          pullRequestUrl: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));

    const git = fakeGit();
    // マージコミットが既に履歴にある（マージ自体は完了していたが、リロードでその後の
    // 状態遷移が失われたケースを模す）。`reconcileMergingTaskOnReload`は`--grep`ではなく
    // 件名の一覧（`git log --format=%s`）をJS側で照合するため、実際のマージコミットの
    // 固定文言（`<type>(<taskId>): merge task (run <runId>)`。typeは既定の`chore`）を返す
    const originalRun = git.run.bind(git);
    const gitWithLog: FakeGitHandle = {
      ...git,
      run: async (args, cwd) => {
        if (args[0] === 'log') {
          return { code: 0, stdout: `chore(T1): merge task (run ${runId})\n`, stderr: '' };
        }
        return originalRun(args, cwd);
      },
    };

    const host = new FakeHost();
    const runner = makeReloadedRunner(store, gitWithLog, host);
    await runner.restoreRunsForView();

    expect(runner.getSnapshot(runId)?.tasks[0]?.state).toBe('done');
  });

  it('永続化されたmergingタスクは、マージコミットが見つからずbranch/cwdが分かれば自動でマージをやり直す', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000102';
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/reload-merging2.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      tasks: {
        T1: {
          state: 'merging',
          sessionId: 'session-1',
          cwd: `/repo/.agents/worktrees/${runId}/T1`,
          branch: `wf/${runId}/T1`,
          submissionCount: 1,
          retryCount: 0,
          manualRetryCount: 0,
          failure: undefined,
          pullRequestNumber: undefined,
          pullRequestUrl: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));

    const git = fakeGit(); // 既定でmerge --no-ffは成功する
    const host = new FakeHost();
    const runner = makeReloadedRunner(store, git, host);
    await runner.restoreRunsForView();
    await flush();

    expect(runner.getSnapshot(runId)?.tasks[0]?.state).toBe('done');
    const mergeCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
    expect(mergeCall?.args).toContain(`wf/${runId}/T1`);
  });

  it('永続化されたmergingタスクに未解決の衝突が残っていればblockedとして復元される', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000103';
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/reload-blocked.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      tasks: {
        T1: {
          state: 'merging',
          sessionId: 'session-1',
          cwd: `/repo/.agents/worktrees/${runId}/T1`,
          branch: `wf/${runId}/T1`,
          submissionCount: 1,
          retryCount: 0,
          manualRetryCount: 0,
          failure: undefined,
          pullRequestNumber: undefined,
          pullRequestUrl: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));

    const git = fakeGit();
    const originalRun = git.run.bind(git);
    const gitWithConflict: FakeGitHandle = {
      ...git,
      run: async (args, cwd) => {
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          return { code: 0, stdout: 'CONFLICT.txt\n', stderr: '' };
        }
        return originalRun(args, cwd);
      },
    };

    const host = new FakeHost();
    const runner = makeReloadedRunner(store, gitWithConflict, host);
    await runner.restoreRunsForView();

    expect(runner.getSnapshot(runId)?.tasks[0]?.state).toBe('blocked');
  });
});

describe('WorkflowRunner: manual / interrupted の実行層（design.md §16.5、Issue #148）', () => {
  /**
   * `applyLoopStopReason`（純粋ロジック側）は`manual`/`interrupted`を既に網羅しているが、
   * 実行層（`runner.ts`）を通した結線は未検証だった。design.mdが「同じ『止める』を1つの
   * 理由にまとめると、Viewからタスクを1つ止めただけでワークフロー全体が停止してしまう」
   * として`taskStopped`と区別している箇所（§16.5）を、実行層での結線ミし（誤って
   * `session.dispose()` や `cleanupWorktreeIfNeeded` を呼んでしまう類）から守る。
   */
  const PARALLEL_YAML = `
version: 1
name: manual-interrupted-test
defaults:
  maxParallel: 2
tasks:
  - id: A
    prompt: p
    done: d
  - id: B
    prompt: p
    done: d
`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('interruptedで終わったタスク自身の状態は変わらず、session.dispose()もcleanupWorktreeIfNeededも呼ばれない', async () => {
    const cleanupSpy = vi.spyOn(
      WorkflowRunner.prototype as unknown as {
        cleanupWorktreeIfNeeded: (...args: unknown[]) => void;
      },
      'cleanupWorktreeIfNeeded',
    );
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML);
    const result = await runner.start('/repo/.agents/workflows/manual-interrupted.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const a = codexHost.byTaskId('A');
    expect(store.find(runId)?.tasks['A']?.state).toBe('running');

    a.finish('interrupted', { ...initialChatState });
    await flush();

    // 人がタブへ直接介入した状態は§16.3のどの状態にも当てはまらないため、
    // タスク自身の状態は変えない設計（design.md §16.5）
    expect(store.find(runId)?.tasks['A']?.state).toBe('running');
    // done/failedと同じ経路でセッションを解放してはいけない（走っていたセッションは
    // そのまま残し、以降は人の操作に委ねる設計）
    expect(a.disposed).toBe(false);
    // worktreeの撤去判定にも回してはいけない
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('interruptedになってもlive.finishedにならず、他のタスクは動き続ける', async () => {
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML);
    const result = await runner.start('/repo/.agents/workflows/manual-interrupted.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const a = codexHost.byTaskId('A');
    const b = codexHost.byTaskId('B');

    a.finish('interrupted', { ...initialChatState });
    await flush();

    // Aのinterruptedに巻き込まれず、Bは走り続ける
    expect(store.find(runId)?.tasks['B']?.state).toBe('running');
    expect(b.disposed).toBe(false);

    // live.finishedが立っていれば以降pump()は何もしなくなる（新規実装の`pump`参照）。
    // Bを実際に完了させ、通常どおりマージまで進むことで、pumpがまだ機能している
    // （＝finishedになっていない）ことを示す
    b.finish('done', doneState('Bの応答'));
    await flush();

    expect(store.find(runId)?.tasks['B']?.state).toBe('done');
    expect(b.disposed).toBe(true);

    // Aはinterruptedのまま人の操作待ちで残り続ける。実行全体はhaltedByUserだが、
    // Aがrunningのままなので終了判定（design.md §16.5「全体の終了」1.）はまだ`running`
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.haltedByUser).toBe(true);
    expect(snapshot?.outcome).toBe('running');
    expect(store.find(runId)?.tasks['A']?.state).toBe('running');
  });

  /**
   * Issue #443（案A）: 衝突解決セッションが人に止められたとき（`manual`/`interrupted`/
   * `taskStopped`）、対象タスクの`merging`は必ず閉じて`blocked`にする。`merging`のまま
   * 残すと`getRunOutcome`が`running`を返し続け、runが終了確定せず`retryMergeState`
   * （`blocked`からしか動かない）の「再マージ」の対象にもならない行き止まりになるため
   * （Issue #443本文）。`git merge --abort`は呼ばない（Issue #412・#434の「巻き戻さない」を
   * 維持する）。
   */
  it.each(['manual', 'interrupted', 'taskStopped'] as const)(
    '衝突解決セッションが%sで終わったとき、対象タスクはblockedになり実行全体は終了確定する',
    async (reason) => {
      const SOLO_MERGE_YAML = `
version: 1
name: manual-merge-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost, store } = createHarness(SOLO_MERGE_YAML, { git });
      const result = await runner.start('/repo/.agents/workflows/manual-merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // T1は衝突したのでmergingのまま、衝突解決セッションが開いている
      expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
      const resolutionSession = codexHost.sessions.at(-1);
      expect(resolutionSession).toBeDefined();
      expect(resolutionSession?.cwd.endsWith('_integration')).toBe(true);

      resolutionSession?.finish(reason as LoopStopReason, { ...initialChatState });
      await flush();

      // 人が止めた。実行全体は停止するが、タスク自身は`merging`のまま残さず`blocked`に
      // 確定させる（Issue #443・案A）
      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      // abortAndBlock（マージの巻き戻し）は経由しない。git merge --abortは呼ばれない
      const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
      expect(abortCall).toBeUndefined();
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);
      // `merging`が無くなった以上、runは`running`を返し続けない（`getRunOutcome`が
      // 終了状態を返す。Issue #443の中心的な症状の解消を確かめる）
      expect(runner.getSnapshot(runId)?.outcome).toBe('blocked');

      // `blocked`になったので「再マージ」の対象にできる（`retryMergeState`は`blocked`
      // からしか動かない。修正前は`merging`のまま残るため対象にならなかった）
      git.resolveConflict();
      expect(runner.retryMerge(runId, 'T1')).toBe(true);
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    },
  );

  /**
   * **順序依存の担保（Issue #443レビュー指摘）。** `finishMergeResolution`は
   * `applyLoopStopReason`の**後**に`markMergeBlocked`を呼ぶ設計だが、上のSOLO_MERGE_YAML
   * のテスト（T1に依存タスクが無い）はこの順序を検知できない。依存する後続の`failure`が
   * `runHalted`か`mergeBlocked`かは、`runner.stop()`を経由せず直接`manual`/`interrupted`が
   * 届く経路（`haltedByUser`がまだ`false`の状態でこの呼び出しが初めてそれを立てる経路）
   * でしか区別できない。`taskStopped`は`stop()`が事前に`haltedByUser`を立てているため
   * `applyLoopStopReason`が早期returnし、この順序に依らず`runHalted`のまま残る
   * （このテストの対象外）。
   *
   * 逆順（`markMergeBlocked`を先に呼ぶ）にすると、まだ`pending`のT2・T3・T4が先に
   * `skipped(mergeBlocked)`へ倒れ、後から呼ばれる`skipRemainingPending`は`pending`だけを
   * 見るため上書きできず、この後続の`failure`が`mergeBlocked`のまま残ってしまう
   * （このテストがRED化する）。
   */
  it.each(['manual', 'interrupted'] as const)(
    '衝突解決セッションが%sで終わったとき（stop()を経由しない直接介入）、依存する後続はrunHaltedのままでmergeBlockedに上書きされない',
    async (reason) => {
      const DEPENDENT_MERGE_YAML = `
version: 1
name: dependent-merge-test
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
  - id: T3
    dependsOn: [T1]
    prompt: p3
    done: d3
  - id: T4
    dependsOn: [T2, T3]
    prompt: p4
    done: d4
`;
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost, store } = createHarness(DEPENDENT_MERGE_YAML, { git });
      const result = await runner.start('/repo/.agents/workflows/dependent-merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // T1は衝突したのでmergingのまま。T2・T3はT1がmergingの間は開始できずpendingのまま
      expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
      expect(store.find(runId)?.tasks['T2']?.state).toBe('pending');
      expect(store.find(runId)?.tasks['T3']?.state).toBe('pending');
      expect(store.find(runId)?.tasks['T4']?.state).toBe('pending');
      // `runner.stop()`は呼ばない。haltedByUserはまだfalseのはず
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(false);

      const resolutionSession = codexHost.sessions.at(-1);
      expect(resolutionSession).toBeDefined();

      resolutionSession?.finish(reason as LoopStopReason, { ...initialChatState });
      await flush();

      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
      expect(abortCall).toBeUndefined();
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);

      // 順序依存の本体: 依存する後続はrunHaltedのまま（mergeBlockedに上書きされない）
      expect(store.find(runId)?.tasks['T2']?.failure).toEqual({ kind: 'runHalted' });
      expect(store.find(runId)?.tasks['T3']?.failure).toEqual({ kind: 'runHalted' });
      expect(store.find(runId)?.tasks['T4']?.failure).toEqual({ kind: 'runHalted' });
    },
  );
});

describe('WorkflowRunner: 回数切れから続ける（design.md §16.8、issue #284）', () => {
  const YAML = `
version: 1
name: continue-test
tasks:
  - id: T1
    prompt: p
    continuePrompt: つづき
    maxIterations: 3
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;

  it('回数切れではセッションを解放せず、続けるで同じセッションへ継続プロンプトを送る', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('maxReached', { ...initialChatState });
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    // 続きから走らせる唯一の足がかりなので、回数切れだけはセッションを残す
    expect(t1.disposed).toBe(false);

    expect(runner.continueTask(runId, 'T1')).toBe(true);
    await flush();

    // 新しいセッションは作らない（同じ会話・同じworktreeのまま）
    expect(codexHost.sessions).toHaveLength(1);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    expect(store.find(runId)?.tasks['T1']?.failure).toBeUndefined();
    // worktreeもブランチも作り直さないため、再試行の回数は増やさない
    expect(store.find(runId)?.tasks['T1']?.retryCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.manualRetryCount).toBe(0);

    expect(t1.runLoopCalls).toHaveLength(2);
    const second = t1.runLoopCalls[1];
    // 初回の指示を送り直すと最初からやり直させることになる（継続指示から再開する）
    expect(second?.initialPrompt).toBe('');
    expect(second?.continuePrompt).toBe('つづき');
    // 送信回数の予算はmaxIterations分そのまま足される
    expect(second?.maxIterations).toBe(3);
    expect(second?.condition).toContain('d');
    // 専用ブランチを持つタスクなので「コミットしてあること」も同じように足す
    expect(second?.condition).toContain('コミット');
  });

  it('続けると、連鎖してskippedになった依存先がpendingへ戻る', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('maxReached', { ...initialChatState });
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
    // failedによる停止は`hasFailedTask`から導出される（`haltedByUser`は立たない）
    expect(runner.getSnapshot(runId)?.outcome).toBe('failed');

    expect(runner.continueTask(runId, 'T1')).toBe(true);
    await flush();

    expect(store.find(runId)?.tasks['T2']?.state).toBe('pending');
    // T1がfailedでなくなったので実行全体も止まっていない
    expect(runner.getSnapshot(runId)?.outcome).toBe('running');
    expect(runner.getSnapshot(runId)?.haltedByUser).toBe(false);
  });

  it('回数切れ以外の失敗ではセッションを解放し、続けるも受け付けない', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('failed', { ...initialChatState, turnFailed: true });
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(t1.disposed).toBe(true);
    expect(runner.continueTask(runId, 'T1')).toBe(false);
    expect(t1.runLoopCalls).toHaveLength(1);
  });

  it('回数切れのあと再実行を選んだ場合、残っていたセッションを解放してから作り直す', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const attempt1 = codexHost.byTaskId('T1');
    attempt1.finish('maxReached', { ...initialChatState });
    await flush();
    expect(attempt1.disposed).toBe(false);

    expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();

    // 残したセッションを解放しないとCLIのプロセスが宙に浮く
    expect(attempt1.disposed).toBe(true);
    expect(codexHost.sessions).toHaveLength(2);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
  });

  it('未知のrun・未知のtaskIdでは何もしない', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('maxReached', { ...initialChatState });
    await flush();

    expect(runner.continueTask('no-such-run', 'T1')).toBe(false);
    expect(runner.continueTask(runId, 'no-such-task')).toBe(false);
  });
});

describe('WorkflowRunner: 停滞（stalled）で止まる（design.md §16.27、Issue #336）', () => {
  const YAML = `
version: 1
name: stall-test
tasks:
  - id: T1
    prompt: p
    continuePrompt: つづき
    maxIterations: 20
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;

  it('停滞ではセッションを解放せず、maxReachedとは区別できる理由でfailedに確定する', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/stall.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('stalled', { ...initialChatState });
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'stalled' });
    // maxReachedと同じく、続けるための足がかりとしてセッションを残す
    expect(t1.disposed).toBe(false);
    // 依存する後続はfailedの波及と同じくskippedになる
    expect(store.find(runId)?.tasks['T2']?.state).toBe('skipped');
  });

  it('停滞は続ける（continueTask）で同じセッションのまま再開できる', async () => {
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/stall.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('stalled', { ...initialChatState });
    await flush();

    expect(runner.continueTask(runId, 'T1')).toBe(true);
    await flush();

    // 新しいセッションは作らない（同じ会話・同じworktreeのまま）
    expect(codexHost.sessions).toHaveLength(1);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    expect(store.find(runId)?.tasks['T1']?.failure).toBeUndefined();
    expect(t1.runLoopCalls).toHaveLength(2);
  });

  it('停滞はワークフローViewの警告欄にloopStalledとして出る（maxReachedとは別kind）', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/stall.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('stalled', { ...initialChatState });
    await flush();

    const snapshot = runner.getSnapshot(runId);
    const warning = snapshot?.warnings.find((w) => w.kind === 'loopStalled');
    expect(warning?.taskId).toBe('T1');
    expect(warning?.message).toContain('T1');
    // maxReached専用の警告としては出ない（別kindで区別できる）
    expect(snapshot?.warnings.find((w) => w.kind === 'maxReached')).toBeUndefined();
  });

  it('停滞はオーケストレーターへtaskFailedではなくtaskStalledとして通知される', async () => {
    const { runner, codexHost } = createHarness(YAML);
    await runner.start('/repo/.agents/workflows/stall.yaml', '/repo');
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
    // run開始の通知でターンが走っている。走行中は割り込まないので、まず終わらせる
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });
    const sentBefore = orchestrator.sentTexts.length;

    codexHost.byTaskId('T1').finish('stalled', { ...initialChatState });
    await flush();

    // notifyOrchestratorはbusyの間pendingに積むだけなので、ここでも1回ターンを終わらせる
    // （design.md §16.25 確認事項4。busyゲートを通過させるところまで状態を進める）
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });

    const added = orchestrator.sentTexts.slice(sentBefore).join('\n');
    expect(added).toContain('T1');
    expect(added).toContain('停滞');
    expect(added).toContain('continue_task');
    expect(added).not.toContain('kind="taskFailed"');
  });

  it('未知のrun・未知のtaskIdでは何もしない', async () => {
    const { runner, codexHost } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/continue.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('maxReached', { ...initialChatState });
    await flush();

    expect(runner.continueTask('no-such-run', 'T1')).toBe(false);
    expect(runner.continueTask(runId, 'no-such-task')).toBe(false);
  });
});

describe('WorkflowRunner: オーケストレーターセッション（design.md §16.23）', () => {
  const YAML_ONE = `version: 1
name: orchestrator
tasks:
  - id: T1
    prompt: p
    done: d
`;

  it('run開始でタスクとは別に1つ開き、読み取り専用・ワークスペース直下で動かす', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();

    expect(codexHost.orchestratorSessions).toHaveLength(1);
    // 依存グラフのノードではないので、タスクのセッションには混ざらない
    expect(codexHost.sessions).toHaveLength(1);
    const session = codexHost.orchestratorSessions[0] as FakeTaskSession;
    // worktreeを作らず、メインのワークスペースで動かす
    expect(session.cwd).toBe('/repo');
  });

  it('allowAutoApproveが有効なら、オーケストレーターの承認要求を自動許可する', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE, { allowAutoApprove: true });
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();

    const session = codexHost.orchestratorSessions[0] as FakeTaskSession;
    const result = await session.requestApproval({
      requestId: 'orchestrator-read',
      kind: 'command',
      title: '',
      detail: '',
      itemId: undefined,
    });

    expect(result).toEqual({ kind: 'auto', decision: 'accept' });
    expect(
      session.mcpElicitationHandler?.({
        serverName: 'task-messaging',
        message: 'Allow the task-messaging MCP server to run tool "get_run_status"?',
      }),
    ).toBe(true);
    expect(
      session.mcpElicitationHandler?.({
        serverName: 'task-messaging',
        message: 'Allow the task-messaging MCP server to run tool "stop_task"?',
      }),
    ).toBe(false);
  });

  it('allowAutoApproveが無効なら、オーケストレーターの承認ハンドラを設定しない', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE, { allowAutoApprove: false });
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();

    const session = codexHost.orchestratorSessions[0] as FakeTaskSession;
    expect(session.approvalHandler).toBeUndefined();
  });

  it('run開始の通知を送る（役割と道具の説明つき）', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();

    const session = codexHost.orchestratorSessions[0] as FakeTaskSession;
    expect(session.sentTexts).toHaveLength(1);
    expect(session.sentTexts[0]).toContain('オーケストレーター');
    expect(session.sentTexts[0]).toContain('update_task_prompt');
    // ループは使わない（1回きりの送信だけ）
    expect(session.runLoopCalls).toHaveLength(0);
  });

  it(
    'ORCHESTRATOR_CONTROL_TOOLSの各ツールが道具の列挙行に1つずつ現れる（Issue #589、' +
      'decide_final_mergeだけが列挙から漏れていた。将来ツールを足したときに' +
      '案内文の更新漏れを機械で検出する）',
    async () => {
      const { runner, codexHost } = createHarness(YAML_ONE);
      await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
      await flush();

      const session = codexHost.orchestratorSessions[0] as FakeTaskSession;
      const introBody = session.sentTexts[0] as string;
      // 「- 」で始まる行だけを道具の列挙とみなす。`introBody`全体への`toContain`だと、
      // 拒否文等の散文でツール名に言及しているだけでも通ってしまい列挙漏れを見逃す
      // （この Issue の発端そのものが、ask_userの拒否文（375行目付近）では
      // decide_final_mergeに言及しているのに道具の列挙には無い、という食い違いだった）。
      const toolLines = introBody.split('\n').filter((line) => line.startsWith('- '));

      for (const tool of ORCHESTRATOR_CONTROL_TOOLS) {
        expect(
          toolLines.some((line) => line.includes(tool.name)),
          `道具の列挙行に${tool.name}が無い`,
        ).toBe(true);
      }
    },
  );

  it('タスクが完了すると通知が届き、run終了ではセッションを解放しない', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
    // run開始の通知でターンが走っている。走行中は割り込まないので、まず終わらせる
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });
    const sentBefore = orchestrator.sentTexts.length;

    (codexHost.sessions[0] as FakeTaskSession).finish('done', doneState('ok'));
    await flush();

    const added = orchestrator.sentTexts.slice(sentBefore).join('\n');
    expect(added).toContain('T1');
    expect(added).toContain('完了');

    // run終了の通知は、この送信で始まったターンが終わるまで溜まる（割り込まない）
    orchestrator.emitState({ ...initialChatState, busy: true });
    orchestrator.emitState({ ...initialChatState, busy: false });
    const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
    expect(last).toContain('実行が終了しました');
    expect(last).toContain('もう使えません');
    // runが終わってもセッションは解放しない（design.md §16.23「セッションの生成と寿命」）
    expect(orchestrator.disposed).toBe(false);
  });

  it('人の発話を送れる。セッションが無ければfalseを返す', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    const result = await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

    expect(runner.sendToOrchestrator(runId, '進捗を教えて')).toBe(true);
    expect(orchestrator.sentTexts[orchestrator.sentTexts.length - 1]).toBe('進捗を教えて');
    // 空文字は送らない
    expect(runner.sendToOrchestrator(runId, '   ')).toBe(false);
    expect(runner.sendToOrchestrator('unknown-run', 'x')).toBe(false);
  });

  it('dispose()でオーケストレーターセッションを解放する（design.md §16.23「セッションの生成と寿命」。Issue #363: 拡張機能のdeactivate時にextension.tsがcontext.subscriptionsへ登録して呼び出す）', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

    expect(orchestrator.disposed).toBe(false);
    runner.dispose();
    expect(orchestrator.disposed).toBe(true);

    // 二重に呼ばれても安全（自己レビュー観点）。既にorchestratorはundefinedに
    // 戻っているため、2回目は何もせず例外も投げない
    expect(() => runner.dispose()).not.toThrow();
  });

  it('セッションを開けなくても実行は止まらず、警告欄に出る', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    codexHost.rejectOrchestrator = new Error('CLIが見つかりません');

    const result = await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(codexHost.sessions).toHaveLength(1);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.warnings.some((w) => w.kind === 'orchestratorUnavailable')).toBe(true);
    expect(runner.sendToOrchestrator(runId, 'x')).toBe(false);
  });

  it('スナップショットにオーケストレーター欄の値が載る（応答本文は載らない）', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    const result = await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

    // run開始の通知でターンが走っている
    orchestrator.emitState({ ...initialChatState, busy: true });
    expect(runner.getSnapshot(runId)?.orchestrator).toMatchObject({
      available: true,
      provider: 'codex',
      busy: true,
    });

    // ターンが終わると要約が入り、未読が増える
    orchestrator.emitState({ ...doneState('方針を確認しました'), busy: false });
    const after = runner.getSnapshot(runId)?.orchestrator;
    expect(after?.busy).toBe(false);
    expect(after?.lastResponseSummary).toContain('方針');
    expect(after?.unreadCount).toBeGreaterThan(0);

    // 会話を開くと未読が消える
    expect(runner.revealOrchestrator(runId)).toBe(true);
    expect(runner.getSnapshot(runId)?.orchestrator?.unreadCount).toBe(0);
  });

  it('セッションを開けなかったrunの欄はavailable: falseになる', async () => {
    const { runner, codexHost } = createHarness(YAML_ONE);
    codexHost.rejectOrchestrator = new Error('CLIが見つかりません');
    const result = await runner.start('/repo/.agents/workflows/o.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(runner.getSnapshot(runId)?.orchestrator).toEqual({
      available: false,
      busy: false,
      lastResponseSummary: '',
      unreadCount: 0,
    });
    expect(runner.revealOrchestrator(runId)).toBe(false);
  });
});
describe('WorkflowRunner: オーケストレーターの制御ツール（design.md §16.23「道具」）', () => {
  const TWO_TASK_YAML = `
version: 1
name: control-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    continuePrompt: c1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  /** 制御ツールの実体（オーケストレーター専用接続に見せているもの）を取り出す。 */
  function control(state: FakeMessagingState): OrchestratorControlPort {
    const port = state.hub?.orchestratorControl;
    if (port === undefined) {
      throw new Error('制御ツールが配線されていません');
    }
    return port;
  }

  it('get_run_statusはタスクの状態と警告を返し、プロンプトの全文は含めない', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();
    codexHost.byTaskId('T1');

    const status = control(state).getRunStatus() as {
      name: string;
      tasks: { id: string; state: string }[];
      warnings: unknown[];
      integration: Record<string, unknown>;
    };

    expect(status.name).toBe('control-test');
    expect(status.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
    expect(status.tasks.every((t) => t.state === 'running')).toBe(true);
    expect(JSON.stringify(status)).not.toContain('p1');
    expect(status.integration).toBeDefined();
  });

  it('stop_taskは走行中タスクのループを止め、存在しないidは理由付きで拒否する', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();

    const accepted = control(state).stopTask('T1');
    const rejected = control(state).stopTask('T9');

    expect(accepted.accepted).toBe(true);
    expect(codexHost.byTaskId('T1').stopLoopCount).toBe(1);
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain('T9');
  });

  /**
   * 対象タスクの状態は分かる（`runState.tasks`には居る）が、止める先のセッションが
   * `live.tasks`にも`live.mergeResolutions`にも無い場合の回帰テスト（issue #514）。
   *
   * 修正前は`WorkflowRunner.stopTask`が`void`を返すため、`runnerOrchestrator.ts`は
   * 「タスクが見つかりません」（未知のid）以外は無条件で成功（`ok(...)`）を返していた。
   * 依存未達でまだ`pending`のタスクは、id自体は`runState`にあるためこの早期拒否には
   * 引っかからず、旧実装なら誤って成功を返してしまうケースだった。
   */
  it('stop_taskは送り先のセッションが無いタスクにはno(...)を返す（issue #514）', async () => {
    const DEPENDENT_YAML = `
version: 1
name: control-no-destination-test
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(DEPENDENT_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control-no-destination.yaml', '/repo');
    await flush();

    // T2はT1に依存しているためまだpending。runStateには居るが、live.tasks /
    // live.mergeResolutionsのどちらにもセッションが無い
    const rejected = control(state).stopTask('T2');

    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain('T2');
  });

  /**
   * 「見つからない」と「届いたが既に終わっていた」を同じ文言で返していた欠陥の回帰
   * テスト（issue #514 medium指摘）。
   *
   * 実際の`LoopController.stop()`（`loopController.ts`）は、既に止まっている
   * （`!this.status.running`）ループへの呼び出しに`false`を返す。`done`になった
   * タスクの`live.tasks`エントリは`onTaskFinished`後も消えないため
   * （`WorkflowRunner.stopTask`のJSDoc参照）、`stopTask`はセッションを見つけたうえで
   * この`false`を受け取る。これは「対象のループが見つかりません」（送り先自体が無い）
   * とは別の状況であり、`hasStoppableSession`で判定を分ける。
   *
   * このテストのフェイクセッション（`FakeTaskSession`）は`stopLoop()`が常に`true`を
   * 返す簡略実装のため、`stopLoopReturns = false`で実際の`LoopController`の
   * 「既に止まっている」応答を模してから検証する（送り先（セッション）自体は
   * `live.tasks`に存在し続けている点は変えない）。
   */
  it('stop_taskは届いたが既に止まっていたタスクには「見つからない」と別の文言でno(...)を返す（issue #514 medium指摘）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.stopLoopReturns = false;
    expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');

    const rejected = control(state).stopTask('T1');

    expect(rejected.accepted).toBe(false);
    // 「見つかりません」ではなく「既に停止しています」であることを確認する。
    // 誤診（実際には届いていたのに「届いていない」と伝える）を防ぐのが目的
    expect(rejected.reason).not.toContain('見つかりません');
    expect(rejected.reason).toContain('既に停止しています');
  });

  it('continue_taskは止まっているタスクを続きから走らせる', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    // `continueTask`が受け付けるのは`failed`かつ`failure.kind === 'maxReached'`だけ
    // （`runState.ts`の`continueTask`）。送信回数を使い切った状態を作る
    t1.finish('maxReached', { ...initialChatState });
    await flush();

    const before = t1.runLoopCalls.length;
    const outcome = control(state).continueTask('T1');

    expect(outcome.accepted).toBe(true);
    expect(t1.runLoopCalls.length).toBe(before + 1);
    expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');
  });

  describe('人が「全体の停止」を押した後は再開できない（Issue #401）', () => {
    const THREE_TASK_YAML = `
version: 1
name: control-halt-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
  - id: T3
    prompt: p3
    done: d3
`;

    const SINGLE_TASK_HALT_YAML = `
version: 1
name: control-final-merge-halt-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

    it('retry_taskは停止直後（走行中タスクが残りoutcomeがrunningのまま）でもhaltedByUserを解除しない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(THREE_TASK_YAML, {
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // maxParallel=2なのでT1・T2が走り出し、T3はpendingのまま
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T3')?.state).toBe('pending');

      runner.stop(runId);
      await flush();

      // T1・T2はまだ進行中のターンが終わっていないためrunningのまま残る
      // （stop()は割り込まない）。この窓でoutcomeは'running'のまま
      expect(runner.getSnapshot(runId)?.outcome).toBe('running');
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T3')?.state).toBe('skipped');

      const sessionsBefore = codexHost.sessions.length;
      const outcome = control(state).retryTask('T3');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('人がこの実行全体を停止しました');
      // haltedByUserは解除されず、T3も再開されない（嘘の成功を返さない）
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T3')?.state).toBe('skipped');
      expect(codexHost.sessions.length).toBe(sessionsBefore);
    });

    it('continue_taskは停止直後でもhaltedByUserを解除せず、スケジューラを迂回して再開しない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // T1を回数切れ（maxReached）で先にfailedへ確定させる。T2は走行中のまま残す
      const t1 = codexHost.byTaskId('T1');
      t1.finish('maxReached', { ...initialChatState });
      await flush();
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('failed');

      runner.stop(runId);
      await flush();

      // T2はまだ進行中のターンが終わっていないためrunningのまま残り、outcomeは'running'
      expect(runner.getSnapshot(runId)?.outcome).toBe('running');
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);

      const before = t1.runLoopCalls.length;
      const outcome = control(state).continueTask('T1');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('人がこの実行全体を停止しました');
      // `continueTask`はスケジューラ（`nextTasksToStart`）を通らず直接runningへ倒すため、
      // ここで拒否できていないと`isRunHalted`のガードも無関係に再開してしまう
      expect(t1.runLoopCalls.length).toBe(before);
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('failed');
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);
    });

    it('decide_approvalも停止直後は拒否する', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(THREE_TASK_YAML, {
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      void t1.requestApproval({
        requestId: 1,
        kind: 'execCommand',
        title: 'rm -rf',
        detail: '',
        itemId: 'item-1',
      });
      await flush();

      runner.stop(runId);
      await flush();

      const outcome = control(state).decideApproval('T1', 'accept');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('人がこの実行全体を停止しました');
    });

    it('update_task_promptも停止直後は拒否し、継続指示を差し替えない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      runner.stop(runId);
      await flush();

      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);

      const t1 = codexHost.byTaskId('T1');
      const outcome = control(state).updateTaskPrompt('T1', 'これからは設計だけをやること');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('人がこの実行全体を停止しました');
      // 差し替えは反映されない（`promptTransform`は通常どおりテンプレート展開のままで、
      // 拒否した差し替え文へは置き換わらない）。警告欄にも積まれない
      expect(t1.promptTransform?.('これは通常の継続文')).toBe('これは通常の継続文');
      const warning = runner
        .getSnapshot(runId)
        ?.warnings.find((w) => w.kind === 'orchestratorPromptOverride');
      expect(warning).toBeUndefined();
    });

    it('人がワークフローViewから押す再実行（WorkflowRunner.retryTaskの直接呼び出し）は停止後も引き続き機能する', async () => {
      const { runner, codexHost, store } = createHarness(THREE_TASK_YAML);
      const result = await runner.start('/repo/.agents/workflows/control-view.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      runner.stop(runId);
      await flush();
      expect(store.find(runId)?.tasks['T3']?.state).toBe('skipped');
      expect(store.find(runId)?.haltedByUser).toBe(true);

      // ガードは制御ポート層（オーケストレーター専用の接続）にだけ置かれているため、
      // Viewのボタンが呼ぶ`WorkflowRunner.retryTask`の直接呼び出しは変わらず機能する
      const outcome = runner.retryTask(runId, 'T3');
      await flush();

      expect(outcome).toEqual({ ok: true });
      expect(store.find(runId)?.tasks['T3']?.state).toBe('pending');
      expect(store.find(runId)?.haltedByUser).toBe(false);
      void codexHost;
    });

    it('1件失敗しただけの通常運転（人の停止ではない）では、オーケストレーターのretry_taskは死なない（isRunHalted誤用への回帰防止）', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // T1だけが通常の失敗で確定する（stop()は呼ばない）。T2は走行中のまま
      const t1 = codexHost.byTaskId('T1');
      t1.finish('failed', { ...initialChatState, turnFailed: true });
      await flush();

      // haltedByUserは立っていない（人は停止していない）が、`isRunHalted`は
      // `hasFailedTask`により真になる。ガードは`haltedByUser`だけを見るべきで、
      // `isRunHalted`を使うとここで誤って拒否してしまう
      expect(runner.getSnapshot(runId)?.haltedByUser).toBe(false);

      const outcome = control(state).retryTask('T1');

      expect(outcome.accepted).toBe(true);
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');
    });

    it(
      'decide_final_mergeも停止直後は拒否する（design.md §16.26、レビュー指摘。' +
        '他の判断系制御ツールと同じくhaltedByUserを見る）',
      async () => {
        const git = fakeGit({
          originRemoteUrl: 'git@github.com:acme/repo.git',
          headBranch: 'main',
        });
        const cli = fakeForgeCli();
        const { deps, state } = fakeMessagingDeps();
        const { runner, codexHost } = createHarness(SINGLE_TASK_HALT_YAML, {
          git,
          forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
          messaging: deps,
        });
        const result = await runner.start(
          '/repo/.agents/workflows/control-final-merge.yaml',
          '/repo',
        );
        const runId = result.runId as string;
        await flush();

        codexHost.byTaskId('T1').finish('done', doneState('ok'));
        await flush();
        expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({
          mode: 'orchestrator',
        });

        runner.stop(runId);
        await flush();
        expect(runner.getSnapshot(runId)?.haltedByUser).toBe(true);

        const outcome = control(state).decideFinalMerge('merge', 'stop後にマージを試みる');

        expect(outcome.accepted).toBe(false);
        expect(outcome.reason).toContain('人がこの実行全体を停止しました');
        expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      },
    );
  });

  it('decide_approvalはacceptとdeclineだけを受け付ける（セッション全体への承認は選べない）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    void t1.requestApproval({
      requestId: 7,
      kind: 'execCommand',
      title: 'rm -rf',
      detail: '',
      itemId: 'item-1',
    });
    await flush();

    const widened = control(state).decideApproval('T1', 'acceptForSession');
    const accepted = control(state).decideApproval('T1', 'accept');

    expect(widened.accepted).toBe(false);
    expect(accepted.accepted).toBe(true);
    expect(t1.decideApprovalCalls).toEqual([{ requestId: 7, decision: 'accept' }]);
  });

  it('run終了後の制御ツールは理由付きで拒否され、get_run_statusだけは答え続ける', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok1'));
    codexHost.byTaskId('T2').finish('done', doneState('ok2'));
    await flush();
    expect(runner.getSnapshot(runId)?.outcome).not.toBe('running');

    // 会話は続けられるが、動かす対象がもう無いので制御ツールだけが無効になる
    // （design.md §16.23「run終了後の制御ツールは無効。過去のrunを後から動かす経路は
    // 作らない」）。理由を返すのは、モデルが使えないツールを呼び続けないようにするため
    const port = control(state);
    for (const outcome of [
      port.stopTask('T1'),
      port.retryTask('T1'),
      port.continueTask('T1'),
      port.decideApproval('T1', 'accept'),
      port.updateTaskPrompt('T1', '以降はこの方針で'),
    ]) {
      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('終了');
    }

    // 「なぜ失敗したのか」を走り終えた後に聞く経路は残す
    const status = port.getRunStatus() as { tasks: { id: string }[] };
    expect(status.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
    // 会話そのものは続けられる
    expect(runner.sendToOrchestrator(runId, 'なぜT1は時間がかかったの？')).toBe(true);
  });

  it('update_task_promptは以降の送信本文を差し替え、警告欄へ出す', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const outcome = control(state).updateTaskPrompt('T1', 'これからは設計だけをやること');

    expect(outcome.accepted).toBe(true);
    const t1 = codexHost.byTaskId('T1');
    expect(t1.promptTransform?.('c1')).toBe('これからは設計だけをやること');
    const warning = runner
      .getSnapshot(runId)
      ?.warnings.find((w) => w.kind === 'orchestratorPromptOverride');
    expect(warning?.taskId).toBe('T1');
    expect(warning?.message).toContain('これからは設計だけをやること');
  });

  it('update_task_promptは同一taskIdへの複数回の差し替えでも警告が無制限に増えない（Issue #366）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const port = control(state);
    for (let i = 0; i < 5; i += 1) {
      const outcome = port.updateTaskPrompt('T1', `方針転換その${i}`);
      expect(outcome.accepted).toBe(true);
    }

    const warnings = runner
      .getSnapshot(runId)
      ?.warnings.filter((w) => w.kind === 'orchestratorPromptOverride');
    // 直近1件へ丸められるため、5回呼んでも件数は増えない
    expect(warnings).toHaveLength(1);
    // 警告が出た事実自体は失われず、最新の差し替え内容が残っている
    expect(warnings?.[0]?.taskId).toBe('T1');
    expect(warnings?.[0]?.message).toContain('方針転換その4');
  });

  it('update_task_promptはテンプレート変数を展開しない（リテラルとして送る）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();

    control(state).updateTaskPrompt('T2', 'T1の結果は {{T1.result}} を見よ');

    expect(codexHost.byTaskId('T2').promptTransform?.('c2')).toBe(
      'T1の結果は {{T1.result}} を見よ',
    );
  });

  it('update_task_promptは上限超過と空文字を受付自体で拒否する', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(TWO_TASK_YAML, {
      messaging: deps,
    });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();

    const tooLong = control(state).updateTaskPrompt('T1', 'あ'.repeat(4001));
    const empty = control(state).updateTaskPrompt('T1', '   ');

    expect(tooLong.accepted).toBe(false);
    expect(tooLong.reason).toContain('4000');
    expect(empty.accepted).toBe(false);
    // 拒否されたので差し替わっていない
    expect(codexHost.byTaskId('T1').promptTransform?.('c1')).toBe('c1');
  });

  it('セッションが無いタスク（開始前・終了後）の差し替えは拒否する', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/control.yaml', '/repo');
    await flush();

    const outcome = control(state).updateTaskPrompt('T9', '方針転換');

    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toContain('T9');
  });
});

describe(
  'WorkflowRunner: add_task / remove_task / update_task_dependencies' +
    '（design.md §16.29、roadmap W4、Issue #338）',
  () => {
    const TWO_TASK_YAML = `
version: 1
name: task-edit-test
defaults:
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    continuePrompt: c1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

    /** T1が走行中のまま、T2がT3へ依存し、T3は独立しているがmaxParallelの空きが無くpendingで残るYAML。 */
    const PENDING_DEPENDENT_YAML = `
version: 1
name: task-edit-remove-test
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T3]
    prompt: p2
    done: d2
  - id: T3
    prompt: p3
    done: d3
`;

    /**
     * 削除対象（T3）を`dependsOn`に持ち、かつその成果をテンプレート変数で参照している
     * タスク（T2）を含む定義（Issue #764）。`remove_task`が検証を挟まないと、T2の
     * `{{T3.cwd}}`が空文字へ展開されたまま走ってしまう。
     */
    const TEMPLATE_REF_YAML = `
version: 1
name: task-remove-template-ref-test
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    dependsOn: [T3]
    prompt: "p2 {{T3.cwd}}"
    done: d2
  - id: T3
    prompt: p3
    done: d3
`;

    /** 制御ツールの実体（オーケストレーター専用接続に見せているもの）を取り出す。 */
    function control(state: FakeMessagingState): OrchestratorControlPort {
      const port = state.hub?.orchestratorControl;
      if (port === undefined) {
        throw new Error('制御ツールが配線されていません');
      }
      return port;
    }

    it('add_taskでタスクが増え、依存グラフとタスク一覧に反映される', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const outcome = control(state).addTask({
        id: 'T3',
        prompt: 'p3',
        done: 'd3',
        dependsOn: ['T1'],
      });

      expect(outcome.accepted).toBe(true);
      const snapshot = runner.getSnapshot(runId);
      const t3 = snapshot?.tasks.find((t) => t.id === 'T3');
      expect(t3).toBeDefined();
      expect(t3?.dependsOn).toEqual(['T1']);
      expect(t3?.state).toBe('pending');
      expect(snapshot?.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2', 'T3']);
    });

    it('add_taskは実行中の定義（メモリ）だけへ適用し、永続化した定義には書き込まない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      control(state).addTask({ id: 'T3', prompt: 'p3', done: 'd3', dependsOn: [] });

      expect(store.find(runId)?.tasks['T3']).toBeUndefined();
    });

    it('add_taskは循環依存になる追加を適用前に拒否し、理由を返す', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const outcome = control(state).addTask({
        id: 'T3',
        prompt: 'p3',
        done: 'd3',
        dependsOn: ['T3'],
      });

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('循環');
      expect(
        runner
          .getSnapshot(runId)
          ?.tasks.map((t) => t.id)
          .sort(),
      ).toEqual(['T1', 'T2']);
    });

    it('add_taskは上限件数を超える追加を適用前に拒否する', async () => {
      const manyTasks = Array.from(
        { length: 50 },
        (_, i) => `  - id: T${i + 1}\n    prompt: p\n    done: d\n`,
      ).join('');
      const FULL_YAML = `version: 1\nname: full-test\ndefaults:\n  maxParallel: 5\ntasks:\n${manyTasks}`;
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(FULL_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/full.yaml', '/repo');
      await flush();

      const outcome = control(state).addTask({
        id: 'T51',
        prompt: 'p51',
        done: 'd51',
        dependsOn: [],
      });

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('上限');
    });

    it('add_taskはautoApprove/allow/sandbox/approvalModeを指定できず、指定すると拒否される', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const autoApprove = control(state).addTask({
        id: 'T3',
        prompt: 'p3',
        done: 'd3',
        dependsOn: [],
        autoApprove: true,
      });
      const allow = control(state).addTask({
        id: 'T4',
        prompt: 'p4',
        done: 'd4',
        dependsOn: [],
        allow: ['危険なコマンド'],
      });
      const sandbox = control(state).addTask({
        id: 'T5',
        prompt: 'p5',
        done: 'd5',
        dependsOn: [],
        sandbox: 'danger-full-access',
      });
      const approvalMode = control(state).addTask({
        id: 'T6',
        prompt: 'p6',
        done: 'd6',
        dependsOn: [],
        approvalMode: 'never',
      });

      expect(autoApprove.accepted).toBe(false);
      expect(autoApprove.reason).toContain('autoApprove');
      expect(allow.accepted).toBe(false);
      expect(allow.reason).toContain('allow');
      expect(sandbox.accepted).toBe(false);
      expect(sandbox.reason).toContain('sandbox');
      expect(approvalMode.accepted).toBe(false);
      expect(approvalMode.reason).toContain('approvalMode');
      // どれも適用されていない
      expect(
        runner
          .getSnapshot(runId)
          ?.tasks.map((t) => t.id)
          .sort(),
      ).toEqual(['T1', 'T2']);
    });

    it('add_taskは適用した内容を全文でワークフローViewの警告欄へ残す', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const longPrompt = 'この指示を実施してください。'.repeat(20);
      control(state).addTask({
        id: 'T3',
        prompt: longPrompt,
        done: 'テストが通ること',
        dependsOn: ['T1', 'T2'],
      });

      const warning = runner
        .getSnapshot(runId)
        ?.warnings.find((w) => w.kind === 'orchestratorTaskAdded');
      expect(warning?.taskId).toBe('T3');
      expect(warning?.message).toContain(longPrompt);
      expect(warning?.message).toContain('テストが通ること');
      expect(warning?.message).toContain('T1, T2');
    });

    it('remove_taskは走行中のタスクを拒否する（stop_taskを使わせる）', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');
      const outcome = control(state).removeTask('T1');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('stop_task');
      expect(
        runner
          .getSnapshot(runId)
          ?.tasks.map((t) => t.id)
          .sort(),
      ).toEqual(['T1', 'T2']);
    });

    it(
      'remove_taskはpendingのタスクを取り除き、依存していたタスクのdependsOnからも' +
        '取り除いて孤立させない',
      async () => {
        const { deps, state } = fakeMessagingDeps();
        const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
        const result = await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const before = runner.getSnapshot(runId);
        expect(before?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');
        expect(before?.tasks.find((t) => t.id === 'T3')?.state).toBe('pending');

        const outcome = control(state).removeTask('T3');

        expect(outcome.accepted).toBe(true);
        const after = runner.getSnapshot(runId);
        expect(after?.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
        const t2 = after?.tasks.find((t) => t.id === 'T2');
        expect(t2?.dependsOn).toEqual([]);

        const warning = after?.warnings.find((w) => w.kind === 'orchestratorTaskRemoved');
        expect(warning?.taskId).toBe('T3');
        expect(warning?.message).toContain('T2');
      },
    );

    it('remove_taskは存在しないidを理由付きで拒否する', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      await flush();

      const outcome = control(state).removeTask('T9');

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('T9');
    });

    it(
      'remove_taskは、削除で宙に浮くテンプレート参照が残る場合を理由付きで拒否し、' +
        '定義も状態も書き換えない（Issue #764）',
      async () => {
        const { deps, state } = fakeMessagingDeps();
        const { runner } = createHarness(TEMPLATE_REF_YAML, { messaging: deps });
        const result = await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        const outcome = control(state).removeTask('T3');

        expect(outcome.accepted).toBe(false);
        expect(outcome.reason).toContain('{{T3.cwd}}');

        // 部分適用が残っていないこと（T3は消えず、T2のdependsOnも剥がされていない）
        const after = runner.getSnapshot(runId);
        expect(after?.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2', 'T3']);
        expect(after?.tasks.find((t) => t.id === 'T2')?.dependsOn).toEqual(['T3']);
        expect(after?.warnings.some((w) => w.kind === 'orchestratorTaskRemoved')).toBe(false);
      },
    );

    it('同一taskIdへのupdate_task_dependenciesの警告は直近1件へ丸める（Issue #765）', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      expect(control(state).updateTaskDependencies('T2', []).accepted).toBe(true);
      expect(control(state).updateTaskDependencies('T2', ['T3']).accepted).toBe(true);
      expect(control(state).updateTaskDependencies('T2', []).accepted).toBe(true);

      const warnings = runner
        .getSnapshot(runId)
        ?.warnings.filter((w) => w.kind === 'orchestratorDependenciesChanged');
      expect(warnings?.length).toBe(1);
      // 残るのは最新の1件（直前は[T3]、変更後は空）
      expect(warnings?.[0]?.message).toContain('変更前: T3 → 変更後: (なし)');
    });

    it('add_task/remove_taskの履歴警告は上限で古い順に落とし、落とした事実を残す（Issue #765）', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(TWO_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // 追加と削除を繰り返す（1周で履歴警告が2件積まれる）
      for (let i = 0; i < 40; i += 1) {
        const added = control(state).addTask({
          id: `X${i}`,
          prompt: `p${i}`,
          done: `d${i}`,
        });
        expect(added.accepted).toBe(true);
        expect(control(state).removeTask(`X${i}`).accepted).toBe(true);
      }

      const warnings = runner.getSnapshot(runId)?.warnings ?? [];
      const history = warnings.filter(
        (w) => w.kind === 'orchestratorTaskAdded' || w.kind === 'orchestratorTaskRemoved',
      );
      expect(history.length).toBe(50);
      // 落ちたのは古い方（最後の追加・削除は残っている）
      expect(history.some((w) => w.taskId === 'X39')).toBe(true);
      expect(history.some((w) => w.taskId === 'X0')).toBe(false);

      const trimmed = warnings.filter((w) => w.kind === 'orchestratorPlanHistoryTrimmed');
      expect(trimmed.length).toBe(1);
    });

    it('update_task_dependenciesはpendingでないタスクへの変更を拒否する', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
      await flush();

      const outcome = control(state).updateTaskDependencies('T1', []);

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('running');
    });

    it('update_task_dependenciesは循環依存になる変更を適用前に拒否する', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      // T2はT3へ依存している。T3の依存へT2を足すと循環になる
      const outcome = control(state).updateTaskDependencies('T3', ['T2']);

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('循環');
      expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T3')?.dependsOn).toEqual([]);
    });

    it('update_task_dependenciesは依存を差し替え、警告欄へ変更前後を全文残す', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const outcome = control(state).updateTaskDependencies('T3', ['T1']);

      expect(outcome.accepted).toBe(true);
      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.tasks.find((t) => t.id === 'T3')?.dependsOn).toEqual(['T1']);
      const warning = snapshot?.warnings.find((w) => w.kind === 'orchestratorDependenciesChanged');
      expect(warning?.taskId).toBe('T3');
      expect(warning?.message).toContain('変更前: (なし)');
      expect(warning?.message).toContain('変更後: T1');
    });

    it('update_task_dependenciesは未定義のidへの参照を適用前に拒否する', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner } = createHarness(PENDING_DEPENDENT_YAML, { messaging: deps });
      await runner.start('/repo/.agents/workflows/pending.yaml', '/repo');
      await flush();

      const outcome = control(state).updateTaskDependencies('T3', ['T9']);

      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toContain('T9');
    });

    it(
      'リロード後、add_taskで足したタスクの永続状態は定義（YAML）に無ければ落とされ、' +
        'runが完走できる（レビューblocking指摘、2026-08-23。§16.29「どの経路からもpersist' +
        'を呼ばない」はlive.defには成り立つが、live.runStateは他の経路のpersistで永続化される）',
      async () => {
        const { deps, state } = fakeMessagingDeps();
        const { runner, codexHost, store } = createHarness(TWO_TASK_YAML, { messaging: deps });
        const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        control(state).addTask({ id: 'T3', prompt: 'p3', done: 'd3', dependsOn: [] });

        // T1・T2・T3のいずれかが完了すると、その経路のpersist()がlive.runState.tasksを
        // 丸ごと書き出す。add_task自身はpersistを呼ばないが、この持続化でT3のidが
        // 永続データへ入る（レビュー指摘の核心）
        // TWO_TASK_YAMLのmaxParallelは2で、T1・T2が既にその枠を使い切っているため、
        // 追加したT3は空き枠が出るまでpendingのまま（`nextTasksToStart`のcapacity判定）。
        // T1・T2を終わらせてpersist()させた後、T3がpendingのまま永続データへ入っていた
        // 瞬間（capacityが空く直前）を模すため、T3の永続状態を直接差し込む
        // （T3自身が実際に走り出すタイミングとは切り離し、「追加した直後にpersistが
        // 走った」という事実だけを再現する）
        const t1 = codexHost.byTaskId('T1');
        t1.finish('done', doneState('T1の応答'));
        const t2 = codexHost.byTaskId('T2');
        t2.finish('done', doneState('T2の応答'));
        await flush();

        expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
        expect(store.find(runId)?.tasks['T2']?.state).toBe('done');

        await store.update(runId, (current) => {
          if (current === undefined) {
            throw new Error('persisted run not found');
          }
          const t1 = current.tasks['T1'];
          if (t1 === undefined) {
            throw new Error('T1 not found in persisted run');
          }
          return {
            ...current,
            tasks: {
              ...current.tasks,
              T3: {
                ...t1,
                state: 'pending',
                submissionCount: 0,
                retryCount: 0,
                manualRetryCount: 0,
                failure: undefined,
                sessionId: undefined,
                cwd: undefined,
                branch: undefined,
                pullRequestNumber: undefined,
                pullRequestUrl: undefined,
              },
            },
          };
        });

        expect(store.find(runId)?.tasks['T3']?.state).toBe('pending');

        // 新しいプロセス（リロード後）を模す。定義ファイルは元のTWO_TASK_YAML
        // （add_taskで足したT3を含まない）のまま
        const reloadedRunner = new WorkflowRunner({
          readAutoResume: () => false,
          hosts: { codex: new FakeHost(), claude: new FakeHost() },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit(),
          fs: identityFs,
          filePort: filePort(TWO_TASK_YAML),
          store,
          log: fakeLogger,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        const snapshot = reloadedRunner.getSnapshot(runId);
        // 定義に無いT3はタスク一覧に出ない（YAML本来の2件だけに戻る）
        expect(snapshot?.tasks.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
        // T1・T2はどちらもdoneのため、runは完走（succeeded）として扱えるはず
        expect(snapshot?.outcome).toBe('succeeded');
      },
    );

    it(
      'リロード後、remove_taskで消したタスクが定義（YAML）に残っていれば、' +
        'pendingとして復元され直す（レビューblocking指摘、2026-08-23。消したまま定義に残る' +
        'タスクを黙って無視すると、一度も走っていないタスクがあるのにrunが完走扱いになりうる）',
      async () => {
        // maxParallel: 1にして、T1が走行中の間はT2がpendingのまま残るようにする
        // （TWO_TASK_YAMLのmaxParallel: 2だと両方すぐ走り始め、pendingのタスクを
        // 用意できない）
        const ONE_AT_A_TIME_YAML = `
version: 1
name: task-edit-remove-reload-test
defaults:
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
        const { deps, state } = fakeMessagingDeps();
        const { runner, codexHost, store } = createHarness(ONE_AT_A_TIME_YAML, {
          messaging: deps,
        });
        const result = await runner.start('/repo/.agents/workflows/edit.yaml', '/repo');
        const runId = result.runId as string;
        await flush();

        // T2はpendingのまま（maxParallel: 1でT1が枠を使い切っているため）
        expect(runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T2')?.state).toBe('pending');
        const removeOutcome = control(state).removeTask('T2');
        expect(removeOutcome.accepted).toBe(true);

        const t1 = codexHost.byTaskId('T1');
        t1.finish('done', doneState('T1の応答'));
        await flush();

        // 永続データにT2は無い（remove_task後にpersistされたため）
        expect(store.find(runId)?.tasks['T2']).toBeUndefined();

        // 新しいプロセス（リロード後）を模す。定義ファイルは元のONE_AT_A_TIME_YAML
        // （remove_taskで消したT2を含む）のまま
        const reloadedRunner = new WorkflowRunner({
          readAutoResume: () => false,
          hosts: { codex: new FakeHost(), claude: new FakeHost() },
          worktreeQueue: new WorktreeCreationQueue(),
          git: fakeGit(),
          fs: identityFs,
          filePort: filePort(ONE_AT_A_TIME_YAML),
          store,
          log: fakeLogger,
          readBaseline: () => ({
            codexSandbox: 'read-only',
            codexApprovalMode: 'on-request',
            claudePermissionMode: 'manual',
            allowAutoApprove: true,
            allowClaudeBypassPermissions: false,
          }),
        });
        await reloadedRunner.restoreRunsForView();

        const snapshot = reloadedRunner.getSnapshot(runId);
        // T2が定義どおりタスク一覧に戻り、pendingとして数えられる（完走扱いにしない）
        const t2Snapshot = snapshot?.tasks.find((t) => t.id === 'T2');
        expect(t2Snapshot).toBeDefined();
        expect(t2Snapshot?.state).toBe('pending');
        expect(snapshot?.outcome).toBe('running');
      },
    );
  },
);

describe('WorkflowRunner: ask_user（design.md §16.33、Issue #583）', () => {
  const YAML_ONE = `version: 1
name: ask-user-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

  /** 制御ツールの実体（オーケストレーター専用接続に見せているもの）を取り出す。 */
  function control(state: FakeMessagingState): OrchestratorControlPort {
    const port = state.hub?.orchestratorControl;
    if (port === undefined) {
      throw new Error('制御ツールが配線されていません');
    }
    return port;
  }

  it('ask_userを呼ぶと問いをスナップショットへ載せ、受け付ける（本番と同じくrun開始の通知でbusyのまま呼ぶ）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(YAML_ONE, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    // ask_userはオーケストレーターのターンの最中に呼ばれる。run開始の通知（flushOrchestrator）で
    // 既にbusy: trueのはずで、ここでは明示的にbusyを崩さない
    expect(runner.getSnapshot(runId)?.orchestrator?.busy).toBe(true);

    const outcome = control(state).askUser('どちらへ進める？', ['A案', 'B案']);

    expect(outcome.accepted).toBe(true);
    expect(runner.getSnapshot(runId)?.pendingAskUser).toMatchObject({
      question: 'どちらへ進める？',
      choices: ['A案', 'B案'],
      hasLiveSession: true,
    });
  });

  it('回答待ちの間に次のask_userを呼ぶと拒否する（人が答えるまで1問だけ）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(YAML_ONE, { messaging: deps });
    await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    await flush();

    control(state).askUser('問1', ['A', 'B']);
    const second = control(state).askUser('問2', ['C', 'D']);

    expect(second.accepted).toBe(false);
    expect(second.reason).toContain('既に回答待ちの質問があります');
  });

  it('questionが空・choicesが2〜4個の範囲外なら拒否する（機械的な形式検証のみ）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(YAML_ONE, { messaging: deps });
    await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    await flush();

    const empty = control(state).askUser('   ', ['A', 'B']);
    const tooFew = control(state).askUser('問い', ['A']);
    const tooMany = control(state).askUser('問い', ['A', 'B', 'C', 'D', 'E']);

    expect(empty.accepted).toBe(false);
    expect(empty.reason).toContain('空です');
    expect(tooFew.accepted).toBe(false);
    expect(tooFew.reason).toContain('2〜4個');
    expect(tooMany.accepted).toBe(false);
    expect(tooMany.reason).toContain('2〜4個');
  });

  it(
    `既定では1runにつき${DEFAULT_MAX_ASK_USER_PER_RUN}回まで呼べ、超えると拒否し` +
      '自己判断かdecide_final_mergeのholdを促す（design.md §16.33「確認を絞る」）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(YAML_ONE, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

      const outcomes: OrchestratorControlResult[] = [];
      for (let i = 0; i < DEFAULT_MAX_ASK_USER_PER_RUN; i += 1) {
        outcomes.push(control(state).askUser(`問${i}`, ['A', 'B']));
        // 次のask_userを呼べるように、直前の質問へ都度答えておく（1回に1問だけの制約）。
        // answerAskUserはbusy中は送信を保留するため、ターンが終わったことにして配送させる
        runner.answerAskUser(runId, 0);
        orchestrator.emitState({ ...initialChatState, busy: false });
      }
      const overLimit = control(state).askUser('もう1問', ['A', 'B']);

      expect(outcomes.every((o) => o.accepted)).toBe(true);
      expect(overLimit.accepted).toBe(false);
      expect(overLimit.reason).toContain(`上限（${DEFAULT_MAX_ASK_USER_PER_RUN}回/run）`);
      expect(overLimit.reason).toContain('decide_final_merge');
    },
  );

  it('readMaxAskUserPerRunで上限を変えられる（config.tsのworkflows.maxAskUserPerRun経由）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(YAML_ONE, {
      messaging: deps,
      readMaxAskUserPerRun: () => 1,
    });
    const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

    const first = control(state).askUser('問1', ['A', 'B']);
    expect(first.accepted).toBe(true);
    expect(runner.answerAskUser(runId, 0)).toBe(true);
    // answerAskUserはbusy中は送信を保留する。ターンが終わったことにして配送させる
    orchestrator.emitState({ ...initialChatState, busy: false });

    const second = control(state).askUser('問2', ['C', 'D']);
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain('上限（1回/run）');
    expect(second.reason).toContain('decide_final_merge');
  });

  it(
    'answerAskUserはbusy中に答えても失わず、ターンが終わってからまとめて送る' +
      '（レビュー指摘: ask_userはオーケストレーターのターンの最中に呼ばれるため、答えた時点で' +
      'busyがtrueのことがある。割り込んで送ると送信が失われrunが無期限に止まるため、' +
      'busy中は保留し、ターンが終わってから送る）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(YAML_ONE, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      // run開始の通知でターンが走っている（本番と同じくbusy: trueのまま）
      expect(runner.getSnapshot(runId)?.orchestrator?.busy).toBe(true);

      // ask_userもそのターンの最中に呼ばれる
      control(state).askUser('どちらへ進める？', ['A案', 'B案']);
      expect(runner.getSnapshot(runId)?.pendingAskUser).toMatchObject({ answered: false });

      const sentBefore = orchestrator.sentTexts.length;
      const accepted = runner.answerAskUser(runId, 1);

      // busy中はまだ送らない（走行中のターンへ割り込むと送信が失われかねないため）
      expect(accepted).toBe(true);
      expect(orchestrator.sentTexts.length).toBe(sentBefore);
      expect(runner.getSnapshot(runId)?.pendingAskUser).toMatchObject({ answered: true });

      // ターンが終わって初めて送る
      orchestrator.emitState({ ...initialChatState, busy: false });

      expect(runner.getSnapshot(runId)?.pendingAskUser).toBeUndefined();
      const last = orchestrator.sentTexts[orchestrator.sentTexts.length - 1] as string;
      expect(last).toContain('B案');
    },
  );

  it('答え済み・配送待ちの間にもう一度答えても二重送信にならない', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(YAML_ONE, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;

    control(state).askUser('どちらへ進める？', ['A案', 'B案']);
    const first = runner.answerAskUser(runId, 0);
    const sentBefore = orchestrator.sentTexts.length;
    const second = runner.answerAskUser(runId, 1);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(orchestrator.sentTexts.length).toBe(sentBefore);

    orchestrator.emitState({ ...initialChatState, busy: false });

    const sent = orchestrator.sentTexts.join('\n');
    expect(sent).toContain('A案');
    expect(sent).not.toContain('B案');
  });

  it('answerAskUserは範囲外のindex・回答待ちが無いときはfalseを返し、何も変えない', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(YAML_ONE, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(runner.answerAskUser(runId, 0)).toBe(false);

    control(state).askUser('問い', ['A', 'B']);
    expect(runner.answerAskUser(runId, 9)).toBe(false);
    expect(runner.getSnapshot(runId)?.pendingAskUser).toBeDefined();
    expect(runner.answerAskUser('unknown-run', 0)).toBe(false);
  });

  it(
    '回答待ちの間はタスク完了通知の送信を止めて溜め、answerAskUserが答えと一緒に合流させる' +
      '（design.md §16.33「待たせる仕組み」）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(YAML_ONE, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      const orchestrator = codexHost.orchestratorSessions[0] as FakeTaskSession;
      orchestrator.emitState({ ...initialChatState, busy: true });
      orchestrator.emitState({ ...initialChatState, busy: false });

      control(state).askUser('どちらへ進める？', ['A案', 'B案']);
      const sentBefore = orchestrator.sentTexts.length;

      // 回答待ちの間にタスクが完了しても、まだオーケストレーターへは送らない
      (codexHost.sessions[0] as FakeTaskSession).finish('done', doneState('ok'));
      await flush();
      expect(orchestrator.sentTexts.length).toBe(sentBefore);

      runner.answerAskUser(runId, 0);

      const added = orchestrator.sentTexts.slice(sentBefore).join('\n');
      expect(added).toContain('A案');
      expect(added).toContain('T1');
    },
  );

  it('回答待ちの間は人の自由記述の発話を送らせない（design.md §16.33「回答の経路を一意にする」）', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner } = createHarness(YAML_ONE, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    control(state).askUser('どちらへ進める？', ['A案', 'B案']);

    expect(runner.sendToOrchestrator(runId, '横から一言')).toBe(false);
  });

  it(
    'リロード後は永続化された問いの文言だけ復元し、hasLiveSession: falseで答えられない' +
      '（design.md §16.33「永続化」。オーケストレーターセッション自体は復元できない）',
    async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, store } = createHarness(YAML_ONE, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/ask-user.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      control(state).askUser('どちらへ進める？', ['A案', 'B案']);
      await flush();
      expect(store.find(runId)?.pendingAskUser).toMatchObject({
        question: 'どちらへ進める？',
        choices: ['A案', 'B案'],
      });

      const newCodexHost = new FakeHost();
      const reloadedRunner = new WorkflowRunner({
        // 本番の既定値（true）だとリロード後の自動再開が動き、この既存テストが確かめている
        // 「人が手動で再実行するまで再開しない」前提が崩れるため明示的に無効化する
        // （design.md §16.35、roadmap W10、Issue #584）
        readAutoResume: () => false,
        hosts: { codex: newCodexHost, claude: newCodexHost },
        worktreeQueue: new WorktreeCreationQueue(),
        git: fakeGit(),
        fs: identityFs,
        filePort: filePort(YAML_ONE),
        store,
        log: fakeLogger,
        readBaseline: () => ({
          codexSandbox: 'read-only',
          codexApprovalMode: 'on-request',
          claudePermissionMode: 'manual',
          allowAutoApprove: true,
          allowClaudeBypassPermissions: false,
        }),
      });

      await reloadedRunner.restoreRunsForView();

      const snapshot = reloadedRunner.getSnapshot(runId);
      expect(snapshot?.pendingAskUser).toEqual({
        question: 'どちらへ進める？',
        choices: ['A案', 'B案'],
        hasLiveSession: false,
        answered: false,
      });
      // 答える経路自体が無い（セッションが無いのでfalseで何もしない）
      expect(reloadedRunner.answerAskUser(runId, 0)).toBe(false);
    },
  );
});

describe('WorkflowRunner: 中断からの自動再開（design.md §16.35、roadmap W10、Issue #584）', () => {
  const YAML = `
version: 1
name: auto-resume-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

  const ALLOW_YAML = `
version: 1
name: auto-resume-allow-test
tasks:
  - id: T1
    allow:
      - "npm test"
    prompt: p
    done: d
`;

  function reloadWith(
    store: WorkflowRunStore,
    yaml: string,
    options?: { readAutoResume?: () => boolean; readMaxAutoResumeAttempts?: () => number },
  ): { reloadedRunner: WorkflowRunner; newCodexHost: FakeHost } {
    const newCodexHost = new FakeHost();
    const reloadedRunner = new WorkflowRunner({
      ...(options?.readAutoResume !== undefined ? { readAutoResume: options.readAutoResume } : {}),
      ...(options?.readMaxAutoResumeAttempts !== undefined
        ? { readMaxAutoResumeAttempts: options.readMaxAutoResumeAttempts }
        : {}),
      hosts: { codex: newCodexHost, claude: newCodexHost },
      worktreeQueue: new WorktreeCreationQueue(),
      git: fakeGit(),
      fs: identityFs,
      filePort: filePort(yaml),
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });
    return { reloadedRunner, newCodexHost };
  }

  it('既定（autoResume: true）ではreloadInterruptedのタスクをpendingへ戻し自動的に再開する', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    // 明示的に`true`を渡す（本番の既定値と同じ）。ハーネス既定は`false`のため
    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => true,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    // 再実行を待つ`failed`ではなく、新しいセッションから自動的に走り出している
    const snapshot = reloadedRunner.getSnapshot(runId);
    expect(snapshot?.tasks[0]?.state).toBe('running');
    expect(snapshot?.tasks[0]?.hasLiveSession).toBe(true);
    expect(newCodexHost.sessions).toHaveLength(1);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    // 戻したタスクidがViewから見える形で残る（design.md §16.35の受入基準）
    const warning = snapshot?.warnings.find((w) => w.kind === 'autoResume');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('T1');

    // 自動再開の実施回数を数えている（次のリロードで上限判定に使う）
    expect(store.find(runId)?.autoResumeAttempts).toBe(1);
  });

  it('haltedByUser（人が全体停止した実行）は自動再開しない', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume-halted.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 全体停止した直後、走行中タスクのstopLoopがまだ返ってきていない状態でリロードが来た
    // ことを模す（haltedByUser: trueかつタスクはまだ`running`のまま）
    runner.stop(runId);
    await flush();
    expect(store.find(runId)?.haltedByUser).toBe(true);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => true,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    // reconcileAfterReloadでfailed(reloadInterrupted)になったまま、自動再開はしない
    const snapshot = reloadedRunner.getSnapshot(runId);
    expect(snapshot?.tasks[0]?.state).toBe('failed');
    expect(snapshot?.tasks[0]?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(newCodexHost.sessions).toHaveLength(0);
    expect(snapshot?.warnings.some((w) => w.kind === 'autoResume')).toBe(false);
  });

  it('agent.workflows.autoResumeがfalseなら従来どおり再開せず、人の再実行を待つ', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume-off.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => false,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    const snapshot = reloadedRunner.getSnapshot(runId);
    expect(snapshot?.tasks[0]?.state).toBe('failed');
    expect(snapshot?.tasks[0]?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(newCodexHost.sessions).toHaveLength(0);
    expect(reloadedRunner.retryTask(runId, 'T1')).toEqual({ ok: true });
    await flush();
    expect(newCodexHost.sessions).toHaveLength(1);
  });

  it('自動再開の上限（maxAutoResumeAttempts）に達していれば再開せず、理由をViewへ残す', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume-limit.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 前回までの自動再開で既に上限（1回）へ達していたことを模す
    const before = store.find(runId);
    if (before === undefined) {
      throw new Error('runが見つかりません');
    }
    await store.update(runId, () => ({ ...before, autoResumeAttempts: 1 }));

    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => true,
      readMaxAutoResumeAttempts: () => 1,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    const snapshot = reloadedRunner.getSnapshot(runId);
    // 再開せず、reloadInterruptedのままViewから見える
    expect(snapshot?.tasks[0]?.state).toBe('failed');
    expect(snapshot?.tasks[0]?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(newCodexHost.sessions).toHaveLength(0);
    const warning = snapshot?.warnings.find((w) => w.kind === 'autoResumeLimitExceeded');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('1');
    // 上限超過では実施回数を増やさない（機械的に増え続けない）
    expect(store.find(runId)?.autoResumeAttempts).toBe(1);
  });

  it('allowを持つタスクがreloadInterruptedなら、run全体の自動再開を見送る', async () => {
    const { runner, store } = createHarness(ALLOW_YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume-allow.yaml', '/repo', {
      allowConfirmed: true,
    });
    const runId = result.runId as string;
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    const { reloadedRunner, newCodexHost } = reloadWith(store, ALLOW_YAML, {
      readAutoResume: () => true,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    const snapshot = reloadedRunner.getSnapshot(runId);
    // 人が居ないその場でallow確認を代行できないため、reloadInterruptedのまま残す
    expect(snapshot?.tasks[0]?.state).toBe('failed');
    expect(snapshot?.tasks[0]?.failure).toEqual({ kind: 'reloadInterrupted' });
    expect(newCodexHost.sessions).toHaveLength(0);
    expect(snapshot?.warnings.some((w) => w.kind === 'autoResume')).toBe(false);
    // 見送った理由自体はViewから見える（レビュー指摘。2026-08-23。上限超過だけ理由が
    // 見えて他は見えないと人が区別できないため、autoResumeBlockedとしてrunへ積む）
    const blockedWarning = snapshot?.warnings.find((w) => w.kind === 'autoResumeBlocked');
    expect(blockedWarning).toBeDefined();
    expect(blockedWarning?.message).toContain('allow');
    // 再実行にはallow確認が要る（従来どおり）
    expect(reloadedRunner.retryTask(runId, 'T1')).toEqual({
      ok: false,
      needsAllowConfirmation: true,
    });
  });

  it(
    '他の理由で失敗したタスクが混ざっているreloadInterruptedは、run全体の自動再開を見送り、' +
      '理由をViewへ残す',
    async () => {
      const TWO_TASK_YAML = `
version: 1
name: auto-resume-other-failure-test
tasks:
  - id: T1
    prompt: p
    done: d
  - id: T2
    prompt: p
    done: d
`;
      const { runner, store } = createHarness(TWO_TASK_YAML);
      const result = await runner.start(
        '/repo/.agents/workflows/auto-resume-other-failure.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
      expect(store.find(runId)?.tasks['T2']?.state).toBe('running');

      // T2は本物の理由（loopFailed）で先に失敗していたとする。T1はまだ走行中のまま
      // リロードが来た（reconcileAfterReloadでreloadInterruptedになる）
      const before = store.find(runId);
      if (before === undefined) {
        throw new Error('runが見つかりません');
      }
      await store.update(runId, () => ({
        ...before,
        tasks: {
          ...before.tasks,
          T2: {
            ...before.tasks['T2']!,
            state: 'failed',
            failure: { kind: 'loopFailed', reason: 'stopped' },
          },
        },
      }));

      const { reloadedRunner, newCodexHost } = reloadWith(store, TWO_TASK_YAML, {
        readAutoResume: () => true,
      });
      await reloadedRunner.restoreRunsForView();
      await flush();

      const snapshot = reloadedRunner.getSnapshot(runId);
      // 孤立したpendingを作らないため、T1もreloadInterruptedのまま残す
      const t1 = snapshot?.tasks.find((t) => t.id === 'T1');
      expect(t1?.state).toBe('failed');
      expect(t1?.failure).toEqual({ kind: 'reloadInterrupted' });
      expect(newCodexHost.sessions).toHaveLength(0);
      expect(snapshot?.warnings.some((w) => w.kind === 'autoResume')).toBe(false);
      const blockedWarning = snapshot?.warnings.find((w) => w.kind === 'autoResumeBlocked');
      expect(blockedWarning).toBeDefined();
    },
  );

  it('自動再開したタスクは前の試行と別のworktree・別のブランチで走り、二重作成にならない', async () => {
    const { runner, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/auto-resume-worktree.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const before = store.find(runId)?.tasks['T1'];
    expect(before?.state).toBe('running');
    expect(before?.retryCount).toBe(0);

    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => true,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    // クラッシュした試行のworktree・ブランチ名（.../T1）とは別名（.../T1-retry0）で
    // 作り直す。`applyAutoResume`がmanualRetryCountを1増やすため（`retrySuffixOf`と同じ計算）。
    // retryCountは増やさない（自動再試行=`retries`の予算を消費させないため。レビュー指摘、
    // 2026-08-23）
    const resumed = newCodexHost.sessions.find((s) => s.cwd.endsWith('/T1-retry0'));
    expect(resumed).toBeDefined();
    expect(store.find(runId)?.tasks['T1']?.retryCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.manualRetryCount).toBe(1);
  });

  it('ask_user回答待ちのまま中断した実行は、自動再開後に問いを出し直す', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, store } = createHarness(YAML, { messaging: deps });
    const result = await runner.start('/repo/.agents/workflows/auto-resume-ask.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const port = state.hub?.orchestratorControl;
    if (port === undefined) {
      throw new Error('制御ツールが配線されていません');
    }
    port.askUser('どちらへ進める？', ['A案', 'B案']);
    await flush();
    expect(store.find(runId)?.pendingAskUser).toMatchObject({
      question: 'どちらへ進める？',
      choices: ['A案', 'B案'],
    });

    const { reloadedRunner, newCodexHost } = reloadWith(store, YAML, {
      readAutoResume: () => true,
    });
    await reloadedRunner.restoreRunsForView();
    await flush();

    // 答え待ちの問いが、新しいオーケストレーターセッションでも生きている
    // （hasLiveSession: trueに戻り、人が答えられる。design.md §16.33「答える経路」）
    const snapshot = reloadedRunner.getSnapshot(runId);
    expect(snapshot?.pendingAskUser).toMatchObject({
      question: 'どちらへ進める？',
      choices: ['A案', 'B案'],
      hasLiveSession: true,
      answered: false,
    });
    expect(newCodexHost.orchestratorSessions).toHaveLength(1);

    // 答えると、質問を引き継いだ文脈と一緒に配送される（会話は復元できないため、
    // イントロへ問いの文言を織り込む形で引き継ぐ。`runnerOrchestrator.ts`の
    // `buildIntroBody`参照）
    expect(reloadedRunner.answerAskUser(runId, 0)).toBe(true);
    const orchestrator = newCodexHost.orchestratorSessions[0] as FakeTaskSession;
    orchestrator.emitState({ ...initialChatState, busy: false });
    await flush();

    const sent = orchestrator.sentTexts.join('\n');
    expect(sent).toContain('自動再開です');
    expect(sent).toContain('どちらへ進める？');
    expect(sent).toContain('A案');
  });
});

describe('formatPathList（先頭20件+残り件数の丸め、レビュー指摘: risk、Issue #380）', () => {
  it('20件以下はそのまま全件をカンマ区切りで表示する（境界値）', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);

    expect(formatPathList(paths)).toBe(paths.join(', '));
  });

  it('21件になると先頭20件+残り1件の省略表示になる（境界値）', () => {
    const paths = Array.from({ length: 21 }, (_, i) => `f${i}.txt`);

    const result = formatPathList(paths);

    expect(result).toBe(`${paths.slice(0, 20).join(', ')}, ...ほか1件`);
  });

  it('0件は「なし」を返す', () => {
    expect(formatPathList([])).toBe('なし');
  });

  it(
    '1件ずつsanitizeForLogを通す（パスに混ざった制御文字・ユーザー名を' +
      'ワークフローViewへ出さない、Issue #433）',
    () => {
      const result = formatPathList(['/home/victim/repo/a.txt', 'b\u202E.txt']);

      expect(result).toContain('/home/***/repo/a.txt');
      expect(result).not.toContain('victim');
      expect(result).not.toContain('\u202E');
    },
  );
});

/**
 * 統合worktreeの占有（Issue #412）。衝突解決セッションはLLMの複数ターンぶんの時間
 * （数分〜数十分）走るのに、以前は「gitコマンド1回」しか直列化されていなかったため、
 * その間に別タスクのマージが割り込めた。割り込むと、
 *
 * - 割り込んだ側の`git merge`が「未解決ファイルがある」で失敗し、
 *   `git diff --diff-filter=U`が**他タスクの**未解決パスを返すため`conflict`と誤判定される
 * - 解決セッションが`git add`済みの瞬間なら未解決パスが空になり`failure`（マージ失敗）で確定する
 * - 解決コミット直後なら「未解決なし」を自分の解決とみなして`done`で確定する（実際には
 *   1コミットも統合ブランチへ入っていない）
 *
 * という3通りの壊れ方をした。占有を「マージ1件の全区間」へ広げたことを、割り込み側が
 * 順番待ちになることで確かめる。
 */
describe('WorkflowRunner: 統合worktreeの占有（Issue #412）', () => {
  /** 依存の無い2タスクが同時に走り、同時に完了しうる定義。 */
  const PARALLEL_YAML = `
version: 1
name: lease-test
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  function mergeCalls(git: FakeGitHandle): Array<{ args: string[]; cwd: string }> {
    return git.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--no-ff');
  }

  it('衝突解決中は別タスクのマージが順番待ちになり、他タスクの未解決パスを拾って誤判定しない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // T1が衝突し、衝突解決セッションが開いた（統合worktreeはT1が占有したまま）
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const resolution = codexHost.sessions.at(-1);
    expect(resolution).toBeDefined();
    expect(mergeCalls(git)).toHaveLength(1);

    // その最中にT2が完了しても、T2のマージは始まらない（占有待ち）
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(mergeCalls(git)).toHaveLength(1);
    // 修正前はここでT2がconflict/failure/doneのいずれかへ誤って確定していた
    expect(store.find(runId)?.tasks['T2']?.state).toBe('merging');
    expect(store.find(runId)?.tasks['T2']?.failure).toBeUndefined();

    // T1の解決が終わって占有が解けると、T2のマージが順番どおり走る
    git.resolveConflict();
    resolution?.finish('done', doneState('衝突を解決しました'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    const merges = mergeCalls(git);
    expect(merges).toHaveLength(2);
    expect(merges[1]?.args).toContain(`wf/${runId}/T2`);
  });

  /**
   * 停止・巻き戻しが効かず、統合worktreeに`MERGE_HEAD`と未解決パスが残ったまま占有だけが
   * 解放される経路がある（衝突解決セッションを人が止めた場合や、`git merge --abort`自体が
   * 失敗した場合）。そこへ次のタスクのマージが来たとき、多層防御のゲート
   * （`findMergeInProgress`）が`failure`を返すと`markMergeFailed`で`failed`が確定し、
   * `retryMergeState`は`blocked`からしか戻せないためViewの「再マージ」でも復帰できない
   * 行き止まりになる（レビュー指摘1）。回復可能な`blocked`へ倒すことを確かめる。
   */
  it('他タスクの未解決の衝突が残った統合worktreeへぶつかったタスクは、failedではなくblockedになり再マージで復帰できる', async () => {
    // 巻き戻しに失敗させ、`MERGE_HEAD`が残ったまま占有が解放される状況を作る
    const git = fakeGit({ conflictOnce: true, failMergeAbort: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);
    expect(resolution).toBeDefined();

    // 解決セッションはdoneを宣言するがgit上は未解決のまま。巻き戻しにも失敗するため、
    // 統合worktreeは`MERGE_HEAD`を抱えたまま占有だけが解放される
    resolution?.finish('done', doneState('解決したつもり'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // そこへT2のマージが来る
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();

    // 修正前はここで`failure`→`failed`が確定し、以後どうやっても戻せなかった
    expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');
    expect(store.find(runId)?.tasks['T2']?.failure).toBeUndefined();
    // 他タスクの未解決パスを自分の衝突として拾わない（解決セッションも開かない）
    expect(codexHost.sessions).toHaveLength(3);
    expect(
      runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'mergeBusy' && w.taskId === 'T2'),
    ).toBe(true);

    // 人が統合worktreeを片付けてからViewの「再マージ」を押せば、そのまま先へ進める
    git.resolveConflict();
    expect(runner.retryMerge(runId, 'T2')).toBe(true);
    await flush();

    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });

  /**
   * `acquireLease`は無期限で待ち、`stop()`は`haltedByUser`を立てるだけで待機中の取得を
   * 起こさない。そのため、他タスクの衝突解決が長引いている間に人が停止しても、占有が
   * 解けた瞬間に`git merge --no-ff`が走り、衝突すれば新しい解決セッションまで開いてしまう
   * （レビュー指摘2）。取得直後の再確認でこれを止める。
   *
   * **止めたタスクは`merging`のまま残さず`blocked`で確定させる**（レビュー指摘A）。
   * `merging`は`getRunOutcome`では`running`扱いのため、放置するとrunの終了判定が永久に
   * 立たず（`finishedAt`が付かない）、停止操作が完了せず、終了時の後始末も走らない。
   * Viewも`merging`には操作ボタンを出さないため復帰手段が無くなる。
   */
  it('占有の順番待ちの間に停止されたら、マージを始めずblockedで確定させる', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);

    // T2は占有待ちで止まっている
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(mergeCalls(git)).toHaveLength(1);

    // 待っている最中にユーザーが停止する
    runner.stop(runId);
    await flush();
    const sessionCountAtStop = codexHost.sessions.length;

    // T1の解決が終わって占有が解ける
    git.resolveConflict();
    resolution?.finish('done', doneState('衝突を解決しました'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    // 修正前はここでT2の`git merge --no-ff`が走っていた
    expect(mergeCalls(git)).toHaveLength(1);
    // 新しい衝突解決セッションも開かない
    expect(codexHost.sessions).toHaveLength(sessionCountAtStop);

    // マージは始めないが、`merging`のまま固着させない（人が理由を追える警告も残る）
    expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');
    expect(store.find(runId)?.tasks['T2']?.failure).toBeUndefined();
    expect(
      runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'mergeBusy' && w.taskId === 'T2'),
    ).toBe(true);
    // runの終了判定まで進む（`merging`のままだと`running`扱いで永久に終わらない）
    expect(store.find(runId)?.finishedAt).toBeDefined();

    // 停止したあとでも、人が「再マージ」を押せばそのタスクは先へ進められる
    expect(runner.retryMerge(runId, 'T2')).toBe(true);
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });

  it('衝突解決セッションを開けなかった（例外）経路でも占有は解放され、次のタスクのマージが進む', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 衝突解決セッションの生成だけを失敗させる（タスクのセッションは開き終わっている）
    codexHost.rejectNext(new Error('app-serverが落ちている'));
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // 例外経路は`abortAndBlock`（自分の占有ハンドルで巻き戻す）を通ってblockedになる
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort')).toBe(true);

    // 占有が解放されていなければ、ここでT2のマージが永久に詰まる（デッドロック）
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });

  /**
   * 引き継ぎ（`handover.done`）を`onFinished`の登録まで遅らせると、`session.open()`と
   * `buildMergeResolutionPrompt()`が投げる窓が残る（レビュー指摘C）。この窓で投げると、
   * 統合worktreeで生きているセッションを抱えたまま`attemptMerge`の`finally`が占有を解放し、
   * 次タスクの`git merge`が解決作業へ割り込む。さらに`session.open()`が投げた場合は
   * `live.mergeResolutions.set`の前なので、そのセッションは誰にもdisposeされず残る。
   * `openTaskSession`が解決した直後に引き継ぎを確定させ、以降をこの関数の`catch`で
   * 始末することを確かめる。
   */
  it('衝突解決セッションのopen()が投げても、セッションを畳んで巻き戻しblockedで確定する', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 衝突解決セッションのタブ表示だけを失敗させる（セッション自体は手に入っている）
    codexHost.configureNext = (session) => {
      session.failOpen = new Error('タブを開けませんでした');
    };
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // 修正前は例外がそのまま抜け、T1は`merging`のまま・セッションは開きっぱなしだった
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    const resolution = codexHost.sessions.at(-1);
    expect(resolution?.openCount).toBe(1);
    expect(resolution?.disposed).toBe(true);
    expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort')).toBe(true);
    // 占有も手放されているので、次のタスクのマージは進む
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
  });

  /**
   * `onFinished`の登録が`session.open()`より後にあると、`open()`が同期的にループを回し切る
   * host実装では、登録前に発火した終了を取りこぼす（レビュー指摘12）。取りこぼすと、
   * 引き継ぎ（`handover.done`）が既に立っているぶん`attemptMerge`の`finally`も解放しないため、
   * 統合worktreeの占有を誰も手放さないまま`runLoop()`が**正常return**する（`catch`にも
   * 入らないので気づけない）。以後そのrunのマージは全て順番待ちで詰まる。
   */
  it('衝突解決セッションのopen()が同期的に終了を発火しても、決着まで進み占有も解放される', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 衝突解決セッションだけ、`open()`の中でループを回し切って終了まで発火する実装にする
    codexHost.configureNext = (session) => {
      session.openFinishReason = 'maxReached';
    };
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // 修正前はこの終了を誰も受け取らず、T1は`merging`のまま・占有も握られたままだった
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    const resolution = codexHost.sessions.at(-1);
    // 終わったセッションへループをかけ直さず、その場で畳む
    expect(resolution?.runLoopCalls).toHaveLength(0);
    expect(resolution?.disposed).toBe(true);

    // 占有が解放されているので、次のタスクのマージは順番どおり進む
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });

  /**
   * 占有の失効を「runが破棄された」と読み替えて何もせず戻ると、将来`releaseAllLeases()`を
   * 破棄以外（停止時など）からも呼ぶようにした瞬間、順番待ちだったタスクが`merging`のまま
   * 固着してrunが永久に終わらなくなる（`getRunOutcome`は`merging`を`running`扱いするため。
   * 本PRのAで潰した壊れ方がそのまま復活する）。`IntegrationMergeQueue`は呼び出し元が
   * `dispose()`だけであることを何も保証していないので、`decideAfterLeaseWait`は
   * 「強制解放された」という事実と「このrunが破棄されたか（`live.finished`）」を別々に見て、
   * 生きているrunなら`blocked`へ倒す（レビュー指摘11）。
   *
   * `dispose()`を経由せずキューだけを強制解放するため、ここだけ内部のキューへ直接触る
   * （将来`releaseAllLeases()`の呼び出し箇所が増えた状況の先取り）。
   */
  it('runが生きているまま占有が強制解放されたら、mergingで固着させずblockedで確定させる', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // T1が衝突解決中、T2はその占有待ち
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(mergeCalls(git)).toHaveLength(1);
    expect(store.find(runId)?.tasks['T2']?.state).toBe('merging');

    // run破棄（`dispose()`）ではなく、キューの強制解放だけが起きた状況
    (
      runner as unknown as { integrationQueue: { releaseAllLeases: () => void } }
    ).integrationQueue.releaseAllLeases();
    await flush();

    // 権利を失っているのでマージはしない。ただし`merging`のままにもしない
    expect(mergeCalls(git)).toHaveLength(1);
    expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');
    expect(store.find(runId)?.tasks['T2']?.failure).toBeUndefined();
    expect(
      runner.getSnapshot(runId)?.warnings.some((w) => w.kind === 'mergeBusy' && w.taskId === 'T2'),
    ).toBe(true);

    // `blocked`なので人が「再マージ」で復帰できる（統合worktreeにはT1の未解決の衝突が
    // 残ったままなので、人が片付けてから押す）
    git.resolveConflict();
    expect(runner.retryMerge(runId, 'T2')).toBe(true);
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });

  /**
   * `catch`の`session.dispose()`は`onFinished`を同期的に発火しうる（`chatView.ts`の
   * `teardown`→`entry.loop.stop('manual')`）。そのまま`onMergeResolutionFinished`へ
   * 再入すると、`applyLoopStopReason('manual')`が**run全体を停止して未開始の`pending`を
   * `skipped`にし**、さらに占有解放が先に走るぶん`abortAndBlock`の`git merge --abort`が
   * `leaseNotHeld`で拒否されて`MERGE_HEAD`が残る（レビュー指摘D）。`dispose`の前に
   * 後始末済みの印を立て、リスナーを黙らせることを確かめる。
   */
  it('後始末のdisposeがonFinishedを再入させても、run全体は止まらず巻き戻しも走る', async () => {
    // maxParallel: 1 なので、T1が走っている間T2は`pending`のまま残る
    const serialYaml = `
version: 1
name: lease-dispose
defaults:
  provider: codex
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(serialYaml, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 衝突解決セッションはループを走らせられず、その後始末のdisposeがonFinishedを発火する
    codexHost.configureNext = (session) => {
      session.failRunLoop = new Error('ループを開始できませんでした');
      session.disposeFinishReason = 'manual';
    };
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    // 修正前は`leaseNotHeld`で拒否され、`git merge --abort`が走らなかった
    expect(git.calls.some((c) => c.args[0] === 'merge' && c.args[1] === '--abort')).toBe(true);
    // 修正前はrun全体が停止し、未開始のT2が`skipped`（runHalted）で終わっていた
    expect(store.find(runId)?.haltedByUser).toBe(false);
    expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
  });

  /**
   * `finishMergeResolution`の`session?.dispose()`は`reason`の判定より前に無条件で呼ばれる。
   * `dispose()`（実体は`streamSession.ts`の`stdin.end()`やプロセスkill）が例外を投げると、
   * `reason`が`manual`/`interrupted`/`taskStopped`（人が止めた経路）であっても
   * `onMergeResolutionFinished`の`catch`が拾って`markMergeFailed`へ落としてしまい、
   * 「人が止めたマージはタスク自身の状態を変えない」（Issue #434）という規律と衝突する。
   * `dispose()`由来の例外は`reason`に関わらずログにだけ残し、`markMergeFailed`へ落とさない
   * ことを確かめる。
   */
  it('人が衝突解決セッションを止めたとき、後始末のdisposeが例外を投げてもmarkMergeFailedへ落ちない（Issue #434）', async () => {
    const soloYaml = `
version: 1
name: lease-manual-stop
defaults:
  provider: codex
tasks:
  - id: T1
    prompt: p1
    done: d1
`;
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(soloYaml, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // T1が衝突し、衝突解決セッションが開いた
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);
    if (resolution === undefined) {
      throw new Error('衝突解決セッションが開かれていません');
    }

    // 人がタブを閉じた（`manual`）。その後始末のdisposeがプロセスkillの失敗等で例外を投げる
    resolution.failDispose = new Error('プロセスの終了に失敗しました');
    resolution.finish('manual', { ...initialChatState });
    await flush();

    // Issue #434の規律どおり、`dispose()`の例外は`markMergeFailed`（`failed`）へは落ちない。
    // ただしIssue #443（案A）により、タスク自身は`merging`のまま残さず`blocked`に確定する
    // （`git merge --abort`は呼ばれない。巻き戻さない規律はそのまま守る）
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
    expect(store.find(runId)?.haltedByUser).toBe(true);
  });

  /**
   * `merging`のまま残った2件を持つ永続化データと、それを復元するrunnerを用意する
   * （リロード後のやり直しの検証用）。
   */
  async function restoreHarness(git: FakeGitHandle): Promise<{
    runner: WorkflowRunner;
    host: FakeHost;
    store: WorkflowRunStore;
    runId: string;
  }> {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000412';
    const persistedTask = (id: string) => ({
      state: 'merging' as const,
      sessionId: `session-${id}`,
      cwd: `/repo/.agents/worktrees/${runId}/${id}`,
      branch: `wf/${runId}/${id}`,
      submissionCount: 1,
      retryCount: 0,
      manualRetryCount: 0,
      failure: undefined,
      pullRequestNumber: undefined,
      pullRequestUrl: undefined,
    });
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/lease.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      tasks: { T1: persistedTask('T1'), T2: persistedTask('T2') },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));

    const host = new FakeHost();
    const runner = new WorkflowRunner({
      hosts: { codex: host, claude: host },
      worktreeQueue: new WorktreeCreationQueue(),
      git,
      fs: identityFs,
      filePort: filePort(PARALLEL_YAML),
      store,
      log: fakeLogger,
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });
    return { runner, host, store, runId };
  }

  /**
   * 復元のやり直しが**1件ずつ直列**であることを、占有の順番待ちに頼らずに確かめる。
   *
   * 衝突しないgitで2件を復元すると、1件目のマージは待たされないまま終わる。直列なら
   * 「T1の全ての手順（未コミット回収→マージ）が終わってからT2の1回目のgitコマンドが出る」
   * のに対し、一斉に`void`で投げると、T1がawaitへ入った隙にT2の未コミット回収
   * （T2のworktreeでの`git status`）が始まり、T1のマージより前に現れる。
   *
   * 以前のテストは`conflictOnce`で1件目を衝突させていたため、`void`の一斉投入へ戻しても
   * 2件目が占有待ちで止まって観測結果が変わらず、直列化そのものを区別できていなかった
   * （レビュー指摘8）。
   */
  it('リロード後の復元は、衝突しない場合でもmergingタスクを1件ずつ順番に走らせる', async () => {
    const git = fakeGit();
    const { runner, store, runId } = await restoreHarness(git);

    await runner.restoreRunsForView();
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');

    const t1MergeIndex = git.calls.findIndex(
      (c) => c.args[0] === 'merge' && c.args[1] === '--no-ff' && c.args.includes(`wf/${runId}/T1`),
    );
    const t2MergeIndex = git.calls.findIndex(
      (c) => c.args[0] === 'merge' && c.args[1] === '--no-ff' && c.args.includes(`wf/${runId}/T2`),
    );
    expect(t1MergeIndex).toBeGreaterThanOrEqual(0);
    expect(t2MergeIndex).toBeGreaterThan(t1MergeIndex);

    // T2側のworktreeを触るgitコマンドは、T1のマージが終わるまで1つも出ない
    const firstT2CallIndex = git.calls.findIndex((c) => c.cwd.endsWith('/T2'));
    expect(firstT2CallIndex).toBeGreaterThan(t1MergeIndex);
  });

  /**
   * `dispose()`の`releaseAllLeases()`で起き上がった待機者が、そのまま`markMergeFailed`→
   * `persist`/`notify`まで進むと、破棄済みのEventEmitter・workspaceStateへ書き込む
   * （レビュー指摘6）。起こす前に「即戻る」状態にしてあることを確かめる。
   */
  it('占有待ちの最中にdispose()されても、起き上がった側は破棄済みのrunへ書き戻さない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/lease.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(mergeCalls(git)).toHaveLength(1);

    runner.dispose();
    await flush();

    // 失効したハンドルで起き上がっても、マージも状態の書き換えも行わない
    expect(mergeCalls(git)).toHaveLength(1);
    expect(store.find(runId)?.tasks['T2']?.state).toBe('merging');
    expect(store.find(runId)?.tasks['T2']?.failure).toBeUndefined();
  });

  /**
   * 復元のやり直しを直列にしたぶん、1件目が例外を投げるとそこで打ち切られて2件目以降が
   * 永久に`merging`のまま残る（レビュー指摘7）。1件ごとに拾って先へ進むことを確かめる…
   * つもりだったが、`throwingGit`が投げる例外は`startMerge`（`runnerMerge.ts`）内の
   * `commitUncommittedChangesIfNeeded`が最初に受け止めてしまう。`startMerge`自体が
   * 例外を受け止めて`markMergeFailed`へ落とすようになった（Issue #437）ため、この
   * テストで実際に検証できているのは`startMerge`内部の`try/catch`だけで、
   * `resumeMergesSequentially`（`runnerRestore.ts`）の`try/catch`は1回も例外を
   * 受け取っていない。守ろうとした性質（1件目の失敗で2件目以降を止めない）自体は
   * 保たれているが、それを保証しているのが`startMerge`側なのか
   * `resumeMergesSequentially`側なのかをこのテストは区別できない
   * （`resumeMergesSequentially`の`try/catch`を消しても同じ結果で通る）。
   * `resumeMergesSequentially`自身の`try/catch`は次のテストが受け持つ。
   */
  it('リロード後の復元は、1件目が例外で落ちても2件目のやり直しを続ける（startMerge内で受け止める経路）', async () => {
    const base = fakeGit();
    const throwingGit: FakeGitHandle = {
      calls: base.calls,
      resolveConflict: () => base.resolveConflict(),
      run: async (args, cwd) => {
        if (cwd.endsWith('/T1')) {
          throw new Error('gitの起動に失敗しました');
        }
        return base.run(args, cwd);
      },
    };
    const { runner, store, runId } = await restoreHarness(throwingGit);

    await runner.restoreRunsForView();
    await flush();

    // 1件目は例外を受けてfailedへ確定する（`merging`のまま固着しない）が、
    // 2件目のやり直しは打ち切られず走り切る
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
  });

  /**
   * 前のテストと違い、`startMerge`を呼ぶより前の層（`resumeMergeAfterReload`が
   * `self.deps.store.find(runId)`を読む箇所、`runnerRestore.ts`）で例外を起こし、
   * `resumeMergesSequentially`の`try/catch`が実際に例外を受け止めて次のtaskIdへ
   * 進むことを確かめる。ここで例外を起こすのは`store.find`が最初の1回だけ投げる
   * フェイクにしたためで、`startMerge`自体は一度も呼ばれない
   * （T1の状態は復元前の`merging`のまま固着する＝レビュー指摘が言う「1件目の失敗が
   * 2件目を道連れにする」を防げているかどうかの純粋な検証になる）。
   */
  it('リロード後の復元は、store.findが例外を投げても2件目のやり直しを続ける（resumeMergesSequentially自身のtry/catch）', async () => {
    class ThrowOnceStore extends WorkflowRunStore {
      private calls = 0;
      override find(runId: string): PersistedRun | undefined {
        this.calls += 1;
        if (this.calls === 1) {
          throw new Error('storeの読み出しに失敗しました');
        }
        return super.find(runId);
      }
    }
    const store = new ThrowOnceStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000413';
    const persistedTask = (id: string) => ({
      state: 'merging' as const,
      sessionId: `session-${id}`,
      cwd: `/repo/.agents/worktrees/${runId}/${id}`,
      branch: `wf/${runId}/${id}`,
      submissionCount: 1,
      retryCount: 0,
      manualRetryCount: 0,
      failure: undefined,
      pullRequestNumber: undefined,
      pullRequestUrl: undefined,
    });
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/lease.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      tasks: { T1: persistedTask('T1'), T2: persistedTask('T2') },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));

    const errorLog = vi.fn();
    const git = fakeGit();
    const host = new FakeHost();
    const runner = new WorkflowRunner({
      hosts: { codex: host, claude: host },
      worktreeQueue: new WorktreeCreationQueue(),
      git,
      fs: identityFs,
      filePort: filePort(PARALLEL_YAML),
      store,
      log: { ...fakeLogger, error: errorLog },
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });

    await runner.restoreRunsForView();
    await flush();

    // T1は`store.find`が投げた時点で打ち切られ、復元前の`merging`のまま固着する
    // （`startMerge`は一度も呼ばれていない）。それでもT2のやり直しは続いて完了する
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    // catch節のログ文言（`runnerRestore.ts`）も検証する
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`[workflow ${runId}/T1] リロード後のマージのやり直しに失敗しました`),
    );
  });

  it('リロード後の復元は1件目が衝突しても2件目を割り込ませない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, host, store, runId } = await restoreHarness(git);

    await runner.restoreRunsForView();
    await flush();

    // 1件目（T1）が衝突して解決セッションを開いた時点で、2件目（T2）のマージは待たされる
    expect(mergeCalls(git)).toHaveLength(1);
    expect(store.find(runId)?.tasks['T2']?.state).toBe('merging');

    git.resolveConflict();
    host.sessions.at(-1)?.finish('done', doneState('衝突を解決しました'));
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('done');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('done');
    expect(mergeCalls(git)).toHaveLength(2);
  });
});

/**
 * `void`で発火するマージ経路のうち、pseudo worktree側（Issue #376）と復元側（Issue #412）は
 * rejectionを受け止めるようになったが、gitのメイン経路（`runner.ts`の`void startMerge(...)`・
 * `runnerMerge.ts`の`retryMerge`内`void startMerge(...)`・`void onMergeResolutionFinished(...)`）
 * は残っていた（Issue #437）。`nodeGitCommandRunner`は基本的にresolveしか返さないため実害は
 * 起きにくいが、想定外の例外（ENOSPC等）が起きると`merging`のまま固着し、`getRunOutcome`が
 * `merging`を`running`へマップするためrunが永久に終わらない。
 */
describe('WorkflowRunner: マージ経路のrejectionを受け止める（Issue #437）', () => {
  const SOLO_YAML = `
version: 1
name: merge-rejection-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  /** `git merge --no-ff`だけ例外を投げるgit（resolveしか返さない実装が想定外に投げた状況を模す）。 */
  function throwOnMergeGit(base: FakeGitHandle): FakeGitHandle {
    return {
      calls: base.calls,
      resolveConflict: () => base.resolveConflict(),
      run: async (args, cwd) => {
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          throw new Error('ENOSPC: fake disk full');
        }
        return base.run(args, cwd);
      },
    };
  }

  it('onTaskFinishedのvoid startMerge(...)がgitの例外で落ちても、mergingで固着せずfailedへ確定する', async () => {
    const git = throwOnMergeGit(fakeGit());
    const { runner, codexHost, store } = createHarness(SOLO_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge-rejection.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // 修正前はここで`merging`のまま残り、runの終了判定（`getRunOutcome`）も
    // `merging`を`running`扱いするため`finishedAt`が永久に付かなかった
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.finishedAt).toBeDefined();
  });

  it('retryMerge内のvoid startMerge(...)がgitの例外で落ちても、mergingで固着せずfailedへ確定する', async () => {
    const conflictGit = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(SOLO_YAML, { git: conflictGit });
    const result = await runner.start(
      '/repo/.agents/workflows/merge-rejection-retry.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    // 解決セッションはdoneを宣言するがgit上は未解決のまま（`resolveConflict()`を呼ばない）
    // なので`abortAndBlock`経由で`blocked`になる。「再マージ」の起点を作る
    codexHost.sessions.at(-1)?.finish('done', doneState('解決したつもり'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // 「再マージ」の内部で呼ばれるgitの`merge --no-ff`がここで例外を投げるよう差し替える
    let mergeRetried = false;
    conflictGit.run = async (args, cwd) => {
      if (!mergeRetried && args[0] === 'merge' && args[1] === '--no-ff') {
        mergeRetried = true;
        throw new Error('ENOSPC: fake disk full');
      }
      return fakeGit().run(args, cwd);
    };

    expect(runner.retryMerge(runId, 'T1')).toBe(true);
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.finishedAt).toBeDefined();
  });

  it('衝突解決後のvoid onMergeResolutionFinished(...)が例外で落ちても、mergingで固着せずfailedへ確定する', async () => {
    const base = fakeGit({ conflictOnce: true });
    // `git diff --diff-filter=U`は`findMergeInProgress`（衝突前の事前チェック）と
    // `isMergeResolutionComplete`（解決後の確認）の両方が呼ぶため、1回目（衝突前）は
    // 素通しし、2回目（`finishMergeResolution`からの呼び出し）だけ例外を投げさせる
    let diffCallCount = 0;
    const git: FakeGitHandle = {
      calls: base.calls,
      resolveConflict: () => base.resolveConflict(),
      run: async (args, cwd) => {
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          diffCallCount += 1;
          if (diffCallCount >= 2) {
            throw new Error('ENOSPC: fake disk full');
          }
        }
        return base.run(args, cwd);
      },
    };
    const { runner, codexHost, store } = createHarness(SOLO_YAML, { git });
    const result = await runner.start(
      '/repo/.agents/workflows/merge-resolution-throw.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);

    base.resolveConflict();
    resolution?.finish('done', doneState('解決しました'));
    await flush();

    // 修正前はここで`onMergeResolutionFinished`の例外がunhandled rejectionとなり、
    // `merging`のまま固着していた
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    expect(store.find(runId)?.finishedAt).toBeDefined();
  });
});

/**
 * `mergeBusy`警告は「再マージ」（人が何度でも押せる操作）のたびに積まれる。Issue #383（T20）が
 * `orchestratorPromptOverride`を同一taskIdの直近1件へ丸めた規律に、Issue #412が新設した
 * `mergeBusy`（`runnerMerge.ts`2箇所）は乗っていなかった（Issue #439）。
 */
describe('WorkflowRunner: mergeBusy警告を直近1件へ丸める（Issue #439）', () => {
  const PARALLEL_YAML = `
version: 1
name: merge-busy-cap-test
defaults:
  maxParallel: 3
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  it('busy理由でblockedを繰り返しても、同一taskIdのmergeBusy警告は直近1件に丸められる', async () => {
    // T1の解決セッションがdoneを宣言するがgit上は未解決のままで、巻き戻しにも失敗するため、
    // 統合worktreeはMERGE_HEADを抱えたまま占有だけが解放される（既存の
    // 「他タスクの未解決の衝突が残った統合worktreeへぶつかったタスクは」テストと同じ状況）
    const git = fakeGit({ conflictOnce: true, failMergeAbort: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/merge-busy-cap.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);
    resolution?.finish('done', doneState('解決したつもり'));
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // T2のマージは、片付いていない統合worktreeにぶつかって busy → blocked になる
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');

    // 統合worktreeを片付けないまま「再マージ」を複数回押す。押すたびに同じ理由のbusyへ
    // ぶつかり、修正前はmergeBusy警告が押した回数だけ積み上がっていた
    for (let i = 0; i < 3; i += 1) {
      expect(runner.retryMerge(runId, 'T2')).toBe(true);
      await flush();
      expect(store.find(runId)?.tasks['T2']?.state).toBe('blocked');
    }

    const mergeBusyWarnings = (runner.getSnapshot(runId)?.warnings ?? []).filter(
      (w) => w.kind === 'mergeBusy' && w.taskId === 'T2',
    );
    expect(mergeBusyWarnings).toHaveLength(1);
  });
});

describe('WorkflowRunner: ロードマップの警告をログへ届ける（design.md §16.19、Issue #408）', () => {
  const ROADMAP_YAML = `
version: 1
name: roadmap-warn-test
roadmap: "docs/roadmap/g.md"
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  // Issue行はあるが番号として読めない実例（`roadmap.test.ts`の同種の文言と同じ形）。
  // `applyRunCompletionToFile`経由の`applyRunCompletion`が返す`warnings`に1件積まれる想定
  const ROADMAP_MD_WITH_WARNING = `# g

## Phase 1

- [ ] T1 foo
  - Issue: 未起票（着手時に起票する）
`;

  it('runが終わったとき、ロードマップのパース警告がlog.warn経由で人へ届く（受入基準: 警告が人へ届く）', async () => {
    const warnCalls: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (message) => warnCalls.push(message),
      error: () => undefined,
      show: () => undefined,
    };
    const roadmapFs: RoadmapFileSystemPort = {
      readTextFile: async () => ROADMAP_MD_WITH_WARNING,
      writeTextFile: async () => undefined,
    };
    const { runner, codexHost } = createHarness(ROADMAP_YAML, {
      log,
      roadmap: { fs: roadmapFs },
    });
    const result = await runner.start('/repo/.agents/workflows/roadmap-warn.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const roadmapWarnLogs = warnCalls.filter((message) =>
      message.startsWith(`[workflow ${runId}] ロードマップの警告:`),
    );
    expect(roadmapWarnLogs).toHaveLength(1);
    expect(roadmapWarnLogs[0]).toContain('T1: Issue行を番号として読み取れませんでした');
  });

  it('ロードマップの警告が複数件あれば、その件数分だけlog.warnが呼ばれる', async () => {
    const warnCalls: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (message) => warnCalls.push(message),
      error: () => undefined,
      show: () => undefined,
    };
    const twoWarningsMd = `# g

## Phase 1

- [ ] T1 foo
  - Issue: 未起票（着手時に起票する）
- [z] broken checkbox line
`;
    const roadmapFs: RoadmapFileSystemPort = {
      readTextFile: async () => twoWarningsMd,
      writeTextFile: async () => undefined,
    };
    const { runner, codexHost } = createHarness(ROADMAP_YAML, {
      log,
      roadmap: { fs: roadmapFs },
    });
    const result = await runner.start('/repo/.agents/workflows/roadmap-warn-2.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const roadmapWarnLogs = warnCalls.filter((message) =>
      message.startsWith(`[workflow ${runId}] ロードマップの警告:`),
    );
    expect(roadmapWarnLogs).toHaveLength(2);
  });

  it('ロードマップの警告が無ければ、ロードマップの警告経由のlog.warnは呼ばれない', async () => {
    const warnCalls: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (message) => warnCalls.push(message),
      error: () => undefined,
      show: () => undefined,
    };
    const cleanMd = `# g

## Phase 1

- [ ] T1 foo
  - 依存: なし
`;
    const roadmapFs: RoadmapFileSystemPort = {
      readTextFile: async () => cleanMd,
      writeTextFile: async () => undefined,
    };
    const { runner, codexHost } = createHarness(ROADMAP_YAML, {
      log,
      roadmap: { fs: roadmapFs },
    });
    const result = await runner.start('/repo/.agents/workflows/roadmap-clean.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const roadmapWarnLogs = warnCalls.filter((message) =>
      message.startsWith(`[workflow ${runId}] ロードマップの警告:`),
    );
    expect(roadmapWarnLogs).toEqual([]);
  });
});

/**
 * 実行中のrunを抱えたまま拡張機能がdeactivateされたとき（ウィンドウのリロード等）、
 * `dispose()`がrunの資源をすべて解放することを確かめる（Issue #374）。
 *
 * `dispose()`は`live.orchestrator`と統合worktreeの占有しか解放しておらず、実行中のrunの
 * タスクセッション（CLIの子プロセス）・MCPサーバ（listen中のソケット）・
 * ポーリングタイマー（`setInterval`）・衝突解決セッションが残っていた。MCPサーバの後始末は
 * `pump()`のrun終了分岐にしか無く、実行中のrunでは一度も通らないため、リロードのたびに
 * ポートが積み上がる。
 */
describe('WorkflowRunner.dispose: 実行中のrunが抱える資源の解放（Issue #374）', () => {
  const YAML = `
version: 1
name: dispose-test
defaults:
  provider: codex
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  const ONE_TASK_YAML = `
version: 1
name: dispose-merge-test
defaults:
  provider: codex
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  /** 直列実行（`maxParallel: 1`）。T1が走っている間、T2は未着手（`pending`）で残る。 */
  const SERIAL_YAML = `
version: 1
name: dispose-serial-test
defaults:
  provider: codex
  maxParallel: 1
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('実行中のrunのタスクセッション・MCPサーバ・ポーリングタイマーを解放する', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    expect(t1.disposed).toBe(false);
    expect(t2.disposed).toBe(false);
    expect(state.handle?.closed).toBe(false);

    // 走行中のタイマーだけを数えるため、解放の直前からスパイする
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    runner.dispose();

    expect(t1.disposed).toBe(true);
    expect(t2.disposed).toBe(true);
    expect(state.handle?.closed).toBe(true);
    expect(state.handle?.closeCount).toBe(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // 二重に呼ばれても安全（冪等）。もう1度閉じにいかない
    expect(() => runner.dispose()).not.toThrow();
    expect(state.handle?.closeCount).toBe(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('衝突解決セッション（live.mergeResolutions）も解放する', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(ONE_TASK_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    // 衝突したのでmergingのまま、統合worktreeで衝突解決セッションが開いている
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const resolutionSession = codexHost.sessions.at(-1);
    expect(resolutionSession?.cwd.endsWith('_integration')).toBe(true);
    expect(resolutionSession?.disposed).toBe(false);

    runner.dispose();

    expect(resolutionSession?.disposed).toBe(true);
    // 冪等（2度目は対象が消えているので何もしない）
    expect(() => runner.dispose()).not.toThrow();
  });

  it('1つの解放が例外を投げても、残りの解放を続ける', async () => {
    const warnCalls: string[] = [];
    const log: Logger = { ...fakeLogger, warn: (message: string) => void warnCalls.push(message) };
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(YAML, { messaging: deps, log });
    await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    const t2 = codexHost.byTaskId('T2');
    t1.failDispose = new Error('タブの片付けに失敗しました');

    expect(() => runner.dispose()).not.toThrow();

    // 失敗した1件（T1）に引きずられず、残りのセッションとMCPサーバは解放される
    expect(t1.disposed).toBe(false);
    expect(t2.disposed).toBe(true);
    expect(state.handle?.closed).toBe(true);
    expect(warnCalls.some((m) => m.includes('終了時の解放に失敗しました'))).toBe(true);
  });

  it('MCPサーバのcloseが投げても、ポーリングタイマーは解放される', async () => {
    const { deps, state } = fakeMessagingDeps({ failClose: true });
    const { runner } = createHarness(YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    await flush();

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    expect(() => runner.dispose()).not.toThrow();

    expect(state.handle?.closeCount).toBe(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('run終了で閉じたあとにdispose()が来ても二重解放にならない', async () => {
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(YAML, { messaging: deps });
    await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    expect(state.handle?.closeCount).toBe(1);

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    expect(() => runner.dispose()).not.toThrow();
    expect(state.handle?.closeCount).toBe(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
  /**
   * `TaskSession.dispose()`は実装（`chatManagerBase.ts`の`teardown()`）が
   * `loop.stop('manual')`を先に呼ぶため、走行中のループの`onFinished`を`manual`で
   * **同期的に**発火する。これが`onTaskFinished`まで届くと、`applyLoopStopReason('manual')`が
   * taskIdを見ずに`haltedByUser`を立て、未着手の`pending`を全て`skipped`にしたうえで
   * `persist`する。deactivateしただけの実行が「人が手動停止した」ものとして永続化され、
   * 次の起動では`skipped`のタスクを手で1件ずつ再実行しないと続きが進まない
   * （Issue #374のレビュー指摘high）。`live.finished`は`pump()`を止めるだけで、
   * `onTaskFinished`自体の再入は止められない。
   */
  it('タスクセッションの解放が発火するonFinishedでrunの状態を書き換えない', async () => {
    const { runner, codexHost, store } = createHarness(SERIAL_YAML);
    const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // 直列実行なのでT1だけが走り、T2は未着手のまま残っている
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
    expect(store.find(runId)?.tasks['T2']?.state).toBe('pending');
    const persistedBefore = JSON.stringify(store.find(runId));

    // deactivate時、実タブの片付けが走行中のループを`manual`で止める
    codexHost.byTaskId('T1').disposeFinishReason = 'manual';
    const updateSpy = vi.spyOn(store, 'update');
    runner.dispose();
    await flush();

    // `runState`を書き換える側が黙るので、破棄をきっかけにした永続化がそもそも起きない
    // （`persist()`側に全面停止のガードは置いていない。Issue #374のレビュー2周目）
    expect(updateSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(store.find(runId))).toBe(persistedBefore);
    // メモリ上の`runState`も据え置き。未着手のT2が`skipped`へ倒れない
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.haltedByUser).toBe(false);
    expect(snapshot?.tasks.find((t) => t.id === 'T1')?.state).toBe('running');
    expect(snapshot?.tasks.find((t) => t.id === 'T2')?.state).toBe('pending');
  });

  /** 依存の無い2タスク。T1が衝突すると、T2のマージは統合worktreeの占有待ちで止まる。 */
  const PARALLEL_YAML = `
version: 1
name: dispose-lease-test
defaults:
  provider: codex
  maxParallel: 3
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  /**
   * 衝突解決セッションを抱えたままの破棄（経路1）。`dispose()`が
   * `live.mergeResolutions`のセッションを解放すると`onFinished('manual')`が同期的に
   * 発火し、`onMergeResolutionFinished`→`finishMergeResolution`の`manual`分岐が
   * `applyLoopStopReason(..., '', 'manual')`でrun全体を手動停止にしてしまう
   * （Issue #374のレビュー2周目のmedium）。`onTaskFinished`側の印だけでは塞げない別経路。
   */
  it('衝突解決セッションを抱えたままdispose()しても、runの状態を書き換えない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // T1が衝突して衝突解決セッションが開き、T2は占有待ちで`merging`のまま止まる
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);
    if (resolution === undefined) {
      throw new Error('衝突解決セッションが開かれていません');
    }
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
    const persistedBefore = JSON.stringify(store.find(runId));

    // deactivate時、実タブの片付けが解決セッションのループを`manual`で止める
    resolution.disposeFinishReason = 'manual';
    runner.dispose();
    await flush();

    // メモリ上の`runState`が汚染されない（修正前はここで`haltedByUser`が立っていた）
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.haltedByUser).toBe(false);
    expect(snapshot?.tasks.find((t) => t.id === 'T1')?.state).toBe('merging');
    expect(JSON.stringify(store.find(runId))).toBe(persistedBefore);
  });

  /**
   * 占有待ちのマージを抱えたままの破棄（経路2）。このテストが実際に固定しているのは
   * 「`dispose()`が`live.finished`を立ててから`releaseAllLeases()`を呼ぶことで、
   * 起こされた`decideAfterLeaseWait`が`live.finished`を見て`skip`を返す」という性質
   * （レビュー3周目のmedium）。`blockMergeAfterLeaseWait`冒頭の`isDisposing()`ガードは
   * 多層防御であり、この経路には現状到達しないため、削除してもこのテストの結果は
   * 変わらない（`decideAfterLeaseWait`が先に`skip`へ倒すため）。破棄しただけの実行は
   * 次の起動で`merging`から再判定（`resumeMergeAfterReload`）できなければならない、
   * という完了条件そのものは変わらない。
   */
  it('占有待ちのマージを抱えたままdispose()しても、mergingがblockedへ倒れない', async () => {
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    // T2は統合worktreeの占有待ち（`merging`のまま、マージは始まっていない）
    expect(store.find(runId)?.tasks['T2']?.state).toBe('merging');
    const persistedBefore = JSON.stringify(store.find(runId));

    runner.dispose();
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.tasks.find((t) => t.id === 'T2')?.state).toBe('merging');
    expect(snapshot?.warnings.some((w) => w.kind === 'mergeBusy' && w.taskId === 'T2')).toBe(false);
    expect(JSON.stringify(store.find(runId))).toBe(persistedBefore);
  });

  /**
   * **破棄の直前に積まれたpersistは、破棄の後にupdaterが走る**（レビュー2周目のmedium）。
   * `WorkflowRunStore.update`は`SerialQueue`越しで、しかもupdaterは`live.runState`を
   * 実行時点で読み直す（issue #381）。そのため`persist()`の冒頭で`disposing`を見て
   * 早期returnしても、**既にキューへ入っている**persistは素通りし、破棄中に汚染された
   * `runState`をそのままworkspaceStateへ書く。塞ぐには汚染そのものを起こさせるな、
   * という理屈の検証。
   */
  it('破棄の直前に積まれたpersistが破棄後に走っても、runの状態を汚染しない', async () => {
    const { memento, pendingCount, releaseOne } = controllableMemento();
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(PARALLEL_YAML, { git, memento });

    // `memento.update`を留め置くので、`start()`のpersistは手で解放しないと返らない
    const drainAll = async (): Promise<void> => {
      while (pendingCount() > 0) {
        releaseOne();
        await flush();
      }
    };
    const startPromise = runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    await flush();
    await drainAll();
    const result = await startPromise;
    const runId = result.runId as string;
    await flush();
    await drainAll();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    codexHost.byTaskId('T2').finish('done', doneState('ok'));
    await flush();
    const resolution = codexHost.sessions.at(-1);
    if (resolution === undefined) {
      throw new Error('衝突解決セッションが開かれていません');
    }
    // ここでは**あえて解放しない**。先頭の`memento.update`が未解決のまま
    // `SerialQueue`が詰まり、後続のpersistはupdater未実行のままキューに積まれている
    expect(pendingCount()).toBe(1);

    resolution.disposeFinishReason = 'manual';
    runner.dispose();
    await flush();

    // 破棄の後になってキュー待ちのupdaterが走る。読み直す`live.runState`が汚れていれば
    // そのまま永続化される（`persist()`の冒頭ガードでは止められない）
    await drainAll();

    const run = store.find(runId) as PersistedRun;
    expect(run.haltedByUser).toBe(false);
    expect(run.tasks['T1']?.state).toBe('merging');
    expect(run.tasks['T2']?.state).toBe('merging');
  });

  /**
   * `disposing`は破棄経路だけの印であり、人が明示的に止める`stop()`には影響しない
   * （手動停止では従来どおり`haltedByUser`が立ち、未着手の`pending`は`skipped`になる）。
   *
   * このテスト自体は今回の修正（`dispose()`の全面片付け化）が触ったコードを経由しない
   * （レビュー3周目のlow）。`stop()`は`disposing`を参照しないため回帰テストではなく、
   * 「将来`stop()`が`disposing`を参照するようになったら落ちる」という性質を先んじて
   * 固定しておくためのテスト
   */
  it('disposingはstop()に影響しない（手動停止は従来どおり確定する）', async () => {
    const { runner, codexHost, store } = createHarness(SERIAL_YAML);
    const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    expect(store.find(runId)?.tasks['T2']?.state).toBe('pending');

    runner.stop(runId);
    await flush();
    codexHost.byTaskId('T1').finish('taskStopped' as LoopStopReason, { ...initialChatState });
    await flush();

    const run = store.find(runId) as PersistedRun;
    expect(run.haltedByUser).toBe(true);
    expect(run.tasks['T2']?.state).toBe('skipped');
  });

  describe('ensureMessagingはdisposing中・後の到達を防ぐ（Issue #475/PR #495レビュー指摘: high）', () => {
    /**
     * `dispose()`後にretryTaskで再開しても、CLIセッションそのものが再度開かない
     * （Issue #502）。
     *
     * このテストはもともとIssue #475/PR #495の回帰確認として書かれ、「`ensureMessaging`が
     * `this.disposing`を見てメッセージング資源（HTTPリスナー・ポーリングタイマー）だけは
     * 新たに立てない」ことだけを検証していた。当時は`startTask`→`prepareTaskLaunch`の
     * 先、`host.openTaskSession`の呼び出し自体は`disposing`を見ずに素通りしており、
     * `retryTask`後にCLIセッションそのものは新しく開いてしまっていた（`mcp`接続URLだけが
     * 付かない状態）。PR #495はこの挙動を「MCPサーバ（HTTPリスナーと`setInterval`）が
     * 破棄後に立つ経路を塞いだ」に留め、CLIセッションが破棄後に開く経路は意図的に
     * スコープ外とした（そのままだと、そのCLI子プロセスを所有する`WorkflowRunner`が
     * 既に破棄済みのため、二度と閉じる経路が無いまま残り続ける）。
     *
     * Issue #502はこの窓を独立して扱い、`startTask`内・`host.openTaskSession`呼び出しの
     * 直前へ`this.disposing`の番人を置いて塞いだ。`this.runs`からrunを削除する経路が無い
     * ため`live`は`dispose()`後も解決でき、`retryTask`自体も`this.disposing`を見ないため
     * `{ ok: true }`を返すが、その先でCLIセッションの起動自体が止まる。このテストは
     * その結果として、`retryTask`後もCLIセッション・MCPサーバ・タイマーのいずれも
     * 新たに立たないことを確認する
     */
    it('dispose()後にretryTaskで再開してもCLIセッション・MCPサーバ・タイマーを新たに立てない', async () => {
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost, store } = createHarness(ONE_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      expect(state.startCallCount).toBe(1);
      const t1InputsBeforeDispose = codexHost.openInputs.filter((i) =>
        cwdEndsWithTask(i.cwd, 'T1'),
      );
      expect(t1InputsBeforeDispose).toHaveLength(1);

      // run終了（T1失敗）でMCPサーバは通常どおり閉じる
      codexHost.byTaskId('T1').finish('failed', { ...initialChatState, turnFailed: true });
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
      expect(state.handle?.closed).toBe(true);

      // 拡張機能の終了。以後`this.disposing`はずっとtrueのまま（二度とfalseへ戻らない）
      runner.dispose();

      // 人の「再実行」操作と同じ経路（`live.finished`を解除して`pump()`を呼び直す）。
      // `retryTask`自体は`this.disposing`を見ないため`{ ok: true }`を返すが、
      // その先の`startTask`（`host.openTaskSession`直前のガード、Issue #502）で止まるべき
      expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
      await flush();

      // 新しいtransportは立たない
      expect(state.startCallCount).toBe(1);
      // CLIセッションそのものも新しく開かない（dispose前の1件のまま増えない）
      const t1InputsAfterRetry = codexHost.openInputs.filter((i) => cwdEndsWithTask(i.cwd, 'T1'));
      expect(t1InputsAfterRetry).toHaveLength(1);
      expect(codexHost.sessions).toHaveLength(1);
    });

    /**
     * `startTransport`の`await`中に`dispose()`が完了する窓（入口のガードだけでは
     * 塞げない）。この窓で立ち上がってしまったtransportを`live.messaging`へ渡さず、
     * その場で閉じることを確認する。
     */
    it('startTransportの待機中にdispose()が完了すると、立ち上がったtransportは使われず閉じる', async () => {
      const { deps, state } = fakeMessagingDeps({ blockStart: true });
      const { runner, codexHost, store } = createHarness(ONE_TASK_YAML, { messaging: deps });
      const result = await runner.start('/repo/.agents/workflows/dispose.yaml', '/repo');
      const runId = result.runId as string;
      await flush();
      expect(state.startCallCount).toBe(1);

      codexHost.byTaskId('T1').finish('failed', { ...initialChatState, turnFailed: true });
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
      expect(state.handle?.closed).toBe(true);

      // retryTaskで再開する。2回目の`startTransport`呼び出しなので`blockStart`により
      // `releaseStart()`を呼ぶまで保留される
      expect(runner.retryTask(runId, 'T1')).toEqual({ ok: true });
      await flush();
      expect(state.startCallCount).toBe(2);

      // 保留中に拡張機能が終了する
      runner.dispose();

      // 保留していたstartTransportを解決させる。ここで初めてtransportのhandleが作られる
      state.releaseStart();
      await flush();

      // 解決したtransportは`live.messaging`へ渡されず、その場で閉じられる
      expect(state.handle?.closed).toBe(true);
      expect(state.handle?.closeCount).toBe(1);
    });
  });
});

/**
 * 衝突解決セッションの承認待ちアイドルタイムアウト（design.md §16.17「承認待ちの
 * アイドルタイムアウト」、Issue #413 PR5）。
 *
 * PR4（Issue #413）は`live.mergeResolutions`（`MergeResolutionEntry.waitingApprovalSinceMs`）で
 * 承認待ちの可視化だけを行った。このPRはその値を経過時間の起点として使い、
 * `agent.workflows.mergeApprovalTimeoutSec`（既定3600秒）を超えたら自動的に
 * `session.stopLoop()`を呼び、対象タスクだけを`blocked`にする。
 *
 * 並行作業（Issue #528〜531）との衝突を避けるため、既存の`describe`ブロックへは
 * 差し込まず、ファイル末尾に新しいブロックとして追加する（申し送り事項参照）。
 */
describe('WorkflowRunner: 衝突解決セッションの承認待ちアイドルタイムアウト（design.md §16.17、Issue #413 PR5）', () => {
  const YAML = `
version: 1
name: merge-approval-timeout-test
defaults:
  provider: codex
  maxParallel: 2
tasks:
  - id: T1
    prompt: p1
    done: d1
  - id: T2
    prompt: p2
    done: d2
`;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const APPROVAL_STATE: ChatState = {
    ...initialChatState,
    approvals: [{ requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined }],
  };

  it(
    '承認待ちがmergeApprovalTimeoutSecを超えると衝突解決セッションを停止し、' +
      '対象タスクだけをblockedにする（run全体は停止せず、独立タスクは開始できる）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ conflictOnce: true });
      const { runner, codexHost, store } = createHarness(YAML, {
        git,
        readMergeApprovalTimeoutSec: () => 60,
      });
      const result = await runner.start(
        '/repo/.agents/workflows/merge-approval-timeout.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // T1は衝突したのでmergingのまま。maxParallel:2の枠を占めるが、T2（独立タスク）は
      // 通常どおりすぐ開始できる（衝突・承認待ちとは無関係）
      expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
      expect(store.find(runId)?.tasks['T2']?.state).toBe('running');

      const resolutionSession = codexHost.sessions.at(-1);
      expect(resolutionSession).toBeDefined();

      // 承認カードが出て、解決セッションが人待ちになった（PR4の可視化と同じ発火点）
      resolutionSession?.emitState(APPROVAL_STATE);
      await flush();
      expect(
        runner.getSnapshot(runId)?.tasks.find((t) => t.id === 'T1')?.mergeResolutionWaitingApproval,
      ).toBe(true);

      // 閾値の直前ではまだ止めない（経過時間の閾値そのものを検証する）
      await vi.advanceTimersByTimeAsync(59_000);
      await flush();
      expect(resolutionSession?.stopLoopCount).toBe(0);

      // 閾値を超えたら自動的にstopLoopを呼ぶ
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(resolutionSession?.stopLoopCount).toBe(1);

      // `TaskSession.stopLoop()`は`LoopStopReason: 'taskStopped'`でonFinishedを呼ぶ
      // （フェイクはカウントだけなので、既存テストと同じく`finish()`で模擬する）
      resolutionSession?.finish('taskStopped' as LoopStopReason, APPROVAL_STATE);
      await flush();

      // マージの巻き戻し（`git merge --abort`）は呼ばれない（Issue #434と同じ非破壊分岐）
      const abortCall = git.calls.find((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
      expect(abortCall).toBeUndefined();

      // 対象タスクだけがblockedになる
      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      const warnings = runner.getSnapshot(runId)?.warnings ?? [];
      expect(warnings.some((w) => w.kind === 'mergeApprovalTimeout' && w.taskId === 'T1')).toBe(
        true,
      );

      // **run全体は停止しない。** `haltedByUser`が立たず、既に開始済みのT2は
      // 通常どおり走り続ける（`applyLoopStopReason`の全体停止分岐へ合流していないことの確認。
      // 合流していれば`haltedByUser`がtrueになり、以後の新規タスク開始が止まる）
      expect(store.find(runId)?.haltedByUser).toBe(false);
      expect(store.find(runId)?.tasks['T2']?.state).toBe('running');
    },
  );

  it('承認待ちで無い間（LLMが作業中）は計測しない', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost, store } = createHarness(YAML, {
      git,
      readMergeApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start(
      '/repo/.agents/workflows/merge-approval-timeout-2.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const resolutionSession = codexHost.sessions.at(-1);
    // 承認カードを一度も出さない（LLMが作業中のまま）。閾値を大きく超えて進めても
    // 停止してはいけない
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();

    expect(resolutionSession?.stopLoopCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('merging');
  });

  it('一度承認待ちを抜けると計測がリセットされる（再び承認待ちになったら1から数え直す）', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost } = createHarness(YAML, {
      git,
      readMergeApprovalTimeoutSec: () => 60,
    });
    await runner.start('/repo/.agents/workflows/merge-approval-timeout-3.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();

    // 閾値の途中で承認が解消された（LLMの作業が再開した）
    await vi.advanceTimersByTimeAsync(50_000);
    resolutionSession?.emitState({ ...initialChatState, approvals: [] });
    await flush();

    // 元の閾値（60秒）を超えて進めても、計測はリセットされているので停止しない
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(resolutionSession?.stopLoopCount).toBe(0);

    // 再び承認待ちに入ってから60秒経てば、そこから数え直して停止する
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    await flush();
    expect(resolutionSession?.stopLoopCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(resolutionSession?.stopLoopCount).toBe(1);
  });

  it('設定を渡さない場合は既定の1時間（3600秒）が使われる', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ conflictOnce: true });
    // readMergeApprovalTimeoutSecを渡さない
    const { runner, codexHost } = createHarness(YAML, { git });
    await runner.start('/repo/.agents/workflows/merge-approval-timeout-4.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();

    await vi.advanceTimersByTimeAsync(3600 * 1000 - 1_000);
    await flush();
    expect(resolutionSession?.stopLoopCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(resolutionSession?.stopLoopCount).toBe(1);
  });

  it('同一taskIdの直近1件へ丸める（再マージ後に再びタイムアウトしても警告は積み増さない）', async () => {
    vi.useFakeTimers();
    // `conflictEveryMerge`: 「再マージ」しても再び衝突させ、承認待ちタイムアウトを
    // 同じタスクで2回起こせるようにする（Issue #439の`mergeBusy`と同じ「人が何度でも
    // 押せる操作」の丸め込みを確かめる）
    const git = fakeGit({ conflictOnce: true, conflictEveryMerge: true });
    const { runner, codexHost, store } = createHarness(YAML, {
      git,
      readMergeApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start(
      '/repo/.agents/workflows/merge-approval-timeout-5.yaml',
      '/repo',
    );
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    let resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    resolutionSession?.finish('taskStopped' as LoopStopReason, APPROVAL_STATE);
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    // 「再マージ」でやり直す。未解決の統合worktree（MERGE_HEAD）を人が片付けた体で
    // `resolveConflict()`を呼んでから再マージする（片付けないと`mergeTaskBranch`の
    // busyゲートに引っかかり、新しい衝突解決セッションがそもそも開かない）
    git.resolveConflict();
    expect(runner.retryMerge(runId, 'T1')).toBe(true);
    await flush();

    resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    resolutionSession?.finish('taskStopped' as LoopStopReason, APPROVAL_STATE);
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

    const warnings =
      runner.getSnapshot(runId)?.warnings.filter((w) => w.kind === 'mergeApprovalTimeout') ?? [];
    expect(warnings).toHaveLength(1);
  });

  it('WorkflowRunner.dispose()は承認待ちタイムアウトのタイマーも解放する', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const git = fakeGit({ conflictOnce: true });
    const { runner, codexHost } = createHarness(YAML, {
      git,
      readMergeApprovalTimeoutSec: () => 60,
    });
    await runner.start('/repo/.agents/workflows/merge-approval-timeout-6.yaml', '/repo');
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const resolutionSession = codexHost.sessions.at(-1);
    resolutionSession?.emitState(APPROVAL_STATE);
    await flush();

    const callsBeforeDispose = clearTimeoutSpy.mock.calls.length;
    runner.dispose();
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeDispose);
  });

  /**
   * Issue #539: 「再マージ」（`retryMerge`）は`haltedByUser`を解除しない（design.md
   * §16.17「再マージ」・`markMergeRetried`のJSDoc参照）。そのため、実行全体が停止した
   * 状態のまま新しい衝突解決セッションが開くことがある。そのセッションが承認待ちに
   * 入ってタイムアウトしても、`merging`のまま放置されず対象タスクだけが`blocked`へ
   * 確定すること（run全体の`haltedByUser`は変えない）を確認する。
   */
  it(
    '実行全体が停止した状態で開いた衝突解決セッションでも、承認待ちタイムアウトで' +
      '対象タスクがblockedへ確定する（Issue #539）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ conflictOnce: true, conflictEveryMerge: true });
      const { runner, codexHost, store } = createHarness(YAML, {
        git,
        readMergeApprovalTimeoutSec: () => 60,
      });
      const result = await runner.start(
        '/repo/.agents/workflows/merge-approval-timeout-halted.yaml',
        '/repo',
      );
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      let resolutionSession = codexHost.sessions.at(-1);
      resolutionSession?.emitState(APPROVAL_STATE);
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      resolutionSession?.finish('taskStopped' as LoopStopReason, APPROVAL_STATE);
      await flush();
      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');

      // 実行全体を停止する（`haltedByUser`が立つ）
      runner.stop(runId);
      await flush();
      expect(store.find(runId)?.haltedByUser).toBe(true);

      // 停止中に「再マージ」を行う（Issue #517/#525で正規化された経路。`retryMerge`は
      // `haltedByUser`を解除しない）
      git.resolveConflict();
      expect(runner.retryMerge(runId, 'T1')).toBe(true);
      await flush();
      expect(store.find(runId)?.haltedByUser).toBe(true);

      resolutionSession = codexHost.sessions.at(-1);
      resolutionSession?.emitState(APPROVAL_STATE);
      await flush();

      // 停止中に開いた新しい衝突解決セッションでも、承認待ちタイムアウトが機能する
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(resolutionSession?.stopLoopCount).toBe(1);

      resolutionSession?.finish('taskStopped' as LoopStopReason, APPROVAL_STATE);
      await flush();

      // `merging`のまま放置されない。run全体の`haltedByUser`（人が明示的に止めた事実）は
      // タイムアウトでは変えない
      expect(store.find(runId)?.tasks['T1']?.state).toBe('blocked');
      expect(store.find(runId)?.haltedByUser).toBe(true);
    },
  );
});

/**
 * design.md §16.26（最終マージの判断、Issue #335）。
 *
 * `finalMerge: orchestrator | confirm` は統合PR/MR作成後にmainへ即マージせず、判断待ちの
 * 状態へ入る。判断は`decide_final_merge`（MCP、orchestratorモードのみ）／Webviewの
 * ボタン（confirmモードのみ）／タイムアウト（orchestratorモードのみ）のいずれかで確定し、
 * どの経路でも`WorkflowRunner.decideFinalMerge(runId, decision, reason)`へ合流する。
 *
 * 判断待ちの間はMCPサーバー（`state.handle`）を閉じない（`decide_final_merge`を呼べる
 * 状態を保つため）。決着後に閉じる。この開閉のタイミングそのものが今回の実装で見つけた
 * 既存の欠陥（`pump()`がfinalizeForgeの完了を待たずに閉じていた）の修正対象であり、
 * `state.handle?.closed`で直接検証する。
 */
describe('WorkflowRunner: 最終マージの判断（design.md §16.26、Issue #335）', () => {
  const SINGLE_TASK_YAML = `
version: 1
name: final-merge-decision-test
tasks:
  - id: T1
    prompt: p1
    done: d1
`;

  /**
   * 制御ツールの実体（オーケストレーター専用接続に見せているもの）を取り出す。
   * 「WorkflowRunner: オーケストレーターの制御ツール」describeのローカルヘルパーと
   * 同じ実装（このdescribeのスコープからは参照できないため複製）。
   */
  function control(state: FakeMessagingState): OrchestratorControlPort {
    const port = state.hub?.orchestratorControl;
    if (port === undefined) {
      throw new Error('制御ツールが配線されていません');
    }
    return port;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it(
    'finalMerge: orchestratorはPR/MR作成後、即マージせず判断待ちを警告欄へ記録し、' +
      'MCPサーバーを開けたままにする',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const cli = fakeForgeCli();
      const { deps, state } = fakeMessagingDeps();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
        messaging: deps,
      });
      const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      const t1 = codexHost.byTaskId('T1');
      t1.finish('done', doneState('ok'));
      await flush();

      // 統合PR/MRは作られているが、mainへのマージはまだ呼ばれていない
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(true);
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);

      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.finalMergeOutcome).toBeUndefined();
      expect(snapshot?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });
      expect(
        snapshot?.warnings.some(
          (w) => w.kind === 'finalMergeDecision' && w.message.includes('待っています'),
        ),
      ).toBe(true);

      // decide_final_mergeを呼べる状態を保つため、MCPサーバーはまだ閉じない
      expect(state.handle?.closed).toBe(false);
    },
  );

  it('decideFinalMerge(merge)は最終マージを実行し、決定と理由を警告欄へ記録してMCPサーバーを閉じる', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const accepted = runner.decideFinalMerge(runId, 'merge', 'CIが全緑のため');
    await flush();

    expect(accepted).toBe(true);
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(true);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBe('merged');
    expect(snapshot?.finalMergeDecision).toBeUndefined();
    expect(
      snapshot?.warnings.some(
        (w) =>
          w.kind === 'finalMergeDecision' &&
          w.message.includes('merge') &&
          w.message.includes('CIが全緑のため'),
      ),
    ).toBe(true);
    // 判断が確定したので、遅らせていたMCPサーバーの解放が進む
    expect(state.handle?.closed).toBe(true);
  });

  it('decideFinalMerge(hold)はマージせずheldとして扱い、理由を警告欄へ記録する', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
    });
    const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    const accepted = runner.decideFinalMerge(runId, 'hold', 'レビュー未完了のため');
    await flush();

    expect(accepted).toBe(true);
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBe('held');
    expect(store.find(runId)?.finalMergeOutcome).toBe('held');
    expect(
      snapshot?.warnings.some(
        (w) => w.kind === 'finalMergeDecision' && w.message.includes('レビュー未完了のため'),
      ),
    ).toBe(true);
  });

  it('判断待ちが無い状態でdecideFinalMergeを呼んでもfalseを返し、何も変えない（二重確定・不明runId対策）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      // finalMerge: auto。判断待ちが発生しない
      forge: fakeForgeDeps(cli, { finalMerge: 'auto' }),
    });
    const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(runner.decideFinalMerge(runId, 'merge', 'x')).toBe(false);
    expect(runner.decideFinalMerge('unknown-run', 'merge', 'x')).toBe(false);
  });

  it('decide_final_mergeは上限超過のreasonを受付自体で拒否する（update_task_promptと同じ流儀）', async () => {
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    const tooLong = control(state).decideFinalMerge('merge', 'x'.repeat(4001));

    expect(tooLong.accepted).toBe(false);
    expect(tooLong.reason).toContain('4000');
    // 拒否されたので判断待ちは解消されず、マージも実行されない
    expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({
      mode: 'orchestrator',
    });
    expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
  });

  it(
    'finalMerge: orchestratorは応答が無いままagent.workflows.finalMergeDecisionTimeoutSecを' +
      '超えると自動的にholdへ倒す（design.md §16.26。processを無期限に止めないための保険）',
    async () => {
      vi.useFakeTimers();
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const cli = fakeForgeCli();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
        readFinalMergeDecisionTimeoutSec: () => 60,
      });
      const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      codexHost.byTaskId('T1').finish('done', doneState('ok'));
      await flush();

      expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });

      // 閾値の直前ではまだ倒さない
      await vi.advanceTimersByTimeAsync(59_000);
      await flush();
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBeUndefined();

      // 閾値を超えたら自動的にholdへ倒す
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();

      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.finalMergeOutcome).toBe('held');
      expect(snapshot?.finalMergeDecision).toBeUndefined();
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      expect(snapshot?.warnings.some((w) => w.kind === 'finalMergeDecision')).toBe(true);
    },
  );

  it(
    '人が「全体の停止」を押した後は、オーケストレーターがdecide_final_merge相当（' +
      "decideFinalMerge）でdecision: 'merge'を呼んでもmainへマージされない（" +
      'レビュー指摘。他の判断系制御ツールと同じくhaltedByUserを見る）',
    async () => {
      const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
      const cli = fakeForgeCli();
      const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
        git,
        forge: fakeForgeDeps(cli, { finalMerge: 'orchestrator' }),
      });
      const result = await runner.start('/repo/.agents/workflows/final-merge-halt.yaml', '/repo');
      const runId = result.runId as string;
      await flush();

      codexHost.byTaskId('T1').finish('done', doneState('ok'));
      await flush();

      expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });

      // 全タスクが既に完了しているため、stop()はhaltedByUserを立てるだけでoutcomeは
      // succeededのまま変わらない（getRunOutcomeはpending/runningの残りが無い限りskip扱いに
      // しない）。判断待ちの状態で「全体の停止」が押されるケースそのものが再現できる
      runner.stop(runId);
      await flush();
      expect(runner.getSnapshot(runId)?.outcome).toBe('succeeded');

      const accepted = runner.decideFinalMerge(runId, 'merge', '停止後に無理やりマージを試みる');
      await flush();

      expect(accepted).toBe(false);
      expect(cli.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
      const snapshot = runner.getSnapshot(runId);
      expect(snapshot?.finalMergeOutcome).toBeUndefined();
      // 判断待ちの状態自体は解除されない（拒否しただけで、タイムアウトによる自動holdは
      // 引き続き効く。holdは安全側なので拒否しない）
      expect(snapshot?.finalMergeDecision).toMatchObject({ mode: 'orchestrator' });

      // holdは拒否しない（安全側。タイムアウトの自動hold呼び出しも同じ経路を通るため、
      // ここを塞ぐと判断待ちが無期限に解消されなくなる）
      const heldAccepted = runner.decideFinalMerge(runId, 'hold', '停止後なのでholdにする');
      await flush();
      expect(heldAccepted).toBe(true);
      expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBe('held');
    },
  );

  it('finalMerge: confirmはタイムアウトしない（人の応答時間は予測できないため）', async () => {
    vi.useFakeTimers();
    const git = fakeGit({ originRemoteUrl: 'git@github.com:acme/repo.git', headBranch: 'main' });
    const cli = fakeForgeCli();
    const { runner, codexHost } = createHarness(SINGLE_TASK_YAML, {
      git,
      forge: fakeForgeDeps(cli, { finalMerge: 'confirm' }),
      readFinalMergeDecisionTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/final-merge.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    codexHost.byTaskId('T1').finish('done', doneState('ok'));
    await flush();

    expect(runner.getSnapshot(runId)?.finalMergeDecision).toMatchObject({ mode: 'confirm' });

    // 閾値を大きく超えて進めても倒れない（confirmにはタイムアウトが効かない）
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();

    const snapshot = runner.getSnapshot(runId);
    expect(snapshot?.finalMergeOutcome).toBeUndefined();
    expect(snapshot?.finalMergeDecision).toMatchObject({ mode: 'confirm' });

    // 人が判断すれば通常どおり確定する
    expect(runner.decideFinalMerge(runId, 'merge', '人が確認済み')).toBe(true);
    await flush();
    expect(runner.getSnapshot(runId)?.finalMergeOutcome).toBe('merged');
  });
});

describe('worktree撤去の試行回数の上限（Issue #490）', () => {
  const YAML = `
version: 1
name: removal-cap-test
defaults:
  cleanup: keep
tasks:
  - id: T1
    prompt: p
    done: d
`;

  /**
   * `manualRetryCount`を大きな値にしたrunを永続化してから復元する。
   *
   * `retryTask`を実際に何百回も呼ぶ代わりに復元経路を使う。**この上限は「人が
   * ワークフローViewの再実行を押し続けた」ときに効くもので、押した回数そのものを
   * 再現する必要は無い**——撤去側が見るのは`retryCount + manualRetryCount`の値だけで
   * あり、その値がどう積み上がったかには依存しない。
   */
  async function reloadedRunWithRetries(
    store: WorkflowRunStore,
    runId: string,
    manualRetryCount: number,
  ): Promise<void> {
    await store.update(runId, () => ({
      runId,
      defPath: '/repo/.agents/workflows/removal-cap.yaml',
      workspaceRoot: '/repo',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      tasks: {
        T1: {
          state: 'done',
          sessionId: 'session-1',
          cwd: `/repo/.agents/worktrees/${runId}/T1`,
          branch: `wf/${runId}/T1`,
          submissionCount: 1,
          retryCount: 0,
          manualRetryCount,
          failure: undefined,
          pullRequestNumber: undefined,
          pullRequestUrl: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
      integrationPullRequestNumber: undefined,
      integrationPullRequestUrl: undefined,
      finalMergeOutcome: undefined,
      pendingAskUser: undefined,
    }));
  }

  function makeRunner(
    store: WorkflowRunStore,
    git: FakeGitHandle,
    warn: (message: string) => void,
    pseudoFs?: FakePseudoFs,
  ): WorkflowRunner {
    return new WorkflowRunner({
      hosts: { codex: new FakeHost(), claude: new FakeHost() },
      worktreeQueue: new WorktreeCreationQueue(),
      git,
      fs: identityFs,
      filePort: filePort(YAML),
      store,
      log: { ...fakeLogger, warn },
      ...(pseudoFs === undefined ? {} : { pseudoWorktree: { fs: pseudoFs, exclude: [] } }),
      readBaseline: () => ({
        codexSandbox: 'read-only',
        codexApprovalMode: 'on-request',
        claudePermissionMode: 'manual',
        allowAutoApprove: true,
        allowClaudeBypassPermissions: false,
      }),
    });
  }

  it('git側: 上限を超える再試行があっても、撤去の試行は「初回＋上限回」で頭打ちになる', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000490';
    await reloadedRunWithRetries(store, runId, MAX_WORKTREE_REMOVAL_ATTEMPTS + 250);

    const git = fakeGit();
    const warnings: string[] = [];
    const runner = makeRunner(store, git, (m) => warnings.push(m));
    await runner.restoreRunsForView();

    await runner.removeWorktrees(runId);

    const removeCalls = git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    // 「初回（retryなし）＋ 0..上限-1」で上限+1回。上限が効いていなければ351回になる
    expect(removeCalls).toHaveLength(MAX_WORKTREE_REMOVAL_ATTEMPTS + 1);
    // 撤去されずに残る分があることを人へ知らせる（黙って諦めない）
    expect(warnings.some((m) => m.includes('残ります'))).toBe(true);
  });

  it('疑似worktree側: git側と同じ上限が効く（片方だけだと対称性が崩れる）', async () => {
    const store = new WorkflowRunStore(fakeMemento());
    const runId = '00000000-0000-4000-8000-000000000491';
    await reloadedRunWithRetries(store, runId, MAX_WORKTREE_REMOVAL_ATTEMPTS + 250);

    const git = fakeGit({ notGitRepo: true });
    const pseudoFs = new FakePseudoFs();
    const realpathCalls: string[] = [];
    const originalRealpath = pseudoFs.realpath.bind(pseudoFs);
    pseudoFs.realpath = async (target: string): Promise<string | undefined> => {
      realpathCalls.push(target);
      return originalRealpath(target);
    };
    const warnings: string[] = [];
    const runner = makeRunner(store, git, (m) => warnings.push(m), pseudoFs);
    await runner.restoreRunsForView();

    await runner.removeWorktrees(runId);

    // 撤去対象のパスに対する`realpath`の回数で数える。撤去そのもの（`removeDirRecursive`）は
    // 対象が存在しなければ呼ばれないため、**呼ばれないことが上限のせいなのか不在のせいなのかを
    // 区別できない**。`realpath`は試行ごとに必ず1回通る
    const t1Calls = realpathCalls.filter((p) => p.includes(`/${runId}/T1`));
    expect(t1Calls).toHaveLength(MAX_WORKTREE_REMOVAL_ATTEMPTS + 1);
    expect(warnings.some((m) => m.includes('残ります'))).toBe(true);
  });
});
