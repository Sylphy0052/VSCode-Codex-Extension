# ワークフローの自律性と安全な統制

書き手: **WF-Eの担当セッションだけが書く。** この文書が WF-E の書き場である
（[review-and-feature-consolidation.md](review-and-feature-consolidation.md) の
「docs/roadmap/ の5本の関係」を参照）。運用規約は [ops-rules.md](ops-rules.md)、
番号の割り当ては [numbering.md](numbering.md) にある。

ワークフローが「走らせたあとは人が見ているだけ」になっている状態を直し、オーケストレーターが
状況に応じて判断・進行できるようにする12項目のロードマップ。
進捗の追跡は epic Issue [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) に集める。

**2026-08-22にW6〜W12を追加し、W1・W4の方針を転換した**（Issue #497）。同日、この拡張の
ワークフロー機能を使わずに人手で7ワークフローを回した実運用から要求が出たため。当初の
「自律性を上げる分だけ人の承認を必ず挟む」という方針は、「判断するのはオーケストレーターで
あって人ではない。人へ確認するのは最低限」へ置き換わっている。詳しくは下の「方針」を見ること。

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

2026-08-22に人手で7ワークフローを回した実運用から、さらに次の不足が分かった（W6〜W12）。

- **タスク同士が直接メッセージを送り合う**（メッシュ型）。オーケストレーターは中継に関与せず、
  誰が何を伝えたかを知らない
- **タスクからオーケストレーターへ判断を仰ぐ経路が無い**。行き詰まったタスクは
  `maxIterations` を消費するか、`done` を満たさないまま終わるしかない
- **オーケストレーターからユーザーへ確認する経路が無い**
- **中断から自動で再開しない**。リロード後の復元はあるが、続きを走らせるには人が
  「再実行」を押す必要がある
- **CIの結果を見ずにマージする**。`pr update-branch` 相当も無いため、strictなブランチ保護の
  下では2本目以降のPRが必ず詰まる
- **runをまたぐ統括が無い**。1 run = 1ワークフローで、複数ワークフローを波に分ける進め方を
  表現できない

一方で、次の2つは既に実装済みだった（新しく作る必要はない）。

- 一時ブランチ（統合ブランチ `wf/<runId>/integration`）を作り、そこからタスクのworktreeを
  派生させる構成（[integration.ts](../../src/orchestrator/integration.ts)）
- タスク間メッセージング。Codexは `thread/start` の `config.mcp_servers`、Claude Codeは
  `--mcp-config` で、**両方とも実装済み**（[messaging.ts](../../src/orchestrator/messaging.ts)）

方針は次の5つ。**1と2は2026-08-22に人手で7ワークフローを回した実運用から出た要求で、
当初の「人の承認を必ず挟む」という方針を置き換えている。**

1. **判断するのはオーケストレーターであって人ではない。** mainへのマージも計画の変更も
   オーケストレーターが決める。**人へ確認するのは最低限**に留め、方針が変わるとき
   （担当領域をまたぐ・設計の前提を変える・受入基準を下げる）だけ上げる
2. **やりとりは必ずオーケストレーターを通す。** タスク同士は直接つながらない。
   人 ←→ オーケストレーター ←→ タスク の3層に固定する（スター型）
3. **エージェントの判断は見えるところに残す。** 適用した変更はワークフローViewの警告欄へ常時出す
   （`update_task_prompt` と同じ扱い）。承認を挟まない分、記録が唯一の追跡手段になる
4. **外から入るテキストは指示ではなくデータとして扱う。** レビューコメントもタスクの応答も同じ
5. **providerを問わない。** ここで足す道具はすべてMCPサーバのツールとして実装し、Codexと
   Claude Codeの双方へ同じ形で配る。[design.md](../design.md) §16.22 のとおり、Codexは
   `thread/start` の `config.mcp_servers`、Claude Codeは `--mcp-config` で渡せることが
   実測で確認済み（Issue #123）。**Claude Codeのセッション間メッセージングのような
   provider固有の機能には依存しない**（Codexで再現できないため）

各項目の `依存` はロードマップのパーサ（[roadmap.ts](../../src/orchestrator/roadmap.ts)）が読む
形式に合わせてある。

## フェーズ1 止めどころを作る

