import type { ChatItem, ChatState } from '../appserver/chatState';

/**
 * ワークフローViewのノード・一覧に出す「直近の応答の1行要約」を組み立てる（design.md §16.8）。
 *
 * `runner.ts` がタスクの `ChatState` が変わるたびに呼び、結果は `LiveTask` に持たせて
 * Viewのスナップショットへ渡す。**応答本文そのものは永続化しない**（design.md §16.11）ため、
 * ここで作るのはあくまでメモリ上・表示専用の短い要約であり、`workspaceState` へは書かない。
 *
 * VSCode APIには依存しない純粋関数。`ChatState` は `appserver` 層の型だが、値を読むだけで
 * 副作用を持たないためテストしやすい。
 */

/** 表示用に切り詰める上限文字数。長い応答でグラフのノードが間延びしないようにする。 */
export const MAX_SUMMARY_LENGTH = 120;

/**
 * ターンの完了後は `turnResultText`、進行中（ストリーミング中）は直近の `agentMessage` を使う。
 * どちらも無ければ空文字（「まだ応答が無い」の意味）を返す。
 */
export function buildResponseSummary(state: ChatState): string {
  const source =
    state.turnResultText !== '' ? state.turnResultText : lastAgentMessageText(state.items);
  return firstLineOf(source);
}

function lastAgentMessageText(items: readonly ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'agentMessage' && item.text.trim() !== '') {
      return item.text;
    }
  }
  return '';
}

/** 最初の空でない行を取り、上限で省略する。改行以降は「1行要約」の趣旨から外れるため捨てる。 */
function firstLineOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > MAX_SUMMARY_LENGTH ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH)}…` : trimmed;
}
