import { readFile } from 'node:fs/promises';

import type { ChatItem, ChatState } from '../appserver/chatState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { formatReflexProbability as formatProbability, noulAnswer } from '../reflex/reflexAnswer';
import { judge, type ReflexJudgeDeps } from '../reflex/reflexJudge';

/**
 * 引き継ぎ先の受領をReflexで判定する（Issue #1840）。
 *
 * 受領行（`HANDOFF_ACCEPTED <id>`、Issue #1751）もpointerファイルの読み込み（Issue #1797）も
 * 無いまま `notAccepted` で決着しそうなときに限って、1回だけ呼ぶ。引き継ぎ先は受領行を書かずに
 * 作業を始めることがあり、本文として渡した経路ではpointerの読み込みでも救えないため。
 * `vscode`には依存しない。親スイッチと閾値は呼び出し側が読んで渡す。
 */

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_HANDOFF_ACCEPTANCE_THRESHOLD = 0.6;

/**
 * 判定の材料の上限（コードポイント単位）。合計は`REFLEX_STATE_LIMIT`（2万字）に収める。
 * 本文は前提・やったことが先頭に来るため先頭の側を残す。引き継ぎ先の応答も、受領の様子は
 * 最初の数件に出るため先頭から取る。
 */
const BODY_MAX_LENGTH = 8000;
const MESSAGE_COUNT = 3;
const MESSAGE_MAX_LENGTH = 2000;
const ACTION_COUNT = 20;
const ACTION_MAX_LENGTH = 200;
/** HandoffTraceへ出す材料の抜粋の長さ。 */
const TRACE_EXCERPT_LENGTH = 80;

export interface HandoffAcceptanceMaterial {
  /** 引き継ぎの本文。pointerを使った経路ではpointerファイルの中身、そうでなければ初回プロンプト。 */
  readonly body: string;
  /** 引き継ぎ先のアシスタント応答（先頭から数件）。 */
  readonly messages: readonly string[];
  /** 引き継ぎ先が実行したコマンドと読んだファイル（先頭から）。 */
  readonly actions: readonly string[];
}

function keepHead(text: string, maxLength: number): string {
  const chars = [...text];
  return chars.length <= maxLength ? text : `${chars.slice(0, maxLength).join('')}…`;
}

/** 引き継ぎ先の状態から、判定に渡す応答と行動を抜き出す。 */
export function collectHandoffAcceptanceMaterial(
  body: string,
  items: ReadonlyArray<Pick<ChatItem, 'kind' | 'text' | 'detail'>>,
): HandoffAcceptanceMaterial {
  const messages = items
    .filter((item) => item.kind === 'agentMessage' && item.text.trim() !== '')
    .slice(0, MESSAGE_COUNT)
    .map((item) => keepHead(item.text, MESSAGE_MAX_LENGTH));
  const actions = items
    .filter(
      (item) =>
        (item.kind === 'commandExecution' || item.kind === 'fileRead') && item.detail.trim() !== '',
    )
    .slice(0, ACTION_COUNT)
    .map(
      (item) =>
        `${item.kind === 'fileRead' ? 'read' : 'command'}: ${sanitizeInlineText(item.detail, ACTION_MAX_LENGTH)}`,
    );
  return { body: keepHead(body, BODY_MAX_LENGTH), messages, actions };
}

/**
 * 引き継ぎ先が本文を把握したうえで動いているかを1問で判定する。
 *
 * @returns 受領している確率。判定が失敗したとき、応答の形が合わないときは`undefined`
 */
export async function judgeHandoffAcceptance(
  deps: ReflexJudgeDeps,
  material: HandoffAcceptanceMaterial,
): Promise<number | undefined> {
  const answers = await judge(deps, {
    situation: [
      'AIエージェントのセッションを新しいセッションへ引き継いだ。拡張機能は、引き継ぎ先が引き継ぎの本文を',
      '受け取って読めたかを確かめてから、引き継ぎ元の画面を閉じようとしている。引き継ぎ先には受領を示す',
      '決まった1行を書くよう指示したが、その行は書かれていない。状態は引き継ぎの本文と、引き継ぎ先の',
      '最初の応答と行動である。',
    ].join(''),
    state: [
      '## 引き継ぎの本文',
      material.body,
      '',
      '## 引き継ぎ先の応答（先頭から）',
      material.messages.length === 0 ? '（無し）' : material.messages.join('\n\n---\n\n'),
      '',
      '## 引き継ぎ先の行動（先頭から）',
      material.actions.length === 0 ? '（無し）' : material.actions.join('\n'),
    ].join('\n'),
    questions: [
      {
        kind: 'noul',
        question: [
          '引き継ぎ先の応答と行動は、本文の前提・やったこと・次の1手を把握したうえでのものか。',
          '本文と食い違う前提で動いている、本文と無関係な作業を始めた場合は含まない。',
        ].join(''),
      },
    ],
  });
  return noulAnswer(answers?.[0])?.yes;
}

