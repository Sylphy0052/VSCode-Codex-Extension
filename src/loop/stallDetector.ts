import { lastNonEmptyAgentMessageText, type ChatState } from '../appserver/chatState';

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
 * `orchestrator/taskSummary.ts` の `buildResponseSummary`（表示用の1行要約）と起点は
 * 同じ（`turnResultText` を優先し、無ければ直近の `agentMessage`）だが、こちらは
 * **表示や通知へ直接載せない**（比較にしか使わない）値のため、切り詰め・制御文字の
 * 除去は行わない。外部由来テキストを画面・ログへ出す際の無害化（`sanitizeForLog` /
 * `escapeAngleBrackets` 等の一本化された適用地点）は、このモジュールの外
 * （`taskSummary.ts` が作る `lastResponseSummary` の経路）にすでにあり、ここへ重ねて
 * 適用すると「どちらが最終防御か」が曖昧になる（design.md §16.24 参照）。
 */
export function extractTurnSignature(state: ChatState): string {
  const source =
    state.turnResultText !== '' ? state.turnResultText : lastNonEmptyAgentMessageText(state.items);
  return source.trim();
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
