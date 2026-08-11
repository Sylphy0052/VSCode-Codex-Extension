/**
 * ワークフロー（design.md §16）の統合テスト用ヘルパー（Issue #158）。
 *
 * `tsconfig.integration.json` の `rootDir` の都合で `src/**` を直接importできないため、
 * ここでは実物と構造互換な最小限の宣言だけを持つ（`helpers/extension.ts` と同じ流儀）。
 * 実行時に受け取るのは `activate()` が返した本物の `WorkflowRunner` である。
 *
 * CLIとの境界は `TaskSessionHost.openTaskSession` の1メソッドだけなので、統合テストでは
 * そこだけをこのフェイクへ差し替える。worktreeの作成・スケジューリング・状態遷移・
 * ワークフローView・workspaceStateへの保存は実物を通る。
 */

/** `ChatState` のうち `runner.ts` が `onFinished` で読む項目だけを写したもの。 */
export interface ChatStateLike {
  turnResultText: string;
  turnEditedFiles: readonly string[];
  items: readonly unknown[];
}

/** 完了時に渡す `ChatState` 相当を組み立てる。 */
export function doneState(text: string): ChatStateLike {
  return { turnResultText: text, turnEditedFiles: [], items: [] };
}

/** `TaskSession`（`src/orchestrator/taskSession.ts`）と構造互換な最小の口。 */
export interface TaskSessionLike {
  readonly sessionId: string;
  runLoop(plan: unknown): void;
  setPromptTransform(transform: (text: string) => string): void;
  onFinished(listener: (reason: string, state: ChatStateLike) => void): void;
  onStateChanged(listener: (state: ChatStateLike) => void): void;
  setApprovalHandler(handler: unknown): void;
  onApprovalResolved(listener: (outcome: unknown) => void): void;
  interrupt(): Promise<void>;
  pauseLoop(): void;
  resumeLoop(): void;
  checkMessagingToolVisible(): Promise<boolean>;
  stopLoop(): void;
  decideApproval(requestId: number | string, decision: string): void;
  reveal(): void;
  open(options: { preserveFocus: boolean }): void;
  dispose(): void;
}

/** `TaskSessionInput` のうちフェイクが見る項目。 */
export interface TaskSessionInputLike {
  cwd: string;
}

/** `TaskSessionHost` と構造互換な最小の口。 */
export interface TaskSessionHostLike {
  openTaskSession(input: TaskSessionInputLike): Promise<TaskSessionLike>;
}

/**
 * CLIを起動しないタスクセッション。ターンは自動では進まず、テストが `finishDone` /
 * `finishFailed` を呼んだときだけ完了する。並列区間の重なりを観測するために、
 * 「開始したまま終わらない」状態を保てることが要る。
 */
export class FakeTaskSession implements TaskSessionLike {
  readonly sessionId: string;
  readonly runLoopCalls: unknown[] = [];
  disposed = false;
  interruptCount = 0;
  pauseLoopCount = 0;
  resumeLoopCount = 0;
  revealCount = 0;
  openCount = 0;
  private readonly finishedListeners: Array<(reason: string, state: ChatStateLike) => void> = [];
  private readonly stateListeners: Array<(state: ChatStateLike) => void> = [];
  private finished = false;

  constructor(
    readonly cwd: string,
    idSeed: number,
  ) {
    this.sessionId = `fake-session-${idSeed}`;
  }

  runLoop(plan: unknown): void {
    this.runLoopCalls.push(plan);
  }
  setPromptTransform(): void {}
  onFinished(listener: (reason: string, state: ChatStateLike) => void): void {
    this.finishedListeners.push(listener);
  }
  onStateChanged(listener: (state: ChatStateLike) => void): void {
    this.stateListeners.push(listener);
  }
  setApprovalHandler(): void {}
  onApprovalResolved(): void {}
  interrupt(): Promise<void> {
    this.interruptCount += 1;
    return Promise.resolve();
  }
  pauseLoop(): void {
    this.pauseLoopCount += 1;
  }
  resumeLoop(): void {
    this.resumeLoopCount += 1;
  }
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(true);
  }
  /**
   * 「タスク停止」操作の実体。実物（`ChatViewManager`）はループを止め、
   * `LoopStopReason: 'taskStopped'` で `onFinished` を呼ぶ。ここでも同じ順序で伝える。
   */
  stopLoop(): void {
    this.emitFinished('taskStopped', doneState(''));
  }
  decideApproval(): void {}
  reveal(): void {
    this.revealCount += 1;
  }
  open(): void {
    this.openCount += 1;
  }
  dispose(): void {
    this.disposed = true;
  }

  // ---- テストからの操作 ----

  /** 終了条件の成立を宣言する（`LoopStopReason: 'done'`）。 */
  finishDone(result: string): void {
    this.emitFinished('done', doneState(result));
  }

  /** ターンの失敗で終わらせる（`LoopStopReason: 'failed'`）。 */
  finishFailed(): void {
    this.emitFinished('failed', doneState(''));
  }

  private emitFinished(reason: string, state: ChatStateLike): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    for (const listener of this.finishedListeners) {
      listener(reason, state);
    }
  }
}

