import type { IntegrationMergeQueue } from './integration';
import type {
  LiveRun,
  LiveRunForgeState,
  LiveTask,
  WorkflowRunnerDeps,
} from './runner';
import type { WorkflowTask } from './workflow';

/**
 * `WorkflowRunner`を機能単位で分割したモジュール（`runnerSnapshot.ts`等、Issue #147）だけが
 * 触る内部の口（PR #157のレビュー指摘への対応）。
 *
 * 分割にあたって`runs`・`integrationQueue`・`notify`・`pump`・`persist`・
 * `resolveForgeState`の`private`を一括で外していたが、それでは`src/view/`や
 * `extension.ts`からも内部の可変状態と状態遷移の入口へ到達でき、
 * `runner.runs.get(id)!.runState = ...`や`runner.pump(id)`を直接書いても型検査が止められない。
 * `persist()`・`notify()`を経ずに書き換えると、永続化した値とメモリ上の`LiveRun`が
 * 食い違う。
 *
 * そこで公開範囲をこのインターフェースへ閉じ、`WorkflowRunner`側のメンバは`private`へ戻す。
 * 分割モジュールは`self: WorkflowRunnerInternals`として受け取り、`WorkflowRunner`は
 * コンストラクタで組み立てた`internals`（`runner.ts`）でのみ自身の内部を渡す。
 *
 * `this as unknown as WorkflowRunnerInternals`のキャストでは済ませない。キャストは
 * 構造的部分型の検査ごと無効にするため、このインターフェースとクラス側がずれても
 * `tsc`が検出できず、実行時に`self.pump is not a function`のような形で初めて表面化する。
 */
export interface WorkflowRunnerInternals {
  readonly deps: WorkflowRunnerDeps;
  readonly runs: Map<string, LiveRun>;
  readonly integrationQueue: IntegrationMergeQueue;
  notify(runId: string): void;
  pump(runId: string): void;
  persist(runId: string): Promise<void>;
  resolveForgeState(repoRoot: string): Promise<LiveRunForgeState>;
  /**
   * worktreeの撤去（`runnerMerge.ts`の同名関数のラッパー）。
   *
   * テストが`WorkflowRunner.prototype`をスパイして「interrupted/manualでは撤去しない」を
   * 確かめるため、モジュール関数を直接呼ばずここを通す。分割時にマージ成功経路と
   * 衝突解決完了経路がラッパーを迂回していたのを戻したもの（PR #157のレビュー指摘）。
   */
  cleanupWorktreeIfNeeded(
    live: LiveRun,
    task: WorkflowTask,
    taskId: string,
    liveTask: LiveTask | undefined,
  ): void;
}
