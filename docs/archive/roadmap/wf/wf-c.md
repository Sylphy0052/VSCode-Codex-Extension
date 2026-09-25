# WF-C チャットUIの土台

第1波 土台の修正。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: 完了済み。記録として残す（追記しない）

- **WF-C チャットUIの土台**（9項目）
  - T05 app-server接続の初期化失敗・接続断で待機中のPromiseが解放されない
  - T06 Claude CLIの異常終了で応答待ちのPromiseが解放されず永久ハングする
  - T11 Claude側の `postState` に間引きが無い
  - T12 未使用の `AgentProvider.buildLaunch` 経路の整理
  - T17 ストリーム受信とプロセス終了の頑健性
  - T18 View層の軽微な2件（`controlPanelView` の参照クリア・CSPの集約）
  - T22 `chatView.ts` の破壊的操作系へのテスト追加（実装は変更しない）
  - T23 `chatView.ts` からプロバイダ非依存の共有ユーティリティを抽出
  - T24 `ChatViewManager` と `ClaudeChatViewManager` の重複を基底クラスへ抽出
  - 依存: T17←T05, T06 / T23←T11, T22 / T24←T23
  - ファイル: `src/appserver/*`, `src/claude/*`, `src/codex/*`, `src/provider/types.ts`,
    `src/util/ndjson.ts`, `src/view/chat*.ts`, `src/view/controlPanelView.ts`, `src/view/conversationView.ts`
