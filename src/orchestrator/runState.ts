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
  'waitingReply',
  'merging',
  'done',
  'failed',
  'blocked',
  'skipped',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * その状態が「並列枠を占めている」か（design.md §16.3）。
 *
 * `running` はもちろん、`waitingApproval`（人待ちのセッションもプロセスとしては生きている）・
 * `waitingReply`（返信待ちのセッションも同様。§16.21）・`merging`（マージが終わるまで
 * そのタスクの成果は確定しない）も枠を占める。この4状態の集合は、`maxParallel` の空き数
 * 計算（`scheduler.ts` の `nextTasksToStart`）・待ちぼうけ検出（`runnerMessaging.ts` の
 * `checkWaitingReplyStalls`。Issue #147の分割で`runner.ts`から移った）・実行全体の
 * 終了判定（`scheduler.ts` の `getRunOutcome`）の
 * 3箇所で同じ判定が必要になる（Issue #146）。状態を1つ足すたびに3箇所を揃えて直す必要が
 * あった重複を、ここへ集約する。
 *
 * `getRunOutcome` は「実行全体がまだ終わっていないか」という別の問い（この4状態に加えて
 * `pending` も含む）を判定しており、`isActiveTaskState` はその一部として使う
 * （`pending` は「枠を占める」の意味ではまだ何も始まっていないため、ここには含めない）。
 *
 * 「状態を1つ足すたびに揃えて直す」対象は、この関数が集約する3箇所に加えて`isUnsettled`
 * （「外部からの確定通知を受け付けてよいか」）も含む。観点が別なので中身の状態集合は
 * 一致しない（`isUnsettled`は`pending`を含み`merging`を含まない）が、新しい状態を
 * 追加・変更するときは両方を見直す必要がある（Issue #362）。
 */
export function isActiveTaskState(state: TaskState): boolean {
  return (
    state === 'running' ||
    state === 'waitingApproval' ||
    state === 'waitingReply' ||
    state === 'merging'
  );
}

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
  /**
   * ワークフローViewの「タスク停止」操作（design.md §16.8）で人がそのタスクだけを止めた。
   * `approvalRejected` と同じ理由（同じ操作を勝手にやり直さない）で自動再試行の対象にしない。
   */
  | { readonly kind: 'manualStop' }
  /**
   * ループが停滞したと判定されて自動的に止まった（design.md §16.27、Issue #336）。
   * `loopFailed`（ターンそのものが失敗した）とは原因が異なるため区別する。`manualStop`と
   * 同じ理由（人・オーケストレーターの判断を挟まずに勝手にやり直さない）で自動再試行の
   * 対象にしない。セッションは`maxReached`と同じく`onTaskFinished`が残すため、
   * `continueTask`で同じ会話のまま続きを試せる（`retryTask`による「再実行」＝新しい
   * worktreeでの最初からのやり直しも従来どおり選べる）。
   */
  | { readonly kind: 'stalled' }
  /** 依存先タスクの失敗が波及して `skipped` になった。 */
  | { readonly kind: 'dependencyFailed'; readonly failedTaskIds: readonly string[] }
  /**
   * 依存先タスクのマージが衝突し、自動解決にも失敗した（`blocked`）ために `skipped` に
   * なった（design.md §16.17「依存する後続は skipped（理由: mergeBlocked）」）。
   * `dependencyFailed` と同じ理由で複数の親を配列に持てるようにする
   * （`appendBlockedTaskId`）。`failed` とは違い実行全体は止めないため、`skipRemainingPending`
   * の対象にはならない（このタスクの依存関係にある後続だけが対象）。
   */
  | { readonly kind: 'mergeBlocked'; readonly blockedTaskIds: readonly string[] }
  /**
   * マージが衝突以外の理由（gitエラー等）で失敗した（design.md §16.17「その他の失敗は
   * failed」）。`applyLoopStopReason` の `'failed'` 分岐（`retries` を消費してループを
   * 新しいworktreeでやり直す）とは別経路のため、`retries` は消費しない即時確定にする
   * （マージという別の操作の失敗をタスクのループ失敗と同列に扱わない）。
   */
  | { readonly kind: 'mergeFailed' }
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
  /**
   * `retries`の権利（`retryCount`）を消費しない再試行の回数（0開始）。ワークフローViewからの
   * 手動の再実行（`retryTask`）に加えて、リロード・WSL再起動からの自動再開
   * （`applyAutoResume`、design.md §16.35、roadmap W10、Issue #584）も、`reloadInterrupted`の
   * タスクを`pending`へ戻すときにここを増やす。
   *
   * 分けて持つのは、`retryCount`が「自動再試行を何回使ったか」という**権利の消費**を
   * 表しているからで、人の操作・自動再開のどちらでそれを増やしても使える自動再試行が
   * 減ってしまう（特に自動再開は「タスクが中断されただけで、まだ何も本物の失敗をしていない」
   * ケースを扱うため、`retryCount`を進めると後で本物の理由（`loopFailed`等）で失敗したときの
   * 自動再試行の権利を黙って1回消費してしまう。レビュー指摘、2026-08-23）。
   * 一方でworktreeのディレクトリ名とブランチ名（`wf/<runId>/<taskId>-retry<n>`。§16.5）は
   * **試行が何回目か**で決まる必要がある。失敗した試行のworktreeとブランチは人が中身を
   * 見られるように残るため、同じ名前で作り直そうとすると`branchExists`で必ず失敗する
   * （issue #275で実測）。名前は両者の合計から決める（`retrySuffixOf`）。
   */
  readonly manualRetryCount: number;
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
  manualRetryCount: 0,
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
 * 通知（`LoopStopReason` や承認拒否）を受け付けてよいのはこの4状態のときだけで、
 * `done` / `failed` / `skipped` は一度確定したら通知を再度受けても動かさない
 * （二重配信・遅延到着で確定済みの結果が書き換わる事故を防ぐ）。
 *
 * `waitingReply`（返信待ち）も含む（Issue #362）。`loopController.ts`の`observe()`は
 * pause中（＝`waitingReply`）でも`turnFailed`を見たら`stop('failed')`を呼ぶ（「返信待ちの
 * まま実は失敗していた、を黙って握り潰さない」）。ここに含めていないと`applyLoopStopReason`
 * が`markFailed`へ到達せず、セッションは`dispose`済みなのにタスクだけ`waitingReply`のまま
 * 残り、`isActiveTaskState`が真であり続けて`maxParallel`の枠を永久に占有する。
 *
 * `isActiveTaskState`と同様、状態を1つ足すたびに揃えて直す必要がある集合の1つ
 * （こちらは「外部からの確定通知を受け付けてよいか」という別の観点の集合）。
 *
 * `merging`はここに含めない。マージ中のタスクを閉じるのは`applyLoopStopReason`ではなく
 * `markMergeSucceeded` / `markMergeBlocked` / `markMergeFailed`という専用の経路であり、
 * マージ開始後に`LoopStopReason`（例: 別経路からの`failed`）が遅れて届いても、マージの
 * 結果を待たずに横から`failed`へ確定させてはならないため（マージ中の停止理由の扱いは
 * 別の設計判断であり、ここでは変えない）。
 */
