export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_MODES = ['untrusted', 'on-request', 'never'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * VSCode設定から読んだ生の値。いずれも空文字は「フラグを渡さない」を意味し、
 * Codex側 config.toml へ委譲する（設計書 §7）。
 */
export interface CodexConfig {
  model: string;
  /** `model_reasoning_effort`。専用フラグが無いため `-c` で渡す。 */
  reasoningEffort: string;
  profile: string;
  sandbox: string;
  approvalMode: string;
  additionalArgs: string[];
}

export const emptyConfig: CodexConfig = {
  model: '',
  reasoningEffort: '',
  profile: '',
  sandbox: '',
  approvalMode: '',
  additionalArgs: [],
};

export type LaunchTarget =
  { kind: 'new' } | { kind: 'resume'; sessionId: string } | { kind: 'fork'; sessionId: string };

/** ~/.codex/session_index.jsonl の1行。 */
export interface SessionIndexEntry {
  id: string;
  threadName: string | undefined;
  updatedAt: string;
}

/** ロールアウトファイル1行目の session_meta。 */
export interface SessionMeta {
  sessionId: string;
  cwd: string;
  timestamp: string;
  originator: string | undefined;
  /** 文字列（"vscode" / "exec"）にもオブジェクト（subagent）にもなりうる。 */
  source: unknown;
  threadSource: string | undefined;
}

/** 一覧に出す1セッション。index と session_meta の合成。 */
export interface SessionSummary {
  id: string;
  threadName: string | undefined;
  updatedAt: string;
  cwd: string | undefined;
  archived: boolean;
}
