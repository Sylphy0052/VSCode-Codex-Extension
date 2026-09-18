/**
 * ワークフローViewが読む唯一のイベント・スナップショットの口（design.md §16.8、Issue #1272）。
 *
 * これまでViewは`WorkflowRunner.onChanged(runId)`と`ProgramRunner.onChanged(programId)`の
 * 2つを購読し、`WorkflowRunner.getSnapshot(runId)` / `ProgramStore.list()`という別々の
 * スナップショットを自前で組み合わせて描いていた。同じ実行について入口が2つあるため、
 * 片方だけ更新された瞬間の状態を描いてしまう余地が残っていた。
 *
 * ここでその2つを1本にまとめる。
 *
 * - 通知は`WorkflowChange`（`{ kind: 'run' }` / `{ kind: 'program' }`）の1本だけにする
 * - スナップショットは`WorkflowFeedSnapshot`の1つだけにし、run一覧・プログラム一覧・
 *   表示中のrunを**同じ呼び出しの中で**読む（Viewが2種類のデータを突き合わせない）
 *
 * 純粋関数の置き場の使い分け: 表示のための整形（文字列の組み立て・レイアウト・集計）は
 * `view/workflowGraph.ts`へ、実行状態どうしの突き合わせ（`buildFeedRuns`）はこちらへ置く。
 * 後者はVSCodeにもWebviewにも依存しないオーケストレーター層の関心事である。
 *
 * **発火の順序は変えない。** `ProgramRunner.onChanged`は「対象プログラムの状態を
 * `programStore`へ永続化し終えた後にだけ発火する」（`programRunner.ts`の`changeEmitter`の
 * JSDoc、design.md §16.37.3のレビュー指摘F1）。このモジュールは受け取った通知を
 * そのまま転送するだけで、発火のタイミングには一切関与しない。
 */

import type { PersistedProgram } from './programStore';
import type { LiveRunSummary, WorkflowRunSnapshot } from './runner';
import { SimpleEmitter } from './runner';

/**
 * ワークフロー層（単発run）とプログラム層（runを束ねるプログラム）の変化を1つに
 * まとめた通知。「何が変わったか」を判別できる形にしてある。
 */
export type WorkflowChange =
  { kind: 'run'; runId: string } | { kind: 'program'; programId: string };

/**
 * run一覧の1件。`LiveRunSummary`に「どのプログラムに属すか」を足したもの。
 *
 * プログラムに属さない単発runは`programId`/`programRunRefId`が`undefined`で、
 * プログラムのrunと同じ配列に並べる（別の一覧には分けない）。どちらも同じ`runId`で
 * 表示・操作できるため、Viewから見た扱いは変わらない。
 */
export interface FeedRunSummary extends LiveRunSummary {
  /** 属するプログラムのid。単発runでは`undefined`。 */
  programId: string | undefined;
  /** プログラム定義内でのrun参照名（`ProgramRunRef.id`）。単発runでは`undefined`。 */
  programRunRefId: string | undefined;
}

/** Viewが1回の呼び出しで読む、その時点の全状態。 */
export interface WorkflowFeedSnapshot {
  /** このウィンドウで生きているrunの一覧（プログラム所属の情報付き）。 */
  runs: readonly FeedRunSummary[];
  /** 永続化済みのプログラム一覧。プログラム層を配線していなければ空。 */
  programs: readonly PersistedProgram[];
  /** 表示中のrunの詳細。`activeRunId`が未指定・そのrunが無ければ`undefined`。 */
  activeRun: WorkflowRunSnapshot | undefined;
}

/** `WorkflowFeed`が`WorkflowRunner`へ要求する最小限の口。`WorkflowRunner`は構造的にこれを満たす。 */
export interface WorkflowFeedRunnerPort {
  listLive(): readonly LiveRunSummary[];
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined;
  onChanged(listener: (runId: string) => void): () => void;
}

/**
 * `WorkflowFeed`がプログラム層へ要求する最小限の口（design.md §16.37.3、Issue #606）。
 * `extension.ts`が`ProgramStore`/`ProgramRunner`から組み立てて渡す。
 *
 * **省略可能。** 渡さない場合はプログラムに関する表示・操作を一切行わない
 * （スナップショットの`programs`が常に空になる）。
 */
