/**
 * 承認方法をキー操作で順に切り替えるための並び（issue #13）。
 *
 * TUIは Shift+Tab で承認モードを循環させる。セレクタを開いて選ぶより速く、実際には
 * こちらばかり使う操作なので、チャット画面にも同じ入口を用意する。
 *
 * **並びは「制限が強い側から緩い側へ」**。押すたびに緩む向きに進むので、どこまで緩めたかが
 * 押した回数で分かる。
 */

/** Codexの循環。`APPROVAL_MODES` の宣言順がそのまま安全順になっている。 */
export const CODEX_APPROVAL_CYCLE: readonly string[] = ['untrusted', 'on-request', 'never'];

/**
 * Claude Codeの循環。
 *
 * **`bypassPermissions` は含めない。** 確認なしでツールが動く値であり、キーを連打していて
 * 到達してよいものではない（設定パネルとセレクタでは明示の同意を取ったうえで選べる）。
 * `plan` を先頭に置くのは、Plan modeが「書けないことを権限で保証する」いちばん強い状態のため。
 */
export const CLAUDE_APPROVAL_CYCLE: readonly string[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'dontAsk',
];

/**
 * 次の承認方法を返す。
 *
 * 現在値が循環に無い場合（空文字＝CLIへ委譲、または `bypassPermissions` のような循環外の値）は
 * **先頭へ進む**。いま何が効いているか画面から判らない状態から、いちばん厳しいところへ寄せる。
 */
export function nextApprovalMode(cycle: readonly string[], current: string): string | undefined {
  if (cycle.length === 0) {
    return undefined;
  }
  const index = cycle.indexOf(current);
  return index === -1 ? cycle[0] : cycle[(index + 1) % cycle.length];
}
