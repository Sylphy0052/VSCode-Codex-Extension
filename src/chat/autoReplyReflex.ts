import type { AskUserQuestionItem, AskUserQuestionSelections } from '../claude/askUserQuestion';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { judge, type ReflexAnswer, type ReflexJudgeDeps } from '../reflex/reflexJudge';

/**
 * 自動返信モードに挟むReflex判定（Issue #1435）。
 *
 * 返信役（`autoReplyAgent.ts`）の前後に型付きの判定（`reflexJudge.ts`）を置き、止めるか・
 * どう答えるか・送ってよいかを確率の閾値で決める。`vscode`には依存しない。判定の組み立てと
 * 閾値による判断だけを置き、会話への表示と停止はview層（`chatView.ts` /
 * `claudeChatView.ts`）が行う。
 *
 * - 完了の検証: ターン終了時、返信役を呼ぶ前に「完了した / 人の判断が要る / 続けられる」を判定する
 * - 質問の自動回答: AskUserQuestionの選択肢を判定し、確信度が高ければ返信役を通さずに選ぶ
 * - 危険度ゲート: 自動で送る発言・回答が危険な操作を招くかを判定し、危険なら送らない
 *
 * 判定が失敗したときは、危険度ゲートだけ安全側（送らない）に倒し、それ以外は判定が
 * 無かったときの挙動（返信役に任せる）へ戻す。
 */

/** `agent.chat.autoReply.reflex.*`の設定値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface AutoReplyReflexSettings {
  enabled: boolean;
  /** 「完了した」「人の判断が要る」のどちらかがこれ以上なら、返信役を呼ばずに止める。 */
  completionThreshold: number;
  /** AskUserQuestionの各質問で、最上位の選択肢の確率がこれ以上なら自動で選ぶ。 */
  answerThreshold: number;
  /** 送る内容が危険な操作を招く確率がこれ以上なら送らない。迷ったら止まるよう低めに置く。 */
  dangerThreshold: number;
}

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_AUTO_REPLY_REFLEX_COMPLETION_THRESHOLD = 0.7;
export const DEFAULT_AUTO_REPLY_REFLEX_ANSWER_THRESHOLD = 0.8;
export const DEFAULT_AUTO_REPLY_REFLEX_DANGER_THRESHOLD = 0.3;

const COMPLETED = '完了した';
const NEEDS_HUMAN = '人の判断が要る';
const CAN_CONTINUE = '続けられる';
const COMPLETION_OPTIONS = [COMPLETED, NEEDS_HUMAN, CAN_CONTINUE] as const;

/**
 * AskUserQuestionの選択肢に足す「どれでもない」。これが選ばれた質問は人へ回す。
 *
 * 括弧などの約物を入れない。Claudeは応答のキーで全角括弧を半角に書き換えることがあり、
 * 選択肢名と一致しなくなって判定全体が無効になるため。
 */
export const ASK_USER_QUESTION_NONE_OPTION = '選択肢に合うものが無い';

const ASK_LABEL_MAX_LENGTH = 200;
const ASK_TEXT_MAX_LENGTH = 400;
/** 危険度ゲートへ文脈として渡す直前の出力の上限。送る内容を先に置くため、切れるのは文脈の側。 */
const DANGER_CONTEXT_MAX_LENGTH = 8000;

function formatProbability(p: number): string {
  return p.toFixed(2);
}

function describeChoice(
  labels: readonly string[],
  probabilities: Readonly<Record<string, number>>,
): string {
  return labels
    .map((label) => `${label} ${formatProbability(probabilities[label] ?? 0)}`)
    .join(' / ');
}

export type AutoReplyCompletionVerdict =
  | { readonly kind: 'stop'; readonly reason: 'completed' | 'needsHuman'; readonly summary: string }
  | { readonly kind: 'continue'; readonly summary: string }
  /** 判定が失敗した。返信役に任せる。 */
  | { readonly kind: 'unavailable' };

/**
 * ターン終了時の完了の検証。「完了した」「人の判断が要る」のうち確率の高い方が閾値以上なら
 * `stop`を返す。
 */
