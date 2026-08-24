import * as vscode from 'vscode';
import { approvalStatusBarText, type ApprovalPendingSession } from './approvalPending';

/** ステータスバーから承認待ちの画面へ戻るコマンド（`package.json`にも同じidがある）。 */
export const SHOW_APPROVAL_PENDING_COMMAND = 'codex.showApprovalPending';

/**
 * 承認待ちをステータスバーへ出す（issue #755）。
 *
 * Agentsビューのバッジ（issue #734）と対。あちらはサイドバーを開いていれば見え、
 * こちらはサイドバーの表示に関わらず常に見える。両方入れる。
 *
 * 使用量（`usageStatusBar.ts`）とは別クラスにする。使用量は放っておいても回復する情報で、
 * こちらは操作しない限り進まない合図であり、更新の契機も出し方も共有するものが無い。
 *
 * 配置は左（`StatusBarAlignment.Left`）。右側は使用量2つで埋まりつつあり、通知性の高い
 * 項目はエディタの状態表示の近くに出したい。
 */
export class ApprovalStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = '承認待ち';
    this.item.command = SHOW_APPROVAL_PENDING_COMMAND;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.update([]);
  }

  /**
   * 承認待ちの一覧を反映する。0件は項目ごと隠す。
   *
   * 0件で「承認待ち 0」を出し続けると、目立つ背景色のまま常駐して合図として働かなくなる
   * （バッジを0件で消すのと同じ理由）。
   */
  update(pending: readonly ApprovalPendingSession[]): void {
    const text = approvalStatusBarText(pending.length);
    if (text === '') {
      this.item.hide();
      return;
    }
    this.item.text = text;
    this.item.tooltip = buildTooltip(pending);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * どのセッションが待っているかまで出す。件数だけだと、押して初めて中身が分かる。
 *
 * タイトルはCLI由来の値（`deriveTitle`が要約名から作る）なので未信頼として扱い、
 * Markdownとして解釈させない（`MarkdownString`の既定どおり`isTrusted`は付けず、
 * 記号もエスケープする）。
 */
function buildTooltip(pending: readonly ApprovalPendingSession[]): vscode.MarkdownString {
  const lines = ['**承認待ち**', ''];
  for (const session of pending) {
    lines.push(`- ${escapeMarkdown(session.title)}`);
  }
  lines.push('', '_押すと該当の会話を開きます_');
  return new vscode.MarkdownString(lines.join('\n'));
}

/** Markdownの記号を打ち消す。tooltipへ差し込むのはCLI由来の文字列のため。 */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|<>]/gu, (match) => `\\${match}`);
}
