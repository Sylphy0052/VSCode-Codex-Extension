# WF-E ワークフローの自律性と安全な統制

第2波 機能の追加。

全体の骨格は
[review-and-feature-consolidation.md](../review-and-feature-consolidation.md)
を見ること。運用規約は [ops-rules.md](../ops-rules.md)、番号の割り当ては
[numbering.md](../numbering.md) にある。

書き手: **WF-Eの担当セッションだけが書く。**

- **WF-E ワークフローの自律性と安全な統制**（12項目、詳細は [workflow-autonomy.md](../workflow-autonomy.md)）
  - W1 mainへの最終マージをオーケストレーターが判断する（[#335](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/335)）
  - W2 タスクのループ・停滞を検知して止める（[#336](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/336)）
  - W3 生成したワークフローの分解が妥当かをレビューする段を足す（[#337](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/337)）
  - W4 オーケストレーターがタスクを追加・削除・依存変更できるようにする（[#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338)）
  - W5 PR/MRのレビュー結果を取り込んでタスクへ反映する（[#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339)）
  - W6 タスクごとにIssueを起票し、PRのレビューを経てマージする（後述。Issue [#596](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/596)）
  - W7 タスクからオーケストレーターへ判断を仰ぐ経路を作る（Issueは未起票）
  - W8 オーケストレーターからユーザーへ確認する経路を作る（Issueは未起票）
  - W9 タスク間の直接メッセージングを廃し、オーケストレーターの中継にする（Issueは未起票）
  - W10 中断からの自動再開（Issueは未起票）
  - W11 CIの完了待ちとブランチ保護への対応（Issueは未起票）
  - W12 runをまたぐ統括（Issueは未起票）
  - 依存: W2←W1 / W7←W9 / W8←W7 / W4←W2, W8 / W5←W4 / W6←W1 / W11←W1 /
    W12←W1, W7, W8, W9, W10
  - **W6〜W12 は2026-08-22に追加した**（Issue #497）。同日、この拡張のワークフロー機能を使わずに
    人手で7ワークフローを回した実運用から出た要求による。あわせてW1・W4の方針を
    「人の承認を必須にする」から「オーケストレーターが判断し、人への確認は最低限」へ転換した
  - 前提: WF-AとWF-Bの完了（`runner.ts` / `forge.ts` / `planner.ts` / `roadmap.ts` を共有する）。
    両者とも完了済み（2026-08-22、WF-A: PR #447 / WF-B: PR #429）
  - 事実: WF-A2（[#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）も
    `runner.ts`（例: #374 `WorkflowRunner.dispose()`）を触るため、WF-Eとファイルの集合が交差する。
    ワークフロー同士がファイルを共有しないという本ロードマップの並列規則に照らして判断すること
  - **決定: WF-EはWF-A2（#466）の完了を待つ**（2026-08-22）。上の交差があるため、
    並列規則に照らして順序を付けた。第2波はWF-Fのみ先に着手する
  - **申し送り**（2026-08-22、WF-B の担当から。着手時の起動プロンプトへ含めること）
    - **W6 が通すべき集約点の実体**。W6 は外部由来テキストの整形をT10の集約点へ通す前提であり、
      新規に整形処理を書き起こすと集約が崩れる。モジュールは
      [untrustedText.ts](../../../src/orchestrator/untrustedText.ts)、仕様は
      [design.md](../../design.md) §16.24。公開関数は
      `formatUntrusted(text, options)`（`options` は `{ id, field, maxLength, preserveNewlines?, nonce? }`。
      nonce は省略時に `randomUUID()`。**1回の展開で複数フィールドを囲む場合は呼び出し側が
      同じ nonce を明示的に渡す**）、`sanitizeInlineText(text, maxLength)`（一覧の要素向け）、
      `truncateByCodePoint(...)`（サロゲートペアを割らない切り詰め）
    - **使い分けは2系統ある。** プロンプトへ渡す経路は `formatUntrusted`、ログへ出す経路は
      `sanitizeForLog`（Trojan Source / bidi制御文字対策）。取り違えないこと
    - **`runner.ts` にロードマップ警告のログ出力6行がある。** WF-A のファイルだが、T16 の警告を
      人へ見せる出口として必要だったため**ユーザーの承認を得た例外**として残してある（Issue #408）。
      不審に見えても消さないこと。行番号は main が進んで当てにならないので識別子で探す

## W6 タスクごとにIssueを起票し、PRのレビューを経てマージする

- 依存: W1
- Issue: [#596](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/596)
- 現状: **タスクごとのPR作成は既に実装されている。** `agent.workflows.pullRequest` の既定が
  `per-task` で（[config.ts](../../../src/config.ts) の `normalizePullRequestLayerConfig`）、
  [runnerMerge.ts](../../../src/orchestrator/runnerMerge.ts) が
  `shouldCreateTaskPullRequest` を見て
  [forge.ts](../../../src/orchestrator/forge.ts) の `runTaskPullRequestFlow` を回す。その段取りは
  「タスクブランチをpush → 統合ブランチをpush → PRを作る → ローカルでマージして統合ブランチをpush →
  PRをready化」である。PR作成時の宛先ブランチも引数（`baseBranch`）で受け取っている。
  無いのは次の2つだけ。
  - **タスクごとのIssue起票**（`gh issue create` を呼ぶ経路が `src` 配下に無い）
  - **PRのレビューを経てからマージする段**（PRは記録として残すだけで、マージはローカルで行うため、
    PR上のレビューを待つ余地が無い）
- 変更: 上の2点だけを足す。既にある `per-task` のフローを作り直さない。
  - (a) タスクの開始時にIssueを起票し、PR本文から参照する。Issue本文はタスクの `prompt` と `done`
    から組み立て、外部由来テキストはT10で集約するサニタイズを通す
  - (b) PRを作ったあと、ローカルマージの前にレビューを1段挟む。レビューの実施主体
    （別セッションを立てるのか、forgeのレビュー機能を使うのか）は実装時に決めて design.md へ残す
  - どちらも設定で切り替えられるようにし、既定をどちらにするかは実装時に決めて design.md へ残す
- 受入基準: タスクの開始でIssueが起票されPR本文から参照される／PRがレビューを経てからマージされる／
  Issueを起票できない環境（CLIや認証が無い）では警告を出して従来どおり進み、runは止まらない／
  設定で従来の挙動へ戻せる／`per-task` 以外（`none` / `integration`）を選んだときの挙動が変わらない
- 影響: [forge.ts](../../../src/orchestrator/forge.ts) /
  [runnerMerge.ts](../../../src/orchestrator/runnerMerge.ts) /
  [runner.ts](../../../src/orchestrator/runner.ts) /
  [config.ts](../../../src/config.ts) / [workflowView.ts](../../../src/view/workflowView.ts)