function isUnsettled(state: TaskState): boolean {
  return (
    state === 'pending' ||
    state === 'running' ||
    state === 'waitingApproval' ||
    state === 'waitingReply'
  );
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
 * `dependencyFailed` / `mergeBlocked` で `skipped` になっている子孫へ、もう1件の原因を
 * 積み増す。複数の親（合流タスクの依存先）が別々に失敗・ブロックされうるため、
 * `failedTaskIds` / `blockedTaskIds` を単一要素で作り切りにすると2件目以降が記録から
 * 漏れる（レビュー指摘: 1件目しか残らない）。重複は入れない。指定した `kind` 以外
 * （`runHalted` 等、または`dependencyFailed`と`mergeBlocked`の取り違え）は原因が異なる
 * ため触らない。
 */
function appendCascadeTaskId(
  current: TaskRunState,
  kind: 'dependencyFailed' | 'mergeBlocked',
  taskId: string,
): TaskRunState {
  const failure = current.failure;
  if (failure === undefined || failure.kind !== kind) {
    return current;
  }
  if (failure.kind === 'dependencyFailed') {
    if (failure.failedTaskIds.includes(taskId)) {
      return current;
    }
    return {
      ...current,
      failure: { kind: 'dependencyFailed', failedTaskIds: [...failure.failedTaskIds, taskId] },
    };
  }
  if (failure.blockedTaskIds.includes(taskId)) {
    return current;
  }
  return {
    ...current,
    failure: { kind: 'mergeBlocked', blockedTaskIds: [...failure.blockedTaskIds, taskId] },
  };
}

/**
 * タスクを `failed` に確定し、依存する全タスク（間接を含む）を `skipped` にする
 * （design.md §16.5「失敗の波及」）。呼び出し側（`markFailed` / `markMergeFailed`）が、
 * 対象タスクがどの状態から失敗しうるかを `allowedState` で指定する。
 *
 * すでに `done` / `failed` / `skipped` で確定しているタスクへ`LoopStopReason`が二重・
 * 遅延で届いても上書きしない（レビュー指摘: 以前はここに自己ガードが無く、確定済みの
 * `done` が `maxReached` の再通知だけで `failed` へ書き換わりうった）。
 *
 * 下流（依存する側）についても、すでに `running` / `waitingApproval` / `done` /
 * `failed` のものは触らない。すでに `dependencyFailed` で `skipped` のものは、状態は
 * 変えずに失敗原因だけ積み増す（`appendCascadeTaskId`）。
 */
function markFailedFrom(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
  reason: TaskFailureReason,
  allowedState: (state: TaskState) => boolean,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || !allowedState(current.state)) {
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
    nextTasks.set(id, appendCascadeTaskId(s, 'dependencyFailed', taskId));
  }
  // ここまでで依存先の失敗が波及する分は確定した。残った `pending` は、依存関係の上では
  // このタスクと無関係な独立した枝でも、実行全体が停止する以上は新たに開始しない
  // （design.md §16.5「独立した枝も新たには開始しない」）。区別のため `runHalted` にする。
  skipRemainingPending(nextTasks);
  return { ...run, tasks: nextTasks };
}

