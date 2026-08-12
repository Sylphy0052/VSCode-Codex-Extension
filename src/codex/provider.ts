import { readConfig } from '../config';
import type { AgentProvider, LaunchInput, LaunchSpec } from '../provider/types';
import type { ListOptions, ListResult, SessionStore } from '../session/sessionStore';
import { buildLaunchEnv, buildShellArgs } from './argvBuilder';
import { nodeLocatorDeps, resolveCodexPath, type LocateResult } from './cliLocator';
import type { SessionSummary } from './types';

const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/';

/**
 * Codex CLI をプロバイダ境界に載せたもの。
 *
 * 既存のロジック（argvBuilder / cliLocator / SessionStore）はそのまま使い、
 * ここでは「どれを呼ぶか」だけを決める。
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly installUrl = CODEX_INSTALL_URL;
  readonly executableSettingKey = 'codex.executablePath';
  readonly capabilities = {
    fork: true,
    forkFromTurn: true,
    archive: true,
    delete: true,
  };

  constructor(private readonly store: SessionStore) {}

  locate(): LocateResult {
    return resolveCodexPath(readConfig().executablePath, nodeLocatorDeps);
  }

  async listSessions(options: ListOptions): Promise<ListResult> {
    return this.store.list(options);
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    const { args, warnings } = buildShellArgs({
      target: input.target,
      cwd: input.cwd,
      config: readConfig().codex,
    });
    return {
      args,
      env: buildLaunchEnv(input.tag),
      // fork は新しいセッションになるため、id は起動後の紐付けで確定させる
      sessionId: input.target.kind === 'resume' ? input.target.sessionId : undefined,
      warnings,
    };
  }

  tabTitle(session: Pick<SessionSummary, 'id' | 'threadName'>): string {
    return `Codex: ${session.threadName ?? session.id.slice(0, 8)}`;
  }
}
