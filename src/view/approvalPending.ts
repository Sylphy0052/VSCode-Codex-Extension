import type { SessionActivityState } from './sessionActivity';

/**
 * 承認待ちの件数と、その見せ方（issue #734・#755）。
 *
 * Agentsビューのバッジ（`TreeView.badge`、issue #734）とステータスバー（issue #755）は
 * 同じ「いま人の操作を待っている数」を別の場所へ出す。件数の数え方と文言をここへ寄せ、
 * 2箇所で別々に数えて食い違うことを防ぐ。
 *
 * `vscode`に依存しないため、実VSCode無しでユニットテストできる（`sessionActivity.ts`と
 * 同じ流儀）。
 */

/**
 * 承認待ちの数（issue #734）。
 *
 * 実行中（`running`）は数に含めない。バッジは「人の操作を待っているもの」に限る。
 * 実行中まで含めると、放っておけば終わるものと、操作しない限り進まないものが同じ数字に
 * 混ざり、数字を見ても手を動かすべきか判断できなくなる。
 */
export function countApprovalPending(states: Iterable<SessionActivityState>): number {
  let count = 0;
  for (const state of states) {
    if (state === 'approvalPending') {
      count += 1;
    }
  }
  return count;
}

/** バッジの中身（`vscode.ViewBadge`と同じ形。`vscode`を参照せずに済ませるため再宣言）。 */
export interface ApprovalPendingBadge {
  readonly value: number;
  readonly tooltip: string;
}

/**
 * 件数からバッジの中身を作る（issue #734）。0件は`undefined`＝バッジを消す。
 *
 * 0を出さないのは、承認待ちが無いときがほとんどであり、常時「0」が付いていると
 * バッジ自体が合図として働かなくなるため（`sessionTreeProvider.ts`の未オープンに
 * 色を付けない判断と同じ理由）。
 */
export function approvalPendingBadge(count: number): ApprovalPendingBadge | undefined {
  if (count <= 0) {
    return undefined;
  }
  return { value: count, tooltip: `承認待ち ${count}件` };
}
