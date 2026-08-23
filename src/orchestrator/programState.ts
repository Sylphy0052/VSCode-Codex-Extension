import type { ProgramDefinition } from './program';

/**
 * プログラム実行中のrun状態の型と初期状態の組み立て（design.md §16.37、roadmap W12-1、
 * Issue #604）。`runState.ts`がタスク状態（`TaskState`）を持つのに対し、こちらはrun状態を
 * 持つ。VSCode APIには一切依存しない純粋なロジックのみを置く。
 *
 * **この段では状態遷移そのもの（`pending`から`running`へ進める・依存の完了を見て次の
 * runを選ぶ等）は持たない。** それはrunを実際に起動する後続Issue（波のスケジューリング、
 * roadmap W12-2、Issue #605）の担当。ここにあるのは「プログラム全体の状態」という
 * 入れ物の形と、リロード直後の中断扱い（`reconcileProgramStateOnReload`）だけ。
 */

/** design.md 起票文の「未着手・実行中・完了・失敗」に対応する4値。 */
export const PROGRAM_RUN_STATES = ['pending', 'running', 'done', 'failed'] as const;
export type ProgramRunState = (typeof PROGRAM_RUN_STATES)[number];

/** プログラムが束ねる個々のrunの状態。`runState.ts`の`PersistedRun.runId`と紐づく。 */
export interface ProgramRunEntry {
  state: ProgramRunState;
  /**
   * このrunに対応する`WorkflowRunStore`側の`PersistedRun.runId`。まだ開始していなければ
   * `undefined`（`pending`のときは常に`undefined`）。
   */
  runId: string | undefined;
}

/** プログラム全体の実行状態（`runState.ts`の`RunState`に相当する層）。 */
export interface ProgramState {
  /** キーは`ProgramRunRef.id`（プログラム定義内のrun参照名）。 */
  runs: Record<string, ProgramRunEntry>;
}

/**
 * 検証済み（`validateProgram(def).errors.length === 0`）のプログラム定義から初期状態を
 * 組み立てる。全runを`pending`（未着手）にする。`workflow.ts`の`validateWorkflow`と同じく、
 * 呼び出し側が先に検証を済ませておく前提（この関数自体は検証しない）。
 */
export function createInitialProgramState(def: ProgramDefinition): ProgramState {
  const runs: Record<string, ProgramRunEntry> = {};
  for (const r of def.runs) {
    runs[r.id] = { state: 'pending', runId: undefined };
  }
  return { runs };
}

/**
 * ウィンドウのリロード（あるいはWSLの停止・再起動）直後、`running`だったrun参照を
 * `failed`として扱う（`runStore.ts`の`reconcileRunOnReload`とタスク単位の同じ扱いを
 * プログラム単位でも行う。design.md §16.11・§16.35）。
 *
 * **この関数は状態を戻すだけで、失敗の伝播（依存先runを道連れにする等）は行わない。**
 * それは失敗の伝播そのものを扱う後続Issue（roadmap W12-3、Issue #606）の担当。
 * `pending`のrunはそのまま`pending`に留める（まだ何も始めていないため、単発runの
 * `reconcileRunOnReload`が`pending`を`skipped`へ道連れにするのとは異なる。プログラムは
 * まだ上位のスケジューリングを持たないため、道連れにする対象＝根拠が無い）。
 *
 * 純粋関数。呼び出し側（`programStore.ts`の`ProgramStore.reconcileAfterReload`）が
 * 実際の読み書きを担う。
 */
export function reconcileProgramStateOnReload(state: ProgramState): ProgramState {
  let changed = false;
  const runs: Record<string, ProgramRunEntry> = {};
  for (const [id, entry] of Object.entries(state.runs)) {
    if (entry.state === 'running') {
      runs[id] = { ...entry, state: 'failed' };
      changed = true;
      continue;
    }
    runs[id] = entry;
  }
  if (!changed) {
    return state;
  }
  return { runs };
}
