import {
  runHeadlessPrompt,
  type HeadlessCliDeps,
  type HeadlessProvider,
} from '../loop/headlessCli';
import {
  HANDOFF_LEVELS,
  LEVEL_DESCRIPTIONS,
  isHandoffLevel,
  type HandoffLevel,
} from './handoffRouter';

/**
 * 引き継ぎ先の抽象レベルを、会話しているのと同じCLIのヘッドレス実行で判定する（Issue #1082）。
 *
 * 判定材料（直近のユーザー指示・直前のターンが失敗したか・作業中のパス）は、引き継ぎの
 * ポインタファイルを組み立てるために既に集めてある値をそのまま使う。新たに取りに行かない。
 *
 * 呼び出しは`goalEvaluatorProcess.ts`（issue #892）と同じ条件のstatelessな1回実行で、
 * ツールを渡さず、利用者の設定（`CLAUDE.md`・hooks・skills）も読ませない。ここを緩めると
 * 判定役が自分で作業を始めたり、利用者側の口調規約でJSONを返さなくなったりする。
 *
 * **失敗しても例外を投げない。** CLIが落ちた・時間切れ・JSONが読めないのいずれも
 * `undefined` を返し、呼び出し側は引き継ぎ元のmodel / effortをそのまま持ち越す。判定の
 * 失敗で引き継ぎそのものを止めない。
 */

/**
 * 判定に使うモデル（ティアの最下位）。
 *
 * 判定は短いJSONを1つ返すだけの作業のため、重いモデルを起動する理由が無い。既存の脇役
 * （Evaluator / Advisor）は `haiku` を既定にしているが、引き継ぎの判定は作業の重さの
 * 見積もりで、最下位のモデルには荷が勝つ場面がある。1段上を固定で使う。
 */
export const JUDGE_MODELS: Record<HeadlessProvider, string> = {
  claude: 'sonnet',
  codex: 'terra',
};

/** 判定の待ち時間。人が引き継ぎ操作の結果を待っているため、長く待たせない。 */
export const JUDGE_TIMEOUT_MS = 30_000;

/** 判定の材料。`HandoffPointerInput` が既に集めている値だけで構成する。 */
export interface HandoffJudgeInput {
  /** 直近のユーザー指示（会話順）。 */
  recentUserMessages: readonly string[];
  /** 直前のターンが失敗して終わったか。 */
  turnFailed: boolean;
  cwd: string | undefined;
  gitBranch: string | undefined;
  /**
   * 直前のターンで編集したファイル。**ターン単位でリセットされる**ため「全部」ではない
   * （`handoff.ts` の同名の項目を参照）。どこを触っていたかの手掛かりとしてだけ渡す。
   */
  turnEditedFiles: readonly string[];
}

/** 判定の結果。`reason` はポインタファイルと拡張機能のログへそのまま出す。 */
export interface HandoffJudgement {
  level: HandoffLevel;
  reason: string;
}

/** 1件あたりの上限。長い指示をそのまま積むとプロンプトが膨らみ、判定も遅くなる。 */
const MESSAGE_LIMIT = 400;
/** 渡す指示の件数。新しいものを優先する。 */
const MESSAGE_COUNT = 5;
/** 渡すファイルの件数。 */
const FILE_COUNT = 20;