/** `applyLoopStopReason` / `markApprovalRejected` からの `failed` 確定。`isUnsettled` な状態からだけ動く。 */
function markFailed(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
  reason: TaskFailureReason,
): RunState {
  return markFailedFrom(run, tasks, taskId, reason, isUnsettled);
}

/**
 * ループの停止理由（`LoopStopReason`）をタスクの結果へ対応させる（design.md §16.5の表）。
 *
 * | `LoopStopReason`         | タスクの結果                             |
 * | ------------------------ | ---------------------------------------- |
 * | `done`                   | `merging`（マージが済んで初めて`done`。design.md §16.17。マージ結果に応じた `done` / `blocked` / `failed` への遷移は `markMergeSucceeded` / `markMergeBlocked` / `markMergeFailed` が担う） |
 * | `maxReached`             | `failed`（回数切れ）                     |
 * | `failed`                 | `failed`（`retries` の範囲で再試行）     |
 * | `stalled`                | `failed`（停滞。design.md §16.27、Issue #336。`retries`は消費しない） |
 * | `manual` / `interrupted` | 実行全体を停止（このタスク自身は変えない）|
 *
 * `manual` / `interrupted` は「タスクの結果」の対応が表に無い（design.mdは「実行全体を
 * 停止」とだけ書いている）。人がそのタスクの画面へ直接介入した状態を指すため、この8状態
 * （pending/running/waitingApproval/merging/done/failed/blocked/skipped）のどれにも
 * 当てはまらない。ここでは実行層に判断を委ね、`haltedByUser` を立てて新規開始だけを止める。
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
    // ループが終わっただけでは`done`にしない。マージが済むまでは`merging`
    // （design.md §16.17。実際のマージ呼び出しと結果に応じた遷移は実行層 `runner.ts` が
    // `markMergeSucceeded` / `markMergeBlocked` / `markMergeFailed` を呼んで担う）。
    return setTask(run, taskId, { ...current, state: 'merging', failure: undefined });
  }

  if (reason === 'maxReached') {
    return markFailed(run, tasks, taskId, { kind: 'maxReached' });
  }

  if (reason === 'taskStopped') {
    // ワークフローViewの「タスク停止」（design.md §16.8）。`markApprovalRejected`と同じく
    // `retries`の自動再試行の経路には乗せない（人が明示的に止めたタスクを勝手にやり直さない）。
    return markFailed(run, tasks, taskId, { kind: 'manualStop' });
  }

  if (reason === 'stalled') {
    // 停滞判定（design.md §16.27、Issue #336）。`taskStopped`と同じく`retries`の
    // 自動再試行の経路には乗せない——同じ内容を繰り返すだけの状態を、原因を変えずに
    // 機械的にやり直しても再び停滞する可能性が高いため、人・オーケストレーターの判断
    // （`continueTask`で続きを試す／`retryTask`で最初からやり直す）を挟む
    return markFailed(run, tasks, taskId, { kind: 'stalled' });
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

// ---------------------------------------------------------------------------
// マージの結果に応じた遷移（design.md §16.17）。
//
// ループの完了（`applyLoopStopReason(..., 'done')`）はタスクを`merging`にするだけで、
// 実際にマージを試みるのは実行層（`runner.ts`）の責務。以下の3関数は、その結果を
// 受けて`merging`から次の状態へ遷移させる。いずれも対象タスクが`merging`のときだけ動く。
// ---------------------------------------------------------------------------

/**
 * マージが成功した（design.md §16.17「マージが成功したら`done`」）。
 *
 * このタスクの失敗（衝突）を理由に`skipped`（`mergeBlocked`）へ倒れていた依存先も
 * `pending`へ戻す。「再マージ」（`retryMergeState`）で一度`blocked`になったタスクの
 * マージを成功させたときに、依存する後続が永久に`skipped`のまま残らないようにするため
 * （`retryTask`が`dependencyFailed`のskippedを戻すのと同じ考え方）。複数の親から
 * ブロックされていた場合でも、`nextTasksToStart`の依存充足チェック（`dependsOn`が
 * 全て`done`）が残りの親を待つため、ここでは無条件に戻してよい。
 *
 * ただし**実行全体が停止している（`isRunHalted(run)`）間は`pending`へ戻さない**
 * （Issue #432-1）。
 *
 * **不変条件: `nextTasksToStart`が開始しない`pending`を作ってはならない。** 作った瞬間
 * `getRunOutcome`が`running`を返し続け、`retryTask`/`continueTask`のどちらも`pending`
 * を受理しないため、誰にも回収できない状態になる。`nextTasksToStart`自身の門が
 * `isRunHalted`（`run.haltedByUser || hasFailedTask(run)`）である以上、ここで戻すかどうかの
 * 判定もそれと揃える必要がある。`run.haltedByUser`だけを見ていると、人が停止していない
 * 通常運用（独立した枝の1つが`failed`で確定し、別の枝がマージ衝突→人が解決→再マージ
 * 成功）でも同じ袋小路が起きる（`hasFailedTask`が真の間`nextTasksToStart`は新規開始しない
 * ため）。
 *
 * **この穴は2回目である。** Issue #432では`haltedByUser`の門で見つかり、今回（PR #517の
 * セキュリティ監査）は`hasFailedTask`の門で再発した。個別の門を1つずつ揃えても、次に
 * 別の門が足されれば3回目が起きる。だから「どの門を見るか」ではなく「開始されない
 * `pending`を作らない」という不変条件の形で書いてある。
 *
 * **これは`runnerOrchestrator.ts`の`runHaltedByUserReason`のJSDoc（PR #503、107-108行付近）
 * が「必ず`snapshot.haltedByUser`だけを見る。`isRunHalted`を使ってはならない」と書いて
 * いるのと矛盾しない。** あちらが答えるべき問いは
 * 「**人が**停止したか」（オーケストレーター制御ツールの停止判定）
 * であり`haltedByUser`を直接見る必要があるのに対し、ここで答えるべき問いは
 * 「**スケジューラはこのタスクを開始するのか**」であって、スケジューラ自身の門
 * （`nextTasksToStart`の`isRunHalted`）と同じ判定に揃えるのが正しい。
 *
 * 停止中（広義。`haltedByUser`または`hasFailedTask`のいずれか）は`skipped`
 * （`runHalted`）のままにしておく。`skipRemainingPending`が失敗起因の停止に対しても
 * 同じ`runHalted`を使っている（コメント「区別のため`runHalted`にする」）のと意味を揃えた。
 *
 * **回復について。** `retryTask`は`skipped`を理由を問わず受理し`haltedByUser`を解除する
 * ため、`haltedByUser`だけが原因（`hasFailedTask`は偽）なら、その`skipped`（`runHalted`）
 * タスク自身へ`retryTask`を呼ぶだけで拾い直せ、即座に`nextTasksToStart`が拾える。
 * **一方`hasFailedTask`が原因（他タスクが`failed`で確定している）のときは、この
 * `skipped`タスク自身への`retryTask`だけでは復帰しない。** `retryTask`はその失敗タスク
 * 自身を`pending`へ戻すだけで`haltedByUser`をfalseにするが、`hasFailedTask`は依然として
 * 真（当該の`failed`タスクがまだ`failed`のまま）なので`isRunHalted`は真のまま残り、
 * `nextTasksToStart`はまだ開始しない。**回復には、その`failed`タスク自身を`retryTask`
 * （または`continueTask`）で救う操作が別途要る。** 重要なのは、`skipped`のままなら
 * `getRunOutcome`が`pending`を見ずに`anyFailed`を見て`'failed'`（終端）を返せること
 * であって、`skipped`にした時点で即座に自動再開できることではない。この2つを混同しない。
 *
 * 副作用として、複数の親からブロックされていたタスクは自動復帰しなくなる。`failure.kind`
 * を`runHalted`へ書き換えると、下のフィルタ（`s.failure?.kind !== 'mergeBlocked'`）に
 * 掛からなくなるため、停止が別経路（他タスクの`retryTask`）で解除された後にもう一方の親の
 * マージが成功しても、このタスクは`pending`へ戻らない。その場合は対象タスク自身へ
 * `retryTask`を呼べば救えるので詰みではないが、「両親のマージ完了で自動復帰」ではなく
 * 「手動の再実行が要る」に変わる。停止という人の明示操作（または他タスクの失敗確定）が
 * 挟まった後は、どの後続を再開するかを人に選ばせるほうが安全と判断してこの形にした。
 */
