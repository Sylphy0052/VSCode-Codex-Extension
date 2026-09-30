import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { judge, type ReflexJudgeDeps } from '../reflex/reflexJudge';

/**
 * 自動引き継ぎの区切り判定をReflexで行う（Issue #1707）。
 *
 * 分類器（`handoffClassifier.ts`）の独自JSONで見ていた「切り替えてよいか・引き継ぎの提案か・
 * 返答待ちか」を、1回の`judge()`の3問へ置き換える。model/effortを決める作業分類は分類器に
 * 残す。`vscode`には依存しない。判定の組み立てと閾値による判断だけを置き、発火はview層
 * （`chatView.ts` / `claudeChatView.ts`）が`decideAutoHandoff`で決める。
 *
 * - q1: 最終応答が新しいセッションへ移ることを提案・推奨しているか
 * - q2: 最終応答が利用者の読む説明・回答・報告を本文に含むか
 * - q3: 引き継ぎ以外について、作業が区切り・判断待ち・途中のどこにあるか
 */

/** `agent.autoHandoff.reflex.*`の設定値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface HandoffReflexSettings {
  /** Reflexモードの親スイッチ（`agent.chat.reflex.enabled`）。OFFなら分類器の判定を使う。 */
  enabled: boolean;
  /** q1（引き継ぎの提案）がこれ以上なら`assistantSuggested`で発火する。 */
  suggestThreshold: number;
  /** q2（読ませる回答）がこれ以上なら`softThreshold`・`profileChanged`を止め、元タブを閉じない。 */
  readingThreshold: number;
  /** q3の「区切り」がこれ以上のときだけ`softThreshold`・`profileChanged`を発火させる。 */
  boundaryThreshold: number;
}

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_HANDOFF_REFLEX_SUGGEST_THRESHOLD = 0.6;
export const DEFAULT_HANDOFF_REFLEX_READING_THRESHOLD = 0.5;
export const DEFAULT_HANDOFF_REFLEX_BOUNDARY_THRESHOLD = 0.6;

// 選択肢の名前には約物を入れない（Claudeが応答のキーで全角括弧を書き換えた前例がある）
const STAGE_BOUNDARY = '区切り';
const STAGE_AWAITING = '判断待ち';
const STAGE_IN_PROGRESS = '途中';
const STAGE_OPTIONS = [STAGE_BOUNDARY, STAGE_AWAITING, STAGE_IN_PROGRESS] as const;

/**
 * 判定の材料に入れる本文の上限（コードポイント単位）。合計は`REFLEX_STATE_LIMIT`に収める。
 * `judge()`は上限を超えた状態の末尾を切るが、引き継ぎの提案・質問は最終応答の末尾に来るため、
 * 最終応答は先頭の側を落とす。
 */
const USER_MESSAGE_MAX_LENGTH = 4000;
const ASSISTANT_MESSAGE_MAX_LENGTH = 15_000;
/** HandoffTraceへ出す材料の抜粋の長さ。 */
const TRACE_EXCERPT_LENGTH = 80;

export interface HandoffBoundaryMaterial {
  /** 直近のユーザー指示。 */
  readonly userMessage: string;
  /** 直前のアシスタントの最終応答。 */
  readonly assistantMessage: string;
}

/** 3問の確率。 */
export interface HandoffBoundaryVerdict {
  readonly suggested: number;
  readonly reading: number;
  readonly stage: Readonly<Record<string, number>>;
}

/** 閾値を当てた結果。`decideAutoHandoff`へ渡す形。 */
export interface HandoffBoundaryReading {
  /** 最終応答が引き継ぎを提案している（q1）。 */
  readonly handoffSuggested: boolean;
  /** 最終応答が利用者の読む回答を含む（q2）。 */
  readonly readingAnswer: boolean;
  /** `softThreshold`・`profileChanged`を発火させてよい区切りか。 */
  readonly switchSafe: boolean;
}

function keepHead(text: string, maxLength: number): string {
  const chars = [...text];
  return chars.length <= maxLength ? text : `${chars.slice(0, maxLength).join('')}…`;
}

function keepTail(text: string, maxLength: number): string {
  const chars = [...text];
  return chars.length <= maxLength ? text : `…${chars.slice(-maxLength).join('')}`;
}

/**
 * 区切りの3問を1回の`judge()`で判定する。
 *
 * @returns 判定が失敗したとき、応答の形が合わないときは`undefined`
 */
