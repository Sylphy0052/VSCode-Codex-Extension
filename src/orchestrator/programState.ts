import type { ProgramDefinition } from './program';
import type { RunOutcome } from './scheduler';

/**
 * プログラム実行中のrun状態の型・初期状態の組み立て・状態遷移（design.md §16.37、
 * roadmap W12-1・W12-2・W12-3、Issue #604・#605・#606）。`runState.ts`がタスク状態
 * （`TaskState`）を持つのに対し、こちらはrun状態を持つ。VSCode APIには一切依存しない
 * 純粋なロジックのみを置く。
 *
 * 「プログラム全体の状態」という入れ物の形・リロード直後の中断扱い
 * （`reconcileProgramStateOnReload`）に加えて、`pending`から`running`へ・`running`から
 * `done`/`failed`へ進める状態遷移（`markRunStarted` / `markRunFinished`）、`pending`を
 * `skipped`へ進める状態遷移（`markRunSkipped` / `markProgramHaltedByUser`、W12-3）を
 * ここに持つ。**次にどのrunを開始すべきか・どのrunを`skipped`にすべきかを選ぶ判断
 * （波の組み立て・失敗の伝播）はここには無く`programScheduler.ts`の担当。** ここにあるのは
 * 選ばれた後の状態の書き換えのみ（`scheduler.ts`が`nextTasksToStart`を持ち、実際の状態遷移は
 * `runState.ts`が持つのと同じ役割分担）。
 */

/**
 * design.md起票文の「未着手・実行中・完了・失敗」の4値に、`skipped`（走らせなかった）を
 * 加えた5値（W12-3、Issue #606）。**`skipped`は「これ以上そのrunを起動する見込みが無い」
 * ことが確定した`pending`の成れの果てで、`failed`とは区別する。** `failed`は実際に
 * `WorkflowRunner`側のrunが動いて（起動を試みて）失敗・停止したことを意味し`runId`を
 * 持ちうるのに対し、`skipped`はそもそも起動していない（`runId`は常に`undefined`）。
 * 起票文の受入基準「走らせなかったrunについて、理由が残る」を`ProgramRunEntry.skipReason`
 * （このファイル）で表す。
 */
export const PROGRAM_RUN_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type ProgramRunState = (typeof PROGRAM_RUN_STATES)[number];

/**
 * `pending`のrunを`skipped`にした理由（design.md §16.37.3、Issue #606）。
 *
 * - `failedDependency`: 依存していたrun（`failedRunId`）が`failed`または`skipped`に
 *   確定したため、`dependsOn`の`done`条件を満たす見込みが無くなった
 *   （`programScheduler.ts`の`propagateProgramFailures`が確定させる）
 * - `haltedByUser`: 人がプログラム全体を止めた（`markProgramHaltedByUser`）ため、
 *   まだ開始していなかった
 */
export type ProgramRunSkipReason =
  { kind: 'failedDependency'; failedRunId: string } | { kind: 'haltedByUser' };

/** プログラムが束ねる個々のrunの状態。`runState.ts`の`PersistedRun.runId`と紐づく。 */
export interface ProgramRunEntry {
  state: ProgramRunState;
  /**
   * このrunに対応する`WorkflowRunStore`側の`PersistedRun.runId`。まだ開始していなければ
   * `undefined`（`pending`・`skipped`のときは常に`undefined`。`skipped`はそもそも
   * 起動していないため）。
   */
  runId: string | undefined;
  /** `state === 'skipped'`のときだけ意味を持つ（W12-3、Issue #606）。それ以外は`undefined`。 */
  skipReason: ProgramRunSkipReason | undefined;
}

/** プログラム全体の実行状態（`runState.ts`の`RunState`に相当する層）。 */
export interface ProgramState {
  /** キーは`ProgramRunRef.id`（プログラム定義内のrun参照名）。 */
  runs: Record<string, ProgramRunEntry>;
  /**
   * 人がプログラム全体を止めたか（`runState.ts`の`RunState.haltedByUser`のプログラム版、
   * W12-3、Issue #606）。単発run側と同じく、`failed`の確定による停止（≒後述の失敗の伝播）
   * とは別に持つ（二重に状態を持つと同期が崩れるため、判定できるものは判定に寄せる、と
   * いう単発run側の方針をそのまま踏襲）。真の間、`programScheduler.ts`の
   * `nextProgramRunsToStart`は新規のrun起動を一切止める。
   */
  haltedByUser: boolean;
}

/**
 * 検証済み（`validateProgram(def).errors.length === 0`）のプログラム定義から初期状態を
 * 組み立てる。全runを`pending`（未着手）にする。`workflow.ts`の`validateWorkflow`と同じく、
 * 呼び出し側が先に検証を済ませておく前提（この関数自体は検証しない）。
 */
