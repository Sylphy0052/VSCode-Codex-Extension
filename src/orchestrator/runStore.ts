import type { TaskFailureReason, TaskState } from './runState';

/**
 * ワークフロー実行状態の永続化と復元（design.md §16.11）。
 *
 * `workspaceState` は暗号化されない平文ストレージのため、**応答本文は保存しない**。
 * `{{T.result}}` の元になるテキストは機微を含みうる。保存するのは状態・id・パスなど、
 * 復元後に人が判断するために必要な最小限に留める。
 */

/** `vscode.Memento` と構造的に一致する最小限の口。`context.workspaceState` をそのまま渡せる。 */
export interface WorkflowRunMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export const WORKFLOW_RUNS_KEY = 'codex.workflow.runs';

/** 走り終えたrunも含めて残す最大件数（design.md §16.11）。超過分は開始時刻の古い順に消す。 */
export const MAX_STORED_RUNS = 10;

export interface PersistedTaskState {
  state: TaskState;
  sessionId: string | undefined;
  cwd: string | undefined;
  branch: string | undefined;
  submissionCount: number;
  retryCount: number;
  failure: TaskFailureReason | undefined;
}

export interface PersistedRun {
  runId: string;
  /** ワークフロー定義ファイルの絶対パス。 */
  defPath: string;
  /** ワークスペースフォルダの絶対パス。worktreeの置き場の基準（design.md §16.6）。 */
  workspaceRoot: string;
  /** ISO8601。 */
  startedAt: string;
  /** 実行中は undefined。終了判定が付いた時点で埋める。 */
  finishedAt: string | undefined;
  tasks: Record<string, PersistedTaskState>;
  /** `manual` / `interrupted`（人の割り込み）で実行全体が停止しているか（runState.tsのRunStateと同じ意味）。 */
  haltedByUser: boolean;
}

/**
 * ウィンドウのリロード直後、走行中（`running` / `waitingApproval`）だったタスクを
 * `failed`（理由: 中断）として扱う（design.md §16.11）。まだ手を付けていなかった
 * `pending` は、対応するライブの実行状態（`RunState`）ごと失われる以上、実行全体が
 * 止まったのと同じ扱いで `skipped`（`runHalted`）にする。`done` / `failed` / `skipped`
 * は既に確定しているため触らない。
 *
 * 純粋関数。呼び出し側（`WorkflowRunStore.reconcileAfterReload` / `runner.ts`）が
 * 実際の読み書きと後続の記録（ログ・Viewへの通知）を担う。
 */
export function reconcileRunOnReload(run: PersistedRun): PersistedRun {
  let changed = false;
  const tasks: Record<string, PersistedTaskState> = {};
  for (const [id, task] of Object.entries(run.tasks)) {
    if (task.state === 'running' || task.state === 'waitingApproval') {
      tasks[id] = { ...task, state: 'failed', failure: { kind: 'reloadInterrupted' } };
      changed = true;
      continue;
    }
    if (task.state === 'pending') {
      tasks[id] = { ...task, state: 'skipped', failure: { kind: 'runHalted' } };
      changed = true;
      continue;
    }
    tasks[id] = task;
  }
  if (!changed) {
    return run;
  }
  return { ...run, tasks, finishedAt: run.finishedAt ?? new Date().toISOString() };
}

function trimRuns(runs: readonly PersistedRun[]): PersistedRun[] {
  return [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_STORED_RUNS);
}

/**
 * `workspaceState` への読み書きを1本のキューに通して直列化する。
 *
 * 複数のタスクが並列に走ると、状態変化のたびに `update` が競合しうる。素朴な
 * 「読む→書く」を並行実行すると後勝ちで途中の更新が失われる（lost update）ため、
 * `worktree.ts` の `WorktreeCreationQueue` と同じ流儀で直列化する。
 */
export class WorkflowRunStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly memento: WorkflowRunMemento) {}

  list(): readonly PersistedRun[] {
    return this.memento.get<PersistedRun[]>(WORKFLOW_RUNS_KEY, []);
  }

  find(runId: string): PersistedRun | undefined {
    return this.list().find((r) => r.runId === runId);
  }

  /**
   * 指定runIdの内容を関数で更新する。直列化されるため、並行呼び出しでも
   * 読み・書きの間に別の更新が割り込まない。runIdが未登録なら新規追加する。
   */
  update(
    runId: string,
    updater: (current: PersistedRun | undefined) => PersistedRun,
  ): Promise<void> {
    return this.enqueue(async () => {
      const all = this.list();
      const index = all.findIndex((r) => r.runId === runId);
      const current = index === -1 ? undefined : all[index];
      const next = updater(current);
      const merged = index === -1 ? [next, ...all] : all.map((r, i) => (i === index ? next : r));
      await this.memento.update(WORKFLOW_RUNS_KEY, trimRuns(merged));
    });
  }

  /**
   * リロード直後に呼ぶ。全runの走行中タスクを中断扱いへ書き換える
   * （`reconcileRunOnReload`）。変化が無いrunは書き込まない。
   */
  reconcileAfterReload(): Promise<readonly PersistedRun[]> {
    return this.enqueue(async () => {
      const all = this.list();
      const reconciled = all.map(reconcileRunOnReload);
      const anyChanged = reconciled.some((r, i) => r !== all[i]);
      if (anyChanged) {
        await this.memento.update(WORKFLOW_RUNS_KEY, trimRuns(reconciled));
      }
      return reconciled;
    });
  }

  /** 手動で全消去する（design.md §16.11「手動で全消去する手段も用意する」）。 */
  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.memento.update(WORKFLOW_RUNS_KEY, []);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
