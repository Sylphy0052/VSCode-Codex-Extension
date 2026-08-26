import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createInitialProgramState,
  markProgramHaltedByUser,
  markRunFinished,
  markRunStarted,
  reapplyLiveRunOutcome,
} from './programState';
import {
  isProgramSettled,
  nextProgramRunsToStart,
  propagateProgramFailures,
} from './programScheduler';
import {
  parseProgramYaml,
  validateProgram,
  type ProgramDefinition,
  type ProgramIssue,
  type ProgramRunRef,
} from './program';
import type { PersistedProgram, ProgramStore } from './programStore';
import type { OrchestratorControlResult, ProgramControlPort } from './messaging';
import { SerialQueue } from './serialQueue';
import { sanitizeForLog } from './sanitize';
import {
  SimpleEmitter,
  type StartWorkflowResult,
  type LiveRunSummary,
  type WorkflowFilePort,
} from './runner';
import { MAX_WORKFLOW_FILE_BYTES } from './workflow';
import type { Logger } from '../log';

/**
 * プログラム（runの束）の実際の起動・進行・失敗の伝播・人による停止（design.md
 * §16.37.2・§16.37.3、roadmap W12-2・W12-3、Issue #605・#606）。`programScheduler.ts`
 * （波の組み立て・失敗の伝播の判断）・`programState.ts`（状態遷移）・`programStore.ts`
 * （永続化、W12-1）を束ね、`WorkflowRunner.start`/`stop`を実際に呼んでrunを起動・停止する層。
 *
 * 起動した各runのオーケストレーターへprogram制御口を注入する。前段run失敗時は後続を
 * 即skipせずpendingに保ち、run追加・削除・依存変更・再試行による復旧を10分待つ。
 *
 * `WorkflowRunner`本体には依存せず、必要な操作だけを`ProgramWorkflowPort`として
 * 注入で受け取る（`runner.ts`が`WorkflowRunnerDeps`で外部依存を注入で受け取るのと
 * 同じ方針。テストでは`WorkflowRunner`を起動せずにフェイクで差し替えられる）。
 */

/** `ProgramRunner`が`WorkflowRunner`へ要求する最小限の口。`WorkflowRunner`は構造的にこれを満たす。 */
export interface ProgramWorkflowPort {
  start(
    defPath: string,
    repoRoot: string,
    options?: { programControl?: ProgramControlPort },
  ): Promise<StartWorkflowResult>;
  listLive(): readonly LiveRunSummary[];
  onChanged(listener: (runId: string) => void): () => void;
  /**
   * 指定runIdの実行を停止する（design.md §16.37.3、roadmap W12-3、Issue #606）。
   * `WorkflowRunner.stop`と同形（同期・戻り値なし）。走行中のタスクのループを止める
   * だけで、そのrun自身の終了確定（`done`/`blocked`/`failed`）は既存の`onChanged`経路を
   * 待つ（`haltProgram`のJSDoc参照）。
   */
  stop(runId: string): void;
  attachProgramControl?(runId: string, control: ProgramControlPort): void;
  beginProgramRecovery?(runId: string, message: string): boolean;
  endProgramRecovery?(runId: string): void;
}

export interface ProgramRunnerDeps {
  programStore: ProgramStore;
  filePort: WorkflowFilePort;
  workflow: ProgramWorkflowPort;
  log: Logger;
  now?: () => Date;
  randomId?: () => string;
}

export interface StartProgramResult {
  ok: boolean;
  programId?: string;
  errors?: readonly ProgramIssue[];
}

type ParsedProgram =
  { ok: true; def: ProgramDefinition } | { ok: false; errors: readonly ProgramIssue[] };

