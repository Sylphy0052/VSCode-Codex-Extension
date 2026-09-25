import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { judge, type ReflexJudgeDeps } from '../reflex/reflexJudge';
import type { GoalEvidence } from './goalLoop';

/**
 * 条件付きループの完了宣言の検証（issue #1447）。
 *
 * 条件付きループは、応答の最終行が`<<LOOP_DONE>>`なら止まる。エージェントの自己申告だけで
 * 終わるため、止める前にReflex判定で「終了条件を本当に満たしたか」を聞き、確信が持てない
 * ときは次の周へ進める。
 *
 * ゴールで回すループは対象外（別セッションのEvaluatorが完了を判定している）。`vscode`へは
 * 依存させず、設定の読み出しと判定の実行手段は呼び出し側（view層）から渡す。
 */

/** `agent.chat.loopDoneCheck.*`の設定値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface LoopDoneCheckSettings {
  enabled: boolean;
  /** 「終了条件を満たした」の確率がこれ以上なら止める。 */
  threshold: number;
}

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_LOOP_DONE_CHECK_THRESHOLD = 0.7;

/** 判定へ渡す材料。 */
export interface LoopDoneCheckInput {
  /** ループの終了条件（利用者が画面で入力したもの）。 */
  condition: string;
  /** 直近の応答本文。古い順。最後が完了を宣言した応答。 */
  recentTurns: readonly string[];
  /** ループを始めてから実行されたコマンドの記録。 */
  evidence: readonly GoalEvidence[];
}

/** 足りない点の選択肢。次の周の指示文へは、この名前ではなく`GAP_FEEDBACK`の固定文を載せる。 */
const GAP_NONE = '不足なし';
const GAP_NOT_VERIFIED = '検証が未実行';
const GAP_VERIFY_FAILED = '検証が失敗';
const GAP_PARTIAL = '条件の一部が未達';
const GAP_NO_BASIS = '根拠が不明';
const GAP_OPTIONS = [GAP_NONE, GAP_NOT_VERIFIED, GAP_VERIFY_FAILED, GAP_PARTIAL, GAP_NO_BASIS];

/**
 * 足りない点ごとに次の周へ添える文。
 *
 * **判定の応答から自由文を受け取らず、コード側の固定文だけを送る。** 判定の入力には
 * エージェントの出力が入っており、そこに紛れた指示が判定の理由を経由して次の指示文へ
 * 流れ込む経路を作らないため。
 */
const GAP_FEEDBACK: Readonly<Record<string, string>> = {
  [GAP_NOT_VERIFIED]:
    '終了条件を満たしたことを確かめるコマンド（テスト・ビルドなど）がまだ実行されていません。',
  [GAP_VERIFY_FAILED]: '実行したコマンドのうち、失敗したまま直っていないものがあります。',
  [GAP_PARTIAL]: '終了条件のうち、まだ満たしていない部分があります。',
  [GAP_NO_BASIS]: '応答にも実行の記録にも、終了条件を満たした根拠が見当たりません。',
};
const GAP_FEEDBACK_FALLBACK = '終了条件を満たしたと判断できる根拠が足りません。';

/**
 * 判定へ渡すコマンドの記録の上限件数。新しいものを残す。1件は最大で約450文字になるため、
 * 直近の応答と合わせても`judge`の上限（20000文字）に収まる件数にしてある
 */
export const LOOP_DONE_CHECK_EVIDENCE_LIMIT = 25;
const EVIDENCE_SOURCE_MAX_LENGTH = 200;
/** 出力は末尾（テストの集計行など、結果が出る側）を残す。 */
const EVIDENCE_OUTPUT_MAX_LENGTH = 200;
const CONDITION_MAX_LENGTH = 1000;

export type LoopDoneCheckResult =
  /** 満たしたとする確率が閾値以上。止める。 */
  | { readonly kind: 'passed'; readonly probability: number }
  /** 閾値未満。止めずに次の周へ進む。`feedback`は次の指示文へ添える固定文。 */
  | {
      readonly kind: 'rejected';
      readonly probability: number;
      readonly gap: string | undefined;
      readonly feedback: string;
    }
  /** 判定が失敗した（時間切れ・読み取れない応答など）。判定が無かったときと同じく止める。 */
  | { readonly kind: 'unavailable' };

/** `LoopPlan`へ載せる設定。判定の実行と、結果を会話へ残す処理を呼び出し側から受け取る。 */
export interface LoopDoneCheckConfig {
  /**
   * 判定を1回走らせる。失敗時も例外を投げず`unavailable`を返す実装を期待する。
   * `signal`はループが止められたときに発火する。
   */
  check: (input: LoopDoneCheckInput, signal?: AbortSignal) => Promise<LoopDoneCheckResult>;
  /** 判定の結果を会話へ1行残す。例外を投げないこと。 */
  note?: (result: LoopDoneCheckResult, iteration: number) => void;
}

function formatProbability(p: number): string {
  return p.toFixed(2);
}

/**
 * コマンドの記録を1件1行へ均す。コマンド行も出力も外部由来なので改行を潰し、偽の行を
 * 作らせない。
 */
