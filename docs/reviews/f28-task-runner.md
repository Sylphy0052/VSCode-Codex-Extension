# F28レビュー:タスク実行

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f28)の4項目を静的レビューした。

| 項目   | 確認内容                                                        |
| ------ | --------------------------------------------------------------- |
| F28.01 | 依存doneと並列枠で起動。非同期起動前にrunningへ遷移             |
| F28.02 | 開始・反復・停止・継続・新セッション再試行と権限再確認を確認    |
| F28.03 | DONE後の独立検証・merging遷移、失敗理由別の遷移、後続停止を確認 |
| F28.04 | 結果・変更ファイル・応答要約を保存し、run終了処理と通知へ接続   |

## 指摘

### F28-01[P1]:準備中に全体停止してもタスクが起動する

[pump](../../src/orchestrator/runner.ts#L3110)はrunningへ変えて非同期の準備を始める。[stop](../../src/orchestrator/runner.ts#L2255)はhaltedByUserを立て、登録済みセッションを停止するが、準備中のセッションはまだ登録されていない。[startTask](../../src/orchestrator/runner.ts#L3742)は準備後にdisposingだけを確認し、全体停止を確認せずセッションを開いてrunLoopへ進む。worktree作成やIssue起票待ちに停止すると、その後に作業指示が送られる。

修正案:準備後・セッション生成後にrunの停止状態と起動世代を確認し、中止したセッションを閉じる。確認ケース:prepare待ちとopenTaskSession待ちのそれぞれで停止。

### F28-02[P2]:semantic:falseではverify.commandsを検証しない

[verifyTaskCompletion](../../src/orchestrator/runner.ts#L4756)はverify.commandsをsemanticレビューの依頼文だけへ挿入する。semantic:false、commandsあり、files/diffなしならコマンド未実行のまま「独立検証を通過」と記録する。

修正案:コマンド検証を独立した実行結果で判定するか、この組合せを定義検証で拒否する。確認ケース:必ず失敗する検証コマンドとsemantic:false。

根拠:[スケジューラ](../../src/orchestrator/scheduler.ts#L45)、[停止理由の遷移](../../src/orchestrator/runState.ts#L508)、[要約](../../src/orchestrator/taskSummary.ts#L22)。

実装修正、テスト・型チェック・lint、実VSCode・外部CLI連携の検証は未実施。
