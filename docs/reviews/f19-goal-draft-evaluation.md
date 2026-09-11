# F19レビュー:ゴール下書き・ゴール駆動ループ

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f19)の4項目を静的レビューした。P1が1件。

| 項目   | 確認内容                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F19.01 | 短い依頼と取得できたGitHub Issueから下書き生成。Issue取得失敗は依頼だけへフォールバック                                                                 |
| F19.02 | provider/model/期限を反映。要求IDと入力スナップショットで古い下書きによる上書きを防ぐ。外部Issue由来は自動開始設定でも確認を要求                        |
| F19.03 | 終了コードを持つコマンドだけを証拠化し、既存の完了コマンドは除外。作業役の自己申告はunknown。証拠40件、出力抜粋と直近応答に上限                         |
| F19.04 | achieved/continue/escalate/indeterminateを区別。不正応答・呼出失敗はindeterminate、連続上限で停止。Advisorのblockerを優先し、達成との衝突も別の停止理由 |

### F19-01[P1]:評価役へコマンド出力などをマスクせず送る

[評価用prompt](../../src/loop/goalEvaluatorProcess.ts#L78)はbuildEvaluatorPromptの結果をそのまま補助CLIへ送る。[証拠収集](../../src/loop/goalLoop.ts#L178)にはコマンドの引数・出力が入り、[prompt](../../src/loop/goalPrompt.ts#L67)はuntrustedの区切りを付けるだけで資格情報を伏せない。出力にトークンなどが含まれる場合、設定次第で本流と異なるproviderへも原文が送られる。

下書き役とAdvisorが使うredactCredentialsを評価役にも適用する。コマンド引数・末尾出力・応答・ゴールにマスク対象を入れ、送信直前の文字列で伏せられることを確認する必要がある。今回は送信しておらず、実際の漏えいが発生したという指摘ではない。

根拠:[下書き](../../src/loop/goalDraft.ts)、[下書きの送信前マスク](../../src/loop/goalDraftProcess.ts#L67)、[factory](../../src/view/goalDraftFactory.ts)、[入力の照合](../../src/view/chatScript.ts#L2768)、[評価結果](../../src/loop/goalPrompt.ts#L144)、[停止判断](../../src/loop/loopController.ts#L819)。モデルの達成判定自体はプロンプトへの遵守に依存する。テスト・実CLI・Issue取得は実行していない。
