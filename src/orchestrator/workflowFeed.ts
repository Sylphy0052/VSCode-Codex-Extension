/**
 * ワークフローViewが読む唯一のイベント・スナップショットの口（design.md §16.8、Issue #1272）。
 *
 * 通知は`WorkflowChange`（`{ kind: 'run' }`）の1本にする。スナップショットは
 * `WorkflowFeedSnapshot`の1つだけにし、run一覧・表示中のrunを**同じ呼び出しの中で**読む
 * （Viewが複数の入口を突き合わせない）。
 *
 * 純粋関数の置き場の使い分け: 表示のための整形（文字列の組み立て・レイアウト・集計）は
 * `view/workflowGraph.ts`へ、実行状態の突き合わせはこちらへ置く。後者はVSCodeにも
 * Webviewにも依存しないオーケストレーター層の関心事である。
 *
 * 複数runを束ねる「プログラム」機能はIssue #1679で削除した（状態の組み合わせを
 * 減らすため）。履歴はgit（削除前のこのファイル・`programStore.ts`等）に残る。
 */

import type { LiveRunSummary, WorkflowRunSnapshot } from './runner';
import { SimpleEmitter } from './runner';

/** 単発runの変化を表す通知。 */
export type WorkflowChange = { kind: 'run'; runId: string };

/** run一覧の1件。 */
export type FeedRunSummary = LiveRunSummary;

/** Viewが1回の呼び出しで読む、その時点の全状態。 */
export interface WorkflowFeedSnapshot {
  /** このウィンドウで生きているrunの一覧。 */
  runs: readonly FeedRunSummary[];
  /** 表示中のrunの詳細。`activeRunId`が未指定・そのrunが無ければ`undefined`。 */
  activeRun: WorkflowRunSnapshot | undefined;
}

/** `WorkflowFeed`が`WorkflowRunner`へ要求する最小限の口。`WorkflowRunner`は構造的にこれを満たす。 */
export interface WorkflowFeedRunnerPort {
  listLive(): readonly LiveRunSummary[];
  getSnapshot(runId: string): WorkflowRunSnapshot | undefined;
  onChanged(listener: (runId: string) => void): () => void;
}

export interface WorkflowFeed {
  /** 単発runの変化がこの1本で届く。戻り値は購読解除の関数。 */
  onChanged(listener: (change: WorkflowChange) => void): () => void;
  /** その時点の全状態を1つのスナップショットとして読む。 */
  getSnapshot(activeRunId: string | undefined): WorkflowFeedSnapshot;
  /** 購読を解除する。 */
  dispose(): void;
}

/**
 * `WorkflowRunner`からの通知・スナップショットをfeedの形にまとめる。
 */
export function createWorkflowFeed(deps: { runner: WorkflowFeedRunnerPort }): WorkflowFeed {
  const emitter = new SimpleEmitter<WorkflowChange>();
  const unsubscribeRun = deps.runner.onChanged((runId) => emitter.fire({ kind: 'run', runId }));
  return {
    onChanged: (listener) => emitter.on(listener),
    getSnapshot: (activeRunId) => ({
      runs: deps.runner.listLive(),
      activeRun: activeRunId === undefined ? undefined : deps.runner.getSnapshot(activeRunId),
    }),
    dispose: () => {
      unsubscribeRun();
    },
  };
}
