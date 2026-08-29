import {
  buildClaudeHeadlessArgs,
  buildCodexHeadlessArgs,
  resolveHeadlessProvider,
  runHeadlessPrompt,
  type HeadlessProvider,
  type HeadlessProviderSetting,
} from './headlessCli';
import type { GoalEvaluation, GoalEvaluator, GoalEvaluatorInput } from './goalLoop';
import { buildEvaluatorPrompt, indeterminate, parseEvaluation } from './goalPrompt';

/**
 * ゴール駆動ループ（issue #892）のEvaluatorを、CLIのヘッドレス実行として呼ぶ。
 *
 * 呼び出しは**毎ターンstatelessな新規実行**にする。前回の評価セッションをresumeすると、
 * 過去の自分の判断へのアンカリング（一度「未達」と言った手前、達成を認めにくくなる）と
 * contextの肥大化が起きる。判定はその時点の証拠だけを見て行わせる。
 *
 * Evaluatorには**ツールを渡さない**。Evaluatorが自分でコマンドを実行して直しに行った
 * 瞬間に、作業役と評価役を分けた意味が消える。
 *
 * 起動そのもの（引数の組み立てとプロセスの実行）は`headlessCli.ts`にある。Advisor
 * （issue #957）も同じ条件で呼ぶため、共通部として切り出してある。
 */

export { AUTO_CLAUDE_MODEL, readClaudeResult } from './headlessCli';

/** 設定 `agent.chat.goalEvaluator.provider` の値。 */
export type GoalEvaluatorProviderSetting = HeadlessProviderSetting;

/** 実際に起動するCLI。 */
export type GoalEvaluatorProvider = HeadlessProvider;

export interface GoalEvaluatorSettings {
  provider: GoalEvaluatorProviderSetting;
  /** `auto` なら同一プロバイダの軽量モデルに任せる。 */
  model: string;
  timeoutSeconds: number;
  maxIndeterminate: number;
}

/** どちらのCLIでEvaluatorを動かすか決める。詳細は`resolveHeadlessProvider`。 */
export function resolveEvaluatorProvider(
  setting: GoalEvaluatorProviderSetting,
  host: GoalEvaluatorProvider,
): GoalEvaluatorProvider {
  return resolveHeadlessProvider(setting, host);
}

/** Claude CLIの起動引数。詳細は`buildClaudeHeadlessArgs`。 */
export function buildClaudeEvaluatorArgs(model: string): string[] {
  return buildClaudeHeadlessArgs(model);
}

/** Codex CLIの起動引数。詳細は`buildCodexHeadlessArgs`。 */
export function buildCodexEvaluatorArgs(model: string, outputFile: string): string[] {
  return buildCodexHeadlessArgs(model, outputFile);
}

export interface GoalEvaluatorDeps {
  provider: GoalEvaluatorProvider;
  executable: string;
  model: string;
  timeoutMs: number;
  /** 失敗の記録先。判定そのものは`indeterminate`へ倒すため、ここでは記録だけ行う。 */
  logWarn?: (message: string) => void;
}

/**
 * Evaluatorを1回呼ぶ関数を作る。
 *
 * **呼び出しに失敗しても例外を投げない。** CLIが落ちた・タイムアウトした・JSONが読めない
 * のいずれも`indeterminate`として返し、続けるか止めるかの判断は`LoopController`へ委ねる。
 * 評価の失敗でループ全体が壊れると、それまでの作業ごと失われる。
 */
export function createGoalEvaluator(deps: GoalEvaluatorDeps): GoalEvaluator {
  return async (input: GoalEvaluatorInput): Promise<GoalEvaluation> => {
    const prompt = buildEvaluatorPrompt(input);
    try {
      const raw = await runHeadlessPrompt(deps, prompt);
      if (raw === undefined) {
        return indeterminate('Evaluatorの呼び出しに失敗しました');
      }
      return parseEvaluation(raw);
    } catch (e) {
      deps.logWarn?.(`Evaluatorの呼び出しで例外が出ました: ${errorMessage(e)}`);
      return indeterminate('Evaluatorの呼び出しで例外が出ました');
    }
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
