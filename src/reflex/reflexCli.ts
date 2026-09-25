import {
  runHeadlessPromptDetailed,
  type HeadlessCliDeps,
  type HeadlessOutcome,
  type HeadlessProvider,
} from '../loop/headlessCli';

/**
 * 軽量判定（Reflex。Issue #1434）のヘッドレス実行。
 *
 * 引き継ぎの分類器（`handoffClassifier.ts`）・タブ名の自動付け直し（`sessionAutoName.ts`）・
 * Reflexの型付き判定（`reflexJudge.ts`）が、同じモデル選択と同じ呼び出し条件で使う。
 * 呼び出しは`headlessCli.ts`のstatelessな1回実行で、ツールを渡さず、利用者の設定
 * （`CLAUDE.md`・hooks・skills）も読ませない。
 */

/**
 * 判定に使うモデル。会話しているCLIに合わせて切り替える。
 *
 * 判定は短いJSONを1つ返すだけの作業のため、重いモデルを起動する理由が無い。既存の脇役
 * （Evaluator / Advisor）は `haiku` を既定にしているが、作業の重さの見積もりには荷が勝つ
 * 場面がある。1段上を固定で使う。
 */
export const REFLEX_MODELS: Record<HeadlessProvider, string> = {
  claude: 'sonnet',
  // CodexはClaude Codeのような短縮名を受け付けないため、正式なモデルslugを渡す。
  codex: 'gpt-6-luna',
};

export interface ReflexCliDeps {
  /** 会話しているCLI。判定もこれと同じCLIで走らせる。 */
  provider: HeadlessProvider;
  executable: string;
  timeoutMs: number;
  logWarn?: (message: string) => void;
  signal?: AbortSignal;
  /** テストから差し替えるための口。既定は実際のヘッドレス実行。 */
  run?: (deps: HeadlessCliDeps, prompt: string) => Promise<HeadlessOutcome>;
}

/**
 * `REFLEX_MODELS`のモデルでプロンプトを1回だけ投げる。
 *
 * 失敗の扱い（ログの文言、応答の解釈）は用途ごとに違うため、ここでは結果をそのまま返す。
 */
export function runReflexPrompt(deps: ReflexCliDeps, prompt: string): Promise<HeadlessOutcome> {
  const run = deps.run ?? runHeadlessPromptDetailed;
  return run(
    {
      provider: deps.provider,
      executable: deps.executable,
      model: REFLEX_MODELS[deps.provider],
      timeoutMs: deps.timeoutMs,
      ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    prompt,
  );
}
