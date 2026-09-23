import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import { readConfig, workspaceFolderPaths } from '../config';
import type { Logger } from '../log';
import type { ProviderRegistry } from '../provider/registry';
import { PinnedSessionStore, pinKeyFor } from '../util/pinnedSessions';
import { buildSessionTreeItem } from './sessionTreeProvider';
import type { SessionActivityState } from './sessionActivity';

/**
 * お気に入りビュー（Issue #1366）。履歴ビューの「ピン留め」グループを置き換える。
 *
 * セッションの葉ノードは`sessionTreeProvider.ts`と同じ理由で`SessionSummary`をそのまま使う
 * （包むと`view/item/context`から呼ぶコマンドへラッパーが渡ってしまう。issue #236参照）。
 * グループ化は行わない（お気に入りは元々少数のはずで、日付・作業ディレクトリで畳む意味が薄い）。
 *
 * 履歴の表示範囲（ワークスペース／すべて）や絞り込みに関わらず、常に全ワークスペースから
 * 拾う（`scope: 'all'`固定。Issue #1366の受入基準）。
 */
export class FavoritesTreeProvider implements vscode.TreeDataProvider<SessionSummary> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly getActivity: (session: SessionSummary) => SessionActivityState | undefined,
    private readonly log: Logger,
    private readonly pinnedStore: PinnedSessionStore = new PinnedSessionStore(),
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: SessionSummary): Promise<SessionSummary[]> {
    if (element !== undefined) {
      // 葉ノードなので子は無い（グループ化しない、`sessionTreeProvider.ts`と同じ形に統一）
      return [];
    }

    const config = readConfig();
    // 履歴の絞り込み範囲に関わらず常に全ワークスペースから拾う（Issue #1366の受入基準）
    const sessions = await this.providers.listSessions(
      {
        scope: 'all',
        workspaceFolders: workspaceFolderPaths(),
        maxEntries: config.historyMaxEntries,
      },
      this.log,
    );

    const byKey = new Map(sessions.map((s) => [pinKeyFor(s), s] as const));
    const favorites: SessionSummary[] = [];
    // ストアの並び順（ピンした順、先頭が最も古い）のまま出す。実体が一覧から消えた
    // （アーカイブ済みが対象外の一覧に落ちた・削除された等）キーは自然に読み飛ばす
    for (const key of this.pinnedStore.list()) {
      const session = byKey.get(key);
      if (session !== undefined) {
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
      // お気に入りは常に全ワークスペースから出すため、cwdは常に補足へ足す
      scope: 'all',
      favorite: true,
      // 行末のデコレーション（issue #735）は履歴ビューだけの機能
      withResourceUri: false,
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
