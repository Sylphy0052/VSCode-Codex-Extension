import { readClaudeConfig, readConfig, readGoalEvaluatorConfig } from '../config';
import {
  createGoalEvaluator,
  resolveEvaluatorProvider,
  type GoalEvaluatorProvider,
} from '../loop/goalEvaluatorProcess';
import type { GoalLoopOptions } from '../loop/loopController';
import type { Logger } from '../log';

/**
 * ゴール駆動ループ（issue #892）のEvaluatorを、設定から組み立てる。
 *
 * `LoopController`と`goalEvaluatorProcess`はどちらも`vscode`に依存しないため、設定の
 * 読み出しと実行ファイルの解決はこの層（view）が受け持つ。`loopEngineering`の設定を
 * view側で読んで渡しているのと同じ流儀。
 *
 * `host`は会話しているCLI。設定が`inherit`（既定）のときはこれをそのまま使う。
 */
export function createGoalLoopOptions(host: GoalEvaluatorProvider, log: Logger): GoalLoopOptions {
  const settings = readGoalEvaluatorConfig();
  const provider = resolveEvaluatorProvider(settings.provider, host);
  // 会話しているのと別のCLIを指定されることがあるため、実行ファイルは判定先に合わせて読む
  const executable =
    provider === 'claude' ? readClaudeConfig().executablePath : readConfig().executablePath;
  return {
    evaluate: createGoalEvaluator({
      provider,
      executable,
      model: settings.model,
      timeoutMs: settings.timeoutSeconds * 1000,
      logWarn: (message) => log.warn(message),
    }),
    maxIndeterminate: settings.maxIndeterminate,
  };
}
