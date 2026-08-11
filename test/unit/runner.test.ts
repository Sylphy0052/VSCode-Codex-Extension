import { describe, expect, it } from 'vitest';
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
  MAX_WORKFLOW_FILE_BYTES,
  WorkflowRunner,
  type WorkflowFilePort,
} from '../../src/orchestrator/runner';
import {
  WorkflowRunStore,
  type PersistedRun,
  type WorkflowRunMemento,
} from '../../src/orchestrator/runStore';
import {
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from '../../src/orchestrator/worktree';
import type { Provider } from '../../src/orchestrator/workflow';
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
  reveal(): void {}
  open(): void {}
  dispose(): void {
    this.disposed = true;
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
  sessions: FakeTaskSession[] = [];
  openInputs: TaskSessionInput[] = [];
  private counter = 0;
  /** 次の`openTaskSession`呼び出しだけ失敗させる（例: app-serverが落ちている等の再現）。 */
  private pendingRejection: Error | undefined;

  rejectNext(error: Error): void {
    this.pendingRejection = error;
  }

  async openTaskSession(input: TaskSessionInput): Promise<TaskSession> {
    if (this.pendingRejection !== undefined) {
      const error = this.pendingRejection;
      this.pendingRejection = undefined;
      throw error;
    }
    this.openInputs.push(input);
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
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
}

/** `worktree add` を常に失敗させたい場合だけ `failWorktreeAdd: true` を渡す。 */
function fakeGit(options?: { failWorktreeAdd?: boolean }): FakeGitHandle {
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
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        // ブランチはまだ存在しない（worktree作成前提）
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        if (options?.failWorktreeAdd) {
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
      return { code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` };
    },
  };
}

const identityFs: WorktreeFileSystemPort = {
  realpath: async (target) => target,
  readTextFile: async () => '.agents/worktrees/\n',
  isSymbolicLink: async () => false,
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
  claudeHost: FakeHost;
  store: WorkflowRunStore;
  git: FakeGitHandle;
}

function createHarness(
  yaml: string,
  options?: {
    allowAutoApprove?: boolean;
    codexSandbox?: string;
    codexApprovalMode?: string;
    claudePermissionMode?: string;
    git?: FakeGitHandle;
  },
): Harness {
  const codexHost = new FakeHost();
  const claudeHost = new FakeHost();
  const store = new WorkflowRunStore(fakeMemento());
  const hosts: Record<Provider, TaskSessionHost> = { codex: codexHost, claude: claudeHost };
  const git = options?.git ?? fakeGit();
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
      codexSandbox: options?.codexSandbox ?? 'read-only',
      codexApprovalMode: options?.codexApprovalMode ?? 'on-request',
      claudePermissionMode: options?.claudePermissionMode ?? 'manual',
      allowAutoApprove: options?.allowAutoApprove ?? true,
    }),
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
    // 実際の送信直前（promptTransform）ではテンプレートが展開される（design.md §16.4）
    expect(t2.promptTransform?.('T1の結果: {{T1.result}}')).toBe('T1の結果: T1の応答テキスト');

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
            { path: `${a.cwd}/.git/hooks/pre-commit`, kind: 'add', movePath: undefined, diff: '' },
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
          diffs: [{ path: `${a.cwd}/src/index.ts`, kind: 'update', movePath: undefined, diff: '' }],
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
  it('実行全体を停止すると、新規タスクは開始されない', async () => {
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
    const { runner, codexHost, store } = createHarness(YAML);
    const result = await runner.start('/repo/.agents/workflows/a.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    runner.stop(runId);
    await flush();

    const t1 = codexHost.byTaskId('T1');
    t1.finish('done', doneState('ok'));
    await flush();

    // T1は走り続けて完了できるが、停止済みなのでT2は開始されない
    const run = store.find(runId) as PersistedRun;
    expect(run.tasks['T1']?.state).toBe('done');
    expect(run.tasks['T2']?.state).toBe('skipped');
    expect(run.haltedByUser).toBe(true);
  });
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

describe('WorkflowRunner: bypassPermissionsの実効値に対する最終防御（design.md §16.7、レビュー指摘: critical 3）', () => {
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

  it('拡張機能側の設定が既にbypassPermissionsのとき、実効値を継承したタスクを開始しない', async () => {
    const { runner, claudeHost, store } = createHarness(YAML, {
      claudePermissionMode: 'bypassPermissions',
    });
    const result = await runner.start('/repo/.agents/workflows/bypass.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    // bypassPermissionsでは can_use_tool 自体が発行されず、classifyApprovalRequestも
    // autoApproveもescalateもallowも一度も呼ばれない（#54の危険判定が丸ごと無意味になる）。
    // タスクを開始せずfailedにするのが唯一の歯止め
    expect(claudeHost.openInputs).toHaveLength(0);
    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
  });

  it('拡張機能側の設定がbypassPermissionsでなければ通常通り開始する', async () => {
    const { runner, claudeHost } = createHarness(YAML, { claudePermissionMode: 'manual' });
    await runner.start('/repo/.agents/workflows/ok.yaml', '/repo');
    await flush();

    expect(claudeHost.openInputs).toHaveLength(1);
    expect(claudeHost.openInputs[0]?.config.approvalMode).toBe('manual');
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
    const git = fakeGit({ failWorktreeAdd: true });
    const { runner, codexHost, store } = createHarness(YAML, { git });
    const result = await runner.start('/repo/.agents/workflows/wtfail.yaml', '/repo');
    const runId = result.runId as string;
    await flush();

    expect(store.find(runId)?.tasks['T1']?.state).toBe('failed');
    // worktreeが無いのでセッションも一度も開かれない
    expect(codexHost.openInputs).toHaveLength(0);
  });
});