export async function checkAutoReplyCompletion(
  deps: ReflexJudgeDeps,
  lastAgentMessage: string,
  threshold: number,
): Promise<AutoReplyCompletionVerdict> {
  const answers = await judge(deps, {
    situation: [
      'AIエージェント（元セッション）が1ターンの作業を終えた。利用者は席を外しており、自動返信の仕組みが',
      '利用者の代わりに次の発言を送るかどうかを決めようとしている。状態は元セッションの直前の出力である。',
    ].join(''),
    state: lastAgentMessage,
    questions: [
      {
        kind: 'choice',
        question: [
          '元セッションの作業はどの段階にあるか。',
          `「${COMPLETED}」は依頼された作業が終わり、次に頼むことが無い。`,
          `「${NEEDS_HUMAN}」は方針の選択・承認・取り消せない操作の確認など、利用者本人が決めるべき問いを出している。`,
          `「${CAN_CONTINUE}」は利用者が決めなくても、次の指示で作業を進められる。`,
        ].join(''),
        options: COMPLETION_OPTIONS,
      },
    ],
  });
  const answer = answers?.[0];
  if (answer?.kind !== 'choice') {
    return { kind: 'unavailable' };
  }
  const summary = describeChoice(COMPLETION_OPTIONS, answer.probabilities);
  const completed = answer.probabilities[COMPLETED] ?? 0;
  const needsHuman = answer.probabilities[NEEDS_HUMAN] ?? 0;
  const [reason, p] =
    completed >= needsHuman
      ? (['completed', completed] as const)
      : (['needsHuman', needsHuman] as const);
  if (p >= threshold) {
    return { kind: 'stop', reason, summary };
  }
  return { kind: 'continue', summary };
}

export type AutoReplyDangerVerdict =
  | { readonly kind: 'safe'; readonly summary: string }
  | { readonly kind: 'danger'; readonly summary: string }
  /** 判定が失敗した。安全側に倒し、送らない。 */
  | { readonly kind: 'unavailable' };

/**
 * 危険度ゲート。自動で送る内容（`outgoing`）が、取り消せない操作・外部への公開・秘密情報への
 * 接触を招くかを判定する。`context`は送る内容に至った元セッションの直前の出力。
 */
export async function checkAutoReplyDanger(
  deps: ReflexJudgeDeps,
  outgoing: string,
  context: string,
  threshold: number,
): Promise<AutoReplyDangerVerdict> {
  const answers = await judge(deps, {
    situation: [
      '利用者が席を外している間、自動返信の仕組みがAIエージェント（元セッション）へ発言や質問への回答を',
      '代わりに送ろうとしている。送る前に、それが危険な操作を招かないかを確かめたい。状態には、送ろうと',
      'している内容と、そこに至った元セッションの直前の出力が入っている。',
    ].join(''),
    state: [
      '### 送ろうとしている内容',
      '',
      outgoing,
      '',
      '### 元セッションの直前の出力',
      '',
      context.length > DANGER_CONTEXT_MAX_LENGTH
        ? `${context.slice(0, DANGER_CONTEXT_MAX_LENGTH)}…`
        : context,
    ].join('\n'),
    questions: [
      {
        kind: 'noul',
        question: [
          'この内容を送ると、元セッションが次のいずれかを行う見込みがあるか。',
          '(1) ファイル・データ・ブランチの削除、履歴の書き換え、強制pushなど取り消せない操作。',
          '(2) push・公開・外部サービスへの送信など、外部への公開。',
          '(3) APIキー・トークン・パスワード・秘密鍵など秘密情報の読み出しや表示。',
          '迷うときはyes寄りに答えること。',
        ].join(''),
      },
    ],
  });
  const answer = answers?.[0];
  if (answer?.kind !== 'noul') {
    return { kind: 'unavailable' };
  }
  const summary = `危険 ${formatProbability(answer.yes)}`;
  return answer.yes >= threshold ? { kind: 'danger', summary } : { kind: 'safe', summary };
}

export type AutoReplyAskUserQuestionVerdict =
  | {
      readonly kind: 'answer';
      readonly selections: AskUserQuestionSelections;
      readonly summary: string;
    }
  /** 確信度が足りない、または自由記述が要る。カードを残して人の回答を待つ。 */
  | { readonly kind: 'human'; readonly summary: string }
  /** 判定できない（判定の失敗・複数選択の質問）。返信役に任せる。 */
  | { readonly kind: 'delegate' };

/**
 * AskUserQuestionの質問ごとに、選択肢へ「どれでもない」を足して`choice`で判定する。
 *
 * 全ての質問で、最上位の選択肢が「どれでもない」以外かつ閾値以上なら`answer`を返す。
 * 複数選択の質問は`choice`（1つだけが正しい）で表せないため、判定せず返信役に任せる。
 */
