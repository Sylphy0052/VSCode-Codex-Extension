# F17レビュー:skills・plugins・apps・設定インポート

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f17)の4項目を静的レビューした。指摘2件、いずれもP2。

| 項目   | 確認内容                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F17.01 | Codexはpath単位で重複排除して一覧・警告を表示しskills/config/writeで切替。Claudeはprobeと開いている会話へreloadを送り、有効切替は出さない |
| F17.02 | Codexは導入・削除、Claudeは加えて有効切替。導入・削除は確認付き、Claudeのscopeは引数で渡す。Codexの一覧にはmarketplace取得エラーも表示    |
| F17.03 | app/installedの全件を表示し、上限件数までapp/readで名前を補完。補完失敗時はruntimeName/idを残す                                           |
| F17.04 | home/workspaceの候補検出、既知キー選別、内容確認、raw候補で実行、進捗と完了通知、timeout後の履歴参照を確認                                |

### F17-01[P2]:インポート確認中の更新で、確認した候補と実行内容が入れ替わる

[runCodexImport](../../src/view/settingsProvider.ts#L731)はitemsを保持して確認ダイアログを待ち、その後に可変のcodexImportRawByKeyからrawを引く。確認中に候補を再検出すると、同じitemType/cwdキーの別内容を実行する。候補の一部が消えた場合も、残りだけで実行してしまう。

確認前にraw候補も固定し、確認した全項目と実行内容を一致させる。確認中の再取得、同じキーで内容変更、一部候補消失を確認する必要がある。

### F17-02[P2]:skillとClaude pluginの切替失敗を画面へ通知しない

[skill切替](../../src/view/controlPanelView.ts#L319)と[plugin切替](../../src/view/controlPanelView.ts#L348)は失敗結果を捨ててrefreshする。設定側はログに残すだけなので、権限エラー・不正scopeなどの理由が見えない。F16-02と共通の画面処理で修正できる。

根拠:[skills](../../src/codex/skillsStatus.ts)、[plugins](../../src/codex/pluginsStatus.ts)、[apps](../../src/codex/appsStatus.ts)、[import](../../src/codex/importStatus.ts)、[CLI接続](../../src/codex/appServerClient.ts#L660)、[Claude skills](../../src/claude/skillsProbe.ts)、[Claude plugin操作](../../src/claude/pluginsActions.ts)。既存ファイルの競合解決は外部CLIへ委ねられ、拡張側ではロールバックしない。テスト・導入・削除・インポート・実CLIは実行していない。
