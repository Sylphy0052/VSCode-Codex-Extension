// `setup.mjs`（統合テストのフィクスチャ。実体はJavaScript）の型宣言。
// `test/unit/integrationFixtureGuards.test.ts` がガードを単体テストから呼ぶために要る。

/** ワークフローの実行の起点がこのリポジトリの作業ツリーの外にあることを確かめる（Issue #178）。 */
export function assertOutsideThisRepository(label: string, dir: string): void;

/**
 * テスト用ワークスペースが自分自身を根とするgitリポジトリであり、remoteを持たないことを
 * 確かめる（Issue #178）。
 */
export function assertIsolatedGitRepo(label: string, dir: string): void;

/**
 * フィクスチャ一式を作る根をプロセスごとにユニークに用意する（Issue #608）。呼ぶたびに
 * 異なるパスを返す。`<repoRoot>/.vscode-test/` の直下に作り、返った時点でディレクトリは
 * 実在する。
 */
export function createFixturesRoot(): string;

/** 使い捨てのVSCodeプロファイル・履歴データ一式を作る。`.vscode-test.mjs` から呼ばれる。 */
export function prepareFixtures(): {
  workspaceFolder: string;
  userDataDir: string;
  runtimeDir: string;
  codexHome: string;
  claudeHome: string;
  manifest: unknown;
};