export interface WorkflowFeedProgramPort {
  /** 永続化済みの全プログラムを新しい順に返す。`ProgramStore.list()`と同じ契約。 */
  list(): readonly PersistedProgram[];
  /** 指定プログラムを人の手で止める。`ProgramRunner.haltProgram`と同じ契約。 */
  halt(programId: string): Promise<void>;
  /**
   * プログラムの状態が永続化された後に発火する。`ProgramRunner.onChanged`と同じ契約
   * （design.md §16.37.3のレビュー指摘F1、Issue #606）。
   */
  onChanged(listener: (programId: string) => void): () => void;
}

export interface WorkflowFeed {
  /** 単発run・プログラムのどちらの変化もこの1本で届く。戻り値は購読解除の関数。 */
  onChanged(listener: (change: WorkflowChange) => void): () => void;
  /** その時点の全状態を1つのスナップショットとして読む。 */
  getSnapshot(activeRunId: string | undefined): WorkflowFeedSnapshot;
  /** プログラムを人の手で止める。プログラム層が未配線なら何もしない。 */
  haltProgram(programId: string): Promise<void>;
  /** 元の2つの購読を解除する。 */
  dispose(): void;
}

/**
 * run一覧へプログラム所属を付ける（純粋関数）。
 *
 * 突き合わせの規則はここ1箇所に閉じる。同じ`runId`が複数のプログラムから参照されることは
 * 無い（`ProgramRunner`が起動したrunを1つのプログラムのエントリへ記録する）が、万一
 * 重複した場合は先に見つかったプログラムを採る。
 */
export function buildFeedRuns(
  runs: readonly LiveRunSummary[],
  programs: readonly PersistedProgram[],
): readonly FeedRunSummary[] {
  const owner = new Map<string, { programId: string; runRefId: string }>();
  for (const program of programs) {
    // `state.runs`は`Record`（`ProgramState`のJSDoc参照）。永続化を経た値なので、
    // 想定外の形が入っていても`Object.entries`で投げないよう先に確かめる。ここは
    // 変化通知のリスナから同期で呼ばれるため、投げると発火元の処理まで巻き込む
    const runs: unknown = program.state.runs;
    if (typeof runs !== 'object' || runs === null || Array.isArray(runs)) {
      continue;
    }
    for (const [runRefId, entry] of Object.entries(program.state.runs)) {
      if (entry.runId === undefined || owner.has(entry.runId)) {
        continue;
      }
      owner.set(entry.runId, { programId: program.programId, runRefId });
    }
  }
  return runs.map((run) => {
    const found = owner.get(run.runId);
    return {
      ...run,
      programId: found?.programId,
      programRunRefId: found?.runRefId,
    };
  });
}

/**
 * 2つの層の通知・スナップショットを1本にまとめたfeedを作る。
 *
 * `programs`を省略した場合でも、単発runの通知とスナップショットはそのまま流れる
 * （既存の単発runの挙動は変わらない）。
 */
export function createWorkflowFeed(deps: {
  runner: WorkflowFeedRunnerPort;
  programs?: WorkflowFeedProgramPort;
}): WorkflowFeed {
  const emitter = new SimpleEmitter<WorkflowChange>();
  const unsubscribeRun = deps.runner.onChanged((runId) => emitter.fire({ kind: 'run', runId }));
  const unsubscribePrograms = deps.programs?.onChanged((programId) =>
    emitter.fire({ kind: 'program', programId }),
  );
  return {
    onChanged: (listener) => emitter.on(listener),
    getSnapshot: (activeRunId) => {
      const programs = deps.programs?.list() ?? [];
      return {
        runs: buildFeedRuns(deps.runner.listLive(), programs),
        programs,
        activeRun: activeRunId === undefined ? undefined : deps.runner.getSnapshot(activeRunId),
      };
    },
    haltProgram: async (programId) => {
      await deps.programs?.halt(programId);
    },
    dispose: () => {
      unsubscribeRun();
      unsubscribePrograms?.();
    },
  };
}
