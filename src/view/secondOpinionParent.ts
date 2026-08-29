/**
 * セカンドオピニオン（Issue #949）から見た「親セッションが暇か」を、画面の実体から作る。
 *
 * `chatView.ts`（Codex）と `claudeChatView.ts`（Claude Code）はタブの型こそ違うが、
 * 状態は同じ `ChatState` で、変化の購読も同じ `stateListeners` の配列である。判定と購読を
 * ここに1つだけ置き、両方の画面がこれを呼ぶ。
 */

import type { ChatState } from '../appserver/chatState';
import type { SecondOpinionParentPort } from '../secondOpinion/wait';

/**
 * 親セッションが暇か。
 *
 * `busy` の立ち下がりだけでは足りない。人が積んだ待機列が残っていると、ターンが終わった
 * 直後に次の1件が送られ（`chatView.ts` の `onSessionChange`）すぐ `busy` へ戻るため、
 * そこで走らせると待たせた意味が無くなる。積んだ指示を捌き切ってから走らせる。
 */
export function isIdleChatState(state: Pick<ChatState, 'busy' | 'queued'>): boolean {
  return !state.busy && state.queued.length === 0;
}

/**
 * 待機に必要な口だけを持つタブの形。`ChatPanel` / `ClaudePanel` の共通部分。
 *
 * `stateListeners` は画面が状態を配るための配列で、`onSessionChange` が毎回全件を呼ぶ。
 * 直接触るのはこのファイルだけに留める。
 */
export interface SecondOpinionParentEntry {
  session: { getState(): ChatState };
  stateListeners: Array<(state: ChatState) => void>;
}

/**
 * タブから {@link SecondOpinionParentPort} を作る。
 *
 * 購読の解除を返すのが要点である。`stateListeners` には解除の仕組みが無く、押すたびに
 * 積みっぱなしにすると、タブを開いている間ずっと増え続ける（待機は毎回終わるのに、
 * 見に行く関数だけが残る）。配列から自分自身を取り除く `dispose` を返す。
 */
export function secondOpinionParentPortFor(
  entry: SecondOpinionParentEntry,
): SecondOpinionParentPort {
  return {
    isParentIdle: () => isIdleChatState(entry.session.getState()),
    onParentStateChanged: (listener) => {
      const wrapped = (): void => {
        listener();
      };
      entry.stateListeners.push(wrapped);
      return {
        dispose: () => {
          const index = entry.stateListeners.indexOf(wrapped);
          if (index >= 0) {
            entry.stateListeners.splice(index, 1);
          }
        },
      };
    },
  };
}
