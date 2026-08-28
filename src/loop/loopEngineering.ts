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

import type { ChatItem } from '../appserver/chatState';

/**
 * 行き詰まりを申告するための合図（Escalate、issue #891）。
 *
 * 会話に紛れない綴りにしてある点も、**判定が最終行の完全一致である**点も
 * `LOOP_DONE_TOKEN`（`loopController.ts`）と同じ（`LOOP_DONE_TOKEN`は`includes`だったが、
 * 同じ理由でissue #914に完全一致へ揃えた）。この合図は「解決できないので止めてくれ」と
 * いう強い意味を持ち、指示文そのものが会話の中でこの綴りを含むため、`includes`では
 * 「必要なら <<LOOP_ESCALATE>> を返します」といった説明文だけで誤って停止してしまう。
 *
 * 合図の定義をこのモジュールへ置くのは、これを教えるのが`loopEngineering`の指示文
 * だからで、`LoopController`側は`declaresEscalate`を呼ぶだけにしてある
 * （`loopController.ts`が`loopEngineering.ts`をimportする一方向にして循環を避ける）。
 */
export const LOOP_ESCALATE_TOKEN = '<<LOOP_ESCALATE>>';

/**
 * **渡された発言が**行き詰まりを宣言しているか。
 *
 * **発言の最終行が`LOOP_ESCALATE_TOKEN`と完全に一致する場合だけ**成立とする
 * （前後の空白は除いて比べる）。本文の途中に説明として現れただけでは成立しない。
 *
 * 受け取るのが`ChatState`ではなく`ChatItem`なのは、**「どの発言を見るか」の判断を
 * `LoopController`へ移したため**（issue #937）。会話全体から直近の発言を探していた頃は、
 * ツール実行だけで本文を返さなかったターンで過去のターンの発言を拾い、ループを始める
 * 前の合図で停止しえた。この関数は「渡された発言が合図か」だけを答え、それが現在の
 * ターンのものかは呼び出し側が決める（`declaresDone`も同じ形）。
 *
 * ループエンジニアリングモードが無効でも判定自体は行う——利用者が自分の指示文へ
 * この合図を書いた場合にも効かせるためで、完全一致にしてあるぶん誤検知の余地は小さい。
 */
export function declaresEscalate(item: ChatItem): boolean {
  return agentMessageFinalLine(item) === LOOP_ESCALATE_TOKEN;
}

/**
 * エージェントの発言の、**最後の非空行**（前後の空白を除く）。
 *
 * `agentMessage`以外を渡された場合と、本文が空白だけの場合は`undefined`。合図
 * （`LOOP_ESCALATE_TOKEN` / `LOOP_DONE_TOKEN`）の判定はどちらもこの値との完全一致で
 * 行う（issue #914）。
 */
export function agentMessageFinalLine(item: ChatItem): string | undefined {
  if (item.kind !== 'agentMessage') {
    return undefined;
  }
  const text = item.text.trimEnd();
  if (text === '') {
    return undefined;
  }
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1];
  return lastLine === undefined ? undefined : lastLine.trim();
}

/**
 * 末尾から数えて最初の`agentMessage`。1つも無ければ`undefined`。
 *
 * 見るのが配列の最後の項目ではなく最後の`agentMessage`なのは、応答の後ろに
 * `commandExecution`などの項目が並ぶことがあるため。合図はエージェントの発言の中に
 * あればよく、その後ろにツールの実行記録が続いていても成立する。
 *
 * これが**どのターンの発言かはここでは分からない**。`ChatItem.turnId`は
 * `item/agentMessage/delta`で作られた項目では`undefined`のままになることがあり
 * （`chatState.ts`の`appendDelta`）、ターンの絞り込みには使えない。現在のターンの
 * ものかは`LoopController`が前のターン境界の値と比べて決める（issue #937）。
 */
export function lastAgentMessage(items: readonly ChatItem[]): ChatItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'agentMessage') {
      return item;
    }
  }
  return undefined;
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
  '1) 完了は自己申告だけで判断せず、可能な場合はテストの終了コード、コマンド結果、生成物の確認など機械的に検証できる根拠で確認する。機械的な検証が適さない作業では、完了を確認できる具体的な根拠を示す。' +
  '2) 直前の結果を確認してから次の行動を決める。同じ前提・同じ操作で進展せず、新しい情報も得られない場合は、そのまま繰り返さず原因仮説または方針を変える。一時的な失敗と判断できる根拠がある場合の再試行はよい。' +
  '3) 直前のターンで得た成功・失敗・エラー・検証結果を次の判断へ反映し、未解決の原因と次に確かめることを更新する。' +
  '4) 必要な権限・入力・外部判断が無い、複数の異なる方針を試しても進展しない、または追加作業から新しい情報を得られる見込みが無い場合は無意味に作業を続けない。' +
  `行き詰まりの原因、試したこと、人に必要な判断や入力を簡潔に報告した後、応答の最後の非空行に ${LOOP_ESCALATE_TOKEN} だけを出力し、それ以降は何も出力しない。`;

/**
 * `agent.chat.loopEngineering.continueInstruction` の既定値。**2回目以降に**連結する
 * 短い再確認。
 *
 * 完全な方針文を200回（`LOOP_ITERATION_LIMIT`）送り直しても得るものは無いため、
 * 継続側は要点だけにする。ただし**短くても自己完結させる**（issue #914）。
 * 「1回目の方針を継続すること」と参照するだけの文面にしていた頃は、会話の圧縮・要約や
 * tool outputによる希釈で初回メッセージの意味が薄れると、何を続ければよいのかが
 * 分からなくなっていた。4軸それぞれの中身を1文ずつ入れ、初回指示を読み直せなくても
 * 成立する文面にしてある。
 */
export const DEFAULT_LOOP_ENGINEERING_CONTINUE_INSTRUCTION =
  '直前の検証結果を確認してから次の行動を決めること。完了は自己申告だけでなく確認可能な根拠に基づいて判断すること。' +
  '同じ前提・同じ操作で進展せず新しい情報も得られない場合は繰り返さず、原因仮説または方針を変えること。' +
  '直前の成功・失敗・エラーを次の判断へ反映すること。' +
  `追加作業で進展する見込みが無い場合は必要な報告を終えた後、最後の非空行に ${LOOP_ESCALATE_TOKEN} だけを出力し、それ以降は何も出力しない。`;

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
