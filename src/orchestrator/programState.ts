import type { ProgramDefinition } from './program';
import type { RunOutcome } from './scheduler';

/**
 * プログラム実行中のrun状態の型・初期状態の組み立て・状態遷移（design.md §16.37、
 * roadmap W12-1・W12-2、Issue #604・#605）。`runState.ts`がタスク状態（`TaskState`）を
 * 持つのに対し、こちらはrun状態を持つ。VSCode APIには一切依存しない純粋なロジックの
 * みを置く。
 *
 * 「プログラム全体の状態」という入れ物の形・リロード直後の中断扱い
 * （`reconcileProgramStateOnReload`）に加えて、`pending`から`running`へ・`running`から
 * `done`/`failed`へ進める状態遷移（`markRunStarted` / `markRunFinished`）をここに持つ。
 * **次にどのrunを開始すべきかを選ぶ判断（波の組み立て）はここには無く
 * `programScheduler.ts`の担当。** ここにあるのは選ばれた後の状態の書き換えのみ
 * （`scheduler.ts`が`nextTasksToStart`を持ち、実際の状態遷移は`runState.ts`が持つのと
 * 同じ役割分担）。
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
 * `programScheduler.ts`の`nextProgramRunsToStart`が選んだrunidを`running`へ進める
 * （design.md §16.37.2、roadmap W12-2、Issue #605）。対応する`WorkflowRunner.start`が
 * 返した`runId`（`runState.ts`の`PersistedRun.runId`）を紐づける。
 *
 * 呼び出し側（`programRunner.ts`）が`state.runs[runRefId]?.state === 'pending'`を
 * 確認してから呼ぶ前提（この関数自体は前提を検証しない。`runState.ts`の遷移関数群と
 * 同じ方針）。純粋関数。
 */
export function markRunStarted(
  state: ProgramState,
  runRefId: string,
  runId: string,
): ProgramState {
  const current = state.runs[runRefId];
  if (current === undefined) {
    return state;
  }
  return { runs: { ...state.runs, [runRefId]: { state: 'running', runId } } };
}

/**
 * 開始済みのrunが終了したとき（`scheduler.ts`の`getRunOutcome`が`running`以外を
 * 返したとき）、対応するrun参照を`done`（`succeeded`）または`failed`（それ以外＝
 * `failed`/`blocked`/`aborted`）へ倒す（design.md §16.37.2、roadmap W12-2、
 * Issue #605）。
 *
 * **`succeeded`以外は全て`failed`へ丸める。** プログラム層の`ProgramRunState`は
 * `pending`/`running`/`done`/`failed`の4値のみで（design.md起票文の4状態）、単発run側の
 * `blocked`（統合できなかった）・`aborted`（人の割り込み等）に対応する専用の値を
 * 持たない。プログラムの観点で意味を持つのは「後続runの依存を満たす`done`か否か」の
 * 一点のみで、`blocked`/`aborted`を`failed`と区別して扱う（例えば別の対応を取る）判断は
 * 失敗の伝播そのものであり、roadmap W12-3（Issue #606）の担当。
 *
 * 呼び出し側が`state.runs[runRefId]?.state === 'running'`を確認してから呼ぶ前提
 * （この関数自体は前提を検証しない）。純粋関数。
 */
export function markRunFinished(
  state: ProgramState,
  runRefId: string,
  outcome: 'succeeded' | 'failed' | 'blocked' | 'aborted',
): ProgramState {
  const current = state.runs[runRefId];
  if (current === undefined) {
    return state;
  }
  const nextState: ProgramRunState = outcome === 'succeeded' ? 'done' : 'failed';
  return {
    runs: { ...state.runs, [runRefId]: { state: nextState, runId: current.runId } },
  };
}

/**
 * リロード直後、そのrunの実体（`WorkflowRunner`側の`runId`）が生きている（`listLive()`に
 * まだ現れる）と分かったとき、その最新の`outcome`（`scheduler.ts`の`getRunOutcome`）へ
 * 強制的に合わせ直す（design.md §16.37.2「リロードとW10の自動再開の整合」、
 * Issue #605のレビュー指摘F1）。
 *
 * **`reconcileProgramStateOnReload`が`running`を`failed`へ倒すのは暫定的な扱いでしかない。**
 * `runStore.ts`の`reconcileRunOnReload`が単発run側のタスクを`reloadInterrupted`扱いの
 * `failed`へ倒すのと同じく、その直後にW10（`runnerRestore.ts`の`autoResumeIfEligible`）が
 * 対象を再開しうる。単発run側は同じ`runId`のまま`pending`へ戻して続行する
 * （`applyAutoResume`）ため、プログラム側もその事実に追随する必要がある。呼び出し側
 * （`programRunner.ts`の`reconcileAfterReload`）が、`WorkflowRunner.restoreRunsForView()`
 * 完了後に`listLive()`で該当`runId`の現在の`outcome`を引いてから呼ぶ想定。
 *
 * `markRunStarted`と異なり、現在の`state`が`pending`であることを前提にしない
 * （`failed`からでも`running`・`done`へ戻せる）。`outcome === 'running'`なら`running`へ、
 * それ以外は`markRunFinished`と同じ丸め方（`succeeded`のみ`done`、それ以外は`failed`）で
 * 確定させる。変化が無ければ同じ参照を返す。純粋関数。
 */
export function reapplyLiveRunOutcome(
  state: ProgramState,
  runRefId: string,
  runId: string,
  outcome: RunOutcome,
): ProgramState {
  const current = state.runs[runRefId];
  if (current === undefined) {
    return state;
  }
  if (outcome !== 'running') {
    return markRunFinished(state, runRefId, outcome);
  }
  if (current.state === 'running' && current.runId === runId) {
    return state;
  }
  return { runs: { ...state.runs, [runRefId]: { state: 'running', runId } } };
}

/**
 * ウィンドウのリロード（あるいはWSLの停止・再起動）直後、`running`だったrun参照を
 * `failed`として扱う（`runStore.ts`の`reconcileRunOnReload`とタスク単位の同じ扱いを
 * プログラム単位でも行う。design.md §16.11・§16.35）。
 *
 * **この関数は状態を戻すだけで、失敗の伝播（依存先runを道連れにする等）は行わない。**
 * それは失敗の伝播そのものを扱う後続Issue（roadmap W12-3、Issue #606）の担当。
 * `pending`のrunはそのまま`pending`に留める（まだ何も始めていないため、単発runの
 * `reconcileRunOnReload`が`pending`を`skipped`へ道連れにするのとは異なる）。
 * roadmap W12-2（`programScheduler.ts`）で波のスケジューリング自体は持つように
 * なったが、それでも道連れにしない判断は変わらない。`pending`のrunが依存先の
 * `failed`によって永久に開始されないのか、単に`maxParallel`の空きを待っているだけ
 * なのかをここで見分けて片方だけ`skipped`等へ倒すのは、失敗の伝播そのものの判断で
 * あり引き続きroadmap W12-3（Issue #606）の担当（`programScheduler.ts`の
 * `isProgramSettled`のコメントも参照）。
 *
 * 純粋関数。呼び出し側（`programStore.ts`の`ProgramStore.reconcileAfterReload`）が
 * 実際の読み書きを担う。**ここで`failed`へ倒した後、その`runId`が実際にはW10で再開
 * されていた場合の訂正は`reapplyLiveRunOutcome`（このファイル）が担う。** この関数
 * 自体はリロード直後の暫定値を作るだけで、W10の再開有無までは判定しない。
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