function fold(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

/**
 * 判定を頼むプロンプトを組み立てる。
 *
 * レベルの定義（`LEVEL_DESCRIPTIONS`）をそのまま載せ、JSON以外を書かないよう明示する。
 * 材料は「事実」として渡し、判定の根拠を1文で書かせる。根拠が無いと、判定が外れたときに
 * 何を見て外したのかが追えない。
 */
export function buildJudgePrompt(input: HandoffJudgeInput): string {
  const levels = HANDOFF_LEVELS.map((l) => `- L${l}: ${LEVEL_DESCRIPTIONS[l]}`).join('\n');
  const messages = input.recentUserMessages
    .slice(-MESSAGE_COUNT)
    .map((m) => fold(m, MESSAGE_LIMIT))
    .filter((m) => m !== '');
  const files = input.turnEditedFiles.slice(0, FILE_COUNT);

  const lines: string[] = [];
  lines.push(
    'あなたはコーディング支援セッションの引き継ぎを仲介する判定器です。次のセッションがどれだけ重い作業を引き継ぐのかを見積もり、抽象レベルを1つ選んでください。',
  );
  lines.push('');
  lines.push('## レベルの定義');
  lines.push('');
  lines.push(levels);
  lines.push('');
  lines.push('## 引き継ぎ元の状況');
  lines.push('');
  lines.push(`- 作業ディレクトリ: ${input.cwd ?? '不明'}`);
  lines.push(`- gitブランチ: ${input.gitBranch ?? '不明'}`);
  lines.push(`- 直前のターンが失敗して終わったか: ${input.turnFailed ? 'はい' : 'いいえ'}`);
  lines.push('');
  lines.push('### 直近のユーザー指示（古い順）');
  lines.push('');
  lines.push(messages.length === 0 ? '（記録が無い）' : messages.map((m) => `- ${m}`).join('\n'));
  lines.push('');
  lines.push('### 直前のターンで編集したファイル');
  lines.push('');
  lines.push(
    files.length === 0
      ? '（記録が無い。これは「編集していない」という意味ではない）'
      : files.map((f) => `- ${f}`).join('\n'),
  );
  lines.push('');
  lines.push('## 判定の指針');
  lines.push('');
  lines.push('- 直前のターンが失敗して終わっているなら、同じ重さで再挑戦させない。1段上げる');
  lines.push('- 材料が乏しいときは中央（L2）へ寄せる。分からないことを理由に最軽量へ落とさない');
  lines.push('- 会話の話題ではなく、次のセッションが実際に行う作業の重さで判断する');
  lines.push('');
  lines.push('## 出力');
  lines.push('');
  lines.push(
    'JSONオブジェクトを1つだけ出力してください。前後に説明・コードブロックの記号・その他の文字を付けないこと。',
  );
  lines.push('');
  lines.push('{"level": <0から5の整数>, "reason": "<判定の根拠を日本語で1文>"}');
  return lines.join('\n');
}

/**
 * 応答からレベルを取り出す。
 *
 * コードブロックで包まれたり前後に文が付いたりしても拾えるよう、最初に現れるJSONらしき
 * 塊を探してから解析する。`level` が読めなければ `undefined`（＝判定できなかった）。
 */
export function parseJudgement(raw: string): HandoffJudgement | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const level = record['level'];
  if (!isHandoffLevel(level)) {
    return undefined;
  }
  const reason = record['reason'];
  return {
    level,
    reason:
      typeof reason === 'string' && reason.trim() !== '' ? fold(reason, 200) : '理由の記載なし',
  };
}

export interface HandoffJudgeDeps {
  /** 会話しているCLI。引き継ぎ元と同じものを使う。 */
  provider: HeadlessProvider;
  executable: string;
  logWarn?: (message: string) => void;
  /** テストから差し替えるための口。既定は実際のヘッドレス実行。 */
  run?: (deps: HeadlessCliDeps, prompt: string) => Promise<string | undefined>;
}

/**
 * レベルを1回だけ判定する。失敗したときは `undefined`。
 *
 * @see buildJudgePrompt 判定の条件
 */
export async function judgeHandoffLevel(
  deps: HandoffJudgeDeps,
  input: HandoffJudgeInput,
): Promise<HandoffJudgement | undefined> {
  const run = deps.run ?? runHeadlessPrompt;
  try {
    const raw = await run(
      {
        provider: deps.provider,
        executable: deps.executable,
        model: JUDGE_MODELS[deps.provider],
        timeoutMs: JUDGE_TIMEOUT_MS,
        ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      },
      buildJudgePrompt(input),
    );
    if (raw === undefined) {
      deps.logWarn?.('引き継ぎ先のレベル判定が応答しませんでした');
      return undefined;
    }
    const judgement = parseJudgement(raw);
    if (judgement === undefined) {
      deps.logWarn?.('引き継ぎ先のレベル判定の応答を読めませんでした');
    }
    return judgement;
  } catch (e) {
    deps.logWarn?.(
      `引き継ぎ先のレベル判定で例外が出ました: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
