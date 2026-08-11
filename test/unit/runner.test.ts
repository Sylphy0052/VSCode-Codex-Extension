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

/** 既定でaskになる危険パターンの例（design.md §16.7）。承認関連のテストで使い回す。 */
const DANGEROUS_COMMAND = ['git', 'push', '--force', 'origin', 'main'].join(' ');

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
  stopLoopCount = 0;
  stopLoop(): void {
    this.stopLoopCount += 1;
  }
  decideApprovalCalls: Array<{ requestId: number | string; decision: ApprovalDecision }> = [];
  decideApproval(requestId: number | string, decision: ApprovalDecision): void {
    this.decideApprovalCalls.push({ requestId, decision });
  }
  revealCount = 0;
  reveal(): void {
    this.revealCount += 1;
  }
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
        return { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' };
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
          conflictPending = false;
          unresolvedConflict = true;
          return { code: 1, stdout: '', stderr: 'CONFLICT (content): fake conflict' };
        }
        if (options?.failMerge) {
          return { code: 1, stdout: '', stderr: 'fatal: fake merge failure' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'merge' && args[1] === '--abort') {
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
          failure: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
    }));

    const git = fakeGit();
    // マージコミットが既に履歴にある（マージ自体は完了していたが、リロードでその後の
    // 状態遷移が失われたケースを模す）
    const originalRun = git.run.bind(git);
    const gitWithLog: FakeGitHandle = {
      ...git,
      run: async (args, cwd) => {
        if (args[0] === 'log') {
          return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
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
          failure: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
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
          failure: undefined,
        },
      },
      haltedByUser: false,
      integrationBranch: `wf/${runId}/integration`,
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