/** 開いたセッションを記録するだけのホスト。 */
export class FakeTaskSessionHost implements TaskSessionHostLike {
  readonly sessions: FakeTaskSession[] = [];
  private counter = 0;

  openTaskSession(input: TaskSessionInputLike): Promise<TaskSessionLike> {
    this.counter += 1;
    const session = new FakeTaskSession(input.cwd, this.counter);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  /**
   * cwdの末尾セグメントで引く（worktreeのディレクトリ名がtaskIdになる）。
   * まだ開かれていなければ `undefined`。
   */
  find(taskId: string): FakeTaskSession | undefined {
    return this.sessions.find((s) => s.cwd.endsWith(`/${taskId}`) || s.cwd.endsWith(`\\${taskId}`));
  }

  /** 引けなければ例外。待ち合わせ済みの箇所で使う。 */
  get(taskId: string): FakeTaskSession {
    const found = this.find(taskId);
    if (found === undefined) {
      const opened = this.sessions.map((s) => s.cwd).join(', ');
      throw new Error(`taskId=${taskId}のセッションが見つからない（開いたcwd: ${opened}）`);
    }
    return found;
  }
}

/** `TaskSnapshot` のうち統合テストが見る項目。 */
export interface TaskSnapshotLike {
  id: string;
  dependsOn: readonly string[];
  state: string;
  cwd: string | undefined;
  branch: string | undefined;
  startedAt: string | undefined;
  hasLiveSession: boolean;
  /** 失敗理由（`TaskFailureReason`）。診断メッセージへそのまま載せる。 */
  failure?: unknown;
}

/** `WorkflowRunSnapshot` のうち統合テストが見る項目。 */
export interface WorkflowRunSnapshotLike {
  runId: string;
  name: string;
  outcome: string;
  tasks: readonly TaskSnapshotLike[];
  /** 警告欄（`WorkflowWarning`）。失敗時の手がかりとして診断メッセージへ載せる。 */
  warnings?: readonly unknown[];
}

/** `WorkflowRunner` のうち統合テストが呼ぶ口。 */
export interface WorkflowRunnerLike {
  start(
    defPath: string,
    repoRoot: string,
    options?: { allowConfirmed?: boolean },
  ): Promise<{
    ok: boolean;
    runId?: string;
    errors?: ReadonlyArray<{ message: string }>;
    needsAllowConfirmation?: boolean;
  }>;
  getSnapshot(runId: string): WorkflowRunSnapshotLike | undefined;
  stop(runId: string): void;
  /** 進行中のターンだけ止める（design.md §16.8「中断」）。 */
  interruptTask(runId: string, taskId: string): Promise<void>;
  /** タスクの会話タブを前面に出す（design.md §16.8「会話への導線」）。 */
  revealTask(runId: string, taskId: string): boolean;
  stopTask(runId: string, taskId: string): void;
  removeWorktrees(runId: string): Promise<{ removed: string[]; failed: string[] }>;
}

/** `WorkflowTestApi`（`src/extension.ts`）と構造互換な口。 */
export interface WorkflowTestApiLike {
  readonly runner: WorkflowRunnerLike;
  setTaskSessionHost(provider: 'codex' | 'claude', host: TaskSessionHostLike | undefined): void;
}

/** スナップショットからタスク1件を引く。 */
export function taskOf(
  snapshot: WorkflowRunSnapshotLike | undefined,
  taskId: string,
): TaskSnapshotLike | undefined {
  return snapshot?.tasks.find((t) => t.id === taskId);
}

/** タスクの現在の状態。スナップショットが無ければ `undefined`。 */
export function stateOf(
  snapshot: WorkflowRunSnapshotLike | undefined,
  taskId: string,
): string | undefined {
  return taskOf(snapshot, taskId)?.state;
}

/** 失敗時の手がかりとして、実行の状態をそのまま文字列化する。 */
export function describeSnapshot(snapshot: WorkflowRunSnapshotLike | undefined): string {
  if (snapshot === undefined) {
    return 'スナップショットなし';
  }
  const tasks = snapshot.tasks
    .map(
      (t) =>
        `${t.id}=${t.state}(session=${String(t.hasLiveSession)}, cwd=${t.cwd ?? '-'}` +
        `${t.failure === undefined ? '' : `, failure=${JSON.stringify(t.failure)}`})`,
    )
    .join(' / ');
  const warnings = (snapshot.warnings ?? []).map((w) => JSON.stringify(w)).join(' / ');
  return `outcome=${snapshot.outcome} ${tasks}${warnings === '' ? '' : ` warnings=[${warnings}]`}`;
}