function formatEvidenceLines(evidence: readonly GoalEvidence[]): string {
  const recent = evidence.slice(-LOOP_DONE_CHECK_EVIDENCE_LIMIT);
  if (recent.length === 0) {
    return '（なし）';
  }
  return recent
    .map((e) => {
      const source = sanitizeInlineText(e.source.replace(/\s+/gu, ' '), EVIDENCE_SOURCE_MAX_LENGTH);
      const flatOutput = e.detail.replace(/\s+/gu, ' ').trim();
      const output = sanitizeInlineText(
        flatOutput.length > EVIDENCE_OUTPUT_MAX_LENGTH
          ? `…${flatOutput.slice(-EVIDENCE_OUTPUT_MAX_LENGTH)}`
          : flatOutput,
        EVIDENCE_OUTPUT_MAX_LENGTH + 1,
      );
      return `- [${e.status}] ${e.kind}: ${source}${output === '' ? '' : ` → 出力末尾: ${output}`}`;
    })
    .join('\n');
}

export function buildLoopDoneCheckState(input: LoopDoneCheckInput): string {
  const turns = input.recentTurns.length === 0 ? ['（なし）'] : input.recentTurns;
  return [
    '### ループ中に実行したコマンド（古い順。[pass]は終了コード0、[fail]は0以外、[unknown]は不明）',
    '',
    formatEvidenceLines(input.evidence),
    '',
    '### 直近の応答（古い順。最後が完了を宣言した応答）',
    '',
    turns.join('\n\n---\n\n'),
  ].join('\n');
}

/**
 * 完了宣言を検証する。`deps.signal`でプロセスを止められる。
 */
export async function checkLoopDone(
  deps: ReflexJudgeDeps,
  input: LoopDoneCheckInput,
  threshold: number,
): Promise<LoopDoneCheckResult> {
  const condition = sanitizeInlineText(input.condition.replace(/\s+/gu, ' '), CONDITION_MAX_LENGTH);
  const answers = await judge(deps, {
    situation: [
      'AIエージェントに、終了条件を満たすまで同じ作業を繰り返させている。エージェントは直前の応答で',
      '「終了条件を満たした」と宣言した。ループを止めてよいかを判断したい。',
      `終了条件は利用者が次のとおり指定した: ${JSON.stringify(condition)}`,
    ].join(''),
    state: buildLoopDoneCheckState(input),
    questions: [
      {
        kind: 'noul',
        question:
          '応答とコマンドの記録から判断して、終了条件は本当に満たされているか。エージェントの宣言だけを根拠にしない。',
      },
      {
        kind: 'choice',
        question: [
          '終了条件を満たしたと言うのに最も足りていない点はどれか。',
          `「${GAP_NONE}」は根拠が揃っている。`,
          `「${GAP_NOT_VERIFIED}」は条件を確かめるコマンドが実行されていない。`,
          `「${GAP_VERIFY_FAILED}」は実行したコマンドが失敗したまま直っていない。`,
          `「${GAP_PARTIAL}」は条件の一部だけを満たしている。`,
          `「${GAP_NO_BASIS}」は応答にも記録にも満たした根拠が無い。`,
        ].join(''),
        options: GAP_OPTIONS,
      },
    ],
  });
  const done = answers?.[0];
  if (done?.kind !== 'noul') {
    return { kind: 'unavailable' };
  }
  if (done.yes >= threshold) {
    return { kind: 'passed', probability: done.yes };
  }
  // 足りない点が読めなかったとき・「不足なし」なのに閾値を下回ったときは、一般的な文で返す
  const gapAnswer = answers?.[1];
  const gap = gapAnswer?.kind === 'choice' ? gapAnswer.best : undefined;
  return {
    kind: 'rejected',
    probability: done.yes,
    gap,
    feedback: (gap === undefined ? undefined : GAP_FEEDBACK[gap]) ?? GAP_FEEDBACK_FALLBACK,
  };
}

/**
 * `LoopPlan.doneCheck`を組み立てる。設定で無効なら`undefined`（計画に載らない）。
 *
 * `deps.signal`はここでは受け取らず、判定ごとにループの停止信号を差し込む。
 */
export function createLoopDoneCheckConfig(
  settings: LoopDoneCheckSettings,
  deps: Omit<ReflexJudgeDeps, 'signal'>,
  note: (result: LoopDoneCheckResult, iteration: number) => void,
): LoopDoneCheckConfig | undefined {
  if (!settings.enabled) {
    return undefined;
  }
  return {
    check: (input, signal) =>
      checkLoopDone(
        { ...deps, ...(signal !== undefined ? { signal } : {}) },
        input,
        settings.threshold,
      ),
    note,
  };
}

/** 会話へ残す1行。 */
export function describeLoopDoneCheck(result: LoopDoneCheckResult): string {
  switch (result.kind) {
    case 'passed':
      return `Reflex判定（完了宣言の検証）: 満たした ${formatProbability(result.probability)} のためループを終了します`;
    case 'rejected':
      return `Reflex判定（完了宣言の検証）: 満たした ${formatProbability(result.probability)}、不足 ${result.gap ?? '不明'} のためループを続けます`;
    case 'unavailable':
      return 'Reflex判定（完了宣言の検証）: 判定できなかったため、宣言どおりループを終了します';
  }
}

/** 検証で差し戻したときの次の指示文。継続指示の前に、差し戻した理由を置く。 */
export function buildRejectedDonePrompt(continuePrompt: string, feedback: string): string {
  return [
    `前の応答で終了を宣言しましたが、検証で差し戻しました。${feedback}`,
    '足りない点を補ってから、改めて終了条件を確かめてください。',
    '',
    continuePrompt,
  ].join('\n');
}
