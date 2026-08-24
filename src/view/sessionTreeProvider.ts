import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import { readConfig, workspaceFolderPaths } from '../config';
import type { Logger } from '../log';
import type { ProviderRegistry } from '../provider/registry';
import type { HistoryScope } from '../session/sessionStore';
import { basenameOf } from '../util/paths';
import { PinnedSessionStore, partitionPinned, pinKeyFor } from '../util/pinnedSessions';
import { matchesSessionQuery, sessionNameHighlights } from '../util/sessionFilter';
import { buildDateGroups, buildFolderGroups, type SessionGroup } from '../util/sessionGrouping';
import { formatAbsoluteTime, formatRelativeTime } from './relativeTime';
import type { SessionActivityState } from './sessionActivity';
import {
  decorationStateOf,
  parseSessionUri,
  sessionUri,
  type SessionDecorationSource,
  type SessionDecorationState,
} from './sessionDecorations';

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

export class SessionTreeProvider
  implements vscode.TreeDataProvider<TreeElement>, SessionDecorationSource
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  /**
   * 現在表示している（絞り込み後の）セッションを`<provider>:<id>`で引ける形で持つ
   * （issue #735）。`FileDecorationProvider`にはURIしか渡ってこないため。
   */
  private visibleSessions = new Map<string, SessionSummary>();

  private readonly decorationEmitter = new vscode.EventEmitter<void>();
  /**
   * 行末のデコレーション（issue #735）を引き直させる合図。一覧が実際に入れ替わった
   * 後（`getChildren`のルート呼び出しの末尾）に発火する。
   *
   * `onDidChangeTreeData`を代わりに使うことはできない。あちらは再読込を**依頼した**
   * 時点で発火するため、装飾側がまだ更新されていない一覧を読んでしまい、次に一覧が
   * 届いても誰も引き直さないまま古いバッジが残る。
   */
  readonly onDidChangeDecorations = this.decorationEmitter.event;

  private scopeOverride: HistoryScope | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** タイトルバーの絞り込み入力（issue #293）。表示だけを変え、読み込み件数には関与しない。 */
  private filterText = '';

  constructor(
    private readonly providers: ProviderRegistry,
    /**
     * セッションの活動状態を引く（issue #286、design.md §14.55）。`undefined`は
     * 「開いていない」（従来の`isOpen`相当）。`SessionSummary`を渡すのは、実体
     * （`chat` / `claudeChat`のどちらのマネージャへ引くか）を`session.provider`で
     * 決める必要があるため（`src/extension.ts`の配線を参照）。
     */
    private readonly getActivity: (session: SessionSummary) => SessionActivityState | undefined,
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
    await vscode.commands.executeCommand(
      'setContext',
      'codex.sessionFilterActive',
      this.filterActive,
    );
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

    // 行末のデコレーション（issue #735）の引き先。VS Codeは`provideFileDecoration`へ
    // URIしか渡さないため、URIからセッションへ戻れるようにここで持ち直す。
    // グループ化の分岐より前に置く（`none`でも同じように引けるようにする）
    this.visibleSessions = new Map(visible.map((s) => [`${s.provider}:${s.id}`, s]));
    this.decorationEmitter.fire();

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
      groups.push({
        kind: 'group',
        groupKind: 'pinned',
        id: 'group:pinned',
        label: 'ピン留め',
        sessions: pinned,
      });
    }

    const contentGroups: SessionGroup[] =
      config.historyGroupBy === 'folder'
        ? buildFolderGroups(rest)
        : buildDateGroups(rest, Date.now());
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

  /**
   * 行末のデコレーションの状態を引く（issue #735、`SessionDecorationSource`）。
   *
   * 一覧に無いURI（絞り込みで消えた・別スキーム）は`undefined`を返す。VS Codeは
   * このプロバイダを全URIに対して呼ぶため、他のビュー（エクスプローラ等）のURIも届く。
   */
  decorationStateFor(uri: vscode.Uri): SessionDecorationState | undefined {
    const parsed = parseSessionUri(uri);
    if (parsed === undefined) {
      return undefined;
    }
    const session = this.visibleSessions.get(`${parsed.provider}:${parsed.id}`);
    if (session === undefined) {
      return undefined;
    }
    return decorationStateOf(session, this.getActivity(session));
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return isGroupNode(element)
      ? this.buildGroupTreeItem(element)
      : this.buildSessionTreeItem(element);
  }

  private buildGroupTreeItem(group: SessionGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = group.id;
    item.description = groupSummaryText(group.sessions.map((s) => this.getActivity(s)));
    // メニューのwhen句（`/^codexSession\./`系）はどれも一致しない値にしてある
    // （グループへ右クリック操作を出さないため。`package.json`のview/item/context参照）
    item.contextValue = 'codexSessionGroup';
    item.iconPath = new vscode.ThemeIcon(GROUP_ICON[group.groupKind]);
    return item;
  }

  /**
   * 行のラベル。絞り込み中にスレッド名が一致していれば、一致箇所を強調する
   * `TreeItemLabel` を返す（issue #738）。絞り込みが空のときや、`cwd`・IDにだけ
   * 一致した行では従来どおり素の文字列を返す——常に `TreeItemLabel` にすると
   * ラベルの読み出し側（テスト・ツールチップ生成）が分岐だらけになるため
   */
  private buildSessionLabel(session: SessionSummary): string | vscode.TreeItemLabel {
    const name = session.threadName ?? '(名称未設定)';
    if (!this.filterActive) {
      return name;
    }
    const highlights = sessionNameHighlights(name, this.filterText);
    if (highlights.length === 0) {
      return name;
    }
    return { label: name, highlights };
  }

  private buildSessionTreeItem(session: SessionSummary): vscode.TreeItem {
    const activity = this.getActivity(session);
    const item = new vscode.TreeItem(
      this.buildSessionLabel(session),
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

    // 行末のデコレーション（issue #735）を効かせるための仮想URI。`FileDecorationProvider`
    // は`resourceUri`を持つ項目にしか効かない。実ファイル（rolloutのjsonl）ではなく
    // 専用スキームを指す（実パスにすると同じファイルを開いている他のUIへ装飾が波及する）。
    // ラベルは`TreeItem.label`が優先されるので、表示名はこれで変わらない
    item.resourceUri = sessionUri(session);

    const label = this.providers.get(session.provider)?.label ?? session.provider;
    // 補足はいちばん見たい「いつ更新されたか」を先頭に置く（issue #736）。CLI名
    // （`Codex` / `Claude Code`）は載せない——サイドバーの幅が狭いと後ろから切れるため、
    // 3つ並べると相対時刻が押し出される。CLI名はツールチップの`- CLI:`に残してある
    const parts = [formatRelativeTime(session.updatedAt, Date.now())];
    if (this.scope === 'all' && session.cwd !== undefined) {
      parts.push(basenameOf(session.cwd));
    }
    // 実行中／承認待ちは他の情報より優先度が高いので先頭へ差し込む（issue #286、
    // design.md §14.55）。`idle`（開いてはいるが動いていない）・未オープンでは何も足さない
    if (activity === 'approvalPending') {
      parts.unshift('承認待ち');
    } else if (activity === 'running') {
      parts.unshift('実行中');
    }
    // 区切りは中黒（issue #736）。全角スペース2個は幅を取るわりに切れ目が読み取りにくい
    item.description = parts.filter((p) => p !== '').join(' · ');

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

    item.iconPath = buildSessionIcon(session, activity);
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
    this.decorationEmitter.dispose();
  }
}

