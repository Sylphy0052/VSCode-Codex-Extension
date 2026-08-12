import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, EXTENSION_ID } from './helpers/extension';
import { readManifest } from './helpers/manifest';

interface ConfigurationProperty {
  default?: unknown;
}

function readConfigurationSchema(): Record<string, ConfigurationProperty> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (ext === undefined) {
    throw new Error(`拡張機能 ${EXTENSION_ID} が見つからない`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, ConfigurationProperty> } };
  };
  return pkg.contributes.configuration.properties;
}

/** 統合テスト用の使い捨てVSCodeプロファイル（`test/integration/fixtures/setup.mjs`）が
 * 意図的に上書きしているキー。既定値との比較対象から外す。 */
const OVERRIDDEN_BY_FIXTURE = new Set([
  'codex.codexHome',
  'codex.executablePath',
  'claude.configDir',
  'claude.executablePath',
  'agent.activityLog.enabled',
  'agent.activityLog.dir',
  // PR/MRの作成と `git push` を封じている（Issue #178）。値は次のテストで確かめる。
  'agent.workflows.forge',
  'agent.workflows.pullRequest',
  'agent.workflows.finalMerge',
]);

suite('設定（package.jsonのcontributes.configurationとの整合）', () => {
  test('上書きしていないキーはpackage.jsonの既定値どおりに読める', async () => {
    await activateExtension();
    const properties = readConfigurationSchema();
    const config = vscode.workspace.getConfiguration();

    for (const [key, schema] of Object.entries(properties)) {
      if (OVERRIDDEN_BY_FIXTURE.has(key) || !('default' in schema)) {
        continue;
      }
      assert.deepEqual(
        config.get(key),
        schema.default,
        `設定 ${key} の実際値がpackage.jsonの既定値と一致しない`,
      );
    }
  });

  test('統合テスト用プロファイルで上書きした値が実際に反映されている', async () => {
    await activateExtension();
    const manifest = readManifest();
    const config = vscode.workspace.getConfiguration();

    assert.equal(config.get('codex.codexHome'), manifest.codexHome);
    assert.equal(config.get('claude.configDir'), manifest.claudeHome);
    assert.equal(config.get('agent.activityLog.enabled'), false);
  });

  test('統合テストの実行が origin へ push しうる経路は設定で塞がれている（Issue #178）', async () => {
    await activateExtension();
    const config = vscode.workspace.getConfiguration();

    // PR/MRを作らない＝タスクブランチ・統合ブランチのpush（§16.18）そのものが通らない。
    assert.equal(config.get('agent.workflows.forge'), 'none');
    assert.equal(config.get('agent.workflows.pullRequest'), 'none');
    // 統合ブランチ→mainの無人マージも行わせない。
    assert.equal(config.get('agent.workflows.finalMerge'), 'pr-only');
  });

  test('resourceスコープの設定はワークスペースへ書き込むと読み直せる', async () => {
    await activateExtension();
    const config = vscode.workspace.getConfiguration('agent');
    const original = config.get<string>('workflows.dir');

    await config.update(
      'workflows.dir',
      '.agents/integration-test',
      vscode.ConfigurationTarget.Workspace,
    );
    try {
      const updated = vscode.workspace.getConfiguration('agent').get<string>('workflows.dir');
      assert.equal(updated, '.agents/integration-test');
    } finally {
      await config.update('workflows.dir', original, vscode.ConfigurationTarget.Workspace);
    }
  });
});
