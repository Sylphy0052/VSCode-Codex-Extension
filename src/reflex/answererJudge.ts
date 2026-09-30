import { describeCautionDangers, findQuestionDangers } from '../orchestrator/roadmapQuestionMcp';
import {
  choiceAnswer,
  choiceProbability,
  describeReflexChoice,
  type ReflexFallback,
} from './reflexAnswer';
import { judge, type ReflexJudgeDeps } from './reflexJudge';

/** 判定できなければ、問いを人（ユーザー）へ回す。 */
export const ANSWERER_JUDGE_FALLBACK: ReflexFallback = 'askHuman';

/**
 * 回答者判定（Issue #1708）。オーケストレーターへ届いた問い・オーケストレーターが出そうとした
 * 問いを、ユーザーが答えるべきか、オーケストレーターが自分で決めてよいかをReflexで判定する。
 *
 * 対象は3経路: オーケストレータモードの工程の質問と関門、ワークフローモードの`ask_user`、
 * オーケストレーターのターン末の問いかけ。オーケストレーターへ回すのは「オーケストレーター」の
 * 確率が閾値以上のときだけで、判定の失敗・時間切れはユーザーへ回す（誤判定より安全側に倒す）。
 * secretsと破壊的操作に関わる語（Issue #1712の危険語のうちユーザーが決めるもの）を含む問いは、
 * Reflexを通さずユーザーへ回す。本番環境・課金・デプロイ・公開の語は判定の材料にする（Issue #1771）。
 *
 * `vscode`へは依存させず、設定の読み出しと判定の実行手段は呼び出し側から渡す。
 */

/** `agent.chat.answererJudge.*`の設定値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface AnswererJudgeSettings {
  enabled: boolean;
  /** 「オーケストレーター」の確率がこれ以上ならオーケストレーターに決めさせる。 */
  threshold: number;
}

// 本来ユーザーが決める問いをオーケストレーターが決めるリスクを抑えるため高めに置く。仮置き
export const DEFAULT_ANSWERER_JUDGE_THRESHOLD = 0.7;

// 選択肢名に約物を入れない。Claudeは応答のキーで全角の約物を半角へ書き換えることがある
const USER = 'ユーザー';
const ORCHESTRATOR = 'オーケストレーター';
const NO_QUESTION = '問いなし';
const QUESTION_OPTIONS = [USER, ORCHESTRATOR] as const;
const TURN_END_OPTIONS = [USER, ORCHESTRATOR, NO_QUESTION] as const;

const USER_CRITERIA =
  `「${USER}」は、方針の選択、承認、取り消せない操作、担当領域をまたぐ変更、設計の前提を変える変更、` +
  '受入基準を下げる判断、またはユーザーしか知らない情報が要る問い。';
const ORCHESTRATOR_CRITERIA =
  `「${ORCHESTRATOR}」は、計画・Issue・コード・過去の回答から決められる問い、または推奨案があり` +
  `「${USER}」の条件に当たらない問い。`;

export type AnswererVerdict =
  /** オーケストレーターが自分で決めてよい（確率が閾値以上）。 */
  | { readonly kind: 'orchestrator'; readonly summary: string }
  /** ユーザーが答える。判定の失敗（`summary`が`undefined`）もここへ入れる。 */
  | { readonly kind: 'user'; readonly summary: string | undefined }
  /** ターン末の出力に問いが無い（`judgeTurnEndAnswerer`だけが返す）。 */
  | { readonly kind: 'noQuestion'; readonly summary: string };

/** 判定が無効・失敗したときにユーザーへ回す結果（理由を添えないもの）。 */
export const ANSWERER_USER_FALLBACK: AnswererVerdict = { kind: 'user', summary: undefined };

/** 判定にかける問い。 */
export interface AnswererQuestion {
  /** 誰が尋ねた問いか。工程セッション（`stageSession`）はオーケストレーターへ、`orchestrator`はユーザーへ尋ねている。 */
  source: 'stageSession' | 'orchestrator';
  question: string;
  reason?: string | undefined;
  options?: readonly string[];
  recommended?: string | undefined;
  /** 判断の材料。既存の選択肢判定の要約など。 */
  evidence?: string | undefined;
  /**
   * 承認を求められたコマンド（PRのmergeと元ブランチのリモート削除、Issue #1771）。危険語の検査に
   * かけない。形が許可リストに当たること（連結・置換を含まない、タスクのPR・元ブランチだけ）は
   * 呼び出し側（`isJudgeableMergeCommand`）が確かめる。
   */
  command?: string | undefined;
}

/** secrets・破壊的操作の危険語を含むなら、Reflexを通さずユーザーへ回す判定を返す。 */
function userVerdictForDangers(dangers: readonly string[]): AnswererVerdict | undefined {
  return dangers.length === 0
    ? undefined
    : {
        kind: 'user',
        summary: `secretsか破壊的操作に関わる語を含むため回答者判定を通さなかった（${dangers.join('、')}）`,
      };
}

