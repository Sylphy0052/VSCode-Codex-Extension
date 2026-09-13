# F16レビュー:MCP・hooksの管理

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f16)の3項目を静的レビューした。指摘2件、いずれもP2。

| 項目   | 確認内容                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F16.01 | Codexは接続状態とconfigのenabledを合成。Claudeは専用プロセスのcontrol応答を利用。接続・無効・取得失敗を分け、ツール数・版・理由を表示                                   |
| F16.02 | 名前検証、Codexの設定書込とreload、Claudeのmcp_toggle、操作後再取得を確認                                                                                               |
| F16.03 | Codexはhook由来・有効状態・信頼hash・警告を変換し、quoted keyでtrusted_hashを書き込む。Claudeはeffective settingsから一覧化し、信頼非対応とplugin由来の欠落可能性を表示 |

### F16-01[P2]:ドットを含むMCP名を別の設定階層として書き込む

[名前検証](../../src/provider/mcpServers.ts)はドットを許すが、[設定書込](../../src/codex/appServerClient.ts#L264)はmcp_servers.${name}.enabledを引用なしで組み立てる。名前がa.bなら、単一サーバーa.bではなくa配下のbというパスになる。対象の無効化に失敗するか、別の設定を作る。

[hookの書込](../../src/codex/hooksStatus.ts#L142)同様に名前を単一のquoted keyへ変換する。通常名とドット入りの名前で書込先を確認する必要がある。

### F16-02[P2]:MCP切替・hook信頼の失敗結果を画面が捨てる

[画面ハンドラー](../../src/view/controlPanelView.ts#L292)はtoggleMcpServerとtrustCodexHookのok=falseを見ず、refreshだけを呼ぶ。設定側はログにしか失敗を残さない。書込不可やreload失敗では、利用者に失敗理由が出ない。

アカウント操作と同様に失敗を通知する。書込成功後のreload失敗は、変更済みと再読込失敗を分けて案内する。

根拠:[MCP状態変換](../../src/codex/mcpStatus.ts)、[hooks状態変換](../../src/codex/hooksStatus.ts)、[Claude MCP](../../src/claude/mcpProbe.ts)、[Claude hooks](../../src/claude/hooksProbe.ts)、[settings解析](../../src/claude/hooksSettings.ts)。Claudeのプロジェクト別設定はprobeの起動cwdに依存し、複数workspaceの各会話へ適用されるかは実環境で未検証。テスト・設定変更・実CLIは実行していない。
