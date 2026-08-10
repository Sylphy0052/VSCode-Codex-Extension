/**
 * Codex画面のPlan mode。
 *
 * app-serverには**Plan modeそのものが無い**。`ThreadSettings` に `collaborationMode`
 * （`plan` / `default`）はあるが、それを設定するメソッドは92あるClientRequestのどれにも
 * 無く、`ModeKind` の説明も「TUIが起動するときの初期モード」となっている。
 *
 * 代わりに `turn/start` の `sandboxPolicy` と `approvalPolicy` で作る。読み取り専用の
 * サンドボックスに落とせば、**プロンプトではなく権限でファイル変更を止められる**
 * （実測: 「plan.txtを作れ」に対し「権限が読み取り専用のため作成できません」と答え、
 * ファイルは作られなかった）。承認を `never` にするのは、書き込みの失敗がサンドボックス
 * 脱出の承認要求へ化けて、そこで許可すると読み取り専用でなくなるため。
 *
 * TUIの `/plan` は計画を促す指示も入れるが、`turn/start` に指示を差し込む口は無い
 * （`developerInstructions` は `thread/start` のみ）。**指示は足さない**。ユーザーが
 * 送った文面をそのまま送る。
 */

/** ターンへ載せる権限。app-serverの形をそのまま持つ。 */
export interface TurnPolicy {
  /** `AskForApproval`。文字列にもオブジェクトにもなる。 */
  approvalPolicy: unknown;
  /** `SandboxPolicy`。`{ type: 'workspaceWrite', ... }` のような形。 */
  sandboxPolicy: unknown;
}

/**
 * Plan mode 中の権限。
 *
 * `turn/start` の指定は「このターン以降」に効く。つまり一度これを送ったら、
 * 抜けるときに明示的に戻さないと読み取り専用のままになる。
 */
export const PLAN_POLICY: TurnPolicy = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'readOnly' },
};

/**
 * `thread/start` / `thread/resume` の応答から、いま効いている権限を読む。
 *
 * Plan modeを抜けるときの戻し先になる。設定値から組み立て直すと、設定が空
 * （CLIのconfig.tomlへ委譲）のときに推測することになるため、応答の値を控える。
 */
export function readTurnPolicy(result: unknown): TurnPolicy | undefined {
  const root = asObject(result);
  const approvalPolicy = root?.['approvalPolicy'];
  const sandboxPolicy = root?.['sandbox'];
  if (approvalPolicy === undefined || sandboxPolicy === undefined) {
    return undefined;
  }
  return { approvalPolicy, sandboxPolicy };
}

/**
 * そのターンへ載せる権限を決める。`undefined` なら何も載せない。
 *
 * @param planMode いまPlan modeか
 * @param baseline 開始時に控えた権限。Plan modeを抜けるときの戻し先
 * @param overridden 一度でもPlan modeの権限を送ったか。送っていれば明示的に戻す必要がある
 */
export function turnPolicyFor(
  planMode: boolean,
  baseline: TurnPolicy | undefined,
  overridden: boolean,
): TurnPolicy | undefined {
  if (planMode) {
    return PLAN_POLICY;
  }
  // 送っていなければ触らない。スレッド開始時の権限がそのまま効いている
  return overridden ? baseline : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
