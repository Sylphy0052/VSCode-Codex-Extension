import * as vscode from 'vscode';
import type { ChatUsage } from '../appserver/chatState';
import { formatClaudeUsage } from '../claude/usageText';
import {
  formatResetsIn,
  formatUsageGauge,
  formatWindow,
  severityOf,
  type UsageSnapshot,
} from '../codex/usage';
import { formatAbsoluteTime } from './relativeTime';

/**
 * レート制限の使用量をステータスバーに常時表示する。
 * サイドバーを閉じていても見えることが要件なのでステータスバーを使う。
 */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Claude Codeは常時読める記録が無いため、チャット画面が受け取った値だけを出す別項目にする。 */
  private readonly claudeItem: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codex.showUsage';
    this.item.name = 'Codex 使用量';
    this.update(undefined);
    this.item.show();

    this.claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.claudeItem.name = 'Claude Code 制限';
    this.updateClaude(undefined);
  }

  /**
   * Claude Codeの制限表示を更新する。
   *
   * 一度も届いていない間は項目ごと隠す。値が無いのに枠だけ出ていると、
   * 取得できていないのか制限が無いのか区別できないため。
   */
  updateClaude(usage: ChatUsage | undefined): void {
    const text = formatClaudeUsage(usage, Date.now());
    if (text === '') {
      this.claudeItem.hide();
      return;
    }
    this.claudeItem.text = `$(pulse) ${text}`;
    this.claudeItem.tooltip = new vscode.MarkdownString(
      [
        '**Claude Code の制限**',
        '',
        'Claude Codeは消費率を返さないため、制限の種類とリセット時刻だけを表示します。',
        '',
        '_チャット画面を開いている間に届いた値です_',
      ].join('\n'),
    );
    this.claudeItem.backgroundColor =
      usage?.limited === true
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.claudeItem.show();
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
    const gauge = isGaugeEnabled() ? formatUsageGauge(snapshot.usedPercent) : '';
    this.item.text = `$(pulse) Codex ${gauge === '' ? '' : `${gauge} `}${percent}%${resets === '' ? '' : ` ・ ${resets}`}`;
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
    this.claudeItem.dispose();
  }
}

/**
 * ステータスバーにゲージを添えるか。
 *
 * 文字数が増えて他の項目を押し出すのを嫌う人がいるため、数字だけへ戻せるようにする。
 */
function isGaugeEnabled(): boolean {
  return vscode.workspace.getConfiguration('codex').get<boolean>('usage.statusBarGauge') !== false;
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
