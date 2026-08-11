import type { LoopStopReason } from '../loop/loopController';
import type { WorkflowTask } from './workflow';

/**
 * ワークフロー実行中のタスク状態の型と遷移（design.md §16.3 / §16.5）。
 *
 * VSCode APIには一切依存しない純粋なロジックのみを置く。時刻・乱数にも依存させない
 * （経過時間や再試行の待ち時間は実行層 `runner.ts` が持つ）。セッションの生成・worktree操作・
 * Viewはこの層の外（後続Issue）。
 */

export const TASK_STATES = [
  'pending',
  'running',
  'waitingApproval',
  'done',
  'failed',
  'skipped',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * タスクが `failed` / `skipped` になった理由。discriminated unionにすることで、
 * 「人が承認要求を拒否した（approvalRejected）」を他の失敗（自動再試行してよいもの）と
 * 型で区別できるようにする（design.md §16.5「人が承認要求を拒否したために止まったタスクは、
 * 自動再試行の対象にしない」）。
 */
export type TaskFailureReason =
  /** `LoopStopReason: maxReached`。送信回数を使い切った（回数切れ）。 */
  | { readonly kind: 'maxReached' }
  /** `LoopStopReason: failed` が `retries` を使い切って確定した。 */
  | { readonly kind: 'loopFailed' }
  /** 人が承認要求を拒否した。自動再試行の対象にしない。 */
  | { readonly kind: 'approvalRejected' }
  /** 依存先タスクの失敗が波及して `skipped` になった。 */
  | { readonly kind: 'dependencyFailed'; readonly failedTaskIds: readonly string[] }
  /**
   * 依存関係とは無関係に、実行全体が停止したため開始されなかった（独立した枝など）。
   * `dependencyFailed`（自分の依存先が失敗した）とは原因が異なるため区別する。
   * Viewはこの2つを別の表示にできる。
   */
  | { readonly kind: 'runHalted' }
  /**
   * ウィンドウのリロードで走行中（`running` / `waitingApproval`）だったタスクを
   * 「中断」として`failed`にする（design.md §16.11）。セッションのプロセスごと消えている
   * ため、`manual` / `interrupted`（人がそのタスクの画面を直接操作した状態。セッションは
   * 生きたまま残る）とは意味が異なり、`retries`の自動再試行も対象外にする
   * （中断は操作ミスではなく環境側の理由のため、他の失敗理由と同列に自動再試行してよいが、
   * 少なくとも「同じ危険操作を繰り返し提示しない」制約は無関係なので`approvalRejected`とは
   * 別に区別できるようにしておく）。
   */
  | { readonly kind: 'reloadInterrupted' };

/** タスク1件の実行状態。 */
export interface TaskRunState {
  readonly state: TaskState;
  /** ループへの送信回数。実行層（`LoopStatus.iteration`）の値をそのまま写す想定。 */
  readonly submissionCount: number;
  /** これまでの自動再試行回数（0開始）。手動の再実行ではここを増やさない。 */
  readonly retryCount: number;
  /** `state` が `failed` / `skipped` のときだけ意味を持つ。 */
  readonly failure: TaskFailureReason | undefined;
  /**
   * 実行層が埋める値。この層では読み書きせず、遷移のたびにそのまま引き継ぐ
   * （design.mdの指示どおり「触らない」）。`TaskRunState` の他フィールドと表記を
   * 揃えるため、存在しないことを明示する `undefined` 込みの型にしてある
   * （`?:` にはしない。`exactOptionalPropertyTypes` の下では `failure` のように
   * 「値として `undefined` を明示的に書き込む」用途と混在させると意味が変わるため）。
   *
   * **`pending` へ戻すとき（自動再試行・手動の再実行）もこの値は引き継がれたまま残る。**
   * 前回の試行のセッションid・作業ディレクトリであり、再試行は新しいスレッド・
   * worktreeでやり直す前提（design.md §16.5）なので、実行層が新しい値で上書きする
   * までは古い（もう無効な）値が入っている点に注意する。
   */
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
}

/** ワークフロー実行全体の状態。タスク定義（`WorkflowTask[]`）とは別に持つ。 */
export interface RunState {
  readonly tasks: ReadonlyMap<string, TaskRunState>;
  /**
   * `manual` / `interrupted`（人の割り込み）で実行全体を止めたか。
   * `failed` の確定による停止は `hasFailedTask` から導出できるため、ここでは持たない
   * （二重に状態を持つと同期が崩れるため、判定できるものは判定に寄せる）。
   */
  readonly haltedByUser: boolean;
}

const initialTaskRunState: TaskRunState = {
  state: 'pending',
  submissionCount: 0,
  retryCount: 0,
  failure: undefined,
  sessionId: undefined,
  cwd: undefined,
};

/** 全タスクを `pending` として初期化する。 */
export function createRunState(tasks: readonly WorkflowTask[]): RunState {
  const entries = tasks.map((t) => [t.id, initialTaskRunState] as const);
  return { tasks: new Map(entries), haltedByUser: false };
}

/** 1件でも `failed` が確定しているか。 */
export function hasFailedTask(run: RunState): boolean {
  for (const s of run.tasks.values()) {
    if (s.state === 'failed') {
      return true;
    }
  }
  return false;
}

/**
 * 実行全体が停止しているか（`failed` の確定、または人の割り込みのいずれか）。
 * スケジューラはこれを見て新規のタスク開始を止める。
 */
export function isRunHalted(run: RunState): boolean {
  return run.haltedByUser || hasFailedTask(run);
}

/** idごとに、そのタスクへ直接依存するタスクidの一覧を作る。 */
function buildDependentsIndex(tasks: readonly WorkflowTask[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const list = dependents.get(dep);
      if (list === undefined) {
        dependents.set(dep, [t.id]);
      } else {
        list.push(t.id);
      }
    }
  }
  return dependents;
}

