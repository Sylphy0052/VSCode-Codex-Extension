/**
 * パスの末尾要素だけを取り出す。`node:path` の `basename` は環境のセパレータに依存するため、
 * ここでは常に `/` 区切りとして扱う（セッションの `cwd` はロールアウト/トランスクリプトへ
 * 書かれたPOSIXパス前提。design.md 既存実装 `sessionTreeProvider.ts` の踏襲）。
 */
export function basenameOf(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
