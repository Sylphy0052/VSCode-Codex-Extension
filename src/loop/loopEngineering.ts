/**
 * ループエンジニアリングモード（`agent.chat.loopEngineering.*`、issue #891）。
 *
 * ループが送る指示の末尾へ、ループの回し方そのものについての方針を連結する。
 * 「次へ」を機械的に繰り返すだけのループを、検証・方針変更・撤退判断を含むループへ
 * 引き上げるための設定で、既定は無効。有効にするまで送信テキストは一字一句変わらない。
 *
 * 方針は次の5軸で整理している（design.md §9.7）。このモジュールが担うのは
 * プロンプトへ載せる4軸で、最後の`Bound`は`LoopController`（反復上限・時間上限・
 * 停滞検知）が持つ。プロンプトで頼むのではなく外側から縛るものなので、指示文には
 * 含めない。
 *
 * | 軸       | 内容                                         | 担当             |
 * | -------- | -------------------------------------------- | ---------------- |
 * | Verify   | 完了は機械的に確認できる根拠で判定する       | 指示文           |
 * | Replan   | 効かなかった手を繰り返さず方針を変える       | 指示文           |
 * | Feedback | 失敗した出力・エラーを次のターンの入力にする | 指示文           |
 * | Escalate | 行き詰まったら撤退を申告する                 | 指示文           |
 * | Bound    | 反復上限・時間上限・停滞検知                 | `LoopController` |
 *
 * `vscode`に依存しない純粋なロジックだけを置く（`view/turnSummary.ts`と同じ流儀）。
 * 設定の読み出しは`src/config.ts`の`readChatLoopEngineeringConfig`が行う。
 * `view/`ではなく`loop/`に置くのは、連結する相手が画面から手で送る発言ではなく
 * `LoopController`が送る指示であり、参照するのも`LoopController`自身のため。
 */

import type { ChatState } from '../appserver/chatState';

/**
 * 行き詰まりを申告するための合図（Escalate、issue #891）。
 *
 * 会話に紛れない綴りにしてある点は`LOOP_DONE_TOKEN`（`loopController.ts`）と同じだが、
 * **判定は`declaresEscalate`が最終行の完全一致で行う**（`LOOP_DONE_TOKEN`のような
 * `includes`ではない）。この合図は「解決できないので止めてくれ」という強い意味を持ち、
 * 指示文そのものが会話の中でこの綴りを含むため、`includes`では
 * 「必要なら <<LOOP_ESCALATE>> を返します」といった説明文だけで誤って停止してしまう。
 *
 * 合図の定義をこのモジュールへ置くのは、これを教えるのが`loopEngineering`の指示文
 * だからで、`LoopController`側は`declaresEscalate`を呼ぶだけにしてある
 * （`loopController.ts`が`loopEngineering.ts`をimportする一方向にして循環を避ける）。
 */
export const LOOP_ESCALATE_TOKEN = '<<LOOP_ESCALATE>>';

/**
 * 直近のエージェント発言が行き詰まりを宣言しているか。
 *
 * **応答の最終行が`LOOP_ESCALATE_TOKEN`と完全に一致する場合だけ**成立とする
 * （前後の空白は除いて比べる）。本文の途中に説明として現れただけでは成立しない。
 *
 * 判定に使うのは「末尾から数えて最初の`agentMessage`」で、`declaresDone`と同じ。
 * ループエンジニアリングモードが無効でも判定自体は行う——利用者が自分の指示文へ
 * この合図を書いた場合にも効かせるためで、完全一致にしてあるぶん誤検知の余地は小さい。
 */
export function declaresEscalate(state: ChatState): boolean {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind === 'agentMessage') {
      const lines = item.text.trimEnd().split('\n');
      const lastLine = lines[lines.length - 1];
      return lastLine !== undefined && lastLine.trim() === LOOP_ESCALATE_TOKEN;
    }
  }
  return false;
}

