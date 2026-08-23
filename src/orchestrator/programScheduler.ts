import type { ProgramDefinition } from './program';
import { markRunSkipped, type ProgramState } from './programState';

/**
 * プログラム（runの束）の波のスケジューリング・失敗の伝播・終了判定（design.md
 * §16.37.2・§16.37.3、roadmap W12-2・W12-3、Issue #605・#606）。
 *
 * `scheduler.ts`が1run内のタスクの波を組み立てるのに対し、こちらは同じ考え方を
 * run単位へ持ち上げたもの。VSCode APIには一切依存しない純粋なロジックのみを置く
 * （`scheduler.ts`と同じ方針）。**「次にどのrunを開始すべきか」「どのrunを`skipped`に
 * すべきか」という判断はここに集約し、`programState.ts`は選ばれた後の状態の書き換え
 * （`markRunSkipped`等）だけを持つ**（`nextProgramRunsToStart`のJSDoc、上のモジュール
 * コメントと同じ役割分担）。
 */

/**
 * 次に開始するrunidの集合を決める。`scheduler.ts`の`nextTasksToStart`のrun版。
 *
 * - **プログラム全体が人によって停止されていないこと（`state.haltedByUser`が偽）。**
 *   単発run側の`scheduler.ts`が`isRunHalted`を見て新規タスクの開始を止めるのと同じ
 *   構図（design.md §16.5・§16.35、roadmap W12-3、Issue #606）。この判定を関数の
 *   先頭に置くことで、呼び出し側（`programRunner.ts`）がこの条件を確認し忘れても
 *   新規起動が漏れない一点集中のガードにしてある
 * - `dependsOn`の全てが`done`であること
 * - 自身が`pending`であること
 * - `running`の総数が`def.maxParallel`未満であること（`scheduler.ts`と異なり、
 *   プログラムのrun状態は`pending`/`running`/`done`/`failed`/`skipped`の5値のみで
 *   `waitingApproval`等の中間状態を持たないため、`running`だけを数えれば足りる）
 * - `def.runs`に書かれた順で埋める（`scheduler.ts`と同じく再現性のため）
 *
 * **失敗の伝播はこの関数では行わない（`propagateProgramFailures`の担当、下記）。**
 * この関数を呼ぶ前に`propagateProgramFailures`を先に適用しておく前提（`programRunner.ts`の
 * `pumpProgram`が両方をこの順で呼ぶ）で、`failed`な依存を持つ`pending`は、その時点で
 * 既に`skipped`へ倒れているため、ここでは通常の`depsAllDone`判定（`skipped`は`done`
 * ではないので当然弾かれる）だけで足りる。それ以外の独立したrun（`failed`/`skipped`の
 * runに依存しない`pending`）は引き続き開始対象になる。
 */
export function nextProgramRunsToStart(
  def: ProgramDefinition,
  state: ProgramState,
): ReadonlySet<string> {
  if (state.haltedByUser) {
    return new Set();
  }

  const result = new Set<string>();

  let activeCount = 0;
  for (const entry of Object.values(state.runs)) {
    if (entry.state === 'running') {
      activeCount += 1;
    }
  }
  let capacity = def.maxParallel - activeCount;

  for (const run of def.runs) {
    if (capacity <= 0) {
      break;
    }
    const entry = state.runs[run.id];
    if (entry === undefined || entry.state !== 'pending') {
      continue;
    }
    const depsAllDone = run.dependsOn.every((dep) => state.runs[dep]?.state === 'done');
    if (!depsAllDone) {
      continue;
    }
    result.add(run.id);
    capacity -= 1;
  }
  return result;
}

