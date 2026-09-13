# F18レビュー:反復ループ・完了/停滞判定

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f18)の5項目を静的レビューした。独立した新規指摘はなし。

| 項目   | 確認内容                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| F18.01 | 回数は1〜200、時間は最大24時間へ正規化。時間制限はターン間と一時停止からの再開時に確認し、進行中ターンを時間だけで中断しない                     |
| F18.02 | 開始・停止・pause/resume、保留プロンプト、送信失敗、停止後の非同期結果の世代照合を確認                                                           |
| F18.03 | busyを観測してからturnCompletionSeq更新を待つ。最後の新しいagentMessageの最終非空行だけでDONE/ESCALATEを判定。ゴール型は自己申告DONEを採用しない |
| F18.04 | 承認・送信キューが残る間は進めない。失敗・撤退・同一非空応答の反復・時間・回数で停止。使用量制限との接続はF11参照                                |
| F18.05 | 初回/継続で別の検証方針を付与。有効設定でも空本文・空指示へは追加しない                                                                          |

根拠:[LoopController](../../src/loop/loopController.ts#L588)、[observe](../../src/loop/loopController.ts#L671)、[送信](../../src/loop/loopController.ts#L978)、[停滞](../../src/loop/stallDetector.ts)、[指示と終了合図](../../src/loop/loopEngineering.ts)、[焦点](../../src/loop/turnFocus.ts)、[Codexの開始](../../src/view/chatView.ts#L1410)、[Claudeの開始](../../src/view/claudeChatView.ts#L2181)。

UIの連打による二重開始や、通常送信・承認回答との実イベント順序は実VSCodeで未検証。既存loopControllerテストには停止後のAdvisor結果破棄やpause/resumeの観点があるが、全ケースの実行結果は確認していない。テスト・型チェック・lint・実CLIは未実行。
