/**
 * セカンドオピニオン（Issue #894）を会話へ1項目として残すときの見せ方。
 *
 * `vscode` を一切importしない純粋なロジック層（`claude/sideQuestion.ts` と同じ役割）。
 * 会話への差し込みは `ChatSession` / `ClaudeStreamSession` の `noteSecondOpinion`、
 * 起動と待ち合わせは view 層が持ち、ここは文字列の組み立てだけを持つ。
 */

import type { SecondOpinionCandidate } from './candidates';
import { CONTEXT_KIND_LABELS, type SecondOpinionContextKind } from './prompt';

/** 会話へ残す1項目の中身。`ChatItem` の `text` / `detail` / `status` にそのまま入る。 */
export interface SecondOpinionDisplay {
  status: 'inProgress' | 'completed' | 'failed';
  text: string;
  detail: string;
}

/** 依頼先と、渡した対象の1行表記。 */
function describeRun(
  candidate: SecondOpinionCandidate,
  contextKind: SecondOpinionContextKind,
): string {
  return `${candidate.model} / ${candidate.effort} ・ ${CONTEXT_KIND_LABELS[contextKind]}`;
}

/**
 * 「この会話は渡していない」旨の固定の注記。
 *
 * この機能の値打ちは独立したコンテキストで評価させることにあり、それが読み手に
 * 伝わらないと、返ってきた指摘の重みを判断できない（会話を踏まえた指摘なのか、
 * 踏まえていない指摘なのかで、扱いが変わる）。毎回出す。
 */
const INDEPENDENT_NOTE = 'この会話の内容は渡していません（独立したセッションの評価です）';

/**
 * 要約（Issue #903）を添えた場合の注記。
 *
 * 「会話は渡していない」とだけ出すと事実と食い違う。渡したのは会話そのものではなく、
 * 別セッションが記録から作った圧縮であることを、読み手が区別できるように書き分ける。
 */
const SUMMARY_ATTACHED_NOTE =
  'この会話そのものは渡していません（別セッションが作った要約のみを添えた独立評価です）';

/**
 * 要約が作れなかったときの注記。
 *
 * ログにだけ残すと、タブを開かない設定では人に何も見えない。要約を期待したのに
 * 付いていない状態は指摘の読み方が変わるため、会話へ必ず残す（受入基準5）。
 */
const SUMMARY_FAILED_NOTE =
  'この会話の内容は渡していません（会話の要約は作れなかったため添えていません）';

/** 要約の結末。`off` は設定で切っている・要約する会話がまだ無い場合。 */
export type SecondOpinionSummaryStatus = 'off' | 'attached' | 'failed';

function independenceNote(summaryStatus: SecondOpinionSummaryStatus): string {
  switch (summaryStatus) {
    case 'attached':
      return SUMMARY_ATTACHED_NOTE;
    case 'failed':
      return SUMMARY_FAILED_NOTE;
    case 'off':
      return INDEPENDENT_NOTE;
  }
}

/** 起動直後、応答が届く前の表示。 */
export function pendingSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  contextKind: SecondOpinionContextKind,
  request: string,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンを依頼しました（${candidate.name}）\n\n${request}`,
    detail: `実行中… ・ ${describeRun(candidate, contextKind)}`,
  };
}

/**
 * 応答が届いた後の表示。
 *
 * 回答は要約せず全文をそのまま載せる（別モデルの解釈を挟むと、独立レビューとしての
 * 値打ちが落ちるため。Issue #894 の受入基準6）。
 */
export function finishedSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  contextKind: SecondOpinionContextKind,
  request: string,
  response: string,
  summaryStatus: SecondOpinionSummaryStatus = 'off',
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text: `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n**回答**\n\n${response}`,
    detail: `${independenceNote(summaryStatus)} ・ ${describeRun(candidate, contextKind)}`,
  };
}

/**
 * 失敗・打ち切りの表示。
 *
 * タブを開かない（headless）場合、ここに出さないと人には何も見えない。理由を必ず載せる
 * （受入基準9・10）。
 */
export function failedSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  contextKind: SecondOpinionContextKind,
  request: string,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: `セカンドオピニオン（${candidate.name}）\n\n${request}`,
    detail: `${reason} ・ ${describeRun(candidate, contextKind)}`,
  };
}
