import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import { readConfig, workspaceFolderPaths } from '../config';
import type { Logger } from '../log';
import type { ProviderRegistry } from '../provider/registry';
import type { HistoryScope } from '../session/sessionStore';
import { basenameOf } from '../util/paths';
import { PinnedSessionStore, partitionPinned, pinKeyFor } from '../util/pinnedSessions';
import { matchesSessionQuery } from '../util/sessionFilter';
import { buildDateGroups, buildFolderGroups, type SessionGroup } from '../util/sessionGrouping';
import { formatAbsoluteTime, formatRelativeTime } from './relativeTime';

/**
 * グループの見出し用ツリー要素（issue #293。日付/作業ディレクトリ/ピン留めのグループ化）。
 *
 * セッションの葉ノードは`SessionGroupNode`で包まず`SessionSummary`をそのまま使う
 * （`TreeElement = SessionSummary | SessionGroupNode`という直和型）。包んでしまうと
 * `view/item/context`（右クリックメニュー・インラインアイコン）から呼ばれるコマンドへ
 * ラッパーオブジェクトが渡ってしまい、`codex.archiveSession`等が期待する`SessionSummary`と
 * 食い違う。VS Codeはツリーの要素（＝`TreeDataProvider<T>`の`T`）をそのままコマンド引数へ渡す
 * ため、`T`の「セッション」側は常に生の`SessionSummary`である必要がある（issue #236の
 * 再発防止と同じ理由）。
 */
export interface SessionGroupNode {
  readonly kind: 'group';
  readonly groupKind: 'pinned' | 'date' | 'folder';
  /** `group:<groupKind>:<key>`の形。セッション側のidは`<provider>:<id>`（providerは
   * `codex` | `claude`のみ）で、`group:`から始まることは無いため衝突しない。 */
  readonly id: string;
  readonly label: string;
  readonly sessions: SessionSummary[];
}

export type TreeElement = SessionSummary | SessionGroupNode;

function isGroupNode(element: TreeElement): element is SessionGroupNode {
  return (
    typeof element === 'object' &&
    element !== null &&
    (element as { kind?: unknown }).kind === 'group'
  );
}

