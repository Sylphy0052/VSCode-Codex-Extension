/**
 * 同時実行数に上限を設けて`fn`を並列実行する。
 *
 * `Promise.all`は要素数分のPromiseを無制限に同時発火するため、件数が数千規模になると
 * 望ましくない（issue #382のレビュー指摘）。ここでは`limit`件までのワーカーを起動し、
 * 各ワーカーが完了次第次の要素を取りにいく方式で同時実行数を頭打ちにする。
 *
 * 戻り値の配列は`items`の入力順を保つ（各ワーカーが担当indexへ結果を書き込むため、
 * 完了順ではなく入力順で揃う）。
 *
 * `limit`が0以下のときは1として扱う（逐次実行）。空配列のときは空配列を返す。
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index] as T, index);
    }
  };

  const workers = Array.from({ length: effectiveLimit }, () => worker());
  await Promise.all(workers);

  return results;
}
