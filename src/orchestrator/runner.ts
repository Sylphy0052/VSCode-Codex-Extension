import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';

import type { ApprovalDecision } from '../appserver/approvals';
import type { ChatState, PendingApproval } from '../appserver/chatState';
import type { LoopStopReason } from '../loop/loopController';
import type { Logger } from '../log';
import { buildEscalationRequest } from './approvalMapping';
import {
  classifyApprovalRequest,
  isPathWithinRoot,
  type EscalationPolicy,
  type TaskBoundary,
} from './escalation';
import {
  applyLoopStopReason,
  createRunState,
  markApprovalRejected,
  markRunning,
  markWaitingApproval,
  recordSessionInfo,
  recordSubmissionCount,
  resumeFromApproval,
  retryTask as retryTaskState,
  type RunState,
  type TaskFailureReason,
  type TaskRunState,
  type TaskState,
} from './runState';
import { getRunOutcome, nextTasksToStart, type RunOutcome } from './scheduler';
import { WorkflowRunStore, type PersistedRun, type PersistedTaskState } from './runStore';
import { sanitizeForLog, stripControlChars } from './sanitize';
import { buildEffectiveTaskConfig, type ExtensionSafetyBaseline } from './taskConfig';
import { buildResponseSummary } from './taskSummary';
import type {
  ApprovalHandlerResult,
  TaskSession,
  TaskSessionHost,
  TaskSessionInput,
} from './taskSession';
import {
  buildTaskBoundary,
  checkWorktreesGitignored,
  decideWorkingDirectory,
  isGitWorkingTree,
  resolveHeadCommit,
  shouldRemoveWorktree,
  WorktreeCreationQueue,
  type GitCommandRunner,
  type WorktreeFileSystemPort,
} from './worktree';
import {
  expandTemplate,
  parseWorkflowYaml,
  validateWorkflow,
  type Provider,
  type TaskResult,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowTask,
} from './workflow';

/**
 * スケジューラ（#53）が「開始せよ」と言ったタスクについて、セッションを作り、指示を送り、
 * 完了を検知して結果を返す（design.md §16.5 / §16.10）。
 *
 * VSCode APIには直接依存しない。`TaskSessionHost`（Codex/Claudeのチャット画面が実装）・
 * `GitCommandRunner` / `WorktreeFileSystemPort`（#55）・`WorkflowRunStore`
 * （`workspaceState` を抽象化した口）を注入で受け取り、`extension.ts` が実体を組み立てる。
 */

/** ワークフロー定義ファイルの読み込み口。サイズ上限のチェックを読み込む側の責務にする（design.md #52コメント）。 */
export interface WorkflowFilePort {
  /** バイト数。存在しない・読めない場合は undefined。 */
  fileSize(path: string): Promise<number | undefined>;
  readTextFile(path: string): Promise<string | undefined>;
}

/**
 * 巨大なYAMLで拡張機能ホスト（シングルスレッド）を固まらせないための上限。
 * `workflow.ts` の `MAX_PROMPT_LENGTH`（20000文字）× `MAX_TASK_COUNT`（50）を
 * 大きく超える値を目安にした余裕のある上限で、通常のワークフロー定義には十分すぎる。
 */
export const MAX_WORKFLOW_FILE_BYTES = 1 * 1024 * 1024;

