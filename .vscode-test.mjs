// @vscode/test-cli の設定ファイル。`npm run test:integration` から呼ばれる。
//
// 実VSCode（Electron）を起動して拡張機能ホスト内でmochaテストを走らせる。フィクスチャ
// （履歴データ・使い捨てのVSCodeプロファイル）は `test/integration/fixtures/setup.mjs` が
// このファイルの読み込み時に一度だけ作る。ユーザーの実環境には触れない
// （`.vscode-test/` は.gitignore済み）。
import { defineConfig } from '@vscode/test-cli';
import { prepareFixtures } from './test/integration/fixtures/setup.mjs';

const fixtures = prepareFixtures();

export default defineConfig({
  label: 'integration',
  files: 'out/integration/**/*.test.js',
  workspaceFolder: fixtures.workspaceFolder,
  launchArgs: [
    `--user-data-dir=${fixtures.userDataDir}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
    // Electron内蔵のsetuidサンドボックスは、実行環境によっては権限不足でカーネルに
    // SIGKILLされる（chrome-sandboxがCAP_SYS_ADMIN相当を要求するため）。統合テストは
    // 使い捨てのVSCodeプロファイル・ワークスペースでのみ動くため、この隔離は不要。
    '--no-sandbox',
  ],
  env: {
    // codex/claudeが実行ファイルとしてPATH上に居ても解決させない（実CLIを絶対に呼ばせない
    // ための二重の防御。設定側の対策は setup.mjs のexecutablePath参照）。
    PATH: '/usr/bin:/bin',
    // VSCodeがIPCソケットを作る先。実行環境の `/run/user/<uid>` が消えていても起動できる
    // ようにする（issue #163。理由は setup.mjs の createRuntimeDir 参照）。
    XDG_RUNTIME_DIR: fixtures.runtimeDir,
  },
  mocha: {
    ui: 'tdd',
    color: true,
    timeout: 20_000,
  },
});
