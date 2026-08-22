import type { Logger } from '../log';
import { sanitizeForLog } from '../orchestrator/sanitize';
import type { SessionStore } from './sessionStore';

/**
 * 起動時にメタキャッシュ（`SessionMeta` の永続キャッシュ）を掃除する（issue #382）。
 *
 * 既定経路である thread/list 成功時（`SessionStore.list` → `buildFromThreadList`）は
 * キャッシュ削除処理を一切通らないため、thread/list が使える環境では実体が消えた
 * セッションの `SessionMeta` が globalState へ溜まり続ける。`pruneCache()` 自体は
 * 以前から実装されていたが、`src` 配下のどこからも呼ばれていなかった
 * （`SessionStore.pruneCache` のJSDoc参照）。
 *
 * 呼び出し側（`activate()`）は必ず `void` で投げっぱなしにする。ここでは
 * `pruneCache()` が失敗しても例外を外へ出さず、`activate()` を妨げない。
 *
 * `pruneCache()`は`locateRollouts()`のスナップショットと現在状態の間にウィンドウが
 * あるため、起動直後に作られたセッションのメタを消しうる。ただし対象はメタキャッシュ
 * のみで実ファイルは削除せず、キャッシュミスは`resolveMeta`が読み直して自己修復する
 * ため実害はない。この関数を実ファイル削除やアーカイブ処理へ転用しないこと。
 */
export async function pruneMetaCacheOnStartup(
  store: Pick<SessionStore, 'pruneCache'>,
  persistIfChanged: (removed: number) => Promise<void>,
  log: Logger,
): Promise<void> {
  try {
    const removed = await store.pruneCache();
    if (removed > 0) {
      await persistIfChanged(removed);
    }
  } catch (e) {
    // 例外のメッセージにはNode.jsのfsエラーが埋め込む絶対パス（OSユーザー名を含む）や
    // 制御文字が入りうるため、そのままログへ流さず`sanitizeForLog`を通す（Issue #433）。
    log.warn(`起動時のメタキャッシュ掃除に失敗しました: ${sanitizeForLog(String(e))}`);
  }
}