export const nodeWorkflowFilePort: WorkflowFilePort = {
  async fileSize(path: string): Promise<number | undefined> {
    try {
      const stat = await fsPromises.stat(path);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  },
  async readTextFile(path: string): Promise<string | undefined> {
    try {
      return await fsPromises.readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export interface WorkflowRunnerDeps {
  /** provider別の `TaskSessionHost`。`runner.ts` はプロバイダを見ずにこの口だけを使う。 */
  hosts: Record<Provider, TaskSessionHost>;
  /** 1実行（run）につき1つ使い回すこと（`WorktreeCreationQueue` 自身の制約）。 */
  worktreeQueue: WorktreeCreationQueue;
  git: GitCommandRunner;
  fs: WorktreeFileSystemPort;
  filePort: WorkflowFilePort;
  store: WorkflowRunStore;
  log: Logger;
  /**
   * 拡張機能側の現在の設定（クランプの基準）。タスクを開始する瞬間に読み直すため、
   * 呼び出し側は使い捨てのオブジェクトではなく毎回現在値を返す関数を渡すこと。
   */
  readBaseline: () => ExtensionSafetyBaseline;
  /** テスト用の差し替え口。既定は `node:crypto` の `randomUUID`。 */
  randomId?: () => string;
  /** テスト用の差し替え口。既定は `Date.now`。 */
  now?: () => Date;
}

export interface StartWorkflowResult {
  ok: boolean;
  runId?: string;
  errors?: readonly WorkflowIssue[];
  /** `true` のとき、`allowTaskIds` を確認のうえ `allowConfirmed: true` で呼び直すこと（design.md §16.7）。 */
  needsAllowConfirmation?: boolean;
  allowTaskIds?: readonly string[];
}

/** `WorkflowRunner.retryTask` の戻り値。`start()` の `allow` 確認と同じ形にしてある。 */
export interface RetryTaskResult {
  ok: boolean;
  /** `true` のとき、対象タスクに `allow` があるため確認のうえ `allowConfirmed: true` で呼び直すこと。 */
  needsAllowConfirmation?: boolean;
}

/** 一覧表示用の要約。#57のワークフローViewができるまでの間、コマンドのQuickPickに使う。 */
export interface LiveRunSummary {
  runId: string;
  name: string;
  defPath: string;
  outcome: RunOutcome;
}

/**
 * ワークフローViewの警告欄に出す1件（design.md §16.8「警告欄」）。
 *
 * `message` はここで組み立てる時点では拡張機能自身が作った文字列（gitのエラーは
 * `sanitizeForLog` を通した後）だが、Viewはそれでもテキストノードとして挿入する
 * （HTMLエスケープが要らないことをここでは前提にしない）。
 */
export interface WorkflowWarning {
  kind:
    | 'gitFallback'
    | 'gitCommonDir'
    | 'clamp'
    | 'allowOverride'
    | 'maxReached'
    | 'gitignore'
    /**
     * ゴール文から生成したワークフロー（`planner.ts`）が、既定の安全設定を上書きする
     * 指定（`autoApprove: true` / 非空の `allow` / `sandbox` や `approvalMode` の緩和）を
     * 含んでいる（design.md §16.9「分解セッションの制限」）。他のkindは実行時に動的へ
     * 発生するが、これは生成直後のプレビュー（`WorkflowViewManager.previewDefinition`）
     * でも出す必要があるため区別する。
     */
    | 'plannerSecurity';
  /** ワークフロー全体に関わる警告（gitignoreなど）は undefined。 */
  taskId: string | undefined;
  message: string;
}

/** `waitingApproval` のとき、Viewがその場に出す要求内容（design.md §16.8「承認」）。 */
export interface TaskPendingApprovalSnapshot {
  requestId: number | string;
  kind: string;
  title: string;
  detail: string;
}

/** タスク1件のView向けスナップショット。応答本文そのものではなく1行要約だけを持つ。 */
export interface TaskSnapshot {
  id: string;
  dependsOn: readonly string[];
  provider: Provider;
  state: TaskState;
  cwd: string | undefined;
  branch: string | undefined;
  submissionCount: number;
  retryCount: number;
  /** タスクが開始された時刻（ISO8601）。経過時間の表示に使う。未開始なら undefined。 */
  startedAt: string | undefined;
  lastResponseSummary: string;
  failure: TaskFailureReason | undefined;
  pendingApproval: TaskPendingApprovalSnapshot | undefined;
  /**
   * このウィンドウでセッションが生きているか。`reveal` / `中断` / `タスク停止` /
   * `承認` はこれが `true` のときだけ意味を持つ（design.md §16.11「リロード後の実行再開」。
   * リロード直後に復元したrunのタスクにはまだセッションが無く、`再実行` だけが有効）。
   */
  hasLiveSession: boolean;
}

/** ワークフローViewが描画する1実行分のスナップショット（design.md §16.8）。 */
export interface WorkflowRunSnapshot {
  runId: string;
  name: string;
  defPath: string;
  outcome: RunOutcome;
  startedAt: string;
  tasks: readonly TaskSnapshot[];
  warnings: readonly WorkflowWarning[];
  /** 人の割り込み（`manual`/`interrupted`）で実行全体が停止しているか。 */
  haltedByUser: boolean;
}

/** タスク1件の実行時ブックキーピング。`RunState`（純粋）とは別に、セッション等の実体を持つ。 */
interface LiveTask {
  session: TaskSession;
  cwd: string;
  branch: string;
  /** クランプ済みの `autoApprove`。承認判定の入力に使う。 */
  autoApprove: boolean;
  boundary: TaskBoundary;
  /** `isolation: worktree` で実際にworktreeを使ったか。撤去してよいかの判定に使う。 */
  usedWorktree: boolean;
  lastState: ChatState | undefined;
  /** `done` になったときだけ埋まる。後続タスクのテンプレート変数に使う（応答本文は永続化しない）。 */
  result: TaskResult | undefined;
  wasBusy: boolean;
  submissionCount: number;
  /** タスクが開始された時刻（ISO8601）。Viewの経過時間表示に使う。 */
  startedAt: string;
  /** 直近の応答の1行要約（design.md §16.8）。応答本文そのものは持たない。 */
  lastResponseSummary: string;
  /** `waitingApproval` の間だけ埋まる。Viewの「承認」操作が要求内容を出すために使う。 */
  pendingApproval: TaskPendingApprovalSnapshot | undefined;
}

interface LiveRun {
  runId: string;
  def: WorkflowDefinition;
  defPath: string;
  repoRoot: string;
  gitRepo: boolean;
  headCommit: string;
  startedAt: string;
  runState: RunState;
  tasks: Map<string, LiveTask>;
  finished: boolean;
  /** design.md §16.8「警告欄」。発生した順に積む（`maxReached` はスナップショット生成時に動的に足す）。 */
  warnings: WorkflowWarning[];
}

/** `onChanged` の最小限のpub-sub。VSCodeの `EventEmitter` には依存しない（design.mdの方針どおり）。 */
class SimpleEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  on(listener: (value: T) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) {
        this.listeners.splice(i, 1);
      }
    };
  }
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

export class WorkflowRunner {
  private readonly runs = new Map<string, LiveRun>();
  private readonly changeEmitter = new SimpleEmitter<string>();

  constructor(private readonly deps: WorkflowRunnerDeps) {}

  /**
   * 実行状態が変わるたびに呼ばれる（design.md §16.8「更新はタスクの状態が変わったとき」）。
   * 通知の中身は `runId` だけで、実際の値は `getSnapshot` を呼んで取る。Viewはここで
   * 差分を計算し、変わった分だけをwebviewへ送る（design.md「送るのは差分のみ」）。
   *
   * 戻り値は購読解除の関数。VSCodeの `Disposable` は使わない（`runner.ts` はVSCode APIに
   * 依存しない設計方針。design.md §16.10）。
   */
  onChanged(listener: (runId: string) => void): () => void {
    return this.changeEmitter.on(listener);
  }

  private notify(runId: string): void {
    this.changeEmitter.fire(runId);
  }

  /**
   * Viewが描画する現在の状態のスナップショット（design.md §16.8）。
   * 応答本文そのものではなく `LiveTask.lastResponseSummary`（1行要約）だけを渡す。
   */
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return undefined;
    }
    const tasks = live.def.tasks.map((task) => this.buildTaskSnapshot(live, task));
    return {
      runId: live.runId,
      name: live.def.name,
      defPath: live.defPath,
      outcome: getRunOutcome(live.runState),
      startedAt: live.startedAt,
      tasks,
      warnings: [
        ...live.warnings,
        ...this.deriveMaxReachedWarnings(live),
        ...this.deriveAllowWarnings(live),
      ],
      haltedByUser: live.runState.haltedByUser,
    };
  }

  private buildTaskSnapshot(live: LiveRun, task: WorkflowTask): TaskSnapshot {
    const state = live.runState.tasks.get(task.id);
    const liveTask = live.tasks.get(task.id);
    return {
      id: task.id,
      dependsOn: task.dependsOn,
      provider: task.provider,
      state: state?.state ?? 'pending',
      cwd: state?.cwd,
      // ライブなセッションの値を優先する。リロード復元直後はliveTaskが無いため
      // `state.cwd`（永続化された値）へ落ちる（design.md §16.11）
      branch: liveTask?.branch,
      submissionCount: state?.submissionCount ?? 0,
      retryCount: state?.retryCount ?? 0,
      startedAt: liveTask?.startedAt,
      lastResponseSummary: liveTask?.lastResponseSummary ?? '',
      failure: state?.failure,
      pendingApproval: liveTask?.pendingApproval,
      hasLiveSession: liveTask !== undefined,
    };
  }

  /**
   * `allow` による危険判定の解除は定義ファイルから決まる情報であり、状態として
   * 持つ必要が無い（レビュー指摘: high）。以前は`start()`の中で1回だけ`live.warnings`へ
   * 積んでいたため、ウィンドウのリロードで復元した実行（`rebuildLiveRun`は`warnings: []`で
   * 初期化する）では二度と現れなかった。`live.def.tasks`から都度導出すれば、
   * design.md §16.7「どのタスクがどのパターンを解除しているかを常時出す」を
   * 復元経路でも自動的に満たす。
   */
  private deriveAllowWarnings(live: LiveRun): WorkflowWarning[] {
    const warnings: WorkflowWarning[] = [];
    for (const task of live.def.tasks) {
      if (task.allow.length > 0) {
        warnings.push({
          kind: 'allowOverride',
          taskId: task.id,
          message: `allowで危険操作チェックの一部を解除しています: ${task.allow.join(', ')}`,
        });
      }
    }
    return warnings;
  }

  /** 回数切れは状態としてすでに`failed`が持っているため、都度作らず表示のたびに導出する。 */
  private deriveMaxReachedWarnings(live: LiveRun): WorkflowWarning[] {
    const warnings: WorkflowWarning[] = [];
    for (const [taskId, state] of live.runState.tasks) {
      if (state.state === 'failed' && state.failure?.kind === 'maxReached') {
        warnings.push({
          kind: 'maxReached',
          taskId,
          message: `送信回数の上限に達しました（終了条件が満たされないまま停止）: ${taskId}`,
        });
      }
    }
    return warnings;
  }

  /** 現在メモリ上で把握している実行（このウィンドウで開始したもの）の一覧。 */
  listLive(): LiveRunSummary[] {
    return [...this.runs.values()].map((live) => ({
      runId: live.runId,
      name: live.def.name,
      defPath: live.defPath,
      outcome: getRunOutcome(live.runState),
    }));
  }

  /**
   * このsessionId（Codexのthread id / Claudeのsession id）がタスク（オーケストレータ）
   * 管理下かどうかを答える（design.md §16.10の7）。`ChatViewManager` /
   * `ClaudeChatViewManager` の `isTaskManagedThread` へそのまま渡す用途。
   *
   * **永続化された`WorkflowRunStore`を見る。メモリ上の `this.runs` だけを見てはいけない。**
   * ウィンドウのリロード直後は `this.runs`（このプロセスのライブな実行状態）が空になる
   * 一方、`restorePanel`（VSCodeのWebviewパネル復元）はまさにその瞬間に呼ばれる。
   * メモリだけを見ると常に`false`を返してしまい、worktreeで走っていたタスクのタブが
   * 汎用復元に拾われてワークスペース直下のcwdでセッションが復活する事故になる
   * （レビュー指摘: critical 1）。`workspaceState`は`reconcileAfterReload`後も
   * `sessionId`を保持したまま残るため、これを見れば復元直後でも正しく判定できる。
   */
  isTaskManagedSessionId(sessionId: string): boolean {
    if (sessionId === '') {
      return false;
    }
    return this.deps.store
      .list()
      .some((run) => Object.values(run.tasks).some((t) => t.sessionId === sessionId));
  }

  /**
   * リロード直後に呼ぶ（design.md §16.11「リロード後の実行再開」）。
   *
   * `workspaceState` に残っているrun（`reconcileAfterReload` で走行中タスクを
   * 中断扱いへ倒し済み）をメモリ上へ復元し、ワークフローViewが表示・「再実行」
   * できるようにする。#56では中断扱いに倒すところまでしか実装していなかった。
   *
   * 定義ファイルが読めない・検証を通らないrunは復元をあきらめる（ログにだけ残す）。
   * そのrunはこのウィンドウのライブな状態には現れないが、`workspaceState`自体からは
   * 消さない（ファイルを直して次回リロードすれば復元できる余地を残す）。
   */
  async restoreRunsForView(): Promise<void> {
    const persisted = await this.deps.store.reconcileAfterReload();
    for (const p of persisted) {
      if (this.runs.has(p.runId)) {
        continue;
      }
      const rebuilt = await this.rebuildLiveRun(p);
      if (rebuilt !== undefined) {
        this.runs.set(p.runId, rebuilt);
      }
    }
  }

  private async rebuildLiveRun(p: PersistedRun): Promise<LiveRun | undefined> {
    // start()と同じ上限チェックをここでも通す（レビュー指摘: medium 2）。
    // `MAX_WORKFLOW_FILE_BYTES`のコメントどおり「巨大なYAMLで拡張機能ホスト
    // （シングルスレッド）を固まらせない」ための防御であり、復元経路だけ素通りさせない
    const size = await this.deps.filePort.fileSize(p.defPath);
    if (size === undefined || size > MAX_WORKFLOW_FILE_BYTES) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    const text = await this.deps.filePort.readTextFile(p.defPath);
    if (text === undefined) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルを読み込めないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(text);
    } catch {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルの解析に失敗したため復元できません: ${p.defPath}`,
      );
      return undefined;
    }
    if (validateWorkflow(def).errors.length > 0) {
      this.deps.log.warn(
        `[workflow ${p.runId}] 定義ファイルが検証を通らないため復元できません: ${p.defPath}`,
      );
      return undefined;
    }

    const gitRepo = await isGitWorkingTree(p.workspaceRoot, this.deps.git);
    // 元のHEADは永続化していない（design.md §16.11は応答本文以外も最小限しか保存しない
    // 方針）ため、復元した時点のHEADを分岐元にする。再実行は元々「新しいスレッド・
    // worktreeでやり直す」設計（design.md §16.5）なので、この差異は再実行の意味を壊さない
    const headCommit = gitRepo
      ? ((await resolveHeadCommit(p.workspaceRoot, this.deps.git)) ?? '')
      : '';

    const tasks = new Map<string, TaskRunState>();
    for (const [id, t] of Object.entries(p.tasks)) {
      tasks.set(id, {
        state: t.state,
        submissionCount: t.submissionCount,
        retryCount: t.retryCount,
        failure: t.failure,
        sessionId: t.sessionId,
        cwd: t.cwd,
      });
    }
    const runState: RunState = { tasks, haltedByUser: p.haltedByUser };

    return {
      runId: p.runId,
      def,
      defPath: p.defPath,
      repoRoot: p.workspaceRoot,
      gitRepo,
      headCommit,
      startedAt: p.startedAt,
      runState,
      // このプロセスでまだセッションを開いていない。`hasLiveSession: false`として
      // Viewへ出る（design.md §16.11。再実行すればstartTask()が新しく作る）
      tasks: new Map(),
      finished: getRunOutcome(runState) !== 'running',
      warnings: [],
    };
  }

  /**
   * 定義ファイルを読み込み、検証し、通れば実行を開始する。
   *
   * `repoRoot` はワークフロー定義ファイルが属するワークスペースフォルダの絶対パス
   * （design.md §16.6「`currentWorkspaceFolder()` は使わない」の呼び出し側での実践）。
   *
   * `allow` を含むタスクが1件でもあれば、`options.allowConfirmed !== true` の間は
   * 実行を始めず `needsAllowConfirmation` を立てて返す（design.md §16.7「`allow`を含む
   * ワークフローは、実行開始時に...確認を取る」）。呼び出し側（`extension.ts` /
   * ワークフローView）はこれを見てモーダルを出し、確認が取れたら
   * `allowConfirmed: true` で呼び直す。
   */
  async start(
    defPath: string,
    repoRoot: string,
    options?: { allowConfirmed?: boolean },
  ): Promise<StartWorkflowResult> {
    const size = await this.deps.filePort.fileSize(defPath);
    if (size === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }
    if (size > MAX_WORKFLOW_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          issue(
            `定義ファイルが大きすぎます（上限${MAX_WORKFLOW_FILE_BYTES}バイト）: ${size}バイト`,
          ),
        ],
      };
    }
    const text = await this.deps.filePort.readTextFile(defPath);
    if (text === undefined) {
      return { ok: false, errors: [issue(`定義ファイルを読み込めません: ${defPath}`)] };
    }

    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errors: [issue(`YAMLの解析に失敗しました: ${message}`)] };
    }

    const validation = validateWorkflow(def);
    for (const w of validation.warnings) {
      this.deps.log.warn(`[workflow] ${w.message}`);
    }
    if (validation.errors.length > 0) {
      return { ok: false, errors: validation.errors };
    }

    const allowTaskIds = def.tasks.filter((t) => t.allow.length > 0).map((t) => t.id);
    if (allowTaskIds.length > 0 && options?.allowConfirmed !== true) {
      return { ok: false, needsAllowConfirmation: true, allowTaskIds };
    }

    const gitRepo = await isGitWorkingTree(repoRoot, this.deps.git);
    let headCommit = '';
    if (gitRepo) {
      const head = await resolveHeadCommit(repoRoot, this.deps.git);
      if (head === undefined) {
        return { ok: false, errors: [issue('HEADコミットを解決できませんでした')] };
      }
      headCommit = head;
    } else {
      const strictWithoutCwd = def.tasks.find(
        (t) => t.isolation === 'worktree-strict' && t.cwd === undefined,
      );
      if (strictWithoutCwd !== undefined) {
        return {
          ok: false,
          errors: [
            issue(
              'ワークスペースがgitの作業ツリーではないため、isolation: worktree-strict のタスクを実行できません',
              [strictWithoutCwd.id],
            ),
          ],
        };
      }
    }

    const cwdErrors = await this.validateExplicitCwds(def, repoRoot);
    if (cwdErrors.length > 0) {
      return { ok: false, errors: cwdErrors };
    }

    const gitignoreCheck = await checkWorktreesGitignored(repoRoot, this.deps.fs);
    const warnings: WorkflowWarning[] = [];
    if (gitignoreCheck.needsEntry && gitignoreCheck.message !== undefined) {
      this.deps.log.warn(`[workflow] ${gitignoreCheck.message}`);
      warnings.push({ kind: 'gitignore', taskId: undefined, message: gitignoreCheck.message });
    }
    // allowによる危険判定の解除はここでは積まない。`getSnapshot`が`live.def.tasks`から
    // 都度導出する（`deriveAllowWarnings`）。ここで1回だけ積むと、ウィンドウのリロードで
    // 復元した実行（`rebuildLiveRun`は`warnings: []`で初期化する）では二度と現れず、
    // design.md §16.7の「常時出す」が復元経路だけ欠けてしまう（レビュー指摘: high）

    const runId = this.deps.randomId?.() ?? randomUUID();
    const live: LiveRun = {
      runId,
      def,
      defPath,
      repoRoot,
      gitRepo,
      headCommit,
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      runState: createRunState(def.tasks),
      tasks: new Map(),
      finished: false,
      warnings,
    };
    this.runs.set(runId, live);
    await this.persist(runId);
    this.notify(runId);
    this.pump(runId);
    return { ok: true, runId };
  }

  /**
   * 実行全体を停止する。人の割り込み（`manual`）と同じ扱いで、新しいタスクの開始だけを
   * 止める。既に `running` のタスクはそのまま走らせ切る（design.md §16.5）。
   */
  stop(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    // `manual` / `interrupted` の遷移はtaskIdを使わない（実装上の事実。runState.ts参照）ため
    // 空文字で十分だが、意図を示すため定数として明示しておく
    const NO_SPECIFIC_TASK = '';
    live.runState = applyLoopStopReason(live.runState, live.def.tasks, NO_SPECIFIC_TASK, 'manual');
    this.notify(runId);
    void this.persist(runId);
  }

  // ---- ワークフローViewからのタスク単位の操作（design.md §16.8） ----

  /**
   * そのタスクのチャットタブを前面に出す。閉じていれば作り直し、会話を復元する
   * （`TaskSession.reveal()`。#56で実装済みの寿命分離をそのまま使う）。
   *
   * リロード直後で復元しただけの実行（`live.tasks` にまだ実体が無い）に対しては
   * 何もできない。`false` を返すので、Viewは「再実行」だけを案内する。
   */
  revealTask(runId: string, taskId: string): boolean {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    if (liveTask === undefined) {
      return false;
    }
    liveTask.session.reveal();
    return true;
  }

  /**
   * 進行中のターンだけ止める（design.md §16.8「中断」）。タスクのループは続き、
   * 次の指示（`continuePrompt`）から進む。`TaskSession.interrupt()` を直接呼ぶだけで、
   * `noteUserAction()` は経由しない（それだとループごと止まってしまう。`taskSession.ts` 参照）。
   */
  async interruptTask(runId: string, taskId: string): Promise<void> {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    if (liveTask === undefined) {
      return;
    }
    await liveTask.session.interrupt();
  }

  /**
   * そのタスクのループを止め、`failed`（手動停止）にする（design.md §16.8「タスク停止」）。
   *
   * `TaskSession.stopLoop()` はループを `LoopStopReason: 'taskStopped'` で止め、
   * 通常の完了検知経路（`onFinished` → `onTaskFinished`）へ合流する。そちら側で
   * `applyLoopStopReason` が `manualStop` として確定し、セッションの解放とworktreeの
   * 撤去判定まで一貫して行われるため、ここでは呼び出すだけでよい。
   */
  stopTask(runId: string, taskId: string): void {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    if (liveTask === undefined) {
      return;
    }
    liveTask.session.stopLoop();
  }

  /**
   * `failed` / `skipped` のタスクを、依存が満たされていればもう1度走らせる
   * （design.md §16.8「再実行」）。対象外（依存未達・未確定の状態・未知のid）なら
   * 何もせず `false` を返す。
   *
   * リロード直後で復元した実行（`live.tasks` が空）でも動く。`retryTaskState` が
   * `live.runState`（`workspaceState` から復元済み）だけを見て `pending` へ戻し、
   * `pump()` が `startTask()` を呼んで新しいセッションを作る。
   *
   * 対象タスクに非空の `allow` があれば、`options.allowConfirmed !== true` の間は
   * 再実行を始めず `needsAllowConfirmation` を立てて返す（`start()` と同じ形。
   * レビュー指摘: high）。`start()` の実行前確認は**そのプロセスの最初の起動時**にしか
   * 効かず、ウィンドウのリロード後に復元した実行を「再実行」する経路はそれを経由しない
   * ため、ここでも独立して確認を要求する。
   */
  retryTask(
    runId: string,
    taskId: string,
    options?: { allowConfirmed?: boolean },
  ): RetryTaskResult {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return { ok: false };
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task !== undefined && task.allow.length > 0 && options?.allowConfirmed !== true) {
      return { ok: false, needsAllowConfirmation: true };
    }
    const next = retryTaskState(live.runState, live.def.tasks, taskId);
    if (next === live.runState) {
      return { ok: false };
    }
    live.runState = next;
    // 停止していた実行を人の操作で再開する起点でもあるため、finishedを解除する
    live.finished = false;
    this.notify(runId);
    void this.persist(runId);
    this.pump(runId);
    return { ok: true };
  }

  /**
   * `waitingApproval` の要求を、チャット画面のタブを開かずその場で決める
   * （design.md §16.8「承認」）。`handleApproval` が保留した `pendingApproval` の
   * `requestId` を使って `TaskSession.decideApproval` を呼ぶ。対象が無ければ何もしない。
   */
  decideApproval(runId: string, taskId: string, decision: ApprovalDecision): boolean {
    const liveTask = this.runs.get(runId)?.tasks.get(taskId);
    const pending = liveTask?.pendingApproval;
    if (liveTask === undefined || pending === undefined) {
      return false;
    }
    liveTask.session.decideApproval(pending.requestId, decision);
    return true;
  }

  /**
   * 終わった（`done`/`failed`/`skipped`）タスクのworktreeをまとめて撤去する
   * （design.md §16.8「そのほか」の操作。`cleanup: keep` のまま放置されたものを
   * 後から片付ける手段）。
   */
  async removeWorktrees(runId: string): Promise<{ removed: string[]; failed: string[] }> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return { removed: [], failed: [] };
    }
    const removed: string[] = [];
    const failed: string[] = [];
    for (const task of live.def.tasks) {
      const state = live.runState.tasks.get(task.id);
      if (
        state === undefined ||
        (state.state !== 'done' && state.state !== 'failed' && state.state !== 'skipped')
      ) {
        continue;
      }
      const liveTask = live.tasks.get(task.id);
      // このウィンドウでworktreeを作ったことが判っている（liveTask.usedWorktree）場合を
      // 優先し、リロード復元でliveTaskが無い場合は定義から推定する（cwdを明示していない
      // worktree系isolationかつgitリポジトリなら作られたはず、という近似）
      const usedWorktree =
        liveTask?.usedWorktree ??
        (task.cwd === undefined &&
          (task.isolation === 'worktree' || task.isolation === 'worktree-strict') &&
          live.gitRepo);
      if (!usedWorktree) {
        continue;
      }
      const retry = retrySuffixOf(state.retryCount);
      const result = await this.deps.worktreeQueue.remove(
        live.repoRoot,
        runId,
        task.id,
        retry,
        this.deps.git,
      );
      if (result.ok) {
        removed.push(task.id);
      } else {
        failed.push(task.id);
        this.deps.log.warn(
          `[workflow ${runId}/${task.id}] worktreeの撤去に失敗しました: ${result.message}`,
        );
      }
    }
    this.notify(runId);
    return { removed, failed };
  }

  // ---- スケジューリング ----

  /** 状態が変わるたびに呼ぶ（design.md §16.3）。次に開始できるタスクを開始し、終了を判定する。 */
  private pump(runId: string): void {
    const live = this.runs.get(runId);
    if (live === undefined || live.finished) {
      return;
    }
    const toStart = nextTasksToStart(live.def, live.runState);
    for (const taskId of toStart) {
      // 開始の意思決定と同時にrunningへ倒す。非同期のstartTaskが終わるまで待つと、
      // 同じタスクが次のpump呼び出しで二重にnextTasksToStartへ拾われてしまう
      live.runState = markRunning(live.runState, taskId);
      void this.startTask(runId, taskId);
    }
    void this.persist(runId);
    this.notify(runId);

    const outcome = getRunOutcome(live.runState);
    if (outcome !== 'running' && !live.finished) {
      live.finished = true;
      this.deps.log.info(`[workflow ${runId}] 実行が終了しました: ${outcome}`);
    }
  }

  private async startTask(runId: string, taskId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const task = live.def.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      return;
    }

    try {
      const retry = retrySuffixOf(live.runState.tasks.get(taskId)?.retryCount);
      const { cwd, branch, usedWorktree } = await this.resolveWorkingDirectory(live, task, retry);

      const baseline = this.deps.readBaseline();
      // クランプはこの1関数だけを通す（design.md §16.16。#52セキュリティ監査指摘）
      const effective = buildEffectiveTaskConfig(task, baseline);
      for (const w of effective.warnings) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${w}`);
        live.warnings.push({ kind: 'clamp', taskId, message: w });
      }

      // 最終防御（レビュー指摘: critical 3）。bypassPermissionsでは`can_use_tool`が
      // 発行されず、classifyApprovalRequest / autoApprove / escalate / allow が
      // 一度も呼ばれない。workflow.tsのvalidateWorkflowはYAMLリテラルの
      // `approvalMode: bypassPermissions`一致だけを見るため、YAML側が何も指定せず
      // 拡張機能側の設定が既にbypassPermissionsの場合は素通りしてしまう（実測で確認済み）。
      // ここは実効値（クランプ後の値）に対する検査であり、YAMLの記述に関わらず効く
      if (task.provider === 'claude' && effective.config.approvalMode === 'bypassPermissions') {
        throw new Error(
          '実効approvalModeがbypassPermissionsのため、このタスクは開始できません' +
            '（危険判定が働かない設定での無人実行はできません）',
        );
      }

      const input: TaskSessionInput = { cwd, config: effective.config, sandbox: effective.sandbox };

      const boundaryResult = await this.buildBoundary(live, cwd);
      if (boundaryResult.warning !== undefined) {
        this.deps.log.warn(`[workflow ${runId}/${taskId}] ${boundaryResult.warning}`);
        live.warnings.push({ kind: 'gitCommonDir', taskId, message: boundaryResult.warning });
      }

      const host = this.deps.hosts[task.provider];
      const session = await host.openTaskSession(input);
      session.open({ preserveFocus: true });

      const liveTask: LiveTask = {
        session,
        cwd,
        branch,
        autoApprove: effective.autoApprove,
        boundary: boundaryResult.boundary,
        usedWorktree,
        lastState: undefined,
        result: undefined,
        wasBusy: false,
        submissionCount: 0,
        startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        lastResponseSummary: '',
        pendingApproval: undefined,
      };
      live.tasks.set(taskId, liveTask);
      live.runState = recordSessionInfo(live.runState, taskId, session.sessionId, cwd);

      session.setApprovalHandler((approval, rawParams) =>
        this.handleApproval(runId, taskId, task, approval, rawParams),
      );
      session.onApprovalResolved((outcome) =>
        this.onApprovalResolved(runId, taskId, outcome.decision),
      );
      session.onStateChanged((state) => this.onTaskStateChanged(runId, taskId, state));
      session.onFinished((reason, state) =>
        this.onTaskFinished(runId, taskId, task, reason, state),
      );

      // テンプレート展開はタスク開始直前に行う（design.md §16.4）。`runLoop` へ渡す本文は
      // 展開前のまま（作業記録に残すため。§16.12）で、実際の送信直前にpromptTransformで展開する
      const resultsMap = this.buildResultsMap(live, task);
      session.setPromptTransform((text) => expandTemplate(text, resultsMap));

      session.runLoop({
        initialPrompt: task.prompt,
        continuePrompt: task.continuePrompt,
        maxIterations: task.maxIterations,
        condition: task.done,
      });
      this.notify(runId);
    } catch (e) {
      // openTaskSessionの失敗はCLIプロセス起動時のエラーをそのまま含みうる。
      // worktree.ts側のgitエラーは既に無害化済みだが、ここでも共通ヘルパーを通しておく
      // （レビュー指摘: warning。sanitizeForLogは冪等に近く、二重に通しても実害は無い）
      const message = sanitizeForLog(e instanceof Error ? e.message : String(e));
      this.deps.log.error(`[workflow ${runId}/${taskId}] タスクを開始できませんでした: ${message}`);
      live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, 'failed');
      void this.persist(runId);
      this.notify(runId);
      this.pump(runId);
    }
  }

  /**
   * `cwd` を実パス解決し、`repoRoot` の実パス配下にあるか確かめる。
   *
   * cwdを無検証で通すと、`sandbox: workspace-write` の「workspace」の基準そのものを
   * YAMLから付け替えられる（例: cwdに `~/.ssh` を指定すれば、そこが書き込み可能な領域に
   * なる）。design.md §16.16 が塞ぐと決めている経路。`workflow.ts` の検証は実パス解決を
   * 伴わないためこの判定ができず、実行層の責務になる。
   */
  private async resolveExplicitCwd(
    cwd: string,
    repoRoot: string,
  ): Promise<{ ok: true; resolved: string } | { ok: false; message: string }> {
    const resolvedCwd = await this.deps.fs.realpath(cwd);
    if (resolvedCwd === undefined) {
      return { ok: false, message: `cwdを解決できませんでした: ${cwd}` };
    }
    // 境界側も実パスに直してから比べる。シンボリックリンク越しに外へ出るのを防ぐ
    const resolvedRoot = (await this.deps.fs.realpath(repoRoot)) ?? repoRoot;
    if (!isPathWithinRoot(resolvedCwd, resolvedRoot)) {
      return {
        ok: false,
        message: `cwdがワークスペースの外を指しています（design.md §16.16）: ${cwd}`,
      };
    }
    return { ok: true, resolved: resolvedCwd };
  }

  /**
   * 全タスクの明示`cwd`を実行開始前に一括で検証する（design.md §16.2「1件でも該当すれば
   * 実行を始めない」）。タスクごと（`startTask`内）の事後検証だけだと、正当なcwdの
   * タスクが先に開始・副作用を残した後で別タスクの違反が判明しうる
   * （レビュー指摘: warning）。
   */
  private async validateExplicitCwds(
    def: WorkflowDefinition,
    repoRoot: string,
  ): Promise<WorkflowIssue[]> {
    const errors: WorkflowIssue[] = [];
    for (const task of def.tasks) {
      if (task.cwd === undefined) {
        continue;
      }
      const resolved = await this.resolveExplicitCwd(task.cwd, repoRoot);
      if (!resolved.ok) {
        errors.push(issue(resolved.message, [task.id]));
      }
    }
    return errors;
  }

  private buildResultsMap(live: LiveRun, task: WorkflowTask): Map<string, TaskResult> {
    const map = new Map<string, TaskResult>();
    for (const depId of task.dependsOn) {
      const result = live.tasks.get(depId)?.result;
      if (result !== undefined) {
        map.set(depId, result);
      }
    }
    return map;
  }

  private async resolveWorkingDirectory(
    live: LiveRun,
    task: WorkflowTask,
    retry: number | undefined,
  ): Promise<{ cwd: string; branch: string; usedWorktree: boolean }> {
    const decision = decideWorkingDirectory(task, live.gitRepo);
    if (decision.kind === 'explicitCwd') {
      // decision.kind==='explicitCwd'はtask.cwdが設定されている場合にしか出ない
      // （decideWorkingDirectoryの実装参照）。ここで無いのは呼び出し元の不整合
      if (task.cwd === undefined) {
        throw new Error('内部矛盾: explicitCwdの判定なのにcwdが無いタスクです');
      }
      // 実行開始時（start()）の一括検証を必ず通っている前提だが、念のためここでも確かめる
      // （多層防御。呼び出し順序の変更などで一括検証が経由されなくても危険側に倒れない）
      const resolved = await this.resolveExplicitCwd(task.cwd, live.repoRoot);
      if (!resolved.ok) {
        throw new Error(resolved.message);
      }
      return { cwd: resolved.resolved, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'shared') {
      return { cwd: live.repoRoot, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'sharedFallback') {
      this.deps.log.warn(`[workflow ${live.runId}/${task.id}] ${decision.warning}`);
      live.warnings.push({ kind: 'gitFallback', taskId: task.id, message: decision.warning });
      return { cwd: live.repoRoot, branch: '', usedWorktree: false };
    }
    if (decision.kind === 'error') {
      throw new Error(decision.message);
    }

    const result = await this.deps.worktreeQueue.create(
      {
        repoRoot: live.repoRoot,
        runId: live.runId,
        taskId: task.id,
        headCommit: live.headCommit,
        retry,
      },
      this.deps.git,
      this.deps.fs,
    );
    if (!result.ok) {
      throw new Error(`worktreeの作成に失敗しました: ${result.message}`);
    }
    return { cwd: result.cwd, branch: result.branch, usedWorktree: true };
  }

  private async buildBoundary(
    live: LiveRun,
    cwd: string,
  ): Promise<{ boundary: TaskBoundary; warning: string | undefined }> {
    const result = await buildTaskBoundary([cwd], live.repoRoot, this.deps.git, this.deps.fs);
    return { boundary: result.boundary, warning: result.gitCommonDirWarning };
  }

  // ---- 承認 ----

  private async handleApproval(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    approval: PendingApproval,
    rawParams: Record<string, unknown>,
  ): Promise<ApprovalHandlerResult> {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      // 不整合（起きない想定）。安全側でaskへ倒す
      return { kind: 'ask' };
    }

    const request = await buildEscalationRequest(
      task.provider,
      approval,
      rawParams,
      liveTask.cwd,
      liveTask.lastState?.items ?? [],
      this.deps.fs,
    );
    const policy: EscalationPolicy = {
      escalate: task.escalate,
      allow: task.allow,
      autoApprove: liveTask.autoApprove,
    };
    const result = classifyApprovalRequest(request, liveTask.boundary, policy);
    this.deps.log.info(
      `[workflow ${runId}/${taskId}] 承認判定(${approval.kind}): ${result.decision} - ${result.reasons.join(' / ')}`,
    );

    if (result.decision === 'auto') {
      return { kind: 'auto', decision: 'accept' };
    }

    // Viewの「承認」操作（`decideApproval`）がその場に要求内容を出すために持っておく
    // （design.md §16.8）。応答が決まったら`onApprovalResolved`側で消す。
    //
    // title/detail（コマンド文字列・cwd・reasonを含む）は`describeApproval`が組み立てた
    // ものでCLI・エージェント由来のため信用しない。`textContent`で挿入する限りXSSには
    // ならないが、双方向制御文字（RTL override等）は表示上の文字列を反転・偽装できる。
    // ワークフローViewの「承認」は会話タブを開かずその場で決める設計（design.md §16.8）で
    // 通常のチャット画面より文脈が少なく、見た目の偽装が誤判断に直結しやすいため
    // `stripControlChars`を通す（レビュー指摘: medium 3）。`detail`は切り詰めない
    // （危険な内容の一部が「…」に隠れて見えなくなるほうが、承認可否の判断としては危険）
    liveTask.pendingApproval = {
      requestId: approval.requestId,
      kind: approval.kind,
      title: sanitizeForLog(approval.title),
      detail: stripControlChars(approval.detail),
    };
    live.runState = markWaitingApproval(live.runState, taskId);
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
    return { kind: 'ask' };
  }

  private onApprovalResolved(runId: string, taskId: string, decision: ApprovalDecision): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const liveTask = live.tasks.get(taskId);
    if (liveTask !== undefined) {
      liveTask.pendingApproval = undefined;
    }
    if (decision === 'accept' || decision === 'acceptForSession') {
      live.runState = resumeFromApproval(live.runState, taskId);
    } else {
      // decline / cancel。危険操作を人が拒否した。`retries` の自動再試行の対象にしない
      // 専用の経路（design.md §16.5「承認拒否をfailedとして通知してはならない」）
      live.runState = markApprovalRejected(live.runState, live.def.tasks, taskId);
    }
    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  // ---- 完了検知 ----

  private onTaskStateChanged(runId: string, taskId: string, state: ChatState): void {
    const live = this.runs.get(runId);
    const liveTask = live?.tasks.get(taskId);
    if (live === undefined || liveTask === undefined) {
      return;
    }
    liveTask.lastState = state;
    // 直近の応答の1行要約（design.md §16.8）。ストリーミング中も更新するため、
    // ターンの区切りを待たず毎回計算し直す（応答本文そのものは保持しない）
    liveTask.lastResponseSummary = buildResponseSummary(state);
    // 送信回数はLoopControllerが内部に持ち、TaskSessionからは見えないため、
    // ターン開始（busyの立ち上がり）の回数で近似する
    const startedTurn = !liveTask.wasBusy && state.busy;
    liveTask.wasBusy = state.busy;
    if (startedTurn) {
      liveTask.submissionCount += 1;
      live.runState = recordSubmissionCount(live.runState, taskId, liveTask.submissionCount);
      void this.persist(runId);
    }
    // 状態変化のたびにViewへ知らせる。永続化（persist）は送信回数の節目だけに絞ったままだが、
    // 表示専用の通知はストリーミング中の要約更新でも毎回出す
    this.notify(runId);
  }

  private onTaskFinished(
    runId: string,
    taskId: string,
    task: WorkflowTask,
    reason: LoopStopReason,
    state: ChatState,
  ): void {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const liveTask = live.tasks.get(taskId);

    if (reason === 'done' && liveTask !== undefined) {
      liveTask.result = {
        result: state.turnResultText,
        cwd: liveTask.cwd,
        branch: liveTask.branch,
        files: [...state.turnEditedFiles],
      };
    }

    live.runState = applyLoopStopReason(live.runState, live.def.tasks, taskId, reason);

    if (reason !== 'manual' && reason !== 'interrupted') {
      // done / maxReached / failed。セッションを解放する（design.md §16.10の4）。
      // 再試行はここで新しいセッション・worktreeを新規に作るため、古いものは残さない
      liveTask?.session.dispose();
      this.cleanupWorktreeIfNeeded(live, task, taskId, liveTask);
    }

    void this.persist(runId);
    this.notify(runId);
    this.pump(runId);
  }

  private cleanupWorktreeIfNeeded(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    liveTask: LiveTask | undefined,
  ): void {
    if (liveTask === undefined || !liveTask.usedWorktree) {
      return;
    }
    const finalState = live.runState.tasks.get(taskId)?.state;
    if (finalState === undefined || !shouldRemoveWorktree(task.cleanup, finalState)) {
      return;
    }
    const retry = retrySuffixOf(live.runState.tasks.get(taskId)?.retryCount);
    void this.deps.worktreeQueue
      .remove(live.repoRoot, live.runId, taskId, retry, this.deps.git)
      .then((result) => {
        if (!result.ok) {
          this.deps.log.warn(
            `[workflow ${live.runId}/${taskId}] worktreeの撤去に失敗しました: ${result.message}`,
          );
        }
      });
  }

  // ---- 永続化 ----

  private async persist(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (live === undefined) {
      return;
    }
    const tasks: Record<string, PersistedTaskState> = {};
    for (const [id, s] of live.runState.tasks) {
      const liveTask = live.tasks.get(id);
      tasks[id] = {
        state: s.state,
        sessionId: s.sessionId,
        cwd: s.cwd,
        branch: liveTask?.branch,
        submissionCount: s.submissionCount,
        retryCount: s.retryCount,
        failure: s.failure,
      };
    }
    const outcome = getRunOutcome(live.runState);
    await this.deps.store.update(runId, (current) => ({
      runId,
      defPath: live.defPath,
      workspaceRoot: live.repoRoot,
      startedAt: current?.startedAt ?? live.startedAt,
      finishedAt:
        outcome === 'running' ? undefined : (current?.finishedAt ?? new Date().toISOString()),
      tasks,
      haltedByUser: live.runState.haltedByUser,
    }));
  }
}

function issue(message: string, taskIds: string[] = []): WorkflowIssue {
  return { taskIds, message };
}

/**
 * `TaskRunState.retryCount`（0開始。「これまでの自動再試行回数」）から、
 * `worktreePath` / `branchName` が受け取る `retry` サフィックス番号（0開始）へ変換する。
 *
 * `retryCount` は `applyLoopStopReason` が**次の試行を始める前に**インクリメントする
 * （design.md §16.5の再試行判定）ため、1回目の失敗直後は `retryCount === 1` になる。
 * これは「1回retryを消費した」という意味であり、そのままworktreeのサフィックスに使うと
 * 1回目の再試行が `-retry1` になってしまう（`worktree.test.ts` が固定している規約は
 * 1回目の再試行が `-retry0`）。1つずらして渡す必要がある
 * （レビュー指摘: high。テスト追加で発覚したオフバイワン）。
 */
function retrySuffixOf(retryCount: number | undefined): number | undefined {
  return retryCount !== undefined && retryCount > 0 ? retryCount - 1 : undefined;
}
