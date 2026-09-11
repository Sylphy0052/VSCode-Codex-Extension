import {
  runHeadlessPrompt,
  type HeadlessCliDeps,
  type HeadlessProvider,
} from '../loop/headlessCli';
import {
  TASK_TYPES,
  isAssessmentScore,
  isTaskType,
  type AssessmentScore,
  type TaskAssessment,
} from './handoffRouter';

/**
 * 引き継ぎ先の作業を、会話しているのと同じCLIのヘッドレス実行で分類する（Issue #1082）。
 *
 * 分類器が返すのは作業の性質（種類と5つの軸の数値）だけで、**model / effortは選ばせない**。
 * どのモデル・どのeffortにするかは `handoffRouter.ts` の決定論的な規則が決める。LLMに
 * 最終決定を自由回答させると、最上位モデルを勝手に指名したり、カタログに無い名前を返したり
 * する。意味の理解だけを任せ、方針の適用はコードで保証する。
 *
 * 判定材料（直近のユーザー指示・直前のターンが失敗したか・作業中のパス）は、引き継ぎの
 * ポインタファイルを組み立てるために既に集めてある値をそのまま使う。新たに取りに行かない。
 *
 * 呼び出しは`goalEvaluatorProcess.ts`（issue #892）と同じ条件のstatelessな1回実行で、
 * ツールを渡さず、利用者の設定（`CLAUDE.md`・hooks・skills）も読ませない。ここを緩めると
 * 分類器が自分で作業を始めたり、利用者側の口調規約でJSONを返さなくなったりする。
 *
 * **失敗しても例外を投げない。** CLIが落ちた・時間切れ・JSONが読めないのいずれも
 * `undefined` を返し、呼び出し側は引き継ぎ元のmodel / effortをそのまま持ち越す。分類の
 * 失敗で引き継ぎそのものを止めない。
 */

/**
 * 分類に使うモデル（ティアの最下位）。
 *
 * 分類は短いJSONを1つ返すだけの作業のため、重いモデルを起動する理由が無い。既存の脇役
 * （Evaluator / Advisor）は `haiku` を既定にしているが、作業の重さの見積もりには荷が勝つ
 * 場面がある。1段上を固定で使う。
 */
export const CLASSIFIER_MODELS: Record<HeadlessProvider, string> = {
  claude: 'sonnet',
  codex: 'terra',
};

/** 分類の待ち時間。人が引き継ぎ操作の結果を待っているため、長く待たせない。 */
export const CLASSIFIER_TIMEOUT_MS = 30_000;