export class ProgramRunner {
  /**
   * 開始済みでまだ終了を確認していない`WorkflowRunner`側の`runId` ->
   * `{ programId, runRefId }`の逆引き。このウィンドウで`ProgramRunner`自身が起動した
   * runだけを持つ（`WorkflowRunner.restoreRunsForView`が復元した単発runの`runId`は
   * ここには入らない。単発run側は`ProgramState`と紐づく理由が無いため）。
   *
   * **メモリ上のみで、リロードそのものをまたいでは保持しない。** リロード直後は
   * `reconcileAfterReload()`（このクラス）が、`WorkflowRunner.listLive()`を見て
   * まだ生きている（＝W10で再開された）`runId`ぶんだけをここへ組み直す
   * （design.md §16.37.2「リロードとW10の自動再開の整合」、Issue #605のレビュー
   * 指摘F1）。`ProgramStore`側の永続化（`runId`は`ProgramRunEntry.runId`として残る）を
   * 種にして復元する形は、`WorkflowRunner`本体の`runs`（メモリ上のLiveRunのMap）を
   * `restoreRunsForView()`が明示的に復元する設計（design.md §16.11）と同じ考え方。
   */
  private readonly trackedRuns = new Map<string, { programId: string; runRefId: string }>();
  private unsubscribe: (() => void) | undefined;
  /**
   * プログラムの状態が永続化された後に発火する通知（design.md §16.37.3のレビュー
   * 指摘F1、Issue #606）。`WorkflowViewManager`が持つ`workflow.onChanged`（`SimpleEmitter`、
   * `runner.ts`）は同期的にリスナを呼ぶが、その配下のリスナ（`ProgramRunner.attach()`が
   * 登録した`onRunChanged`）自体は非同期（ファイル読み込みを挟む`pumpProgram`を`await`
   * する）。そのため`workflow.onChanged`の別の購読者（`WorkflowViewManager`）が
   * それにただ乗りしてプログラムの状態を読んでも、`pumpProgram`の永続化が終わる前の
   * 値を読んでしまう。プログラムの状態が実際に確定した後にだけ発火するこの専用の
   * 通知を`pumpProgram` / `haltProgram`の末尾に置くことで、購読側が常に確定後の値を
   * 読めるようにする。
   */
  private readonly changeEmitter = new SimpleEmitter<string>();

