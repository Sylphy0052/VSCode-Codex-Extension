/**
 * 案ごとのメリット・デメリットを添えさせる指示（`agent.chat.prosCons.*`、issue #1474）。
 *
 * ターン要約（`turnSummary.ts`、issue #709）と同じく、チャット画面から手動で送る発言の
 * 末尾へ定型の指示文を連結する。追加のAI呼び出しはしない。
 *
 * `vscode`に依存しない純粋なロジックだけを置く。設定の読み出しは`src/config.ts`の
 * `readChatProsConsConfig`が行う。
 */

import { appendTurnSummaryInstruction, type TurnSummaryConfig } from './turnSummary';

/**
 * `agent.chat.prosCons.instruction` の既定値。`package.json` の
 * `contributes.configuration` にも同じ文字列をリテラルで持たせてあるので、
 * 変える場合は両方を合わせて直すこと。
 */
export const DEFAULT_PROS_CONS_INSTRUCTION =
  '複数の案・方針・選択肢を示すときは、案ごとにメリットとデメリットを示し、推奨する案とその理由を添えること。';

/** メリデメ説明の設定。形（有効フラグと指示文）はターン要約と同じ。 */
export type ProsConsConfig = TurnSummaryConfig;

/**
 * 手動で送る発言の末尾へ、メリデメ説明とターン要約の指示を連結する。
 *
 * 順番は 本文 → メリデメの指示 → ターン要約の指示。要約の指示を最後に置き、応答の
 * 末尾が要約になるようにする。連結しない条件（無効・指示文が空・本文が空）はどちらも
 * `appendTurnSummaryInstruction`と同じなので、同じ関数を2回通す。
 */
export function appendManualSendInstructions(
  text: string,
  prosCons: ProsConsConfig,
  turnSummary: TurnSummaryConfig,
): string {
  return appendTurnSummaryInstruction(appendTurnSummaryInstruction(text, prosCons), turnSummary);
}
