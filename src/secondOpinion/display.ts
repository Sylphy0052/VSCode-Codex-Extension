/**
 * セカンドオピニオン（Issue #894）を会話へ1項目として残すときの見せ方。
 *
 * `vscode` を一切importしない純粋なロジック層（`claude/sideQuestion.ts` と同じ役割）。
 * 会話への差し込みは `ChatSession` / `ClaudeStreamSession` の `noteSecondOpinion`、
 * 起動と待ち合わせは view 層が持ち、ここは文字列の組み立てだけを持つ。
 */

import type { SecondOpinionCandidate } from './candidates';
import { ARTIFACT_KIND_LABELS, type SecondOpinionArtifactKind } from './prompt';

/** 会話へ残す1項目の中身。`ChatItem` の `text` / `detail` / `status` にそのまま入る。 */
export interface SecondOpinionDisplay {
  status: 'inProgress' | 'completed' | 'failed';
  text: string;
  detail: string;
}

/** 依頼先と、渡した対象の1行表記。 */
function describeRun(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
): string {
  return `${candidate.model} / ${candidate.effort} ・ ${ARTIFACT_KIND_LABELS[artifactKind]}`;
}

/**
 * 何を渡した上での意見なのかを示す固定の注記。
 *
 * 独立性とは、作業を担当したAIのセッション状態・内部コンテキストを継承しないことであり、
 * コンテキストがゼロであることではない（Issue #926 P0）。それが読み手に伝わらないと、
 * 返ってきた意見の重みを判断できない（背景を踏まえた意見なのか、踏まえていない意見なのかで
 * 扱いが変わる）。毎回出す。
 */
const INDEPENDENT_NOTE = '作業中のAIとは別セッションの意見です（背景は添えていません）';

/**
 * 背景要約（Issue #903）を添えた場合の注記。
 *
 * 渡したのは会話そのものではなく、別セッションが記録から作った圧縮であることを、
 * 読み手が区別できるように書き分ける。
 */
const SUMMARY_ATTACHED_NOTE =
  '作業中のAIとは別セッションの意見です（会話そのものは渡さず、別セッションが作った背景要約を添えています）';

/**
 * 背景要約が作れなかったときの注記。
 *
 * ログにだけ残すと、タブを開かない設定では人に何も見えない。要約を期待したのに
 * 付いていない状態は意見の読み方が変わるため、会話へ必ず残す（受入基準5）。
 */
const SUMMARY_FAILED_NOTE =
  '作業中のAIとは別セッションの意見です（背景要約は作れなかったため添えていません）';

/**
 * 会話が短く、要約せずに記録そのものを背景として渡した場合の注記（Issue #944）。
 *
 * 「要約を添えた」と出すと、圧縮による抜けを警戒しながら読ませることになる。渡したのが
 * 記録そのものである以上、その但し書きは事実と違う。
 */
const TRANSCRIPT_ATTACHED_NOTE =
  '作業中のAIとは別セッションの意見です（会話が短いため、要約せず記録そのものを背景に添えています）';

/** 要約の結末。`off` は設定で切っている・要約する会話がまだ無い場合。 */
export type SecondOpinionSummaryStatus = 'off' | 'attached' | 'transcript' | 'failed';

function independenceNote(summaryStatus: SecondOpinionSummaryStatus): string {
  switch (summaryStatus) {
    case 'attached':
      return SUMMARY_ATTACHED_NOTE;
    case 'transcript':
      return TRANSCRIPT_ATTACHED_NOTE;
    case 'failed':
      return SUMMARY_FAILED_NOTE;
    case 'off':
      return INDEPENDENT_NOTE;
  }
}

