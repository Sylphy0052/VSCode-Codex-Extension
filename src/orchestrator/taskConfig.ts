import {
  clampAutoApprove,
  clampClaudePermissionMode,
  clampCodexApprovalMode,
  clampSandbox,
  type WorkflowTask,
} from './workflow';
import type { TaskSessionConfig } from './taskSession';

/**
 * タスクごとの有効な設定を組み立てる、唯一の入口（design.md §16.16）。
 *
 * #52のセキュリティ監査指摘: `clampSandbox` / `clampCodexApprovalMode` /
 * `clampClaudePermissionMode` / `clampAutoApprove` は「呼び出し側が使う」という
 * JSDocの約束だけで、呼び忘れを防ぐ強制力がコンパイラにもテストにも無かった。
 *
 * `runner.ts` はタスクのセッションを開くとき、**この関数の戻り値以外から**
 * `TaskSessionConfig` / `sandbox` / `autoApprove` を組み立てない
 * （`worktree.ts` の `createWorktree` / `removeWorktree` を非exportにして
 * `WorktreeCreationQueue` だけを入口にしたのと同じ「入口を1つに絞る」構造）。
 * クランプを経由しない経路が無いことは `test/unit/taskConfig.test.ts` と
 * `test/unit/runner.test.ts`（実際にセッションを開始する経路を通した確認）で担保する。
 */

/** 拡張機能側の現在の設定値。クランプの基準（安全側の上限）になる。 */
export interface ExtensionSafetyBaseline {
  /** `codex.sandbox`。空文字はCodex CLI側（config.toml）への委譲を意味する。 */
  codexSandbox: string;
  /** `codex.approvalMode`。 */
  codexApprovalMode: string;
  /** `claude.permissionMode`。 */
  claudePermissionMode: string;
  /** machineスコープ設定 `agent.workflows.allowAutoApprove`。 */
  allowAutoApprove: boolean;
}

export interface EffectiveTaskConfig {
  /** `TaskSessionHost.openTaskSession` へそのまま渡せる、クランプ済みの設定。 */
  config: TaskSessionConfig;
  /** クランプ済みの `sandbox`（Codexのみ意味を持つ。Claudeタスクでは空文字）。 */
  sandbox: string;
  /** クランプ済みの `autoApprove`。 */
  autoApprove: boolean;
  /** 緩める指定を無視した等の警告。呼び出し側がログ・Viewへ出す。 */
  warnings: string[];
}

/**
 * タスクの `sandbox` / `approvalMode` / `autoApprove` を拡張機能側の設定より
 * 緩められないようクランプし、`model` / `effort` はそのまま通す（design.md §16.16の表）。
 */
export function buildEffectiveTaskConfig(
  task: Pick<
    WorkflowTask,
    'provider' | 'model' | 'effort' | 'approvalMode' | 'sandbox' | 'autoApprove'
  >,
  baseline: ExtensionSafetyBaseline,
): EffectiveTaskConfig {
  const warnings: string[] = [];

  const approvalBaseline =
    task.provider === 'claude' ? baseline.claudePermissionMode : baseline.codexApprovalMode;
  const approvalResult =
    task.provider === 'claude'
      ? clampClaudePermissionMode(approvalBaseline, task.approvalMode ?? '')
      : clampCodexApprovalMode(approvalBaseline, task.approvalMode ?? '');
  if (approvalResult.warning !== undefined) {
    warnings.push(approvalResult.warning);
  }

  // sandboxはCodex固有の概念（Claudeには起動時のフラグが無い）。Claudeタスクでは
  // クランプそのものが無意味なので空文字にする（`toClaudeConfig` はinput.sandboxを読まない）
  let sandbox = '';
  if (task.provider === 'codex') {
    const sandboxResult = clampSandbox(baseline.codexSandbox, task.sandbox ?? '');
    sandbox = sandboxResult.value;
    if (sandboxResult.warning !== undefined) {
      warnings.push(sandboxResult.warning);
    }
  }

  const autoApproveResult = clampAutoApprove(task.autoApprove, baseline.allowAutoApprove);
  if (autoApproveResult.warning !== undefined) {
    warnings.push(autoApproveResult.warning);
  }

  // bypassPermissionsでは can_use_tool 自体が発行されないため、classifyApprovalRequest /
  // autoApprove / escalate / allow が一度も呼ばれず、#54の危険判定が丸ごと無意味になる
  // （レビュー指摘: critical 3）。YAMLがapprovalModeを一切指定しない場合、
  // clampToSaferは拡張機能側の値をそのまま継承する（yamlValue === ''の早期return）ため、
  // baseline自体がbypassPermissionsだと実効値も無警告でbypassPermissionsになる。
  // ここでは警告を出すだけに留め、実際にタスクを開始させない最終防御はrunner.ts側で行う
  // （純粋関数であるこの関数はI/Oも状態遷移も持たないため）。
  if (task.provider === 'claude' && approvalResult.value === 'bypassPermissions') {
    warnings.push(
      'Claudeタスクの実効approvalModeがbypassPermissionsです。この設定では危険判定（承認）が' +
        '一切働かないため、タスクは開始されません',
    );
  }

  return {
    config: {
      model: task.model ?? '',
      effort: task.effort ?? '',
      approvalMode: approvalResult.value,
    },
    sandbox,
    autoApprove: autoApproveResult.value,
    warnings,
  };
}
