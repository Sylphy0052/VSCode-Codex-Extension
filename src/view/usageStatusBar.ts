import * as vscode from 'vscode';
import type { ChatUsage } from '../appserver/chatState';
import {
  formatClaudeLimitLines,
  formatClaudeUsage,
  mergeClaudeUsage,
  summarizeClaudeLimits,
  type ClaudeLimitEntry,
} from '../claude/usageText';
import {
  formatResetsIn,
  formatUsageGauge,
  formatWindow,
  formatWindowLabel,
  severityOf,
  type UsageSnapshot,
} from '../codex/usage';
import { formatAbsoluteTime } from './relativeTime';

/** 残り時間の表記を進めるための再描画の間隔（issue #1224。分未満は表示に出ない）。 */
const TICK_MS = 60_000;

/**
 * レート制限の使用量をステータスバーに常時表示する。
 * サイドバーを閉じていても見えることが要件なのでステータスバーを使う。
 */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Claude Codeは常時読める記録が無いため、チャット画面が受け取った値だけを出す別項目にする。 */
  private readonly claudeItem: vscode.StatusBarItem;
  /**
   * Claude Codeの制限枠ごとの保持値（issue #1221）。
   *
   * 取得元が2つあり、それぞれ持っている情報が違う。届いた値で置き換えると、割合だけの取得が
   * 到達とリセット時刻を消す。枠ごとに重ねてから代表値を描く。
   */
  private claudeLimits: ClaudeLimitEntry[] = [];
  /** Codexの直近のスナップショット。残り時間の表記を進めるために持つ（issue #1224）。 */
  private snapshot: UsageSnapshot | undefined;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codex.showUsage';
    this.item.name = 'Codex 使用量';
    this.update(undefined);
    this.item.show();

    this.claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.claudeItem.name = 'Claude Code 制限';
    this.updateClaude(undefined);

    // 残り時間の表記を進めるだけの再描画（新しい値は読まない）。値を持っているのはこの
    // クラスなので、描き直しもここが持つ。以前は `extension.ts` のtickerがCodex側だけを
    // 描き直しており、Claudeの表示は通知が止まると固まっていた（issue #1224）
    this.ticker = setInterval(() => this.redraw(), TICK_MS);
    // テストやサーバ側の実行で、この間隔だけがプロセスを生かし続けないようにする
    this.ticker.unref?.();
  }

  /** 保持している値のまま描き直す。時刻が進むと残り時間の表記が変わる。 */
  private redraw(): void {
    this.renderCodex();
    this.renderClaude();
  }

  /**
   * Claude Codeの制限表示を更新する。
   *
   * 一度も届いていない間は項目ごと隠す。値が無いのに枠だけ出ていると、
   * 取得できていないのか制限が無いのか区別できないため。
   *
   * 渡された値は枠ごとに重ねて保つ。`rate_limit_event` は到達とリセット時刻を、`/usage` は
   * 消費率を持つので、後から来たほうで置き換えると片方が消える（issue #1221）。
   */
  updateClaude(usage: ChatUsage | undefined): void {
    if (usage !== undefined) {
      this.claudeLimits = mergeClaudeUsage(this.claudeLimits, usage);
    }
    this.renderClaude();
  }

  private renderClaude(): void {
    const now = Date.now();
    const summary = summarizeClaudeLimits(this.claudeLimits);
    const text = formatClaudeUsage(summary, now);
    if (text === '') {
      this.claudeItem.hide();
      return;
    }
    this.claudeItem.text = `$(pulse) ${text}`;
    this.claudeItem.tooltip = new vscode.MarkdownString(
      [
        '**Claude Code の制限**',
        '',
        // 見出しは1枠ぶんなので、他の枠の割合・リセット時刻はここでしか読めない（issue #1221）
        ...formatClaudeLimitLines(this.claudeLimits, now),
        '',
        'Claude Codeは制限の種類ごとに、届いた消費率とリセット時刻を表示します。',
        '',
        '_チャット画面を開いている間に届いた値です_',
      ].join('\n'),
    );
    this.claudeItem.backgroundColor =
      summary?.limited === true
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.claudeItem.show();
  }

  update(snapshot: UsageSnapshot | undefined): void {
    this.snapshot = snapshot;
    this.renderCodex();
  }

  private renderCodex(): void {
    const snapshot = this.snapshot;
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
    clearInterval(this.ticker);
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
  const lines = [`**Codex 使用量**`, ''];
  const now = Date.now();
  if (snapshot.windows.length === 0) {
    const window = formatWindow(snapshot.windowMinutes);
    lines.push(
      `- ${window === '' ? '制限' : window}: ${Math.round(snapshot.usedPercent ?? 0)}% 使用`,
    );
    const resets = formatResetsIn(snapshot.resetsAt, now);
    if (resets !== '') {
      lines.push(`- リセット: ${resets}`);
    }
  } else {
    // 窓ごとに1行。見出しの数字は最も逼迫した窓なので、他の窓の残りはここでしか判らない
    // （issue #1212）
    for (const window of snapshot.windows) {
      const resets = formatResetsIn(window.resetsAt, now);
      lines.push(
        `- ${formatWindowLabel(window, snapshot.windows)}: ${Math.round(window.usedPercent)}% 使用${resets === '' ? '' : ` ・ リセット ${resets}`}`,
      );
    }
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