export async function judgeHandoffBoundary(
  deps: ReflexJudgeDeps,
  material: HandoffBoundaryMaterial,
): Promise<HandoffBoundaryVerdict | undefined> {
  const answers = await judge(deps, {
    situation: [
      'AIエージェントのセッションが1ターンを終えた。拡張機能は、このセッションを終えて新しいセッションへ',
      '作業を引き継ぐ（自動引き継ぎ）かどうかを決めようとしている。引き継ぐと利用者は新しいセッションへ',
      '移され、元のセッションの画面は閉じられることがある。状態は直近のユーザー指示と、それに対する',
      'エージェントの最終応答である。',
    ].join(''),
    state: [
      '## 直近のユーザー指示',
      keepHead(material.userMessage, USER_MESSAGE_MAX_LENGTH),
      '',
      '## エージェントの最終応答',
      keepTail(material.assistantMessage, ASSISTANT_MESSAGE_MAX_LENGTH),
    ].join('\n'),
    questions: [
      {
        kind: 'noul',
        question: [
          '最終応答は、今のセッションを終えて新しいセッションへ移ることを提案・推奨しているか。',
          '移るかどうかを利用者へ尋ねている文面、/handoffの実行を利用者へ頼む文面も含む。',
        ].join(''),
      },
      {
        kind: 'noul',
        question:
          '最終応答は、利用者が読むための説明・回答・調査結果・報告を本文に含むか。作業の完了を一言で伝えるだけの文面は含まない。',
      },
      {
        kind: 'choice',
        question: [
          '新しいセッションへ移る話を除いて、作業はどの段階にあるか。',
          `「${STAGE_BOUNDARY}」は直前の指示が一段落し、次の作業が文面から追える。`,
          `「${STAGE_AWAITING}」は引き継ぎ以外の事柄で、利用者の回答・承認・方針の選択を待っている。`,
          `「${STAGE_IN_PROGRESS}」は指示の実行が終わっていない、議論の途中、出しかけの成果物がある。`,
        ].join(''),
        options: STAGE_OPTIONS,
      },
    ],
  });
  const [q1, q2, q3] = answers ?? [];
  if (q1?.kind !== 'noul' || q2?.kind !== 'noul' || q3?.kind !== 'choice') {
    return undefined;
  }
  return { suggested: q1.yes, reading: q2.yes, stage: q3.probabilities };
}

/**
 * 3問の確率へ閾値を当てる。
 *
 * 読ませる回答を含む応答は、区切りであっても`softThreshold`・`profileChanged`の区切りとは
 * 扱わない。利用者の次の発言の後のターン終わりで判定し直す。
 */
export function applyHandoffReflexThresholds(
  verdict: HandoffBoundaryVerdict,
  settings: HandoffReflexSettings,
): HandoffBoundaryReading {
  const readingAnswer = verdict.reading >= settings.readingThreshold;
  return {
    handoffSuggested: verdict.suggested >= settings.suggestThreshold,
    readingAnswer,
    switchSafe:
      !readingAnswer && (verdict.stage[STAGE_BOUNDARY] ?? 0) >= settings.boundaryThreshold,
  };
}

function formatProbability(p: number): string {
  return p.toFixed(2);
}

/** HandoffTraceへ出す1行。閾値の調整に使う。 */
export function describeHandoffBoundaryVerdict(verdict: HandoffBoundaryVerdict): string {
  const stage = STAGE_OPTIONS.map(
    (label) => `${label} ${formatProbability(verdict.stage[label] ?? 0)}`,
  ).join(' ');
  return `Reflex判定: 提案 ${formatProbability(verdict.suggested)} / 読む回答 ${formatProbability(verdict.reading)} / ${stage}`;
}

/** 契機の根拠。分類器の1文の代わりにポインタファイルとHandoffTraceへ出す。 */
export function handoffReflexReasons(verdict: HandoffBoundaryVerdict): {
  suggestReason: string;
  switchReason: string;
} {
  return {
    suggestReason: `Reflexの判定で最終応答が引き継ぎを提案している確率 ${formatProbability(verdict.suggested)}`,
    switchReason: `Reflexの判定で作業が区切りにある確率 ${formatProbability(verdict.stage[STAGE_BOUNDARY] ?? 0)}`,
  };
}

function excerpt(text: string): string {
  return sanitizeInlineText(text, TRACE_EXCERPT_LENGTH);
}

/** 判定の材料をHandoffTraceへ出す1行。長い本文は先頭だけにする。 */
export function describeHandoffBoundaryMaterial(material: HandoffBoundaryMaterial): string {
  return `Reflex判定の材料: 指示「${excerpt(material.userMessage)}」（${[...material.userMessage].length}字） / 最終応答「${excerpt(material.assistantMessage)}」（${[...material.assistantMessage].length}字）`;
}