- [x] W1 mainへの最終マージをオーケストレーターが判断する
  - 依存: なし
  - Issue: #335
  - 現状: `FinalMergeConfig` は `'auto' | 'pr-only'`（[forge.ts](../../src/orchestrator/forge.ts)）で
    **既定が `auto`**。全タスクが `done` になると統合ブランチからmainへのPR/MRを作り、そのまま
    `gh pr merge` / `glab mr merge` まで進む。人の目を通さずmainが進む。
    既存の `pr-only` はPR/MRを作った時点で**runを終える**設定で、そのあと人がマージしたかどうかを
    拡張側は追わない（承認を待つ状態が無い）
  - 変更: `FinalMergeConfig` へ `orchestrator` を足して**新しい既定にする**。統合PR/MRを作った
    あと、マージするかどうかをオーケストレーターへ問う。オーケストレーターは差分・CIの結果・
    残った警告を見て `merge` か `hold` を返す。`hold` を返した場合はPR/MRを残してrunを終え、
    理由をワークフローViewへ出す。**人の承認は挟まない**（方針1）。判断の内容と理由は
    警告欄へ必ず残す（方針3）。タスクブランチ→統合ブランチのマージは従来どおり自動。
    **`auto` と `pr-only` は消さずに残す。** 4つの使い分けは次のとおりで、READMEと設定の
    説明にもこの形で書く。
    - `auto` — PR/MRを作ってそのままマージする（従来の既定）
    - `orchestrator` — PR/MRを作り、オーケストレーターの判断でマージする（新しい既定）
    - `confirm` — PR/MRを作って人の承認を待ち、承認されたときだけマージする
    - `pr-only` — PR/MRを作った時点でrunを終える。マージは拡張の外（GitHub/GitLab上）で行う
  - 補足: `confirm` も同時に実装して残す。人が必ず見る運用を選べる余地は要る（この設定を
    既定にしないだけで、選択肢としては消さない）
  - 受入基準: 設定を書いていないワークフローで統合PR/MRが作られたあとオーケストレーターへ
    判断が渡る／`merge` を返すとマージされる／`hold` を返すとPR/MRが残りrunが終わる／
    どちらの判断も理由つきで警告欄に残る／`auto` `confirm` `pr-only` を明示したときは
    それぞれの挙動になる／前提チェックが通らずPR/MRを作れなかった場合は従来どおり
    mainへマージしない／**オーケストレーターが応答しない場合は `hold` として扱う**
    （判断を待って無限に止まらない）
  - 影響: [forge.ts](../../src/orchestrator/forge.ts) / [config.ts](../../src/config.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [workflowView.ts](../../src/view/workflowView.ts) /
    package.json / README.md

- [x] W3 生成したワークフローの分解が妥当かをレビューする段を足す
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

- [x] W2 タスクのループ・停滞を検知して止める
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

- [x] W4 オーケストレーターがタスクを追加・削除・依存変更できるようにする
  - 依存: W2, W8
  - Issue: [#338](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/338)
  - 現状: オーケストレーターが持つのは `list_tasks` / `get_run_status` / `send_message` /
    `stop_task` / `retry_task` / `continue_task` / `decide_approval` / `update_task_prompt` の8ツール。
    タスクの追加・削除・依存の変更はできない
  - 変更: `add_task` / `remove_task` / `update_task_dependencies` を足す。**人の承認は挟まず、
    オーケストレーターの判断で適用する**（方針1）。ただし次の3つは変わらない。
    - 適用先は実行中の定義だけで、**YAMLファイルは書き換えない**
    - 追加するタスクにも既存の検証をそのまま通す。**権限の緩和はオーケストレーターからは
      指定できない**（ここだけは判断に委ねない。緩和は必ず人が書いた定義から来る）
    - 削除はまだ始まっていないタスクに限る

    適用した変更は**全文を警告欄へ残す**（方針3）。承認を挟まない以上、記録が唯一の追跡手段になる。
    **方針が変わる変更だけはユーザーへ上げる**（W8の `ask_user` を使う。担当領域をまたぐ・
    設計の前提を変える・受入基準を下げる場合が該当する）
  - 受入基準: `add_task` でタスクが増え依存グラフとタスク一覧に反映される／循環依存や上限超過は
    適用前に拒否され理由がオーケストレーターへ返る／権限を緩める追加が拒否される／走行中の
    タスクは削除できない／適用した変更が全文で警告欄に残る／YAMLファイルが書き換わらない
  - 影響: [messaging.ts](../../src/orchestrator/messaging.ts) /
    [runnerOrchestrator.ts](../../src/orchestrator/runnerOrchestrator.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [runState.ts](../../src/orchestrator/runState.ts) /
    [scheduler.ts](../../src/orchestrator/scheduler.ts) / [workflow.ts](../../src/orchestrator/workflow.ts) /
    [workflowView.ts](../../src/view/workflowView.ts)

## フェーズ4 レビューを取り込む

- [x] W5 PR/MRのレビュー結果を取り込んでタスクへ反映する
  - 依存: W4
  - Issue: [#339](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/339)
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

## フェーズ5 やりとりをオーケストレーターへ集約する

2026-08-22の実運用で出た要求（方針1・2）を満たすための3項目。**現行のタスク間メッセージングは
タスク同士が直接つながるメッシュ型で、方針2に反している。** ここを作り替える。

- [x] W9 タスク間の直接メッセージングを廃し、オーケストレーターの中継にする（Issue [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547)）
  - 依存: なし
  - Issue: [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547)
  - 現状: `send_message` の宛先は「同じrunのタスク」に限られ（[messaging.ts](../../src/orchestrator/messaging.ts)
    の `knownTaskIds` 判定）、タスクからタスクへ直接届く。オーケストレーターは中継に関与せず、
    どのタスクが何を伝えたのかを知らない。タスクが n 個あれば経路は n×(n-1) 本になる
  - 変更: タスクが持つ `send_message` の宛先を**オーケストレーターに固定する**。タスク宛の指定は
    受け付けない。オーケストレーターは受け取った内容を見て、必要なら自分の `send_message`
    （宛先にタスクidを取れる既存のもの）で転送する。**転送するかどうか、内容を変えるかどうかは
    オーケストレーターが決める**。中継した内容は往復ともワークフローViewへ残す
  - 補足: これは機能の削減ではなく経路の集約である。タスクAがタスクBへ伝えたい情報は、
    オーケストレーターを経由して届く。かわりに、オーケストレーターが全ての伝達内容を見られる
  - 受入基準: タスクからタスクへ直接メッセージが届かない／タスクが宛先にタスクidを書くと拒否され
    理由が返る／オーケストレーターが転送するとタスクへ届く／往復の内容がViewへ残る／
    `expectReply` の返信待ち（`waitingReply`）が中継を挟んでも成立する／自己宛の拒否は従来どおり
  - 影響: [messaging.ts](../../src/orchestrator/messaging.ts) /
    [runnerMessaging.ts](../../src/orchestrator/runnerMessaging.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [workflowView.ts](../../src/view/workflowView.ts) /
    [design.md](../design.md) §16.21

- [x] W7 タスクからオーケストレーターへ判断を仰ぐ経路を作る
  - 依存: W9
  - Issue: [#571](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/571)
  - 現状: タスクがオーケストレーターへ能動的に判断を仰ぐ道具が無い。`decide_approval` は
    **承認要求（コマンド実行やファイル変更）に対してオーケストレーターが裁く**ための道具であって、
    タスクが「この方針でよいか」と問う経路ではない。いまタスクにできるのは、行き詰まったまま
    `maxIterations` を消費するか、`done` を満たさないまま終わるかのどちらか
  - 変更: タスク側のツールとして `ask_orchestrator` を足す。問い（本文）と、答えが来るまで
    待つかどうか（`blocking`）を取る。`blocking: true` ならタスクは `waitingReply` へ入り、
    答えが来たら次のターンのプロンプトへ差し込まれる（`composeNextPrompt` と同じ形）。
    オーケストレーター側には問いが通知として届き、既存の `send_message` で答える。
    **答えられない問いはW8でユーザーへ上げる**
  - 受入基準: `ask_orchestrator` を呼ぶとオーケストレーターへ届く／`blocking: true` のタスクが
    `waitingReply` になり答えが来ると再開する／`blocking: false` なら待たずに進む／問いと答えの
    両方がViewへ残る／答えが来ないまま `maxIterations` に達した場合はタスクが失敗として確定する
    （返事待ちで枠を占有し続けない）／問いの本文は外部由来テキストとして扱われる
  - 影響: [messaging.ts](../../src/orchestrator/messaging.ts) /
    [runnerMessaging.ts](../../src/orchestrator/runnerMessaging.ts) /
    [runState.ts](../../src/orchestrator/runState.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) / [workflowView.ts](../../src/view/workflowView.ts)

- [x] W8 オーケストレーターからユーザーへ確認する経路を作る
  - 依存: W7
  - Issue: [#583](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/583)
  - 現状: オーケストレーターが持つ8つのツールに、人へ問う道具が無い。`decide_approval` は
    **人の代わりにオーケストレーターが裁く**方向の道具で、向きが逆である
  - 変更: `ask_user` を足す。問いと選択肢（2〜4個）を取り、ワークフローViewへ出す。人が選ぶまで
    オーケストレーターは待つ。**呼べる条件を絞る**（方針1「確認は最低限」）。使ってよいのは
    次の場合に限り、それ以外で呼んだら拒否して理由を返す。
    - 担当領域をまたぐ変更（他のワークフローへ影響する）
    - 設計の前提を変える変更
    - 受入基準を下げる判断
    - 同じ失敗を3回繰り返して打つ手が尽きた場合
  - 補足: 「最低限」を仕組みで担保する。**1つのrunで呼べる回数に上限を設ける**（既定3回、設定で
    変更可）。上限に達したあとの `ask_user` は拒否し、オーケストレーターへ「自分で判断するか
    `hold` で止めよ」と返す。乱発を設定ではなく既定の挙動で抑える
  - 受入基準: `ask_user` を呼ぶとViewへ問いと選択肢が出る／人が選ぶまでオーケストレーターが待つ／
    選んだ結果がオーケストレーターへ返る／上限を超えた呼び出しが拒否される／人が答えないまま
    runを閉じた場合もrunの状態が壊れない（永続化して再開時に問い直す。W10と組み合わせる）／
    問いの本文は外部由来テキストとして扱われる
  - 影響: [messaging.ts](../../src/orchestrator/messaging.ts) /
    [runnerOrchestrator.ts](../../src/orchestrator/runnerOrchestrator.ts) /
    [runState.ts](../../src/orchestrator/runState.ts) /
    [runStore.ts](../../src/orchestrator/runStore.ts) /
    [workflowView.ts](../../src/view/workflowView.ts) / [config.ts](../../src/config.ts)

## フェーズ6 落ちても続くようにする

- [x] W10 中断からの自動再開
  - 依存: W8（受入基準の「`ask_user` 待ちだったrunは問いを出し直す」を満たすため。
    **初版はここを「なし」と書いていたが、同じ項目の補足と受入基準がW8を要求しており
    矛盾していた**。Issue [#586](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/586)
    で修正）
  - Issue: [#584](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/584)
  - 現状: リロード後の復元は実装済みで（[runnerRestore.ts](../../src/orchestrator/runnerRestore.ts)、
    design.md §16.11）、`workspaceState` に残ったrunをメモリへ戻し、`merging` で切れたものは
    マージからやり直す。**ただし復元したrunは自動では進まない。** 走行中だったタスクは中断扱いへ
    倒され、そこから先は人がワークフローViewで「再実行」を押す必要がある。VSCodeのリロードは
    もちろん、WSLごと止めた場合も同じ
  - 変更: 復元したrunを**自動で続きから走らせる**。中断扱いになったタスクを `pending` へ戻して
    スケジューラへ載せ直す。オーケストレーターセッションも復元して立て直す。
    **無条件には再開しない。** 次を満たすときだけ自動で進める。
    - runが人の手で止められていない（`haltedByUser` が立っていない）
    - 再開の試行回数が上限内（同じrunが起動のたびに再開を繰り返して壊れ続けるのを防ぐ）
    - 定義ファイルが読めて検証を通る（従来どおり。通らなければ復元だけして止める）
    自動再開したことと、どのタスクを `pending` へ戻したかはViewへ残す。設定
    `agent.workflows.autoResume`（既定 `true`）で切れるようにする
  - 補足: **W8の `ask_user` 待ちで落ちた場合は、再開時に問いを出し直す。** 人の答えを永続化の
    対象に含める
  - 受入基準: VSCodeをリロードするとrunが自動で続きから進む／WSLを止めて起動し直しても同じ／
    人が止めたrunは自動再開しない／`autoResume: false` で従来どおり手動再開になる／
    再開の試行が上限を超えたrunは止まったままになり理由がViewへ出る／再開したタスクが
    worktreeを二重に作らない／`ask_user` 待ちだったrunは問いを出し直す
  - 影響: [runnerRestore.ts](../../src/orchestrator/runnerRestore.ts) /
    [runStore.ts](../../src/orchestrator/runStore.ts) /
    [runState.ts](../../src/orchestrator/runState.ts) /
    [runner.ts](../../src/orchestrator/runner.ts) /
    [scheduler.ts](../../src/orchestrator/scheduler.ts) / [config.ts](../../src/config.ts) /
    [design.md](../design.md) §16.11

- [x] W11 CIの完了待ちとブランチ保護への対応
  - 依存: なし
  - Issue: [#556](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/556)
  - 現状: [forge.ts](../../src/orchestrator/forge.ts) が呼ぶGitHub/GitLabの操作は
    `pr create` / `pr merge` / `pr ready` の3つだけ。**CIの結果を見ずにマージする。**
    また `pr update-branch` 相当が無い
  - 変更: 2つ足す。
    - **CIの完了を待つ。** PRを作ったあと `gh pr view --json statusCheckRollup` 相当で
      チェックの完了を待ち、赤ならマージせずタスクを失敗として確定する（理由つき）。
      待ち時間の上限を設定で持ち、超えたら赤と同じ扱いにする
    - **baseの取り込み直しに対応する。** マージが「baseの最新でない」ことで拒否された場合、
      `gh pr update-branch` 相当を実行してCIの再実行を待ち、もう一度マージする。
      リトライ回数の上限を持つ
  - 根拠: 2026-08-22、mainにブランチ保護（PR必須・`checks` 必須・**strict**）を入れた直後に、
    PR #481 のマージで PR #482 が `not up to date with the base branch` になり詰まった。
    **strictなブランチ保護の下では、mainへ1本マージするたびに他の全てのopen PRが古くなる。**
    統合ブランチからmainへ複数のPRを順に出す運用では必ず起きる
  - 受入基準: CIが緑になるまでマージしない／赤ならマージせずタスクが失敗で確定する／
    待ち時間の上限を超えたら赤と同じ扱いになる／`not up to date` で拒否されたら取り込み直して
    再試行する／再試行の上限を超えたら失敗として確定する／CIが設定されていないリポジトリでは
    従来どおり即マージする（チェックが0件なのと赤なのを取り違えない）
  - 影響: [forge.ts](../../src/orchestrator/forge.ts) /
    [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) /
    [config.ts](../../src/config.ts) / README.md

## フェーズ7 複数のワークフローを束ねる

- [ ] W12 runをまたぐ統括
  - 依存: W1, W7, W8, W9, W10
  - Issue: 未起票（着手時に起票する）
  - 現状: **1 run = 1ワークフロー**で、runの上に層が無い。ロードマップからの生成も
    「選べるのはフェーズ単位のみ」（design.md §16.19）。複数のワークフローを波に分けて、
    波の内側は並列・波をまたぐと逐次、という進め方を拡張機能では表現できない
  - 変更: runの上に**プログラム**（複数runの束）を置く。プログラムは次を持つ。
    - run の一覧と、run 同士の依存（「WF-Eは WF-A2 の完了を待つ」）
    - 波の概念（依存の無いrunを同時に走らせ、依存があるものは前段の完了を待つ）
    - プログラム全体の状態と、その永続化（W10の自動再開の対象に含める）
    上位のオーケストレーター（プログラムのオーケストレーター）は置かない。**各runの
    オーケストレーターが自分のrunだけを見る構成のまま、runの起動順をプログラムが決める**
  - 補足: これは2026-08-22に人手で回した7ワークフロー・3波の運用そのものにあたる。
    **他の項目より大きく、他の項目が無いと意味を成さない**ため最後に置く。着手時に
    分割し直すことを見込んでおく
  - 受入基準: 複数のrunを1つのプログラムとして定義できる／依存の無いrunが同時に走る／
    依存のあるrunが前段の完了を待つ／前段が失敗したとき後段が走らない／プログラムの状態が
    永続化され、リロードやWSLの停止をまたいでも続きから進む／プログラムを人の手で止められる
  - 影響: `src/orchestrator/` 全域 / [workflowView.ts](../../src/view/workflowView.ts) /
    [config.ts](../../src/config.ts) / [design.md](../design.md)

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
| W1 | #335 | `feat/335/final-merge-confirm` | §16.26 | W-F |
| W2 | #336 | `feat/336/detect-stalled-loop` | §16.27 | W-G |
| W3 | #337 | `feat/337/review-generated-plan` | §16.28 | W-H |
| W4 | #338 | `feat/338/orchestrator-task-edit` | §16.29 | W-I |
| W5 | #339 | `feat/339/import-review-comments` | §16.30 | W-J |
| W6 | [#596](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/596) | `feat/596/task-issue-and-review` | §16.31 | W-K |
| W7 | [#571](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/571) | `feat/571/ask-orchestrator` | §16.32 | W-L |
| W8 | [#583](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/583) | `feat/583/ask-user` | §16.33 | W-M |
| W9 | [#547](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/547) | `refactor/547/messaging-via-orchestrator` | §16.34 | W-N |
| W10 | [#584](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/584) | `feat/584/auto-resume` | §16.35 | W-O |
| W11 | [#556](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/556) | `feat/556/ci-wait-and-update-branch` | §16.36 | W-P |
| W12 | 未起票 | `feat/<IID>/program-of-runs` | §16.37 | W-Q |

W6〜W12 は2026-08-22に追加した項目（Issue #497）。**W6 の定義もこのファイルの末尾へ
移した**（Issue #613。もとは `review-and-feature-consolidation.md` の「W6」の節にあり、
このファイルには番号の割り当てだけを置いていた。ロードマップの分割で
`wf/wf-e.md` へ動いたが、WF-E の書き場はこのファイルなので二重管理になっていた）。
W7〜W12 の定義はこのファイルのフェーズ5〜7にある。

### 着手前に必ず実測する

**この表の番号は、書いた時点の写しでしかない。着手前に実測して、ずれていたら実装より先に表を直す**
（実装後に気づくと採番のやり直しになる）。

```
grep -nE '^### 16\.[0-9]+' docs/design.md      # 16系の最大値と空きを見る
grep -nE '^### W-' docs/manual-test.md          # W群の体系を見る
```

**このファイルには棚が3か所ある。epic Issue のチェックリストを入れると4か所である。**
Issueを起票したら、**同じ操作で4か所すべてへ番号を書き込む。**

1. **割当表**の該当行（`| W9 | … |`）
2. **フェーズのチェックリスト行**（`- [ ] W9 …`）
3. **フェーズ本文の `Issue:` 行**（`  - Issue: …`）
4. **epic [#341](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/341) の
   チェックリスト**

書き漏らしは次で数えられる。**実際に未起票の項目だけが並ぶはずで、それ以外が出たら漏れである。**

```
grep -n '未起票' docs/roadmap/workflow-autonomy.md
```

片方だけ更新されると、もう片方を読んだ担当が「未起票」と判断して二重に起票する。
**2026-08-23 に W9 で2回続けて起きた。** 1回目は Issue #547 が epic のチェックリストへは
入ったが割当表に無かった（PR #555 で修正）。2回目は、その修正で1と2は入ったのに
**3（フェーズ本文の `Issue:` 行）が残っていた**（PR #557 で W11 の同じ行を直したときにも
気づかれず、W9 だけ残った）。**「棚は2か所」と書いた文書の同じ節に、3か所目が実在していた。**
数えたつもりで数え足りない、という形なので、上の grep で機械的に確認する。

事前割り当ては「並列で作業しても採番が衝突しないこと」だけを保証する仕組みで、
**その後に起きる採番や体系の変更には追随しない**。実際、この表は3回腐っている。

- **2026-08-22（Issue #487）**: W1 へ割り当てた §16.24 を、WF-B の T10
  （外部由来テキストの整形、`untrustedText.ts`）が先に使っていた
- **2026-08-22（同）**: W1〜W5 へ割り当てた `manual-test.md` の W-22〜W-32 が、
  Issue #186 の仕分けで W-A〜W-E の体系へ再編されて存在しなくなっていた
- **2026-08-23（Issue #543）**: W1 へ割り当てた §16.25 を、PR #542（WF-A2統合）の
  §16.25「無効なテストの一般則」が先に使った

3回目の解消では **実物のほうを正とし、予約表を §16.26〜§16.37 へずらした**。
PR #542 の時点で design.md の実在する最大は §16.24 で、その直後を §16.25 が取るのは自然であり、
予約は実体のない紙の上の数字だからである。**表をずらしたときは、子Issue
（#335〜#339）の本文に書かれた番号も同じPRで直す。** 表だけ直すと本文の数字が誤ったまま残り、
次の担当が本文を先に読む（#487 でこれが起きた）。

### 割り当ての由来

この割り当ては2026-08-22に実在する空き番号へ直したもの（Issue #487）。当初は
§16.24〜§16.28 と W-22〜W-32 を割り当てていた。

- **§16.24 は WF-B の T10（外部由来テキストの整形、`untrustedText.ts`）が使用済み**
  （[design.md](../design.md) の §16.24）
- **W-22 以降という番号は現行の [manual-test.md](../manual-test.md) に存在しない。**
  W群は Issue #186 の仕分けで W-01〜W-21 の数字体系から W-A〜W-E の観点別体系へ再編済みで、
  旧番号との対応表だけが残っている。新規ケースはその続きとして W-F 以降を充てる

1項目に複数のケースが要る場合は `W-F-1` `W-F-2` のように枝番を付ける。観点が既存の
W-A〜W-E のいずれかに収まるなら、新しい記号を起こさずそちらへ手順を足してもよい。

## 並列の順序

**着手可能**（2026-08-23）。着手を待たせていた WF-A2（epic
[#466](https://github.com/Sylphy0052/VSCode-Codex-Extension/issues/466)）は
PR [#542](https://github.com/Sylphy0052/VSCode-Codex-Extension/pull/542) で完了し、
`runner.ts` / `forge.ts` の交差が解けた。統合ブランチ `wf/wf-a2/integration` も削除済み。

着手後の順序は次のとおり。`runner.ts` と `messaging.ts` を複数の項目が触るため、波に分けて進める。

1. **第1波（並列4）: 完了**（2026-08-23）。W1（forge・config）/ W3（planner・roadmap）/ W9（messaging）/ W11（forge）
   - W1 と W11 はどちらも `forge.ts` を触るため、この2つだけは逐次にした（W1 → W11）
   - **交差は着手して初めて分かった。** W1 と W3 は影響欄に無い `extension.ts` を両方が触り、
     W9 と W11 はどちらも `test/integration/helpers/workflow.ts` を触った。
     後者は統合ブランチ上で衝突し、同じ位置に別の節を挿す形（design.md §16.34/§16.36、
     manual-test.md W-N/W-P）だったため両方残して解決している
   - **W11 の担当が、W1 のガードが `finalMerge: auto` の経路を取り逃していたこと**
     （`decideFinalMerge` を経由せず `performFinalMerge` へ直行する）**を見つけて塞いだ。**
     W1 の中だけを見ていては見つからない形で、「同じクラスの穴が兄弟にもないか」を
     毎回確かめる運用がそのまま効いた
2. 第2波（並列2）: W2（loopController・runState・runner）/ W7（messaging。W9の完了が前提）
3. 第3波: W8（W7の完了が前提）→ W10（runnerRestore・runStore・scheduler。**W8の完了が前提**。
   受入基準に `ask_user` 待ちからの再問いが含まれるため、この2つは並列にしない）
4. 第4波: W4（messaging・runner・workflowView。W2とW8の完了が前提。最も大きい）
5. 第5波: W5（W4の完了が前提）/ W6（W1の完了が前提）
6. 第6波: W12（他の全項目の完了が前提）

**W12 は他の項目が揃わないと意味を成さない**ため、着手時に改めて分割し直すことを見込んでおく。

## ワークフローとしての実施記録（WF-E）

この文書は項目の仕様を持つ。ここから下は、[review-and-feature-consolidation.md](review-and-feature-consolidation.md) 側で
WF-E として運営したときの依存・前提・決定・申し送りである（Issue #613 で統合した）。

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
    [untrustedText.ts](../../src/orchestrator/untrustedText.ts)、仕様は
    [design.md](../design.md) §16.24。公開関数は
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
  `per-task` で（[config.ts](../../src/config.ts) の `normalizePullRequestLayerConfig`）、
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) が
  `shouldCreateTaskPullRequest` を見て
  [forge.ts](../../src/orchestrator/forge.ts) の `runTaskPullRequestFlow` を回す。その段取りは
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
- 影響: [forge.ts](../../src/orchestrator/forge.ts) /
  [runnerMerge.ts](../../src/orchestrator/runnerMerge.ts) /
  [runner.ts](../../src/orchestrator/runner.ts) /
  [config.ts](../../src/config.ts) / [workflowView.ts](../../src/view/workflowView.ts)
