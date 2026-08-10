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
export function chatCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // 添付画像のサムネイルはデータURLで渡す。外部から取ってくることは無い
    'img-src data:',
  ].join('; ');
}
