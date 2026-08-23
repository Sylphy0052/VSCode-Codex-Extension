import { reconcileProgramStateOnReload, type ProgramState } from './programState';
import type { MementoLike } from '../util/memento';
import { SerialQueue } from './serialQueue';

/**
 * プログラム実行状態の永続化と復元（design.md §16.37、roadmap W12-1、Issue #604）。
 *
 * `runStore.ts`の`WorkflowRunStore`と対になる、プログラム単位の同じ役割の層。
 * `workspaceState`は暗号化されない平文ストレージのため、`runStore.ts`と同じく
 * **応答本文に相当するものは持たない**（プログラムは定義ファイルへのパスと状態しか
 * 持たないため、そもそも該当する値が無い）。
 */

/** `vscode.Memento`と構造的に一致する最小限の口。`runStore.ts`の`WorkflowRunMemento`と同型。 */
export type ProgramMemento = MementoLike;

export const PROGRAM_RUNS_KEY = 'codex.workflow.programs';

/** 走り終えたプログラムも含めて残す最大件数。`runStore.ts`の`MAX_STORED_RUNS`と同じ考え方。 */
export const MAX_STORED_PROGRAMS = 10;

export interface PersistedProgram {
  programId: string;
  /** プログラム定義ファイルの絶対パス。 */
  defPath: string;
  /** ワークスペースフォルダの絶対パス。`runStore.ts`の`PersistedRun.workspaceRoot`と同じ意味。 */
  workspaceRoot: string;
  /** ISO8601。 */
  startedAt: string;
  /**
   * 実行中は undefined。終了判定が付いた時点で埋める。`programRunner.ts`の
   * `isProgramSettled`（全runが`done`/`failed`/`skipped`のいずれか）が真になった時点で
   * `ProgramRunner`が埋める（roadmap W12-2・W12-3、Issue #605・#606）。`pending`・
   * `running`が1件でも残っていれば埋まらない。前段の`failed`に依存して未着手のまま
   * だった`pending`は、失敗の伝播（`programScheduler.ts`の`propagateProgramFailures`）
   * が`skipped`（終端状態）へ確定させるため、`pending`のまま無期限に「実行中」扱いが
   * 残ることは無くなった（W12-2時点の挙動からの変更）。
   */
  finishedAt: string | undefined;
  state: ProgramState;
}

function trimPrograms(programs: readonly PersistedProgram[]): PersistedProgram[] {
  return [...programs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_STORED_PROGRAMS);
}

/**
 * `reconcileProgramStateOnReload`をrun全体へ適用する。`runStore.ts`の
 * `reconcileRunOnReload`のプログラム版。
 */
export function reconcileProgramOnReload(program: PersistedProgram): PersistedProgram {
  const state = reconcileProgramStateOnReload(program.state);
  if (state === program.state) {
    return program;
  }
  // finishedAtは変えない。あるrunがrunningからfailedへ倒れただけでプログラム全体が
  // 終わったとは言えない。この関数（`reconcileProgramStateOnReload`）自身は失敗の伝播
  // （前段の`failed`が確定した後続`pending`を`skipped`にする）を行わない
  // （`programState.ts`の`reconcileProgramStateOnReload`のJSDoc参照）。伝播と
  // `finishedAt`の確定は、この直後に呼ばれる`ProgramRunner.reconcileAfterReload`
  // （`pumpProgram`経由、roadmap W12-3、Issue #606）が担う
  return { ...program, state };
}

/**
 * `workspaceState`への読み書きを1本のキューに通して直列化する。`runStore.ts`の
 * `WorkflowRunStore`と同じ理由・同じ`SerialQueue`を使う（Issue #146）。
 */
export class ProgramStore {
  private readonly queue = new SerialQueue();

  constructor(private readonly memento: ProgramMemento) {}

  list(): readonly PersistedProgram[] {
    return this.memento.get<PersistedProgram[]>(PROGRAM_RUNS_KEY, []);
  }

  find(programId: string): PersistedProgram | undefined {
    return this.list().find((p) => p.programId === programId);
  }

  /**
   * 指定programIdの内容を関数で更新する。直列化されるため、並行呼び出しでも
   * 読み・書きの間に別の更新が割り込まない。programIdが未登録なら新規追加する。
   */
  update(
    programId: string,
    updater: (current: PersistedProgram | undefined) => PersistedProgram,
  ): Promise<void> {
    return this.enqueue(async () => {
      const all = this.list();
      const index = all.findIndex((p) => p.programId === programId);
      const current = index === -1 ? undefined : all[index];
      const next = updater(current);
      const merged = index === -1 ? [next, ...all] : all.map((p, i) => (i === index ? next : p));
      await this.memento.update(PROGRAM_RUNS_KEY, trimPrograms(merged));
    });
  }

  /**
   * リロード直後に呼ぶ。全プログラムの`running`なrun参照を中断扱いへ書き換える
   * （`reconcileProgramOnReload`）。変化が無いプログラムは書き込まない。
   *
   * `WorkflowRunStore.reconcileAfterReload`と同じタイミングで呼ぶことで、プログラムの
   * 永続化状態を中断からの自動再開（design.md §16.35、roadmap W10）の対象に含める。
   * ここが担うのは状態を書き戻すところまで。実際の再開（続きの波の起動）は、この
   * メソッドが返した`reconciled`を使って`extension.ts`が`ProgramRunner.pumpProgram`を
   * 呼ぶ側の責務（`programRunner.ts`、roadmap W12-2、Issue #605）。
   */
  reconcileAfterReload(): Promise<readonly PersistedProgram[]> {
    return this.enqueue(async () => {
      const all = this.list();
      const reconciled = all.map(reconcileProgramOnReload);
      const anyChanged = reconciled.some((p, i) => p !== all[i]);
      if (anyChanged) {
        await this.memento.update(PROGRAM_RUNS_KEY, trimPrograms(reconciled));
      }
      return reconciled;
    });
  }

  /** 手動で全消去する（`runStore.ts`の`clearAll`と同じ）。 */
  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.memento.update(PROGRAM_RUNS_KEY, []);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(task);
  }
}
