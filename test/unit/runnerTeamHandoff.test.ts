import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * run終了時にチームモードの受け渡しファイル（design.md §16.44、Issue #693）が片付けられる
 * ことを確かめる（Issue #725。PR #711 で見送っていたぶん）。
 *
 * `runner.ts` の終了処理は `TeamHandoffStore` を `nodeHandoffFileSystem` と直接組み立てる
 * （ポート経由にすると「他のセッションのファイルもまとめて消す」操作をタスクへ渡すことに
 * なるため、そこは意図的に注入点を作っていない）。そのためここではモジュールごと差し替えて
 * 観測する。副作用として、このファイルのテストは実ファイルシステムへ一切触れない
 * （`runner.test.ts` / `runnerDispose.test.ts` と同じ方針）。
 *
 * ヘルパー（`createHarness`/`fakeGit`/`flush`等）は `runnerDispose.test.ts` と同趣旨だが、
 * 巨大な `runner.test.ts` へ追記せず自己完結させている（同ファイルの冒頭コメントと同じ理由）。
 */

const handoffFs = vi.hoisted(() => ({
  makeDirectory: vi.fn<(target: string) => Promise<boolean>>(() => Promise.resolve(true)),
  writeTextFile: vi.fn<(target: string, content: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  readTextFile: vi.fn<(target: string) => Promise<string | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  listDirectory: vi.fn<(target: string) => Promise<string[]>>(() => Promise.resolve([])),
  removeFile: vi.fn<(target: string) => Promise<boolean>>(() => Promise.resolve(true)),
  removeDirectory: vi.fn<(target: string) => Promise<boolean>>(() => Promise.resolve(true)),
  isSymbolicLink: vi.fn<(target: string) => Promise<boolean>>(() => Promise.resolve(false)),
}));

vi.mock('../../src/orchestrator/nodeHandoffFileSystem', () => ({
  nodeHandoffFileSystem: handoffFs,
}));

class FakeTaskSession implements TaskSession {
  readonly sessionId: string;
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

  runLoop(_plan: LoopPlan): void {
    // このテストではタスクを完走させないため使わない
  }
  send(): void {
    // 使わない
  }
  setPromptTransform(_transform: (text: string) => string): void {
    // 使わない
  }
  onFinished(listener: (reason: LoopStopReason, state: ChatState) => void): void {
    this.finishedListeners.push(listener);
  }
  onStateChanged(listener: (state: ChatState) => void): void {
    this.stateListeners.push(listener);
  }
  setApprovalHandler(_handler: ApprovalHandler): void {
    // 使わない
  }
  onApprovalResolved(listener: (outcome: ApprovalOutcome) => void): void {
    this.approvalResolvedListeners.push(listener);
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  pauseLoop(): void {
    // 使わない
  }
  resumeLoop(): void {
    // 使わない
  }
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(true);
  }
  stopLoop(): boolean {
    return true;
  }
  decideApproval(): void {
    // 使わない
  }
  reveal(): void {
    // 使わない
  }
  open(): void {
    // 使わない
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeHost implements TaskSessionHost {
  sessions: FakeTaskSession[] = [];
  private counter = 0;
  private pendingRejection: Error | undefined;

  /** 次の（オーケストレーター以外の）`openTaskSession`だけ失敗させ、runを終了させる。 */
  rejectNext(error: Error): void {
    this.pendingRejection = error;
  }

  openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    if (input.role !== 'orchestrator' && this.pendingRejection !== undefined) {
      const error = this.pendingRejection;
      this.pendingRejection = undefined;
      return Promise.reject(error);
    }
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
    if (input.role !== 'orchestrator') {
      this.sessions.push(session);
    }
    return Promise.resolve(session);
  }
}

/** `git` の呼び出しを全てフェイクで完結させる。実ファイルシステムへは一切触れない。 */
function fakeGit(): GitCommandRunner {
  return {
    run(args) {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return Promise.resolve({ code: 0, stdout: 'true\n', stderr: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return Promise.resolve({ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return Promise.resolve({ code: 0, stdout: '/repo/.git\n', stderr: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return Promise.resolve({ code: 0, stdout: 'main\n', stderr: '' });
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return Promise.resolve({ code: 1, stdout: '', stderr: "error: No such remote 'origin'" });
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'not found' });
      }
      if (args[0] === 'worktree') {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args[0] === 'merge' || args[0] === 'add' || args[0] === 'commit' || args[0] === 'log') {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args[0] === 'diff') {
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` });
    },
  };
}

const identityFs: WorktreeFileSystemPort = {
  realpath: (target) => Promise.resolve(target),
  readTextFile: () => Promise.resolve('.agents/worktrees/\n'),
  isSymbolicLink: () => Promise.resolve(false),
  pathExists: () => Promise.resolve(true),
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
    fileSize: () => Promise.resolve(Buffer.byteLength(content, 'utf8')),
    readTextFile: () => Promise.resolve(content),
  };
}

/** マイクロタスクを十分な回数流し、非同期の起動チェーンと終了処理を進める。 */
async function flush(times = 100): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

const YAML = `
version: 1
name: team-handoff-cleanup-test
tasks:
  - id: T1
    prompt: p
    done: d
`;

interface Harness {
  runner: WorkflowRunner;
  host: FakeHost;
  warnings: string[];
}

function createHarness(): Harness {
  const host = new FakeHost();
  const claudeHost = new FakeHost();
  const warnings: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
    show: () => undefined,
  };
  const hosts: Record<Provider, TaskSessionHost> = { codex: host, claude: claudeHost };
  let seq = 0;
  const runner = new WorkflowRunner({
    hosts,
    worktreeQueue: new WorktreeCreationQueue(),
    git: fakeGit(),
    fs: identityFs,
    filePort: filePort(YAML),
    store: new WorkflowRunStore(fakeMemento()),
    log,
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
  return { runner, host, warnings };
}

/**
 * タスクの起動をhost側で失敗させ、runを終了（`failed`）まで進める。
 *
 * 終了処理は `void`＋`then`で走る非同期なので、`flush`を挟んでから観測する。
 */
async function runUntilFinished(harness: Harness): Promise<string> {
  harness.host.rejectNext(new Error('fake session open failure'));
  const started = await harness.runner.start(
    '/repo/.agents/workflows/team-handoff-cleanup.yaml',
    '/repo',
  );
  await flush();
  const runId = started.runId;
  expect(runId).toBeDefined();
  if (runId === undefined) {
    throw new Error('runIdが返らなかった');
  }
  expect(harness.runner.getSnapshot(runId)?.outcome).toBe('failed');
  return runId;
}

const cleanupWarnings = (warnings: readonly string[]): string[] =>
  warnings.filter((message) => message.includes('受け渡しファイルの片付けに失敗しました'));

describe('WorkflowRunner: run終了時に受け渡しファイルを片付ける（design.md §16.44、Issue #693）', () => {
  beforeEach(() => {
    handoffFs.removeDirectory.mockReset();
    handoffFs.removeDirectory.mockImplementation(() => Promise.resolve(true));
    handoffFs.isSymbolicLink.mockReset();
    handoffFs.isSymbolicLink.mockImplementation(() => Promise.resolve(false));
  });

  it('runが終わるとrunのディレクトリごと消し、警告は残さない', async () => {
    const harness = createHarness();
    const runId = await runUntilFinished(harness);

    expect(handoffFs.removeDirectory).toHaveBeenCalledTimes(1);
    expect(handoffFs.removeDirectory).toHaveBeenCalledWith(
      path.join('/repo', '.agents', 'handoff', 'runs', runId),
    );
    expect(cleanupWarnings(harness.warnings)).toEqual([]);
  });

  it('撤去に失敗（ok: false）したら警告をログへ残す', async () => {
    handoffFs.removeDirectory.mockImplementation(() => Promise.resolve(false));
    const harness = createHarness();
    const runId = await runUntilFinished(harness);

    const warned = cleanupWarnings(harness.warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`[workflow ${runId}]`);
    expect(warned[0]).toContain('受け渡しファイルの置き場を削除できませんでした');
  });

  it('置き場の祖先がシンボリックリンクなら、消さずに警告をログへ残す', async () => {
    // `.agents` そのものがリンクである状況（design.md §16.6の一次防御）
    handoffFs.isSymbolicLink.mockImplementation((target: string) =>
      Promise.resolve(target === path.join('/repo', '.agents')),
    );
    const harness = createHarness();
    await runUntilFinished(harness);

    expect(handoffFs.removeDirectory).not.toHaveBeenCalled();
    const warned = cleanupWarnings(harness.warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('シンボリックリンク');
  });

  it('撤去が例外を投げても、警告だけ残してrunの終了処理は壊れない', async () => {
    handoffFs.removeDirectory.mockImplementation(() => Promise.reject(new Error('EBUSY')));
    const harness = createHarness();
    const runId = await runUntilFinished(harness);

    const warned = cleanupWarnings(harness.warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('EBUSY');
    // 例外を握っても run の状態は終了したまま（後始末の失敗が結果を書き換えない）
    expect(harness.runner.getSnapshot(runId)?.outcome).toBe('failed');
  });
});
