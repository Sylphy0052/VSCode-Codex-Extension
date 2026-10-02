import { readFile } from 'node:fs/promises';

import type { ChatState } from '../appserver/chatState';
import { sanitizeInlineText } from '../orchestrator/untrustedText';
import { formatReflexProbability, noulAnswer } from '../reflex/reflexAnswer';
import { judge, type ReflexJudgeDeps } from '../reflex/reflexJudge';

/**
 * 引き継ぎ先の受領をReflexで判定する（Issue #1840）。
 *
 * 受領行（#1751）もpointerファイルの読み込み（#1797）も無いまま `notAccepted` で決着しそうな
 * ときだけ、「引き継ぎ先は本文を読めているか」を1回の`judge()`で尋ねる。`vscode`には依存しない。
 * 外部由来の本文・応答・コマンドは、`judge()`が状態として囲って渡す（`formatUntrusted`）。
 */

/** `agent.autoHandoff.reflex.acceptanceThreshold`の値。`config.ts`が読み出し、ここへは値だけを渡す。 */
export interface HandoffAcceptanceReflexSettings {
  /** Reflexモードの親スイッチ（タブ単位の上書きを含む）。OFFなら判定しない。 */
  enabled: boolean;
  /** 受領の確率がこれ以上なら受領とする。 */
  acceptanceThreshold: number;
}

// 初期値は仮置き。確率はモデルの自己申告で較正されていないため、使ってから調整する
export const DEFAULT_HANDOFF_ACCEPTANCE_REFLEX_THRESHOLD = 0.6;

/** 判定の材料に入れる量の上限（コードポイント単位）。合計は`REFLEX_STATE_LIMIT`（2万）に収める。 */
const BODY_MAX_LENGTH = 10_000;
const MESSAGES_MAX_COUNT = 5;
const MESSAGES_MAX_LENGTH = 1_500;
const ACTIONS_MAX_COUNT = 30;
const ACTION_MAX_LENGTH = 200;
/** HandoffTraceへ出す材料の抜粋の長さ。 */
const TRACE_EXCERPT_LENGTH = 60;

export interface HandoffAcceptanceMaterial {
  /** handoffの本文（pointerの中身か、本文として渡した初回プロンプト）。 */
  readonly handoffBody: string;
  /** 引き継ぎ先の`agentMessage`。先頭の側から数件。 */
  readonly agentMessages: readonly string[];
  /** 引き継ぎ先が実行したコマンドと読んだファイル（`detail`）。 */
  readonly actions: readonly string[];
}

function keepHead(text: string, maxLength: number): string {
  const chars = [...text];
  return chars.length <= maxLength ? text : `${chars.slice(0, maxLength).join('')}…`;
}

/** 引き継ぎ先の状態から、判定の材料のうち応答と行動を集める。 */
export function collectHandoffAcceptanceActivity(
  state: ChatState,
): Pick<HandoffAcceptanceMaterial, 'agentMessages' | 'actions'> {
  const agentMessages: string[] = [];
  const actions: string[] = [];
  for (const item of state.items) {
    if (item.kind === 'agentMessage') {
      if (agentMessages.length < MESSAGES_MAX_COUNT) {
        agentMessages.push(keepHead(item.text, MESSAGES_MAX_LENGTH));
      }
    } else if (item.kind === 'commandExecution' || item.kind === 'fileRead') {
      if (actions.length < ACTIONS_MAX_COUNT) {
        // 1件を1行へ畳む。改行を残すと、状態の中で偽の見出しを作れてしまう
        actions.push(`${item.kind}: ${sanitizeInlineText(item.detail, ACTION_MAX_LENGTH)}`);
      }
    }
  }
  return { agentMessages, actions };
}