/** 起動直後、応答が届く前の表示。 */
export function pendingSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンを依頼しました（${candidate.name}）\n\n${request}`,
    detail: `実行中… ・ ${describeRun(candidate, artifactKind)}`,
  };
}

/**
 * 応答が届いた後の表示。
 *
 * 回答は要約せず全文をそのまま載せる（別モデルの解釈を挟むと、独立した意見としての
 * 値打ちが落ちるため。Issue #894 の受入基準6）。
 */
export function finishedSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
  response: string,
  summaryStatus: SecondOpinionSummaryStatus = 'off',
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text: `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n**回答**\n\n${response}`,
    detail: `${independenceNote(summaryStatus)} ・ ${describeRun(candidate, artifactKind)}`,
  };
}

/**
 * 打ち切られ、そこまでの回答だけが返ったときの表示（Issue #907）。
 *
 * 失敗ではなく完了として出す——内容は本物の回答であり、読む値打ちがあるため。ただし
 * 途中で切れていることが分からないと、指摘が出ていないのか出せなかったのかを取り違える。
 * 本文の冒頭と注記の両方に、打ち切られた事実を出す。
 */
export function partialSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
  response: string,
  reason: string,
  summaryStatus: SecondOpinionSummaryStatus = 'off',
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text:
      `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n` +
      `**回答（打ち切り時点まで）**\n\n${response}`,
    detail: `${reason}（ここまでの回答を残しています） ・ ${independenceNote(summaryStatus)} ・ ${describeRun(candidate, artifactKind)}`,
  };
}

/**
 * askGptモード（Issue #947）の注記。
 *
 * 既定モードの注記が「背景を添えたか」を伝えるのに対し、こちらが伝えるべきは
 * 「渡したのは作業中のAI自身が組み立てた質問文である」こと。同じ独立性でも、資料を
 * 選んだのが拡張機能なのか作業中のAIなのかで、返ってきた意見の読み方が変わる。
 */
const ASK_GPT_NOTE =
  '作業中のAIとは別セッションの意見です（作業中のAIが組み立てた質問文だけを渡しています）';

/**
 * askGptモードの実行条件の1行表記。
 *
 * 質問文の全文は載せない。関連コードの全文を含むため会話が埋まってしまう。何を送ったかは
 * 分量で示し、中身は送信前の確認（`agent.secondOpinion.askGpt.confirm`）で見てもらう。
 */
function describeAskGptRun(
  candidate: SecondOpinionCandidate,
  extras: (string | undefined)[],
): string {
  return [
    `${candidate.model} / ${candidate.effort}`,
    ...extras.filter((e) => e !== undefined),
  ].join(' ・ ');
}

/**
 * askGptモードの進行中表示。
 *
 * `phase` で「質問文を組み立てている」段階と「意見を待っている」段階を書き分ける。生成は
 * リポジトリの読み取りを伴い、本体と同じくらい待つことがあるため、どちらで待っているのかが
 * 分からないと止まって見える。
 */
export function pendingAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  phase: string,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンを依頼しました（${candidate.name}）\n\n${request}`,
    detail: describeAskGptRun(candidate, [phase]),
  };
}

/** askGptモードの完了表示。 */
export function finishedAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  response: string,
  requestTextChars: number,
  redactionNote: string | undefined,
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text: `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n**回答**\n\n${response}`,
    detail: describeAskGptRun(candidate, [
      ASK_GPT_NOTE,
      `質問文${requestTextChars.toLocaleString('en-US')}文字`,
      redactionNote,
    ]),
  };
}

/** askGptモードの、打ち切られてそこまでの回答だけが返ったときの表示。 */
export function partialAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  response: string,
  reason: string,
  requestTextChars: number,
  redactionNote: string | undefined,
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text:
      `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n` +
      `**回答（打ち切り時点まで）**\n\n${response}`,
    detail: describeAskGptRun(candidate, [
      `${reason}（ここまでの回答を残しています）`,
      ASK_GPT_NOTE,
      `質問文${requestTextChars.toLocaleString('en-US')}文字`,
      redactionNote,
    ]),
  };
}

/**
 * askGptモードの失敗表示。
 *
 * 質問文の生成に失敗した場合もここへ来る。Advisorを開始していないことが読み取れるよう、
 * 理由には何の段階で止まったかを含めて渡す（呼び出し側の責務）。
 */
export function failedAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: `セカンドオピニオン（${candidate.name}）\n\n${request}`,
    detail: describeAskGptRun(candidate, [reason]),
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
  artifactKind: SecondOpinionArtifactKind,
  request: string,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: `セカンドオピニオン（${candidate.name}）\n\n${request}`,
    detail: `${reason} ・ ${describeRun(candidate, artifactKind)}`,
  };
}
