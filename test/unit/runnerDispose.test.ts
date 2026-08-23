import { describe, expect, it } from 'vitest';
import type { ChatState } from '../../src/appserver/chatState';
import type { LoopPlan, LoopStopReason } from '../../src/loop/loopController';
import type {
  ApprovalHandler,
  ApprovalOutcome,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from '../../src/orchestrator/taskSession';
import { WorkflowRunner, type WorkflowFilePort } from '../../src/orchestrator/runner';
import { WorkflowRunStore, type WorkflowRunMemento } from '../../src/orchestrator/runStore';
import {
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';
import type { Provider } from '../../src/orchestrator/workflow';
import type { Logger } from '../../src/log';

/**
 * Issue #502の再現テスト。`dispose()`後に宙に浮いた`startTask`の継続がCLIセッションを
 * 起動しないこと、および通常の再開（`retryTask`）がその防御で止まらないことを検証する。
 *
 * ヘルパー（`createHarness`/`fakeGit`/`flush`等）は`runner.test.ts`のものと同趣旨だが、
 * `runner.test.ts`は別セッション（Issue #589）が同時に使うため、このファイルは
 * 自己完結させて重複定義している（`runner.test.ts`への追記はしない）。
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
  promptTransform: ((text: string) => string) | undefined;
  approvalHandler: ApprovalHandler | undefined;
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

  runLoop(plan: LoopPlan): void {
    this.runLoopCalls.push(plan);
  }
  send(): void {
    // 再現テストでは使わない
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
  onApprovalResolved(listener: (outcome: ApprovalOutcome) => void): void {
    this.approvalResolvedListeners.push(listener);
  }
  interrupt(): Promise<void> {
    this.interruptCount += 1;
    return Promise.resolve();
  }
  pauseLoop(): void {
    // 再現テストでは使わない
  }
  resumeLoop(): void {
    // 再現テストでは使わない
  }
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(true);
  }
  stopLoop(): boolean {
    return true;
  }
  decideApproval(): void {
    // 再現テストでは使わない
  }
  reveal(): void {
    // 再現テストでは使わない
  }
  open(): void {
    // 再現テストでは使わない（同期発火系のフラグは持たない）
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeHost implements TaskSessionHost {
  sessions: FakeTaskSession[] = [];
  orchestratorSessions: FakeTaskSession[] = [];
  private counter = 0;
  /** 次の`openTaskSession`呼び出しだけ失敗させる（`retryTask`回帰テスト用）。 */
  private pendingRejection: Error | undefined;

  rejectNext(error: Error): void {
    this.pendingRejection = error;
  }

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    if (input.role !== 'orchestrator' && this.pendingRejection !== undefined) {
      const error = this.pendingRejection;
      this.pendingRejection = undefined;
      throw error;
    }
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
    if (input.role === 'orchestrator') {
      this.orchestratorSessions.push(session);
      return session;
    }
    this.sessions.push(session);
    return session;
  }
}

interface FakeGitHandle extends GitCommandRunner {
  calls: Array<{ args: string[]; cwd: string }>;
}

/** `git` の呼び出しを全てフェイクで完結させる。実ファイルシステムへは一切触れない。 */
function fakeGit(onRun?: (args: readonly string[], cwd: string) => Promise<void>): FakeGitHandle {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    calls,
    async run(args, cwd) {
      calls.push({ args: [...args], cwd });
      if (onRun !== undefined) {
        await onRun(args, cwd);
      }
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

/**
 * `git worktree add` の2回目以降（＝タスク自身のworktree作成。1回目は`start()`が作る
 * 統合worktree）を、`release()`が呼ばれるまでゲートで止められるgitフェイク。
 * `startTask`を`prepareTaskLaunch`（`resolveWorkingDirectory`内）の`await`点で
 * 停止させたまま`dispose()`を割り込ませるために使う。
 */
function gatedGit(): { git: FakeGitHandle; release: () => void; gated: Promise<void> } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let reached = (): void => undefined;
  const gated = new Promise<void>((resolve) => {
    reached = () => resolve();
  });
  let worktreeAddCount = 0;
  const git = fakeGit(async (args) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      worktreeAddCount += 1;
      if (worktreeAddCount >= 2) {
        reached();
        await gate;
      }
    }
  });
  return { git, release, gated };
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

