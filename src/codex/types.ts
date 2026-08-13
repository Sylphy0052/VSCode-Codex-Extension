import type { ProviderId } from '../provider/id';

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_MODES = ['untrusted', 'on-request', 'never'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * 承認要求を誰へ回すか（`--approve-for-me` / `ThreadStartParams.approvalsReviewer`）。
 *
 * `approvalMode`（いつ承認を求めるか）とは**別の軸**であり、混ぜてはならない。
 * `auto_review` は人ではなくCodex内部のsubagentが承認要求を判定する。スキーマの説明では
 * 「sandbox脱出・ネットワーク遮断・MCPの承認・ARCエスカレーションを、文脈を集めた上で
 * リスク基準にもとづき承認/拒否する」。
 *
 * legacyの `guardian_subagent` は互換のため相手が受け付けるだけの値なので、
 * こちらからは選ばせない（受け取る側の話であり、設定として提示する意味が無い）。
 */
export const APPROVALS_REVIEWERS = ['user', 'auto_review'] as const;
export type ApprovalsReviewer = (typeof APPROVALS_REVIEWERS)[number];

/**
 * 設定から読んだ値が `ApprovalsReviewer` かを確かめる。
 *
 * 起動引数（`argvBuilder`）とapp-serverへの要求（`chatSession`）の両方が境界になるため、
 * ここに置いて同じ判定を使う。
 */
export function isApprovalsReviewer(value: string): value is ApprovalsReviewer {
  return (APPROVALS_REVIEWERS as readonly string[]).includes(value);
}

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
  /**
   * 承認要求の回し先（`APPROVALS_REVIEWERS`）。空ならCodex側の既定（`user`）へ委譲する。
   * 端末起動では `auto_review` のときだけ `--approve-for-me` を渡す。
   */
  approvalsReviewer: string;
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
  approvalsReviewer: '',
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
