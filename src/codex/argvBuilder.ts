import type { CodexConfig } from './types';

/** Codexのセッションid。UUID形式以外は受け付けない（引数注入の防止）。 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Codexの保護を両方とも外す組み合わせ。起動前に確認ダイアログを出す（設計書 §7）。
 *
 * - `bypassApprovalsAndSandbox`: 単独で該当する（issue #222）。他の3つと違って
 *   サンドボックス自体を張らないため、`sandbox` に何が入っていても意味を持たない。
 * - `sandbox: danger-full-access` かつ `approvalMode: never`: 承認要求そのものが出ない。
 * - `sandbox: danger-full-access` かつ `approvalsReviewer: auto_review`: 承認要求は出るが、
 *   人ではなくsubagentが答える。制限なしのサンドボックスと組むと、機械の判定だけで
 *   マシン全体への操作が通る。`never` と同じ重さで扱う。
 */
export function isUnsafeCombination(config: CodexConfig): boolean {
  return describeUnsafeCombination(config) !== undefined;
}

/**
 * 保護を外した組み合わせが何をもたらすかの説明。安全なら `undefined`。
 *
 * 確認ダイアログの本文に使う。**何が起きるか**を書く（設定キー名を並べるだけでは、
 * 押してよいかを判断できない）。当てはまるものが複数ある場合は、実際に効くほうを
 * 述べる（`bypass` は他の指定を打ち消して勝つ。`turnPolicyFor` 参照）。
 */
export function describeUnsafeCombination(config: CodexConfig): string | undefined {
  if (config.bypassApprovalsAndSandbox) {
    return 'サンドボックスを張らず、確認も一切求めずに実行します。ファイルの書き換えもネットワークも制限されません。';
  }
  if (config.sandbox !== 'danger-full-access') {
    return undefined;
  }
  if (config.approvalMode === 'never') {
    return '制限なしのサンドボックスで、承認を一切求めずに実行します。';
  }
  if (config.approvalsReviewer === 'auto_review') {
    return '制限なしのサンドボックスで、承認をCodex内部のsubagentが自動で判定します。人には回りません。';
  }
  return undefined;
}
