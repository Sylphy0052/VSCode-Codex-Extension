/**
 * `thread/start` の応答待ちを複数同時に保持する（design.md §16.10「開始待ちの管理を
 * 複数件に対応させる」）。
 *
 * 従来の `ChatViewManager` は開始待ちの画面を `pending: ChatPanel | undefined` という
 * 単一の値で持っていた。並列で2つ以上のCodexスレッドを開始すると、後から開始した
 * 画面が `pending` を上書きし、まだthreadIdの判らない先発の画面宛の通知・承認要求が
 * 後発の画面へ誤配送される（承認の誤配送は「別タスクの操作を勝手に許可する」事故になる）。
 *
 * ここでは「最後の1件」を決め打ちで返す代わりに、開始待ちの全エントリを保持し、
 * 通知・要求に含まれるthreadIdと**各エントリが実際に記録しているthreadId**（
 * `resolveThreadId` で読む）を突き合わせて宛先を探す。まだどのエントリもそのthreadIdを
 * 記録していない場合は「宛先不明」として `undefined` を返す。past
 * （`panels`に正しく登録される前の）取り違えを許すより、誤配送を避けて安全側に倒す
 * ほうが、このモジュールが対処すべき脅威（承認の誤配送）に対して正しい。
 */
export class PendingStartRegistry<T> {
  private readonly entries = new Map<string, T>();
  private nextKey = 0;

  /** 開始待ちを1件登録する。返した鍵で `end` に渡すこと。 */
  begin(entry: T): string {
    const key = `pending:${this.nextKey}`;
    this.nextKey += 1;
    this.entries.set(key, entry);
    return key;
  }

  /** threadIdが判った（またはエラーで打ち切った）ときに呼ぶ。 */
  end(key: string): void {
    this.entries.delete(key);
  }

  /** 現在の開始待ち全件。全画面ブロードキャストや破棄処理の走査に使う。 */
  values(): T[] {
    return [...this.entries.values()];
  }

  /**
   * `resolveThreadId(entry)` が `threadId` と一致するエントリを探す。
   * 一致するものが無ければ `undefined`（宛先不明。誤って別エントリへ渡さない）。
   */
  findByThreadId(
    threadId: string,
    resolveThreadId: (entry: T) => string | undefined,
  ): T | undefined {
    for (const entry of this.entries.values()) {
      if (resolveThreadId(entry) === threadId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * 開始待ちがちょうど1件のときだけ、それを返す。
   *
   * `thread/start` の応答が返る前にも、そのスレッド宛の通知は届く（従来の実装が
   * 単一の `pending` へ流していたのはこのため）。応答前のエントリはまだthreadIdを
   * 記録していないので `findByThreadId` では拾えず、そのまま捨てると開始直後の
   * 通知を取りこぼす。
   *
   * 開始待ちが1件しか無いなら宛先は一意に定まるので、取り違えようがない。
   * 2件以上あるときに限って諦める（誤配送を避けるほうが、取りこぼしより重い）。
   */
  soleEntry(): T | undefined {
    return this.entries.size === 1 ? this.entries.values().next().value : undefined;
  }

  /** 該当エントリを鍵によらず取り除く（破棄処理でどの鍵だったか追わなくて済むように）。 */
  remove(entry: T): void {
    for (const [key, value] of this.entries) {
      if (value === entry) {
        this.entries.delete(key);
      }
    }
  }
}
