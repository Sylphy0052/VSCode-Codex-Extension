# WF-B 生成・安全系

第1波 土台の修正。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: 完了済み。記録として残す（追記しない）

- **WF-B 生成・安全系**（4項目）
  - T10 外部由来テキストの整形を1モジュールへ集約し、全プロンプト経路をそこへ通す
  - T15 ワークフロー生成（planner）の3件の不具合
  - T16 ロードマップMarkdownのパースを堅くする
  - T27 `slugifyGoal` の前処理にあるReDoSで長いゴール文がUIスレッドを止める（着手後に見つけて足した項目）
  - 依存: T15←T10 / T16←T10, T15 / T27←T15
  - ファイル: `src/orchestrator/workflow.ts`, `roadmap.ts`, `planner.ts`
