import type { ProgramDefinition } from './program';
import type { ProgramState } from './programState';

/**
 * プログラム（runの束）の波のスケジューリングと終了判定（design.md §16.37.2、
 * roadmap W12-2、Issue #605）。
 *
 * `scheduler.ts`が1run内のタスクの波を組み立てるのに対し、こちらは同じ考え方を
 * run単位へ持ち上げたもの。VSCode APIには一切依存しない純粋なロジックのみを置く
 * （`scheduler.ts`と同じ方針）。
 */

/**
 * 次に開始するrunidの集合を決める。`scheduler.ts`の`nextTasksToStart`のrun版。
 *
 * - `dependsOn`の全てが`done`であること
 * - 自身が`pending`であること
 * - `running`の総数が`def.maxParallel`未満であること（`scheduler.ts`と異なり、
 *   プログラムのrun状態は`pending`/`running`/`done`/`failed`の4値のみで
 *   `waitingApproval`等の中間状態を持たないため、`running`だけを数えれば足りる）
 * - `def.runs`に書かれた順で埋める（`scheduler.ts`と同じく再現性のため）
 *
 * **失敗の伝播は決め打ちしない（roadmap W12-3、Issue #606の担当）。** あるrunが
 * `failed`になっても、それに依存する後続runは単に`depsAllDone`を満たさないため
 * 開始されないままになる（＝何もしない）。それ以外の独立したrun（`failed`のrunに
 * 依存しない`pending`）は引き続き開始対象になる。
 */
export function nextProgramRunsToStart(
  def: ProgramDefinition,
  state: ProgramState,
): ReadonlySet<string> {
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
 * プログラム全体がこれ以上進まない状態（＝これ以上の波が起こり得ない）か。
 *
 * `pending`のまま残るrunがあっても、それが（直接・間接に）`failed`なrunへ依存して
 * 二度と開始されないだけなら「これ以上進まない」に該当する。ここでは個々のrunの
 * 依存関係を遡って判定せず、**`pending`が1件でも残っていれば`false`**という
 * 保守的な判定に留める。理由: `pending`が「失敗した依存のせいで永久に開始されない」のか
 * 「まだ`maxParallel`の空きを待っているだけ」なのかをここで積極的に見分けて後者だけ
 * 続行するのは、失敗の伝播そのもの（後続runをどう扱うか）の判断に踏み込むことになり、
 * roadmap W12-3（Issue #606）の担当。ここで決め打ちしない（design.md §16.37.2）。
 *
 * 結果として、依存先が`failed`になったせいで永久に`pending`のまま残るrunを含む
 * プログラムは、`isProgramSettled`が`true`を返さず`finishedAt`が埋まらない
 * （＝いつまでも「実行中」として永続化され続ける）。これも同じくW12-3が決めるまでの
 * 意図した保留であり、バグではない。
 */
export function isProgramSettled(def: ProgramDefinition, state: ProgramState): boolean {
  return def.runs.every((run) => {
    const entry = state.runs[run.id];
    return entry?.state === 'done' || entry?.state === 'failed';
  });
}
