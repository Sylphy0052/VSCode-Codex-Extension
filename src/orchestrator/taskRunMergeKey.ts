import { MergeLanes } from './mergeLanes';

/**
 * オーケストレータモード（Issue #1505）のmergeの鍵。「mergeとcleanup」の工程はLLMのセッションが
 * mergeするため、鍵はセッションが動いている間ずっと持ち、セッションの終了・停止・失敗で放す。
 * 同じリポジトリで並行するmergeが同じ版番号へ上げるのを防ぐため。
 *
 * 列そのものは`MergeLanes`で、渡せばロードマップ実行（`roadmapMergeQueue.ts`）と列を共有できる。
 * ただし`isBusy`が数えるのはこのインスタンスで取った鍵だけで、共有しても相手の保持は見えない
 * （mergeそのものは列で直列になるので、相手の保持中に選んだ工程は鍵の順番を待つ）。
 * 鍵はメモリ上にだけあり、ウィンドウの再読み込みで失われる。
 */

export interface MergeKeyLease {
  /** 鍵を放す。2回目以降は何もしない。 */
  release(): void;
}

export class TaskRunMergeKeys {
  /** リポジトリごとの、鍵を待っている・持っている数。 */
  private readonly holders = new Map<string, number>();

  constructor(private readonly lanes: MergeLanes = new MergeLanes()) {}

  /** 鍵を誰かが持っているか待っている。スケジューラはこの間、次の「mergeとcleanup」を選ばない。 */
  isBusy(laneKey: string): boolean {
    return (this.holders.get(laneKey) ?? 0) > 0;
  }

  /**
   * `laneKey`（リポジトリ）の鍵を取る。順番が来たら鍵を返す。同じ`itemKey`が鍵を待っている・
   * 持っているなら`undefined`を返す。
   */
  acquire(laneKey: string, itemKey: string): Promise<MergeKeyLease> | undefined {
    let releaseHeld = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let grant = (_lease: MergeKeyLease): void => {};
    const granted = new Promise<MergeKeyLease>((resolve) => {
      grant = resolve;
    });
    const queued = this.lanes.enqueue(laneKey, itemKey, async () => {
      grant({ release: releaseHeld });
      await held;
    });
    if (queued === undefined) {
      return undefined;
    }
    this.holders.set(laneKey, (this.holders.get(laneKey) ?? 0) + 1);
    void queued.finally(() => {
      const count = (this.holders.get(laneKey) ?? 1) - 1;
      if (count <= 0) {
        this.holders.delete(laneKey);
      } else {
        this.holders.set(laneKey, count);
      }
    });
    return granted;
  }
}
