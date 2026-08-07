import { resolveExecutable, type LocateResult, type LocatorDeps } from '../codex/cliLocator';

/** claude実行ファイルを解決する。既定名は `claude`。 */
export function resolveClaudePath(configured: string, deps: LocatorDeps): LocateResult {
  return resolveExecutable(configured, 'claude', deps);
}

/** 設定 > `CLAUDE_CONFIG_DIR` > `~/.claude` の順。 */
export function resolveClaudeHome(configured: string, deps: LocatorDeps): string {
  const trimmed = configured.trim();
  if (trimmed !== '') {
    return trimmed;
  }

  const fromEnv = deps.env['CLAUDE_CONFIG_DIR'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }

  return `${deps.homedir()}/.claude`;
}

export interface ClaudePaths {
  home: string;
  /**
   * `projects/<cwd-slug>/<sessionId>.jsonl` の親。
   * ファイル名がそのままセッションidになるため、一覧はここの走査で作れる。
   */
  projects: string;
}

export function claudePaths(home: string): ClaudePaths {
  return { home, projects: `${home}/projects` };
}
