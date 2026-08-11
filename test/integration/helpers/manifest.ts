import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface FixtureManifest {
  workspaceFolder: string;
  outsideWorkspace: string;
  codexHome: string;
  claudeHome: string;
  codex: {
    named: { id: string; threadName: string };
    archived: { id: string; threadName: string };
    unnamed: { id: string; firstMessage: string };
  };
  claude: {
    inScope: { id: string; firstMessage: string };
    outOfScope: { id: string; firstMessage: string };
  };
}

/** `test/integration/fixtures/setup.mjs` がワークスペース直下に書き出した内容を読み直す。 */
export function readManifest(): FixtureManifest {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    throw new Error(
      'テスト用ワークスペースフォルダが開かれていない（.vscode-test.mjsのworkspaceFolder設定を確認）',
    );
  }
  const manifestPath = path.join(folder.uri.fsPath, '.fixture-manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as FixtureManifest;
}
