import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface FixtureManifest {
  workspaceFolder: string;
  /** ワークフローの統合テスト（Issue #158）用の定義ファイル。 */
  workflow: {
    defPath: string;
    /** 統合の衝突（Issue #170）用。同じ行を書き換える2つの並列タスクを含む。 */
    conflictDefPath: string;
    /** タスク間メッセージング（Issue #171）用。並列に走る2つのタスクを含む。 */
    messagingDefPath: string;
  };
  /**
   * ロードマップ一周（Issue #173）用のひな形。runの終了後に非同期でロードマップが
   * 書き戻されるため、テストはケースごとに別のロードマップと定義を掘って使う。
   */
  roadmap: {
    markdown: string;
    /** `roadmap:` が `markdownRelativePath` を指すワークフロー定義のひな形。 */
    defTemplate: string;
    markdownRelativePath: string;
    /** ワークスペース相対のロードマップ置き場・定義置き場。 */
    dir: string;
    workflowDir: string;
  };
  /**
   * 疑似worktree（Issue #168）用。`root` は**gitリポジトリではない**親ディレクトリで、
   * テストはこの下にケースごとの使い捨てワークスペースを作り、定義のひな形をコピーして使う。
   */
  pseudoWorktree: {
    root: string;
    defTemplate: string;
    strictDefTemplate: string;
  };
  /**
   * PR/MRの作成順序（Issue #172）用。`root` の下にケースごとの使い捨てディレクトリを掘り、
   * ローカルのbareリポジトリを `origin` に持つ作業ツリーを作る（`helpers/forgeRepo.ts`）。
   */
  forge: {
    root: string;
    defTemplate: string;
  };
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
