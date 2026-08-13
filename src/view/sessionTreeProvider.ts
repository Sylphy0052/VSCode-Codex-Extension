import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import { readConfig, workspaceFolderPaths } from '../config';
import type { Logger } from '../log';
import type { ProviderRegistry } from '../provider/registry';
import type { HistoryScope } from '../session/sessionStore';
import { formatAbsoluteTime, formatRelativeTime } from './relativeTime';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionSummary> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private scopeOverride: HistoryScope | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly isOpen: (sessionId: string) => boolean,
    private readonly log: Logger,
  ) {}

  get scope(): HistoryScope {
    return this.scopeOverride ?? readConfig().historyScope;
  }

  async setScope(scope: HistoryScope): Promise<void> {
    this.scopeOverride = scope;
    await vscode.commands.executeCommand('setContext', 'codex.historyScope', scope);
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** ファイル監視は短時間に何度も発火するため、まとめて1回にする。 */
  refreshDebounced(delayMs = 300): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  async getChildren(element?: SessionSummary): Promise<SessionSummary[]> {
    if (element !== undefined) {
      return [];
    }

    const config = readConfig();
    return this.providers.listSessions(
      {
        scope: this.scope,
        workspaceFolders: workspaceFolderPaths(),
        maxEntries: config.historyMaxEntries,
      },
      this.log,
    );
  }

  getTreeItem(session: SessionSummary): vscode.TreeItem {
    const open = this.isOpen(session.id);
    const item = new vscode.TreeItem(
      session.threadName ?? '(名称未設定)',
      vscode.TreeItemCollapsibleState.None,
    );

    // VS Codeはツリーの要素とTreeItemの対応を`id`で保持する。`id`が無いとラベルと位置から
    // 内部ハンドルを組み立てるが、このツリーのラベルは`threadName ?? '(名称未設定)'`で
    // 重複しやすく、`refreshDebounced`によって並びも頻繁に変わる。その結果ハンドルと要素の
    // 対応がずれ、`view/item/context`（インラインアイコン・右クリックメニュー）から呼ぶ
    // コマンドへ`SessionSummary`が渡らず`undefined`になる（issue #236）。
    // プロバイダをまたいでも衝突しないよう、プロバイダ名とセッションIDの組で一意にする。
    item.id = `${session.provider}:${session.id}`;

    const label = this.providers.get(session.provider)?.label ?? session.provider;
    const parts = [label, formatRelativeTime(session.updatedAt, Date.now())];
    if (this.scope === 'all' && session.cwd !== undefined) {
      parts.push(basename(session.cwd));
    }
    item.description = parts.filter((p) => p !== '').join('  ');

    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.threadName ?? '(名称未設定)'}**`,
        '',
        `- CLI: ${label}`,
        `- 更新: ${formatAbsoluteTime(session.updatedAt)}`,
        `- cwd: \`${session.cwd ?? '不明'}\``,
        `- id: \`${session.id}\``,
        ...(session.archived ? ['- アーカイブ済み'] : []),
        // 親スレッドが分かる場合のみ（issue #34、design.md §14.26）。切替はできないため、
        // ツリーからは「親が居る」ことが分かるだけに留める
        ...(session.parentThreadId !== undefined
          ? [`- 親スレッド: \`${session.parentThreadId}\``]
          : []),
      ].join('\n'),
    );

    item.iconPath = new vscode.ThemeIcon(
      open
        ? 'circle-filled'
        : session.archived
          ? 'archive'
          : session.provider === 'claude'
            ? 'sparkle'
            : 'comment-discussion',
    );
    // メニューの出し分けにプロバイダを含める（Claude Codeにはarchive/deleteが無い）
    item.contextValue = session.archived
      ? `codexSession.${session.provider}.archived`
      : `codexSession.${session.provider}`;
    item.command = {
      command: 'codex.openSession',
      title: 'Open',
      arguments: [session],
    };
    return item;
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.emitter.dispose();
  }
}

function basename(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