/** HandoffTraceへ出す1行。閾値の調整に使う。 */
export function describeHandoffAcceptanceVerdict(probability: number, threshold: number): string {
  return `Reflexの受領判定: 受領 ${formatProbability(probability)}（閾値 ${formatProbability(threshold)}）`;
}

/** 判定の材料をHandoffTraceへ出す1行。長い本文は先頭だけにする。 */
export function describeHandoffAcceptanceMaterial(material: HandoffAcceptanceMaterial): string {
  const first = material.messages[0] ?? '';
  return `Reflexの受領判定の材料: 本文${[...material.body].length}字 / 応答${material.messages.length}件「${sanitizeInlineText(first, TRACE_EXCERPT_LENGTH)}」 / 行動${material.actions.length}件`;
}

/** `createHandoffAcceptanceJudge` の入力。 */
export interface HandoffAcceptanceJudgeInput {
  /** Reflexの親スイッチ（タブ単位の上書きを含む）。判定の時点で読む。 */
  readonly enabled: () => boolean;
  /** 受領とみなす確率の下限。判定の時点で読む。 */
  readonly threshold: () => number;
  readonly deps: ReflexJudgeDeps;
  /** 引き継ぎ先へ送った初回プロンプト。 */
  readonly sentPrompt: string;
  /** 初回プロンプトでpointerファイルを指したときだけ渡す。その中身を本文とする。 */
  readonly pointerPath: string | undefined;
  /** 引き継ぎ先のタブが閉じられたか。閉じられたら受領とはみなさない。 */
  readonly destinationDisposed: () => boolean;
  readonly trace: { info(message: string): void };
}

/**
 * `waitForDestinationResponse` へ渡す受領判定を組む。受領と判定したときだけ`true`を返す。
 * 親スイッチがOFF、判定の失敗・時間切れ、閾値未満、引き継ぎ先のタブが閉じられたときは
 * `false`（従来どおり`notAccepted`）。
 */
export function createHandoffAcceptanceJudge(
  input: HandoffAcceptanceJudgeInput,
): (state: ChatState) => Promise<boolean> {
  return async (state) => {
    try {
      return await judgeWith(input, state);
    } catch (error) {
      input.trace.info(
        `Reflexの受領判定が例外で終わったため、受領していないとみなす: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
}

async function judgeWith(input: HandoffAcceptanceJudgeInput, state: ChatState): Promise<boolean> {
  if (!input.enabled()) {
    input.trace.info('Reflexの親スイッチがOFFのため、受領をReflexで判定しない');
    return false;
  }
  const body = await readHandoffBody(input);
  const material = collectHandoffAcceptanceMaterial(body, state.items);
  input.trace.info(describeHandoffAcceptanceMaterial(material));
  const probability = await judgeHandoffAcceptance(input.deps, material);
  if (probability === undefined) {
    // 失敗の理由（時間切れ / 起動失敗 / JSON不正）は `judge` がwarnで出す
    input.trace.info('Reflexの受領判定が失敗したため、受領していないとみなす');
    return false;
  }
  const threshold = input.threshold();
  input.trace.info(describeHandoffAcceptanceVerdict(probability, threshold));
  // 判定を待つ間に引き継ぎ先のタブが閉じられていたら、旧タブまで閉じないよう受領にしない
  if (input.destinationDisposed()) {
    input.trace.info('Reflexの受領判定の間に引き継ぎ先のタブが閉じられたため、受領していないとみなす');
    return false;
  }
  return probability >= threshold;
}

/** pointerファイルの中身を読む。読めなければ初回プロンプトを本文とする。 */
async function readHandoffBody(input: HandoffAcceptanceJudgeInput): Promise<string> {
  if (input.pointerPath === undefined) {
    return input.sentPrompt;
  }
  try {
    return await readFile(input.pointerPath, 'utf8');
  } catch (error) {
    input.trace.info(
      `pointerファイルを読めなかったため、初回プロンプトを本文として受領を判定する: ${error instanceof Error ? error.message : String(error)}`,
    );
    return input.sentPrompt;
  }
}
