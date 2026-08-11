/**
 * 条件を満たすまで指定間隔でポーリングする。
 *
 * ファイル監視のようにイベントの到達までに時間差があるものを、固定sleepではなく
 * 「満たすまで待つ、ただし上限あり」で確認するための小さなヘルパー。
 */
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: ${timeoutMs}ms待っても条件を満たさなかった`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