export function markMergeSucceeded(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'merging') {
    return run;
  }
  const dependents = buildDependentsIndex(tasks);
  const toRestore = collectDependents(taskId, dependents);

  const nextTasks = new Map(run.tasks);
  nextTasks.set(taskId, { ...current, state: 'done', failure: undefined });
  for (const id of toRestore) {
    const s = nextTasks.get(id);
    if (s === undefined || s.state !== 'skipped' || s.failure?.kind !== 'mergeBlocked') {
      continue;
    }
    if (isRunHalted(run)) {
      nextTasks.set(id, { ...s, failure: { kind: 'runHalted' } });
      continue;
    }
    nextTasks.set(id, { ...s, state: 'pending', failure: undefined });
  }
  return { ...run, tasks: nextTasks };
}

/**
 * マージが衝突し、自動解決（衝突解決セッション）にも失敗した
 * （design.md §16.17「コンフリクト」7.）。対象タスクを`blocked`にし、依存する後続
 * （間接を含む）のうちまだ`pending`のものだけを`skipped`（理由: `mergeBlocked`）にする。
 *
 * `markFailed`（`failed`用）とは違い、実行全体は止めない。`blocked`は「タスクの作業
 * 自体は終わったが、統合できていない」状態で、独立した枝は走り続ける
 * （design.md §16.3「`blocked`は実行全体を止めない」）。そのため`skipRemainingPending`
 * は呼ばない。
 *
 * **呼び出し元は、`git merge --abort`で巻き戻した後（衝突が自動解決できなかった通常経路）
 * だけでなく、巻き戻さずに`blocked`へ倒す経路（`runnerMerge.ts`の`finishMergeResolution`
 * の`manual`/`interrupted`/`taskStopped`分岐、Issue #443・案A。`mergeBusy`・
 * `blockMergeAfterLeaseWait`も同様）からも呼ぶ。** この関数自身は`failure`を`undefined`に
 * するため、両者を状態からは区別できない。
 *
 * **中断由来の`blocked`（巻き戻していないもの）が統合worktreeの誤撤去から守られているのは、
 * `blocked`という状態そのものではなく、`removeWorktree`（`worktree.ts`）の
 * `git status --porcelain`が未コミット差分（`MERGE_HEAD`・未解決パス）を検知して撤去を
 * 拒否するという、別の安全網に依存しているからである。** `cleanupIntegration`
 * （`runner.ts`）の`getRunOutcome(...) === 'running'`ガードは、この関数が呼ばれた時点で
 * 素通りしうる（`blocked`はrunを終了確定させうるため）。将来、**差分を伴わない**
 * `blocked`を作る経路（例: 何も変更していない状態で衝突解決セッションを中断する）を
 * 追加するときは、`git status`が空になり得るためこの安全網が効かず、
 * `cleanupIntegration`の撤去ガードが素通りしてしまうことを確認すること。
 */
