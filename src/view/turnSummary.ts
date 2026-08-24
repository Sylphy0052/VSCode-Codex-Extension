/**
 * ターン末尾の要約指示（`agent.chat.turnSummary.*`、issue #709）。
 *
 * チャット画面から手動で送る発言の末尾へ定型の指示文を連結し、応答の最後に
 * 「今回の指示」「実施した内容の要約」「次の推奨アクション」を必ず出させる。
 * ターンが終わった後に別のリクエストを投げる方式は採らない（追加のAPI呼び出し・
 * 待ち時間・会話履歴の汚れが増えるだけで、得られるものが変わらないため）。
 *
 * `vscode`に依存しない純粋なロジックだけを置く（`composerButtons.ts`と同じ流儀）。
 * 設定の読み出しは`src/config.ts`の`readChatTurnSummaryConfig`が行う。
 */

/**
 * `agent.chat.turnSummary.instruction` の既定値。`package.json` の
 * `contributes.configuration` にも同じ文字列をリテラルで持たせてあるので、
 * 変える場合は両方を合わせて直すこと。
 */
export const DEFAULT_TURN_SUMMARY_INSTRUCTION =
  '最後に次の3点を必ず示すこと。1) 今回受け取った指示、2) この会話で実施した内容の要約、3) 次の推奨アクション。';

/** `appendTurnSummaryInstruction` に渡す設定。`readChatTurnSummaryConfig` の返り値。 */
export interface TurnSummaryConfig {
  /** 無効なら連結しない（既定 `false`）。 */
  enabled: boolean;
  /** 連結する指示文。空文字なら連結しない。 */
  instruction: string;
}

/**
 * 送信する本文の末尾へ要約指示を連結する。
 *
 * 連結しないのは次の場合。いずれも「元の文面をそのまま送る」ことに意味がある。
 * - 設定が無効（既定）。有効にするまで送信テキストは一字一句変わらない
 * - 指示文が空（実質的な無効化として扱う）
 * - 本文が空（画像だけを送る場合。指示文だけが本文になるのを避ける）
 *
 * 擬似コマンド（`/btw`等）と入力モード（行頭 `!` / `#`）は呼び出し側が先に振り分ける
 * ため、ここへは来ない（`chatView.ts` / `claudeChatView.ts` の `send` ハンドラ参照）。
 */
export function appendTurnSummaryInstruction(text: string, config: TurnSummaryConfig): string {
  if (!config.enabled) {
    return text;
  }
  const instruction = config.instruction.trim();
  if (instruction === '') {
    return text;
  }
  if (text.trim() === '') {
    return text;
  }
  // 本文と指示の境界を空行で分ける。本文が箇条書きやコードブロックで終わっていても、
  // 指示文が続きの行として読まれないようにする
  return `${text.replace(/\s+$/u, '')}\n\n${instruction}`;
}
