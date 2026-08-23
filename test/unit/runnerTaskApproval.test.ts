import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialChatState, type ChatState } from '../../src/appserver/chatState';
import type { ApprovalDecision } from '../../src/appserver/approvals';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import {
  WAITING_REPLY_POLL_INTERVAL_MS,
  WorkflowRunner,
  type WorkflowFilePort,
  type WorkflowRunnerMessagingDeps,
} from '../../src/orchestrator/runner';
import { ORCHESTRATOR_CONNECTION_ID } from '../../src/orchestrator/orchestratorSession';
import type { HttpMcpTransportHandle, TaskMessagingHub } from '../../src/orchestrator/messaging';
import { WorkflowRunStore, type WorkflowRunMemento } from '../../src/orchestrator/runStore';
import {
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';
import type { Provider } from '../../src/orchestrator/workflow';
import type { Logger } from '../../src/log';

/**
 * Issue #579の再現テスト（design.md §16.39）。通常タスクの`waitingApproval`に時間切れの
 * 解放が無いこと（RED実測はハンドオフファイル・PR説明に記録）と、実装後は
 * `agent.workflows.taskApprovalTimeoutSec`を超えたら`failed`（理由`taskApprovalTimedOut`）
 * へ倒れることを確認する。あわせて、その副次効果（承認待ちが1件あると他タスクの
 * 返信待ち解放まで止まる、`checkWaitingReplyStalls`の経路1）の修正も確認する。
 *
 * ヘルパー（`createHarness`/`FakeTaskSession`/`flush`等）は`runner.test.ts`・
 * `runnerDispose.test.ts`のものと同趣旨だが、指示（`test/unit/runner.test.ts`は他の回でも
 * 触るため新規ファイルへ置くこと）に従い自己完結させて重複定義している。
 */

const fakeLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  show: () => undefined,
};

class FakeTaskSession implements TaskSession {
  readonly sessionId: string;
  runLoopCalls: LoopPlan[] = [];
  approvalHandler: ApprovalHandler | undefined;
  disposed = false;
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

  runLoop(plan: LoopPlan): void {
    this.runLoopCalls.push(plan);
  }
  send(): void {
    // このテストでは使わない
  }
  setPromptTransform(): void {
    // このテストでは使わない
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
  onApprovalResolved(listener: (outcome: ApprovalOutcome) => void): void {
    this.approvalResolvedListeners.push(listener);
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  pauseLoop(): void {
    // このテストでは使わない
  }
  resumeLoop(): void {
    // このテストでは使わない
  }
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(true);
  }
  stopLoopCount = 0;
  stopLoop(): boolean {
    this.stopLoopCount += 1;
    return true;
  }
  decideApproval(): void {
    // このテストでは使わない（`resolveApproval`で直接`onApprovalResolved`を発火させる）
  }
  reveal(): void {
    // このテストでは使わない
  }
  open(): void {
    // このテストでは使わない（同期発火系のフラグは持たない）
  }
  dispose(): void {
    this.disposed = true;
  }

  // ---- テスト用の操作 ----
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
  sessions: FakeTaskSession[] = [];
  orchestratorSessions: FakeTaskSession[] = [];
  private counter = 0;

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
    if (input.role === 'orchestrator') {
      this.orchestratorSessions.push(session);
      return session;
    }
    this.sessions.push(session);
    return session;
  }

  byTaskId(taskId: string): FakeTaskSession {
    const found = this.sessions.find((s) => s.cwd.endsWith(`/${taskId}`) || s.cwd === taskId);
    if (found === undefined) {
      throw new Error(`taskId=${taskId}のセッションが見つかりません`);
    }
    return found;
  }
}

interface FakeGitHandle extends GitCommandRunner {
  calls: Array<{ args: string[]; cwd: string }>;
}

function fakeGit(): FakeGitHandle {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    calls,
    async run(args, cwd) {
      calls.push({ args: [...args], cwd });
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { code: 1, stdout: '', stderr: "error: No such remote 'origin'" };
      }
      if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add' && args[1] === '-A') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'commit') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'log') {
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

function filePort(content: string): WorkflowFilePort {
  return {
    fileSize: async () => Buffer.byteLength(content, 'utf8'),
    readTextFile: async () => content,
  };
}

/** マイクロタスクを十分な回数流し、非同期の起動チェーンを進める。 */
async function flush(times = 100): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  runner: WorkflowRunner;
  codexHost: FakeHost;
  store: WorkflowRunStore;
}

