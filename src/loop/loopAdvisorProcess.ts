import { describeRedaction, redactCredentials } from '../secondOpinion/redact';
import { buildAdvisorPrompt, parseAdvice } from './advisorPrompt';
import type { GoalEvaluatorInput } from './goalLoop';
import {
  runHeadlessPromptDetailed,
  type HeadlessProvider,
  type HeadlessProviderSetting,
} from './headlessCli';
import {
  advisorFailed,
  advisorOk,
  type LoopAdvisorFn,
  type LoopAdvisorResult,
} from './loopAdvisor';

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
 * のいずれも`failed`として返し、ループは続行させる。Advisorの不調でループ全体が壊れたり
 * 人待ちで止まったりしないようにする。
 *
 * ただし失敗を「指摘なし」へは倒さない（issue #964）。**動いたうえで指摘が無かった周と、
 * 一度も動けなかった周を、呼び出し側が区別できるようにする。**
 */
export function createLoopAdvisor(deps: LoopAdvisorDeps): LoopAdvisorFn {
  return async (input: GoalEvaluatorInput, signal?: AbortSignal): Promise<LoopAdvisorResult> => {
    const redaction = redactAdvisorPrompt(input);
    const note = describeRedaction(redaction);
    if (note !== undefined) {
      deps.logInfo?.(`Advisorへ送る前に伏せました: ${note}`);
    }
    try {
      // 打ち切りの合図はターンごとに変わるため、作り置きした`deps`ではなくここで足す
      const outcome = await runHeadlessPromptDetailed(
        { ...deps, ...(signal === undefined ? {} : { signal }) },
        redaction.text,
      );
      if (!outcome.ok) {
        if (signal?.aborted === true) {
          // ループを止めたことによる打ち切り。CLIの不調ではないので警告として残さない
          return advisorFailed(outcome.reason);
        }
        deps.logWarn?.(
          `Advisorの呼び出しに失敗しました（${outcome.reason}。今回は評価なしとして続行します）`,
        );
        return advisorFailed(outcome.reason);
      }
      const advice = parseAdvice(outcome.text);
      if (advice === undefined) {
        // 応答本文はログへ出さない（プロンプトと同じく資格情報が混ざりうる）
        deps.logWarn?.(
          'Advisorの応答をJSONとして読めませんでした（今回は評価なしとして続行します）',
        );
        return advisorFailed('invalid-response');
      }
      return advisorOk(advice);
    } catch (e) {
      deps.logWarn?.(`Advisorの呼び出しで例外が出ました: ${errorMessage(e)}`);
      return advisorFailed('process-error');
    }
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