const GROUP_ICON: Readonly<Record<SessionGroupNode['groupKind'], string>> = {
  pinned: 'pinned',
  date: 'calendar',
  folder: 'folder',
};

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private scopeOverride: HistoryScope | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** タイトルバーの絞り込み入力（issue #293）。表示だけを変え、読み込み件数には関与しない。 */
  private filterText = '';

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly isOpen: (sessionId: string) => boolean,
    private readonly log: Logger,
    private readonly pinnedStore: PinnedSessionStore = new PinnedSessionStore(),
  ) {}

  get scope(): HistoryScope {
    return this.scopeOverride ?? readConfig().historyScope;
  }

  async setScope(scope: HistoryScope): Promise<void> {
    this.scopeOverride = scope;
    await vscode.commands.executeCommand('setContext', 'codex.historyScope', scope);
    this.refresh();
  }

  /** 絞り込みの現在値（生の入力。前後空白を含む）。入力欄の初期値の復元に使う。 */
  get filterQuery(): string {
    return this.filterText;
  }

  /** 絞り込み中かどうか。空白だけの入力は「絞り込み無し」として扱う。 */
  get filterActive(): boolean {
    return this.filterText.trim() !== '';
  }

  async setFilter(query: string): Promise<void> {
    this.filterText = query;
    await vscode.commands.executeCommand('setContext', 'codex.sessionFilterActive', this.filterActive);
    this.refresh();
  }

  async clearFilter(): Promise<void> {
    await this.setFilter('');
  }

  isPinned(session: SessionSummary): boolean {
    return this.pinnedStore.isPinned(pinKeyFor(session));
  }

  async pin(session: SessionSummary): Promise<void> {
    await this.pinnedStore.pin(pinKeyFor(session));
    this.refresh();
  }

  async unpin(session: SessionSummary): Promise<void> {
    await this.pinnedStore.unpin(pinKeyFor(session));
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

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element !== undefined) {
      // グループの子はそのグループが持つセッションだけ。セッション自体は葉なので空配列
      // （`getChildren(element)`は必ずグループの子を返す形に統一。issue #293の受入基準）。
      return isGroupNode(element) ? element.sessions : [];
    }

    const config = readConfig();
    const sessions = await this.providers.listSessions(
      {
        scope: this.scope,
        workspaceFolders: workspaceFolderPaths(),
        maxEntries: config.historyMaxEntries,
      },
      this.log,
    );

    // 絞り込みは表示だけを変える。読み込み件数（maxEntries）はここより前で決まっている
    const visible = this.filterActive
      ? sessions.filter((s) => matchesSessionQuery(s, this.filterText))
      : sessions;

    if (config.historyGroupBy === 'none') {
      // `none`は既存の表示（更新時刻降順のフラットな1リスト）へそのまま戻す。ピン留めして
      // いてもグループ化はしない（「noneで現状とまったく同じ」という受入基準を優先した判断。
      // 判断の詳細はdesign.md §14.54）。ピン留めの解除自体はcontextValue経由でどのモードでも
      // できる（getTreeItem参照）。
      return visible;
    }

    const { pinned, rest } = partitionPinned(visible, this.pinnedStore.list());

    const groups: SessionGroupNode[] = [];
    if (pinned.length > 0) {
      groups.push({ kind: 'group', groupKind: 'pinned', id: 'group:pinned', label: 'ピン留め', sessions: pinned });
    }

    const contentGroups: SessionGroup[] =
      config.historyGroupBy === 'folder' ? buildFolderGroups(rest) : buildDateGroups(rest, Date.now());
    for (const g of contentGroups) {
      groups.push({
        kind: 'group',
        groupKind: g.kind,
        id: `group:${g.kind}:${g.key}`,
        label: g.label,
        sessions: g.sessions,
      });
    }

    return groups;
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return isGroupNode(element) ? this.buildGroupTreeItem(element) : this.buildSessionTreeItem(element);
  }

  private buildGroupTreeItem(group: SessionGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = group.id;
    item.description = `${group.sessions.length}`;
    // メニューのwhen句（`/^codexSession\./`系）はどれも一致しない値にしてある
    // （グループへ右クリック操作を出さないため。`package.json`のview/item/context参照）
    item.contextValue = 'codexSessionGroup';
    item.iconPath = new vscode.ThemeIcon(GROUP_ICON[group.groupKind]);
    return item;
  }

  private buildSessionTreeItem(session: SessionSummary): vscode.TreeItem {
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
    // グループ化（issue #293）後もこの値は変えていない。グループのidは常に`group:`から
    // 始まり、プロバイダ名（`codex` / `claude`）が`group`になることは無いため衝突しない。
    item.id = `${session.provider}:${session.id}`;

    const label = this.providers.get(session.provider)?.label ?? session.provider;
    const parts = [label, formatRelativeTime(session.updatedAt, Date.now())];
    if (this.scope === 'all' && session.cwd !== undefined) {
      parts.push(basenameOf(session.cwd));
    }
    item.description = parts.filter((p) => p !== '').join('  ');

    const pinned = this.isPinned(session);

    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.threadName ?? '(名称未設定)'}**`,
        '',
        `- CLI: ${label}`,
        `- 更新: ${formatAbsoluteTime(session.updatedAt)}`,
        `- cwd: \`${session.cwd ?? '不明'}\``,
        `- id: \`${session.id}\``,
        ...(session.archived ? ['- アーカイブ済み'] : []),
        ...(pinned ? ['- ピン留め済み'] : []),
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
    // メニューの出し分けにプロバイダ・アーカイブ状態・ピン留め状態を含める
    // （Claude Codeにはarchive/deleteが無い。`package.json`のwhen句は正規表現で
    // `.pinned`サフィックスの有無に関わらずマッチするようにしてある）
    item.contextValue = buildSessionContextValue(session, pinned);
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

function buildSessionContextValue(session: SessionSummary, pinned: boolean): string {
  const base = session.archived
    ? `codexSession.${session.provider}.archived`
    : `codexSession.${session.provider}`;
  return pinned ? `${base}.pinned` : base;
}
