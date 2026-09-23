import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import type { Logger } from '../log';
import type { ProviderRegistry } from '../provider/registry';
import { isWithinAnyRoot } from '../util/paths';
import { PinnedSessionStore, pinKeyFor } from '../util/pinnedSessions';
import { BackgroundList } from './backgroundList';
import { buildSessionTreeItem } from './sessionTreeProvider';
import type { SessionActivityState } from './sessionActivity';

/**
 * お気に入りビュー（Issue #1366）。履歴ビューの「ピン留め」グループを置き換える。
 *
 * セッションの葉ノードは`sessionTreeProvider.ts`と同じ理由で`SessionSummary`をそのまま使う
 * （包むと`view/item/context`から呼ぶコマンドへラッパーが渡ってしまう。issue #236参照）。
 * グループ化は行わない（お気に入りは元々少数のはずで、日付・作業ディレクトリで畳む意味が薄い）。
 *
 * 履歴の表示範囲（ワークスペース／すべて）や絞り込みには従わない。全件一覧ではなく、
 * ピン留めしたidだけを引く（Issue #1389）。出すのは開いているリポジトリで起動したものだけ
 * （Issue #1406。当初は全ワークスペースから拾っていた）。
 */
export class FavoritesTreeProvider implements vscode.TreeDataProvider<SessionSummary> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /**
   * 読み込んだ一覧（Issue #1396）。履歴ツリーと同じく、取得は`refresh`の契機で裏で済ませ、
   * `getChildren`は保持済みの値をすぐ返す（右クリックのコマンドが要素を引けなくなるのを防ぐ）。
   */
  private readonly favorites: BackgroundList<SessionSummary[]>;
  /** リポジトリのルート（Issue #1406）。gitを毎回呼ばないよう、フォルダが変わるまで使い回す。 */
  private repoRoots: Promise<readonly string[]> | undefined;
  /** 直近の一覧をリポジトリで絞ったか。絞っていなければ行の補足へcwdを出す。 */
  private scopedToRepo = false;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly getActivity: (session: SessionSummary) => SessionActivityState | undefined,
    private readonly log: Logger,
    private readonly pinnedStore: PinnedSessionStore = new PinnedSessionStore(),
    /** 開いているリポジトリのルートを求める（Issue #1406）。空なら絞らない。 */
    private readonly resolveRepoRoots: () => Promise<readonly string[]> = async () => [],
  ) {
    this.favorites = new BackgroundList(
      () => this.loadFavorites(),
      () => this.emitter.fire(),
      log,
      '後で実施の一覧',
    );
  }

  /** 一覧を裏で取り直し、取り終えたら描き直す（Issue #1396）。 */
  refresh(): void {
    void this.favorites.reload();
  }

  /** ワークスペースフォルダが変わったとき。ルートを求め直してから取り直す（Issue #1406）。 */
  refreshRepoRoots(): void {
    this.repoRoots = undefined;
    this.refresh();
  }

  /** `delayMs`ごとに1回へまとめて取り直す（Issue #1402）。ファイル監視の契機に使う。 */
  refreshSoon(delayMs: number): void {
    this.favorites.reloadSoon(delayMs);
  }

  /** ビューの表示状態を受ける。見えていない間は取り直さない（Issue #1402）。 */
  setVisible(visible: boolean): void {
    this.favorites.setVisible(visible);
  }

  async getChildren(element?: SessionSummary): Promise<SessionSummary[]> {
    if (element !== undefined) {
      // 葉ノードなので子は無い（グループ化しない、`sessionTreeProvider.ts`と同じ形に統一）
      return [];
    }
    return this.favorites.get();
  }

  private async loadFavorites(): Promise<SessionSummary[]> {
    // 全件一覧（`listSessions`）は使わず、ピン留めしたidだけを引く（Issue #1389）。
    // 全件一覧を`scope: 'all'`で取ると、履歴ビューの範囲で作ったClaude Codeの索引との間で
    // 作り直しと再描画が交互に続き、読み込みが終わらなかった。idで引くので、履歴の
    // 絞り込み範囲に関わらずお気に入りを拾える
    const keys = this.pinnedStore.list();
    const [sessions, roots] = await Promise.all([
      this.providers.getSessions(keys, this.log),
      (this.repoRoots ??= this.resolveRepoRoots()),
    ]);
    // 開いているリポジトリで起動したものだけを出す（Issue #1406）。登録は消さないので、
    // 別のリポジトリのウィンドウではそちらのお気に入りとして出る。フォルダを開いていない
    // ウィンドウは絞る基準が無いので全件を出す。cwdが分からないものは所属を判定できないので出さない
    this.scopedToRepo = roots.length > 0;

    const byKey = new Map(sessions.map((s) => [pinKeyFor(s), s] as const));
    const favorites: SessionSummary[] = [];
    // ストアの並び順（ピンした順、先頭が最も古い）のまま出す。実体が見つからない
    // （削除された等）キーは自然に読み飛ばす
    for (const key of keys) {
      const session = byKey.get(key);
      if (
        session !== undefined &&
        (!this.scopedToRepo || (session.cwd !== undefined && isWithinAnyRoot(session.cwd, roots)))
      ) {
        favorites.push(session);
      }
    }
    return favorites;
  }

  getTreeItem(session: SessionSummary): vscode.TreeItem {
    const activity = this.getActivity(session);
    return buildSessionTreeItem(session, activity, {
      label: session.threadName ?? '(名称未設定)',
      providerLabel: this.providers.get(session.provider)?.label ?? session.provider,
      // リポジトリで絞っていれば履歴の「ワークスペース」表示と同じくcwdを省く。
      // 絞っていなければ別の場所のセッションも混ざるので補足へ足す
      scope: this.scopedToRepo ? 'workspace' : 'all',
      favorite: true,
      // 行末のデコレーション（issue #735）は履歴ビューだけの機能
      withResourceUri: false,
    });
  }

  dispose(): void {
    this.favorites.dispose();
    this.emitter.dispose();
  }
}
