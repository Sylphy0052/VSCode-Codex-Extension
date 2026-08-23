import { emptyPluginProvides, type PluginProvides, type PluginView } from '../provider/plugins';

/**
 * `claude plugin list --json` の出力からplugin一覧を組み立てる（issue #32、design.md §14.20）。
 *
 * Claude CodeにはCodexのapp-serverに相当するJSON-RPCが無く、代わりに `claude plugin` という
 * 専用のCLIサブコマンド一式（`list` / `details` / `enable` / `disable` / `install` /
 * `uninstall` / `marketplace ...`）が見つかった（`claude plugin --help` で確認。Phase 0の
 * コメントにあった `plugin_install` / `reload_plugins`（control_request）はどちらも
 * 実測したが、`reload_plugins` は `initialize` と同じ「commands」一覧を返すだけで
 * plugin専用の情報を持たず、`plugin_install` は総当たり確認していない。CLIサブコマンドの
 * 方が構造化されており確実なため、一覧・操作ともにこちらを使う）。
 *
 * 実測（CLI 2.1.227。この環境に実際に導入済みの2件で確認した。設定は変更していない）:
 * ```json
 * [
 *   {"id":"genshijin@genshijin","version":"1.5.0","scope":"user","enabled":true,
 *    "installPath":"/home/user/.claude/plugins/cache/genshijin/genshijin/1.5.0",
 *    "installedAt":"...","lastUpdated":"..."}
 * ]
 * ```
 * `id` は `<name>@<marketplace>` の形。`scope` は `user` / `project` / `local` の3種
 * （`claude plugin install --help` の `-s, --scope` の説明が根拠。`project` / `local` は
 * この環境に対象が無く実測できていない）。
 */
export function parsePluginListJson(text: string): PluginView[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) {
    return undefined;
  }

  const plugins: PluginView[] = [];
  const seenKeys = new Set<string>();
  for (const rawPlugin of data) {
    const plugin = rec(rawPlugin);
    const id = str(plugin?.['id']);
    if (plugin === undefined || id === '' || seenKeys.has(id)) {
      continue;
    }
    seenKeys.add(id);

    const atIndex = id.indexOf('@');
    const name = atIndex > 0 ? id.slice(0, atIndex) : id;
    const marketplace = atIndex > 0 ? id.slice(atIndex + 1) : undefined;
    const scope = strOrUndefined(plugin['scope']);

    plugins.push({
      key: id,
      name,
      // `claude plugin list --json` は説明文を持たない。`enrichPluginProvides` の
      // `claude plugin details` で補う（呼び出し側の責務）
      description: '',
      version: strOrUndefined(plugin['version']),
      origin: describeOrigin(marketplace, scope),
      scope,
      enabled: plugin['enabled'] === true,
      // `claude plugin enable` / `disable` がある
      toggleable: true,
      // `claude plugin uninstall` がある
      removable: true,
      provides: emptyPluginProvides,
    });
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return plugins;
}

function describeOrigin(marketplace: string | undefined, scope: string | undefined): string {
  const scopeLabel =
    scope === 'user'
      ? 'ユーザー'
      : scope === 'project'
        ? 'プロジェクト'
        : scope === 'local'
          ? 'ローカル'
          : undefined;
  const parts: string[] = [];
  if (marketplace !== undefined) {
    parts.push(marketplace);
  }
  if (scopeLabel !== undefined) {
    parts.push(scopeLabel);
  }
  return parts.length === 0 ? '不明' : parts.join(' ・ ');
}

/**
 * `claude plugin details <id>` の出力から、説明と提供するものの内訳を読む（issue #32）。
 *
 * `--json` を持たない（`claude plugin details --help` で確認。`list` / `marketplace list`
 * のみ `--json` がある）ため、人が読める表示用のテキストを解析する。**この形式は表示用
 * 整形であり正式なAPIではない**（skills origin推測（`skillsList.ts`）と同じ注意）。
 * CLI更新で崩れうるため、行が読めなければ該当項目だけ `undefined` のまま返す。
 *
 * 実測（`claude plugin details genshijin@genshijin`。この環境の実プラグインで確認した）:
 * ```
 * genshijin 1.5.0
 *   超圧縮コミュニケーションモード。...
 *   Source: genshijin@genshijin
 *
 * Component inventory
 *   Skills (13)  genshijin, genshijin, ...
 *   Agents (3)  genshijin-reviewer, genshijin-builder, genshijin-investigator
 *   Hooks (2)  SessionStart, UserPromptSubmit  (harness-only — no model context cost)
 *   MCP servers (0)
 *   LSP servers (0)
 * ```
 */
export function parsePluginDetailsText(text: string): {
  description: string | undefined;
  provides: PluginProvides;
} {
  const lines = text.split('\n');

  // 1行目は「name version」、2行目（先頭が空白のインデント行）が説明文。
  // 「Source:」で始まる行は説明文ではないため無視する
  let description: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed === '' || trimmed.startsWith('Source:')) {
      if (description !== undefined) {
        break;
      }
      continue;
    }
    description = trimmed;
    break;
  }

  const provides: PluginProvides = { ...emptyPluginProvides };
  for (const line of lines) {
    const match = /^\s*(Skills|Agents|Hooks|MCP servers)\s*\((\d+)\)/.exec(line);
    if (match === undefined || match === null) {
      continue;
    }
    const count = Number(match[2]);
    if (!Number.isFinite(count)) {
      continue;
    }
    if (match[1] === 'Skills') {
      provides.skills = count;
    } else if (match[1] === 'Agents') {
      provides.agents = count;
    } else if (match[1] === 'Hooks') {
      provides.hooks = count;
    } else if (match[1] === 'MCP servers') {
      provides.mcpServers = count;
    }
  }

  return { description, provides };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrUndefined = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
