import * as fs from 'node:fs';

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

/**
 * ファイルの内容が条件を満たすまで待ち、その内容を返す。
 *
 * `fs.existsSync` で存在だけを待ってから `readFileSync` で内容を検証すると、
 * ファイルが作られてから書き込みが終わるまでの間に読んでしまい、空または途中の
 * 内容が返る。この窓は負荷が高いほど広がる（Issue #541 の実測では、統合テストを
 * 6並列で18回走らせて2回、`''` を読んで L-40 が落ちた）。
 *
 * design.md §16.25 の一般則「発現するタイミングまで進めてから観測する」を、待ち側から
 * 言い直すと「観測したい状態そのものを待つ。その手前の状態で代用しない」になる。
 * 存在は「手前の状態」であり、検証したいのは内容である。
 *
 * 失敗時は最後に読めた内容をメッセージへ含める。空だったのか、別の内容だったのか、
 * そもそもファイルが無かったのかで原因が変わるため。
 */
export async function waitForFileContent(
  filePath: string,
  predicate: (content: string) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  let last: string | undefined;
  const read = (): string | undefined => {
    try {
      last = fs.readFileSync(filePath, 'utf8');
    } catch {
      last = undefined;
    }
    return last;
  };

  let value: string | undefined;
  try {
    value = await waitFor(read, (content) => content !== undefined && predicate(content), options);
  } catch (e) {
    throw new Error(
      `waitForFileContent: ${filePath} の内容が条件を満たさなかった` +
        `（最後に読めた内容: ${last === undefined ? 'ファイルが無い' : JSON.stringify(last)}）`,
      { cause: e },
    );
  }
  if (value === undefined) {
    throw new Error(`waitForFileContent: ${filePath} を読めていない`);
  }
  return value;
}
