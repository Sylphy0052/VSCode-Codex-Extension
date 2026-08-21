/**
 * チャット画面のContent-Security-Policy。
 *
 * `default-src 'none'` なので、**書いていない読み込み先はすべて塞がる**。しかも
 * 塞がれたことは画面に出ないため、抜けがあると機能が黙って死ぬ。ここだけで組み立てて
 * テストで見張る。
 *
 * `chatView.ts` から切り出してあるのは、あちらが `vscode` を読み込んでいてテストから
 * 触れないため。
 */
export interface ChatCspOptions {
  /**
   * `img-src data:` を含めるか（既定はtrue）。添付画像のサムネイルをデータURLで渡す画面向け。
   * 画像を扱わない画面（例: `conversationView.ts`、本文はすべてエスケープ表示のみ）は
   * `false` を渡して不要な許可を増やさない。
   */
  includeImgData?: boolean;
}

export function chatCsp(cspSource: string, nonce: string, options: ChatCspOptions = {}): string {
  const { includeImgData = true } = options;
  const directives = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ];
  if (includeImgData) {
    // 添付画像のサムネイルはデータURLで渡す。外部から取ってくることは無い
    directives.push('img-src data:');
  }
  return directives.join('; ');
}