function createHarness(
  yaml: string,
  options?: {
    readTaskApprovalTimeoutSec?: () => number;
    readMergeApprovalTimeoutSec?: () => number;
    messaging?: WorkflowRunnerMessagingDeps;
    readReplyTimeoutSec?: () => number;
  },
): Harness {
  const codexHost = new FakeHost();
  const claudeHost = new FakeHost();
  const store = new WorkflowRunStore(fakeMemento());
  const hosts: Record<Provider, TaskSessionHost> = { codex: codexHost, claude: claudeHost };
  let seq = 0;
  const runner = new WorkflowRunner({
    hosts,
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
    readAutoResume: () => false,
    ...(options?.readTaskApprovalTimeoutSec !== undefined
      ? { readTaskApprovalTimeoutSec: options.readTaskApprovalTimeoutSec }
      : {}),
    ...(options?.readMergeApprovalTimeoutSec !== undefined
      ? { readMergeApprovalTimeoutSec: options.readMergeApprovalTimeoutSec }
      : {}),
    ...(options?.messaging !== undefined ? { messaging: options.messaging } : {}),
    randomId: () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`,
  });
  return { runner, codexHost, store };
}

/** 危険と判定される要求（既存の`runner.test.ts`と同じ`git push --force`）。 */
async function requestDangerousApproval(session: FakeTaskSession, cwd: string) {
  return session.requestApproval(
    { requestId: 1, kind: 'command', title: '', detail: '', itemId: undefined },
    { command: 'git push --force origin main', cwd },
  );
}

const SINGLE_TASK_YAML = `
version: 1
name: task-approval-timeout
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
`;

const PARENT_CHILD_YAML = `
version: 1
name: task-approval-timeout-cascade
tasks:
  - id: T1
    autoApprove: true
    prompt: p
    done: d
  - id: T2
    dependsOn: [T1]
    prompt: p2
    done: d2
`;

describe('通常タスクのwaitingApprovalタイムアウト（Issue #579、design.md §16.39）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('taskApprovalTimeoutSecを超えたwaitingApprovalは、failed(taskApprovalTimedOut)へ倒れる（RED→GREEN）', async () => {
    vi.useFakeTimers();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      readTaskApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const t1 = codexHost.byTaskId('T1');
    await requestDangerousApproval(t1, t1.cwd);
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('waitingApproval');

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    // `stopLoop()`は呼ばれるが、フェイクは自動で`onFinished`を発火しない
    // （実際のhostは非同期に`onFinished`を呼ぶ想定）。既存の同種テストと同じく
    // ここで明示的にシミュレートする
    expect(t1.stopLoopCount).toBe(1);
    t1.finish('taskStopped', { ...initialChatState });
    await flush();

    const run = store.find(runId);
    expect(run?.tasks['T1']?.state).toBe('failed');
    expect(run?.tasks['T1']?.failure).toEqual({ kind: 'taskApprovalTimedOut' });
  });

  it('タイムアウト前に承認されれば、その後taskApprovalTimeoutSecを超えても何も起きない', async () => {
    vi.useFakeTimers();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      readTaskApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const t1 = codexHost.byTaskId('T1');
    await requestDangerousApproval(t1, t1.cwd);
    await flush();

    t1.resolveApproval(1, 'accept');
    await flush();
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    // 承認済みタイマーは`onApprovalResolved`が解除しているため、時間切れは起きない
    expect(t1.stopLoopCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('running');
  });

  it('タイムアウト前に拒否されれば、従来どおりapprovalRejectedのまま（回帰）', async () => {
    vi.useFakeTimers();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      readTaskApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const t1 = codexHost.byTaskId('T1');
    await requestDangerousApproval(t1, t1.cwd);
    await flush();

    t1.resolveApproval(1, 'decline');
    await flush();
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'approvalRejected' });

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    // 拒否で確定済み。タイマーは`onApprovalResolved`が解除しているため
    // `taskApprovalTimedOut`に化けない
    expect(t1.stopLoopCount).toBe(0);
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'approvalRejected' });
  });

  it('stopTask()でwaitingApprovalのタスクを止めた場合は、従来どおりmanualStopのまま（回帰）', async () => {
    vi.useFakeTimers();
    const { runner, codexHost, store } = createHarness(SINGLE_TASK_YAML, {
      readTaskApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const t1 = codexHost.byTaskId('T1');
    await requestDangerousApproval(t1, t1.cwd);
    await flush();

    expect(runner.stopTask(runId, 'T1')).toBe(true);
    t1.finish('taskStopped', { ...initialChatState });
    await flush();
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'manualStop' });

    // 内部に残っていたタイムアウトタイマーが、後から誤って`taskApprovalTimedOut`へ
    // 上書きしないことを確認する（`handleTaskApprovalTimeout`の状態ガード）
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(store.find(runId)?.tasks['T1']?.failure).toEqual({ kind: 'manualStop' });
  });

  it('依存する後続タスクは、時間切れでもdependencyFailedとして通常どおりskippedになる', async () => {
    vi.useFakeTimers();
    const { runner, codexHost, store } = createHarness(PARENT_CHILD_YAML, {
      readTaskApprovalTimeoutSec: () => 60,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();
    const t1 = codexHost.byTaskId('T1');
    await requestDangerousApproval(t1, t1.cwd);
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    t1.finish('taskStopped', { ...initialChatState });
    await flush();

    const run = store.find(runId);
    expect(run?.tasks['T1']?.state).toBe('failed');
    expect(run?.tasks['T2']?.state).toBe('skipped');
    expect(run?.tasks['T2']?.failure).toEqual({ kind: 'dependencyFailed', failedTaskIds: ['T1'] });
  });
});

// ---------------------------------------------------------------------------
// 副次効果: waitingApprovalが1件あると、待ちぼうけ検出(経路1)が他タスクの
// 返信待ち解放まで止めてしまっていた（Issue #579、design.md §16.21・§16.39）。
// ---------------------------------------------------------------------------

interface FakeMessagingState {
  hub: TaskMessagingHub | undefined;
}

function fakeMessagingDeps(): { deps: WorkflowRunnerMessagingDeps; state: FakeMessagingState } {
  const state: FakeMessagingState = { hub: undefined };
  const deps: WorkflowRunnerMessagingDeps = {
    startTransport: async (hub) => {
      state.hub = hub;
      const handle: HttpMcpTransportHandle = {
        transport: { onConnection: () => undefined },
        baseUrl: 'http://127.0.0.1:0',
        registerTask: (taskId: string) => `http://127.0.0.1:0/mcp/${taskId}`,
        close: () => Promise.resolve(),
      };
      return handle;
    },
    readReplyTimeoutSec: () => 100_000,
  };
  return { deps, state };
}

