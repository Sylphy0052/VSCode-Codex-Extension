# F29レビュー:worktree隔離・統合・片付け

対象commit:efd5cd67eb6a9b0a957538c9b5f981e2969875b6。[台帳](../feature-inventory.md#f29)の4項目を静的レビューした。

| 項目   | 確認内容                                                                                  |
| ------ | ----------------------------------------------------------------------------------------- |
| F29.01 | 識別子とSHAを検証し、直列キュー内で統合HEADを解決してworktreeを作成                       |
| F29.02 | 明示cwd、shared、git worktree、strict拒否、非git時の疑似複製の分岐を確認                  |
| F29.03 | 残った変更をcommitし、統合先の排他権を取得してmerge。競合は解消セッションか再マージへ移行 |
| F29.04 | done時の自動撤去、未コミット変更時の拒否、疑似反映の部分失敗と手動cleanupを確認           |

独立した新規指摘はなし。根拠:[worktree作成](../../src/orchestrator/worktree.ts#L620)、[cwd選択](../../src/orchestrator/runnerWorkingDirectory.ts#L91)、[統合の排他制御](../../src/orchestrator/integration.ts#L619)、[マージ](../../src/orchestrator/runnerMerge.ts#L374)、[cleanup](../../src/orchestrator/runner.ts#L2962)。

疑似worktreeはsymlinkを複製対象から外し、反映時も実パス・除外対象を検査する。元workspaceが変化した場合は反映を拒否し、一時ファイルからrenameする。途中失敗は適用済み・残件を返す。

[差分検出](../../src/orchestrator/pseudoWorktree.ts#L69)はサイズとmtimeのみで、内容ハッシュによる比較ではない。同じサイズ・mtimeの変更、探索中の外部変更、OS別のパス競合は実機未確認。これは隔離・保護の完全性を保証するレビューではない。

実装修正、テスト・型チェック・lint、実VSCode・外部CLI連携の検証は未実施。
