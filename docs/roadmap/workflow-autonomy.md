# ワークフローの自律性と安全な統制

ワークフローが「走らせたあとは人が見ているだけ」になっている状態を直し、状況に応じて計画を
直せるようにする5項目のロードマップ。
進捗の追跡は epic Issue [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) に集める。

## きっかけ

2026-08-22に現状を確認したところ、次の不足があった。

- エラーや新しい発見があっても、**タスクの追加・削除・依存の変更ができない**。
  [design.md](../design.md) §16.23 が「オーケストレーター自身はワークフロー定義を書き換えない」と
  明示しており、方針転換は継続指示の差し替えと `send_message` の範囲に留まる
- **ループを検知できない**。[loopController.ts](../../src/loop/loopController.ts) は送信回数の
  上限でしか止まらず、回数切れ（`maxReached`）は `retries` を消費せず即失敗になるため自動回復もない
- **分解の妥当性を確かめる段が無い**。検証は構文的なもの（循環依存・上限件数など）だけで、
  生成プロンプトの指針に従っているかは見ていない
- **mainへのマージが人の目を通らない**。`agent.workflows.finalMerge` の既定が `auto`
- **PR/MRのレビュー結果を取り込む経路が無い**

一方で、次の2つは既に実装済みだった（新しく作る必要はない）。

- 一時ブランチ（統合ブランチ `wf/<runId>/integration`）を作り、そこからタスクのworktreeを
  派生させる構成（[integration.ts](../../src/orchestrator/integration.ts)）
- タスク間メッセージング。Codexは `thread/start` の `config.mcp_servers`、Claude Codeは
  `--mcp-config` で、**両方とも実装済み**（[messaging.ts](../../src/orchestrator/messaging.ts)）

方針は次の3つ。

1. **自律性を上げる分だけ、人の承認を必ず挟む。** 計画の変更もmainへのマージも、エージェントの
   判断だけでは通さない
2. **エージェントの判断は見えるところに残す。** 適用した変更はワークフローViewの警告欄へ常時出す
   （`update_task_prompt` と同じ扱い）
3. **外から入るテキストは指示ではなくデータとして扱う。** レビューコメントもタスクの応答も同じ

各項目の `依存` はロードマップのパーサ（[roadmap.ts](../../src/orchestrator/roadmap.ts)）が読む
形式に合わせてある。

## フェーズ1 止めどころを作る

