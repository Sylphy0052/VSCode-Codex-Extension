import { describe, expect, it } from 'vitest';
import { mapWithLimit } from '../../src/util/concurrency';

/** resolveまでの遅延をずらして並行実行の余地を作るためのヘルパー。 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithLimit', () => {
  it('入力順を保って結果を返す（完了順が入れ替わっても）', async () => {
    const order = [30, 10, 20, 0];

    const results = await mapWithLimit(order, 4, async (delayMs, index) => {
      await delay(delayMs);
      return index;
    });

    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('同時実行数が上限を超えない', async () => {
    let current = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithLimit(items, 3, async (item) => {
      current++;
      peak = Math.max(peak, current);
      await delay(5);
      current--;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('要素が0件のとき空配列を返し、fnは呼ばれない', async () => {
    let called = false;

    const results = await mapWithLimit([] as number[], 5, async (item) => {
      called = true;
      return item;
    });

    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('limitが0以下のときは1として扱い、逐次実行する', async () => {
    let current = 0;
    let peak = 0;
    const items = [1, 2, 3];

    await mapWithLimit(items, 0, async (item) => {
      current++;
      peak = Math.max(peak, current);
      await delay(1);
      current--;
      return item;
    });

    expect(peak).toBe(1);
  });

  it('いずれかが失敗すると全体がrejectされる', async () => {
    const items = [1, 2, 3, 4, 5];

    await expect(
      mapWithLimit(items, 2, async (item) => {
        if (item === 3) {
          throw new Error('boom');
        }
        await delay(1);
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});
