/**
 * 非同期タスクを1本の待ち行列で直列化する汎用クラス。
 *
 * 導入理由はモジュールごとに異なるが（design.mdの複数箇所で必要になっている）、
 * 「直列化そのものの実装」はどれも同じで良い。以前はバイト単位まで同一の実装が
 * 3クラスへ複製されていた（Issue #146）。
 *
 * - `worktree.ts` の `WorktreeCreationQueue`: `git worktree add` / `git worktree remove` の
 *   `index.lock` 競合対策（design.md §16.6）
 * - `runStore.ts` の `WorkflowRunStore`: `workspaceState` への読み書きが並行すると起きる
 *   lost update対策（design.md §16.11）
 * - `pseudoWorktree.ts` の `IntegrationQueue`: 統合先マニフェストの
 *   read-modify-write競合対策（design.md §16.20）
 *
 * この3クラスは、それぞれ内部にこのクラスのインスタンスを1つ持ち、`enqueue` へ委譲する。
 * このクラス自体は直列化の仕組みだけを持ち、「何を・なぜ直列化するか」というドメイン知識は
 * 一切持たない（各利用箇所のコメントに残す）。
 */
export class SerialQueue {
  /**
   * 「前の項目までの実行が終わったこと」だけを表す継続用Promise。成功・失敗の結果自体は
   * ここに残さない（`enqueue` の戻り値としてそれぞれの呼び出し元へ個別に返す）。
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * `task` をキューへ積み、前の項目が終わり次第実行する。
   *
   * **`this.tail.then(task, task)` という書き方が肝。** 前の項目が成功・失敗の
   * どちらで終わっても次の `task` を走らせる。ここを `this.tail.then(task)`
   * （第2引数を省略した形）にすると、前の項目が失敗した時点で `this.tail` が
   * rejectされたPromiseになり、以後の `enqueue` が呼び出す `.then` の**成功時**
   * コールバックしか登録していないため次の `task` が呼ばれず、キュー全体が
   * 静かに止まってしまう。
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