export function markMergeBlocked(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'merging') {
    return run;
  }
  const dependents = buildDependentsIndex(tasks);
  const toSkip = collectDependents(taskId, dependents);

  const nextTasks = new Map(run.tasks);
  nextTasks.set(taskId, { ...current, state: 'blocked', failure: undefined });
  for (const id of toSkip) {
    const s = nextTasks.get(id);
    if (s === undefined) {
      continue;
    }
    if (s.state === 'pending') {
      nextTasks.set(id, {
        ...s,
        state: 'skipped',
        failure: { kind: 'mergeBlocked', blockedTaskIds: [taskId] },
      });
      continue;
    }
    nextTasks.set(id, appendCascadeTaskId(s, 'mergeBlocked', taskId));
  }
  return { ...run, tasks: nextTasks };
}

/**
 * マージが衝突以外の理由（gitエラー等）で失敗した（design.md §16.17「その他の失敗は
 * failed」）。`failed`と同じく実行全体を止め、依存する後続を`skipped`
 * （理由: `dependencyFailed`）にする。対象タスクが`merging`のときだけ動く。
 */
export function markMergeFailed(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
): RunState {
  return markFailedFrom(run, tasks, taskId, { kind: 'mergeFailed' }, (s) => s === 'merging');
}

/**
 * `blocked`のタスクを、再マージのために`merging`へ戻す（design.md §16.17「Viewから人が
 * 解決したうえで『再マージ』を指示できる」）。`blocked`のときだけ動く。実際にマージを
 * やり直す（`IntegrationMergeQueue.mergeTask`の呼び出し）のは実行層の責務で、この関数は
 * 状態を戻すだけ。依存先の`skipped`（`mergeBlocked`）を戻す処理は、`retryTask`
 * （タスクそのものの再実行）と違い、まだブロック中の後続を勝手に再開させない意図で
 * 含めない（再マージが成功して`done`になった時点で、`nextTasksToStart`が改めて拾う）。
 *
 * **`haltedByUser`は解除しない**（Issue #412のレビュー指摘B）。「再マージ」は人の明示操作
 * だが、解除すると`markMergeSucceeded`が依存先の`skipped`（`mergeBlocked`）を`pending`へ
 * 戻した瞬間に`nextTasksToStart`の停止判定（`isRunHalted`）が外れ、ユーザーが停止したrunの
 * 後続タスクが新しいセッションを開いて走り出す（「再マージ1件」の操作でワークフロー全体が
 * 再開してしまう）。停止中でもそのタスクのマージ自体は走る。実行層（`runnerMerge.ts`の
 * `decideAfterLeaseWait`）が見るのは「統合worktreeの順番待ちの**間に**停止へ変わったか」
 * という差分だけで、`retryMerge`起点なら待つ前から停止中のため素通りするため。
 */