export function createInitialProgramState(def: ProgramDefinition): ProgramState {
  const runs: Record<string, ProgramRunEntry> = {};
  for (const r of def.runs) {
    runs[r.id] = { state: 'pending', runId: undefined, skipReason: undefined };
  }
  return { runs, haltedByUser: false };
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
export function markRunStarted(state: ProgramState, runRefId: string, runId: string): ProgramState {
  const current = state.runs[runRefId];
  if (current === undefined) {
    return state;
  }
  return {
    ...state,
    runs: { ...state.runs, [runRefId]: { state: 'running', runId, skipReason: undefined } },
  };
}

/**
 * 開始済みのrunが終了したとき（`scheduler.ts`の`getRunOutcome`が`running`以外を
 * 返したとき）、対応するrun参照を`done`（`succeeded`）または`failed`（それ以外＝
 * `failed`/`blocked`/`aborted`）へ倒す（design.md §16.37.2、roadmap W12-2、
 * Issue #605）。
 *
 * **`succeeded`以外は全て`failed`へ丸める。** プログラム層の`ProgramRunState`は
 * `pending`/`running`/`done`/`failed`/`skipped`の5値のみで（design.md起票文の4状態に
 * `skipped`を加えたもの。W12-3、Issue #606）、単発run側の`blocked`（統合できなかった）・
 * `aborted`（人の割り込み等）に対応する専用の値を持たない。プログラムの観点で意味を
 * 持つのは「後続runの依存を満たす`done`か否か」の一点のみで、`blocked`/`aborted`を
 * `failed`と区別して**別の状態値へ**倒す判断はしない（後続runを止めるという意味での
 * 「失敗の伝播」自体は行う。`programScheduler.ts`の`propagateProgramFailures`が
 * `failed`（このrun自身）を見て後続の`pending`を`skipped`へ倒す）。
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
    ...state,
    runs: {
      ...state.runs,
      [runRefId]: { state: nextState, runId: current.runId, skipReason: undefined },
    },
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
  return {
    ...state,
    runs: { ...state.runs, [runRefId]: { state: 'running', runId, skipReason: undefined } },
  };
}

/**
 * ウィンドウのリロード（あるいはWSLの停止・再起動）直後、`running`だったrun参照を
 * `failed`として扱う（`runStore.ts`の`reconcileRunOnReload`とタスク単位の同じ扱いを
 * プログラム単位でも行う。design.md §16.11・§16.35）。
 *
 * **この関数は状態を戻すだけで、失敗の伝播（依存先runを道連れにする等）は行わない
 * （W12-3、Issue #606で決着済み）。** `pending`のrunはそのまま`pending`に留める
 * （まだ何も始めていないため、単発runの`reconcileRunOnReload`が`pending`を`skipped`へ
 * 道連れにするのとは異なる）。**このファイルは`def`（run同士の`dependsOn`）を持たない
 * ため、そもそも「どのpendingが道連れか」を判定できない。** 判定と実際の`skipped`への
 * 遷移は`programScheduler.ts`の`propagateProgramFailures`（`def`と`state`の両方を受け取る）
 * が担い、`programRunner.ts`の`pumpProgram`が、この関数（`reconcileProgramOnReload`経由）と
 * `reapplyLiveRunOutcome`（W10の再開との整合）の**両方が確定した後**に呼ぶ
 * （`reconcileAfterReload`の末尾で全プログラムぶん`pumpProgram`を呼ぶ既存の配線が
 * そのままこの役割を兼ねる。design.md §16.37.3「暫定`failed`と確定`failed`の区別」参照）。
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
  return { runs, haltedByUser: state.haltedByUser };
}

/**
 * `pending`のrunを`skipped`にする（design.md §16.37.3、roadmap W12-3、Issue #606）。
 * 既に`pending`でなければ何もしない（`markRunStarted`と同じ、呼び出し側が前提を
 * 満たしてから呼ぶ方針。ここでは`pending`以外への上書きを防ぐガードとして働く。
 * `running`/`done`/`failed`を`skipped`で踏みつぶさないための多層防御）。
 *
 * 呼び出し元は2つ（`ProgramRunSkipReason`の2値に対応）:
 * - `programScheduler.ts`の`propagateProgramFailures`（`failedDependency`。前段runの
 *   `failed`/`skipped`確定を受けて、依存先の`pending`を道連れにする）
 * - このファイルの`markProgramHaltedByUser`（`haltedByUser`。人が全体を止めたときに
 *   未着手のものをまとめて止める）
 *
 * 純粋関数。
 */
export function markRunSkipped(
  state: ProgramState,
  runRefId: string,
  reason: ProgramRunSkipReason,
): ProgramState {
  const current = state.runs[runRefId];
  if (current === undefined || current.state !== 'pending') {
    return state;
  }
  return {
    ...state,
    runs: {
      ...state.runs,
      [runRefId]: { state: 'skipped', runId: undefined, skipReason: reason },
    },
  };
}

/**
 * 人がプログラム全体を止めた（design.md §16.37.3、roadmap W12-3、Issue #606）。
 * `runState.ts`の`applyLoopStopReason`（`manual`/`interrupted`）がタスク単位で行うのと
 * 同じ形をプログラム単位で行う: `haltedByUser`を立て、まだ開始していない`pending`を
 * 全て`skipped`（理由`haltedByUser`）にする。**`running`のrunはここでは変えない**
 * （そのrun自身の停止は`programRunner.ts`の`haltProgram`が`ProgramWorkflowPort.stop`
 * 経由で`WorkflowRunner.stop`を呼ぶ別経路。単発run側の`stop()`が「走行中のタスクは
 * 走らせ切る（ループだけ止める）」のと同じく、ここでは`running`の`ProgramRunEntry`を
 * 即座に`failed`/`skipped`へは倒さない。実際の終了確定は、その子runが実際に停止・
 * 完了して`onRunChanged`から`markRunFinished`が呼ばれるのを待つ）。
 *
 * 既に`haltedByUser`なら何もしない（同じ参照を返す。`stop()`が複数回呼ばれても安全に
 * するため、`runState.ts`の`applyLoopStopReason`と同じ方針）。純粋関数。
 */
export function markProgramHaltedByUser(state: ProgramState): ProgramState {
  if (state.haltedByUser) {
    return state;
  }
  let runs = state.runs;
  for (const [id, entry] of Object.entries(state.runs)) {
    if (entry.state === 'pending') {
      runs = {
        ...runs,
        [id]: { state: 'skipped', runId: undefined, skipReason: { kind: 'haltedByUser' } },
      };
    }
  }
  return { runs, haltedByUser: true };
}
