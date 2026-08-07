/** `claude --permission-mode` が受け付ける値（CLI 2.1系）。 */
export const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** `claude --effort` が受け付ける値。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/**
 * VSCode設定から読んだ生の値。
 * Codex側と同じく、空文字は「そのフラグを渡さない」を意味し `~/.claude/settings.json`
 * へ委譲する（設計書 §7）。
 */
export interface ClaudeConfig {
  model: string;
  effort: string;
  permissionMode: string;
  additionalArgs: string[];
}

export const emptyClaudeConfig: ClaudeConfig = {
  model: '',
  effort: '',
  permissionMode: '',
  additionalArgs: [],
};

/** transcript から読み取ったセッションの素性。 */
export interface TranscriptMeta {
  sessionId: string;
  cwd: string;
  /** 表示名の元になる最初のユーザー発言。Claude Codeに要約名の概念が無いため。 */
  firstUserText: string | undefined;
  /** 最初に見つかったエントリの時刻（ISO8601）。 */
  startedAt: string | undefined;
  gitBranch: string | undefined;
}
