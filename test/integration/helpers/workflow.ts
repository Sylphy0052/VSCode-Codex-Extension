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
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * `ChatState` のうち `runner.ts` が読む項目だけを写したもの。
 * `busy` は `onFinished` では使わないが、`onStateChanged`
 * （`runnerOrchestrator.ts` の `onOrchestratorStateChanged`）がターンの区切り
 * （`busy: true → false`）を見るために使う（design.md §16.34、Issue #547）。
 */
export interface ChatStateLike {
  turnResultText: string;
  turnEditedFiles: readonly string[];
  items: readonly unknown[];
  busy?: boolean;
}

/** 完了時に渡す `ChatState` 相当を組み立てる。 */
export function doneState(text: string): ChatStateLike {
  return { turnResultText: text, turnEditedFiles: [], items: [] };
}

/** `TaskSession`（`src/orchestrator/taskSession.ts`）と構造互換な最小の口。 */
export interface TaskSessionLike {
  readonly sessionId: string;
  runLoop(plan: unknown): void;
  send(text: string): void;
  setPromptTransform(transform: (text: string) => string): void;
  onFinished(listener: (reason: string, state: ChatStateLike) => void): void;
  onStateChanged(listener: (state: ChatStateLike) => void): void;
  setApprovalHandler(handler: unknown): void;
  onApprovalResolved(listener: (outcome: unknown) => void): void;
  interrupt(): Promise<void>;
  pauseLoop(): void;
  resumeLoop(): void;
  checkMessagingToolVisible(): Promise<boolean>;
  stopLoop(): boolean;
  decideApproval(requestId: number | string, decision: string): void;
  reveal(): void;
  open(options: { preserveFocus: boolean }): void;
  dispose(): void;
}

/** `TaskSessionInput` のうちフェイクが見る項目。 */
export interface TaskSessionInputLike {
  cwd: string;
  /**
   * タスク間メッセージング（design.md §16.21、Issue #171）用のMCPサーバへの接続先。
   * runごとに立つサーバから、タスクごとに発行されたURLが渡る。
   */
  mcp?: { url: string };
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
  setApprovalHandlerCount = 0;
  /** `checkMessagingToolVisible` の戻り値（テストから変える）。 */
  messagingToolVisible = true;
  /** タスクへ渡されたMCPサーバの接続先（`TaskSessionInput.mcp`）。 */
  mcpUrl: string | undefined;
  private promptTransform: ((text: string) => string) | undefined;
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
  /** `TaskSession.send`（design.md §16.23）。ループを介さない1回きりの送信。 */
  readonly sentTexts: string[] = [];
  send(text: string): void {
    this.sentTexts.push(text);
  }
  /**
   * 次の指示へ手を入れる差し込み口。タスク間メッセージング（design.md §16.21）では
   * 届いたメッセージをここで添える（`composeNextPrompt`）ため、テストから呼べるように
   * 実物と同じく保持する。
   */
  setPromptTransform(transform: (text: string) => string): void {
    this.promptTransform = transform;
  }

