import { describeRedaction, redactCredentials } from '../secondOpinion/redact';
import { buildAdvisorPrompt, parseAdvice } from './advisorPrompt';
import type { GoalEvaluatorInput } from './goalLoop';
import {
  runHeadlessPrompt,
  type HeadlessProvider,
  type HeadlessProviderSetting,
} from './headlessCli';
import { noAdvice, type LoopAdvice, type LoopAdvisorFn } from './loopAdvisor';

/**
 * ループのAdvisor（issue #957）を、CLIのヘッドレス実行として呼ぶ。
 *
 * 起動条件はEvaluator（`goalEvaluatorProcess.ts`）と同じ。ツールを渡さず、利用者の設定も
 * 読ませず、毎ターンstatelessに呼ぶ。**Advisorも作業はしない。**
 */

/** 設定 `agent.chat.loopAdvisor.provider` の値。 */
export type LoopAdvisorProviderSetting = HeadlessProviderSetting;

/** 実際に起動するCLI。 */
export type LoopAdvisorProvider = HeadlessProvider;

export interface LoopAdvisorSettings {
  enabled: boolean;
  provider: LoopAdvisorProviderSetting;
  /** `auto` なら同一プロバイダの軽量モデルに任せる。 */
  model: string;
  timeoutSeconds: number;
  /** 何ターンごとにAdvisorを呼ぶか。 */
  everyNTurns: number;
}

export interface LoopAdvisorDeps {
  provider: LoopAdvisorProvider;
  executable: string;
  model: string;
  timeoutMs: number;
  /** 失敗と、伏せた資格情報の件数の記録先。**プロンプトと応答の本文は出さない。** */
  logWarn?: (message: string) => void;
  logInfo?: (message: string) => void;
}

/**
 * Advisorへ送るプロンプトを組み立て、資格情報らしき文字列を伏せる。
 *
 * 送るのは会話の抜粋であり、Codex CLI / Claude CLIはいずれもモデルサービスへ送る
 * クライアントである。同一マシンで動いていることは、資格情報を素通しにしてよい理由に
 * ならない（セカンドオピニオンと同じ扱い。`secondOpinion/redact.ts`）。業務コードそのものは
 * 伏せない——伏せると指摘が成り立たなくなるうえ、隠したい対象はそこではない。
 *
 * 送信経路と切り離してexportしてあるのは、伏せていることを単体テストで固定するため。
 */
export function redactAdvisorPrompt(
  input: GoalEvaluatorInput,
): ReturnType<typeof redactCredentials> {
  return redactCredentials(buildAdvisorPrompt(input));
}

/**
 * Advisorを1回呼ぶ関数を作る。
 *
 * **呼び出しに失敗しても例外を投げない。** CLIが落ちた・タイムアウトした・JSONが読めない
 * のいずれも「指摘なし」（`noAdvice()`）として返す。Advisorの不調でループ全体が壊れたり
 * 人待ちで止まったりしないようにする。
 */
export function createLoopAdvisor(deps: LoopAdvisorDeps): LoopAdvisorFn {
  return async (input: GoalEvaluatorInput): Promise<LoopAdvice> => {
    const redaction = redactAdvisorPrompt(input);
    const note = describeRedaction(redaction);
    if (note !== undefined) {
      deps.logInfo?.(`Advisorへ送る前に伏せました: ${note}`);
    }
    try {
      const raw = await runHeadlessPrompt(deps, redaction.text);
      if (raw === undefined) {
        deps.logWarn?.('Advisorの呼び出しに失敗しました（指摘なしとして続行します）');
        return noAdvice();
      }
      return parseAdvice(raw);
    } catch (e) {
      deps.logWarn?.(`Advisorの呼び出しで例外が出ました: ${errorMessage(e)}`);
      return noAdvice();
    }
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
