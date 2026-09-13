# F22レビュー:セカンドオピニオンの実行・継続相談

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f22)の5項目を静的レビューした。P1が1件、P2が1件。

| 項目   | 確認内容                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| F22.01 | 候補の空値・制御文字・長さを検証し、選択とeffort変更後に独立Codexを開く。MCP/skills無効、read-only、bundleをcwdに指定 |
| F22.02 | 親ごとのregistryで二重開始を防ぎ、親idle待機・取消・timeout・部分回答を区別。keepSessionの移譲失敗時もdispose         |
| F22.03 | 親の注記へ結果を表示。autoSendは未確認の別AIの意見である旨を付け、送信失敗を通知                                      |
| F22.04 | 継続質問、資料revision更新、ACK、指示案JSON検証、編集用文書、明示承認、下書きrevision照合、送信失敗時の承認復帰を確認 |
| F22.05 | 相談の置換・終了・idle期限・親終了で閉じる。資料書込中の終了は削除を保留して書込後に片付ける                          |

### F22-01[P1]:利用者が取消した部分回答を本流へ自動送信する

[runSecondOpinion](../../src/secondOpinion/run.ts#L243)は取消時に部分回答があればok=true、cancelledByUser=trueを返す。[autoSendResult](../../src/view/secondOpinionCommand.ts#L1076)はokしか見ず、設定が有効ならこの回答をsendApprovedInstructionへ渡す。取消した操作から本流の新しい作業が始まるか、待機列へ入る。

cancelledByUserの結果は表示だけに留める。timeoutの部分回答を送る設定とは分け、取消前後に部分回答がある場合・ない場合を確認する必要がある。

### F22-02[P2]:資料更新で未追跡ファイルの内容を渡さない

[materialWriterFor](../../src/view/secondOpinionCommand.ts#L683)は未追跡も採取するが、appendReviewBundleRevisionへfullDiffとchangedPathsだけを渡す。[書出し](../../src/secondOpinion/reviewBundle.ts#L285)は追跡ファイルの差分とbaseだけになる。初回以降に追加・変更された未追跡ファイルは新revisionへ入らず、更新を了承した相談先にも届かない。

新revisionへ未追跡の内容と省略理由を保存し、更新通知から参照させる。未追跡だけが変わった場合と追跡/未追跡が混在する場合を確認する。

根拠:[実行](../../src/secondOpinion/run.ts)、[親待機](../../src/secondOpinion/wait.ts)、[相談状態](../../src/secondOpinion/advisorSession.ts#L313)、[指示案](../../src/secondOpinion/handoff.ts)、[承認](../../src/view/secondOpinionCommand.ts#L1175)。テスト・実CLI・自動送信・実際の承認は未実行。
