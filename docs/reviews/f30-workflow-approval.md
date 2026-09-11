# F30レビュー:ワークフロー承認・人への確認

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f30)の4項目を静的レビューした。

| 項目   | 確認内容                                                                                 |
| ------ | ---------------------------------------------------------------------------------------- |
| F30.01 | 拡張設定とタスク設定の安全側合成、autoApprove上限、未知値の扱いを確認                    |
| F30.02 | 不明要求・権限変更・空コマンド・不明変更先を人へ回す。待機時刻で古い期限イベントを無効化 |
| F30.03 | ask_userは1run同時1問、2〜4択、回数上限。回答はbusy解除後に配送                          |
| F30.04 | confirmとorchestratorを区別し、判断中の再操作を拒否。期限切れはhold、停止後mergeは禁止   |

独立した新規指摘はなし。根拠:[実効設定](../../src/orchestrator/taskConfig.ts#L77)、[判定](../../src/orchestrator/escalation.ts#L629)、[期限処理](../../src/orchestrator/runnerApproval.ts#L64)、[質問と回答](../../src/orchestrator/runnerOrchestrator.ts#L690)、[最終判断](../../src/orchestrator/runner.ts#L4402)。

ClaudeのaskUserQuestionは[共通承認ハンドラ](../../src/orchestrator/runner.ts#L4463)で直接askへ返すため、通常のpendingApproval収集・期限処理とは別経路になる。質問待ちの活動表示は[F12](f12-notifications-session-activity.md)と併せて確認する。危険コマンドの分類は既定パターンによる補助判定で、任意のシェルプログラムの安全性を証明するものではない。

実装修正、テスト・型チェック・lint、実VSCode・外部CLI連携の検証は未実施。
