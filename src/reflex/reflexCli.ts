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
  /** 呼び出し元の種類（ログ用。Issue #1807）。`runReflexJson`は`subject`を入れる。 */
  kind?: string;
  /** 同じプロンプトへの成功した結果を再利用してよいか（Issue #1807）。 */
  cacheable?: boolean;
}

/**
 * `REFLEX_MODELS`のモデルでプロンプトを1回だけ投げる。結果をそのまま返す。
 *
 * 呼出元は直接使わず、失敗ログをまとめた`runReflexJson`を通す（Issue #1728）。
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
      ...(deps.kind === undefined ? {} : { kind: deps.kind }),
      ...(deps.cacheable === undefined ? {} : { cacheable: deps.cacheable }),
    },
    prompt,
  );
}

/**
 * JSONを返すReflex呼出の共通ランナー（Issue #1728）。
 *
 * プロンプトを1回投げ、応答本文を`parse`で読む。失敗（時間切れ・CLIの起動失敗や異常終了・
 * 読めない応答・例外）はどれも`undefined`を返し、`subject`を主語にした文言で`logWarn`へ
 * 1行出す。`signal`で打ち切ったときは呼出元が止めた結果であり不調ではないため、ログを出さない。
 *
 * @param subject ログの主語（例: `Reflexの判定`）。`〜が時間切れになりました`の形で使う
 * @param parse 応答本文を読む。読めなければ`undefined`
 */
export async function runReflexJson<T>(
  deps: ReflexCliDeps,
  prompt: string,
  subject: string,
  parse: (text: string) => T | undefined,
): Promise<T | undefined> {
  try {
    // Reflexの判定は応答がプロンプトだけで決まるため、同じ文面への判定は結果を再利用する（Issue #1807）
    const outcome = await runReflexPrompt({ kind: subject, cacheable: true, ...deps }, prompt);
    if (!outcome.ok) {
      if (deps.signal?.aborted !== true && outcome.superseded !== true) {
        // 時間切れと起動・異常終了を言い分ける（Issue #1097）。同じ文言だと、タイムアウトを
        // 延ばすべきなのか、CLIのパスが違うのかがログから判らない
        deps.logWarn?.(
          outcome.reason === 'timeout'
            ? `${subject}が時間切れになりました（${deps.timeoutMs}ms）`
            : `${subject}を実行できませんでした（CLIの起動失敗・異常終了）`,
        );
      }
      return undefined;
    }
    const parsed = parse(outcome.text);
    if (parsed === undefined) {
      deps.logWarn?.(`${subject}の応答を読めませんでした（JSONとして不正）`);
    }
    return parsed;
  } catch (e) {
    deps.logWarn?.(`${subject}で例外が出ました: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
