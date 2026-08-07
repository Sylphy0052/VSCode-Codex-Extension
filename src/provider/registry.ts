import type { SessionSummary } from '../codex/types';
import type { Logger } from '../log';
import type { ListOptions } from '../session/sessionStore';
import type { ProviderId } from './id';
import type { AgentProvider } from './types';

/**
 * 利用可能なCLIエージェントの束。
 *
 * 一覧はプロバイダを跨いで1本にまとめる。実行ファイルが見つからない
 * プロバイダは黙って除くだけで、他方の動作は妨げない。
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

  /** 実行ファイルを解決できたプロバイダだけ。 */
  available(): AgentProvider[] {
    return this.all().filter((p) => p.locate().ok);
  }

  /**
   * 全プロバイダのセッションを更新時刻の新しい順に1本へまとめる。
   * 片方が失敗しても、もう片方の一覧は出す。
   */
  async listSessions(options: ListOptions, log: Logger): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];

    for (const provider of this.available()) {
      try {
        const result = await provider.listSessions(options);
        if (result.skippedIndexLines > 0 || result.unresolved > 0) {
          log.warn(
            `${provider.label} の一覧構築: 壊れた行 ${result.skippedIndexLines} / 実体なし ${result.unresolved}`,
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
