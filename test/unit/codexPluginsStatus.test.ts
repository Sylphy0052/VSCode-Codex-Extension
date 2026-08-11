import { describe, expect, it } from 'vitest';
import { parsePluginInstalled, parsePluginProvides } from '../../src/codex/pluginsStatus';

/**
 * `plugin/installed` の応答の形。実測（codex-cli 0.147.0。このリポジトリで
 * `codex app-server` を起動して呼び出し、実際の応答を確認した。この環境の
 * plugin設定は変更していない）から、無関係なフィールドを間引いたもの。
 */
const pluginInstalledResult = {
  marketplaces: [
    {
      name: 'openai-curated-remote',
      path: null,
      interface: { displayName: 'OpenAI Curated Remote' },
      plugins: [
        {
          id: 'openai-templates@openai-curated-remote',
          name: 'openai-templates',
          version: '0.1.1',
          localVersion: null,
          source: { type: 'remote' },
          installed: true,
          enabled: true,
          interface: { shortDescription: 'Default templates for documents' },
        },
        {
          id: 'github@openai-curated-remote',
          name: 'github',
          version: '0.1.8-2841cf9749ae',
          localVersion: null,
          source: { type: 'remote' },
          installed: true,
          enabled: true,
          interface: { shortDescription: 'Triage PRs, issues, CI, and publish flows' },
        },
        {
          id: 'gmail@openai-curated-remote',
          name: 'gmail',
          version: '0.1.7',
          localVersion: null,
          source: { type: 'remote' },
          installed: false,
          enabled: false,
          interface: { shortDescription: 'Read and manage Gmail' },
        },
      ],
    },
    {
      name: 'local-repo',
      path: '/workspace/repo/.codex/plugins/marketplace.json',
      interface: null,
      plugins: [
        {
          id: 'my-plugin@local-repo',
          name: 'my-plugin',
          version: '1.0.0',
          localVersion: '1.0.0',
          source: { type: 'local', path: '/workspace/repo/.codex/plugins/my-plugin' },
          installed: true,
          enabled: false,
          interface: { shortDescription: 'プロジェクト内のplugin' },
        },
      ],
    },
  ],
  marketplaceLoadErrors: [
    { marketplacePath: '/workspace/repo/broken.json', message: 'invalid marketplace file' },
  ],
};

describe('parsePluginInstalled', () => {
  it('installed: trueのpluginだけを一覧にする', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    expect(plugins.map((p) => p.key).sort()).toEqual(
      ['github@openai-curated-remote', 'my-plugin@local-repo', 'openai-templates@openai-curated-remote'].sort(),
    );
  });

  it('リモートカタログのpluginは出どころにマーケットプレイス名を含める', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    const github = plugins.find((p) => p.key === 'github@openai-curated-remote');
    expect(github?.origin).toContain('OpenAI Curated Remote');
    expect(github?.origin).toContain('リモート');
  });

  it('ローカルplaginは出どころにパスを含める', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    const local = plugins.find((p) => p.key === 'my-plugin@local-repo');
    expect(local?.origin).toContain('/workspace/repo/.codex/plugins/my-plugin');
  });

  it('enabledをそのまま反映する', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    expect(plugins.find((p) => p.key === 'my-plugin@local-repo')?.enabled).toBe(false);
    expect(plugins.find((p) => p.key === 'github@openai-curated-remote')?.enabled).toBe(true);
  });

  it('Codexは有効/無効を切り替える経路が無いためtoggleable: falseにする', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    expect(plugins.every((p) => p.toggleable === false)).toBe(true);
  });

  it('plugin/uninstallがあるためremovable: trueにする', () => {
    const { plugins } = parsePluginInstalled(pluginInstalledResult);
    expect(plugins.every((p) => p.removable === true)).toBe(true);
  });

  it('マーケットプレイスの一覧も返す（インストール操作の選択肢に使う）', () => {
    const { marketplaces } = parsePluginInstalled(pluginInstalledResult);
    expect(marketplaces).toEqual([
      { name: 'openai-curated-remote', path: undefined, displayName: 'OpenAI Curated Remote' },
      { name: 'local-repo', path: '/workspace/repo/.codex/plugins/marketplace.json', displayName: undefined },
    ]);
  });

  it('marketplaceLoadErrorsをwarningsへまとめる', () => {
    const { warnings } = parsePluginInstalled(pluginInstalledResult);
    expect(warnings).toEqual(['invalid marketplace file']);
  });

  it('plugin/readを呼ぶためのref（name・マーケットプレイス参照）も返す', () => {
    const { refs } = parsePluginInstalled(pluginInstalledResult);
    const github = refs.find((r) => r.key === 'github@openai-curated-remote');
    expect(github).toEqual({
      key: 'github@openai-curated-remote',
      pluginName: 'github',
      marketplaceName: 'openai-curated-remote',
      marketplacePath: undefined,
    });
  });

  it('想定外の形では空を返す', () => {
    const empty = { plugins: [], marketplaces: [], refs: [], warnings: [] };
    expect(parsePluginInstalled(undefined)).toEqual(empty);
    expect(parsePluginInstalled(null)).toEqual(empty);
    expect(parsePluginInstalled({})).toEqual(empty);
    expect(parsePluginInstalled({ marketplaces: 'x' })).toEqual(empty);
  });

  it('id/nameを持たないpluginは読み飛ばす', () => {
    const { plugins } = parsePluginInstalled({
      marketplaces: [{ name: 'm', plugins: [{ installed: true, interface: {} }] }],
    });
    expect(plugins).toEqual([]);
  });
});

/**
 * `plugin/read` の応答の形。実測（`pluginName: 'github'`,
 * `remoteMarketplaceName: 'openai-curated-remote'`）から間引いたもの。
 */
const pluginReadResult = {
  plugin: {
    marketplaceName: 'openai-curated-remote',
    summary: { id: 'github@openai-curated-remote', installed: false, enabled: false },
    description: 'Inspect repositories, triage pull requests and issues...',
    hooks: [],
    mcpServers: [],
    skills: [
      { name: 'gh-address-comments', description: '...', enabled: true },
      { name: 'gh-fix-ci', description: '...', enabled: true },
      { name: 'github', description: '...', enabled: true },
      { name: 'yeet', description: '...', enabled: true },
    ],
    apps: [{ id: 'connector_76869538009648d5b282a4bb21c3d157', name: 'GitHub' }],
    appTemplates: [],
  },
};

describe('parsePluginProvides', () => {
  it('hooks/mcpServers/skillsの件数を数える', () => {
    expect(parsePluginProvides(pluginReadResult)).toEqual({
      skills: 4,
      agents: undefined,
      hooks: 0,
      mcpServers: 0,
    });
  });

  it('summaryのinstalled/enabledは無視する（実測: 導入状態を反映しない）', () => {
    // このテスト自体が「読み取らない」ことの確認。provides以外のフィールドを返さない
    const result = parsePluginProvides(pluginReadResult);
    expect(result).not.toHaveProperty('installed');
    expect(result).not.toHaveProperty('enabled');
  });

  it('想定外の形ではundefinedを返す', () => {
    expect(parsePluginProvides(undefined)).toBeUndefined();
    expect(parsePluginProvides({})).toBeUndefined();
    expect(parsePluginProvides({ plugin: null })).toBeUndefined();
  });
});