/** 分類の材料。`HandoffPointerInput` が既に集めている値だけで構成する。 */
export interface HandoffClassifierInput {
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

/** 1件あたりの上限。長い指示をそのまま積むとプロンプトが膨らみ、分類も遅くなる。 */
const MESSAGE_LIMIT = 400;
/** 渡す指示の件数。新しいものを優先する。 */
const MESSAGE_COUNT = 5;
/** 渡すファイルの件数。 */
const FILE_COUNT = 20;
/** 理由1件の上限。ポインタファイルとログへそのまま出すため長くしない。 */
const REASON_LIMIT = 120;
const REASON_COUNT = 5;

function fold(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

/**
 * 分類を頼むプロンプトを組み立てる。
 *
 * 軸の定義をそのまま載せ、**作業を解かないこと・モデルとeffortを選ばないこと**を明示する。
 * 材料は「事実」として渡し、根拠を短く書かせる。根拠が無いと、分類が外れたときに何を見て
 * 外したのかが追えない。
 */
export function buildClassifierPrompt(input: HandoffClassifierInput): string {
  const messages = input.recentUserMessages
    .slice(-MESSAGE_COUNT)
    .map((m) => fold(m, MESSAGE_LIMIT))
    .filter((m) => m !== '');
  const files = input.turnEditedFiles.slice(0, FILE_COUNT);

  const lines: string[] = [];
  lines.push(
    'あなたはソフトウェア開発タスクの分類器です。コーディング支援セッションが新しいセッションへ引き継がれるにあたり、次のセッションが引き継ぐ作業の性質を分類してください。',
  );
  lines.push('');
  lines.push(
    '作業そのものを解かないでください。モデルやeffortも選ばないでください。分類だけを返します。',
  );
  lines.push('');
  lines.push('## 軸の定義（各0〜2の整数）');
  lines.push('');
  lines.push(
    '- difficulty: 0=定型・局所的 / 1=複数ステップ・自明でない / 2=深い推論・原因不明・複雑なアルゴリズム',
  );
  lines.push(
    '- scope: 0=1コンポーネント / 1=数ファイルか1サブシステム / 2=リポジトリ横断・複数システム',
  );
  lines.push('- ambiguity: 0=要件が明確 / 1=設計判断が要る / 2=問題の定義自体を整理する必要がある');
  lines.push(
    '- risk: 0=低リスク / 1=互換性・データ・運用への影響 / 2=security・auth・production・migration・影響範囲が広い',
  );
  lines.push(
    '- autonomy: 0=明示された指示を実行 / 1=実装の詳細を選ぶ / 2=分析・設計・実行まで自律的に進める',
  );
  lines.push('');
  lines.push('## task_type（次のいずれか1つ）');
  lines.push('');
  lines.push(TASK_TYPES.join(', '));
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
  lines.push('## 分類の指針');
  lines.push('');
  lines.push('- 会話の話題ではなく、次のセッションが実際に行う作業で判断する');
  lines.push('- 材料が乏しいときは各軸を1へ寄せる。分からないことを理由に0へ落とさない');
  lines.push('- confidenceは0〜1の小数で、この分類にどれだけ自信があるか');
  lines.push('');
  lines.push('## 切り替えてよいか（switch_safe）');
  lines.push('');
  lines.push(
    'あわせて、いま会話を新しいセッションへ切り替えてしまってよいかを判定してください。判断の基準は「作業が完結したか」ではなく、**新しいセッションがtranscriptと引き継ぎメモから続きを始められるか**です。',
  );
  lines.push('');
  lines.push('- true: 直前の指示が一段落し、次に何をするかが文面から追える');
  lines.push(
    '- false: 議論の途中、ユーザーの質問に答えきっていない、出しかけの成果物がある、直前の指示の実行が終わっていない',
  );
  lines.push('- switch_reasonにはその根拠を1文で書く');
  lines.push('');
  lines.push('## 出力');
  lines.push('');
  lines.push(
    'JSONオブジェクトを1つだけ出力してください。前後に説明・コードブロックの記号・その他の文字を付けないこと。',
  );
  lines.push('');
  lines.push(
    '{"task_type": "<上の一覧から1つ>", "difficulty": 0, "scope": 0, "ambiguity": 0, "risk": 0, "autonomy": 0, "confidence": 0.0, "reasons": ["<根拠を日本語で短く>", "..."], "switch_safe": true, "switch_reason": "<根拠を日本語で1文>"}',
  );
  return lines.join('\n');
}

function readScore(record: Record<string, unknown>, key: string): AssessmentScore | undefined {
  const value = record[key];
  return isAssessmentScore(value) ? value : undefined;
}

/**
 * 応答から見立てを取り出す。
 *
 * コードブロックで包まれたり前後に文が付いたりしても拾えるよう、最初に現れるJSONらしき
 * 塊を探してから解析する。5つの軸のどれか1つでも読めなければ `undefined`（＝分類できな
 * かった）。中途半端に埋めて解決へ進めると、欠けた軸が0扱いになって軽い側へ誤る。
 */
export function parseAssessment(raw: string): TaskAssessment | undefined {
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

  const taskType = record['task_type'];
  const difficulty = readScore(record, 'difficulty');
  const scope = readScore(record, 'scope');
  const ambiguity = readScore(record, 'ambiguity');
  const risk = readScore(record, 'risk');
  const autonomy = readScore(record, 'autonomy');
  if (
    !isTaskType(taskType) ||
    difficulty === undefined ||
    scope === undefined ||
    ambiguity === undefined ||
    risk === undefined ||
    autonomy === undefined
  ) {
    return undefined;
  }

  const rawConfidence = record['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0;
  const rawReasons = record['reasons'];
  const reasons = Array.isArray(rawReasons)
    ? rawReasons
        .filter((r): r is string => typeof r === 'string')
        .map((r) => fold(r, REASON_LIMIT))
        .filter((r) => r !== '')
        .slice(0, REASON_COUNT)
    : [];

  // switch_safeは**読めなければfalse**。欠けたまま切り替える側へ倒すと、議論の途中で
  // タブが入れ替わる（Issue #1090）
  const switchSafe = record['switch_safe'] === true;
  const rawSwitchReason = record['switch_reason'];
  const switchReason =
    typeof rawSwitchReason === 'string' ? fold(rawSwitchReason, REASON_LIMIT) : '';

  return {
    taskType,
    difficulty,
    scope,
    ambiguity,
    risk,
    autonomy,
    confidence,
    reasons,
    switchSafe,
    switchReason,
  };
}

export interface HandoffClassifierDeps {
  /** 会話しているCLI。引き継ぎ元と同じものを使う。 */
  provider: HeadlessProvider;
  executable: string;
  logWarn?: (message: string) => void;
  /** テストから差し替えるための口。既定は実際のヘッドレス実行。 */
  run?: (deps: HeadlessCliDeps, prompt: string) => Promise<string | undefined>;
}

/**
 * 作業を1回だけ分類する。失敗したときは `undefined`。
 *
 * @see buildClassifierPrompt 分類の条件
 */
export async function classifyHandoff(
  deps: HandoffClassifierDeps,
  input: HandoffClassifierInput,
): Promise<TaskAssessment | undefined> {
  const run = deps.run ?? runHeadlessPrompt;
  try {
    const raw = await run(
      {
        provider: deps.provider,
        executable: deps.executable,
        model: CLASSIFIER_MODELS[deps.provider],
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
        ...(deps.logWarn === undefined ? {} : { logWarn: deps.logWarn }),
      },
      buildClassifierPrompt(input),
    );
    if (raw === undefined) {
      deps.logWarn?.('引き継ぎ先の作業の分類が応答しませんでした');
      return undefined;
    }
    const assessment = parseAssessment(raw);
    if (assessment === undefined) {
      deps.logWarn?.('引き継ぎ先の作業の分類の応答を読めませんでした');
    }
    return assessment;
  } catch (e) {
    deps.logWarn?.(
      `引き継ぎ先の作業の分類で例外が出ました: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