/**
 * `taskId` に間接を含めて依存する（下流の）タスクidを全て集める。
 * 依存の循環は読み込み時の検証（`validateWorkflow`）で弾いてある前提だが、
 * 万一に備えて訪問済み集合で無限ループを防ぐ。
 */
function collectDependents(
  taskId: string,
  dependents: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const result = new Set<string>();
  const stack = [...(dependents.get(taskId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (result.has(id)) {
      continue;
    }
    result.add(id);
    for (const next of dependents.get(id) ?? []) {
      stack.push(next);
    }
  }
  return result;
}

function setTask(run: RunState, taskId: string, next: TaskRunState): RunState {
  const tasks = new Map(run.tasks);
  tasks.set(taskId, next);
  return { ...run, tasks };
}

/**
 * まだ結果が確定していない状態。`markFailed` や `done` への遷移など、外部からの
 * 通知（`LoopStopReason` や承認拒否）を受け付けてよいのはこの3状態のときだけで、
 * `done` / `failed` / `skipped` は一度確定したら通知を再度受けても動かさない
 * （二重配信・遅延到着で確定済みの結果が書き換わる事故を防ぐ）。
 */
function isUnsettled(state: TaskState): boolean {
  return state === 'pending' || state === 'running' || state === 'waitingApproval';
}

/**
 * 実行全体が停止した時点で、まだ開始されていない（＝`pending`のままの）タスクを
 * 全て `skipped` にする（design.md §16.5「独立した枝も新たには開始しない」を状態としても
 * 表す）。呼び出し側が作った一時的な `Map` をその場で書き換える内部専用の手続きで、
 * 公開APIの境界（`RunState` そのもの）はどこも直接mutationしない。
 *
 * 依存先の失敗が波及した `dependencyFailed` とは原因が異なるため、`runHalted` として
 * 区別する。すでに `skipped` / `done` / `failed` で確定しているもの、および
 * `running` / `waitingApproval` で走行中のもの（走らせ切る）には触れない。
 */
function skipRemainingPending(tasks: Map<string, TaskRunState>): void {
  for (const [id, s] of tasks) {
    if (s.state === 'pending') {
      tasks.set(id, { ...s, state: 'skipped', failure: { kind: 'runHalted' } });
    }
  }
}

/**
 * `dependencyFailed` で `skipped` になっている子孫へ、もう1件の失敗原因を積み増す。
 * 複数の親（合流タスクの依存先）が別々に失敗しうるため、`failedTaskIds` を単一要素で
 * 作り切りにすると2件目以降の失敗が記録から漏れる（レビュー指摘: 1件目しか残らない）。
 * 重複は入れない。`dependencyFailed` 以外（`runHalted` 等）は原因が異なるため触らない。
 */
function appendFailedTaskId(current: TaskRunState, taskId: string): TaskRunState {
  if (
    current.failure?.kind !== 'dependencyFailed' ||
    current.failure.failedTaskIds.includes(taskId)
  ) {
    return current;
  }
  return {
    ...current,
    failure: {
      kind: 'dependencyFailed',
      failedTaskIds: [...current.failure.failedTaskIds, taskId],
    },
  };
}

/**
 * タスクを `failed` に確定し、依存する全タスク（間接を含む）を `skipped` にする
 * （design.md §16.5「失敗の波及」）。
 *
 * 対象タスク自身が `pending` / `running` / `waitingApproval`（＝未確定）のときだけ動く。
 * すでに `done` / `failed` / `skipped` で確定しているタスクへ`LoopStopReason`が二重・
 * 遅延で届いても上書きしない（レビュー指摘: 以前はここに自己ガードが無く、確定済みの
 * `done` が `maxReached` の再通知だけで `failed` へ書き換わりうった）。
 *
 * 下流（依存する側）についても、すでに `running` / `waitingApproval` / `done` /
 * `failed` のものは触らない。すでに `dependencyFailed` で `skipped` のものは、状態は
 * 変えずに失敗原因だけ積み増す（`appendFailedTaskId`）。
 */
function markFailed(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
  reason: TaskFailureReason,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || !isUnsettled(current.state)) {
    return run;
  }
  const dependents = buildDependentsIndex(tasks);
  const toSkip = collectDependents(taskId, dependents);

  const nextTasks = new Map(run.tasks);
  nextTasks.set(taskId, { ...current, state: 'failed', failure: reason });
  for (const id of toSkip) {
    const s = nextTasks.get(id);
    if (s === undefined) {
      continue;
    }
    if (s.state === 'pending') {
      nextTasks.set(id, {
        ...s,
        state: 'skipped',
        failure: { kind: 'dependencyFailed', failedTaskIds: [taskId] },
      });
      continue;
    }
    nextTasks.set(id, appendFailedTaskId(s, taskId));
  }
  // ここまでで依存先の失敗が波及する分は確定した。残った `pending` は、依存関係の上では
  // このタスクと無関係な独立した枝でも、実行全体が停止する以上は新たに開始しない
  // （design.md §16.5「独立した枝も新たには開始しない」）。区別のため `runHalted` にする。
  skipRemainingPending(nextTasks);
  return { ...run, tasks: nextTasks };
}

/**
 * ループの停止理由（`LoopStopReason`）をタスクの結果へ対応させる（design.md §16.5の表）。
 *
 * | `LoopStopReason`         | タスクの結果                             |
 * | ------------------------ | ---------------------------------------- |
 * | `done`                   | `done`                                   |
 * | `maxReached`             | `failed`（回数切れ）                     |
 * | `failed`                 | `failed`（`retries` の範囲で再試行）     |
 * | `manual` / `interrupted` | 実行全体を停止（このタスク自身は変えない）|
 *
 * `manual` / `interrupted` は「タスクの結果」の対応が表に無い（design.mdは「実行全体を
 * 停止」とだけ書いている）。人がそのタスクの画面へ直接介入した状態を指すため、この6状態
 * （pending/running/waitingApproval/done/failed/skipped）のどれにも当てはまらない。
 * ここでは実行層に判断を委ね、`haltedByUser` を立てて新規開始だけを止める。
 *
 * `failed` の確定、および `haltedByUser` を立てるときのいずれも、まだ開始されていない
 * `pending` のタスクは全て `skipped`（`runHalted`）にする。`running` のものは走らせ切る。
 */
export function applyLoopStopReason(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
  reason: LoopStopReason,
): RunState {
  if (reason === 'manual' || reason === 'interrupted') {
    if (run.haltedByUser) {
      return run;
    }
    // failedの確定と同じく、まだ開始されていない`pending`は実行全体の停止として`skipped`にする。
    // このタスク自身（現在`running`のはず）は変えない。
    const nextTasks = new Map(run.tasks);
    skipRemainingPending(nextTasks);
    return { ...run, tasks: nextTasks, haltedByUser: true };
  }

  const task = tasks.find((t) => t.id === taskId);
  const current = run.tasks.get(taskId);
  if (task === undefined || current === undefined) {
    return run;
  }

  // すでに確定（done/failed/skipped）しているタスクへ停止理由が二重・遅延で届いても
  // 状態を動かさない。`markRunning` などと同じ防御を、この関数の入口にも置く。
  // 分岐ごとに書くと、再試行で`pending`へ戻す経路のように書き漏らしが起きる。
  if (!isUnsettled(current.state)) {
    return run;
  }

  if (reason === 'done') {
    return setTask(run, taskId, { ...current, state: 'done', failure: undefined });
  }

  if (reason === 'maxReached') {
    return markFailed(run, tasks, taskId, { kind: 'maxReached' });
  }

  // reason === 'failed'。`retries`の範囲内なら、新しいスレッド・worktreeでやり直す前提で
  // `pending`へ戻す（送信回数もリセットする）。使い切っていれば`failed`として確定する。
  if (current.retryCount < task.retries) {
    return setTask(run, taskId, {
      ...current,
      state: 'pending',
      retryCount: current.retryCount + 1,
      submissionCount: 0,
      failure: undefined,
    });
  }
  return markFailed(run, tasks, taskId, { kind: 'loopFailed' });
}

/**
 * 人が承認要求を拒否したことによる失敗。`applyLoopStopReason` の再試行判定を経由しないため、
 * `retries` が残っていても自動再試行されない（design.md §16.5）。
 *
 * **`applyLoopStopReason(..., 'failed')` でこれを代用してはいけない。** `'failed'` は
 * `retries` の自動再試行の経路に乗るため、それでは「人が拒否した危険操作を再提示しない」
 * という意図が壊れる。承認拒否の通知は必ずこの関数を呼ぶ。
 *
 * 対象タスクが `waitingApproval`（承認待ち）のときだけ動く。承認判定そのものを担う
 * `escalation.ts` は判定結果を返すだけで、状態遷移はしない（判定と遷移の責務を分ける）。
 */
export function markApprovalRejected(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'waitingApproval') {
    return run;
  }
  return markFailed(run, tasks, taskId, { kind: 'approvalRejected' });
}

