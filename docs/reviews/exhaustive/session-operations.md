# セッション操作・キャッシュ掃除の精査

全文精査済み:`src/session/{sessionActions,pruneOnStartup}.ts`、`test/unit/{sessionActions,pruneOnStartup}.test.ts`。テストは未実行。

| 対象                                               | 確認経路                                                                                                | テスト内容と不足                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `buildActionArgs`                                  | UUID以外はthrow、deleteだけ--force、archive/unarchiveはidを渡す                                         | 3操作、--forceのid混入、空idを確認。UUID形式判定本体はargvBuilderの別単位                                    |
| `nodeCommandRunner.run`とPromise/execFile callback | shellなしで引数配列、30秒timeout、成功code=0、数値exit code、文字列error code→1、stderr空→error.message | 実runnerを試験せずFakeRunnerへ置換しているため、timeout・起動失敗・stderr補完は未検査                        |
| `SessionActions.constructor/run`                   | pathを取得し、引数を検証してrunnerへ委譲。path getterはid検証より先に呼ぶ                               | fakeへの実行引数、成功返値、失敗code/stderr、無効idでrun未呼出しを確認。path取得throw・runner rejectは未検査 |
| `pruneMetaCacheOnStartup`                          | 削除0→保存なし、正数→保存、prune失敗/persist失敗→sanitize後にwarn                                       | 正数3、0、prune reject、sanitize対象のパス/制御文字、persist rejectを5件で確認                               |

FakeRunnerのconstructor既定値・呼出履歴・返却、fakeLogger、各vi.fnの成功/失敗設定、非同期assertionを確認した。削除・アーカイブ・実ファイル掃除を実行する試験ではない。起動時pruneのスナップショット競合はソースにも既知の制約として明記され、対象は再取得できるメタキャッシュである。
