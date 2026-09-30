import type { HeadlessOutcome } from '../../src/loop/headlessCli';
import type { ReflexJudgeDeps } from '../../src/reflex/reflexJudge';

/**
 * Reflexの判定（ヘッドレスCLI）をモックにした`ReflexJudgeDeps`。`reflexJudge.judge`から先の
 * 検証・プロンプト組み立て・応答の解釈は実物のまま通す。
 */
export interface ReflexStub {
  deps: ReflexJudgeDeps;
  /** CLIへ渡したプロンプト。呼ばれた順。 */
  prompts: string[];
  warnings: string[];
}

export function reflexStub(outcome: HeadlessOutcome | Error): ReflexStub {
  const prompts: string[] = [];
  const warnings: string[] = [];
  return {
    prompts,
    warnings,
    deps: {
      provider: 'claude',
      executable: 'claude',
      logWarn: (message) => warnings.push(message),
      run: async (_deps, prompt) => {
        prompts.push(prompt);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    },
  };
}

/**
 * Reflexの応答本文。`answers`は質問の並びで、`noul`は`{p}`、`choice`は`{probs}`を渡す。
 * `id`は質問の並びから`q1`、`q2`…と振る。
 */
export function reflexAnswers(
  ...answers: ({ p: number } | { probs: Record<string, number> })[]
): HeadlessOutcome {
  return {
    ok: true,
    text: JSON.stringify({ answers: answers.map((a, i) => ({ id: `q${String(i + 1)}`, ...a })) }),
  };
}

export const REFLEX_TIMEOUT: HeadlessOutcome = { ok: false, reason: 'timeout' };
export const REFLEX_PROCESS_ERROR: HeadlessOutcome = { ok: false, reason: 'process-error' };
