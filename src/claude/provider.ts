import { nodeLocatorDeps, type LocateResult } from '../codex/cliLocator';
import type { SessionSummary } from '../codex/types';
import { readClaudeConfig } from '../config';
import type { AgentProvider } from '../provider/types';
import type { ListOptions, ListResult } from '../session/sessionStore';
import { resolveClaudePath } from './cliLocator';
import type { ClaudeSessionStore } from './sessionStore';

const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/quickstart';

/**
 * Claude Code CLI をプロバイダ境界に載せたもの。
 *
 * Codexと違い `--session-id` で起動前にidを決められるため、起動と同時に
 * 紐付けが確定する（事後照合が要らない）。
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly installUrl = CLAUDE_INSTALL_URL;
  readonly executableSettingKey = 'claude.executablePath';
  readonly capabilities = {
    fork: true,
    // 会話の途中のターンを指定して分岐する手段がCLIに無い
    forkFromTurn: false,
    // archive/delete に相当するCLIが無い。transcriptを直接消すことはしない
    archive: false,
    delete: false,
  };

  constructor(private readonly store: ClaudeSessionStore) {}

  locate(): LocateResult {
    return resolveClaudePath(readClaudeConfig().executablePath, nodeLocatorDeps);
  }

  async listSessions(options: ListOptions): Promise<ListResult> {
    return this.store.list(options);
  }

  tabTitle(session: Pick<SessionSummary, 'id' | 'threadName'>): string {
    return `Claude: ${session.threadName ?? session.id.slice(0, 8)}`;
  }
}
