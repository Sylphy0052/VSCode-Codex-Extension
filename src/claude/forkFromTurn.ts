import type { OriginatedError, RewindConversationResult } from './control';

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
  /** 由来つき（issue #340横断レビュー指摘）。`describeForkFromTurnError`参照。 */
  error: OriginatedError | undefined;
  /**
   * `rewind_conversation` の逐次送信のうち、成功した件数（issue #494のレビュー指摘）。
   *
   * 呼び出し側（`claudeChatView.ts`）が「1件も戻せずに失敗した」（新しいタブを黙って
   * 閉じても無害）と「途中まで戻ってから失敗した」（fork側のCLIは既に一部のユーザー発言を
   * 削除済み。タブを無言で残すと不整合な状態のまま会話を続けさせてしまう）を区別するために
   * 持たせる。`ok:true` のときは `sequence.length` と一致する。
   */
  succeededCount: number;
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
    return {
      ok: false,
      prefillText: undefined,
      error: { message: '対象の発言が見つかりません', origin: 'app' },
      succeededCount: 0,
    };
  }

  let last: RewindConversationResult | undefined;
  let succeededCount = 0;
  for (const uuid of sequence) {
    last = await sendRewind(uuid);
    if (!last.rewound) {
      return {
        ok: false,
        prefillText: undefined,
        error: last.error ?? { message: '不明なエラー', origin: 'app' },
        succeededCount,
      };
    }
    succeededCount += 1;
  }
  return { ok: true, prefillText: last?.prefillText, error: undefined, succeededCount };
}

/**
 * `rewind_conversation` が返す既知のエラー値を、日本語の説明へマッピングする
 * （issue #494のレビュー指摘、issue #340横断レビュー指摘で由来つきの型へ変更）。
 *
 * CLIの応答文言（`payload.error`。実測、CLI 2.1.235。全量は`docs/design.md`§14.61と
 * `/tmp`の実測記録参照）を`vscode.window.showErrorMessage`へそのまま流すと、CLI側の
 * 実装変更（内部的な言い回しへの変更等）がそのままユーザーへ露出してしまう。既知の値だけ
 * 日本語へ置き換え、未知の値（自分たちが把握していないCLIの新しいエラー、または将来値が
 * 変わった場合）は汎用文言へ丸める。
 *
 * `forkFromTurn`自身・`streamSession.ts`のガードが返す非CLI由来のエラー（対象が見つから
 * ない、セッションが起動していない等、既に日本語）は`error.origin`で判定してカタログを
 * 通さずそのまま返す。以前は文字列の恒等マッピングで対応していたが、`forkFromTurn.ts`
 * 自身の2文言しか登録されておらず、`streamSession.ts`が返す非CLI由来のエラーが
 * ファイルをまたいだ時点で汎用文言に丸まってしまっていた（issue #340横断レビュー指摘）。
 * 型で由来を分ければ、非CLI由来のエラーを個別に列挙し続ける必要が無くなる。
 */
export function describeForkFromTurnError(error: OriginatedError | undefined): string {
  if (error === undefined) {
    return GENERIC_FORK_ERROR_MESSAGE;
  }
  if (error.origin === 'app') {
    return error.message;
  }
  return KNOWN_FORK_ERROR_MESSAGES[error.message] ?? GENERIC_FORK_ERROR_MESSAGE;
}

const GENERIC_FORK_ERROR_MESSAGE = '分岐できませんでした（原因不明のエラーです）';

const KNOWN_FORK_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'turn running':
    '前のターンがまだ実行中のため分岐できませんでした。しばらく待ってからやり直してください。',
  'commands queued':
    '実行待ちのコマンドが残っているため分岐できませんでした。完了を待ってからやり直してください。',
  'target not found': '分岐元の発言が見つかりませんでした。会話が変わった可能性があります。',
  'stale target': '会話がその後に進んでいるため、この発言からは分岐できませんでした。',
  'no preceding assistant': 'この発言より前に応答が無いため分岐できませんでした。',
  'failed to persist rewind anchor': '分岐した状態を保存できませんでした。',
  'state changed': '会話の状態が変わったため分岐できませんでした。',
};
