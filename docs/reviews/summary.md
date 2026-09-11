# 全機能の静的レビュー結果

2026-09-09、[機能別台帳](../feature-inventory.md)の全40機能・176項目の静的レビューを完了した。対象commitはefd5cd67eb6a9b0a957538c9b5f981e2969875b6。

未修正の指摘は計116件（P1:22件、P2:94件）。F03の途中分岐に関する追加調査3件を含む。機能別の指摘IDを数えた件数で、同じ根本原因にまとめられる指摘も含む。修正Issue数や独立した障害数ではない。

P1はデータ・権限・実行制御・主要機能への影響から優先対応が必要な指摘、P2は条件付きの不具合や表示・導線・診断の問題として付けた。静的に確認した経路と、未実行の確認例を各文書で分けて記録している。

## 先に対応する箇所

| 対象                 | 影響と確認先                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ファイル復元・書込先 | [F09](f09-diff-edit-resend-file-restore.md):確認後のパス差し替え、既存ファイルの誤削除、別cwdへの書込。[F27](f27-roadmap.md):同名ロードマップの上書き。                                                                                             |
| 承認の対象・設定     | [F10](f10-tool-approvals-user-questions.md):別会話への承認配送とbypass残留。[F13](f13-plan-review-export.md):古い承認設定による上書き。[F36](f36-workflow-view.md):画面切り替え時の承認対象不一致。                                                 |
| 停止・中断・復元     | [F03](f03-session-lifecycle.md)、[F11](f11-usage-cost-limit-auto-resume.md)、[F22](f22-second-opinion-consultation.md)、[F28](f28-task-runner.md)、[F34](f34-program-runner.md)、[F35](f35-run-restore.md):停止後の継続・再開や返信待ちの取り残し。 |
| 資料・ログの秘密情報 | [F19](f19-goal-draft-evaluation.md)、[F21](f21-second-opinion-material.md)、[F39](f39-activity-logs.md):モデルへの追加送信や日報保存でマスクが適用されない経路。実際の流出は未確認。                                                                |
| 起動・履歴・分岐     | [F01](f01-startup-cli-process.md):ホーム設定の未反映。[F02](f02-history-search-organization.md):空のClaude履歴の更新循環。[F03](f03-session-lifecycle.md):分岐元とcwdの誤った継承。                                                                 |

## 機能別の結果

指摘0件は今回の確認範囲で新規指摘を記録しなかった意味であり、動作保証ではない。共通処理の指摘は該当文書の相互参照をたどる。

