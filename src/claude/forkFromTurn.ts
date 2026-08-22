import type { RewindConversationResult } from './control';

/**
 * 会話の途中のターンから分岐する処理（issue #333、design.md §14.61）。
 *
 * `vscode` を一切importしない純粋なロジック層。実際の送受信（`ClaudeStreamSession`）とは
 * 分離し、ユニットテストで検証できるようにする。
 */

/** 1件の `rewind_conversation` を送って応答を待つ関数。呼び出し側（streamSession.ts）が渡す。 */
export type SendRewindConversation = (targetUuid: string) => Promise<RewindConversationResult>;

/** 分岐の結果。 */
export interface ForkFromTurnResult {
  ok: boolean;
  /** 対象の発言本文。成功時のみ入る。入力欄への差し戻しに使う。 */
  prefillText: string | undefined;
  error: string | undefined;
}

/**
 * 対象の発言まで戻すための送信順を組み立てる。
 *
 * `rewind_conversation` は「現在の最後のユーザー発言」しか対象にできない（対象より後ろに
 * 人間由来のユーザー発言が残っていると `stale target` で拒否される。実測、CLI 2.1.235）。
 * 一方で成功のたびに対象以降が削除されるため、**対象以降（対象を含む）のユーザー発言uuidを
 * 会話の新しい順に並べ替えて1件ずつ戻せば、最終的に任意の過去のターンまで戻せる**。
 *
 * @param userMessageUuids 会話中の全ユーザー発言uuid（**古い順**。会話の見た目の並びと同じ）
 * @param targetUuid 分岐したい発言（この発言の手前まで戻す）。この発言自身も戻す対象に含む
 * @returns 送信順（新しい順）。`targetUuid` が一覧に無ければ空配列を返す
 */
export function buildRewindSequence(
  userMessageUuids: readonly string[],
  targetUuid: string,
): string[] {
  const index = userMessageUuids.indexOf(targetUuid);
  if (index === -1) {
    return [];
  }
  return userMessageUuids.slice(index).reverse();
}

/**
 * 対象の発言まで、`rewind_conversation` を逐次送って戻す。
 *
 * 送信は1件ずつ・順番どおりに行う（並列には投げない）。`stale target` を避けるには、
 * 常に「今の時点で最後のユーザー発言」だけを対象にし続ける必要があるため、前の送信の
 * 応答を待ってから次を送る。
 *
 * 途中で `rewound:false` が返ったら即座に打ち切り、それ以降は送らない
 * （応答は失敗時も `subtype:"success"` の封筒で返るため、`sendRewind` の戻り値は
 * `RewindConversationResult.rewound` で判定する。`ok` だけでは成否を判定できない
 * 点は `control.ts` の `readRewindConversationResult` 参照）。
 *
 * 最後（＝対象そのもの）まで戻し切ると、その応答の `prefillText` を返す。
 */
export async function forkFromTurn(
  userMessageUuids: readonly string[],
  targetUuid: string,
  sendRewind: SendRewindConversation,
): Promise<ForkFromTurnResult> {
  const sequence = buildRewindSequence(userMessageUuids, targetUuid);
  if (sequence.length === 0) {
    return { ok: false, prefillText: undefined, error: '対象の発言が見つかりません' };
  }

  let last: RewindConversationResult | undefined;
  for (const uuid of sequence) {
    last = await sendRewind(uuid);
    if (!last.rewound) {
      return { ok: false, prefillText: undefined, error: last.error ?? '不明なエラー' };
    }
  }
  return { ok: true, prefillText: last?.prefillText, error: undefined };
}