/** 「引き継ぎ先は本文を読めているか」を1回の`judge()`で尋ねる。確率を返し、失敗は`undefined`。 */
export async function judgeHandoffAcceptance(
  deps: ReflexJudgeDeps,
  material: HandoffAcceptanceMaterial,
): Promise<number | undefined> {
  const messages =
    material.agentMessages.length === 0
      ? '（応答なし）'
      : material.agentMessages.map((m, i) => `### 応答${i + 1}\n${m}`).join('\n\n');
  const actions = material.actions.length === 0 ? '（なし）' : material.actions.join('\n');
  const answers = await judge(deps, {
    situation: [
      'AIエージェントのセッションから、新しいセッションへ作業を引き継いだ。新しいセッションには',
      '引き継ぎの本文（前提・やったこと・次の1手）が渡されている。新しいセッションは本文が求めた',
      '受領の合図を返さなかったため、本文を読めているかどうかを、応答と行動から判定する。',
      '状態は、引き継ぎの本文、新しいセッションの応答の先頭の数件、新しいセッションが実行した',
      'コマンドと読んだファイルである。',
    ].join(''),
    state: [
      '## 引き継ぎの本文',
      keepHead(material.handoffBody, BODY_MAX_LENGTH),
      '',
      '## 新しいセッションの応答',
      messages,
      '',
      '## 新しいセッションが実行したコマンドと読んだファイル',
      actions,
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

/** HandoffTraceへ出す1行。閾値の調整に使う。確率が取れなかったときは`probability`を`undefined`にする。 */
export function describeHandoffAcceptanceVerdict(
  probability: number | undefined,
  threshold: number,
  material: HandoffAcceptanceMaterial,
): string {
  const verdict =
    probability === undefined
      ? '判定できず（旧タブは残す）'
      : `受領の確率 ${formatReflexProbability(probability)}（閾値 ${formatReflexProbability(threshold)}）`;
  const first = sanitizeInlineText(material.agentMessages[0] ?? '', TRACE_EXCERPT_LENGTH);
  return `受領のReflex判定: ${verdict} / 本文${[...material.handoffBody].length}字 / 応答${material.agentMessages.length}件 先頭「${first}」 / 行動${material.actions.length}件`;
}

export interface HandoffAcceptanceJudgeInput {
  settings: HandoffAcceptanceReflexSettings;
  deps: ReflexJudgeDeps;
  /** handoffの本文。pointerで渡した経路では、pointerファイルのパスも渡す。 */
  handoff: { text: string; pointerPath?: string };
  /** 判定結果の1行の出力先（HandoffTrace）。 */
  report: (line: string) => void;
}

/**
 * `waitForDestinationResponse`へ渡す受領の判定関数を作る。親スイッチがOFFなら`undefined`
 * （呼び出し側は従来どおり`notAccepted`で決着する）。失敗・閾値未満は`false`へ倒す。
 */
export function createHandoffAcceptanceJudge(
  input: HandoffAcceptanceJudgeInput,
): ((state: ChatState) => Promise<boolean>) | undefined {
  if (!input.settings.enabled) {
    return undefined;
  }
  return async (state) => {
    try {
      const handoffBody = await readHandoffBody(input.handoff);
      const material: HandoffAcceptanceMaterial = {
        handoffBody,
        ...collectHandoffAcceptanceActivity(state),
      };
      const probability = await judgeHandoffAcceptance(input.deps, material);
      input.report(
        describeHandoffAcceptanceVerdict(probability, input.settings.acceptanceThreshold, material),
      );
      return probability !== undefined && probability >= input.settings.acceptanceThreshold;
    } catch {
      return false;
    }
  };
}

/** pointerファイルの中身。読めなければ（本文として渡した経路を含め）渡した本文そのもの。 */
async function readHandoffBody(handoff: { text: string; pointerPath?: string }): Promise<string> {
  if (handoff.pointerPath === undefined) {
    return handoff.text;
  }
  try {
    return await readFile(handoff.pointerPath, 'utf8');
  } catch {
    return handoff.text;
  }
}
