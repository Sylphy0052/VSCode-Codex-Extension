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

/**
 * CLI側のデバッグログ（`~/.claude/debug/`）を開くときに試す候補パスを、優先順で返す
 * （issue #205、design.md §14.39）。
 *
 * 本体の実測（issue #205のコメント、CLI 2.1.227）によれば、ログは`/debug`を送る前から
 * セッション開始時点で既に`<claudeHome>/debug/<sessionId>.txt`へ書かれており、
 * `<claudeHome>/debug/latest`はCLI全体で最後に書かれたログを指すシンボリックリンク。
 * つまり「有効にする」操作は要らず、このパスを直接開けばよい。
 *
 * `threadId`（このパネルのセッションid）が分かっていれば、そのセッション専用のログを
 * 最優先候補にする。`latest`は他のセッションで上書きされうるため、複数のClaude Code画面を
 * 同時に開いている場合に「いま見ている会話のログではないものが開く」ズレを避ける狙い。
 * `threadId`がまだ判っていない（セッション開始直後で`system/init`未受信）場合や、CLIの
 * バージョン差でセッション別ファイルの命名が変わっている場合に備え、`latest`も次点の
 * 候補として必ず含める。
 *
 * 呼び出し側（`claudeChatView.ts`の`openDebugLog`）が先頭から順に開けるか試し、
 * 開けた最初の1件を使う。全滅した場合（ログがまだ無い等）は空配列ではなく`latest`まで
 * 含めた配列を返す（存在確認はここではしない。ファイルI/Oは呼び出し側の責務に留め、
 * この関数は純粋な文字列組み立てだけにしてテストを軽くする）。
 */
export function debugLogCandidates(claudeHome: string, threadId: string | undefined): string[] {
  const debugDir = `${claudeHome}/debug`;
  const candidates: string[] = [];
  if (threadId !== undefined && threadId.trim() !== '') {
    candidates.push(`${debugDir}/${threadId}.txt`);
  }
  candidates.push(`${debugDir}/latest`);
  return candidates;
}
