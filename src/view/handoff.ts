/**
 * セッションの引き継ぎ（issue #694）。
 *
 * 旧セッションのtranscript（会話ログ）のファイルパスを新セッションへそのまま送り、
 * 新セッション側のCLI自身に読ませて要約・引き継ぎさせる。拡張機能側でCLIの応答を
 * 解析する処理は持たない（フォーマット崩れに弱いため）。
 */

/** 新セッションへ送る固定文言。transcriptパスを埋め込む。 */
export function buildHandoffPrompt(transcriptPath: string): string {
  return `前セッションの続き。以下のtranscriptを読んで要約し、作業を引き継いで:\n${transcriptPath}`;
}

/**
 * transcriptファイルの解決を短時間リトライする。
 *
 * セッション開始直後はCLIがまだtranscriptを書き出していないことがあるため、
 * 即失敗にせず数回だけ間隔を空けて再試行する。
 */
export async function resolveWithRetry<T>(
  resolve: () => Promise<T | undefined>,
  retries = 3,
  delayMs = 500,
): Promise<T | undefined> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const found = await resolve();
    if (found !== undefined) {
      return found;
    }
    if (attempt < retries) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs));
    }
  }
  return undefined;
}