function buildQuestionState(question: AnswererQuestion): string {
  const options = question.options ?? [];
  return [
    `問い: ${question.question}`,
    ...(question.reason === undefined ? [] : [`理由: ${question.reason}`]),
    ...(options.length === 0 ? [] : [`選択肢: ${options.join(' / ')}`]),
    ...(question.recommended === undefined ? [] : [`推奨: ${question.recommended}`]),
    ...(question.command === undefined ? [] : [`コマンド: ${question.command}`]),
    ...(question.evidence === undefined ? [] : [`判断の材料: ${question.evidence}`]),
  ].join('\n');
}

/**
 * 問い（工程の質問・関門・`ask_user`）を誰が答えるべきか判定する。「オーケストレーター」の
 * 確率が閾値以上なら`orchestrator`、それ以外と判定の失敗は`user`。
 */
export async function judgeQuestionAnswerer(
  deps: ReflexJudgeDeps,
  question: AnswererQuestion,
  threshold: number,
): Promise<AnswererVerdict> {
  const dangers = findQuestionDangers({
    question: question.question,
    reason: question.reason ?? '',
    options: question.options ?? [],
    evidence: question.evidence,
  });
  const dangerous = userVerdictForDangers(dangers.userOnly);
  if (dangerous !== undefined) {
    return dangerous;
  }
  const caution = describeCautionDangers(dangers);
  const situation =
    question.source === 'stageSession'
      ? 'オーケストレーター（複数のAIエージェントの作業を指揮するAIエージェント）へ、配下の作業セッションから問いが届いた。' +
        'この問いをユーザーへ回すか、オーケストレーターに自分で決めさせるかを決めようとしている。状態は問いの内容である。'
      : 'オーケストレーター（複数のAIエージェントの作業を指揮するAIエージェント）が、ユーザーへ問いを出そうとしている。' +
        'この問いを本当にユーザーへ出すか、オーケストレーターに自分で決めさせるかを決めようとしている。状態は問いの内容である。';
  const answers = await judge(deps, {
    situation,
    state: buildQuestionState(
      caution === undefined
        ? question
        : { ...question, evidence: [question.evidence, caution].filter((l) => l !== undefined).join('\n') },
    ),
    questions: [
      {
        kind: 'choice',
        question: `この問いに答えるべきなのは誰か。${USER_CRITERIA}${ORCHESTRATOR_CRITERIA}迷うときは「${USER}」とする。`,
        options: QUESTION_OPTIONS,
      },
    ],
  });
  const answer = choiceAnswer(answers?.[0]);
  if (answer === undefined) {
    return ANSWERER_USER_FALLBACK;
  }
  const summary = describeReflexChoice(QUESTION_OPTIONS, answer.probabilities);
  return choiceProbability(answer, ORCHESTRATOR) >= threshold
    ? { kind: 'orchestrator', summary }
    : { kind: 'user', summary };
}

/**
 * ターン末のオーケストレーターの出力（`lastMessage`）に、ユーザーへの問いかけがあるか、あれば
 * 誰が答えるべきかを判定する。「オーケストレーター」の確率が閾値以上のときだけ`orchestrator`。
 */
export async function judgeTurnEndAnswerer(
  deps: ReflexJudgeDeps,
  lastMessage: string,
  threshold: number,
): Promise<AnswererVerdict> {
  const dangers = findQuestionDangers({ question: lastMessage, reason: '', options: [], evidence: undefined });
  const dangerous = userVerdictForDangers(dangers.userOnly);
  if (dangerous !== undefined) {
    return dangerous;
  }
  const caution = describeCautionDangers(dangers);
  const answers = await judge(deps, {
    situation:
      'オーケストレーター（複数のAIエージェントの作業を指揮するAIエージェント）が1ターンを終えて、ユーザーの発言を待っている。' +
      '状態はその直前の出力である。出力がユーザーへ問いかけているなら、その問いをオーケストレーターに自分で決めさせるかを決めようとしている。',
    state: caution === undefined ? lastMessage : `${lastMessage}\n\n判断の材料: ${caution}`,
    questions: [
      {
        kind: 'choice',
        question: [
          'この出力の問いかけに答えるべきなのは誰か。',
          USER_CRITERIA,
          ORCHESTRATOR_CRITERIA,
          `「${NO_QUESTION}」は、ユーザーへ問いかけていない。完了の報告や経過の報告の末尾に添えた「ほかにありますか」のような定型の声かけも「${NO_QUESTION}」とする。`,
          `迷うときは「${USER}」とする。`,
        ].join(''),
        options: TURN_END_OPTIONS,
      },
    ],
  });
  const answer = choiceAnswer(answers?.[0]);
  if (answer === undefined) {
    return ANSWERER_USER_FALLBACK;
  }
  const summary = describeReflexChoice(TURN_END_OPTIONS, answer.probabilities);
  if (choiceProbability(answer, ORCHESTRATOR) >= threshold) {
    return { kind: 'orchestrator', summary };
  }
  return answer.best === NO_QUESTION
    ? { kind: 'noQuestion', summary }
    : { kind: 'user', summary };
}
