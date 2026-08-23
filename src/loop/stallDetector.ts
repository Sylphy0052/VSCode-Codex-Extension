import type { ChatState } from '../appserver/chatState';

/**
 * ループの停滞判定（design.md §16.27、Issue #336）。
 *
 * `vscode` に依存しない純粋関数のみを置く。`LoopController.observe()` がターン完了の
 * たびに呼び、`agent.workflows.stallRepeatCount`（既定値は下の `DEFAULT_STALL_REPEAT_COUNT`）
 * だけ直近の応答要約が連続して同一なら停滞とみなす。方式の選定理由は design.md §16.27参照
 * （「直近N回の応答要約が同一」を採用し、「編集ファイル0のターン連続」「同じエラー文字列の
 * 反復」は採らなかった）。
 */

/** しきい値の既定値。保守的（誤検知しない）側に振った値（design.md §16.27）。 */
export const DEFAULT_STALL_REPEAT_COUNT = 4;
/** しきい値として許容する最小値。2未満は「反復」の判定として意味を持たない。 */
export const MIN_STALL_REPEAT_COUNT = 2;
/** しきい値として許容する最大値。`LOOP_ITERATION_LIMIT`（200）を大きく超えない程度に絞る。 */
export const MAX_STALL_REPEAT_COUNT = 50;

/**
 * ターン完了時点の `ChatState` から、停滞判定に使う比較用テキストを取り出す。
 *
 * **`state.turnResultText` だけを見る。`state.items` 全体へフォールバックしない。**
 * `orchestrator/taskSummary.ts` の `buildResponseSummary`（表示用の1行要約）は
 * `turnResultText` が空のとき `lastNonEmptyAgentMessageText(state.items)` で直近の
 * 発言まで遡るが、これは「表示用に何かしら見せたい」要件であって、こちらの
 * 「このターンで進んだかどうかを比較したい」要件とは違う。`items` 全体へ遡ると、
 * ツール呼び出しだけで本文を返さないターンが続いたときに**古いターンの発言テキストを
 * 使い回して比較してしまい**、編集内容が毎回違っても同じ署名が返り続けて誤検知する
 * （design.md §16.27）。`turnResultText`（`summarizeTurn` がそのターンの `turnId` に
 * 属する `agentMessage` だけを連結した値）が空のときは、そのターンは
 * **比較不能として扱い空文字を返す**——`detectStalledLoop` は空文字の反復を停滞と
 * 見なさないため、この空文字が連続しても誤検知しない。表示用の値へは重ねない
 * （`taskSummary.ts` 側の役割のまま）ため、このモジュールは切り詰め・制御文字の
 * 除去も行わない（比較にしか使わず、画面・ログへ直接出さないため。無害化の
 * 一本化された適用地点は`taskSummary.ts`が作る`lastResponseSummary`の経路。
 * design.md §16.24 参照）。
 */
export function extractTurnSignature(state: ChatState): string {
  return state.turnResultText.trim();
}

/**
 * 直近の応答テキストの履歴へ1件足す。`threshold` 件を超えた古い分は捨てる
 * （判定に使わない履歴を際限なく保持しない）。
 */
export function pushTurnSignature(
  history: readonly string[],
  signature: string,
  threshold: number,
): string[] {
  const next = [...history, signature];
  const keep = Math.max(threshold, MIN_STALL_REPEAT_COUNT);
  return next.length > keep ? next.slice(next.length - keep) : next;
}

/**
 * 直近 `threshold` 件の応答テキストが、空でなくかつ全て同一なら停滞と判定する。
 *
 * 空文字（「まだ応答が無い」の意味）の反復は判定の対象にしない——ターンが始まる前や、
 * 応答が読み取れなかった場合まで「停滞」と誤検知しないため。
 */
export function detectStalledLoop(history: readonly string[], threshold: number): boolean {
  if (threshold < MIN_STALL_REPEAT_COUNT || history.length < threshold) {
    return false;
  }
  const tail = history.slice(history.length - threshold);
  const first = tail[0];
  if (first === undefined || first === '') {
    return false;
  }
  return tail.every((signature) => signature === first);
}
