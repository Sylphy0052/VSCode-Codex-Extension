import type { TaskFailureReason, TaskState } from './runState';
import type { MementoLike } from '../util/memento';
import { SerialQueue } from './serialQueue';

/**
 * ワークフロー実行状態の永続化と復元（design.md §16.11）。
 *
 * `workspaceState` は暗号化されない平文ストレージのため、**応答本文は保存しない**。
 * `{{T.result}}` の元になるテキストは機微を含みうる。保存するのは状態・id・パスなど、
 * 復元後に人が判断するために必要な最小限に留める。
 */

/** `vscode.Memento` と構造的に一致する最小限の口（実体は `src/util/memento.ts`）。 */
export type WorkflowRunMemento = MementoLike;

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
  /**
   * 手動の再実行の回数（`TaskRunState.manualRetryCount`）。既存の永続データ
   * （このフィールドが無い形式）を読んでも `undefined` になるだけで壊れない
   * （復元側が0として扱う）。
   */
  manualRetryCount: number | undefined;
  failure: TaskFailureReason | undefined;
  /**
   * タスクPR/MRの番号（design.md §16.11「タスクごとの...PR/MRの番号」、Issue #118）。
   * 作られていない・番号を取り出せない場合は `undefined`。**本文は保存しない**
   * （§16.11・§16.21）。既存の永続データ（このフィールドが無い形式）を読んでも、
   * 単に `undefined` になるだけで壊れない。
   */
  pullRequestNumber: number | undefined;
  /** タスクPR/MRのURL。番号と同じくホスト側にも残っている情報で機微は含まない。 */
  pullRequestUrl: string | undefined;
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
  /**
   * 統合ブランチ名（design.md §16.11「統合ブランチ名とPR/MRの番号を持たせるのは、
   * リロード後もViewから統合の状況を辿れるようにするため」、§16.17）。gitリポジトリでない
   * runでは統合の概念が無いため空文字。`integration.ts`の`integrationBranchName(runId)`と
   * 同じ値になる（runIdから決定的に導けるが、Viewでの表示・将来のPR/MR作成のため明示的に
   * 持たせておく）。
   */
  integrationBranch: string;
  /**
   * 統合PR/MRの番号（design.md §16.11「統合PR/MRの番号」、Issue #118）。作られていない
   * （前提が欠けていた・`pullRequest`/`forge`設定で無効化されている等）場合は `undefined`。
   * 既存の永続データ（このフィールドが無い形式）を読んでも `undefined` になるだけで壊れない。
   */
  integrationPullRequestNumber: number | undefined;
  /** 統合PR/MRのURL。 */
  integrationPullRequestUrl: string | undefined;
  /**
   * 統合→mainの最終マージ（design.md §16.18「最終マージ」）の成否。試みていなければ
   * `undefined`（`finalMerge: pr-only`、統合PR/MRの作成に失敗、runがまだ終わっていない等）。
   * `held`は`finalMerge: orchestrator | confirm`で「マージしない」と判断された場合
   * （design.md §16.26）。
   */
  finalMergeOutcome: 'merged' | 'failed' | 'held' | undefined;
  /**
   * `ask_user`（design.md §16.33、Issue #583）の回答待ちの問い。オーケストレーターが
   * 呼んでから人が答えるまでの間だけ存在する。`finalMergeOutcome`等と違い「確定した結果」
   * ではなく「宙に浮いている問い」なので、答えが確定した・run再開時にオーケストレーターが
   * 新しく開き直した等で消えれば`undefined`に戻る（`WorkflowRunner.persist`参照）。
   * ロードマップW10（中断からの自動再開、Issue未起票）が「再開時に問いを出し直す」ために
   * 読む想定のデータで、この節（W8）では永続化するだけで自動的な出し直しはしない
   * （オーケストレーターセッション自体がリロードで復元できないため。`LiveRun.pendingAskUser`
   * のJSDoc参照）。既存の永続データ（このフィールドが無い形式）を読んでも`undefined`に
   * なるだけで壊れない。
   */
  pendingAskUser: { question: string; choices: string[]; askedAt: string } | undefined;
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
 * `worktree.ts` の `WorktreeCreationQueue` と同じ流儀（直列化そのものの実装は
 * `serialQueue.ts` の `SerialQueue` を共有する。Issue #146）で直列化する。
 */
export class WorkflowRunStore {
  private readonly queue = new SerialQueue();

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
    return this.queue.enqueue(task);
  }
}
