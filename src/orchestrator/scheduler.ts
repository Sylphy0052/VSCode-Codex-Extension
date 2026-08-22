import { isActiveTaskState, isRunHalted, type RunState } from './runState';
import type { WorkflowDefinition } from './workflow';

/**
 * 依存を満たしたタスクを `maxParallel` の範囲で選ぶスケジューリングと、
 * 実行全体の終了判定（design.md §16.3）。
 *
 * VSCode APIには一切依存しない純粋なロジックのみを置く。並列の制御はここでしか
 * 起きないという形にしておくと、テストで全パターンを踏める（design.md §16.3）。
 */

/**
 * 次に開始するタスクidの集合を決める。
 *
 * - `dependsOn` の全てが `done` であること。**`merging` は依存の充足とみなさない**
 *   （design.md §16.17「後続タスクは統合ブランチから分岐するため、依存先が`merging`の間は
 *   開始できない」。統合ブランチへ実際に入るのはマージが終わってからのため）
 * - 自身が `pending` であること
 * - `running` / `waitingApproval` / `waitingReply` / `merging` の合計が `maxParallel`
 *   未満であること（`waitingApproval` も人待ちのセッションが生きているため枠を占め、
 *   `waitingReply` も返信待ちのセッションが生きているため枠を占め、`merging` も
 *   マージが終わるまでそのタスクの成果は確定しないため枠を占める。design.md §16.3）
 * - 実行全体が停止している（`failed` の確定、または人の割り込み）ときは何も返さない
 * - 同じ段で複数開始できるとき、`def.tasks` に書かれた順で埋める（再現性のため）
 *
 * **例外（Issue #413 PR4、design.md §16.3）: `excludeFromActiveCount`。** 衝突解決
 * セッション（`live.mergeResolutions`）が承認待ちのまま止まっていると、そのタスクは
 * `merging`のまま`maxParallel`の枠を無期限に占め続け、他の独立したタスクが開始できなく
 * なる。`runner.ts`の`pump`は、承認待ちの解決セッションのtaskId集合をここへ渡すことで、
 * その分だけ`activeCount`から除外し、他タスクへ枠を明け渡す。
 *
 * **状態そのものは`merging`のまま変えない。** `isActiveTaskState`本体（`runState.ts`）は
 * 触らない。`getRunOutcome`（このファイル）は`merging`を`running`扱いすることに依存して
 * おり、外すと衝突解決中のrunが「終了した」と誤判定されて統合PR/MRの作成まで走る
 * （Issue #443・#412）。そのため`excludeFromActiveCount`はこの関数（`activeCount`の
 * 計算）にだけ作用し、`getRunOutcome`・`checkWaitingReplyStalls`
 * （`runnerMessaging.ts`）には渡さない。
 *
 * **依存の充足判定（`depsAllDone`）には影響しない。** 除外されても対象タスクの状態は
 * 引き続き`merging`であり`done`ではないため、このタスクへ依存する後続は従来どおり
 * 開始されない。したがって除外によって「`nextTasksToStart`が開始しない`pending`」
 * （`runState.ts`の`markMergeSucceeded`の不変条件）が新たに生まれることはない。承認待ちが
 * 解消すれば`pump`が渡す集合から自然に外れ、`activeCount`の計算に戻る。
 */
export function nextTasksToStart(
  def: WorkflowDefinition,
  run: RunState,
  excludeFromActiveCount: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const result = new Set<string>();
  if (isRunHalted(run)) {
    return result;
  }

  let activeCount = 0;
  for (const [taskId, s] of run.tasks) {
    if (isActiveTaskState(s.state) && !excludeFromActiveCount.has(taskId)) {
      activeCount += 1;
    }
  }
  let capacity = def.maxParallel - activeCount;

  for (const task of def.tasks) {
    if (capacity <= 0) {
      break;
    }
    const state = run.tasks.get(task.id);
    if (state === undefined || state.state !== 'pending') {
      continue;
    }
    const depsAllDone = task.dependsOn.every((dep) => run.tasks.get(dep)?.state === 'done');
    if (!depsAllDone) {
      continue;
    }
    result.add(task.id);
    capacity -= 1;
  }
  return result;
}

export type RunOutcome = 'running' | 'succeeded' | 'failed' | 'blocked' | 'aborted';

/**
 * 実行全体の終了判定（design.md §16.5 / §16.17）。判定は次の順。
 *
 * 1. `pending` / `running` / `waitingApproval` / `waitingReply` / `merging` が
 *    1件でもあれば `running`
 * 2. `failed` が1件でもあれば `failed`
 * 3. `blocked` が1件でもあれば `blocked`（作業は終わったが統合できていない）
 * 4. `skipped` が1件でもあれば `aborted`
 * 5. それ以外（全タスクが `done`）は `succeeded`
 *
 * `skipped` を見ずに`failed`の有無だけで判定すると、`manual` / `interrupted` による
 * 停止だけで終わったrun（その原因のタスク自身は`failed`にならない設計。§16.5）が
 * `succeeded` と誤判定される（レビュー指摘）。`dependencyFailed` による `skipped` は
 * 必ず対応する `failed` を伴うため2で拾われ、`mergeBlocked` による `skipped` は必ず
 * 対応する `blocked` を伴うため3で拾われる。4に落ちるのは `runHalted`（人の割り込み、
 * または他の失敗による停止で開始されなかった独立した枝）だけになる。
 *
 * `blocked` を `failed` より後（優先度を下げて）判定するのは、design.md §16.17
 * 「原因も次にやることも違う」の通り、1件でも`failed`があれば（作業そのものが
 * やり直し必要）その方が優先度の高い情報だと判断したため。
 */
export function getRunOutcome(run: RunState): RunOutcome {
  let anyFailed = false;
  let anyBlocked = false;
  let anySkipped = false;
  for (const s of run.tasks.values()) {
    // `isActiveTaskState`（枠を占める4状態）に加えて`pending`（まだ始まっていない）も
    // ここでは「まだ終わっていない」に含める。「枠を占める」より広い問いのため、
    // `pending`はここでだけ明示的に足す（`isActiveTaskState`のコメント参照）。
    if (s.state === 'pending' || isActiveTaskState(s.state)) {
      return 'running';
    }
    if (s.state === 'failed') {
      anyFailed = true;
    }
    if (s.state === 'blocked') {
      anyBlocked = true;
    }
    if (s.state === 'skipped') {
      anySkipped = true;
    }
  }
  if (anyFailed) {
    return 'failed';
  }
  if (anyBlocked) {
    return 'blocked';
  }
  return anySkipped ? 'aborted' : 'succeeded';
}
