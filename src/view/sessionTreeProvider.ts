import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import { readConfig, workspaceFolderPaths } from '../config';
import type { Logger } from '../log';
import type { HistoryScope, SessionStore } from '../session/sessionStore';
import { formatAbsoluteTime, formatRelativeTime } from './relativeTime';

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionSummary> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private scopeOverride: HistoryScope | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: SessionStore,
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
    const result = await this.store.list({
      scope: this.scope,
      workspaceFolders: workspaceFolderPaths(),
      maxEntries: config.historyMaxEntries,
    });

    if (result.skippedIndexLines > 0 || result.unresolved > 0) {
      this.log.warn(
        `一覧構築: 壊れた行 ${result.skippedIndexLines} / 実体なし ${result.unresolved}`,
      );
    }
    return result.sessions;
  }

  getTreeItem(session: SessionSummary): vscode.TreeItem {
    const open = this.isOpen(session.id);
    const item = new vscode.TreeItem(
      session.threadName ?? '(名称未設定)',
      vscode.TreeItemCollapsibleState.None,
    );

    const parts = [formatRelativeTime(session.updatedAt, Date.now())];
    if (this.scope === 'all' && session.cwd !== undefined) {
      parts.push(basename(session.cwd));
    }
    item.description = parts.filter((p) => p !== '').join('  ');

    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.threadName ?? '(名称未設定)'}**`,
        '',
        `- 更新: ${formatAbsoluteTime(session.updatedAt)}`,
        `- cwd: \`${session.cwd ?? '不明'}\``,
        `- id: \`${session.id}\``,
        ...(session.archived ? ['- アーカイブ済み'] : []),
      ].join('\n'),
    );

    item.iconPath = new vscode.ThemeIcon(
      open ? 'circle-filled' : session.archived ? 'archive' : 'comment-discussion',
    );
    item.contextValue = session.archived ? 'codexSession.archived' : 'codexSession';
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
