import {
  emptyPluginProvides,
  type PluginProvides,
  type PluginView,
} from '../provider/plugins';

/**
 * Codexの `plugin/installed` の応答からplugin一覧を組み立てる（issue #32、design.md §14.20）。
 *
 * 実測（codex-cli 0.147.0。このリポジトリで `codex app-server` を起動して呼び出し、実際の
 * 応答を確認した。この環境の plugin 設定は変更していない）:
 * `{marketplaces: [{name, path, interface: {displayName}, plugins: [PluginSummary]}],
 * marketplaceLoadErrors: [...]}`。`PluginSummary` は `id` / `name` / `version` /
 * `localVersion` / `enabled` / `installed` / `source`（`local`|`git`|`npm`|`remote`）/
 * `interface`（`displayName` / `shortDescription` / `longDescription` 等）を持つ
 * （`codex app-server generate-json-schema --out` のスキーマも一致）。
 *
 * **`plugin/list`（全件・マーケットプレイスのカタログ全体）とは別物**。`plugin/list` は
 * この環境で実行すると応答が11MBを超えた（未インストールのリモートplugin候補まで
 * すべて含むため）。導入済みのものだけを一覧する本issueのスコープでは `plugin/installed`
 * を使う（`plugin/list` は呼ばない）。
 *
 * `installed: false` のエントリ（インストール可能だが未導入）は一覧から除く。
 * `plugin/installed` は原則installed済みのものだけを返す（実測）が、念のため防御する。
 */
export function parsePluginInstalled(raw: unknown): {
  plugins: PluginView[];
  marketplaces: MarketplaceRef[];
  /**
   * `plugin/read` を呼ぶために要る、plugin毎のname・マーケットプレイス参照。
   * `PluginView` には持たせない内部専用の情報（`appServerClient.ts` の `listPlugins` が
   * 「提供するもの」の内訳を読むときだけに使う）。
   */
  refs: PluginReadRef[];
  warnings: string[];
} {
  const body = rec(raw);
  const marketplacesRaw = body?.['marketplaces'];
  if (!Array.isArray(marketplacesRaw)) {
    return { plugins: [], marketplaces: [], refs: [], warnings: [] };
  }

  const plugins: PluginView[] = [];
  const marketplaces: MarketplaceRef[] = [];
  const refs: PluginReadRef[] = [];
  const seenKeys = new Set<string>();

  for (const rawMarketplace of marketplacesRaw) {
    const marketplace = rec(rawMarketplace);
    const marketplaceName = str(marketplace?.['name']);
    if (marketplace === undefined || marketplaceName === '') {
      continue;
    }
    const marketplacePath = strOrUndefined(marketplace['path']);
    const displayName = strOrUndefined(rec(marketplace['interface'])?.['displayName']);
    marketplaces.push({ name: marketplaceName, path: marketplacePath, displayName });

    for (const rawPlugin of arrayOf(marketplace['plugins'])) {
      const plugin = rec(rawPlugin);
      const id = str(plugin?.['id']);
      const name = str(plugin?.['name']);
      if (plugin === undefined || id === '' || name === '' || seenKeys.has(id)) {
        continue;
      }
      if (plugin['installed'] !== true) {
        continue;
      }
      seenKeys.add(id);

      const iface = rec(plugin['interface']);
      const description =
        strOrUndefined(iface?.['shortDescription']) ??
        strOrUndefined(iface?.['longDescription']) ??
        '';
      const source = rec(plugin['source']);
      plugins.push({
        key: id,
        name,
        description,
        version: strOrUndefined(plugin['localVersion']) ?? strOrUndefined(plugin['version']),
        origin: describeOrigin(displayName ?? marketplaceName, marketplacePath, source),
        // Codexにはインストールスコープの概念が無い（`plugin/uninstall` は `pluginId` のみ、
        // `plugin/install` は marketplace の指定のみを取る。スキーマ根拠）
        scope: undefined,
        enabled: plugin['enabled'] === true,
        // Codexには専用の有効/無効APIが無い（`plugin/*` を総当たりで確認した。§14.20参照）
        toggleable: false,
        // `plugin/uninstall` がある
        removable: true,
        provides: emptyPluginProvides,
      });
      refs.push({
        key: id,
        pluginName: name,
        marketplaceName,
        marketplacePath,
      });
    }
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  const warnings: string[] = [];
  for (const rawError of arrayOf(body?.['marketplaceLoadErrors'])) {
    const error = rec(rawError);
    const message = str(error?.['message']);
    if (message !== '') {
      warnings.push(message);
    }
  }

  return { plugins, marketplaces, refs, warnings };
}

export interface MarketplaceRef {
  name: string;
  path: string | undefined;
  displayName: string | undefined;
}

export interface PluginReadRef {
  key: string;
  pluginName: string;
  marketplaceName: string;
  marketplacePath: string | undefined;
}

function describeOrigin(
  marketplaceLabel: string,
  marketplacePath: string | undefined,
  source: Record<string, unknown> | undefined,
): string {
  const type = str(source?.['type']);
  if (type === 'git') {
    const url = strOrUndefined(source?.['url']);
    return url === undefined ? `${marketplaceLabel} (git)` : `${marketplaceLabel} (git: ${url})`;
  }
  if (type === 'npm') {
    const pkg = strOrUndefined(source?.['package']);
    return pkg === undefined ? `${marketplaceLabel} (npm)` : `${marketplaceLabel} (npm: ${pkg})`;
  }
  if (type === 'local') {
    const path = strOrUndefined(source?.['path']);
    return path === undefined
      ? `${marketplaceLabel} (ローカル)`
      : `${marketplaceLabel} (ローカル: ${path})`;
  }
  // 'remote'、または未知の種別。マーケットプレイスがローカルファイル由来かどうかも添える
  return marketplacePath === undefined
    ? `${marketplaceLabel} (リモートカタログ)`
    : `${marketplaceLabel} (${marketplacePath})`;
}

/**
 * Codexの `plugin/read` の応答から、pluginが提供するものの内訳を数える（issue #32）。
 *
 * 実測（codex-cli 0.147.0。`remoteMarketplaceName: 'openai-curated-remote'` を指定して
 * `pluginName: 'github'` を読んだ）: `{plugin: {hooks: [...], mcpServers: [...],
 * skills: [...], apps: [...], appTemplates: [...], summary: {...}, description, ...}}`。
 *
 * **この応答の `plugin.summary.installed` / `plugin.summary.enabled` は信用できない**
 * （実測: `plugin/installed` では `installed: true` だった同じpluginを `plugin/read` で
 * 読むと `installed: false` が返った。カタログ定義を読んでいるだけで、この端末の導入状態を
 * 反映していないとみられる）。そのため `parsePluginInstalled` の結果とは独立に、
 * 「提供するもの」の内訳（`hooks` / `mcpServers` / `skills` の件数）だけを取り出す。
 */
export function parsePluginProvides(raw: unknown): PluginProvides | undefined {
  const plugin = rec(rec(raw)?.['plugin']);
  if (plugin === undefined) {
    return undefined;
  }
  return {
    skills: countIfArray(plugin['skills']),
    // Codexのplugin詳細は「agents」を持たない（Claude Codeのplugin.jsonと違う構造）
    agents: undefined,
    hooks: countIfArray(plugin['hooks']),
    mcpServers: countIfArray(plugin['mcpServers']),
  };
}

function countIfArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
