import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, EXTENSION_ID } from './helpers/extension';
import { flattenSessions } from './helpers/sessionTree';

/**
 * 統合テストの土台。実VSCode（拡張機能ホスト）上で拡張機能が有効化され、
 * package.jsonで宣言したコマンドが実際に登録されることだけを確認する。
 */
suite('拡張機能の有効化とコマンド登録（土台）', () => {
  test('拡張機能が有効化される', async () => {
    await activateExtension();
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.equal(ext?.isActive, true);
  });

  test('package.jsonのcontributes.commandsが全て登録されている', async () => {
    await activateExtension();
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext === undefined) {
      throw new Error(`拡張機能 ${EXTENSION_ID} が見つからない`);
    }
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8'),
    ) as { contributes: { commands: Array<{ command: string }> } };
    const declared = pkg.contributes.commands.map((c) => c.command);
    assert.ok(declared.length > 0, 'package.jsonにcommandsが1件もない');

    const registered = await vscode.commands.getCommands(true);
    for (const command of declared) {
      assert.ok(registered.includes(command), `コマンド ${command} が登録されていない`);
    }
  });

  test('セッション一覧TreeViewが取得でき、初期状態で例外を投げない', async () => {
    const api = await activateExtension();
    const children = await flattenSessions(api.sessionTree);
    assert.ok(Array.isArray(children));
  });
});
