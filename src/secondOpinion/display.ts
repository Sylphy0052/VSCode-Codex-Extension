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
 * askGptモードで、利用者が止めたときの表示（Issue #940の扱いに合わせる）。
 *
 * `failed` にはしない。止めたのは利用者であって、機能が失敗したわけではない。止めた段階
 * （質問文の組み立て中か、意見を待っている間か）は `reason` で呼び出し側が渡す。
 */
export function cancelledAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text: `セカンドオピニオン（${candidate.name}）\n\n${request}`,
    detail: describeAskGptRun(candidate, [reason]),
  };
}

/**
 * askGptモードで、利用者が止め、そこまでの回答が出ていたときの表示。
 *
 * 残し方は {@link partialAskGptDisplay}（打ち切り）と同じだが、見出しと注記で理由を
 * 区別する。止めた本人に「時間切れ」と読ませない。
 */
export function cancelledPartialAskGptDisplay(
  candidate: SecondOpinionCandidate,
  request: string,
  response: string,
  requestTextChars: number,
  redactionNote: string | undefined,
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text:
      `セカンドオピニオン（${candidate.name}）\n\n**依頼**\n\n${request}\n\n` +
      `**回答（利用者が停止した時点まで）**\n\n${response}`,
    detail: describeAskGptRun(candidate, [
      CANCELLED_WITH_RESPONSE_NOTE,
      ASK_GPT_NOTE,
      `質問文${requestTextChars.toLocaleString('en-US')}文字`,
      redactionNote,
    ]),
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

/**
 * 相談の続き（Issue #929 Consult）で会話へ残す注記。
 *
 * 追加の往復であること、渡ったのは利用者の質問だけであることを毎回出す。1ターン目の注記
 * （{@link independenceNote}）が「何を材料に判断したか」を伝えるのに対し、こちらが伝えるのは
 * 「これは同じ相談の続きで、作業中のAIは介在していない」ことである。
 */
const FOLLOW_UP_NOTE = '同じ相談相手への追加の質問です（作業中のAIには送っていません）';

/** 依頼先の1行表記。追加の相談では渡した資料の種類を出さない（1ターン目の材料のままのため）。 */
function describeFollowUpRun(candidate: SecondOpinionCandidate): string {
  return `${candidate.model} / ${candidate.effort}`;
}

/** 相談の続きの、応答を待っている間の表示。 */
export function pendingFollowUpDisplay(
  candidate: SecondOpinionCandidate,
  question: string,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンへ追加で相談しました（${candidate.name}）\n\n${question}`,
    detail: `実行中… ・ ${FOLLOW_UP_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/**
 * 相談の続きの、回答が届いた後の表示。
 *
 * 打ち切られてそこまでの回答だけが返った場合は `partialReason` を渡す。1ターン目と同じく、
 * 途中で切れていることが読み取れないと、指摘が出ていないのか出せなかったのかを取り違える。
 */
export function finishedFollowUpDisplay(
  candidate: SecondOpinionCandidate,
  question: string,
  response: string,
  partialReason?: string,
): SecondOpinionDisplay {
  const heading = partialReason === undefined ? '**回答**' : '**回答（打ち切り時点まで）**';
  return {
    status: 'completed',
    text:
      `セカンドオピニオン・追加の相談（${candidate.name}）\n\n**質問**\n\n${question}\n\n` +
      `${heading}\n\n${response}`,
    detail: [
      ...(partialReason === undefined ? [] : [`${partialReason}（ここまでの回答を残しています）`]),
      FOLLOW_UP_NOTE,
      describeFollowUpRun(candidate),
    ].join(' ・ '),
  };
}

/** 相談の続きが失敗したときの表示。 */
export function failedFollowUpDisplay(
  candidate: SecondOpinionCandidate,
  question: string,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: `セカンドオピニオンへ追加で相談しました（${candidate.name}）\n\n${question}`,
    detail: `${reason} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/** 相談の続きを利用者が止めたときの表示。 */
export function cancelledFollowUpDisplay(
  candidate: SecondOpinionCandidate,
  question: string,
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text: `セカンドオピニオンへ追加で相談しました（${candidate.name}）\n\n${question}`,
    detail: `${CANCELLED_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/**
 * 材料の更新（Issue #975）で会話へ残す注記。
 *
 * 更新は利用者が明示的に押したときにだけ起きる。自動で入れ替わったのではないことを毎回
 * 出しておかないと、後から会話を読み返したときに「いつの材料で話していたのか」が辿れない。
 */
const MATERIAL_UPDATE_NOTE = '利用者の操作で材料を更新しました（作業中のAIには送っていません）';

/** 材料の更新を伝えている間の表示。 */
export function pendingMaterialUpdateDisplay(
  candidate: SecondOpinionCandidate,
): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: 'セカンドオピニオンのレビュー材料を最新の状態へ更新しています',
    detail: `実行中… ・ ${MATERIAL_UPDATE_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/**
 * 材料の更新が済んだときの表示。
 *
 * Advisorからの応答も一緒に残す。更新の連絡に対して何を読み直したのか、前の議論と食い違う
 * 点をどう見たのかが、次の質問を考える材料になる。
 */
export function finishedMaterialUpdateDisplay(
  candidate: SecondOpinionCandidate,
  revision: number,
  response: string,
  partialReason?: string,
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text:
      `セカンドオピニオンのレビュー材料を更新しました（第${revision}世代）\n\n` +
      `**相談相手の応答**\n\n${response}`,
    detail: [
      ...(partialReason === undefined ? [] : [`${partialReason}（ここまでの応答を残しています）`]),
      MATERIAL_UPDATE_NOTE,
      describeFollowUpRun(candidate),
    ].join(' ・ '),
  };
}

/** 材料の更新が失敗したときの表示。以後も前の世代の材料で相談は続けられる。 */
export function failedMaterialUpdateDisplay(
  candidate: SecondOpinionCandidate,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: 'セカンドオピニオンのレビュー材料を更新できませんでした（相談は更新前の材料のまま続けられます）',
    detail: `${reason} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/** 材料の更新を利用者が止めたときの表示。 */
export function cancelledMaterialUpdateDisplay(
  candidate: SecondOpinionCandidate,
): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text: 'セカンドオピニオンのレビュー材料の更新を停止しました（相談は更新前の材料のまま続けられます）',
    detail: `${CANCELLED_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/** 下書きがまだ送られていないことの断り書き。 */
const HANDOFF_PENDING_NOTE = 'まだ作業中のAIへは送っていません（承認するまで送りません）';

/** 下書きを待っている間の表示。 */
export function pendingHandoffDisplay(candidate: SecondOpinionCandidate): SecondOpinionDisplay {
  return {
    status: 'inProgress',
    text: `セカンドオピニオンへメインAIへの指示の下書きを依頼しました（${candidate.name}）`,
    detail: `実行中… ・ ${HANDOFF_PENDING_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/**
 * メインAIへの指示の下書き（Issue #929 Handoff）の表示。
 *
 * 会話へ出すのは**要約と指示文の全文**である。指示文を畳んだり省略したりしない——承認すれば
 * そのまま作業中のAIへ渡る文なので、承認の前に全文が見えている必要がある。
 *
 * `detail` に「まだ送っていない」と明記するのは、下書きが出た時点で送信済みと読み違えられる
 * ことを防ぐため。この機能で一番取り返しがつかないのは、送るつもりのない文が送られることである。
 */
export function draftedHandoffDisplay(
  candidate: SecondOpinionCandidate,
  draft: { userSummary: string; mainInstruction: string },
): SecondOpinionDisplay {
  return {
    status: 'completed',
    text:
      `セカンドオピニオン・メインAIへの指示の下書き（${candidate.name}）\n\n` +
      `**この相談の要約**\n\n${draft.userSummary}\n\n` +
      `**メインAIへの指示（案）**\n\n${draft.mainInstruction}`,
    detail: `${HANDOFF_PENDING_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/**
 * 下書きの作成が失敗したときの表示。
 *
 * 応答が形式どおりに読めなかった場合もここへ来る（`parseHandoffDraft` の失敗）。読めない応答を
 * そのまま下書きとして見せると、要約と指示文の切り分けが合っているかを利用者が確かめられない。
 */
export function failedHandoffDisplay(
  candidate: SecondOpinionCandidate,
  reason: string,
): SecondOpinionDisplay {
  return {
    status: 'failed',
    text: `セカンドオピニオンへメインAIへの指示の下書きを依頼しました（${candidate.name}）`,
    detail: `${reason} ・ ${describeFollowUpRun(candidate)}`,
  };
}

/** 下書きの作成を利用者が止めたときの表示。 */
export function cancelledHandoffDisplay(candidate: SecondOpinionCandidate): SecondOpinionDisplay {
  return {
    status: 'cancelled',
    text: `セカンドオピニオンへメインAIへの指示の下書きを依頼しました（${candidate.name}）`,
    detail: `${CANCELLED_NOTE} ・ ${describeFollowUpRun(candidate)}`,
  };
}