  /**
   * `programId`ごとの排他キュー（Issue #606のレビュー指摘。横断レビューで実測、
   * 「同一プログラム配下の複数runがほぼ同時に完了すると`pumpProgram(programId)`が
   * 並行に走り、同じrunを二重起動する」を修正するために追加した）。
   *
   * `pumpProgram`は`programStore.find`（プレーンな同期読み取り）→（`await`を挟む）
   * 判断 → `startOneRun`（`await`で外部の`workflow.start`を呼ぶ）→
   * `programStore.update`という非アトミックな並びを持つ。`ProgramStore`が内部に持つ
   * `SerialQueue`（`programStore.ts`）は個々の`update`呼び出しだけを直列化し、
   * この一連の read→判断→実行→write 全体は守らない。`attach()`の購読が
   * `void this.onRunChanged(runId).catch(...)`というfire-and-forgetのため、同一
   * `programId`配下の複数runがawaitを挟まず同一tickで完了すると、2つの`pumpProgram`
   * 呼び出しが互いの意図が見えないまま同じ`toStart`を計算し、同じrunを二重起動する
   * （実測: `maxParallel:2`、依存無し4本で、2件を同一tick内で完了させると5回起動
   * される。うち1本が重複）。
   *
   * `pumpProgram`・`haltProgram`の両方の本体を、`programId`ごとに1本ずつ持つこの
   * キューへ通して直列化する（`runExclusive`）。**`haltProgram`も同じキューへ入れる。**
   * `haltProgram`も同じ`programId`に対する read（`programStore.find`）→ 判断 →
   * write（`programStore.update`）を持ち、`pumpProgram`と同じ穴を共有するため
   * （例: `pumpProgram`が古い状態を基に新規runを起動する判断をしている最中に
   * `haltProgram`が割り込むと、停止直後にもかかわらず新規runが起動し得る）。
   *
   * **デッドロックしない。** `pumpProgram`・`haltProgram`のどちらの本体からも、
   * 自分自身や相手を（このキュー経由で）再帰的に呼ぶ経路は無い（`startOneRun`が
   * 呼ぶ`programStore.update`は`ProgramStore`側の別の`SerialQueue`であり、この
   * `programQueues`とは別物）。`onRunChanged`・`reconcileAfterReload`は`pumpProgram`
   * を呼ぶだけで、いずれもこのキューへ自ら入ってはいない外側の呼び出し元。
   *
   * プログラムが終了確定（`finishedAt`が埋まる）した後は`runExclusive`が自分の
   * エントリをこのMapから削除する。`programId`は起動のたびに`randomUUID()`で
   * 新規発番されるため、削除しなければ拡張機能のプロセス寿命の間ずっと
   * 増え続けるMapになってしまう（`trackedRuns`と異なり、こちらは終了後に
   * 参照する理由が無い）。
   */
  private readonly programQueues = new Map<string, SerialQueue>();
  private readonly recoveryTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; heldRunIds: readonly string[] }
  >();

  constructor(private readonly deps: ProgramRunnerDeps) {}

  /**
   * プログラムの状態が変わるたびに呼ばれる（`programId`を渡す）。`pumpProgram` /
   * `haltProgram`が、対象プログラムの状態を`programStore`へ永続化し終えた後にだけ
   * 発火する（design.md §16.37.3のレビュー指摘F1）。`extension.ts`が`WorkflowViewManager`
   * へこれを配線し、プログラム欄の再描画のきっかけにする。
   */
  onChanged(listener: (programId: string) => void): () => void {
    return this.changeEmitter.on(listener);
  }

  /** `extension.ts`から1回だけ呼ぶ。`workflow.onChanged`を購読し、runの終了を検知する。 */
  attach(): void {
    this.unsubscribe = this.deps.workflow.onChanged((runId) => {
      void this.onRunChanged(runId).catch((e: unknown) => {
        this.deps.log.error(
          `[program] runId=${runId}の完了処理に失敗しました: ${sanitizeForLog(
            e instanceof Error ? e.message : String(e),
          )}`,
        );
      });
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const recovery of this.recoveryTimers.values()) clearTimeout(recovery.timer);
    this.recoveryTimers.clear();
  }

  /**
   * `programId`に対応する`SerialQueue`（無ければ新規作成）へ`task`を積み、完了を
   * 待ってから、そのプログラムが終了確定していれば`programQueues`から自分の
   * エントリを取り除く（`programQueues`のJSDoc参照。`randomUUID()`で発番される
   * `programId`をキーに持ち続けるMapが際限なく増えないようにする掃除）。
   *
   * `task`実行後に一度`programStore.find`で`finishedAt`を確認するだけで、
   * `runExclusive`自身は「終了確定した」ことを判断しない（`pumpProgramLocked`/
   * `haltProgramLocked`が呼ぶ`maybeMarkFinished`の結果を読むだけ）。まだ`finishedAt`が
   * 埋まっていなければ、次の呼び出しで同じキューを使い続ける（削除しない）。
   */
  private runExclusive<T>(programId: string, task: () => Promise<T>): Promise<T> {
    let queue = this.programQueues.get(programId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.programQueues.set(programId, queue);
    }
    return queue.enqueue(async () => {
      try {
        return await task();
      } finally {
        const persisted = this.deps.programStore.find(programId);
        if (persisted === undefined || persisted.finishedAt !== undefined) {
          this.programQueues.delete(programId);
        }
      }
    });
  }

  /**
   * プログラム定義ファイルを読み込み、検証し、通れば実行を開始する。
   * `runner.ts`の`WorkflowRunner.start`と同じ形の戻り値にしてある。
   */
  async startProgram(defPath: string, workspaceRoot: string): Promise<StartProgramResult> {
    const parsed = await this.parseAndValidateProgram(defPath);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors };
    }
    const { def } = parsed;
    const programId = this.deps.randomId?.() ?? randomUUID();
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.deps.programStore.update(programId, () => ({
      programId,
      defPath,
      workspaceRoot,
      startedAt,
      finishedAt: undefined,
      state: createInitialProgramState(def),
      definition: def,
      recovery: undefined,
      changeHistory: [],
    }));
    await this.pumpProgram(programId);
    return { ok: true, programId };
  }

  /**
   * 次の波を計算し、開始できるrunを実際に起動する。リロード直後の再開（`reconcileAfterReload`
   * が全プログラムぶん呼ぶ）と、run完了検知（`onRunChanged`）の両方から呼ばれる冪等な操作。
   * 開始できるrunが無ければ何もしない。
   *
   * **失敗の伝播（design.md §16.37.3、roadmap W12-3、Issue #606）をここで先に確定させる。**
   * `propagateProgramFailures`が、直前の`markRunFinished`等で`failed`が確定したことを
   * 受けて、それに依存する`pending`を`skipped`へ倒す（1件でも倒れれば永続化してから
   * `persisted.state`を更新後の値へ差し替える）。**この呼び出し順が「暫定`failed`と
   * 確定`failed`の区別」の要。** `pumpProgram`は常に`ProgramStore`に永続化済みの
   * `state`から読み直して動く一本の入口で、リロード直後の暫定`failed`（`reapplyLive
   * RunOutcome`で訂正され得る）を先に確定させてから`propagateProgramFailures`を呼ぶ経路
   * （`reconcileAfterReload`）と、実行中に実際へ`failed`が確定してから呼ぶ経路
   * （`onRunChanged`）のどちらも、この関数へ来た時点の`persisted.state`は既に「その時点で
   * 確定している`failed`」だけを反映している（訂正未了の暫定値の上で伝播を行うことは
   * ない。詳細は`reconcileAfterReload`のJSDoc参照）。
   */
  pumpProgram(programId: string): Promise<void> {
    // 排他は`programQueues`のJSDoc参照。本体（read→判断→起動→write）はこのキューを
    // 通してprogramIdごとに1本ずつしか同時に走らない
    return this.runExclusive(programId, () => this.pumpProgramLocked(programId));
  }

  private async pumpProgramLocked(programId: string): Promise<void> {
    const persisted = this.deps.programStore.find(programId);
    if (persisted === undefined) {
      return;
    }
    const parsed = await this.resolveProgramDefinition(persisted);
    if (!parsed.ok) {
      this.deps.log.error(
        `[program ${programId}] 定義ファイルの再読込に失敗したため、波を進められません:\n` +
          parsed.errors.map((e) => e.message).join('\n'),
      );
      return;
    }
    const { def } = parsed;
    let state = persisted.state;
    // beginProgramRecoveryを実装する新しいWorkflowRunnerでは失敗を保留して復旧口を維持する。
    // この任意APIを持たない既存アダプターでは従来どおり即時伝播し、後方互換を保つ。
    if (this.deps.workflow.beginProgramRecovery === undefined) {
      const propagated = propagateProgramFailures(def, state);
      if (propagated !== state) {
        await this.deps.programStore.update(programId, (current) => {
          if (current === undefined) {
            throw new Error(`[program ${programId}] 失敗伝播中にプログラムが消えました`);
          }
          return { ...current, state: propagated };
        });
        state = propagated;
      }
    }
    const toStart = nextProgramRunsToStart(def, state);
    if (toStart.size > 0 && persisted.recovery !== undefined) {
      await this.clearProgramRecovery(programId, '計画変更後に再スケジューリングを開始しました');
      state = this.deps.programStore.find(programId)?.state ?? state;
    }
    for (const runRefId of toStart) {
      await this.startOneRun(programId, persisted.workspaceRoot, def, runRefId);
    }
    const latest = this.deps.programStore.find(programId);
    if (
      this.deps.workflow.beginProgramRecovery !== undefined &&
      latest !== undefined &&
      this.needsProgramRecovery(def, latest.state)
    ) {
      await this.ensureProgramRecovery(programId, latest);
    } else if (latest?.recovery !== undefined) {
      await this.clearProgramRecovery(programId, 'program変更により失敗した依存が解消されました');
    }
    await this.maybeMarkFinished(programId);
    // 状態の永続化がここまで全て完了した後に発火する（`changeEmitter`のJSDoc参照）
    this.changeEmitter.fire(programId);
  }

  /**
   * プログラム全体を人の手で止める（design.md §16.37.3、roadmap W12-3、Issue #606の
   * 受入基準「プログラムを人の手で止められる」「人が止めたプログラムが、リロード・
   * WSLの停止をまたいでも自動再開しない」）。`runner.ts`の`WorkflowRunner.stop`
   * （単発runの「全体の停止」）のプログラム版。
   *
   * 1. このプログラムが起動した`running`な子run（`trackedRuns`に記録済み）へ
   *    `ProgramWorkflowPort.stop`を送る。`WorkflowRunner.stop`と同じく、走行中の
   *    ループを止めるだけで、その場でrunを終了確定させない（進行中のターンには
   *    割り込まない）。その子run自身の`haltedByUser`もこの時点で立つため
   *    （`runner.ts`の`stop()`）、W10（`runnerRestore.ts`の`autoResumeIfEligible`）は
   *    リロードをまたいでもその子runを再開しない——単発run側と全く同じ仕組みに
   *    そのまま乗る（design.md §16.35「人が止めたrunは再開しない」と同じ扱い）
   * 2. `programStore`の状態を`markProgramHaltedByUser`で更新する。まだ開始していない
   *    `pending`は即座に`skipped`（理由`haltedByUser`）になり、`state.haltedByUser`が
   *    立つ。`state.haltedByUser`は永続化される（`ProgramState`の一部）ため、リロード
   *    後も残り、`nextProgramRunsToStart`が新規起動を止め続ける（`programScheduler.ts`
   *    参照）。**`reconcileProgramStateOnReload`は`haltedByUser`を素通しする**（この
   *    フラグ自体を`running`扱いへ巻き戻す理由が無いため）
   * 3. `maybeMarkFinished`を呼ぶ。停止時点で`running`な子runが無ければ（全て`pending`
   *    だった、または既に決着していた）、この時点で`finishedAt`が埋まる。`running`な
   *    子runが残っていれば、それが実際に終了確定するまで`finishedAt`は埋まらない
   *    （通常の`onRunChanged` → `pumpProgram`の経路で後から埋まる）
   *
   * programIdが存在しなければ何もしない（`pumpProgram`と同じ防御）。
   */
  haltProgram(programId: string): Promise<void> {
    // `pumpProgram`と同じキューを通す（`programQueues`のJSDoc参照。halt自身もこの
    // programIdに対するread-modify-writeを持ち、`pumpProgram`と同じ穴を共有するため）
    return this.runExclusive(programId, () => this.haltProgramLocked(programId));
  }

  private async haltProgramLocked(programId: string): Promise<void> {
    const persisted = this.deps.programStore.find(programId);
    if (persisted === undefined) {
      return;
    }
    for (const [runId, tracked] of this.trackedRuns) {
      if (tracked.programId === programId) {
        this.deps.workflow.stop(runId);
      }
    }
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) {
        throw new Error(`[program ${programId}] 停止の記録中にプログラムが消えました`);
      }
      return { ...current, state: markProgramHaltedByUser(current.state) };
    });
    await this.maybeMarkFinished(programId);
    // 状態の永続化がここまで全て完了した後に発火する（`changeEmitter`のJSDoc参照）
    this.changeEmitter.fire(programId);
  }

  /**
   * リロード（あるいはWSLの停止・再起動）直後に1回呼ぶ。`ProgramStore.reconcileAfterReload()`
   * と`WorkflowRunner.restoreRunsForView()`の両方が完了した後に呼ぶ前提（`extension.ts`が
   * 順序を保証する）。
   *
   * **`reconcileProgramStateOnReload`が`running`を`failed`へ倒すのは暫定値でしかない。**
   * `runId`が`WorkflowRunner.listLive()`にまだ現れる場合、それはW10
   * （`autoResumeIfEligible`）が同じ`runId`のまま再開した（または元から中断していな
   * かった）ことを意味する。その最新の`outcome`へ`reapplyLiveRunOutcome`で合わせ直し、
   * まだ`running`なら`trackedRuns`へ再登録して以後の`onRunChanged`で追跡を再開する
   * （design.md §16.37.2「リロードとW10の自動再開の整合」、Issue #605のレビュー指摘F1）。
   * `listLive()`に現れない（定義ファイルが読めない等で復元自体に失敗した）runIdは、
   * `reconcileProgramStateOnReload`が付けた`failed`のまま変えない。
   *
   * 最後に全プログラムぶん`pumpProgram`を呼び、続きの波を進める。
   */
  async reconcileAfterReload(): Promise<void> {
    for (const persisted of this.deps.programStore.list()) {
      let nextState = persisted.state;
      for (const [runRefId, entry] of Object.entries(persisted.state.runs)) {
        if (entry.state !== 'failed' || entry.runId === undefined) {
          continue;
        }
        const runId = entry.runId;
        const live = this.deps.workflow.listLive().find((r) => r.runId === runId);
        if (live === undefined) {
          // 復元自体に失敗した（定義ファイルが読めない等）。reconcileProgramStateOnReload
          // が付けたfailedのまま変えない
          continue;
        }
        nextState = reapplyLiveRunOutcome(nextState, runRefId, runId, live.outcome);
        this.deps.workflow.attachProgramControl?.(
          runId,
          this.buildProgramControl(persisted.programId),
        );
        if (live.outcome === 'running') {
          this.trackedRuns.set(runId, { programId: persisted.programId, runRefId });
        }
      }
      if (nextState === persisted.state) {
        continue;
      }
      const programId = persisted.programId;
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(`[program ${programId}] リロード後の整合中にプログラムが消えました`);
        }
        return { ...current, state: nextState };
      });
    }
    for (const persisted of this.deps.programStore.list()) {
      await this.pumpProgram(persisted.programId);
    }
  }

  private async startOneRun(
    programId: string,
    workspaceRoot: string,
    def: ProgramDefinition,
    runRefId: string,
  ): Promise<void> {
    const runRef = def.runs.find((r) => r.id === runRefId);
    if (runRef === undefined) {
      return;
    }
    if (path.isAbsolute(runRef.defPath)) {
      // `validateProgram`の`isSafeDefPath`が絶対パスを拒否するため、検証を通った定義
      // からは本来ここへ到達しない。到達した場合に`workspaceRoot`外を指す経路を
      // 開いてしまわないよう、素通しせず明示的に拒否する（Issue #605のレビュー
      // 指摘F3。到達しないことと、到達した場合の向きの安全性は別の話）
      this.deps.log.error(
        `[program ${programId}] run"${runRefId}"のdefPathが絶対パスです（検証済みの定義には` +
          `本来含まれません）: ${runRef.defPath}`,
      );
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(
            `[program ${programId}] run"${runRefId}"の起動拒否の記録中にプログラムが消えました`,
          );
        }
        return { ...current, state: markRunFinished(current.state, runRefId, 'failed') };
      });
      return;
    }
    const absoluteDefPath = path.join(workspaceRoot, runRef.defPath);
    const programControl = this.buildProgramControl(programId);
    const result = await this.deps.workflow.start(absoluteDefPath, workspaceRoot, {
      programControl,
    });
    if (result.ok && result.runId !== undefined) {
      const runId = result.runId;
      this.trackedRuns.set(runId, { programId, runRefId });
      this.deps.workflow.attachProgramControl?.(runId, programControl);
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined) {
          throw new Error(
            `[program ${programId}] run"${runRefId}"の起動中にプログラムが消えました`,
          );
        }
        return { ...current, state: markRunStarted(current.state, runRefId, runId) };
      });
      return;
    }
    // 開始そのものに失敗した（allow確認待ち・検証エラー・git前提の不足等）。
    // 確認待ち（needsAllowConfirmation）は人の判断を要するため、この段では対応せず
    // failedとして記録する（プログラムからの自動起動はallow確認を持たない。allowを
    // 含むワークフローをプログラムのrunに使う場合の扱いはIssue #606以降で検討）
    const detail = (result.errors ?? []).map((e) => e.message).join('; ');
    this.deps.log.error(
      `[program ${programId}] run"${runRefId}"を開始できませんでした` +
        (detail === '' ? '' : `: ${detail}`),
    );
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) {
        throw new Error(
          `[program ${programId}] run"${runRefId}"の起動失敗の記録中にプログラムが消えました`,
        );
      }
      return { ...current, state: markRunFinished(current.state, runRefId, 'failed') };
    });
  }

  private async maybeMarkFinished(programId: string): Promise<void> {
    const persisted = this.deps.programStore.find(programId);
    if (
      persisted === undefined ||
      persisted.finishedAt !== undefined ||
      persisted.recovery !== undefined
    ) {
      return;
    }
    const parsed = await this.resolveProgramDefinition(persisted);
    if (!parsed.ok || !isProgramSettled(parsed.def, persisted.state)) {
      return;
    }
    const finishedAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.deps.programStore.update(programId, (current) =>
      current === undefined || current.finishedAt !== undefined
        ? (current ?? persisted)
        : { ...current, finishedAt },
    );
  }

  private async onRunChanged(runId: string): Promise<void> {
    const tracked = this.trackedRuns.get(runId);
    if (tracked === undefined) {
      return;
    }
    const live = this.deps.workflow.listLive().find((r) => r.runId === runId);
    if (live === undefined || live.outcome === 'running') {
      // まだ終わっていない（あるいはWorkflowRunnerの一覧から既に消えている）。
      // 後者は起きない想定だが、起きても何もしないのが安全（次のonChangedを待つ）
      return;
    }
    this.trackedRuns.delete(runId);
    const { programId, runRefId } = tracked;
    // クロージャ内では`live.outcome`の絞り込み（'running'除外）が保持されないため、
    // 確定した値を変数へ取り出してから渡す
    const outcome = live.outcome;
    if (outcome !== 'succeeded') {
      this.deps.workflow.beginProgramRecovery?.(
        runId,
        `program内のrun ${runRefId} が失敗しました。program全体の計画修復を開始します。`,
      );
    }
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) {
        // 理論上到達しない（このrunIdを追跡していた時点でprogramは存在したはず）。
        // それでも型上は戻り値が要るため、更新をスキップする形の値を返す
        throw new Error(`[program ${programId}] runId=${runId}の追跡中にプログラムが消えました`);
      }
      return { ...current, state: markRunFinished(current.state, runRefId, outcome) };
    });
    await this.pumpProgram(programId);
  }

  private resolveProgramDefinition(persisted: PersistedProgram): Promise<ParsedProgram> {
    if (persisted.definition === undefined) {
      return this.parseAndValidateProgram(persisted.defPath);
    }
    const validation = validateProgram(persisted.definition);
    return Promise.resolve(
      validation.errors.length === 0
        ? { ok: true, def: persisted.definition }
        : { ok: false, errors: validation.errors },
    );
  }

  private needsProgramRecovery(def: ProgramDefinition, state: PersistedProgram['state']): boolean {
    if (state.haltedByUser) return false;
    if (Object.values(state.runs).some((entry) => entry.state === 'running')) return false;
    const failed = new Set(
      Object.entries(state.runs)
        .filter(([, entry]) => entry.state === 'failed')
        .map(([id]) => id),
    );
    if (failed.size === 0) return false;
    return (
      def.runs.some(
        (run) =>
          state.runs[run.id]?.state === 'pending' && run.dependsOn.some((id) => failed.has(id)),
      ) || Object.values(state.runs).every((entry) => entry.state !== 'running')
    );
  }

  private async ensureProgramRecovery(
    programId: string,
    persisted: PersistedProgram,
  ): Promise<void> {
    if (persisted.recovery !== undefined) {
      this.scheduleProgramRecoveryTimeout(programId, persisted.recovery.deadline);
      return;
    }
    const failedRunIds = Object.entries(persisted.state.runs)
      .filter(([, entry]) => entry.state === 'failed')
      .map(([id]) => id);
    const deadline = new Date(
      (this.deps.now?.() ?? new Date()).getTime() + 10 * 60 * 1000,
    ).toISOString();
    const message = `run ${failedRunIds.join(', ')} の失敗後、programオーケストレーターによる復旧を待っています`;
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) throw new Error(`[program ${programId}] 復旧開始中に消えました`);
      return {
        ...current,
        recovery: { failedRunIds, deadline },
        changeHistory: this.appendProgramHistory(current, message),
      };
    });
    this.scheduleProgramRecoveryTimeout(programId, deadline);
    this.changeEmitter.fire(programId);
  }

  private scheduleProgramRecoveryTimeout(programId: string, deadline: string): void {
    if (this.recoveryTimers.has(programId)) return;
    const persisted = this.deps.programStore.find(programId);
    const heldRunIds = Object.values(persisted?.state.runs ?? {})
      .filter((entry) => entry.state === 'failed' && entry.runId !== undefined)
      .map((entry) => entry.runId as string);
    const remaining = Math.max(
      0,
      Date.parse(deadline) - (this.deps.now?.() ?? new Date()).getTime(),
    );
    const timer = setTimeout(() => {
      void this.finalizeProgramRecoveryTimeout(programId);
    }, remaining);
    timer.unref?.();
    this.recoveryTimers.set(programId, { timer, heldRunIds });
  }

  private async finalizeProgramRecoveryTimeout(programId: string): Promise<void> {
    await this.runExclusive(programId, async () => {
      const persisted = this.deps.programStore.find(programId);
      if (persisted?.recovery === undefined) return;
      const parsed = await this.resolveProgramDefinition(persisted);
      if (!parsed.ok) return;
      const state = propagateProgramFailures(parsed.def, persisted.state);
      await this.deps.programStore.update(programId, (current) => {
        if (current === undefined)
          throw new Error(`[program ${programId}] 復旧期限処理中に消えました`);
        return {
          ...current,
          state,
          recovery: undefined,
          changeHistory: this.appendProgramHistory(
            current,
            '10分以内に復旧計画が適用されなかったため、依存失敗を後続runへ最終伝播しました',
          ),
        };
      });
      const held = this.recoveryTimers.get(programId)?.heldRunIds ?? [];
      this.recoveryTimers.delete(programId);
      for (const runId of held) this.deps.workflow.endProgramRecovery?.(runId);
      await this.maybeMarkFinished(programId);
      this.changeEmitter.fire(programId);
    });
  }

  private async clearProgramRecovery(programId: string, message: string): Promise<void> {
    const recovery = this.recoveryTimers.get(programId);
    if (recovery !== undefined) clearTimeout(recovery.timer);
    this.recoveryTimers.delete(programId);
    await this.deps.programStore.update(programId, (current) => {
      if (current === undefined) throw new Error(`[program ${programId}] 復旧解除中に消えました`);
      return {
        ...current,
        recovery: undefined,
        changeHistory: this.appendProgramHistory(current, message),
      };
    });
    for (const runId of recovery?.heldRunIds ?? []) this.deps.workflow.endProgramRecovery?.(runId);
  }

  private appendProgramHistory(
    current: PersistedProgram,
    message: string,
  ): readonly { at: string; message: string }[] {
    return [
      ...(current.changeHistory ?? []),
      { at: (this.deps.now?.() ?? new Date()).toISOString(), message },
    ].slice(-50);
  }

  private buildProgramControl(programId: string): ProgramControlPort {
    const unavailable = (reason: string): OrchestratorControlResult => ({
      accepted: false,
      reason,
    });
    const accepted = (reason: string): OrchestratorControlResult => ({ accepted: true, reason });
    const update = async (
      change: (
        current: PersistedProgram,
        def: ProgramDefinition,
      ) =>
        | { def: ProgramDefinition; state: PersistedProgram['state']; message: string }
        | OrchestratorControlResult,
    ): Promise<OrchestratorControlResult> => {
      let result: OrchestratorControlResult = unavailable('programが見つかりません。');
      await this.runExclusive(programId, async () => {
        const current = this.deps.programStore.find(programId);
        if (current === undefined) return;
        const parsed = await this.resolveProgramDefinition(current);
        if (!parsed.ok) {
          result = unavailable(parsed.errors.map((error) => error.message).join(' / '));
          return;
        }
        const changed = change(current, parsed.def);
        if ('accepted' in changed) {
          result = changed;
          return;
        }
        const validation = validateProgram(changed.def);
        if (validation.errors.length > 0) {
          result = unavailable(validation.errors.map((error) => error.message).join(' / '));
          return;
        }
        await this.deps.programStore.update(programId, (latest) => {
          if (latest === undefined)
            throw new Error(`[program ${programId}] 計画変更中に消えました`);
          return {
            ...latest,
            definition: changed.def,
            state: changed.state,
            finishedAt: undefined,
            changeHistory: this.appendProgramHistory(latest, changed.message),
          };
        });
        result = accepted(changed.message);
        this.changeEmitter.fire(programId);
      });
      if (result.accepted) await this.pumpProgram(programId);
      return result;
    };
    return {
      getProgramStatus: () => {
        const current = this.deps.programStore.find(programId);
        return current === undefined
          ? { error: 'programが見つかりません。' }
          : {
              programId,
              definition: current.definition,
              state: current.state,
              recovery: current.recovery,
              changeHistory: current.changeHistory ?? [],
            };
      },
      addProgramRun: (input) =>
        update((current, def) => {
          const id = typeof input['id'] === 'string' ? input['id'] : '';
          const defPath = typeof input['defPath'] === 'string' ? input['defPath'] : '';
          const rawDeps = input['dependsOn'];
          const dependsOn = Array.isArray(rawDeps)
            ? rawDeps.filter((value): value is string => typeof value === 'string')
            : [];
          const run: ProgramRunRef = { id, defPath, dependsOn, parseErrors: [] };
          return {
            def: { ...def, runs: [...def.runs, run] },
            state: {
              ...current.state,
              runs: {
                ...current.state.runs,
                [id]: { state: 'pending', runId: undefined, skipReason: undefined },
              },
            },
            message: `run ${id} を追加しました（dependsOn: ${dependsOn.join(', ') || 'なし'}）`,
          };
        }),
      removeProgramRun: (runRefId) =>
        update((current, def) => {
          const entry = current.state.runs[runRefId];
          if (entry === undefined) return unavailable(`runが見つかりません: ${runRefId}`);
          if (entry.state === 'running' || entry.state === 'done') {
            return unavailable(`${runRefId} は${entry.state}のため削除できません。`);
          }
          const runs = { ...current.state.runs };
          delete runs[runRefId];
          return {
            def: {
              ...def,
              runs: def.runs
                .filter((run) => run.id !== runRefId)
                .map((run) => ({
                  ...run,
                  dependsOn: run.dependsOn.filter((id) => id !== runRefId),
                })),
            },
            state: { ...current.state, runs },
            message: `run ${runRefId} を削除し、参照する依存を取り除きました`,
          };
        }),
      retryProgramRun: (runRefId) =>
        update((current, def) => {
          const entry = current.state.runs[runRefId];
          if (entry?.state !== 'failed' && entry?.state !== 'skipped') {
            return unavailable(`${runRefId} は再試行できる状態ではありません。`);
          }
          return {
            def,
            state: {
              ...current.state,
              runs: {
                ...current.state.runs,
                [runRefId]: { state: 'pending', runId: undefined, skipReason: undefined },
              },
            },
            message: `run ${runRefId} をpendingへ戻して再試行します`,
          };
        }),
      updateProgramRunDependencies: (runRefId, dependsOn) =>
        update((current, def) => {
          const entry = current.state.runs[runRefId];
          if (entry?.state !== 'pending') {
            return unavailable(`${runRefId} はpendingではないため依存を変更できません。`);
          }
          const unique = [...new Set(dependsOn)];
          return {
            def: {
              ...def,
              runs: def.runs.map((run) =>
                run.id === runRefId ? { ...run, dependsOn: unique } : run,
              ),
            },
            state: current.state,
            message: `run ${runRefId} のdependsOnを ${unique.join(', ') || 'なし'} へ変更しました`,
          };
        }),
    };
  }

  private async parseAndValidateProgram(defPath: string): Promise<ParsedProgram> {
    const size = await this.deps.filePort.fileSize(defPath);
    if (size === undefined) {
      return {
        ok: false,
        errors: [{ runIds: [], message: `定義ファイルを読み込めません: ${defPath}` }],
      };
    }
    if (size > MAX_WORKFLOW_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          {
            runIds: [],
            message: `定義ファイルが大きすぎます（上限${MAX_WORKFLOW_FILE_BYTES}バイト）: ${size}バイト`,
          },
        ],
      };
    }
    const text = await this.deps.filePort.readTextFile(defPath);
    if (text === undefined) {
      return {
        ok: false,
        errors: [{ runIds: [], message: `定義ファイルを読み込めません: ${defPath}` }],
      };
    }
    let def: ProgramDefinition;
    try {
      def = parseProgramYaml(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        errors: [{ runIds: [], message: `YAMLの解析に失敗しました: ${message}` }],
      };
    }
    const validation = validateProgram(def);
    for (const w of validation.warnings) {
      this.deps.log.warn(`[program] ${w.message}`);
    }
    if (validation.errors.length > 0) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, def };
  }
}
