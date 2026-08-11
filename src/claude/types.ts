import type { ModelInfo } from '../codex/modelCatalog';

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
 * モデル一覧をCLIから取れなかったときの退避先。CLIのヘルプが案内するエイリアス。
 *
 * 通常は `initialize` の応答（`readModelList`）から取る。ここは表示名も説明も持たない
 * 最低限の一覧であり、**選択肢を空にしないこと**だけを目的にする。
 */
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export function claudeFallbackModels(): ModelInfo[] {
  return CLAUDE_MODEL_ALIASES.map((slug) => ({
    slug,
    displayName: slug,
    description: undefined,
    defaultEffort: undefined,
    // 対応の有無を知らないので、選択肢を消さない側に倒す
    supportsEffort: true,
    efforts: [],
  }));
}

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
