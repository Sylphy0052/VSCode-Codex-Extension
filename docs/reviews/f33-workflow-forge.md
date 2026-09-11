# F33レビュー:ワークフローのGitHub/GitLab連携

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f33)の5項目を静的レビューした。

| 項目   | 確認内容                                                                             |
| ------ | ------------------------------------------------------------------------------------ |
| F33.01 | originと設定からホストを選び、CLIの存在・認証を確認。不足時は警告して連携を省略      |
| F33.02 | Issueと本文一時ファイル、管理ブランチpush、タスクPRと統合PR、Draft/readyの順序を確認 |
| F33.03 | 独立セッションでの差分レビュー、レビューコメントの重複排除・定期取得を確認           |
| F33.04 | CIなし・成功・失敗・timeoutを区別し、base更新後に再確認。停止をマージ直前にも確認    |
| F33.05 | PR番号を指定して最終マージ。never/confirm/orchestrator等の方針とrun側判断待ちに接続  |

## 指摘

### F33-01[P2]:ローカル統合に失敗してもタスクPRをreadyにする

[runTaskPullRequestFlow](../../src/orchestrator/forge.ts#L1108)はmergeAndPushIntegrationの結果を確認せずmarkPullRequestReadyを呼ぶ。[実コールバック](../../src/orchestrator/runnerMerge.ts#L187)は競合・失敗結果もそのまま返すため、未解決のタスクPRがDraft解除される。

修正案:統合成功を表す条件をflowへ渡し、失敗時はDraftを保持する。確認ケース:競合、git失敗、成功、push失敗。

根拠:[作成と一時ファイル](../../src/orchestrator/forge.ts#L746)、[CIゲート](../../src/orchestrator/forge.ts#L1930)、[コメント取得](../../src/orchestrator/runnerReviewComments.ts#L56)。

訂正:タスクPRレビューの指摘でローカル統合を止めない実装は、設計書§16.18のレビューゲートに反する。[EX-FORGE-04](exhaustive/forge-main.md)へ記録した。CI結果とマージ対象SHAの固定、複数ホストの認証、外部CLIの応答互換性は実サービス未確認。

実装修正、テスト・型チェック・lint、実VSCode・外部CLI連携の検証は未実施。
