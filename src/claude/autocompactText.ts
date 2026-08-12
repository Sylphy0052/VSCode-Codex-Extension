import type { AutocompactWindowView } from '../appserver/chatState';

/**
 * `/autocompact` の応答から自動圧縮の窓サイズを読む（issue #201、design.md §14.37）。
 *
 * **経路の実測（CLI 2.1.227）**: 専用の制御要求は無い。`set_autocompact`
 * `set_autocompact_window` `autocompact` `autocompact_window` `set_auto_compact_window`
 * `configure_autocompact` の6候補はいずれも `Unsupported control request subtype: <name>`
 * で拒否された。`apply_flag_settings` に `{autoCompactWindow}` を載せる経路（`effort`と
 * 同じ抜け道）は `success` が返るが、直後に `get_settings` を送っても `effective` /
 * `applied` のどちらにも反映が現れず、**効いたかどうかを確かめられない**
 * （`control.ts` の `buildSetEffortRequest` と同じ限界）。
 *
 * そのため唯一の経路は、TUIと同じ `/autocompact` をローカルコマンドとして送ること。
 * バイナリのstrings解析で `claude` に `--autocompact <auto|tokens>` という起動オプションと、
 * `argumentHint:"[auto|<tokens>]"` の同名スラッシュコマンド定義が見つかっている。
 *
 * 実際にこの環境で送って実測した結果、**`/recap` `/import` と違いモデル呼び出しを経由しない
 * 固定書式**（`model:"<synthetic>"`、`total_cost_usd` が増えない＝コストゼロ、`num_turns:0`）
 * で、次のいずれかがそのまま返る。
 *
 * - 問い合わせ（`/autocompact`、引数無し）:
 *   `Auto-compact window: auto\n...`（未設定＝CLI既定）
 *   `Auto-compact window: 300k tokens (from settings)\n...`（設定済み）
 * - 変更後の確認（`/autocompact <window>`）:
 *   `Auto-compact window set to 300k tokens` / `Auto-compact window set to auto`
 * - 失敗（範囲外・書式不正。100k〜1Mトークンの外、または `auto`/数値のどちらでもない入力）:
 *   `Couldn't parse '<入力>'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as
 *   shorthand)`（この形はどの分岐にもマッチしない。値は変わっていないので、呼び出し側は
 *   直前の状態をそのまま保てばよい）
 *
 * 1行目だけを見る（後続行は毎回同じ説明文で、読む必要が無い）。とはいえ**この書式は
 * 保証されていない**（他の内蔵ローカルコマンドと同じく非公開の実装詳細）。CLIの更新で
 * 文言が変われば、ここは黙って `undefined` を返すだけになる（`usageText.ts` の
 * `parseUsageReport` と同じ流儀。読めなくなったら諦め、無理に推測しない）。
 */
export function parseAutocompactReport(text: string): AutocompactWindowView | undefined {
  const match = /^Auto-compact window(?: set to|:)\s*(?:auto|(\d+(?:\.\d+)?)(k)?\s*tokens)/i.exec(
    text.trim(),
  );
  if (match === null) {
    return undefined;
  }

  const [, amount, kilo] = match;
  if (amount === undefined) {
    return { mode: 'auto', tokens: undefined };
  }

  const tokens = Number(amount) * (kilo === undefined ? 1 : 1000);
  return Number.isFinite(tokens) ? { mode: 'fixed', tokens } : undefined;
}
