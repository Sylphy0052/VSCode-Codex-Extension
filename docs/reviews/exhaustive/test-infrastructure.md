# テスト基盤の精査

`scripts/{check.sh,count-manual-test-cases.mjs,run-external-cli-tests.mjs,xvfb-vscode-test.sh}`、`.vscode-test.mjs`、`eslint.config.mjs`、`vitest.config.ts`、`test/unit/eslintConfig.test.ts`、`test/external-cli/threadStart.test.mjs`を全文精査。関連設定の`.github/workflows/ci.yml`、`tsconfig.json`、`tsconfig.integration.json`も読んだ。コマンド・テスト・lint・型チェックは実行していない。

## 新規指摘

### EX-TEST-01[P2]ESLintの検査用テストが既存ファイルを上書きして削除する

`test/unit/eslintConfig.test.ts`のlintProbeFilesは固定名`src/t26FloatingPromiseProbe.ts`と`test/integration/t26FloatingPromiseProbe.ts`へ通常のwriteFileで書き、finallyでrm(force=true)する。同名ファイルがある状態でテストを実行すると元の内容を失う。書込がtryより前なので、一方の書込が失敗しても他方の作成分を回収しない。同時実行も衝突する。存在しない固有パスの排他的作成と、作成できたファイルだけの回収が必要。今回は実行していない。

### EX-TEST-02[P2]ルールの有効性を判定するテストがseverity=0を通す

同ファイルのisConfiguredはArray.isArrayしか見ない。no-misused-promisesとawait-thenableの確認は[0]でもtrueになり、ルールを無効化した変更を検出できない。severityの検査か、違反コードに対する実際の診断をassertする必要がある。no-floating-promisesの別テストは診断のruleIdを検査している。

## 全関数・分岐・テスト内容

| 対象                        | 確認内容と不足                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| check.sh                    | set-euo、作業場所移動、lint→format→typecheck→testの順序と失敗停止。実行していない                                                                                                                                                                                                                                                                                            |
| count-manual-test-cases.mjs | 読込、見出し正規表現、数値/英字/添字への分解、群別蓄積、sort、連番統合、既知群出力、未知群warningを確認。重複IDを排除しない。正規表現は末尾固定でなく、英字の連続判定は先頭文字のみ。現行単文字ID以外の形式は保証しない。専用テストなし                                                                                                                                      |
| run-external-cli-tests.mjs  | ファイル列挙・拡張子絞込・sort、0ファイル終了、spawnSync、起動error、status=nullを確認。空ファイルや全skipまで検知する仕組みはない。現在のthreadStart試験にskipはない                                                                                                                                                                                                        |
| xvfb-vscode-test.sh         | set-euo、cwd、xvfbの自動DISPLAY、引数保持を確認                                                                                                                                                                                                                                                                                                                              |
| .vscode-test.mjs            | prepareFixtures呼出し、対象glob、fixture workspace、独立user dir、PATH制限、統合試験用env、TDD/timeoutを確認。prepareFixturesの実装は別項目                                                                                                                                                                                                                                  |
| eslint.config.mjs           | 除外、推奨ルール、型付き対象とproject、非同期ルール、未使用/no-console/eqeqeq、scripts限定例外を確認。.worktreeは明示除外されない。新設調査補助はCommonJSのrequireに依存しない形にする                                                                                                                                                                                       |
| vitest.config.ts            | vscode mockへのalias、unit対象、integration除外、v8のsrc対象と閾値を確認。TZ固定なし。文字列中のWebview JavaScriptは通常の関数カバレッジに入らない                                                                                                                                                                                                                           |
| eslintConfig.test.ts        | lintProbeFilesの作成・lint・結果map・finally、rulesForのconfig取得、isConfigured、4テストを確認。診断確認、2ルールの設定確認、JSへの型付きルール非適用、require-awaitの非適用。上記2指摘のほか、診断severity自体はassertしない                                                                                                                                               |
| threadStart.test.mjs        | 独立cwd/CODEX_HOME、環境構築、spawn、JSONLバッファ、parse失敗の無視、id別Promise、20秒timeout、stdin書込error、initialize、initialized通知、thread/start、ID期待値、finallyを確認。terminateProcessの既終了・SIGTERM・exit・5秒後SIGKILL・追加5秒timeout・settled・タイマー解除も確認。実CLIで検査するのはthread/startで非空文字列IDが返ることだけ。fork/resume/turnは対象外 |
| 外部試験の異常系            | proc/errorとstdin/errorのlistenerなし。request書込失敗時にpendingが残る。終了待ちがrejectすると後続の一時ディレクトリ削除へ進まない。stderr上限なし。これらを再現する試験はない。実行時障害としての再現は未確認                                                                                                                                                              |

CIはチェック群とCLI固定版の外部試験を分ける。VSCode統合試験はCIに含まれない。過去のCI・手動試験記録を、現在のコードで試験成功した根拠として扱わない。
