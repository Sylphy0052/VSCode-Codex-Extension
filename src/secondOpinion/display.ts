/**
 * セカンドオピニオン（Issue #894）を会話へ1項目として残すときの見せ方。
 *
 * `vscode` を一切importしない純粋なロジック層（`claude/sideQuestion.ts` と同じ役割）。
 * 会話への差し込みは `ChatSession` / `ClaudeStreamSession` の `noteSecondOpinion`、
 * 起動と待ち合わせは view 層が持ち、ここは文字列の組み立てだけを持つ。
 */

import type { SecondOpinionCandidate } from './candidates';
import { ARTIFACT_KIND_LABELS, type SecondOpinionArtifactKind } from './prompt';

/**
 * 会話へ残す1項目の中身。`ChatItem` の `text` / `detail` / `status` にそのまま入る。
 *
 * `cancelled` は利用者が止めたとき（Issue #940）。`failed` と分けているのは、止めたのは
 * 本人であって失敗ではないため。webview側の見出しラベル（`chatScript.ts` の
 * `STATUS_LABEL`）にも同じ値を足してある。
 */
export interface SecondOpinionDisplay {
  status: 'inProgress' | 'completed' | 'failed' | 'cancelled';
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

/**
 * 親セッションのターンが終わるのを待っている間の表示（Issue #949）。
 *
 * 押した直後に出す。依頼の内容はもう固まっている（依頼先・追加資料・依頼文はここへ来る前に
 * 決まり、変更のスナップショットも取得済み）ことが読めるように、`pendingSecondOpinionDisplay`
 * と同じ本文を使い、`detail` の先頭だけを待機の表示に替える。
 *
 * `status` は `inProgress` のままにする。待機も含めて「この会話でセカンドオピニオンが1件
 * 進行中」であることに変わりはなく、webview側（`chatScript.ts` の `STATUS_LABEL`）に
 * 状態を増やすと、停止ボタンの出し分けなど既存の分岐がすべて増える。
 */
export function queuedSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンを依頼しました（${candidate.name}）\n\n${request}`,
    detail: `順番待ち（この会話の応答が終わってから始めます）… ・ ${describeRun(candidate, artifactKind)}`,
  };
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
 * 利用者が止めたときの注記（Issue #940）。
 *
 * 「停止しました」と言い切らない。拡張が保証するのは、停止操作を受け付けてこの実行を
 * 拡張側で終了扱いにし、可能な状態であればCLIへ打ち切りを要求するところまでで、CLIの
 * ターンやその子プロセスが止まったことは確認していない（Issue #926 D / #246）。
 * ターンidがまだ割り当たっていない等の理由で、要求自体を送れないこともある。
 */
const CANCELLED_NOTE =
  '停止を要求し、この実行を拡張側では終了扱いにしました。相手側の処理が停止したことは確認していません';

/** 止めた時点までの回答が残っている場合の注記（Issue #940）。 */
const CANCELLED_WITH_RESPONSE_NOTE =
  '利用者が停止を要求しました。ここまでの回答を残しています。相手側では処理が続いている可能性があります';

/**
 * 利用者が止め、回答が1件も出ていなかったときの表示（Issue #940）。
 *
 * `failed` にはしない。止めたのは利用者であって、機能が失敗したわけではない。実行中の
 * 項目を消さずにここへ更新するのは、タブを開かない設定では会話のこの項目だけが唯一の
 * 手掛かりであり、消すと「押したのに何も残らない」状態になるため。
 */
export function cancelledSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text: `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}`,
    detail: `${CANCELLED_NOTE} ・ ${describeRun(candidate, artifactKind)}`,
  };
}

/**
 * 利用者が止め、そこまでの回答が出ていたときの表示（Issue #940）。
 *
 * 残し方は {@link partialSecondOpinionDisplay}（タイムアウト）と同じだが、本文の見出しと
 * 注記で理由を区別する。止めた本人に「時間切れ」と読ませない。
 */
export function cancelledPartialSecondOpinionDisplay(
  candidate: SecondOpinionCandidate,
  artifactKind: SecondOpinionArtifactKind,
  request: string,
  response: string,
  summaryStatus: SecondOpinionSummaryStatus = 'off',
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text:
      `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n` +
      `**回答（利用者が停止した時点まで）**\n\n${response}`,
    detail: `${CANCELLED_WITH_RESPONSE_NOTE} ・ ${independenceNote(summaryStatus)} ・ ${describeRun(candidate, artifactKind)}`,
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