/** `pending` のタスクを `running` にする。対象外の状態・未知のidは無視する。 */
export function markRunning(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'pending') {
    return run;
  }
  return setTask(run, taskId, { ...current, state: 'running' });
}

/** `running` のタスクを `waitingApproval` にする（承認待ちで人の判断を待つ）。 */
export function markWaitingApproval(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'running') {
    return run;
  }
  return setTask(run, taskId, { ...current, state: 'waitingApproval' });
}

/** 承認が解決（許可）し、`waitingApproval` から `running` へ戻る。 */
export function resumeFromApproval(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'waitingApproval') {
    return run;
  }
  return setTask(run, taskId, { ...current, state: 'running' });
}

/** 送信回数を上書きする。実行層（`LoopStatus.iteration`）の値をそのまま写す想定。 */
export function recordSubmissionCount(
  run: RunState,
  taskId: string,
  submissionCount: number,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.submissionCount === submissionCount) {
    return run;
  }
  return setTask(run, taskId, { ...current, submissionCount });
}

/**
 * タスク開始時に、実際に使ったセッションidと作業ディレクトリを記録する。
 * `TaskRunState.sessionId` / `.cwd` のコメント通り「実行層が埋める値」で、この層に
 * 書き込み手段が無いと実行層（`runner.ts`）が永続化のために値を持てない。
 */