/**
 * `agent.chat.loopEngineering.initialInstruction` の既定値。**ループの1回目にだけ**
 * 連結する完全な方針文。
 *
 * `package.json` の `contributes.configuration` にも同じ文字列をリテラルで持たせて
 * あるので、変える場合は両方を合わせて直すこと（`DEFAULT_TURN_SUMMARY_INSTRUCTION`と
 * 同じ約束）。
 */
export const DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION =
  'このループでは次の方針で作業すること。' +
  '1) 完了したかどうかは、テストの終了コードやコマンドの実行結果など、機械的に確認できる根拠で判断する。自己申告で完了としない。' +
  '2) 前回と同じやり方で解決しなかった場合は、同じ手を繰り返さず方針を変える。' +
  '3) 直前のターンで出たエラーや失敗した出力は、次の作業の入力として扱う。' +
  `4) 自力では解決できないと判断した場合は、作業を続けずに、応答の最終行へ ${LOOP_ESCALATE_TOKEN} とだけ出力して人へ引き継ぐ。`;

/**
 * `agent.chat.loopEngineering.continueInstruction` の既定値。**2回目以降に**連結する
 * 短い再確認。
 *
 * 完全な方針文を200回（`LOOP_ITERATION_LIMIT`）送り直しても得るものは無いため、
 * 継続側は要点だけにする。1回目の指示は同じ会話の中に残っているので、方針そのものを
 * 再掲せずに参照できる。
 */
export const DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION =
  'ループの作業方針（機械的な検証・行き詰まったときの方針変更・エラーの折り返し・' +
  `解決不能なときの ${LOOP_ESCALATE_TOKEN}）を継続すること。前ターンの検証結果を根拠に次の行動を選ぶこと。`;

/** ループの何回目の送信かの区別。連結する指示文をこれで選ぶ。 */
export type LoopEngineeringPhase = 'initial' | 'continue';

/** `appendLoopEngineeringInstruction` に渡す設定。`readChatLoopEngineeringConfig` の返り値。 */
export interface LoopEngineeringConfig {
  /** 無効なら連結しない（既定 `false`）。 */
  enabled: boolean;
  /** ループの1回目に連結する方針文。空文字なら連結しない。 */
  initialInstruction: string;
  /** ループの2回目以降に連結する再確認。空文字なら連結しない。 */
  continueInstruction: string;
}

/** 全て既定値の設定。設定を読めない場面（テスト・省略時）の土台に使う。 */
export const defaultLoopEngineeringConfig: LoopEngineeringConfig = {
  enabled: false,
  initialInstruction: DEFAULT_LOOP_ENGINEERING_INITIAL_INSTRUCTION,
  continueInstruction: DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION,
};

/**
 * ループが送る指示の末尾へ、ループエンジニアリングの方針を連結する。
 *
 * 連結しないのは次の場合。いずれも「元の文面をそのまま送る」ことに意味がある。
 * - 設定が無い（呼び出し側がモードを使っていない）
 * - 設定が無効（既定）。有効にするまで送信テキストは一字一句変わらない
 * - その回に使う指示文が空（実質的な無効化として扱う）
 * - 本文が空（指示文だけが本文になるのを避ける）
 *
 * 終了条件（`decoratePrompt`）との順序は呼び出し側（`LoopController.dispatch`）が
 * 決める。方針を先に、終了条件を後ろに置く。
 */
export function appendLoopEngineeringInstruction(
  text: string,
  config: LoopEngineeringConfig | undefined,
  phase: LoopEngineeringPhase,
): string {
  if (config === undefined || !config.enabled) {
    return text;
  }
  const instruction = (
    phase === 'initial' ? config.initialInstruction : config.continueInstruction
  ).trim();
  if (instruction === '') {
    return text;
  }
  if (text.trim() === '') {
    return text;
  }
  // 本文と方針の境界を空行で分ける。本文が箇条書きやコードブロックで終わっていても、
  // 方針が続きの行として読まれないようにする（`appendTurnSummaryInstruction`と同じ）
  return `${text.replace(/\s+$/u, '')}\n\n${instruction}`;
}