export function retryMergeState(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'blocked') {
    return run;
  }
  return setTask(run, taskId, { ...current, state: 'merging', failure: undefined });
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

/**
 * `running` のタスクを `waitingReply` にする（design.md §16.21「`expectReply: true` で
 * 送ったタスクは、自分のターンを終えたあと、返信が届くまで次の指示を受け取らない」）。
 * `messaging.ts`の判定（`validateSendMessage`等）は状態を変えないため、実際の遷移は
 * ここで行う。
 */
export function markWaitingReply(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'running') {
    return run;
  }
  return setTask(run, taskId, { ...current, state: 'waitingReply' });
}

/**
 * `waitingReply` から `running` へ戻る。返信が届いた場合と、待ちぼうけが解けた場合
 * （design.md §16.21「待ちぼうけを検出する経路」）の両方で使う共通の遷移。
 */
export function resumeFromWaitingReply(run: RunState, taskId: string): RunState {
  const current = run.tasks.get(taskId);
  if (current === undefined || current.state !== 'waitingReply') {
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
 * 代わりに`manualRetryCount`を増やす。worktreeのディレクトリ名とブランチ名は両者の合計から
 * 決まるため（`retrySuffixOf`）、前の試行が残したブランチと衝突しない
 * （増やさないと`branchExists`で再実行が必ず失敗する。issue #275）。
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
  nextTasks.set(taskId, {
    ...current,
    state: 'pending',
    manualRetryCount: current.manualRetryCount + 1,
    failure: undefined,
  });
  for (const id of toRestore) {
    const s = nextTasks.get(id);
    if (s === undefined || s.state !== 'skipped') {
      continue;
    }
    nextTasks.set(id, { ...s, state: 'pending', failure: undefined });
  }
  return { ...run, tasks: nextTasks, haltedByUser: false };
}

/**
 * `WorkflowRunner.retryTask`/`WorkflowRunner.continueTask`が「人の明示操作」を起点に
 * するのと対で、ウィンドウのリロード（design.md §16.11）で`reloadInterrupted`（環境側の理由に
 * よる中断、`runStore.ts`の`reconcileRunOnReload`が付ける）へ倒れたタスクを、人の操作を
 * 待たずに`pending`へ戻す（design.md §16.35、roadmap W10、Issue #584）。呼び出し元
 * （`runnerRestore.ts`）が、run単位の事前条件（`haltedByUser`でない・再開試行回数が
 * 上限内・定義ファイルが読める）を確認してから呼ぶ。この関数自身は次を判定する。
 *
 * **`reloadInterrupted`以外の理由で`failed`が1件でも残っていれば、run全体の自動再開を
 * あきらめる（`blockedByOtherFailure`）。** `nextTasksToStart`（`scheduler.ts`）は
 * `isRunHalted`（`haltedByUser || hasFailedTask`）が真の間いっさい新規開始しない。他の
 * タスクが本物の理由（`loopFailed`等）で`failed`のまま残っていると、ここで`reloadInterrupted`
 * のタスクだけ`pending`へ戻しても`nextTasksToStart`に一生拾われない「開始されない`pending`」
 * を作ってしまう（`markMergeSucceeded`のJSDocが書く不変条件と同じ）。誰にも回収できない
 * 状態を防ぐため、他に本物の`failed`が残っている run はまるごと自動再開の対象から外し、
 * 人の操作（Viewの「再実行」）に委ねる。
 *
 * **`allow`（危険操作の実行前確認、design.md §16.7）を持つタスクが`reloadInterrupted`で
 * 止まっていれば、run全体の自動再開をあきらめる（`blockedByAllowGate`）。** `start()`/
 * `retryTask()`はどちらも`allow`が非空のタスクを`allowConfirmed: true`が来るまで開始しない。
 * 自動再開には人が居らず確認を取れないため、そのタスクだけ`pending`へ戻さず`failed`のまま
 * 残すことになるが、それでは上と同じ理由（残った`failed`が`isRunHalted`を真に保つ）で
 * 他の`reloadInterrupted`タスクも道連れで拾われなくなる。したがって`allow`を持つタスクが
 * 1件でも対象に含まれていれば、run全体をまるごと対象から外す。
 *
 * **`reloadInterrupted`のタスクを`pending`へ戻すとき、`manualRetryCount`を1増やす
 * （`retryCount`ではない）。** `worktree.ts`の`createWorktree`はブランチ名が既存なら
 * `branchExists`で拒否し、`git worktree add`自体を試みない（設計上、二重にworktreeを
 * 作ることはできない）。リロード前に中断したタスクは、多くの場合すでに自分のworktree・
 * ブランチを作った後（`running`まで進んでいた）ため、`retryCount`/`manualRetryCount`を
 * 変えずに`pending`へ戻すと`retrySuffixOf`が同じ試行番号を返し、`createWorktree`が
 * 古いworktreeとの`branchExists`衝突で失敗する（＝自動再開のたびに必ず失敗する）。
 * 新しい試行番号（新しいworktree・ブランチ名）を割り当てて衝突を避ける必要がある点は
 * `applyLoopStopReason`の`'failed'`分岐（自動再試行）と同じだが、**`retryCount`を進める
 * 選択はしない**。`retryCount`は`task.retries`（design.md §16.5、タスク定義の自動再試行の
 * 予算）と比較される消費カウンタそのもの（このファイルの`'failed'`分岐、
 * `current.retryCount < task.retries`）で、リロードで中断されただけのタスクの`retryCount`を
 * 進めると、そのタスクが後で本物の理由（`loopFailed`等）で失敗したとき自動再試行の予算を
 * 1回黙って消費してしまう——受入基準にもdesign.mdにも無い副作用になる（レビュー指摘。
 * 2026-08-23）。`retrySuffixOf`（`runner.ts`）はworktree/ブランチの接尾辞を
 * `retryCount + manualRetryCount`の合計から決めるため、どちらを進めても衝突回避の
 * 目的は等しく果たせる。`manualRetryCount`は`task.retries`と比較される箇所が無い
 * （`grep`で確認済み。使うのは`totalAttempts`の算出と`retrySuffixOf`のみ）ため、
 * こちらを進めて「人の明示操作または自動再開による試行回数（`retries`の予算を消費しない
 * 試行）」という意味へ広げる（`TaskRunState.manualRetryCount`のJSDoc参照）。
 *
 * **reload起因で`skipped(runHalted)`になっていた後続も`pending`へ戻す。** 上の2つの
 * ガード（他のfailedが無い・allowを持つ対象が無い）を通過した時点で、このrunに残る
 * `skipped(runHalted)`は必ずこのリロードによって`pending`から倒された（`reconcileRunOnReload`）
 * ものだけだと確定できる（`haltedByUser`は呼び出し元が事前に確認済み、他の`failed`も
 * 無いことをここで確認済みのため、`runHalted`を作りうる経路がこのリロード以外に無い）。
 * `markMergeSucceeded`が依存先の`skipped(mergeBlocked)`を戻すのと同じ考え方で、これらも
 * まとめて`pending`へ戻し、スケジューラ（`nextTasksToStart`）の依存充足チェックに委ねる。
 */
export type AutoResumeOutcome =
  | { readonly kind: 'nothingToResume' }
  | { readonly kind: 'blockedByOtherFailure' }
  | { readonly kind: 'blockedByAllowGate'; readonly taskIds: readonly string[] }
  | { readonly kind: 'resumed'; readonly run: RunState; readonly resumedTaskIds: readonly string[] };

export function applyAutoResume(
  run: RunState,
  tasks: readonly WorkflowTask[],
): AutoResumeOutcome {
  const reloadInterruptedIds: string[] = [];
  let hasOtherFailure = false;
  for (const [id, s] of run.tasks) {
    if (s.state !== 'failed') {
      continue;
    }
    if (s.failure?.kind === 'reloadInterrupted') {
      reloadInterruptedIds.push(id);
    } else {
      hasOtherFailure = true;
    }
  }
  if (hasOtherFailure) {
    return { kind: 'blockedByOtherFailure' };
  }
  if (reloadInterruptedIds.length === 0) {
    return { kind: 'nothingToResume' };
  }
  const allowGatedIds = reloadInterruptedIds.filter((id) => {
    const task = tasks.find((t) => t.id === id);
    return task !== undefined && task.allow.length > 0;
  });
  if (allowGatedIds.length > 0) {
    return { kind: 'blockedByAllowGate', taskIds: allowGatedIds };
  }

  const nextTasks = new Map(run.tasks);
  const resumedTaskIds: string[] = [];
  for (const id of reloadInterruptedIds) {
    const s = nextTasks.get(id);
    if (s === undefined) {
      continue;
    }
    nextTasks.set(id, {
      ...s,
      state: 'pending',
      // `retryCount`ではなく`manualRetryCount`を進める（`task.retries`の予算を消費させない
      // ため。上のJSDoc参照）
      manualRetryCount: s.manualRetryCount + 1,
      submissionCount: 0,
      failure: undefined,
    });
    resumedTaskIds.push(id);
  }
  for (const [id, s] of nextTasks) {
    if (s.state === 'skipped' && s.failure?.kind === 'runHalted') {
      nextTasks.set(id, { ...s, state: 'pending', failure: undefined });
      resumedTaskIds.push(id);
    }
  }
  return { kind: 'resumed', run: { ...run, tasks: nextTasks }, resumedTaskIds };
}

/**
 * 回数切れ（`maxReached`）・停滞（`stalled`、design.md §16.27、Issue #336）で止まった
 * タスクを、同じセッションのまま `running` へ戻す（design.md §16.8「続ける」、issue #284）。
 *
 * 「再実行」（`retryTask`）が新しいworktree・新しい会話で最初のプロンプトからやり直すのに
 * 対し、こちらは止まったところから走らせるための操作。worktreeもブランチも作り直さないため
 * `retryCount` / `manualRetryCount` は増やさない（増やすとディレクトリ名とブランチ名が
 * 変わってしまう。`retrySuffixOf`）。`submissionCount` も通算のまま残す。
 *
 * 受け付けるのは「回数切れ・停滞で `failed` になったタスク」だけ。ほかの失敗（`loopFailed` /
 * `manualStop` / `approvalRejected` など）は途中から続ける前提が無い。`stalled`を
 * `maxReached`と同列に加えたのは、どちらも「セッションは生きている・会話は壊れていない」
 * まま自動的に止まった点が同じで、続きから走らせる前提が崩れていないため（停滞は
 * 「同じ内容を繰り返しているだけ」であり、指示を変えれば続けられる余地がある）。
 * 呼び出し側の`runner.ts`は加えて、そのタスクのセッションがこのウィンドウで生きていることも
 * 要求する（リロード後は会話が失われているため「再実行」しかできない）。
 *
 * 連鎖して `skipped` になった依存先を `pending` へ戻すことと、`haltedByUser` を解除する
 * ことは `retryTask` と同じ（人の明示操作を再開の合図として扱う）。
 */
export function continueTask(
  run: RunState,
  tasks: readonly WorkflowTask[],
  taskId: string,
): RunState {
  const current = run.tasks.get(taskId);
  const task = tasks.find((t) => t.id === taskId);
  if (task === undefined || current === undefined) {
    return run;
  }
  if (
    current.state !== 'failed' ||
    (current.failure?.kind !== 'maxReached' && current.failure?.kind !== 'stalled')
  ) {
    return run;
  }
  const depsAllDone = task.dependsOn.every((dep) => run.tasks.get(dep)?.state === 'done');
  if (!depsAllDone) {
    return run;
  }

  const dependents = buildDependentsIndex(tasks);
  const toRestore = collectDependents(taskId, dependents);

  const nextTasks = new Map(run.tasks);
  nextTasks.set(taskId, { ...current, state: 'running', failure: undefined });
  for (const id of toRestore) {
    const s = nextTasks.get(id);
    if (s === undefined || s.state !== 'skipped') {
      continue;
    }
    nextTasks.set(id, { ...s, state: 'pending', failure: undefined });
  }
  return { ...run, tasks: nextTasks, haltedByUser: false };
}