export async function judgeAutoReplyAskUserQuestion(
  deps: ReflexJudgeDeps,
  questions: readonly AskUserQuestionItem[],
  lastAgentMessage: string,
  threshold: number,
): Promise<AutoReplyAskUserQuestionVerdict> {
  if (questions.length === 0 || questions.some((q) => q.multiSelect)) {
    return { kind: 'delegate' };
  }
  // 選択肢のラベルは元セッション（外部）由来のため1行化して長さを抑える。判定の答えは
  // 整形後のラベルで返るので、元のラベルへは並びの位置で戻す
  const labelsPerQuestion = questions.map((q) =>
    q.options.map((option) => sanitizeInlineText(option.label, ASK_LABEL_MAX_LENGTH)),
  );
  if (labelsPerQuestion.some((labels) => labels.includes(ASK_USER_QUESTION_NONE_OPTION))) {
    return { kind: 'delegate' };
  }
  const answers = await judge(deps, {
    situation: [
      'AIエージェント（元セッション）が利用者へ選択式の質問をした。利用者は席を外しており、自動返信の仕組みが',
      '代わりに答えようとしている。状態には質問の一覧と、質問に至った元セッションの直前の出力が入っている。',
    ].join(''),
    state: buildAskUserQuestionState(questions, lastAgentMessage),
    questions: questions.map((_, i) => ({
      kind: 'choice' as const,
      question: [
        `状態の「質問${i + 1}」に、利用者ならどの選択肢を選ぶか。`,
        `どの選択肢も合わない、または選択肢に無い答えを書く必要があるときは「${ASK_USER_QUESTION_NONE_OPTION}」を選ぶこと。`,
      ].join(''),
      options: [...labelsPerQuestion[i]!, ASK_USER_QUESTION_NONE_OPTION],
    })),
  });
  if (answers === undefined || answers.some((a) => a?.kind !== 'choice')) {
    return { kind: 'delegate' };
  }
  const selections: AskUserQuestionSelections = {};
  const summaries: string[] = [];
  let confident = true;
  for (const [i, question] of questions.entries()) {
    const answer = answers[i] as Extract<ReflexAnswer, { kind: 'choice' }>;
    const p = answer.probabilities[answer.best] ?? 0;
    summaries.push(`質問${i + 1}: ${answer.best} ${formatProbability(p)}`);
    const index = labelsPerQuestion[i]!.indexOf(answer.best);
    const option = question.options[index];
    if (option === undefined || p < threshold) {
      confident = false;
      continue;
    }
    selections[question.question] = [option.label];
  }
  const summary = summaries.join(' / ');
  return confident ? { kind: 'answer', selections, summary } : { kind: 'human', summary };
}

function buildAskUserQuestionState(
  questions: readonly AskUserQuestionItem[],
  lastAgentMessage: string,
): string {
  const lines: string[] = ['### 質問', ''];
  questions.forEach((question, i) => {
    lines.push(`質問${i + 1}: ${sanitizeInlineText(question.question, ASK_TEXT_MAX_LENGTH)}`);
    if (question.header !== '') {
      lines.push(`見出し: ${sanitizeInlineText(question.header, ASK_LABEL_MAX_LENGTH)}`);
    }
    for (const option of question.options) {
      const label = sanitizeInlineText(option.label, ASK_LABEL_MAX_LENGTH);
      const description =
        option.description === ''
          ? ''
          : `: ${sanitizeInlineText(option.description, ASK_TEXT_MAX_LENGTH)}`;
      lines.push(`- ${label}${description}`);
    }
    lines.push('');
  });
  lines.push(
    '### 元セッションの直前の出力',
    '',
    lastAgentMessage === '' ? '（無し）' : lastAgentMessage,
  );
  return lines.join('\n');
}

/** 危険度ゲートへ渡すため、AskUserQuestionへの回答を1つの文にまとめる。 */
export function describeAskUserQuestionSelections(
  questions: readonly AskUserQuestionItem[],
  selections: AskUserQuestionSelections,
): string {
  return questions
    .map((question) => {
      const labels = selections[question.question] ?? [];
      return [
        `質問: ${sanitizeInlineText(question.question, ASK_TEXT_MAX_LENGTH)}`,
        `回答: ${labels.map((label) => sanitizeInlineText(label, ASK_LABEL_MAX_LENGTH)).join('、')}`,
      ].join('\n');
    })
    .join('\n\n');
}
