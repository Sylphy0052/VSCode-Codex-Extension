import type { SessionSummary } from '../codex/types';
import type { Logger } from '../log';
import type { ListOptions } from '../session/sessionStore';
import type { ProviderId } from './id';
import type { AgentProvider } from './types';

/**
 * 利用可能なCLIエージェントの束。
 *
 * 一覧はプロバイダを跨いで1本にまとめる。片方の一覧構築が失敗しても、
 * もう片方の動作は妨げない。
 */
export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, AgentProvider>();

  constructor(providers: readonly AgentProvider[]) {
    for (const provider of providers) {
      this.byId.set(provider.id, provider);
    }
  }

  get(id: ProviderId): AgentProvider | undefined {
    return this.byId.get(id);
  }

  all(): AgentProvider[] {
    return [...this.byId.values()];
  }

  /**
   * 全プロバイダのセッションを更新時刻の新しい順に1本へまとめる。
   * 片方が失敗しても、もう片方の一覧は出す。
   *
   * 実行ファイルが解決できるかどうかでプロバイダを絞らない。一覧の構築は
   * `SessionStore.list()` のファイル読みだけで完結し、CLIプロセスを要さない
   * （`thread/list` が使えるときに使うだけで、使えなければ退避する。design.md §5）。
   * CLIを入れ替えた・PATHから外れた・設定を書き換えた、といった理由で解決できなく
   * なっただけで過去の履歴ごと消えるのは、履歴の見え方として正しくない（issue #164）。
   * 解決できないCLIのセッションを開こうとした場合は、開く時点で
   * `resolveExecutable()`（`src/extension.ts`）が導入手順への導線を出す。
   */
  async listSessions(options: ListOptions, log: Logger): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];

    for (const provider of this.all()) {
      try {
        const result = await provider.listSessions(options);
        if (result.skippedIndexLines > 0 || result.unresolved > 0) {
          log.warn(
            `${provider.label} の一覧構築: 壊れた行 ${result.skippedIndexLines} / 実体なし ${result.unresolved}`,
          );
        }
        // thread/listが使えず（未接続・空応答・エラー）ファイル読みへ退避した場合、
        // 黙って表示が変わらないよう理由を出力パネルに残す（issue #45）
        if (result.threadListFallbackReason !== undefined) {
          log.warn(
            `${provider.label} の一覧構築: thread/list を使わずファイル読みへ退避しました (${result.threadListFallbackReason})`,
          );
        }
        sessions.push(...result.sessions);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.error(`${provider.label} の一覧を構築できませんでした: ${reason}`);
      }
    }

    return sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, options.maxEntries));
  }
}
