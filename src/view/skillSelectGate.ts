/**
 * skill選択（issue #1451）で、人の発言を1件ずつ順に送るための関門。
 *
 * 判定には数秒〜十数秒かかる。その間に次の発言が来ても追い越させないよう、発言ごとの
 * 「判定して送る」処理を前の処理が終わってから走らせる。取り消し（停止ボタン・タブを閉じる）
 * では、判定中・待機中の処理へまとめて中止を伝える。
 */
export class SkillSelectGate {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private aborted: string[] = [];

  /** 判定中・待機中の処理があるか。 */
  get busy(): boolean {
    return this.controllers.size > 0;
  }

  /**
   * 前の処理が終わってから`task`を走らせる。`task`は`signal`が中止されたら結果を捨てること。
   * 例外はそのまま呼び出し側へ返すが、次の処理は止めない。
   */
  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const result = this.tail.then(() => task(controller.signal));
    const done = result.finally(() => {
      this.controllers.delete(controller);
    });
    this.tail = done.catch(() => undefined);
    return done;
  }

  /** 判定中・待機中の処理をすべて中止する。 */
  abortAll(): void {
    this.aborted = [];
    for (const controller of this.controllers) {
      controller.abort();
    }
  }

  /**
   * 中止で送らなかった本文を覚え、同じ中止で戻す本文をまとめて返す。入力欄への書き戻しは
   * 上書きのため、待機中の発言が複数あっても最後の1件だけが残らないようにする。
   */
  collectAborted(text: string): string {
    this.aborted = [...this.aborted, text];
    return this.aborted.join('\n\n');
  }
}
