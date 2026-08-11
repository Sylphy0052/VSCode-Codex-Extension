import { describe, expect, it } from 'vitest';
import { mergeApps, parseAppsInstalled, parseAppsRead } from '../../src/codex/appsStatus';

/** 実測（codex-cli 0.147.0。この環境で実際に導入済みのappを読んだ。設定は変更していない）。 */
const appsInstalledResult = {
  apps: [
    { id: 'connector_76869538009648d5b282a4bb21c3d157', runtimeName: 'GitHub', enabled: true, callable: true },
    { id: 'connector_openai_plugin_management', runtimeName: 'Plugin Management', enabled: true, callable: true },
    { id: 'connector_disabled_example', runtimeName: 'Disabled Example', enabled: false, callable: false },
  ],
};

const appsReadResult = {
  apps: [
    {
      id: 'connector_76869538009648d5b282a4bb21c3d157',
      name: 'GitHub',
      description: 'Access repositories, issues, and pull requests.',
    },
    {
      id: 'connector_openai_plugin_management',
      name: 'Plugin Management',
      description: 'Manage plugins in ChatGPT.',
    },
  ],
  missingAppIds: [],
};

describe('parseAppsInstalled', () => {
  it('id/runtimeName/enabled/callableを読む', () => {
    const apps = parseAppsInstalled(appsInstalledResult);
    expect(apps).toHaveLength(3);
    expect(apps[0]).toEqual({
      id: 'connector_76869538009648d5b282a4bb21c3d157',
      runtimeName: 'GitHub',
      enabled: true,
      callable: true,
    });
  });

  it('idを持たないappは読み飛ばす', () => {
    expect(parseAppsInstalled({ apps: [{ runtimeName: 'x' }] })).toEqual([]);
  });

  it('想定外の形では空を返す', () => {
    expect(parseAppsInstalled(undefined)).toEqual([]);
    expect(parseAppsInstalled({})).toEqual([]);
    expect(parseAppsInstalled({ apps: 'x' })).toEqual([]);
  });
});

describe('parseAppsRead', () => {
  it('id別にname/descriptionを読む', () => {
    const details = parseAppsRead(appsReadResult);
    expect(details.get('connector_76869538009648d5b282a4bb21c3d157')).toEqual({
      name: 'GitHub',
      description: 'Access repositories, issues, and pull requests.',
    });
  });

  it('想定外の形では空のMapを返す', () => {
    expect(parseAppsRead(undefined).size).toBe(0);
    expect(parseAppsRead({ apps: 'x' }).size).toBe(0);
  });
});

describe('mergeApps', () => {
  it('app/readの説明で補い、無ければruntimeNameを名前にする', () => {
    const installed = parseAppsInstalled(appsInstalledResult);
    const details = parseAppsRead(appsReadResult);
    const apps = mergeApps(installed, details);

    expect(apps.find((a) => a.key === 'connector_76869538009648d5b282a4bb21c3d157')).toEqual({
      key: 'connector_76869538009648d5b282a4bb21c3d157',
      name: 'GitHub',
      description: 'Access repositories, issues, and pull requests.',
      enabled: true,
      callable: true,
    });

    // app/readに無いappはruntimeNameへ退避し、一覧から失われない
    const disabled = apps.find((a) => a.key === 'connector_disabled_example');
    expect(disabled?.name).toBe('Disabled Example');
    expect(disabled?.description).toBeUndefined();
    expect(disabled?.enabled).toBe(false);
  });

  it('名前順に並べる', () => {
    const installed = parseAppsInstalled(appsInstalledResult);
    const details = parseAppsRead(appsReadResult);
    const apps = mergeApps(installed, details);
    const names = apps.map((a) => a.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
