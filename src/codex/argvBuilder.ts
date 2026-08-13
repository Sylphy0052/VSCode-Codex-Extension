import { isEffortToken } from './modelCatalog';
import {
  APPROVAL_MODES,
  CodexConfig,
  isApprovalsReviewer,
  LaunchTarget,
  SANDBOX_MODES,
  type ApprovalMode,
  type SandboxMode,
} from './types';

export interface BuildInput {
  target: LaunchTarget;
  /**
   * `-C` に渡す作業ディレクトリ。絶対パスのみ受け付ける。
   * `-C` はプロセスのcwdより優先されるため（設計書 §5.2）、常にこちらを正とする。
   * resume/fork では「セッションが記録しているcwd」を渡すこと。現在のワークスペースを
   * 渡すと、別プロジェクトのセッションを黙って移動させてしまう。
   */
  cwd: string | undefined;
  config: CodexConfig;
}

export interface BuildResult {
  /** createTerminal の shellArgs にそのまま渡す。実行ファイル名は含まない。 */
  args: string[];
  /** 無視した設定値。呼び出し側でログに残す。 */
  warnings: string[];
}

/** Codexのセッションid。UUID形式以外は受け付けない（引数注入の防止）。 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

function isSandboxMode(value: string): value is SandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(value);
}

function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}


/**
 * 設定と起動対象から codex の起動引数を組み立てる。
 *
 * シェルを経由せず shellArgs として渡す前提のため、クォートやエスケープは行わない
 * （設計書 §5.2）。値の妥当性検証のみを担う。
 */
export function buildShellArgs(input: BuildInput): BuildResult {
  const { target, cwd, config } = input;
  const args: string[] = [];
  const warnings: string[] = [];

  if (target.kind !== 'new') {
    if (!isSessionId(target.sessionId)) {
      throw new Error(`不正なsession id: ${target.sessionId}`);
    }
    args.push(target.kind, target.sessionId);
  }

  if (cwd !== undefined) {
    if (!cwd.startsWith('/')) {
      warnings.push(`cwdが絶対パスではないため -C を渡しません: ${cwd}`);
    } else {
      args.push('-C', cwd);
    }
  }

  if (config.model !== '') {
    args.push('-m', config.model);
  }

  if (config.reasoningEffort !== '') {
    // 専用フラグが無いため設定上書きで渡す。値はTOMLとして解釈できなければ文字列扱いになる。
    if (isEffortToken(config.reasoningEffort)) {
      args.push('-c', `model_reasoning_effort=${config.reasoningEffort}`);
    } else {
      warnings.push(`codex.reasoningEffort の値が不正なため無視します: ${config.reasoningEffort}`);
    }
  }

  if (config.profile !== '') {
    args.push('-p', config.profile);
  }

  if (config.sandbox !== '') {
    if (isSandboxMode(config.sandbox)) {
      args.push('-s', config.sandbox);
    } else {
      warnings.push(`codex.sandbox の値が不正なため無視します: ${config.sandbox}`);
    }
  }

  if (config.approvalMode !== '') {
    if (isApprovalMode(config.approvalMode)) {
      args.push('-a', config.approvalMode);
    } else {
      warnings.push(`codex.approvalMode の値が不正なため無視します: ${config.approvalMode}`);
    }
  }

  if (config.approvalsReviewer !== '') {
    if (isApprovalsReviewer(config.approvalsReviewer)) {
      // `user` はCodex側の既定と同じなので、フラグを増やさない。
      // 専用フラグがあるのは自動レビュー側だけ（`--approve-for-me`。0.147.0で確認）。
      if (config.approvalsReviewer === 'auto_review') {
        args.push('--approve-for-me');
      }
    } else {
      warnings.push(
        `codex.approvalsReviewer の値が不正なため無視します: ${config.approvalsReviewer}`,
      );
    }
  }

  for (const extra of config.additionalArgs) {
    if (typeof extra !== 'string' || extra === '') {
      warnings.push('codex.additionalArgs に空または非文字列の要素があるため無視します');
      continue;
    }
    args.push(extra);
  }

  return { args, warnings };
}

/**
 * Codexの保護を両方とも外す組み合わせ。起動前に確認ダイアログを出す（設計書 §7）。
 *
 * - `sandbox: danger-full-access` かつ `approvalMode: never`: 承認要求そのものが出ない。
 * - `sandbox: danger-full-access` かつ `approvalsReviewer: auto_review`: 承認要求は出るが、
 *   人ではなくsubagentが答える。制限なしのサンドボックスと組むと、機械の判定だけで
 *   マシン全体への操作が通る。`never` と同じ重さで扱う。
 */
export function isUnsafeCombination(config: CodexConfig): boolean {
  if (config.sandbox !== 'danger-full-access') {
    return false;
  }
  return config.approvalMode === 'never' || config.approvalsReviewer === 'auto_review';
}

/** 端末に渡す環境変数。一意タグで session_id を確定的に紐付ける（設計書 §9.1）。 */
export function buildLaunchEnv(tag: string): Record<string, string> {
  return { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: tag };
}
