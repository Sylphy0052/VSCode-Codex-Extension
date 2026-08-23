import { describe, expect, it } from 'vitest';
import { parsePluginDetailsText, parsePluginListJson } from '../../src/claude/pluginsList';

/** 実測（CLI 2.1.227。`claude plugin list --json`。この環境の実プラグインで確認した）。 */
const pluginListJson = JSON.stringify([
  {
    id: 'genshijin@genshijin',
    version: '1.5.0',
    scope: 'user',
    enabled: true,
    installPath: '/home/user/.claude/plugins/cache/genshijin/genshijin/1.5.0',
    installedAt: '2026-08-08T02:14:42.036Z',
    lastUpdated: '2026-08-08T02:14:42.036Z',
  },
  {
    id: 'last30days@last30days-skill',
    version: '3.18.4',
    scope: 'user',
    enabled: false,
    installPath: '/home/user/.claude/plugins/cache/last30days-skill/last30days/3.18.4',
    installedAt: '2026-08-08T02:14:42.036Z',
    lastUpdated: '2026-08-08T02:14:42.036Z',
  },
]);

describe('parsePluginListJson', () => {
  it('idからname/marketplaceを分ける', () => {
    const plugins = parsePluginListJson(pluginListJson);
    const genshijin = plugins?.find((p) => p.key === 'genshijin@genshijin');
    expect(genshijin?.name).toBe('genshijin');
    expect(genshijin?.origin).toContain('genshijin');
    expect(genshijin?.origin).toContain('ユーザー');
  });

  it('enabledをそのまま反映する', () => {
    const plugins = parsePluginListJson(pluginListJson);
    expect(plugins?.find((p) => p.key === 'last30days@last30days-skill')?.enabled).toBe(false);
    expect(plugins?.find((p) => p.key === 'genshijin@genshijin')?.enabled).toBe(true);
  });

  it('enable/disable/uninstallの経路があるためtoggleable/removableをtrueにする', () => {
    const plugins = parsePluginListJson(pluginListJson);
    expect(plugins?.every((p) => p.toggleable === true && p.removable === true)).toBe(true);
  });

  it('名前順に並べる', () => {
    const plugins = parsePluginListJson(pluginListJson);
    expect(plugins?.map((p) => p.name)).toEqual(['genshijin', 'last30days']);
  });

  it('不正なJSONではundefinedを返す', () => {
    expect(parsePluginListJson('not json')).toBeUndefined();
    expect(parsePluginListJson('{}')).toBeUndefined();
    expect(parsePluginListJson('[1, 2]')).toEqual([]);
  });

  it('idを持たないエントリは読み飛ばす', () => {
    expect(parsePluginListJson(JSON.stringify([{ version: '1.0.0' }]))).toEqual([]);
  });
});

/** 実測（CLI 2.1.227。`claude plugin details genshijin@genshijin`。実プラグインで確認した）。 */
const detailsText = `genshijin 1.5.0
  超圧縮コミュニケーションモード。原始人のように話してトークン使用量を約75%削減。
  Source: genshijin@genshijin

Component inventory
  Skills (13)  genshijin, genshijin, genshijin-commit, genshijin-commit
  Agents (3)  genshijin-reviewer, genshijin-builder, genshijin-investigator
  Hooks (2)  SessionStart, UserPromptSubmit  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~1,555 tok   added to every session
`;

describe('parsePluginDetailsText', () => {
  it('2行目のインデント行を説明として読む', () => {
    const { description } = parsePluginDetailsText(detailsText);
    expect(description).toBe(
      '超圧縮コミュニケーションモード。原始人のように話してトークン使用量を約75%削減。',
    );
  });

  it('Component inventoryの件数を読む', () => {
    const { provides } = parsePluginDetailsText(detailsText);
    expect(provides).toEqual({ skills: 13, agents: 3, hooks: 2, mcpServers: 0 });
  });

  it('Component inventoryが無ければprovidesは全項目undefinedのままにする', () => {
    const { provides, description } = parsePluginDetailsText('name 1.0.0\n  説明文のみ');
    expect(provides).toEqual({
      skills: undefined,
      agents: undefined,
      hooks: undefined,
      mcpServers: undefined,
    });
    expect(description).toBe('説明文のみ');
  });

  it('空文字では説明もundefinedになる', () => {
    const { description } = parsePluginDetailsText('');
    expect(description).toBeUndefined();
  });
});