/**
 * 状態を表すアイコンと、その色（issue #286・#733、design.md §14.55）。
 *
 * 承認待ち／実行中はオープン状態より優先して出す。どちらでも無ければ従来どおりの分岐
 * （open ? circle-filled : archived ? archive : ...）。
 *
 * 色は形（アイコンID）の補助であり、形の出し分けは変えない。色だけに頼ると、ハイ
 * コントラストや色覚特性の環境で区別が消える。色IDはVS Code組み込みのものだけを使い、
 * 拡張機能側で新しい色を宣言しない（テーマ作者が想定していない色が増えるのを避ける）。
 *
 * 未オープンには色を付けない。一覧のほとんどは未オープンなので、そこへ色を付けると
 * 「色が付いていること」自体が合図でなくなる。
 */
function buildSessionIcon(
  session: SessionSummary,
  activity: SessionActivityState | undefined,
): vscode.ThemeIcon {
  // `undefined` は「開いていない」（従来の`isOpen`相当）。`idle` は開いてはいる
  const open = activity !== undefined;
  if (activity === 'approvalPending') {
    return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'));
  }
  if (activity === 'running') {
    return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
  }
  if (open) {
    return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
  }
  if (session.archived) {
    return new vscode.ThemeIcon('archive', new vscode.ThemeColor('descriptionForeground'));
  }
  return new vscode.ThemeIcon(session.provider === 'claude' ? 'sparkle' : 'comment-discussion');
}

/**
 * グループ見出しの右に出す件数と内訳（issue #737）。
 *
 * 畳んだグループは中の行が見えないため、件数だけだと「この中に承認待ちが居るか」が
 * 分からない。件数のあとに内訳を1つだけ足す。
 *
 * **両方あっても1つしか出さない**。`3件 · 承認待ち1 · 実行中2`まで並べると、サイドバーの
 * 幅が狭いときに後ろから切れ、いちばん急ぐ承認待ちが押し出されることがある。承認待ちを
 * 優先するのは、こちらが人の操作を待って止まっている状態だから（実行中は放っておけば進む）。
 *
 * 引数は活動状態の配列。`SessionSummary`ではなく状態だけを受け取るのは、この関数を
 * ツリーの外から検査できるようにするため。
 */
export function groupSummaryText(
  activities: ReadonlyArray<SessionActivityState | undefined>,
): string {
  const base = `${activities.length}件`;
  const pending = activities.filter((a) => a === 'approvalPending').length;
  if (pending > 0) {
    return `${base} · 承認待ち${pending}`;
  }
  const running = activities.filter((a) => a === 'running').length;
  if (running > 0) {
    return `${base} · 実行中${running}`;
  }
  return base;
}

function buildSessionContextValue(session: SessionSummary, pinned: boolean): string {
  const base = session.archived
    ? `codexSession.${session.provider}.archived`
    : `codexSession.${session.provider}`;
  return pinned ? `${base}.pinned` : base;
}