/** マイクロタスクを十分な回数流し、非同期の起動チェーン（worktree→boundary→openTaskSession）を進める。 */
async function flush(times = 100): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  runner: WorkflowRunner;
  codexHost: FakeHost;
}

function createHarness(yaml: string, git: FakeGitHandle): Harness {
  const codexHost = new FakeHost();
  const claudeHost = new FakeHost();
  const store = new WorkflowRunStore(fakeMemento());
  const hosts: Record<Provider, TaskSessionHost> = { codex: codexHost, claude: claudeHost };
  let seq = 0;
  const runner = new WorkflowRunner({
    hosts,
    worktreeQueue: new WorktreeCreationQueue(),
    git,
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
    randomId: () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`,
  });
  return { runner, codexHost };
}

const YAML = `
version: 1
name: dispose-race-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

describe('WorkflowRunner: dispose()後に宙に浮いたstartTaskの継続（Issue #502）', () => {
  it('dispose()の後、await点で止まっていたstartTaskの継続がCLIセッションを起動しない', async () => {
    const { git, release, gated } = gatedGit();
    const { runner, codexHost } = createHarness(YAML, git);
    await runner.start('/repo/.agents/workflows/dispose-race.yaml', '/repo');
    await gated;
    await flush();

    // 前提: この時点ではまだセッションは開かれていない（await点で止まっている）
    expect(codexHost.sessions).toHaveLength(0);

    runner.dispose();
    release();
    await flush();

    // dispose()後にCLIセッションが起動してはならない
    expect(codexHost.sessions).toHaveLength(0);
  });

  it('起動してしまったセッションはdispose()の解放対象を外れず、閉じられないまま残らない', async () => {
    const { git, release, gated } = gatedGit();
    const { runner, codexHost } = createHarness(YAML, git);
    await runner.start('/repo/.agents/workflows/dispose-race-leak.yaml', '/repo');
    await gated;
    await flush();

    runner.dispose();
    release();
    await flush();

    // 起動してしまった場合でも、せめて解放はされていてほしい
    for (const session of codexHost.sessions) {
      expect(session.runLoopCalls).toHaveLength(0);
      expect(session.disposed).toBe(true);
    }
  });

  it('対照: dispose()しなければ同じ経路でセッションは開かれる（ゲートの有効性の確認）', async () => {
    const { git, release, gated } = gatedGit();
    const { runner, codexHost } = createHarness(YAML, git);
    await runner.start('/repo/.agents/workflows/dispose-race-control.yaml', '/repo');
    await gated;
    await flush();
    expect(codexHost.sessions).toHaveLength(0);

    release();
    await flush();

    expect(codexHost.sessions).toHaveLength(1);
  });

  it('通常の再開（retryTask）はdispose()ガードの影響を受けず引き続き機能する', async () => {
    // `live.finished`をガード条件に使うと`retryTask`がこれを`false`へ戻す動作と衝突して
    // 通常の再開まで止まる（Issue #502の必須制約）。ここではdispose()を一切呼ばず、
    // `startTask`側に追加したガード（`this.disposing`）が通常の再実行を妨げないことを
    // 確かめる
    const git = fakeGit();
    const { runner, codexHost } = createHarness(YAML, git);
    codexHost.rejectNext(new Error('fake session open failure'));
    const startResult = await runner.start('/repo/.agents/workflows/dispose-retry.yaml', '/repo');
    await flush();
    expect(startResult.ok).toBe(true);
    const runId = startResult.runId;
    expect(runId).toBeDefined();
    if (runId === undefined) {
      return;
    }

    // 1回目はhost側の失敗でT1が`failed`になっている（セッションは開かれていない）
    expect(codexHost.sessions).toHaveLength(0);
    const beforeRetry = runner.getSnapshot(runId);
    expect(beforeRetry?.tasks.find((t) => t.id === 'T1')?.state).toBe('failed');

    const retryResult = runner.retryTask(runId, 'T1');
    expect(retryResult.ok).toBe(true);
    await flush();

    // 通常の再開では新しいセッションが開かれ、runの状態も進む
    expect(codexHost.sessions).toHaveLength(1);
    const afterRetry = runner.getSnapshot(runId);
    expect(afterRetry?.tasks.find((t) => t.id === 'T1')?.state).not.toBe('failed');
  });
});