| 機能                                      | 確認項目数 | P1  | P2  | 結果                                                                          |
| ----------------------------------------- | ---------- | --- | --- | ----------------------------------------------------------------------------- |
| F01:起動・CLI探索・プロセス管理           | 6          | 1   | 5   | [詳細](f01-startup-cli-process.md)                                            |
| F02:履歴の収集・検索・整理                | 5          | 1   | 3   | [詳細](f02-history-search-organization.md)                                    |
| F03:会話の開始・再開・命名・タブ復元      | 5          | 3   | 6   | [詳細](f03-session-lifecycle.md)、[分岐追加](f03-fork-error-investigation.md) |
| F04:モデル・設定パネル・プリセット        | 5          | 0   | 4   | [詳細](f04-model-settings-presets.md)                                         |
| F05:入力・送信・キュー・中断              | 5          | 0   | 7   | [詳細](f05-input-send-queue-interrupt.md)                                     |
| F06:添付・画像・ファイル参照              | 4          | 0   | 7   | [詳細](f06-attachments-images-file-references.md)                             |
| F07:スラッシュコマンド・特殊入力          | 5          | 0   | 8   | [詳細](f07-slash-commands-special-input.md)                                   |
| F08:チャット描画・操作性・状態同期        | 5          | 0   | 7   | [詳細](f08-chat-rendering-state-sync.md)                                      |
| F09:差分表示・編集再送・ファイル復元      | 4          | 3   | 4   | [詳細](f09-diff-edit-resend-file-restore.md)                                  |
| F10:ツール承認・質問への回答              | 5          | 2   | 8   | [詳細](f10-tool-approvals-user-questions.md)                                  |
| F11:使用量・費用・制限からの自動再開      | 4          | 2   | 6   | [詳細](f11-usage-cost-limit-auto-resume.md)                                   |
| F12:通知・会話の実行状態                  | 3          | 0   | 4   | [詳細](f12-notifications-session-activity.md)                                 |
| F13:計画・レビュー・圧縮・要約・書き出し  | 6          | 1   | 2   | [詳細](f13-plan-review-export.md)                                             |
| F14:脇道の質問・バックグラウンド作業      | 4          | 0   | 2   | [詳細](f14-side-questions-background.md)                                      |
| F15:アカウント・ログイン状態              | 3          | 0   | 0   | [詳細](f15-account-auth.md)                                                   |
| F16:MCP・hooksの管理                      | 3          | 0   | 2   | [詳細](f16-mcp-hooks.md)                                                      |
| F17:skills・plugins・apps・設定インポート | 4          | 0   | 2   | [詳細](f17-skills-plugins-apps-import.md)                                     |
| F18:反復ループ・完了/停滞判定             | 5          | 0   | 0   | [詳細](f18-loop-control.md)                                                   |
| F19:ゴール下書き・ゴール駆動ループ        | 4          | 1   | 0   | [詳細](f19-goal-draft-evaluation.md)                                          |
| F20:ループAdvisor・補助CLIの制限          | 4          | 0   | 1   | [詳細](f20-advisor-headless.md)                                               |
| F21:セカンドオピニオンの資料準備          | 5          | 1   | 1   | [詳細](f21-second-opinion-material.md)                                        |
| F22:セカンドオピニオンの実行・継続相談    | 5          | 1   | 1   | [詳細](f22-second-opinion-consultation.md)                                    |
| F23:進捗画面                              | 4          | 0   | 1   | [詳細](f23-progress-view.md)                                                  |
| F24:セッションカンバン                    | 3          | 0   | 0   | [詳細](f24-session-kanban.md)                                                 |
| F25:ワークフロー定義・テンプレート        | 4          | 0   | 1   | [詳細](f25-workflow-definition.md)                                            |
| F26:ゴールからのワークフロー生成          | 3          | 0   | 1   | [詳細](f26-workflow-generation.md)                                            |
| F27:ロードマップ生成・変換・次フェーズ    | 5          | 1   | 0   | [詳細](f27-roadmap.md)                                                        |
| F28:タスク実行・スケジューリング          | 4          | 1   | 1   | [詳細](f28-task-runner.md)                                                    |
| F29:worktree隔離・ローカル統合・片付け    | 4          | 0   | 0   | [詳細](f29-worktree-integration.md)                                           |
| F30:ワークフロー承認・人への確認          | 4          | 0   | 0   | [詳細](f30-workflow-approval.md)                                              |
| F31:オーケストレーター・タスク間通信      | 5          | 0   | 1   | [詳細](f31-orchestrator-messaging.md)                                         |
| F32:チームモード・役割・受け渡しファイル  | 4          | 0   | 1   | [詳細](f32-team-handoff.md)                                                   |
| F33:ワークフローのGitHub/GitLab連携       | 5          | 0   | 1   | [詳細](f33-workflow-forge.md)                                                 |
| F34:プログラムによる複数run統括           | 4          | 1   | 0   | [詳細](f34-program-runner.md)                                                 |
| F35:ワークフロー保存・中断後の復元        | 4          | 1   | 1   | [詳細](f35-run-restore.md)                                                    |
| F36:ワークフロー画面・メニュー            | 5          | 1   | 1   | [詳細](f36-workflow-view.md)                                                  |
| F37:Forge HubのIssue起点の開発            | 5          | 0   | 3   | [詳細](f37-forge-hub-issues.md)                                               |
| F38:Forge HubのPR・CI・レビュー・完了記録 | 5          | 0   | 1   | [詳細](f38-forge-hub-review.md)                                               |
| F39:作業記録・診断ログ                    | 5          | 1   | 0   | [詳細](f39-activity-logs.md)                                                  |
| F40:開発・配布・評価基盤                  | 4          | 0   | 1   | [詳細](f40-build-evaluation.md)                                               |

## 残る確認と制約

ユーザー申告の「途中で分岐するとエラー」は、[追加調査](f03-fork-error-investigation.md)へ失敗経路・原因候補・切り分け方を保存した。実際のエラー文、操作した位置、当時のCLIとセッション状態がないため、申告事象の原因は確定していない。

テスト・型チェック・lint・実VSCode操作・外部CLIとの実接続・リモート操作・VSIX作成・精度測定は実施していない。既存テストは根拠や不足箇所の確認に用いた参照で、合格を報告するものではない。コード修正・commit・push・Issue/MR作成も行っていない。

分岐の追加調査ではローカルCLIのバージョン確認とAPI型定義の生成、既存履歴のターンID形式・利用可能なログの読取を行った。会話本文や生ログは文書へ転記していない。CodeGraphの呼出関係と直接のソース読取を併用し、索引の外にある箇所は直接確認した。

[全件対応表](../feature-inventory-index.md)はsrcの242ファイル・公開コマンド45件・設定84件などの入口を40機能へ割り当てる。今回の完了は機能別の176項目を対象とし、全コード行・全実行経路・全テストの精査を意味しない。

成果物はdocs/feature-inventory.md、docs/feature-inventory-index.mdとdocs/reviews/に保存した。リンク先・確認項目数・指摘件数・最終差分を照合し、製品コードの変更がないことを確認した。

全関数・全分岐・全テスト内容の追加精査も完了。対象555/555ファイル、残0件。範囲・根拠・限界は[別台帳](exhaustive/README.md)、追加94指摘は[一覧](exhaustive/findings.md)へ保存した。上記116件は機能別レビューの集計であり、追加指摘を含まない。テスト実行・実機再現・修正は未実施。
