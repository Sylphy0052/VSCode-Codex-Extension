# WF-A オーケストレーター実行系

第1波 土台の修正。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: 完了済み。記録として残す（追記しない）

- **WF-A オーケストレーター実行系**（11項目）
  - T02 `waitingReply` のタスクがターン失敗時に確定せず並列枠を占有する
  - T03 `WorkflowRunner.dispose()` がどこからも呼ばれない
  - T04 再試行時のworktree撤去が誤ったディレクトリを対象にする
  - T07 疑似worktreeの統合・反映で未ハンドルrejectが起き `merging` のまま枠を占有する
  - T08 「全体の停止」が衝突解決セッションを止めない／永続化の時点ずれ
  - T09 PR/MR操作の2件の不具合
  - T13 リロード復元後に統合成果がワークスペースへ届かない
  - T14 タスク間メッセージングの4件の不具合
  - T19 セッション一覧まわりの性能とキャッシュの3件
  - T20 オーケストレーターの警告が無制限に増える
  - T21 統合worktreeの排他制御の調査と修正
  - 依存: T08←T07 / T19←T03 / T21←T04, T13
  - ファイル: `src/orchestrator/runner*.ts`, `loopController.ts`, `runState.ts`, `forge.ts`,
    `integration.ts`, `pseudoWorktree.ts`, `messaging.ts`, `scheduler.ts`, `src/extension.ts`,
    `src/session/*`, `src/claude/sessionStore.ts`, `src/util/paths.ts`, `src/codex/cliLocator.ts`