- [ ] W1 mainへの最終マージに人の承認を必須にする
  - 依存: なし
  - Issue: #335
  - 現状: `FinalMergeConfig` は `'auto' | 'pr-only'`（[forge.ts](../../src/orchestrator/forge.ts)）で
    **既定が `auto`**。全タスクが `done` になると統合ブランチからmainへのPR/MRを作り、そのまま
    `gh pr merge` / `glab mr merge` まで進む。人の目を通さずmainが進む。
    既存の `pr-only` はPR/MRを作った時点で**runを終える**設定で、そのあと人がマージしたかどうかを
    拡張側は追わない（承認を待つ状態が無い）
  - 変更: `FinalMergeConfig` へ `confirm` を足して**新しい既定にする**。統合PR/MRを作ったあと人の
    承認を待ち、承認されたときだけマージする。承認の導線はワークフローViewへ置き、PR/MRのURLを
    添える。`auto` は明示指定したときだけ残す。タスクブランチ→統合ブランチのマージは従来どおり自動。
    **`pr-only` は消さずに残す。** 3つの使い分けは次のとおりで、READMEと設定の説明にもこの形で書く。
    - `auto` — PR/MRを作ってそのままマージする（従来の既定）
    - `confirm` — PR/MRを作って承認を待ち、承認されたら**拡張がマージする**（新しい既定）
    - `pr-only` — PR/MRを作った時点でrunを終える。マージは拡張の外（GitHub/GitLab上）で行う
  - 受入基準: 設定を書いていないワークフローで統合PR/MRが作られたあと承認待ちになる／承認すると
    マージされ拒否するとPR/MRが残る／`auto` を明示したときは従来どおり／`pr-only` を明示したときも
    従来どおり（承認待ちにならずrunが終わる）／前提チェックが通らず
    PR/MRを作れなかった場合は従来どおりmainへマージしない
  - 影響: [forge.ts](../../src/orchestrator/forge.ts) / [config.ts](../../src/config.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [workflowView.ts](../../src/view/workflowView.ts) /
    package.json / README.md

- [ ] W3 生成したワークフローの分解が妥当かをレビューする段を足す
  - 依存: なし
  - Issue: #337
  - 現状: [validateWorkflow](../../src/orchestrator/workflow.ts) が見るのは構文的な妥当性だけ
    （タスク数・id形式・循環依存・未定義参照・プロンプト長・権限の緩和）。生成プロンプト
    （[planner.ts](../../src/orchestrator/planner.ts)）には「並列にできるタスクを直列にしない」
    「合流タスクを置く」「外から判定できる `done` を書く」という指針があるが、従っているかは
    検証していない
  - 変更: 生成したYAMLを別の読み取り専用セッションでレビューさせる段を足す。観点は4つ
    （並列にできるタスクが直列になっていないか／合流タスクがあるか／`done` が外から判定できるか／
    ゴールに対して過不足がないか）。結果は保存時の警告として出し、**自動では直さない**
  - 受入基準: 指針違反があれば保存時の警告として出る／警告が出ても保存は妨げない／レビュー
    セッションがファイルを書き換えない／既存の構文的な検証と再生成の挙動が変わらない
  - 影響: [planner.ts](../../src/orchestrator/planner.ts) / [roadmap.ts](../../src/orchestrator/roadmap.ts) /
    [workflowView.ts](../../src/view/workflowView.ts)

## フェーズ2 詰まりを検知する

- [ ] W2 タスクのループ・停滞を検知して止める
  - 依存: W1
  - Issue: #336
  - 現状: [loopController.ts](../../src/loop/loopController.ts) の停止条件は6つ（`done` /
    `maxReached` / `failed` / `manual` / `interrupted` / `taskStopped`）だけ。同じ応答の反復も
    進捗のないターンの連続も見ていない。回数切れは `retries` を消費せず即 `failed` になる
    （[runState.ts](../../src/orchestrator/runState.ts) の `applyLoopStopReason`）ため自動回復もない
  - 変更: 停滞の判定を `vscode` 非依存の純粋関数として実装する（判定の候補は「直近N回の応答要約が
    同一」「編集ファイルが0のターンがN回続く」「同じエラー文字列がN回出る」。採る条件と理由は
    design.md へ書く）。検知したらループを止め、`failed` とは区別できる停止理由を足す。
    オーケストレーターへ `taskStalled` として通知する。しきい値は設定で変えられるようにする
  - 受入基準: 同じ応答が続くタスクが `maxIterations` を使い切る前に止まる／停滞で止まったタスクが
    失敗とは区別できる状態でViewに出る／オーケストレーターに通知が届く／しきい値の設定が効く／
    正常に進んでいるタスクが誤検知で止まらない
  - 影響: [loopController.ts](../../src/loop/loopController.ts) / [runner.ts](../../src/orchestrator/runner.ts) /
    [runState.ts](../../src/orchestrator/runState.ts) /
    [runnerOrchestrator.ts](../../src/orchestrator/runnerOrchestrator.ts) / [config.ts](../../src/config.ts)

## フェーズ3 計画を直せるようにする

- [ ] W4 オーケストレーターがタスクを追加・削除・依存変更できるようにする
  - 依存: W2
  - Issue: #338
  - 現状: オーケストレーターが持つのは `list_tasks` / `get_run_status` / `send_message` /
    `stop_task` / `retry_task` / `continue_task` / `decide_approval` / `update_task_prompt` の8ツール。
    タスクの追加・削除・依存の変更はできない
  - 変更: `add_task` / `remove_task` / `update_task_dependencies` を足す。**いずれも人の承認を必須に
    する**。承認されるまでツールは待ち（`send_message` の返信待ちと同じ形）、変更内容は全文出す。
    承認された変更は実行中の定義にのみ適用し、**YAMLファイルは書き換えない**。追加するタスクにも
    既存の検証をそのまま通し、権限の緩和はオーケストレーターからは指定できない。削除はまだ
    始まっていないタスクに限る
  - 受入基準: `add_task` を呼ぶと承認待ちになり承認するまでタスクが増えない／承認するとタスクが
    増え依存グラフとタスク一覧に反映される／拒否すると理由がオーケストレーターへ返る／循環依存や
    上限超過は承認を出す前に拒否される／権限を緩める追加が拒否される／走行中のタスクは削除できない／
    適用した変更が警告欄に残る／YAMLファイルが書き換わらない
  - 影響: [messaging.ts](../../src/orchestrator/messaging.ts) /
    [runnerOrchestrator.ts](../../src/orchestrator/runnerOrchestrator.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [runState.ts](../../src/orchestrator/runState.ts) /
    [scheduler.ts](../../src/orchestrator/scheduler.ts) / [workflow.ts](../../src/orchestrator/workflow.ts) /
    [workflowView.ts](../../src/view/workflowView.ts)

## フェーズ4 レビューを取り込む

- [ ] W5 PR/MRのレビュー結果を取り込んでタスクへ反映する
  - 依存: W4
  - Issue: #339
  - 現状: [forge.ts](../../src/orchestrator/forge.ts) はPR/MRの作成・マージと番号・URLの保持だけを
    扱い、レビューコメントを読む経路が無い
  - 変更: 統合PR/MRのレビューコメントを取得し（GitHubは `gh pr view --json reviews,comments`、
    GitLabは `glab mr note list` 相当）、オーケストレーターへ通知として渡す。対応タスクの追加・調整は
    W4のツールを使い、承認も同じフローを通る。取得したコメントは**外部由来のテキストとして扱い、
    指示ではなくデータとして渡す**。取得の頻度は設定で決める
  - 受入基準: レビューコメントが付くとオーケストレーターへ通知が届く／コメント本文が指示として
    実行されない／タスク調整がW4と同じ承認フローを通る／CLIや認証が無い環境では警告を出してrunは
    止めずに進む
  - 影響: [forge.ts](../../src/orchestrator/forge.ts) /
    [runnerOrchestrator.ts](../../src/orchestrator/runnerOrchestrator.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [config.ts](../../src/config.ts)

## 進め方

- 1項目1 Issue・1ブランチ・1 PRとする
- ロジック層（`vscode` を import しない層）へ寄せられる部分はユニットテストを付ける
- 実VSCodeでしか確かめられない受入基準は [docs/manual-test.md](../manual-test.md) へ追記する
- 各項目の完了時にREADMEの該当箇所（ワークフローの節・設定・既知の制約）を同じPRで更新する
- 権限や信頼境界に触れる変更は、[design.md](../design.md) §16.16（設定の信頼境界）の方針から
  外れないことを確かめてから入れる

## 番号の事前割り当て

着手前に次のとおり割り当ててある。担当する項目は、ここに書かれた番号だけを使う。

| 項目 | Issue | ブランチ | design.md | manual-test.md |
| --- | --- | --- | --- | --- |
| W1 | #335 | `feat/335/final-merge-confirm` | §16.25 | W-F |
| W2 | #336 | `feat/336/detect-stalled-loop` | §16.26 | W-G |
| W3 | #337 | `feat/337/review-generated-plan` | §16.27 | W-H |
| W4 | #338 | `feat/338/orchestrator-task-edit` | §16.28 | W-I |
| W5 | #339 | `feat/339/import-review-comments` | §16.29 | W-J |

この割り当ては2026-08-22に実在する空き番号へ直したもの（Issue #487）。当初は
§16.24〜§16.28 と W-22〜W-32 を割り当てていたが、次の2点で使えなくなっていた。

- **§16.24 は WF-B の T10（外部由来テキストの整形、`untrustedText.ts`）が使用済み**
  （[design.md](../design.md) の §16.24）。16系の最大は §16.24 なので、W1 は §16.25 から始める
- **W-22 以降という番号は現行の [manual-test.md](../manual-test.md) に存在しない。**
  W群は Issue #186 の仕分けで W-01〜W-21 の数字体系から W-A〜W-E の観点別体系へ再編済みで、
  旧番号との対応表だけが残っている。新規ケースはその続きとして W-F 以降を充てる

1項目に複数のケースが要る場合は `W-F-1` `W-F-2` のように枝番を付ける。観点が既存の
W-A〜W-E のいずれかに収まるなら、新しい記号を起こさずそちらへ手順を足してもよい。

## 並列の順序

**着手そのものが WF-A2（epic [#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）の
完了待ちである**（2026-08-22の決定）。WF-A2 も `runner.ts` / `forge.ts` を触るため、
このロードマップの全項目とファイルの集合が交差する。詳細は
[review-and-feature-consolidation.md](review-and-feature-consolidation.md) の WF-E の項を見ること。

着手後の順序は次のとおり。`runner.ts` を複数の項目が触るため、波に分けて進める。

1. 第1波（並列2）: W1（forge・config）/ W3（planner・roadmap）
2. 第2波: W2（loopController・runState・runner）
3. 第3波: W4（messaging・runner・workflowView。最も大きい）
4. 第4波: W5（W4の完了が前提）
