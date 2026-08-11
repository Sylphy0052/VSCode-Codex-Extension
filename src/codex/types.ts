import type { ProviderId } from '../provider/id';

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
  /**
   * `workspace-write` のときに作業フォルダの外で書き込みを許す場所。絶対パスのみ。
   * TUIの `/sandbox-add-read-dir` に相当する。
   */
  sandboxWritableRoots: string[];
  /** `workspace-write` のときにネットワークへ出られるか。 */
  sandboxNetworkAccess: boolean;
  approvalMode: string;
  additionalArgs: string[];
}

export const emptyConfig: CodexConfig = {
  model: '',
  reasoningEffort: '',
  profile: '',
  sandbox: '',
  sandboxWritableRoots: [],
  sandboxNetworkAccess: false,
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

/**
 * 一覧に出す1セッション。
 *
 * Codexでは index と session_meta の合成、Claude Codeでは transcript の要約。
 * どちらのCLIのものかは `provider` で見分ける。
 */
export interface SessionSummary {
  id: string;
  provider: ProviderId;
  threadName: string | undefined;
  updatedAt: string;
  cwd: string | undefined;
  archived: boolean;
  /**
   * 親スレッドのid（issue #34、design.md §14.26）。
   *
   * `thread/list`（Codexのみ）の応答にあるキーで、`normalizeThread`で読む。実測・スキーマの
   * どちらでも値が入っている例を確認できていない（`threadSource !== 'user'`
   * の派生スレッドは一覧から除かれるため。design.md §14.26参照）。切替の代わりに
   * ツリーの親子表示へ使う「保険」の値のため、常に持たせず取れたときだけ入れる。
   */
  parentThreadId?: string | undefined;
}
