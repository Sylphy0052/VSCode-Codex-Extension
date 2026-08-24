/**
 * 承認待ちの一覧と、その見せ方（issue #734・#755）。
 *
 * Agentsビューのバッジ（`TreeView.badge`、issue #734）とステータスバー（issue #755）は
 * 同じ「いま人の操作を待っているもの」を別の場所へ出す。前者はサイドバーを開いていれば
 * 見え、後者はサイドバーの表示に関わらず常に見える。数え方と文言をここへ寄せ、2箇所で
 * 別々に数えて食い違うことを防ぐ。
 *
 * 件数は一覧の長さで導く（数える口と開く口を分けない）。分けると、バッジは1と出ているのに
 * ステータスバーから開ける先が0件、といった食い違いが起こりうる。
 *
 * `vscode`に依存しないため、実VSCode無しでユニットテストできる（`sessionActivity.ts`と
 * 同じ流儀）。
 */

/**
 * 承認待ちのセッション1件（issue #755）。ステータスバーから開く先を決めるのに使う。
 *
 * 実行中（`running`）は含めない。「人の操作を待っているもの」に限る。実行中まで含めると、
 * 放っておけば終わるものと、操作しない限り進まないものが同じ数字に混ざり、数字を見ても
 * 手を動かすべきか判断できなくなる。
 */
export interface ApprovalPendingSession {
  readonly threadId: string;
  /** 一覧から選ばせるときの見出し。チャットのタブ名と同じ。 */
  readonly title: string;
  /** どちらのチャット画面へ戻すか。 */
  readonly provider: 'codex' | 'claude';
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

/**
 * ステータスバーの表示文字列（issue #755）。0件は空文字＝項目を隠す。
 *
 * アイコンは履歴ツリーの承認待ち（`sessionTreeProvider.ts`の`bell-dot`）と揃える。
 * 同じ状態を2箇所で別の形に描くと、どちらかを覚え直すことになる。
 */
export function approvalStatusBarText(count: number): string {
  if (count <= 0) {
    return '';
  }
  return `$(bell-dot) 承認待ち ${count}`;
}