const THREE_TASK_YAML = `
version: 1
name: task-approval-timeout-stalemate
defaults:
  maxParallel: 3
tasks:
  - id: A
    autoApprove: true
    prompt: pa
    done: da
  - id: B
    prompt: pb
    done: db
  - id: C
    prompt: pc
    done: dc
`;

describe('waitingApprovalが混ざっていても他タスクのwaitingReply解放は止まらない（Issue #579の副次効果）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A: waitingApproval / B,C: waitingReply でも、B,Cは経路1(全員待ちぼうけ)で解放される', async () => {
    vi.useFakeTimers();
    const { deps, state } = fakeMessagingDeps();
    const { runner, codexHost, store } = createHarness(THREE_TASK_YAML, {
      // Aが時間切れしてこのテストの主眼（B/Cの解放）を邪魔しないよう、十分大きくしておく
      readTaskApprovalTimeoutSec: () => 100_000,
      messaging: deps,
    });
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    const a = codexHost.byTaskId('A');
    await requestDangerousApproval(a, a.cwd);
    await flush();
    expect(store.find(runId)?.tasks['A']?.state).toBe('waitingApproval');

    state.hub?.sendMessage({
      from: 'B',
      to: ORCHESTRATOR_CONNECTION_ID,
      body: 'b',
      expectReply: true,
    });
    state.hub?.sendMessage({
      from: 'C',
      to: ORCHESTRATOR_CONNECTION_ID,
      body: 'c',
      expectReply: true,
    });
    await flush();
    expect(store.find(runId)?.tasks['B']?.state).toBe('waitingReply');
    expect(store.find(runId)?.tasks['C']?.state).toBe('waitingReply');

    // `checkWaitingReplyStalls`のポーリング（`WAITING_REPLY_POLL_INTERVAL_MS`）を進める
    await vi.advanceTimersByTimeAsync(WAITING_REPLY_POLL_INTERVAL_MS);
    await flush();

    const run = store.find(runId);
    // 修正前はAの`waitingApproval`が混ざっているだけで経路1が不成立になり、
    // B/Cとも`waitingReply`のまま残っていた
    expect(run?.tasks['B']?.state).toBe('running');
    expect(run?.tasks['C']?.state).toBe('running');
    // Aは無関係に`waitingApproval`のまま（このテストではタイムアウトを起こしていない）
    expect(run?.tasks['A']?.state).toBe('waitingApproval');
  });
});