export function recordSessionInfo(
  run: RunState,
  taskId: string,
  sessionId: string,
  cwd: string,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined) {
    return run;
  }
  return setTask(run, taskId, { ...current, sessionId, cwd });
}

/**
 * `failed` / `skipped` のタスクを1件だけ手動で `pending` に戻す（design.md §16.5「再実行」）。
 *
 * 依存が全て `done` でなければ戻せない。戻した時点で、そのタスクに依存する `skipped` も
 * 連鎖して `pending` へ戻す（`done` / `failed` / `running` 等はそのまま）。
 * 対象外（`done` / `running` / `waitingApproval` / 未知のid）は何もせず元の `run` を返す。
 *
 * `retryCount`（自動再試行の消費回数）は引き継いだままにする。手動の再実行は自動再試行とは
 * 別の経路であり、すでに使った自動再試行の権利を人の操作で復活させることはしない。
 *
 * **成功したときは `haltedByUser` を解除する。** 人の明示操作（手動の再実行）そのものを
 * 「再開の合図」として扱う（design.md §16.8のViewが「実行、全体の停止、失敗タスクの再実行」
 * を並べて操作させる設計である以上、停止後に人が再開できることが前提になっている）。
 * `failed` の確定による停止は `hasFailedTask` から導出されるため、他に `failed` が
 * 残っていれば `isRunHalted` は引き続き `true` のままになる（二重に状態を持たないので、
 * ここで個別に気にする必要が無い）。
 */
export function retryTask(run: RunState, tasks: readonly WorkflowTask[], taskId: string): RunState {
  const current = run.tasks.get(taskId);
  const task = tasks.find((t) => t.id === taskId);
  if (task === undefined || current === undefined) {
    return run;
  }
  if (current.state !== 'failed' && current.state !== 'skipped') {
    return run;
  }
  const depsAllDone = task.dependsOn.every((dep) => run.tasks.get(dep)?.state === 'done');
  if (!depsAllDone) {
    return run;
  }

  const dependents = buildDependentsIndex(tasks);
  const toRestore = collectDependents(taskId, dependents);

  const nextTasks = new Map(run.tasks);
  nextTasks.set(taskId, { ...current, state: 'pending', failure: undefined });
  for (const id of toRestore) {
    const s = nextTasks.get(id);
    if (s === undefined || s.state !== 'skipped') {
      continue;
    }
    nextTasks.set(id, { ...s, state: 'pending', failure: undefined });
  }
  return { ...run, tasks: nextTasks, haltedByUser: false };
}
