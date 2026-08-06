import * as vscode from 'vscode';
import { formatResetsIn, formatWindow, severityOf, type UsageSnapshot } from '../codex/usage';
import { formatAbsoluteTime } from './relativeTime';

/**
 * レート制限の使用量をステータスバーに常時表示する。
 * サイドバーを閉じていても見えることが要件なのでステータスバーを使う。
 */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codex.showUsage';
    this.item.name = 'Codex 使用量';
    this.update(undefined);
    this.item.show();
  }

  update(snapshot: UsageSnapshot | undefined): void {
    if (snapshot?.usedPercent === undefined) {
      this.item.text = '$(pulse) Codex --';
      this.item.tooltip = new vscode.MarkdownString(
        'Codexの使用量はまだ取得できていません。\n\nセッションでやり取りすると更新されます。',
      );
      this.item.backgroundColor = undefined;
      return;
    }

    const percent = Math.round(snapshot.usedPercent);
    const resets = formatResetsIn(snapshot.resetsAt, Date.now());
    this.item.text = `$(pulse) Codex ${percent}%${resets === '' ? '' : ` ・ ${resets}`}`;
    this.item.tooltip = buildTooltip(snapshot);

    const severity = severityOf(snapshot.usedPercent);
    this.item.backgroundColor =
      severity === 'critical'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(snapshot: UsageSnapshot): vscode.MarkdownString {
  const window = formatWindow(snapshot.windowMinutes);
  const lines = [
    `**Codex 使用量**`,
    '',
    `- ${window === '' ? '制限' : window}: ${Math.round(snapshot.usedPercent ?? 0)}% 使用`,
  ];

  const resets = formatResetsIn(snapshot.resetsAt, Date.now());
  if (resets !== '') {
    lines.push(`- リセット: ${resets}`);
  }
  if (snapshot.planType !== undefined) {
    lines.push(`- プラン: ${snapshot.planType}`);
  }
  if (snapshot.creditsBalance !== undefined) {
    lines.push(`- クレジット: ${snapshot.creditsBalance}`);
  }
  if (snapshot.capturedAt !== undefined) {
    lines.push('', `_${formatAbsoluteTime(snapshot.capturedAt)} 時点_`);
  }
  return new vscode.MarkdownString(lines.join('\n'));
}
