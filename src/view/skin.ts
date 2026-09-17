/**
 * 会話画面の外装（issue #1249）。
 *
 * 設定 `agent.chat.skin` の値を受け取り、`body` へ付けるクラス名へ変換する。
 * `vscode` に依存しない純粋関数として置き、`test/unit/skin.test.ts` から直接
 * テストできるようにしている（`density.ts` と同じ流儀）。
 *
 * 見た目そのものは `chatStyles.ts` 側が持つ。ここが決めるのは「どちらのクラスを
 * 付けるか」だけで、色も寸法も持たない。
 */

/** 外装。`cyber` が既定で、`plain` は装飾を足す前の見た目。 */
export type ChatSkin = 'cyber' | 'plain';

/**
 * 既定値。issue #1249 の目的が「既定でサイバー感のある見た目にする」ことなので
 * `cyber`。従来の見た目へ戻したい場合は設定で `plain` を選ぶ。
 */
export const DEFAULT_CHAT_SKIN: ChatSkin = 'cyber';

/** 設定に書ける値の一覧。`package.json` の `enum` と揃える。 */
export const CHAT_SKINS: readonly ChatSkin[] = ['cyber', 'plain'];

/**
 * 設定の生値を既定へ丸める。設定ファイルは手で書けるため、`enum` を外れた値や
 * 型違いが届きうる。未知の値は既定（`cyber`）にする。
 */
export function normalizeChatSkin(value: unknown): ChatSkin {
  return value === 'cyber' || value === 'plain' ? value : DEFAULT_CHAT_SKIN;
}

/**
 * `body` へ付けるクラス名。`chatStyles.ts` はサイバー固有の規則をすべて
 * `body.skin-cyber` 配下に書き、`plain` に対応する規則は持たない。`skin-plain`
 * に効く規則は無いが、いま何が効いているかを実機で見分けられるよう、クラス自体は
 * 必ず付ける（`densityBodyClass` と同じ考え方）。
 */
export function skinBodyClass(skin: ChatSkin): string {
  return 'skin-' + skin;
}