  /** `setPromptTransform` で受け取った変換を通した結果（届いたメッセージが添えられる）。 */
  transformPrompt(text: string): string {
    return this.promptTransform?.(text) ?? text;
  }
  onFinished(listener: (reason: string, state: ChatStateLike) => void): void {
    this.finishedListeners.push(listener);
  }
  onStateChanged(listener: (state: ChatStateLike) => void): void {
    this.stateListeners.push(listener);
  }
  /**
   * 承認の差し込み口。衝突解決セッションでは**呼ばれない**ことが設計上の主張なので
   * （design.md §16.17「標準の承認カードへ委ねる」＝常に人の承認を求める）、回数を数える。
   */
  setApprovalHandler(): void {
    this.setApprovalHandlerCount += 1;
  }
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
  /**
   * ワークフロー用MCPサーバのツールがCLIから見えているか。design.md §16.21「見えて
   * いなければ警告を出し、通信なしで走らせる」の経路をテストから作れるようにする。
   */
  checkMessagingToolVisible(): Promise<boolean> {
    return Promise.resolve(this.messagingToolVisible);
  }
  /**
   * 「タスク停止」操作の実体。実物（`ChatViewManager`）はループを止め、
   * `LoopStopReason: 'taskStopped'` で `onFinished` を呼ぶ。ここでも同じ順序で伝える。
   */
  stopLoop(): boolean {
    this.emitFinished('taskStopped', doneState(''));
    return true;
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

  /**
   * 任意の `LoopStopReason` で終わらせる（`maxIterations` など）。実物のループ制御は
   * `ChatViewManager` 側にあり、フェイクは回数を数えないため、上限に達した状況は
   * この口で作る。
   */
  finishWith(reason: string): void {
    this.emitFinished(reason, doneState(''));
  }

  /**
   * `onStateChanged` の購読者へ状態を配る（design.md §16.34、Issue #547）。
   * オーケストレーターへの通知（`notifyOrchestrator`）はターン中は`pending`に溜まり、
   * ターンが終わって（`busy: true → false`）初めて`session.send`へ渡る
   * （`runnerOrchestrator.ts`の`onOrchestratorStateChanged`）。統合テストでは実CLIが
   * ターンの区切りを作らないため、テスト側からこれを呼んで明示的に区切りを作る。
   */
  emitState(state: ChatStateLike): void {
    for (const listener of this.stateListeners) {
      listener(state);
    }
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
    session.mcpUrl = input.mcp?.url;
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

  /**
   * オーケストレーター自身のセッションを引く（design.md §16.34、Issue #547）。
   * オーケストレーターのcwdはworktreeを切らずワークスペース直下（`live.repoRoot`）を
   * そのまま使う（`runnerOrchestrator.ts`の`setupOrchestratorForStart`）ため、
   * タスクのように末尾セグメントでは引けない。呼び出し側が知っている
   * `workspaceFolder`との完全一致で引く。
   */
  orchestrator(workspaceFolder: string): FakeTaskSession {
    const found = this.sessions.find((s) => s.cwd === workspaceFolder);
    if (found === undefined) {
      const opened = this.sessions.map((s) => s.cwd).join(', ');
      throw new Error(`オーケストレーターのセッションが見つからない（開いたcwd: ${opened}）`);
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
  /** タスクごとのPR/MR（design.md §16.11、Issue #118・#172）。 */
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
}

/**
 * 警告欄1件（`WorkflowWarning`）と構造互換な最小の口。`kind` は
 * `src/orchestrator/runner.ts` の union をそのまま写さず、テストが実際に見るものだけを
 * 文字列として受ける（増えたときにテスト側の型を追随させずに済む）。
 */
export interface WorkflowWarningLike {
  kind: string;
  taskId?: string | undefined;
  message: string;
}

/** `WorkflowRunSnapshot` のうち統合テストが見る項目。 */
export interface WorkflowRunSnapshotLike {
  runId: string;
  name: string;
  outcome: string;
  tasks: readonly TaskSnapshotLike[];
  /** 警告欄（`WorkflowWarning`）。失敗時の手がかりとして診断メッセージへ載せる。 */
  warnings?: readonly WorkflowWarningLike[];
  /** 統合ブランチ→mainのPR/MR（design.md §16.11・§16.18、Issue #172）。 */
  integrationPullRequestNumber?: number | undefined;
  integrationPullRequestUrl?: string | undefined;
  /** 最終マージ（`agent.workflows.finalMerge: auto`）の結果。 */
  finalMergeOutcome?: 'merged' | 'failed' | undefined;
}

/** 指定の `kind` の警告だけを取り出す。 */
export function warningsOfKind(
  snapshot: WorkflowRunSnapshotLike | undefined,
  kind: string,
): WorkflowWarningLike[] {
  return (snapshot?.warnings ?? []).filter((w) => w.kind === kind);
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
  /** `blocked` のタスクを再マージする（design.md §16.17、Issue #170）。 */
  retryMerge(runId: string, taskId: string): boolean;
  /**
   * 統合ブランチと残ったworktreeをまとめて片付ける（design.md §16.17、Issue #173）。
   * runが `running` の間は統合worktreeを撤去せず、理由を返す。
   */
  cleanupIntegration(runId: string): Promise<{
    tasksRemoved: string[];
    tasksFailed: string[];
    integrationRemoved: boolean;
    integrationFailedMessage: string | undefined;
  }>;
}

/** `CliCommandResult`（`src/orchestrator/forge.ts`）と構造互換な最小の口。 */
export interface CliCommandResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

/** `GitCommandResult`（`src/orchestrator/worktree.ts`）と構造互換な最小の口。 */
export interface GitCommandResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

/** `ForgeOverrides`（`src/extension.ts`）と構造互換な口。渡した項目だけが差し替わる。 */
export interface ForgeOverridesLike {
  cli?: {
    run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResultLike>;
  };
  cliAvailability?: { isOnPath(command: string): Promise<boolean> };
  readConfig?: () => {
    host: 'auto' | 'github' | 'gitlab' | 'none';
    pullRequest: 'none' | 'integration' | 'per-task';
    finalMerge: string;
  };
  git?: { run(args: readonly string[], cwd: string): Promise<GitCommandResultLike> };
}

/** `WorkflowTestApi`（`src/extension.ts`）と構造互換な口。 */
export interface WorkflowTestApiLike {
  readonly runner: WorkflowRunnerLike;
  setTaskSessionHost(provider: 'codex' | 'claude', host: TaskSessionHostLike | undefined): void;
  /** PR/MRまわりの差し替え（Issue #169・#172）。`undefined` で全て実物へ戻る。 */
  setForgeOverrides(overrides: ForgeOverridesLike | undefined): void;
}

/**
 * gitと `gh` / `glab` の呼び出しを**1本の時系列へ**記録する（Issue #172）。
 *
 * design.md §16.18 が定める順序（タスクブランチのpush→統合ブランチのpush→PR/MR作成→
 * 統合worktreeでのマージと統合ブランチのpush）はgitとCLIにまたがるため、別々の配列では
 * 相対順序を確かめられない。`RecordingGit` / `RecordingCli` へ同じインスタンスを渡す。
 */
export class ForgeCallLog {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }

  /**
   * PR/MRの作成順序に関わる呼び出しだけを、確かめやすい短い名前へ畳んで返す。
   * worktreeの作成やstatusの確認など、順序の主張に関わらないgitの呼び出しは落とす。
   */
  forgeSteps(): string[] {
    const steps: string[] = [];
    for (const entry of this.entries) {
      const push = /^git push origin (\S+):\S+$/u.exec(entry);
      if (push !== null) {
        steps.push(`push ${push[1] ?? ''}`);
        continue;
      }
      if (
        /^gh pr create /u.test(entry) ||
        /^glab api projects\/:id\/merge_requests /u.test(entry)
      ) {
        steps.push('createPullRequest');
        continue;
      }
      if (/^git merge /u.test(entry)) {
        steps.push('merge');
        continue;
      }
      if (/^gh pr merge /u.test(entry) || /^glab mr merge /u.test(entry)) {
        steps.push('finalMerge');
      }
    }
    return steps;
  }
}

/** 実gitを呼ぶ最小の `GitCommandRunner` 互換実装（`RecordingGit` の委譲先）。 */
export const realGit = {
  run(args: readonly string[], cwd: string): Promise<GitCommandResultLike> {
    return new Promise((resolve) => {
      execFile('git', [...args], { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
      });
    });
  },
};

/**
 * `gh` / `glab` の呼び出しを記録するだけのフェイク。**何も実行しない**ので、
 * 統合テストがホストへ触れることは無い。`auth status` の結果は `authenticated` で決める。
 *
 * PR/MRの作成（`gh pr create` / `glab api ... merge_requests`）に対しては、本物と同じ形の
 * 出力を返す。`gh` はURLをそのまま標準出力へ、`glab api` は `web_url` を含むJSONを返す
 * （`src/orchestrator/forge.ts` の `extractGithubPullRequestUrl` /
 * `extractGitlabMergeRequestUrl`）。URLのホスト名は `.invalid`（RFC 2606）で、
 * 実在しないことが規約上保証されている。
 */
export class RecordingCli {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  /**
   * PR/MR作成の本文。`forge.ts` は一時ファイルへ書いて `--body-file` / `--field
   * description=@` で渡し、呼び出しの直後に消すため、呼ばれた時点で読んで控える。
   */
  readonly bodies: string[] = [];
  private created = 0;

  constructor(
    private readonly authenticated: boolean,
    private readonly log?: ForgeCallLog,
  ) {}

  run(command: string, args: readonly string[], cwd: string): Promise<CliCommandResultLike> {
    this.calls.push({ command, args, cwd });
    this.log?.record(`${command} ${args.join(' ')}`);
    const isAuthStatus = args[0] === 'auth' && args[1] === 'status';
    if (isAuthStatus) {
      return Promise.resolve(
        this.authenticated
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'not logged in' },
      );
    }
    if (isCreatePullRequest(command, args)) {
      this.created += 1;
      const bodyFile = readBodyFilePath(args);
      if (bodyFile !== undefined) {
        this.bodies.push(readFileSync(bodyFile, 'utf8'));
      }
      const url =
        command === 'gh'
          ? `https://github.invalid/o/r/pull/${this.created}`
          : `https://gitlab.invalid/o/r/-/merge_requests/${this.created}`;
      const stdout = command === 'gh' ? `${url}\n` : JSON.stringify({ web_url: url });
      return Promise.resolve({ code: 0, stdout, stderr: '' });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  /** `auth status` 以外の呼び出し（PR/MRの作成・マージなど）。 */
  nonAuthCalls(): Array<{ command: string; args: readonly string[]; cwd: string }> {
    return this.calls.filter((c) => !(c.args[0] === 'auth' && c.args[1] === 'status'));
  }
}

/** `--body-file=<path>`（gh）/ `--field=description=@<path>`（glab）から本文のパスを取る。 */
function readBodyFilePath(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--body-file=')) {
      return arg.slice('--body-file='.length);
    }
    if (arg.startsWith('--field=description=@')) {
      return arg.slice('--field=description=@'.length);
    }
  }
  return undefined;
}

/** `gh pr create` / `glab api projects/:id/merge_requests`（`forge.ts`が組み立てる形）か。 */
function isCreatePullRequest(command: string, args: readonly string[]): boolean {
  if (command === 'gh') {
    return args[0] === 'pr' && args[1] === 'create';
  }
  return args[0] === 'api' && args[1] === 'projects/:id/merge_requests';
}

/**
 * gitの呼び出しを記録しつつ、**実gitへそのまま委譲する**フェイク（Issue #172）。
 *
 * design.md §16.18 が定める順序はpush（git）とPR/MR作成（`gh` / `glab`）にまたがるため、
 * CLI側の記録だけでは確かめられない。worktreeの作成・統合のマージも同じポートを通るので、
 * 動作は実物のままにして記録だけを足す。
 */
export class RecordingGit {
  readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];

  constructor(
    private readonly real: {
      run(args: readonly string[], cwd: string): Promise<GitCommandResultLike>;
    },
    private readonly log?: ForgeCallLog,
  ) {}

  run(args: readonly string[], cwd: string): Promise<GitCommandResultLike> {
    this.calls.push({ args, cwd });
    this.log?.record(`git ${args.join(' ')}`);
    return this.real.run(args, cwd);
  }

  /** `git push` の呼び出しだけを、refspecの形（`<branch>:<branch>`）で並べる。 */
  pushedRefspecs(): string[] {
    return this.calls.filter((c) => c.args[0] === 'push').map((c) => c.args[2] ?? '');
  }
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

/**
 * 統合ブランチへのマージコミットの件名（`src/orchestrator/integration.ts` の
 * `mergeCommitMessage` が組み立てる現行形）。
 *
 * design.md §16.17 のとおり `<type>(<taskId>): merge task (run <runId>)` で、`type` は
 * タスクYAMLの `type:`（未指定・未知の値は `chore`）。統合テストのfixtureは `type:` を
 * 書いていないため既定の `chore` になる。旧形式（`Merge task <taskId> (run <runId>)`）は
 * 実行中のrunがアップグレードを跨いだ場合に**読む**側だけが受け付けるもので、拡張機能が
 * 新たに書くことはない。ここは書かれる側の現行形だけを見る。
 */
export function mergeCommitSubject(taskId: string, runId: string, type = 'chore'): string {
  return `${type}(${taskId}): merge task (run ${runId})`;
}