/**
 * 失敗の伝播（design.md §16.37.3、roadmap W12-3、Issue #606の受入基準「前段が失敗した
 * とき後段が走らない」「走らなかったrunについて、理由が残る」）。
 *
 * `pending`のrunのうち、`dependsOn`のいずれかが`failed`または`skipped`に確定している
 * ものを、`markRunSkipped`（`programState.ts`）で`skipped`にする。理由
 * （`ProgramRunSkipReason`）には、直接のきっかけになった依存run id
 * （`failedRunId`。それ自身が`skipped`のときは、そのrunをさらに`skipped`にした
 * 依存run idではなく、あくまで**直接見つかった依存**を指す。理由の連鎖を辿るのは
 * `skipReason`を読む側の役目とし、この関数はO(件数)の単純な「直接のきっかけ」記録に
 * とどめる）を残す。
 *
 * **`failed`と`skipped`のどちらも「後続runの依存を満たさない」という点で同じに扱う。**
 * `skipped`は「起動していない」、`failed`は「起動したが失敗した」で意味は違うが、
 * どちらも`dependsOn`の`done`条件を満たさないという1点では共通するため、後続への
 * 伝播判定では区別しない（`markRunFinished`のJSDoc「後続runの依存を満たす`done`か
 * 否かの一点のみ」と同じ考え方）。
 *
 * **依存の連鎖は1回の呼び出しでは追い切らない場合があるため、変化が無くなるまで
 * 繰り返す。** 例: R1→R2→R3（R2はR1に、R3はR2に依存）でR1が`failed`のとき、1周目で
 * R2が`skipped`になるが、その時点でR3はまだ`pending`のままR2を見ても`skipped`が
 * 「今回付いたばかり」の場合がある（`def.runs`の記述順がR3→R2など、依存元より後ろに
 * 書かれた依存先を先に見てしまう順序次第）。`def.runs`の順に1回走査するだけでは
 * 取りこぼしうるため、1周で1件でも`skipped`にしたら再走査する（不動点に達するまで）。
 * `MAX_PROGRAM_RUN_COUNT`（50）が上限のため、最悪でも50周で必ず止まる。
 *
 * 変化が無ければ同じ`state`参照を返す（呼び出し側が「実際に書き換わったか」を
 * 参照比較で判定できるようにする。`reconcileProgramStateOnReload`と同じ方針）。
 * 純粋関数。
 */
export function propagateProgramFailures(def: ProgramDefinition, state: ProgramState): ProgramState {
  let current = state;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const run of def.runs) {
      const entry = current.runs[run.id];
      if (entry === undefined || entry.state !== 'pending') {
        continue;
      }
      const blockingDep = run.dependsOn.find((dep) => {
        const depState = current.runs[dep]?.state;
        return depState === 'failed' || depState === 'skipped';
      });
      if (blockingDep === undefined) {
        continue;
      }
      current = markRunSkipped(current, run.id, {
        kind: 'failedDependency',
        failedRunId: blockingDep,
      });
      progressed = true;
    }
  }
  return current;
}

/**
 * プログラム全体がこれ以上進まない状態（＝これ以上の波が起こり得ない）か。
 *
 * 全runが`done`・`failed`・`skipped`のいずれかに確定していれば`true`。`pending`
 * （`maxParallel`の空き待ち。`propagateProgramFailures`を先に適用済みという前提のため
 * ここに残る`pending`は「いずれ起動されうる」ものだけ）・`running`が1件でも残っていれば
 * `false`。
 *
 * **以前（W12-2まで）はここで「依存先の`failed`によって永久に開始されない`pending`」を
 * `false`のまま保守的に据え置いていた（`isProgramSettled`が真にならず`finishedAt`が
 * 永久に埋まらない、意図された保留）。W12-3（Issue #606）で`propagateProgramFailures`が
 * そのような`pending`を`skipped`（終端状態）へ確定させるようになったため、この関数を
 * 呼ぶ前提が変わった。** `programRunner.ts`の`pumpProgram`は`nextProgramRunsToStart`と
 * 同じく、`propagateProgramFailures`を先に適用した`state`をこの関数へ渡す前提（呼び出し
 * 順の詳細は`programRunner.ts`参照）。その前提が保たれる限り、依存先の失敗で二度と
 * 開始されない`pending`は存在しなくなり、以前あった「いつまでも実行中のまま残る」保留は
 * 解消される。
 */
export function isProgramSettled(def: ProgramDefinition, state: ProgramState): boolean {
  return def.runs.every((run) => {
    const s = state.runs[run.id]?.state;
    return s === 'done' || s === 'failed' || s === 'skipped';
  });
}
