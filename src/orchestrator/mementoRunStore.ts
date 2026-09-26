import type { MementoLike } from '../util/memento';
import { SerialQueue } from './serialQueue';

/**
 * 実行（run）の状態を`workspaceState`の1つのキーへ配列で保存する骨組み。ロードマップ実行
 * （Issue #1465、`roadmapRunStore.ts`）とオーケストレータモード（Issue #1505）が共通で使う。
 *
 * 読み書きを1本のキューに通して直列化し、read-modify-writeの間に別の更新が割り込まない
 * ようにする。保存する件数は開始時刻の新しい順に上限まで残す。読み込み時は`isValid`で
 * 骨格を確かめ、版の合わない（将来の形式や壊れた）要素を読み飛ばす。
 */

export interface StoredRun {
  runId: string;
  /** ISO 8601。新しい順に並べて上限を超えた分を捨てるのに使う。 */
  startedAt: string;
}

export interface MementoRunStoreOptions<T extends StoredRun> {
  key: string;
  /** 走り終えたrunも含めて残す最大件数。 */
  maxStored: number;
  /** 遷移関数が前提にする骨格を持つか。持たない要素は読み飛ばす。 */
  isValid(value: unknown): value is T;
}

export class MementoRunStore<T extends StoredRun> {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly memento: MementoLike,
    private readonly options: MementoRunStoreOptions<T>,
  ) {}

  list(): readonly T[] {
    const raw = this.memento.get<unknown>(this.options.key, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((r): r is T => this.options.isValid(r));
  }

  find(runId: string): T | undefined {
    return this.list().find((r) => r.runId === runId);
  }

  /**
   * 指定runIdの内容を関数で更新する。直列化されるため、読み・書きの間に別の更新が
   * 割り込まない。未登録なら新規追加する。更新後の値を返す。
   */
  update(runId: string, updater: (current: T | undefined) => T): Promise<T> {
    return this.queue.enqueue(async () => {
      const all = this.list();
      const index = all.findIndex((r) => r.runId === runId);
      const current = index === -1 ? undefined : all[index];
      const next = updater(current);
      if (next === current) {
        return next;
      }
      const merged = index === -1 ? [next, ...all] : all.map((r, i) => (i === index ? next : r));
      await this.memento.update(this.options.key, this.trim(merged));
      return next;
    });
  }

  clearAll(): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.memento.update(this.options.key, []);
    });
  }

  private trim(runs: readonly T[]): T[] {
    return [...runs]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, this.options.maxStored);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
