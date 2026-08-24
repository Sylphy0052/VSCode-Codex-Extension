/**
 * 会話画面の表示密度（issue #718）。
 *
 * 設定 `agent.chat.density` の値を受け取り、`body` へ付けるクラス名へ変換する。
 * `vscode` に依存しない純粋関数として置き、`test/unit/density.test.ts` から直接
 * テストできるようにしている（`sendKey.ts` と同じ流儀）。
 *
 * 実際の寸法はCSSカスタムプロパティ側（`chatStyles.ts`）に持つ。ここが決めるのは
 * 「どちらのクラスを付けるか」だけで、数値は持たない。
 */

/** 表示密度。`comfortable` が既定で、変更前の見た目と同じ。 */
export type ChatDensity = 'compact' | 'comfortable';

/** 既定値。設定を書いていない利用者の見た目を変えないため `comfortable`。 */
export const DEFAULT_CHAT_DENSITY: ChatDensity = 'comfortable';

/** 設定に書ける値の一覧。`package.json` の `enum` と揃える。 */
export const CHAT_DENSITIES: readonly ChatDensity[] = ['compact', 'comfortable'];

/**
 * 設定の生値を既定へ丸める。設定ファイルは手で書けるため、`enum` を外れた値や
 * 型違いが届きうる。未知の値は既定（`comfortable`）にする。
 */
export function normalizeChatDensity(value: unknown): ChatDensity {
  return value === 'compact' || value === 'comfortable' ? value : DEFAULT_CHAT_DENSITY;
}

/**
 * `body` へ付けるクラス名。`chatStyles.ts` は `comfortable` の値を `body` の既定として
 * 持ち、`body.density-compact` だけで上書きする。`density-comfortable` に対応する規則は
 * 無いが、いま何が効いているかを実機で見分けられるよう、クラス自体は必ず付ける。
 */
export function densityBodyClass(density: ChatDensity): string {
  return 'density-' + density;
}
