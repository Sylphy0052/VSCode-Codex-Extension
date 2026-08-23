/**
 * plugins / apps の一覧表示（issue #32、design.md TP-51）で共有する型。
 *
 * CodexとClaude Codeでプロトコル・CLIの形はまったく違うが（`src/codex/pluginsStatus.ts` /
 * `src/claude/pluginsList.ts` を参照）、画面へ渡す最終形はここへ揃える。
 * 設定パネル（`src/view/controlPanelScript.ts`）はこの形だけを見ればよい。
 *
 * pluginは任意のコード（hookやMCPサーバー）を持ち込む仕組みなので、hooks（§14.15）・
 * skills（§14.19）と同じく中身を隠さず見せる方針にする（§8のセキュリティ考慮）。
 */

/**
 * 提供するものの内訳。分かる範囲（`undefined`）と「0件確認できた」（`0`）を区別する。
 *
 * Codexは `plugin/read` の応答（`PluginDetail`）から、Claude Codeは
 * `claude plugin details <id>` の出力（Component inventory欄）から数える。どちらも
 * 一覧取得（`plugin/installed` / `claude plugin list --json`）とは別の呼び出しが要るため、
 * 失敗した場合はその項目だけ `undefined` のまま残す（一覧自体は失わない）。
 */
export interface PluginProvides {
  skills: number | undefined;
  agents: number | undefined;
  hooks: number | undefined;
  mcpServers: number | undefined;
}

export const emptyPluginProvides: PluginProvides = {
  skills: undefined,
  agents: undefined,
  hooks: undefined,
  mcpServers: undefined,
};

export interface PluginView {
  /** 一覧の識別・有効無効切替・アンインストールに使うキー。 */
  key: string;
  name: string;
  description: string;
  version: string | undefined;
  /** 出どころの説明（マーケットプレイス名、git/npm/ローカルパスなど、そのまま表示する文字列）。 */
  origin: string;
  /**
   * インストールスコープ（`user` / `project` / `local`）。Claude Codeのみ持つ
   * （`claude plugin install --help` の `-s, --scope` が根拠）。enable/disable/uninstallの
   * CLI呼び出しへそのまま渡す。Codexにはこの概念が無く常に `undefined`。
   */
  scope: string | undefined;
  enabled: boolean;
  /** 有効/無効を切り替えられるか。 */
  toggleable: boolean;
  /** アンインストールできるか。 */
  removable: boolean;
  provides: PluginProvides;
}

/**
 * インストール操作の選択肢として出すマーケットプレイスの参照。Codexのみ持つ
 * （`plugin/installed` が返す）。Claude Codeは `<name>@<marketplace>` を1つの文字列として
 * 自由入力させるため、常に空配列。
 */
export interface MarketplaceOption {
  name: string;
  path: string | undefined;
  displayName: string | undefined;
}

/**
 * 一覧を取得できたかどうかを型で分ける。
 *
 * 空配列（0件）と「取得に失敗した」を区別しないと、CLIが古い・app-serverが起動しない
 * といった状況で「pluginは設定されていません」と誤って出してしまう
 * （design.md の「黙って何も起きない状態を作らない」に反する）。
 */
export type PluginsSnapshot =
  | {
      ok: true;
      plugins: PluginView[];
      installable: boolean;
      marketplaces: MarketplaceOption[];
      warnings: string[];
    }
  | { ok: false; reason: string };

export interface AppView {
  key: string;
  name: string;
  description: string | undefined;
  enabled: boolean;
  /** モデルから呼び出せる状態か（Codexの `callable`。実測。§14.20参照）。 */
  callable: boolean;
}

/** appsは閲覧のみ（Codexのみ。有効/無効・インストール操作の確定した経路が無い。§14.20参照）。 */
export type AppsSnapshot = { ok: true; apps: AppView[] } | { ok: false; reason: string };

/**
 * Codexの `plugin/uninstall` / `plugin/install` の `pluginName` へそのまま埋め込む前の防御。
 *
 * 一覧（`plugin/installed`）が返す `id`（`<name>@<marketplace>`）から取り出した名前、または
 * インストール操作でユーザーが入力した名前を渡す想定。空文字・制御文字・空白を拒否する
 * ホワイトリストにする（設定の書き込み先へ渡す値のため、hooks/skillsと同じ考え方）。
 */
export function isValidPluginName(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 32) {
      return false;
    }
  }
  return true;
}
